/**
 * Instanced batching for map-thing sprites — thousands of billboards in a few draw calls, plus
 * the spectre fuzz shader. See docs/sprites.md § Batching and § The spectre's fuzz.
 */
import * as THREE from 'three';
import type { CachedSprite } from './sprites.ts';
import { VIEWER_ANGLE_DEG } from './sprites.ts';
import { DOOM_TIC } from '../constants.ts';

/** Instances a freshly-created batch starts with, doubling from there as needed. */
const INITIAL_CAPACITY = 64;

/**
 * Fraction of a fuzzed sprite's pixels dropped each fuzz step, and how far the
 * rest are darkened. Both tuned by feel — this engine's fuzz is a look chosen
 * against vanilla's own, not derived from it (docs/sprites.md § The spectre's
 * fuzz), so these two are the whole of it and are meant to be retuned by eye.
 */
const FUZZ_DISCARD = 0.52;
const FUZZ_DARKEN = 0.42;

/**
 * How often the fuzz pattern is redrawn. Vanilla advances `fuzzpos` through
 * `fuzzoffset[FUZZTABLE]` once per column per frame, i.e. the shimmer steps at
 * the frame rate of a 35fps game; stepping on the tic keeps that cadence
 * instead of letting the shimmer run faster on a faster display.
 */
const FUZZ_STEP_SECONDS = DOOM_TIC;

/** The shimmer's clock and its noise, prepended to the fragment shader by `applyFuzz`. */
const FUZZ_GLSL = `
uniform float uFuzzTime;

/** Interleaved gradient noise (Jimenez): cheap, decorrelated per pixel. */
float fuzzNoise(vec2 seed) {
  return fract(52.9829189 * fract(dot(seed, vec2(0.06711056, 0.00583715))));
}
`;

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
  private fuzz: boolean;
  private opacity = 1;
  /**
   * The shimmer's clock, shared by every material this batch builds — a live
   * uniform object handed to each patched shader, so `setFuzzTime` is one
   * write no matter how many lumps the batch spans.
   */
  private fuzzTime = { value: 0 };

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
   * `fuzz` draws everything in this batch as vanilla's `MF_SHADOW` fuzz
   * instead of its own art — see `applyFuzz`.
   */
  constructor(options: { depthBias?: number; translucent?: boolean; fuzz?: boolean } = {}) {
    this.group.name = 'sprite-batches';
    this.depthBias = options.depthBias ?? 0;
    this.translucent = options.translucent ?? false;
    this.fuzz = options.fuzz ?? false;
  }

  /**
   * Advances the fuzz shimmer to level time `seconds` (see `applyFuzz`). Only
   * meaningful on a `fuzz` batch; a plain uniform write, called every frame.
   */
  setFuzzTime(seconds: number): void {
    this.fuzzTime.value = Math.floor(seconds / FUZZ_STEP_SECONDS);
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
    if (this.fuzz) this.applyFuzz(material);
    this.materials.set(cached, material);
    return material;
  }

  /**
   * Turns a lump's material into this engine's `MF_SHADOW` fuzz: the sprite
   * darkened to `FUZZ_DARKEN`, with `FUZZ_DISCARD` of its pixels dropped on a
   * noise pattern re-seeded every `FUZZ_STEP_SECONDS`, so the floor shows
   * through and shimmers.
   *
   * Discarding rather than blending is the same trade the wall/flat fade makes
   * (`render/textures.ts`): a screen-door pattern keeps these planes in the
   * ordinary opaque, depth-tested pass, so they composite correctly against
   * the level's per-texture batches regardless of draw order.
   *
   * A closer reproduction of vanilla's own effect was built and rejected on how
   * it looked, and the rejection is the load-bearing part: docs/sprites.md §
   * The spectre's fuzz.
   */
  private applyFuzz(material: THREE.MeshBasicMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFuzzTime = this.fuzzTime;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         if (fuzzNoise(gl_FragCoord.xy + uFuzzTime * vec2(11.0, 7.0)) < ${FUZZ_DISCARD.toFixed(3)}) discard;
         diffuseColor.rgb *= ${FUZZ_DARKEN.toFixed(3)};`,
      );
      shader.fragmentShader = FUZZ_GLSL + shader.fragmentShader;
    };
    // three.js keys its program cache on the material's *parameters*, which a
    // fuzzed sprite shares exactly with an ordinary batched one — without a
    // key of its own it would be handed the unpatched program (or hand its
    // patched one to every other sprite, whichever compiled first).
    material.customProgramCacheKey = () => 'fuzz';
  }
}
