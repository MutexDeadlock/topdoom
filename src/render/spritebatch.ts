import * as THREE from 'three';
import type { CachedSprite } from './sprites.ts';
import { VIEWER_ANGLE_DEG } from './sprites.ts';

/** Instances a freshly-created batch starts with, doubling from there as needed. */
const INITIAL_CAPACITY = 64;

interface Batch {
  mesh: THREE.InstancedMesh;
  count: number;
}

/**
 * Draws many sprites sharing a lump as a single `InstancedMesh` instead of one
 * `THREE.Mesh` each, rebuilt from scratch every frame (`begin`/`add`/`end`).
 *
 * Batching is a hard performance requirement rather than a refinement, and
 * both the rebuild-wholesale choice and the two properties that make a
 * per-instance write cheap are load-bearing: docs/sprites.md § Batching.
 */
export class SpriteBatch {
  readonly group = new THREE.Group();
  private batches = new Map<CachedSprite, Batch>();
  /** Cloned per cached sprite — see `materialFor`. */
  private materials = new Map<CachedSprite, THREE.MeshBasicMaterial>();
  private cos = 1;
  private sin = 0;
  private depthBias: number;
  private translucent: boolean;
  private opacity = 1;

  /**
   * `depthBias` biases every fragment this batch draws toward the camera by
   * that many depth-buffer units (`polygonOffset`), so it wins the depth test
   * against anything drawn at the *same* depth. Meant for exactly that case —
   * two upright sprite planes standing at the same map position, which are
   * coplanar and would otherwise resolve by draw order (docs/items.md §
   * Making monster drops readable). It is deliberately far too small to push a
   * sprite through geometry genuinely in front of it.
   *
   * `translucent` builds this batch's materials for `setOpacity` — see there.
   */
  constructor(options: { depthBias?: number; translucent?: boolean } = {}) {
    this.group.name = 'sprite-batches';
    this.depthBias = options.depthBias ?? 0;
    this.translucent = options.translucent ?? false;
  }

  /**
   * Fades everything this batch draws to `opacity` (1 = fully opaque). Batch-
   * wide, not per-instance: three.js's `instanceColor` has no alpha channel,
   * so a per-sprite fade would need a custom shader — every sprite in a
   * `translucent` batch fades together.
   *
   * Only meaningful on a `translucent` batch, whose materials are built
   * transparent from the start so this is a plain uniform write. Flipping
   * `transparent`/`alphaTest` on a live material instead would force a shader
   * recompile, and this is called every frame.
   */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
    for (const m of this.materials.values()) m.opacity = opacity;
  }

  /**
   * Starts a frame: drops last frame's instances and fixes the shared yaw
   * every sprite is drawn at. The same yaw `render/sprites.ts`'s
   * `intersectBillboard` takes, which has to reproduce the instance matrix
   * `add` writes below.
   */
  begin(viewerAngleDeg: number): void {
    const rad = THREE.MathUtils.degToRad(viewerAngleDeg - VIEWER_ANGLE_DEG);
    this.cos = Math.cos(rad);
    this.sin = Math.sin(rad);
    for (const b of this.batches.values()) b.count = 0;
  }

  /**
   * Queues one sprite. `pos` is already **three.js** space (the caller
   * converts via `doomToWorld`) and `light` is a 0..1 tint (`lightToColor`).
   */
  add(cached: CachedSprite, x: number, y: number, z: number, scale: number, light: number): void {
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

    batch.count = i + 1;
  }

  /** Ends a frame: publishes each batch's instance count and flags its buffers for upload. */
  end(): void {
    for (const b of this.batches.values()) {
      b.mesh.count = b.count;
      b.mesh.instanceMatrix.needsUpdate = true;
      b.mesh.instanceColor!.needsUpdate = true;
    }
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
    const batch: Batch = { mesh: this.makeMesh(cached, INITIAL_CAPACITY), count: 0 };
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
    if (this.depthBias !== 0) {
      material.polygonOffset = true;
      material.polygonOffsetUnits = -this.depthBias;
      // Sprite planes all face the camera at the same yaw, so their depth
      // slopes match and a slope-scaled term can't separate them; the constant
      // `units` term is what does the work here.
      material.polygonOffsetFactor = 0;
    }
    if (this.translucent) {
      material.transparent = true;
      material.opacity = this.opacity;
      // The shared material alpha-tests at 0.5 against `texture.a * opacity`,
      // which would discard the whole sprite at any opacity below that. WAD
      // sprite alpha is binary (0 or 255, never blended — NearestFilter), so
      // any threshold under the lowest opacity used cuts the same silhouette.
      material.alphaTest = 0.01;
      // One translucent plane among opaque geometry: not writing depth keeps
      // it from punching a hole in whatever draws after it.
      material.depthWrite = false;
    }
    this.materials.set(cached, material);
    return material;
  }
}
