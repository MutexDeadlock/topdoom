/**
 * `DynamicLights`: the per-frame dynamic light set. Every drawn sprite offers its frame key here,
 * the ones GLDEFS binds a light to become emitters, and the result reaches geometry as a shader
 * uniform array and sprites as an additive tint. See docs/lights.md.
 */
import * as THREE from 'three';
import { DOOM_TIC } from '../constants.ts';
import { lightForFrame, type Gldefs, type LightDef } from '../wad/gldefs.ts';
import { BIN_HALF, BIN_PER_RADIAN, SHADOW_STEPS, type LightVisibility } from './lightvis.ts';
import { LIGHT_CELL_MARGIN } from './lightcells.ts';
import { doomToWorld } from './mapmesh.ts';
import { vecLength } from '../util/geom.ts';
import { readStorage, writeStorage } from '../util/storage.ts';

/**
 * How many lights can reach the geometry shader at once. **Tuned by feel**, and generously: a
 * slaughter map with a hundred projectiles in the air should read as fireworks, which a tight cap
 * turns into lights popping in and out as the ranking shuffles. Raising it costs shader *slots*
 * rather than per-pixel work, since a fragment only ever walks its own leaf's list — but those
 * slots are the ceiling to watch, at two uniform rows per light.
 * docs/lights.md § What reaches the shader.
 */

export const MAX_DYN_LIGHTS = 96;

/**
 * What a GLDEFS `size` is multiplied by to get the radius a light actually reaches. The dial for
 * how far the lights carry: tuned by feel, and the first thing to turn if they read too tight or
 * too washed out. Exported so `tests/render/lights.test.ts` can size its fixtures from it rather
 * than mirroring the number — a test that reddens when this is retuned is pinning the dial.
 */
export const RADIUS_SCALE = 1.25;

/**
 * Texels per row of the visibility texture — the map from light cell to the compacted list of
 * lights that reach it, which is how a fragment learns whether a wall stands between it and a light
 * (docs/lights.md § Light stops at walls, § Light cells). One `RGBA32UI` texel per cell; a level
 * with fewer cells than this gets a single short row rather than a padded one.
 *
 * Any width serves; 1024 keeps both axes inside the 2048-texel minimum every WebGL2 implementation
 * guarantees, for every level this engine loads.
 */
const VIS_TEXTURE_WIDTH = 1024;

/** `RGBA32UI` texels are four 32-bit words. */
const VIS_WORDS = 4;

/**
 * How many lights one cell's texel can name: 16 byte-sized slots in its four words, each a
 * committed light's index, `EMPTY_SLOT` past the last. A **list, not a bitmask** — the list is what
 * bounds the fragment loop, where a bitmask prices every fragment by the size of the whole
 * committed set. Past the cap a cell drops the excess, which by then the clamped sum has made
 * invisible there. Both: docs/lights.md § How the answer reaches a fragment.
 * `MAX_DYN_LIGHTS` must stay below `EMPTY_SLOT`, or a light's index is read as the terminator.
 */
export const MAX_LIGHTS_PER_LEAF = VIS_WORDS * 4;

/**
 * The byte value marking an unused slot, and the word of four of them a cleared texel carries: a
 * texel of all-empty words is an unlit leaf. Exported because `render/textures.ts` splices both
 * into the shader that decodes these texels — one statement of the encoding, or the writer here
 * and the reader there drift apart with nothing to catch it.
 */
export const EMPTY_SLOT = 0xff;

export const EMPTY_WORD = 0xffffffff;

/**
 * How far past its nearest blocker a fragment may still be lit. The wall casting a shadow is itself
 * at exactly the blocker distance, so without this every lit wall face would shadow itself; with
 * it, the face stays lit and the floor behind the wall does not. **Tuned by feel**, bounded on both
 * sides: below about 2 the faces flicker on shallow angles, and above the thickness of the thinnest
 * wall a map draws the far side of that wall lights up too.
 */
export const SHADOW_BIAS = 4;

/**
 * How wide a shadow's edge is, as a half-width in angular bins: a fragment is lit by the fraction
 * of the arc `[bin - this, bin + this]` that clears the blocker, rather than by the one bin it
 * falls in. A binary test draws every shadow with a razor edge, which no light this soft has.
 *
 * **Tuned by feel**, against the arithmetic: a bin is 1.4 degrees (`SHADOW_STEPS`), so three of
 * them is a penumbra of ~7 map units at the rim of a 105-unit light and half that mid-way in —
 * and because the kernel is angular, it widens with distance from the light the way a real one
 * does. It is what sets `SHADOW_TAPS`, so raising it costs fetches per lit fragment.
 */
export const SHADOW_SOFT_BINS = 1.5;

/**
 * Bins one shadow lookup touches, and so the fragment loop's tap count: an interval
 * `2 * SHADOW_SOFT_BINS` wide starts anywhere inside a bin, so it can straddle one more than it
 * spans. Derived rather than tuned — the taps outside the interval weigh zero.
 */
export const SHADOW_TAPS = Math.ceil(2 * SHADOW_SOFT_BINS) + 1;

/**
 * The emitter-ID space every `offer`/`tintAt` caller shares. `dontlightself` and a light's flicker
 * phase both key off the ID, so the three sources must not collide: a thing offers `PosedThing.id`
 * (a plain array index, 0 and up), a one-shot effect counts down from -1 (`effectEmitterId`), and
 * the player sits at `PLAYER_EMITTER_ID` below every effect's. Declared here because
 * `DynamicLights` is the only module that reads any of them. docs/lights.md § What emits.
 */
export const PLAYER_EMITTER_ID = -1_000_000;

/** Sprite tints are sampled into this rather than allocating per drawn sprite. */
export interface Tint {
  r: number;
  g: number;
  b: number;
}

const STORAGE_KEY = 'dynamicLights';

/**
 * How many emitters keep a memo. A one-shot effect (`effectEmitterId`) gets a fresh ID every time
 * one spawns, so without a cap the map would grow for the life of the level; four frames' worth of
 * lights is room enough that nothing on screen is ever evicted.
 */
const MEMO_CAP = MAX_DYN_LIGHTS * 4;

/**
 * Whether dynamic lights are drawn at all. On by default. Shaped like every persisted setting —
 * docs/menu.md § Persisted settings.
 */
let dynamicLightsEnabled = readStorage(STORAGE_KEY, true);

/**
 * One channel of a sector light and a dynamic tint composed: the sum, clamped. The single place the
 * two lighting paths meet on the CPU — shared by the instanced batch and `SpriteActor` so a change
 * to how a tint composes reaches both. docs/lights.md § Two lighting paths.
 */
export function tinted(light: number, tint: number): number {
  return Math.min(light + tint, 1);
}

export function getDynamicLights(): boolean {
  return dynamicLightsEnabled;
}

export function setDynamicLights(enabled: boolean): void {
  dynamicLightsEnabled = enabled;
  writeStorage(STORAGE_KEY, enabled);
}

/**
 * The `n`th one-shot effect's emitter ID. Wraps short of `PLAYER_EMITTER_ID` rather than counting
 * down forever, so a long session cannot walk an effect onto the player's ID and stop a light
 * reaching whichever of the two `dontlightself` then skips.
 */
export function effectEmitterId(n: number): number {
  return -1 - (n % (-PLAYER_EMITTER_ID - 1));
}

/** One light offered this frame, before culling. */
interface Emitter {
  def: LightDef;
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  /**
   * The emitter's own BSP leaf, where the reach fill starts. -1 = the caller had none to hand;
   * resolved at commit.
   */
  subsector: number;
  /** `commit`'s cull key, written only on the frames that overflow — see there. */
  sortKey: number;
}

/**
 * What one emitter's flood and shadow cast answered, and every input they were answered from — the
 * key that says a later frame may reuse them. Both are pure functions of those inputs, and none of
 * them moves on most frames. docs/lights.md § What a light remembers between frames.
 */
interface LightMemo {
  x: number;
  y: number;
  /** The leaf the flood started from, which resolves from the position but is passed in. */
  from: number;
  /** `LightVisibility.sightVersion` when this was answered. */
  sight: number;
  /** The radius `reached` was flooded at — the *live* one, so a flickering light re-floods. */
  reachRadius: number;
  reached: number[];
  /** Cast at `widestSize`, so a flickering light does **not** re-cast. See there. */
  shadows: Float32Array;
  /** The `frame` this was last used on, for `pruneMemos`. */
  frame: number;
}

/**
 * Gathers the frame's lights and hands them to the two consumers: `uniforms` for map geometry
 * (`render/textures.ts` patches every material's shader against them) and `tintAt` for sprites,
 * which are lit on the CPU instead (docs/lights.md § Two lighting paths).
 */
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
    /** Light cell -> compacted list of the lights that reach it. See `bindLevel`. */
    uLightVis: { value: makeVisTexture(new Uint32Array(VIS_WORDS).fill(EMPTY_WORD), 1, 1) },
    /**
     * Row width of that texture, and the flag for whether it means anything: 0 = no level bound —
     * geometry draws no dynamic light, sprite tints stay ungated.
     */
    uLightVisWidth: { value: 0 },
    /**
     * Per light, per direction, how far it gets before a wall stops it. See
     * `LightVisibility.castShadows`.
     */
    uLightShadow: { value: makeShadowTexture(new Float32Array(SHADOW_STEPS * MAX_DYN_LIGHTS)) },
  };

  /**
   * `uLightPos`/`uLightColor`'s arrays under a direct name. Both are allocated once and never
   * replaced — only `uLightVis` is rebound (`bindLevel`) — and the per-sprite tint loop reads
   * them per light in the leaf, where a two-deep property chain is pure overhead.
   */
  private readonly lightPos = this.uniforms.uLightPos.value;
  private readonly lightColor = this.uniforms.uLightColor.value;

  private readonly defs: Gldefs;
  private vis: LightVisibility | null = null;
  /** Per emitter ID, what `reach`/`castShadows` last answered for it — see `LightMemo`. */
  private memos = new Map<number, LightMemo>();
  /** Counts `commit`s, so `pruneMemos` can tell a memo used this frame from one left behind. */
  private frame = 0;
  private visSlots = new Uint32Array(VIS_WORDS).fill(EMPTY_WORD);
  /** Per light cell, how many of its slots are filled — where the next light appends. */
  private visCount = new Uint8Array(0);
  /**
   * Which cells carry a light this frame, so clearing costs the lit ones rather than the level.
   */
  private touched: number[] = [];
  /** `commit`'s scratch for the cells one reached leaf hands a light. */
  private reachedCells: number[] = [];
  /** The shadow texture's own array, one `SHADOW_STEPS` row per committed light. */
  private shadows: Float32Array;
  /**
   * Which emitter ID each shadow-texture row currently holds, or -1 for a row never written. The
   * authority for "is this row already what this light needs": a row belongs to the texture, not
   * to a memo, and rows are handed out fresh each frame by commit order — so a light that sits out
   * a frame and comes back to the row number it last used would otherwise keep whatever light
   * took the row meanwhile.
   */
  private rowOwner = new Int32Array(MAX_DYN_LIGHTS).fill(-1);
  /**
   * Whether any row of `shadows` was rewritten this frame, so a frame of memo hits uploads nothing.
   */
  private shadowsDirty = false;
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
   *
   * Only what the uniform arrays don't already hold: radius and colour live in `uLightPos.w` and
   * `uLightColor`, written by the same `commit` and read by `sampleLight` from there, so the two
   * halves of one light cannot disagree. Position stays here because the uniforms carry it in
   * three.js space and a sprite tint is measured in DOOM space.
   */
  private committed = {
    x: new Float32Array(MAX_DYN_LIGHTS),
    y: new Float32Array(MAX_DYN_LIGHTS),
    z: new Float32Array(MAX_DYN_LIGHTS),
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
   * sprite tint ungated, while geometry — which only ever draws in a bound level — draws no
   * dynamic light, which is what `uLightVisWidth` 0 means to the shader.
   */
  bindLevel(vis: LightVisibility | null): void {
    this.vis = vis;
    this.touched.length = 0;
    // Keyed on emitter IDs and leaf indices, both of which the next level reuses for other things.
    this.memos.clear();
    this.rowOwner.fill(-1);
    this.uniforms.uLightVis.value.dispose();
    if (!vis || vis.subsectorCount === 0) {
      this.visSlots = new Uint32Array(VIS_WORDS).fill(EMPTY_WORD);
      this.visCount = new Uint8Array(0);
      this.uniforms.uLightVis.value = makeVisTexture(this.visSlots, 1, 1);
      this.uniforms.uLightVisWidth.value = 0;
      return;
    }
    const cellCount = vis.cells.cellCount;
    const width = Math.min(VIS_TEXTURE_WIDTH, cellCount);
    const height = Math.ceil(cellCount / width);
    this.visSlots = new Uint32Array(width * height * VIS_WORDS).fill(EMPTY_WORD);
    this.visCount = new Uint8Array(cellCount);
    this.uniforms.uLightVis.value = makeVisTexture(this.visSlots, width, height);
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
   *
   * The position and identity stay **scalars** here and in `offerAndTint`/`tintAt`/`sampleLight`,
   * against docs/conventions.md § Named arguments' usual bar: two of the three callers compute the
   * coordinates inline, and one record per drawn sprite measured ~5% on this path — see
   * docs/lights.md § What reaches the shader.
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
        e.sortKey = i < this.offerCount ? vecLength(e.x - this.camX, e.y - this.camY) - e.radius : Infinity;
      }
      this.offered.sort((a, b) => a.sortKey - b.sortKey);
    }

    const pos = this.uniforms.uLightPos.value;
    const col = this.uniforms.uLightColor.value;
    const c = this.committed;
    const vis = this.vis;
    this.frame++;
    // Asked once for the whole frame: every memo below is keyed on it, and it costs one pass over
    // the sector table — which a frame with no lights at all should not pay.
    const sight = vis && n > 0 ? vis.sightVersion() : 0;
    const slots = this.visSlots;
    const counts = this.visCount;
    const hadTouched = this.touched.length > 0;
    for (const s of this.touched) {
      const o = s * VIS_WORDS;
      slots[o] = EMPTY_WORD;
      slots[o + 1] = EMPTY_WORD;
      slots[o + 2] = EMPTY_WORD;
      slots[o + 3] = EMPTY_WORD;
      counts[s] = 0;
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
      c.id[i] = e.id;
      c.dontLightSelf[i] = e.def.dontLightSelf ? 1 : 0;
      if (!vis) continue;
      const reached = this.recall(vis, e, sight, i);
      // Which leaves this light actually reaches, appended to the slot list of each of their
      // cells the light's box touches — a split leaf hands it to its catch-all and to the sub-cells
      // within `radius + LIGHT_CELL_MARGIN` (docs/lights.md § Light cells). A cell enters
      // `touched` the first time a light lands on it, so next frame's clear walks the lit cells
      // rather than the level. A full cell drops the light — see `MAX_LIGHTS_PER_LEAF`; on the
      // frames that overflowed the cap above, commit order is nearest-first, so what a full cell
      // drops is the least relevant of its lights.
      const cells = this.reachedCells;
      const spread = e.radius + LIGHT_CELL_MARGIN;
      for (const leaf of reached) {
        cells.length = 0;
        vis.cells.cellsWithin(leaf, e.x - spread, e.y - spread, e.x + spread, e.y + spread, cells);
        for (const s of cells) {
          const cnt = counts[s];
          if (cnt === 0) this.touched.push(s);
          if (cnt >= MAX_LIGHTS_PER_LEAF) continue;
          const at = s * VIS_WORDS + (cnt >> 2);
          const shift = (cnt & 3) << 3;
          slots[at] = (slots[at] & ~(EMPTY_SLOT << shift)) | (i << shift);
          counts[s] = cnt + 1;
        }
      }
    }
    this.pruneMemos();
    if (this.shadowsDirty) {
      this.uniforms.uLightShadow.value.needsUpdate = true;
      this.shadowsDirty = false;
    }
    this.committedCount = n;
    this.uniforms.uLightCount.value = n;
    // Uploading a frame of all-empty lists over the last one is worth doing once; doing it every
    // frame a level sits unlit is not.
    if (this.touched.length > 0 || hadTouched) this.uniforms.uLightVis.value.needsUpdate = true;
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
   * `emitterId` is the sprite's own, so a `dontlightself` light can skip it (docs/lights.md § Two
   * lighting paths). `subsector` is the sprite's leaf, and its light list — the same one the
   * geometry shader walks — is all that is sampled, so a sprite behind a wall goes unlit exactly
   * as the wall does.
   */
  tintAt(x: number, y: number, z: number, emitterId: number, out: Tint, subsector = -1): void {
    out.r = 0;
    out.g = 0;
    out.b = 0;
    if (!this.active || this.committedCount === 0) return;
    if (!this.vis) {
      // No level bound (tests, tools): nothing gates, every committed light is sampled.
      for (let i = 0; i < this.committedCount; i++) this.sampleLight(i, x, y, z, emitterId, out);
      return;
    }
    // Resolved here rather than asked of every drawn sprite: the descent is only worth paying for
    // once some light is actually live, and most callers already hold the answer.
    const ss = subsector >= 0 ? subsector : this.vis.subsectorAt(x, y);
    if (ss < 0 || ss >= this.vis.subsectorCount) return;
    // The point's own cell's list — the CPU half of the fragment loop, walking the same slots the
    // shader does rather than testing every committed light against this leaf.
    const cell = this.vis.cells.cellOf(ss, x, y);
    const o = cell * VIS_WORDS;
    const cnt = this.visCount[cell];
    for (let k = 0; k < cnt; k++) {
      const i = (this.visSlots[o + (k >> 2)] >>> ((k & 3) << 3)) & EMPTY_SLOT;
      this.sampleLight(i, x, y, z, emitterId, out);
    }
  }

  /**
   * One light's reached-leaf list, and its shadow row written into `this.shadows` — from the memo
   * where nothing it depends on has moved, freshly computed and remembered where something has.
   *
   * The two halves are checked separately: the flood is keyed on the *live* radius, so a
   * flickering light re-floods every frame, while the cast is taken at `widestSize` and survives
   * the flicker. docs/lights.md § What a light remembers between frames.
   */
  private recall(vis: LightVisibility, e: Emitter, sight: number, index: number): number[] {
    const from = e.subsector >= 0 ? e.subsector : vis.subsectorAt(e.x, e.y);
    let memo = this.memos.get(e.id);
    if (memo === undefined) {
      // Keyed on NaN, which compares unequal to any position: a fresh memo takes the stale branch
      // below, so the key is written in one place rather than in a literal and an update both.
      memo = {
        x: NaN,
        y: NaN,
        from: -1,
        sight: 0,
        reachRadius: -1,
        reached: [],
        shadows: new Float32Array(SHADOW_STEPS),
        frame: this.frame,
      };
      this.memos.set(e.id, memo);
    }
    let recast = false;
    if (memo.x !== e.x || memo.y !== e.y || memo.from !== from || memo.sight !== sight) {
      memo.x = e.x;
      memo.y = e.y;
      memo.from = from;
      memo.sight = sight;
      // Both halves are stale together: everything above is an input to each.
      memo.reachRadius = -1;
      recast = true;
      vis.castShadows(e.x, e.y, widestSize(e.def) * RADIUS_SCALE, memo.shadows, 0);
    }
    if (memo.reachRadius !== e.radius) {
      memo.reachRadius = e.radius;
      memo.reached.length = 0;
      vis.reach(from, e.x, e.y, e.radius, memo.reached);
    }
    memo.frame = this.frame;
    // The row is already in the texture where this light still owns it and the cast did not move —
    // and a memo that answered from cache is exactly the frame that would otherwise re-upload it
    // unchanged.
    if (recast || this.rowOwner[index] !== e.id) {
      this.rowOwner[index] = e.id;
      this.shadows.set(memo.shadows, index * SHADOW_STEPS);
      this.shadowsDirty = true;
    }
    return memo.reached;
  }

  /** Drops every memo no light used this frame, once the map has outgrown `MEMO_CAP`. */
  private pruneMemos(): void {
    if (this.memos.size <= MEMO_CAP) return;
    for (const [id, memo] of this.memos) if (memo.frame !== this.frame) this.memos.delete(id);
  }

  /**
   * How much of light `index` reaches a point past its shadows, 0 to 1 — the CPU half of the
   * shader's shadow lookup, so a sprite standing behind a pillar goes dark with the floor it stands
   * on, and softens across the shadow's edge with it (`SHADOW_SOFT_BINS`). `x`/`y` are DOOM space;
   * the map is indexed in three.js space, hence the flipped `y`.
   */
  private unshadowed(index: number, x: number, y: number): number {
    if (!this.vis) return 1;
    const dx = x - this.committed.x[index];
    const dz = -y + this.committed.y[index];
    const dist = vecLength(dx, dz);
    const lo = Math.atan2(dz, dx) * BIN_PER_RADIAN + BIN_HALF - SHADOW_SOFT_BINS;
    const span = 2 * SHADOW_SOFT_BINS;
    const base = Math.floor(lo);
    let lit = 0;
    for (let t = 0; t < SHADOW_TAPS; t++) {
      const b = base + t;
      const w = Math.min(b + 1, lo + span) - Math.max(b, lo);
      if (w <= 0) continue;
      const at = index * SHADOW_STEPS + (b < 0 ? b + SHADOW_STEPS : b >= SHADOW_STEPS ? b - SHADOW_STEPS : b);
      if (dist <= this.shadows[at] + SHADOW_BIAS) lit += w;
    }
    return lit / span;
  }

  /** One committed light's contribution to a sprite tint — the body `tintAt`'s two paths share. */
  private sampleLight(i: number, x: number, y: number, z: number, emitterId: number, out: Tint): void {
    const c = this.committed;
    if (c.dontLightSelf[i] === 1 && c.id[i] === emitterId) return;
    const dx = c.x[i] - x;
    const dy = c.y[i] - y;
    const dz = c.z[i] - z;
    const radius = this.lightPos[i * 4 + 3];
    // Ordered as the shader's is: the falloff first, so only a sprite a light actually reaches
    // pays for the shadow map's atan — and the reject itself is squared, so it costs no sqrt.
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= radius * radius) return;
    const lit = this.unshadowed(i, x, y);
    if (lit <= 0) return;
    // GZDoom's own linear falloff (`shaders/glsl/main.fp`), matching the shader half.
    const att = ((radius - Math.sqrt(distSq)) / radius) * lit;
    const col = this.lightColor;
    out.r += col[i * 3] * att;
    out.g += col[i * 3 + 1] * att;
    out.b += col[i * 3 + 2] * att;
  }
}

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

/**
 * A deterministic hash of an emitter ID and a step number into [0, 1). This is what animates the
 * flicker, and it is **not** `util/random`: the vanilla table is the engine's gameplay entropy on
 * two global cursors, so drawing from it here would make what a monster does depend on how many
 * torches were on screen. See docs/random.md § Why the cursors are global.
 *
 * Being a pure function of (ID, step) also means a light needs no per-emitter state to survive a
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
 * The widest radius a def can ever show, before `RADIUS_SCALE` — the two sizes every animated kind
 * cycles between, and the one size a point light holds.
 *
 * Shadows are cast at *this* rather than at the instant's radius, which is what lets one cast
 * serve a flickering light for as long as it stands still: a blocker recorded past the live radius
 * is further than any fragment that survives the falloff, so the extra reach can never change a
 * verdict. docs/lights.md § What a light remembers between frames.
 */
function widestSize(def: LightDef): number {
  return def.kind === 'point' ? def.size : Math.max(def.size, def.secondarySize);
}

/**
 * The radius a light shows at this instant, before `RADIUS_SCALE`. Each branch is GZDoom's
 * `ADynamicLight::Tick` (`a_dynlight.cpp`), with its per-actor cycler state replaced by a pure
 * function of the emitter ID and the clock — see `hash01`.
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
