/**
 * Instanced batching for map-thing sprites — thousands of billboards in a few draw calls, plus
 * the spectre fuzz shader. See docs/sprites.md § Batching and § The spectre's fuzz.
 */
import * as THREE from 'three';
import type { CachedSprite } from './sprites.ts';
import { spriteMaterial, VIEWER_ANGLE_DEG, whiteVertexColors } from './sprites.ts';
import type { AtlasPage } from './spriteatlas.ts';
import { DOOM_TIC } from '../constants.ts';
import { tinted, type Tint } from './lights.ts';
import { skyScale } from './skytint.ts';

/** Instances a freshly-created batch starts with, doubling from there as needed. */
const INITIAL_CAPACITY = 64;

/**
 * How far a fuzzed sprite is darkened, and the two ends of the per-pixel
 * translucency the shimmer runs between. All three tuned by feel — this
 * engine's fuzz is a look chosen against vanilla's own, not derived from it
 * (docs/sprites.md § The spectre's fuzz), so they are the whole of it and are
 * meant to be retuned by eye. The midpoint of the alpha range sits near the
 * player's own `INVISIBILITY_OPACITY`, which is the same `MF_SHADOW` in vanilla.
 */
const FUZZ_DARKEN = 0.42;
const FUZZ_ALPHA_MIN = 0.12;
const FUZZ_ALPHA_MAX = 0.62;

/**
 * How often the fuzz pattern is redrawn. Vanilla advances `fuzzpos` through
 * `fuzzoffset[FUZZTABLE]` once per column per frame, i.e. the shimmer steps at
 * the frame rate of a 35fps game; stepping on the tic keeps that cadence
 * instead of letting the shimmer run faster on a faster display.
 */
const FUZZ_STEP_SECONDS = DOOM_TIC;

/**
 * The shimmer's clock and its noise, prepended to the fragment shader by `applyFuzz`.
 * A 3D hash (Hoskins' `hash13`) taking the tic as a third dimension, and
 * deliberately not the noise `render/textures.ts` dithers the wall fade with —
 * docs/sprites.md § Why the fuzz can't share the wall dither's noise.
 */
const FUZZ_GLSL = `
uniform float uFuzzTime;

float fuzzNoise(vec2 seed, float t) {
  vec3 p = fract(vec3(seed, t) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
`;

/**
 * The vertex-stage half of drawing from the atlas: the unit plane is sized and shifted per
 * instance (`aSpriteRect`: width, height, the hotspot's x offset) and its UVs mapped onto the
 * lump's rect (`aSpriteUv`: bottom-left, top-right — see `AtlasSprite`). Spliced into three's own
 * `uv_vertex` chunk rather than written beside it, so a three upgrade that renames the line fails
 * loudly (`tests/render/spriteatlas.test.ts`) instead of drawing every sprite from texel zero.
 */
const ATLAS_ATTRIBUTES_GLSL = `
attribute vec3 aSpriteRect;
attribute vec4 aSpriteUv;
`;
const ATLAS_MAP_UV_LINE = 'vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;';
export const ATLAS_UV_VERTEX_GLSL = THREE.ShaderChunk.uv_vertex.replace(
  ATLAS_MAP_UV_LINE,
  'vMapUv = mix( aSpriteUv.xy, aSpriteUv.zw, uv );',
);
export const ATLAS_BEGIN_VERTEX_GLSL =
  'vec3 transformed = vec3( position.x * aSpriteRect.x + aSpriteRect.z, position.y * aSpriteRect.y, 0.0 );';

/** How many floats an instance takes in each lane a batch writes. */
const MATRIX_LANE = 16;
const COLOR_LANE = 3;
const RECT_LANE = 3;
const UV_LANE = 4;

interface Batch {
  mesh: THREE.InstancedMesh;
  count: number;
  /** The atlas lanes, null on a batch drawing one lump from the lump's own texture. */
  rect: THREE.InstancedBufferAttribute | null;
  uv: THREE.InstancedBufferAttribute | null;
  /**
   * Whether the mesh's geometry is this batch's to dispose — an atlas batch's `unitPlane`. A lump
   * batch draws `SpriteMaterialCache`'s own plane, which outlives the level.
   */
  ownsGeometry: boolean;
}

/** What a batch is keyed by: the page every atlas-backed lump on it shares, or a lump of its own. */
type BatchKey = AtlasPage | CachedSprite;

/**
 * Draws many sprites as a few `InstancedMesh`es instead of one `THREE.Mesh` each, rebuilt from
 * scratch every frame (`begin`/`add`/`end`): one mesh per atlas page, and one per lump for a lump
 * the atlas has no room for (`CachedSprite.atlas` null).
 *
 * Batching is a hard performance requirement rather than a refinement, and
 * both the rebuild-wholesale choice and the two properties that make a
 * per-instance write cheap are load-bearing: docs/sprites.md § Batching.
 */
export class SpriteBatch {
  readonly group = new THREE.Group();
  private batches = new Map<BatchKey, Batch>();
  /** One per page, and one clone per lump drawn from its own texture — see `materialFor`. */
  private materials = new Map<BatchKey, THREE.MeshBasicMaterial>();
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
   * `fuzz` draws everything in this batch as vanilla's `MF_SHADOW` fuzz — a
   * translucent batch whose alpha varies per pixel rather than coming from
   * `setOpacity`; see `applyFuzz`.
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
   * every sprite is drawn at.
   */
  begin(viewerAngleDeg: number): void {
    const rad = THREE.MathUtils.degToRad(viewerAngleDeg - VIEWER_ANGLE_DEG);
    this.cos = Math.cos(rad);
    this.sin = Math.sin(rad);
    for (const b of this.batches.values()) b.count = 0;
  }

  /**
   * Queues one sprite. `x`/`y`/`z` are already **three.js** space (the caller
   * converts via `doomToWorld`) and `light` is a 0..1 tint (`lightToColor`).
   * `tint` adds a dynamic light's contribution on top of that
   * (docs/lights.md § Two lighting paths); omitted is the unlit sprite.
   *
   * The position stays **scalars** rather than a point, the coordinate-triple exception in
   * docs/conventions.md § Named arguments: this runs once per drawn sprite per frame, and every
   * caller has just computed the three through `doomToWorld` into a reused vector.
   */
  add(
    cached: CachedSprite,
    x: number,
    y: number,
    z: number,
    scale: number,
    light: number,
    tint?: Tint,
    /** Whether this sprite stands under sky — see `skyScale`. */
    sky = false,
  ): void {
    const atlas = cached.atlas;
    const batch = this.batchFor(cached);
    const i = batch.count;
    if (i === batch.mesh.instanceMatrix.count) this.grow(batch, cached);

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

    if (atlas) {
      const r = batch.rect!.array as Float32Array;
      const ro = i * RECT_LANE;
      r[ro] = atlas.width;
      r[ro + 1] = atlas.height;
      r[ro + 2] = atlas.offsetX;
      const u = batch.uv!.array as Float32Array;
      const uo = i * UV_LANE;
      u[uo] = atlas.u0;
      u[uo + 1] = atlas.v0;
      u[uo + 2] = atlas.u1;
      u[uo + 3] = atlas.v1;
    }

    const c = batch.mesh.instanceColor!.array as Float32Array;
    const co = i * COLOR_LANE;
    const outdoors = skyScale(sky);
    const lr = light * outdoors.r;
    const lg = light * outdoors.g;
    const lb = light * outdoors.b;
    if (tint) {
      c[co] = tinted(lr, tint.r);
      c[co + 1] = tinted(lg, tint.g);
      c[co + 2] = tinted(lb, tint.b);
    } else {
      c[co] = lr;
      c[co + 1] = lg;
      c[co + 2] = lb;
    }

    batch.count = i + 1;
  }

  /**
   * Ends a frame: publishes each batch's instance count and flags the written part of its buffers
   * for upload. Only that part — a batch keeps the capacity it once grew to, and uploading it
   * whole was most of the frame's GL traffic on a map that spreads its things over hundreds of
   * lumps. A batch nothing landed in is hidden outright: the renderer would otherwise still bind
   * and upload it for a draw of zero instances. docs/sprites.md § Batching.
   */
  end(): void {
    for (const b of this.batches.values()) {
      const mesh = b.mesh;
      mesh.count = b.count;
      mesh.visible = b.count > 0;
      if (b.count === 0) continue;
      publish(mesh.instanceMatrix, b.count * MATRIX_LANE);
      publish(mesh.instanceColor!, b.count * COLOR_LANE);
      if (b.rect) publish(b.rect, b.count * RECT_LANE);
      if (b.uv) publish(b.uv, b.count * UV_LANE);
    }
  }

  dispose(): void {
    for (const b of this.batches.values()) {
      this.group.remove(b.mesh);
      b.mesh.dispose();
      // A lump's geometry and every texture belong to SpriteMaterialCache, which outlives a
      // single level and disposes them itself.
      if (b.ownsGeometry) b.mesh.geometry.dispose();
    }
    for (const m of this.materials.values()) m.dispose();
    this.batches.clear();
    this.materials.clear();
  }

  private batchFor(cached: CachedSprite): Batch {
    const key: BatchKey = cached.atlas ? cached.atlas.page : cached;
    const hit = this.batches.get(key);
    if (hit) return hit;
    const batch = this.makeBatch(cached, INITIAL_CAPACITY);
    this.group.add(batch.mesh);
    this.batches.set(key, batch);
    return batch;
  }

  /**
   * Doubles a full batch's capacity, carrying the instances already written this frame over to the
   * new buffers.
   */
  private grow(batch: Batch, cached: CachedSprite): void {
    const old = batch.mesh;
    const next = this.makeBatch(cached, old.instanceMatrix.count * 2);
    (next.mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    (next.mesh.instanceColor!.array as Float32Array).set(old.instanceColor!.array as Float32Array);
    if (batch.rect) (next.rect!.array as Float32Array).set(batch.rect.array as Float32Array);
    if (batch.uv) (next.uv!.array as Float32Array).set(batch.uv.array as Float32Array);
    this.group.remove(old);
    old.dispose();
    if (batch.ownsGeometry) old.geometry.dispose();
    this.group.add(next.mesh);
    batch.mesh = next.mesh;
    batch.rect = next.rect;
    batch.uv = next.uv;
  }

  /**
   * A batch's mesh at `capacity` instances: on the atlas a unit plane the shader sizes per
   * instance, carrying the two atlas lanes; off it the lump's own plane and texture.
   */
  private makeBatch(cached: CachedSprite, capacity: number): Batch {
    const atlas = cached.atlas;
    const geometry = atlas ? unitPlane() : cached.geometry;
    const material = atlas ? this.pageMaterialFor(atlas.page) : this.materialFor(cached);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * COLOR_LANE), COLOR_LANE);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    // A batch's instances are scattered across the whole map, so culling it as one object could
    // only ever cull nothing while costing a bounds recompute a frame — docs/sprites.md § Batching.
    mesh.frustumCulled = false;
    let rect: THREE.InstancedBufferAttribute | null = null;
    let uv: THREE.InstancedBufferAttribute | null = null;
    if (atlas) {
      rect = new THREE.InstancedBufferAttribute(new Float32Array(capacity * RECT_LANE), RECT_LANE);
      rect.setUsage(THREE.DynamicDrawUsage);
      uv = new THREE.InstancedBufferAttribute(new Float32Array(capacity * UV_LANE), UV_LANE);
      uv.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aSpriteRect', rect);
      geometry.setAttribute('aSpriteUv', uv);
    }
    return { mesh, count: 0, rect, uv, ownsGeometry: atlas !== null };
  }

  /**
   * The material every lump on `page` draws through: the page as its map, sized and mapped per
   * instance by the atlas patch, otherwise built exactly as a lump's own is.
   */
  private pageMaterialFor(page: AtlasPage): THREE.MeshBasicMaterial {
    const hit = this.materials.get(page);
    if (hit) return hit;
    const material = spriteMaterial(page.texture);
    material.vertexColors = true;
    this.applyBatchLook(material);
    const fuzzTime = this.fuzzTime;
    const fuzz = this.fuzz;
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        ATLAS_ATTRIBUTES_GLSL +
        shader.vertexShader
          .replace('#include <uv_vertex>', ATLAS_UV_VERTEX_GLSL)
          .replace('#include <begin_vertex>', ATLAS_BEGIN_VERTEX_GLSL);
      if (fuzz) patchFuzz(shader, fuzzTime);
    };
    // Keyed apart from the unpatched program and from the fuzz-only one, for the reason
    // `applyFuzz` gives.
    material.customProgramCacheKey = () => (fuzz ? 'atlas-fuzz' : 'atlas');
    this.materials.set(page, material);
    return material;
  }

  /**
   * The instanced twin of a lump's material: same texture and alpha test, but
   * `vertexColors` on (so `instanceColor` actually reaches the fragment
   * shader — see the `color` attribute comment in `render/sprites.ts`) and a
   * white base color, since the tint rides per instance rather than on the
   * shared material.
   */
  private materialFor(cached: CachedSprite): THREE.MeshBasicMaterial {
    const hit = this.materials.get(cached);
    if (hit) return hit;
    const material = cached.material.clone();
    material.vertexColors = true;
    material.color.setScalar(1);
    this.applyBatchLook(material);
    if (this.fuzz) this.applyFuzz(material);
    this.materials.set(cached, material);
    return material;
  }

  /** What this batch's kind — depth-biased, translucent, fuzzed — sets on every material it builds. */
  private applyBatchLook(material: THREE.MeshBasicMaterial): void {
    if (this.depthBias !== 0) {
      material.polygonOffset = true;
      material.polygonOffsetUnits = -this.depthBias;
      // Sprite planes all face the camera at the same yaw, so their depth
      // slopes match and a slope-scaled term can't separate them; the constant
      // `units` term is what does the work here.
      material.polygonOffsetFactor = 0;
    }
    // A fuzzed sprite is translucent in exactly the way `translucent` builds
    // for — it just varies its alpha per pixel instead of taking one from
    // `setOpacity` (see `applyFuzz`).
    if (this.translucent || this.fuzz) {
      material.transparent = true;
      material.opacity = this.opacity;
      // Both values: docs/sprites.md § Batching.
      material.alphaTest = 0.01;
      material.depthWrite = false;
    }
  }

  /**
   * Turns a lump's material into this engine's `MF_SHADOW` fuzz: the sprite
   * darkened to `FUZZ_DARKEN` and faded to a per-pixel alpha between
   * `FUZZ_ALPHA_MIN` and `FUZZ_ALPHA_MAX`, re-drawn every `FUZZ_STEP_SECONDS`,
   * so the floor shows through and shimmers.
   *
   * Blending rather than a screen-door discard, so the spectre carries no
   * per-pixel mask for a fading wall's own dither to collide with:
   * docs/sprites.md § Why the fuzz can't share the wall dither's noise.
   *
   * Deliberately cruder than vanilla's own effect rather than an approximation of it, and the
   * rejection of the closer reproduction is the load-bearing part: docs/sprites.md §
   * The spectre's fuzz.
   */
  private applyFuzz(material: THREE.MeshBasicMaterial): void {
    const fuzzTime = this.fuzzTime;
    material.onBeforeCompile = (shader) => patchFuzz(shader, fuzzTime);
    // three.js keys its program cache on the material's *parameters*, which a
    // fuzzed sprite shares exactly with an ordinary batched one — without a
    // key of its own it would be handed the unpatched program (or hand its
    // patched one to every other sprite, whichever compiled first).
    material.customProgramCacheKey = () => 'fuzz';
  }
}

/** Flags the first `count` floats of an instance lane for upload — the part this frame wrote. */
function publish(attribute: THREE.BufferAttribute, count: number): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count);
  attribute.needsUpdate = true;
}

/**
 * The plane every atlas batch instances: bottom-centre at the origin, a unit wide and tall, which
 * `ATLAS_BEGIN_VERTEX_GLSL` sizes and shifts per instance. One per batch, since the batch's own
 * lanes hang off it.
 */
function unitPlane(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0, 0.5, 0);
  whiteVertexColors(geometry);
  return geometry;
}

/** The fuzz's fragment patch — see `SpriteBatch.applyFuzz`. */
function patchFuzz(shader: THREE.WebGLProgramParametersWithUniforms, fuzzTime: { value: number }): void {
  shader.uniforms.uFuzzTime = fuzzTime;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
     diffuseColor.rgb *= ${FUZZ_DARKEN.toFixed(3)};
     diffuseColor.a *= mix(
       ${FUZZ_ALPHA_MIN.toFixed(3)},
       ${FUZZ_ALPHA_MAX.toFixed(3)},
       fuzzNoise(gl_FragCoord.xy, uFuzzTime));`,
  );
  shader.fragmentShader = FUZZ_GLSL + shader.fragmentShader;
}
