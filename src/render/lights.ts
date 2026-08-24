/**
 * `DynamicLights`: the per-frame dynamic light set. Every drawn sprite offers its frame key here,
 * the ones GLDEFS binds a light to become emitters, and the result reaches geometry as a shader
 * uniform array and sprites as an additive tint. See docs/lights.md.
 */
import * as THREE from 'three';
import { DOOM_TIC } from '../constants.ts';
import { lightForFrame, type Gldefs, type LightDef } from '../wad/gldefs.ts';
import { SHADOW_STEPS, type LightVisibility } from './lightvis.ts';
import { doomToWorld } from './mapmesh.ts';

/**
 * How many lights can reach the geometry shader at once, the rest culled by how near their reach
 * comes to the camera. Tuned by feel, and generously: a slaughter map with a hundred projectiles
 * in the air is meant to read as fireworks, which a tight cap turns into lights popping in and out
 * as the ranking shuffles. Raising it is close to free while few lights are actually on screen —
 * the fragment loop runs to the live count, so the cap costs shader *slots*, not per-pixel work.
 * What keeps the live count near the lights actually in view is `offer`'s frustum cull, not this.
 *
 * Those slots are the ceiling to watch if this grows again: the arrays below occupy two uniform
 * rows per light (a `vec4` and a `vec3`, and GLSL ES gives every array element its own row), so
 * 64 spends 128 of the 224 fragment uniform vectors WebGL 2 guarantees — the rest of the material's
 * shader has to fit in what is left, on the weakest conformant hardware rather than on this one.
 */
export const MAX_DYN_LIGHTS = 64;

/**
 * What a GLDEFS `size` is multiplied by to get the radius a light actually reaches. The dial for
 * how far the lights carry: tuned by feel, and the first thing to turn if they read too tight or
 * too washed out. Exported so `tests/render/lights.test.ts` can size its fixtures from it rather
 * than mirroring the number — a test that reddens when this is retuned is pinning the dial.
 */
export const RADIUS_SCALE = 1.25;

/**
 * Texels per row of the visibility texture — the map from subsector index to the bitmask of lights
 * that reach it, which is how a fragment learns whether a wall stands between it and a light
 * (docs/lights.md § Light stops at walls). One `RGBA32UI` texel per subsector holds 128 bits, so
 * the mask covers `MAX_DYN_LIGHTS` with room to spare; a level with fewer subsectors than this gets
 * a single short row rather than a padded one.
 *
 * Any width serves; 1024 keeps both axes inside the 2048-texel minimum every WebGL2 implementation
 * guarantees, for every level this engine loads.
 */
const VIS_TEXTURE_WIDTH = 1024;

/** `RGBA32UI` texels are four 32-bit words, and `MAX_DYN_LIGHTS` must fit in them. */
const VIS_WORDS = 4;

/**
 * How far past its nearest blocker a fragment may still be lit. The wall casting a shadow is itself
 * at exactly the blocker distance, so without this every lit wall face would shadow itself; with it,
 * the face stays lit and the floor behind the wall does not. **Tuned by feel**, bounded on both
 * sides: below about 2 the faces flicker on shallow angles, and above the thickness of the thinnest
 * wall a map draws the far side of that wall lights up too.
 */
export const SHADOW_BIAS = 4;

/** One row per light, one texel per angular bin — the distance its shadow starts at. */
function makeShadowTexture(data: Float32Array): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, SHADOW_STEPS, MAX_DYN_LIGHTS, THREE.RedFormat, THREE.FloatType);
  tex.internalFormat = 'R32F';
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The visibility texture, in the one format that carries raw bits to the shader: an integer
 * texture, read with `texelFetch` and never filtered. Kept here rather than in `render/textures.ts`
 * because the controller owns the array behind it.
 */
function makeVisTexture(data: Uint32Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
  tex.internalFormat = 'RGBA32UI';
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Sprite tints are sampled into this rather than allocating per drawn sprite. */
export interface Tint {
  r: number;
  g: number;
  b: number;
}

/**
 * One channel of a sector light and a dynamic tint composed: the sum, clamped. The single place the
 * two lighting paths meet on the CPU — shared by the instanced batch and `SpriteActor` so a change
 * to how a tint composes reaches both. docs/lights.md § Two lighting paths.
 */
export function tinted(light: number, tint: number): number {
  return Math.min(light + tint, 1);
}

const STORAGE_KEY = 'topdoom.dynamicLights';

/**
 * Whether dynamic lights are drawn at all. On by default. Module-level rather than per-`Game`, for
 * the reason `getInfiniteTallActors` is (`game/world.ts`): it is a settings-tab preference that has
 * to apply to the level already running, and the renderer is rebuilt every map load.
 */
let dynamicLightsEnabled = globalThis.localStorage?.getItem(STORAGE_KEY) !== 'false';

export function getDynamicLights(): boolean {
  return dynamicLightsEnabled;
}

export function setDynamicLights(enabled: boolean): void {
  dynamicLightsEnabled = enabled;
  globalThis.localStorage?.setItem(STORAGE_KEY, String(enabled));
}

/**
 * A deterministic hash of an emitter id and a step number into [0, 1). This is what animates the
 * flicker, and it is **not** `util/random`: the vanilla table is the engine's gameplay entropy on
 * two global cursors, so drawing from it here would make what a monster does depend on how many
 * torches were on screen. See docs/random.md § Why the cursors are global.
 *
 * Being a pure function of (id, step) also means a light needs no per-emitter state to survive a
 * save/load, or a frame where its sprite wasn't drawn.
 */
function hash01(id: number, step: number): number {
  let h = (id * 0x9e3779b1) ^ (step * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x100000000;
}

/**
 * The radius a light shows at this instant, before `RADIUS_SCALE`. Each branch is GZDoom's
 * `ADynamicLight::Tick` (`a_dynlight.cpp`), with its per-actor cycler state replaced by a pure
 * function of the emitter id and the clock — see `hash01`.
 */
function animatedSize(def: LightDef, id: number, clock: number): number {
  switch (def.kind) {
    case 'point':
      // `m_currentRadius = GetIntensity()` — a point light never moves.
      return def.size;
    case 'pulse': {
      // GZDoom drives a `CYCLE_Sin` cycler between the two sizes over `interval` seconds. The
      // per-emitter phase stands in for its attach-time cycler start, so two torches in a room
      // don't pulse in lockstep.
      if (def.interval <= 0) return def.size;
      const phase = hash01(id, 0);
      const t = 0.5 + 0.5 * Math.sin(2 * Math.PI * (clock / def.interval + phase));
      return def.secondarySize + (def.size - def.secondarySize) * t;
    }
    case 'flicker': {
      // `rnd < chance` per tic picks the primary size, else the secondary — a hard per-tic switch,
      // not a blend.
      const tic = Math.floor(clock / DOOM_TIC);
      return hash01(id, tic) < def.chance ? def.size : def.secondarySize;
    }
    case 'flicker2': {
      // GZDoom rerolls a random blend between the sizes on an interval counter.
      const bucket = def.interval > 0 ? Math.floor(clock / def.interval) : 0;
      return def.size + (def.secondarySize - def.size) * hash01(id, bucket);
    }
  }
}

/** One light offered this frame, before culling. */
interface Emitter {
  def: LightDef;
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** The emitter's own BSP leaf, where the reach fill starts. -1 = the caller had none to hand; resolved at commit. */
  subsector: number;
  /** `commit`'s cull key, written only on the frames that overflow — see there. */
  sortKey: number;
}

/**
 * Gathers the frame's lights and hands them to the two consumers: `uniforms` for map geometry
 * (`render/textures.ts` patches every material's shader against them) and `tintAt` for sprites,
 * which are lit on the CPU instead (docs/lights.md § Two lighting paths).
 */
/**
 * The emitter-id space every `offer`/`tintAt` caller shares. `dontlightself` and a light's flicker
 * phase both key off the id, so the three sources must not collide: a thing offers `PosedThing.id`
 * (a plain array index, 0 and up), a one-shot effect counts down from -1 (`effectEmitterId`), and
 * the player sits at `PLAYER_EMITTER_ID` below every effect's. Declared here because
 * `DynamicLights` is the only module that reads any of them. docs/lights.md § What emits.
 */
export const PLAYER_EMITTER_ID = -1_000_000;

/**
 * The `n`th one-shot effect's emitter id. Wraps short of `PLAYER_EMITTER_ID` rather than counting
 * down forever, so a long session cannot walk an effect onto the player's id and stop a light
 * reaching whichever of the two `dontlightself` then skips.
 */
export function effectEmitterId(n: number): number {
  return -1 - (n % (-PLAYER_EMITTER_ID - 1));
}

export class DynamicLights {
  /**
   * The live uniform objects, handed to every patched material once and mutated in place
   * thereafter — the pattern `SpriteBatch`'s fuzz time uses (`render/spritebatch.ts`).
   * `pos` is xyz in three.js space plus the radius in w.
   */
  readonly uniforms = {
    uLightCount: { value: 0 },
    uLightPos: { value: new Float32Array(MAX_DYN_LIGHTS * 4) },
    uLightColor: { value: new Float32Array(MAX_DYN_LIGHTS * 3) },
    /** Subsector -> bitmask of the lights that reach it. See `bindLevel`. */
    uLightVis: { value: makeVisTexture(new Uint32Array(VIS_WORDS), 1, 1) },
    /** Row width of that texture, and the flag for whether it means anything: 0 = no level bound, so nothing is gated. */
    uLightVisWidth: { value: 0 },
    /** Per light, per direction, how far it gets before a wall stops it. See `LightVisibility.castShadows`. */
    uLightShadow: { value: makeShadowTexture(new Float32Array(SHADOW_STEPS * MAX_DYN_LIGHTS)) },
  };

  private readonly defs: Gldefs;
  private vis: LightVisibility | null = null;
  private visMask = new Uint32Array(VIS_WORDS);
  /** Which subsectors carry a bit this frame, so clearing costs the lit ones rather than the level. */
  private touched: number[] = [];
  /** `reach`'s output, reused across lights rather than reallocated per light per frame. */
  private reached: number[] = [];
  /** The shadow texture's own array, one `SHADOW_STEPS` row per committed light. */
  private shadows: Float32Array;
  private clock = 0;
  private camX = 0;
  private camY = 0;
  private active = true;

  /** This frame's offers, refilled from index 0 each frame rather than reallocated. */
  private offered: Emitter[] = [];
  private offerCount = 0;

  /**
   * Last frame's committed set, which `tintAt` samples. Its own storage rather than references
   * into `offered`: that array is a pool the next frame's `offer` calls overwrite in place, and
   * `tintAt` reads this set *during* that frame's draw.
   */
  private committed = {
    x: new Float32Array(MAX_DYN_LIGHTS),
    y: new Float32Array(MAX_DYN_LIGHTS),
    z: new Float32Array(MAX_DYN_LIGHTS),
    radius: new Float32Array(MAX_DYN_LIGHTS),
    r: new Float32Array(MAX_DYN_LIGHTS),
    g: new Float32Array(MAX_DYN_LIGHTS),
    b: new Float32Array(MAX_DYN_LIGHTS),
    id: new Int32Array(MAX_DYN_LIGHTS),
    dontLightSelf: new Uint8Array(MAX_DYN_LIGHTS),
  };
  private committedCount = 0;

  /** `offerAndTint`'s one reused output — see there for its lifetime. */
  private sampled: Tint = { r: 0, g: 0, b: 0 };

  private scratch = new THREE.Vector3();
  /** The camera's view volume this frame, or null when the caller gave none (tests, tools). */
  private view: THREE.Frustum | null = null;
  /** Scratch for the offer-side cull, so a rejected light allocates nothing. */
  private cullSphere = new THREE.Sphere();

  constructor(defs: Gldefs) {
    this.defs = defs;
    this.shadows = this.uniforms.uLightShadow.value.image.data as Float32Array;
  }

  /**
   * Points the controller at a level's subsector graph, sizing the visibility texture to it.
   * Called once per map load, before the first frame is drawn; `null` (tests, tools) leaves every
   * light ungated, which is what `uLightVisWidth` 0 means to the shader.
   */
  bindLevel(vis: LightVisibility | null): void {
    this.vis = vis;
    this.touched.length = 0;
    this.uniforms.uLightVis.value.dispose();
    if (!vis || vis.subsectorCount === 0) {
      this.visMask = new Uint32Array(VIS_WORDS);
      this.uniforms.uLightVis.value = makeVisTexture(this.visMask, 1, 1);
      this.uniforms.uLightVisWidth.value = 0;
      return;
    }
    const width = Math.min(VIS_TEXTURE_WIDTH, vis.subsectorCount);
    const height = Math.ceil(vis.subsectorCount / width);
    this.visMask = new Uint32Array(width * height * VIS_WORDS);
    this.uniforms.uLightVis.value = makeVisTexture(this.visMask, width, height);
    this.uniforms.uLightVisWidth.value = width;
  }

  /**
   * Opens a frame: advances the animation clock and records what the camera can see, which is what
   * culling measures against. `rawDt` is the real elapsed time, not the tic step — a light's
   * flicker is presentation, and stuttering it with the fixed step would be visible.
   *
   * `view` is the camera's view volume at the pose it will draw at (`TopDownCamera.viewFrustum`),
   * and every offer outside it is dropped — see `offer`. Omitted (tests, tools), nothing is culled.
   */
  beginFrame(rawDt: number, camX: number, camY: number, view?: THREE.Frustum): void {
    this.clock += rawDt;
    this.camX = camX;
    this.camY = camY;
    this.offerCount = 0;
    this.active = dynamicLightsEnabled;
    this.view = view ?? null;
  }

  /**
   * Offers a drawn sprite as a possible emitter. Called once per drawn sprite per frame from the
   * three draw funnels, so it does no allocation and gives up in two map lookups when the frame
   * carries no light. `x`/`y`/`z` are DOOM map space with `z` at the thing's feet, which is what
   * a GLDEFS `offset` is measured up from. `subsector` is the emitter's own BSP leaf where the
   * caller already holds one (`PosedThing.subsector`, `OneShotEffect.subsector`) — the flood fill
   * starts there, and -1 means resolve it at commit, for the few offers that survive culling.
   */
  offer(frameKey: string, x: number, y: number, z: number, emitterId: number, subsector = -1): void {
    if (!this.active) return;
    const def = lightForFrame(this.defs, frameKey);
    if (!def) return;
    const lx = x + def.offX;
    const ly = y + def.offY;
    const lz = z + def.offZ;
    const radius = animatedSize(def, emitterId, this.clock) * RADIUS_SCALE;
    // Dropped before it ever becomes a light: a sprite is offered wherever fog of war has revealed
    // it, which on a map like E1M1 is most of the level and dozens of emitters at once, while the
    // camera holds a few hundred units of it. The falloff bounds a light to its own sphere, so one
    // that misses the view volume cannot reach a drawn pixel — docs/lights.md § What reaches the
    // shader.
    if (this.view) {
      doomToWorld(lx, ly, lz, this.cullSphere.center);
      this.cullSphere.radius = radius;
      if (!this.view.intersectsSphere(this.cullSphere)) return;
    }
    let slot = this.offered[this.offerCount];
    if (slot === undefined) {
      slot = { def, id: emitterId, x: 0, y: 0, z: 0, radius: 0, subsector: -1, sortKey: 0 };
      this.offered.push(slot);
    }
    slot.def = def;
    slot.id = emitterId;
    slot.subsector = subsector;
    slot.x = lx;
    slot.y = ly;
    slot.z = lz;
    slot.radius = radius;
    this.offerCount++;
  }

  /**
   * Closes the frame: culls the offers to the `MAX_DYN_LIGHTS` whose reach comes nearest the
   * camera's target and uploads them. Runs after every draw funnel has offered, and before the
   * render — so geometry sees this frame's lights.
   */
  commit(): void {
    const n = Math.min(this.offerCount, MAX_DYN_LIGHTS);
    if (this.offerCount > MAX_DYN_LIGHTS) {
      // How far the light's edge falls short of the camera's target, so a big light far away can
      // still beat a small one nearby — it is the one that actually covers more of the view. Keyed
      // once per emitter rather than per comparison, and the pool's unused tail is keyed past every
      // live one instead of being truncated away — `offer` reuses those slots next frame.
      for (let i = 0; i < this.offered.length; i++) {
        const e = this.offered[i];
        e.sortKey = i < this.offerCount ? Math.hypot(e.x - this.camX, e.y - this.camY) - e.radius : Infinity;
      }
      this.offered.sort((a, b) => a.sortKey - b.sortKey);
    }

    const pos = this.uniforms.uLightPos.value;
    const col = this.uniforms.uLightColor.value;
    const c = this.committed;
    const vis = this.vis;
    const mask = this.visMask;
    const hadTouched = this.touched.length > 0;
    for (const s of this.touched) {
      const o = s * VIS_WORDS;
      mask[o] = 0;
      mask[o + 1] = 0;
      mask[o + 2] = 0;
      mask[o + 3] = 0;
    }
    this.touched.length = 0;

    for (let i = 0; i < n; i++) {
      const e = this.offered[i];
      doomToWorld(e.x, e.y, e.z, this.scratch);
      pos[i * 4] = this.scratch.x;
      pos[i * 4 + 1] = this.scratch.y;
      pos[i * 4 + 2] = this.scratch.z;
      pos[i * 4 + 3] = e.radius;
      col[i * 3] = e.def.r;
      col[i * 3 + 1] = e.def.g;
      col[i * 3 + 2] = e.def.b;
      c.x[i] = e.x;
      c.y[i] = e.y;
      c.z[i] = e.z;
      c.radius[i] = e.radius;
      c.r[i] = e.def.r;
      c.g[i] = e.def.g;
      c.b[i] = e.def.b;
      c.id[i] = e.id;
      c.dontLightSelf[i] = e.def.dontLightSelf ? 1 : 0;
      if (!vis) continue;
      // Which leaves this light actually reaches, stamped into the shared mask under this light's
      // own bit. A subsector enters `touched` the first time any bit lands on it, so next frame's
      // clear walks the lit leaves rather than the level.
      const word = i >> 5;
      const bit = 1 << (i & 31);
      this.reached.length = 0;
      vis.reach(e.subsector >= 0 ? e.subsector : vis.subsectorAt(e.x, e.y), e.x, e.y, e.radius, this.reached);
      for (const s of this.reached) {
        const o = s * VIS_WORDS;
        if ((mask[o] | mask[o + 1] | mask[o + 2] | mask[o + 3]) === 0) this.touched.push(s);
        mask[o + word] |= bit;
      }
      vis.castShadows(e.x, e.y, e.radius, this.shadows, i * SHADOW_STEPS);
    }
    if (vis && n > 0) this.uniforms.uLightShadow.value.needsUpdate = true;
    this.committedCount = n;
    this.uniforms.uLightCount.value = n;
    // Uploading a frame of all-zeros over the last one is worth doing once; doing it every frame a
    // level sits unlit is not.
    if (this.touched.length > 0 || hadTouched) this.uniforms.uLightVis.value.needsUpdate = true;
  }

  /** Whether light `index` of the committed set reaches `subsector` — the CPU half of the shader's mask test. */
  private reaches(index: number, subsector: number): boolean {
    if (!this.vis) return true;
    if (subsector < 0 || subsector >= this.vis.subsectorCount) return false;
    return (this.visMask[subsector * VIS_WORDS + (index >> 5)] & (1 << (index & 31))) !== 0;
  }

  /**
   * Whether light `index` reaches a point past its shadows — the CPU half of the shader's shadow
   * lookup, so a sprite standing behind a pillar goes dark with the floor it stands on. `x`/`y` are
   * DOOM space; the map is indexed in three.js space, hence the flipped `y`.
   */
  private unshadowed(index: number, x: number, y: number): boolean {
    if (!this.vis) return true;
    const dx = x - this.committed.x[index];
    const dz = -y + this.committed.y[index];
    const bin = Math.floor((Math.atan2(dz, dx) / (2 * Math.PI) + 0.5) * SHADOW_STEPS);
    const at = index * SHADOW_STEPS + Math.max(0, Math.min(SHADOW_STEPS - 1, bin));
    const reach = this.shadows[at] + SHADOW_BIAS;
    return dx * dx + dz * dz <= reach * reach;
  }

  /**
   * The whole of what a drawn sprite does with the lights: offers itself as an emitter, then
   * samples what reaches it. Every draw funnel goes through here rather than pairing the two
   * calls itself — the order is load-bearing (`tintAt` reads last frame's committed set, `offer`
   * fills this frame's), and a sprite that offered without sampling would light the room but not
   * itself.
   *
   * The returned `Tint` is **one reused scratch**, valid until the next call: read it before
   * drawing the next sprite, which every caller does. docs/lights.md § Two lighting paths.
   */
  offerAndTint(frameKey: string, x: number, y: number, z: number, emitterId: number, subsector = -1): Tint {
    this.offer(frameKey, x, y, z, emitterId, subsector);
    this.tintAt(x, y, z, emitterId, this.sampled, subsector);
    return this.sampled;
  }

  /**
   * The light reaching a point, as an additive tint for a sprite. Samples the **previous** frame's
   * committed set: sprites are lit and offered in the same pass, so this frame's set isn't closed
   * yet when a sprite needs its tint. One frame of latency on a moving light's tint is invisible
   * at these speeds, and gathering in a second pass would mean walking every drawn sprite twice.
   *
   * `emitterId` is the sprite's own, so a `dontlightself` light (the barrel's, the armour bonus's)
   * can skip it — GZDoom's own flag, and what keeps a barrel from glowing green in its own light.
   * `subsector` is the sprite's leaf, tested against the same reach mask the geometry shader reads
   * so a sprite behind a wall goes unlit exactly as the wall does.
   */
  tintAt(x: number, y: number, z: number, emitterId: number, out: Tint, subsector = -1): void {
    out.r = 0;
    out.g = 0;
    out.b = 0;
    if (!this.active || this.committedCount === 0) return;
    // Resolved here rather than asked of every drawn sprite: the descent is only worth paying for
    // once some light is actually live, and most callers already hold the answer.
    const ss = subsector >= 0 || !this.vis ? subsector : this.vis.subsectorAt(x, y);
    const c = this.committed;
    for (let i = 0; i < this.committedCount; i++) {
      if (c.dontLightSelf[i] === 1 && c.id[i] === emitterId) continue;
      if (!this.reaches(i, ss)) continue;
      const dx = c.x[i] - x;
      const dy = c.y[i] - y;
      const dz = c.z[i] - z;
      const radius = c.radius[i];
      // Ordered as the shader's is: the falloff first, so only a sprite a light actually reaches
      // pays for the shadow map's atan — and the reject itself is squared, so it costs no sqrt.
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq >= radius * radius) continue;
      if (!this.unshadowed(i, x, y)) continue;
      // GZDoom's own linear falloff (`shaders/glsl/main.fp`), matching the shader half.
      const att = (radius - Math.sqrt(distSq)) / radius;
      out.r += c.r[i] * att;
      out.g += c.g[i] * att;
      out.b += c.b[i] * att;
    }
  }
}
