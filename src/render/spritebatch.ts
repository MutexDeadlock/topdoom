import * as THREE from 'three';
import type { CachedSprite } from './sprites.ts';
import { VIEWER_ANGLE_DEG } from './sprites.ts';

/** Instances a freshly-created batch starts with, doubling from there as needed. */
const INITIAL_CAPACITY = 64;

interface Batch {
  mesh: THREE.InstancedMesh;
  /** Per-instance `ownerId` handed to `add`, so a raycast hit maps back to whatever the caller keyed on. */
  owners: number[];
  count: number;
}

/**
 * Draws many sprites sharing a lump as a single `InstancedMesh` instead of one
 * `THREE.Mesh` each.
 *
 * This exists because of the draw-call wall. `game/things.ts` poses every map
 * THING every frame, and a stress-test map like NUTS.WAD has 10,696 of them in
 * a single 69-subsector open arena — so essentially all of them are on screen
 * and fog-of-war-revealed at once. One mesh each meant ~10k draw calls per
 * frame, each with its own matrix/uniform upload, which alone dropped the
 * game to a ~2fps slideshow with the renderer utterly dominating the DEVMODE
 * profiler. Batching by lump collapses that to one draw call per *distinct
 * sprite lump currently on screen* (a few dozen to a few hundred), which is
 * the same thing hardware-accelerated source ports do.
 *
 * The batch is rebuilt from scratch every frame (`begin`/`add`/`end`) rather
 * than incrementally maintained. That's deliberate: which lump a thing uses
 * changes constantly — every monster re-picks its rotation frame as the
 * camera orbits and its own facing changes, and its walk cycle advances on
 * top of that — so an instance's batch membership is not stable across frames
 * and there is nothing useful to preserve. Writing straight into the
 * instance buffers costs one matrix's worth of float stores per sprite, far
 * less than the per-object work three.js would otherwise do for each.
 *
 * Two details make the per-instance write cheap enough to do for everything,
 * every frame:
 * - **Every sprite shares one rotation.** The planes never tilt and all track
 *   the same camera yaw (see `SpriteMaterialCache`'s doc), so the rotation's
 *   sin/cos are computed once in `begin` and the whole instance matrix is
 *   written directly into the buffer as scalars — no `Matrix4`/`Quaternion`
 *   allocation or `compose` call per sprite.
 * - **Sector light rides along as a per-instance color**, which as a bonus
 *   *fixes* a pre-existing bug rather than merely preserving behavior: the
 *   non-instanced path tints by mutating the lump's shared material, so with
 *   several things sharing a lump the last one posed each frame decided the
 *   light for all of them. Per-instance color is genuinely per-sprite.
 */
export class SpriteBatch {
  readonly group = new THREE.Group();
  private batches = new Map<CachedSprite, Batch>();
  /** Cloned per cached sprite — see `materialFor`. */
  private materials = new Map<CachedSprite, THREE.MeshBasicMaterial>();
  private cos = 1;
  private sin = 0;

  constructor() {
    this.group.name = 'sprite-batches';
  }

  /** Starts a frame: drops last frame's instances and fixes the shared yaw every sprite is drawn at. */
  begin(viewerAngleDeg: number): void {
    const rad = THREE.MathUtils.degToRad(viewerAngleDeg - VIEWER_ANGLE_DEG);
    this.cos = Math.cos(rad);
    this.sin = Math.sin(rad);
    for (const b of this.batches.values()) {
      b.count = 0;
      b.owners.length = 0;
    }
  }

  /**
   * Queues one sprite. `pos` is already **three.js** space (the caller
   * converts via `doomToWorld`), `light` is a 0..1 tint (`lightToColor`), and
   * `ownerId` is an opaque handle `raycast` hands back for whatever the hit
   * instance turns out to be.
   */
  add(cached: CachedSprite, x: number, y: number, z: number, scale: number, light: number, ownerId: number): void {
    const batch = this.batchFor(cached);
    const i = batch.count;
    if (i === batch.mesh.instanceMatrix.count) this.grow(cached, batch);

    // Column-major TRS for "scale uniformly, rotate about Y, translate" —
    // written out by hand rather than through Matrix4.compose, since this
    // runs once per sprite per frame and the rotation is the same for all of
    // them (see the class doc).
    const m = batch.mesh.instanceMatrix.array as Float32Array;
    const o = i * 16;
    const sc = scale * this.cos;
    const ss = scale * this.sin;
    m[o] = sc;      m[o + 1] = 0;      m[o + 2] = -ss;     m[o + 3] = 0;
    m[o + 4] = 0;   m[o + 5] = scale;  m[o + 6] = 0;       m[o + 7] = 0;
    m[o + 8] = ss;  m[o + 9] = 0;      m[o + 10] = sc;     m[o + 11] = 0;
    m[o + 12] = x;  m[o + 13] = y;     m[o + 14] = z;      m[o + 15] = 1;

    const c = batch.mesh.instanceColor!.array as Float32Array;
    const co = i * 3;
    c[co] = light;
    c[co + 1] = light;
    c[co + 2] = light;

    batch.owners.push(ownerId);
    batch.count = i + 1;
  }

  /** Ends a frame: publishes each batch's instance count and flags its buffers for upload. */
  end(): void {
    for (const b of this.batches.values()) {
      b.mesh.count = b.count;
      b.mesh.instanceMatrix.needsUpdate = true;
      b.mesh.instanceColor!.needsUpdate = true;
      // Instances move every frame, so any sphere three.js cached for the
      // raycast below (which lazily computes and then keeps one) is stale by
      // now. Nulling it forces a recompute on next use; nothing else reads it,
      // since the batches opt out of frustum culling (see `grow`).
      b.mesh.boundingSphere = null;
    }
  }

  /**
   * The `ownerId` of the nearest instance this ray hits that `accept` approves
   * of, or null. Instances `accept` rejects are skipped rather than treated as
   * blockers — the caller (`ThingLayer.pickMonster`) only ever wants monsters,
   * and a decoration standing in front of one shouldn't make it unclickable,
   * matching the behavior from when only monster meshes were in the raycast
   * set at all.
   */
  raycast(raycaster: THREE.Raycaster, accept: (ownerId: number) => boolean): number | null {
    for (const hit of raycaster.intersectObjects(this.group.children, false)) {
      const batch = this.batches.get((hit.object as THREE.InstancedMesh).userData.cached as CachedSprite);
      if (!batch || hit.instanceId === undefined) continue;
      const owner = batch.owners[hit.instanceId];
      if (owner !== undefined && accept(owner)) return owner;
    }
    return null;
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
    }
    // Geometry and textures belong to SpriteMaterialCache, which outlives a
    // single level and disposes them itself; only these clones are ours.
    for (const m of this.materials.values()) m.dispose();
    this.batches.clear();
    this.materials.clear();
  }

  private batchFor(cached: CachedSprite): Batch {
    const hit = this.batches.get(cached);
    if (hit) return hit;
    const batch: Batch = { mesh: this.makeMesh(cached, INITIAL_CAPACITY), owners: [], count: 0 };
    this.group.add(batch.mesh);
    this.batches.set(cached, batch);
    return batch;
  }

  /** Doubles a full batch's capacity, carrying the instances already written this frame over to the new buffers. */
  private grow(cached: CachedSprite, batch: Batch): void {
    const old = batch.mesh;
    const next = this.makeMesh(cached, old.instanceMatrix.count * 2);
    (next.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    (next.instanceColor!.array as Float32Array).set(old.instanceColor!.array as Float32Array);
    this.group.remove(old);
    old.dispose();
    this.group.add(next);
    batch.mesh = next;
  }

  private makeMesh(cached: CachedSprite, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(cached.geometry, this.materialFor(cached), capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    // A batch's instances are scattered across the whole map, so its bounds are
    // effectively the level — culling it as one object could only ever cull
    // nothing, and would cost a per-frame bounds recompute to decide that.
    // Off-screen instances are clipped by the GPU for the price of a trivially
    // cheap vertex shader on 4 vertices, which is the better trade here.
    mesh.frustumCulled = false;
    // Lets `raycast` map a hit mesh back to its batch without a reverse scan.
    mesh.userData.cached = cached;
    return mesh;
  }

  /**
   * The instanced twin of a lump's material: same texture and alpha test, but
   * `vertexColors` on (so `instanceColor` actually reaches the fragment
   * shader — see the `color` attribute comment in `render/sprites.ts`) and a
   * white base color, since the tint now rides per instance instead of on the
   * shared material.
   */
  private materialFor(cached: CachedSprite): THREE.MeshBasicMaterial {
    const hit = this.materials.get(cached);
    if (hit) return hit;
    const material = cached.material.clone();
    material.vertexColors = true;
    material.color.setScalar(1);
    this.materials.set(cached, material);
    return material;
  }
}
