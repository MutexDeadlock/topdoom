/**
 * Fades the walls (and overhanging flats) that sit between the camera and the player, as a
 * dithered discard rather than alpha blending — plus `SurfaceScroller`, which walks the same
 * static-batch geometry to apply Boom's scrolling texture offsets.
 * See docs/render.md § Wall occlusion fading and § Scrolling textures.
 */
import * as THREE from 'three';
import { WALL_CHUNK_LEN, type FlatSurface, type WallOccluder } from './mapmesh.ts';
import type { MaterialBank } from './textures.ts';
import { polygonCentroid, segmentCrossT, segmentMeetsConvexPolygon, signedPolygonArea2 } from '../util/geom.ts';
import { dampenWith } from '../util/damping.ts';
import { PLAYER_HEIGHT } from '../game/player.ts';
import type { StandingBody } from '../game/things/defs.ts';
import type { Opening } from '../game/world.ts';
import type { Pos3 } from '../types.ts';

/**
 * Target coverage (0..1) once a wall sits on the camera-player sightline —
 * rendered as a dithered discard (see MaterialBank.get), not real alpha
 * blending, so this reads as "fraction of pixels kept," not translucency.
 */
export const FADE_ALPHA = 0.2;
/** Exponential smoothing rate (1/seconds) so fades don't pop in/out per frame. */
const FADE_SPEED = 10;
/** Snap-to-target threshold for `dampen` — see its doc for why this matters. */
const SNAP_EPS = 0.004;

/**
 * How wide a hole a sightline opens in whatever it is stopped by, and the
 * full-strength core inside it where the ramp has not started easing back yet.
 * Walls and flats share both, so a hole spanning a floor and the wall behind
 * it is one shape. **Tuned by feel**, but not freely: alpha exists only at
 * chunk corners, so a `FADE_CORE` under `WALL_CHUNK_LEN / 2` cannot open a hole
 * wider than one chunk however the ramp is shaped, and on a tall occluder seen
 * at a grazing angle that one chunk reads as a slit. Sized off the chunk for
 * that reason rather than set as a bare number. Why the tests read these rather
 * than mirroring them: docs/render.md § The fade is a hole, not a wall.
 */
export const FADE_RADIUS = WALL_CHUNK_LEN * 1.5;
/**
 * The core is this fraction of whatever radius a target carries, so every
 * target's hole is the one shape scaled. Stated once, here: `holeAlpha` shapes
 * the ramp through it and `FADE_CORE` is the player's own radius through it, so
 * retuning the ratio moves the renderer and the tests together.
 */
const FADE_CORE_FRACTION = 0.5;
export const FADE_CORE = FADE_RADIUS * FADE_CORE_FRACTION;

/**
 * Total occluder count below which `WallFader` scans them all instead of building an index: over a
 * short list the 3x3 cell walk costs more than the scan it replaces. **Tuned by feel.**
 *
 * A mover fader is *not* excluded, and on a big sector it does cross this — the grid is indexed on
 * quad midpoints, and `refreshMoverMesh` changes a mover's heights, never a quad's footprint
 * (`copyRefreshedQuad`), so the buckets stay true across a refresh. A rebuild that does reshape the
 * mesh builds a fresh fader with it (`MoverGeometry.createMoverMesh`).
 */
const GRID_MIN_OCCLUDERS = 256;

/**
 * What occlusion is tested against — the player, or an awake monster (see
 * `WallFader.update`'s doc). Not a point: `z` is the middle of an **upright
 * sprite** and `halfHeight` how far that sprite reaches above and below it, so
 * a sightline is a wedge rather than a ray and something covering only the
 * head still counts as hiding the target. docs/render.md § The target is the
 * billboard.
 *
 * `fadeFloor` is how far down this target alone pulls what hides it
 * (`FADE_ALPHA` is full strength) and `fadeRadius` how wide a hole it opens.
 */
export type FadeTarget = Pos3 & { halfHeight: number; fadeFloor: number; fadeRadius: number };

/**
 * The quads a `commit` caller knows fog of war moved this frame — `count`
 * entries of `indices`, which is a reused buffer and longer than `count`.
 * Declared structurally here rather than imported, so the render layer keeps no
 * import edge into `game/fogofwar.ts` (the `ScrollOffsets` rule below).
 * `null` means "assume all of them", which is what a wholesale reveal reports.
 */
export interface ChangedQuads {
  readonly indices: Int32Array;
  readonly count: number;
}

/**
 * The alpha one crossing pulls a point at `distanceSquared` from it down to:
 * `floor` inside the core, smoothstepped back to 1 by `radius`, and 1 beyond.
 * The core is always half the radius, so a target's hole is one shape scaled.
 * The one ramp both faders window with — a hole spanning a floor and the wall
 * behind it is one shape because this is one function.
 * docs/render.md § The fade is a hole, not a wall.
 */
function holeAlpha(distanceSquared: number, floor: number, radius: number): number {
  if (distanceSquared >= radius * radius) return 1;
  const core = radius * FADE_CORE_FRACTION;
  const d = Math.sqrt(distanceSquared);
  if (d <= core) return floor;
  const t = (d - core) / (radius - core);
  return floor + (1 - floor) * t * t * (3 - 2 * t);
}

/**
 * A growable bag of the points a pass-one sweep found — where a sightline was
 * actually stopped, and which target it was stopped for. Everything else about
 * the hole (its floor, its radius, where the target's own plane cuts it) is a
 * property of that target, so a crossing carries the index rather than a copy.
 * Both faders file the same four channels, so they share one structure rather
 * than two sets of parallel arrays.
 *
 * One bag holds a whole frame's stops across **every** fader of its kind, since
 * a hole has to dissolve whatever lies inside it whichever mesh that is in —
 * docs/render.md § One hole, whichever mesh it lands in. Walls and flats keep
 * one each: a wall crossing and a floor pierce are different points and fold
 * different geometry.
 */
export class FadeCrossings {
  x: Float64Array = new Float64Array(64);
  y: Float64Array = new Float64Array(64);
  /** The height the sightline was stopped at: a wall crossing's, or the plane a floor pierce sits in. */
  h: Float64Array = new Float64Array(64);
  /** Which target's sightline was stopped here — an index into `TargetPlanes`. */
  target: Float64Array = new Float64Array(64);
  count = 0;
  /**
   * Where the whole bag stands, grown as points arrive. Kept here rather than
   * derived by each reader because the bag is the frame's, not a fader's: every
   * fader that folds it would otherwise rebuild the same box, and only `push`
   * can change the answer. Empty (inverted) until the first point.
   */
  readonly bounds: FadeBox = emptyBox();

  reset(): void {
    this.count = 0;
    this.bounds.minX = Infinity;
    this.bounds.minY = Infinity;
    this.bounds.maxX = -Infinity;
    this.bounds.maxY = -Infinity;
  }

  push(x: number, y: number, h: number, target: number): void {
    if (this.count === this.x.length) {
      this.x = grow(this.x);
      this.y = grow(this.y);
      this.h = grow(this.h);
      this.target = grow(this.target);
    }
    this.x[this.count] = x;
    this.y[this.count] = y;
    this.h[this.count] = h;
    this.target[this.count] = target;
    this.count++;
    stretchBox(this.bounds, x, y);
  }
}

/**
 * Per target, for the frame: the **vertical** plane its sprite stands in.
 * Nothing behind that plane can be hiding the target, so nothing there fades —
 * see docs/render.md § The target is the billboard. Both faders keep one,
 * refilled per `update`; the hole dials stay on the target itself, which every
 * read site already holds.
 */
class TargetPlanes {
  /**
   * The camera→target offset in plan, and `dot(n, target)`: `dot(n, p) > d0` is
   * past the target. Deliberately **not** normalized — every test compares two
   * dot products against this same `n`, so scaling it changes neither side,
   * and the hypot-and-two-divides per target is measurable across the
   * thousand-odd mover faders a frame refills — docs/render.md § The target is
   * the billboard.
   *
   * A camera standing exactly over a target *in plan* leaves `n` and `d0` both
   * zero, and `0 > 0` cuts nothing: that target's hole goes back to the whole
   * ball it was before there was a plane at all. `MIN_TILT_DEG` keeps the player
   * off that point; a monster can stand on it, and eats one frame of the wide
   * hole the cut exists to stop.
   */
  nx = new Float64Array(0);
  ny = new Float64Array(0);
  d0 = new Float64Array(0);

  /** Refills for this frame's targets, growing on demand. */
  fill(camX: number, camY: number, targets: readonly FadeTarget[]): void {
    if (this.nx.length < targets.length) {
      const n = targets.length;
      this.nx = new Float64Array(n);
      this.ny = new Float64Array(n);
      this.d0 = new Float64Array(n);
    }
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k];
      const nx = t.x - camX;
      const ny = t.y - camY;
      this.nx[k] = nx;
      this.ny[k] = ny;
      this.d0[k] = nx * t.x + ny * t.y;
    }
  }
}

function grow(a: Float64Array): Float64Array {
  const next = new Float64Array(a.length * 2);
  next.set(a);
  return next;
}

/**
 * How far an awake monster can be and still count as a fade target.
 * **Tuned by feel** to roughly a room's length, not converted from vanilla.
 * Deliberately a plain distance cap rather than a `hasLineOfSight` gate, which
 * would make the fade a no-op for the case it exists for — docs/render.md §
 * Wall occlusion fading.
 */
export const MONSTER_FADE_RANGE = 768;

/**
 * How wide a hole an awake *monster* opens, as against the player's
 * `FADE_RADIUS` — **tuned by feel**, and deliberately the smallest that still
 * clears a whole chunk rather than a slit (alpha lives only at chunk corners,
 * so a core under `WALL_CHUNK_LEN / 2` cannot). The player's hole is wider
 * because it is centred on the one place the view has to be readable, and what
 * it dissolves is what you were looking at anyway; a monster's is centred
 * somewhere else, and everything it dissolves is context you wanted — the
 * switch on the wall in front of you included.
 * docs/render.md § The fade is a hole, not a wall.
 */
export const MONSTER_FADE_RADIUS = FADE_RADIUS / 2;

/**
 * Most awake monsters that can be fade targets at once, nearest first. Purely
 * a cost bound (`WallFader` cost is quads × targets): past a couple of dozen
 * nearby monsters, every wall any of them stands behind is already faded by a
 * nearer one. See docs/monster-ai.md § Spatial indexing.
 */
const MAX_FADE_TARGETS = 48;

/**
 * The player plus the awake monsters near enough to fade walls for, nearest
 * first and capped at `MAX_FADE_TARGETS`. A wall/flat hiding a monster only
 * fades once that monster is alerted — an unseen sleeping one is supposed to
 * stay hidden — so the caller passes `ThingLayer.awakeMonsters()`, not every
 * monster. **Each target's wedge is its own body**: a monster brings its
 * `mobjinfo.height` (`StandingBody.height`, 56 for an imp to 110 for a
 * cyberdemon), the player `PLAYER_HEIGHT`, and either way `z` is the middle of
 * that span and `halfHeight` reaches from there to the feet and to the crown —
 * the same centre-and-half-extent `shotPath` locks onto as `ShotLock.halfHeight`.
 * docs/render.md § The target is the billboard.
 */
export function collectFadeTargets(player: Pos3, awakeMonsters: readonly StandingBody[]): FadeTarget[] {
  const nearby = awakeMonsters
    .map((m) => ({ m, d: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((e) => e.d <= MONSTER_FADE_RANGE);
  nearby.sort((a, b) => a.d - b.d);
  return [
    {
      x: player.x,
      y: player.y,
      z: player.z + PLAYER_HEIGHT / 2,
      halfHeight: PLAYER_HEIGHT / 2,
      fadeFloor: FADE_ALPHA,
      fadeRadius: FADE_RADIUS,
    },
    ...nearby.slice(0, MAX_FADE_TARGETS).map((e) => ({
      x: e.m.x,
      y: e.m.y,
      z: e.m.z + e.m.height / 2,
      halfHeight: e.m.height / 2,
      // Full strength beside the player, easing to no fade at all by the range
      // cap: a monster the player can barely make out shouldn't cost a wall,
      // and a fade that reached the cap at full strength would pop as the
      // monster crossed it. Linear, **tuned by feel**.
      fadeFloor: FADE_ALPHA + (1 - FADE_ALPHA) * (e.d / MONSTER_FADE_RANGE),
      fadeRadius: MONSTER_FADE_RADIUS,
    })),
  ];
}

/** `sightBox`'s output, reused: the two faders run back to back and neither holds the box past its own update. */
const sightBoxOut = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

/**
 * The box every sightline of one frame lives inside — the camera, stretched over every target. A
 * line side or a fan whose own bounds miss it cannot be crossed by any sightline, which is what
 * both faders reject on before any crossing work. Exact, not a heuristic.
 * docs/render.md § The fade is a hole, not a wall.
 */
function sightBox(camX: number, camY: number, targets: FadeTarget[]): typeof sightBoxOut {
  let minX = camX;
  let maxX = camX;
  let minY = camY;
  let maxY = camY;
  for (const t of targets) {
    if (t.x < minX) minX = t.x;
    if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.y > maxY) maxY = t.y;
  }
  sightBoxOut.minX = minX;
  sightBoxOut.maxX = maxX;
  sightBoxOut.minY = minY;
  sightBoxOut.maxY = maxY;
  return sightBoxOut;
}

/** A 2D box in DOOM map space, for `fadeReach`'s caller to test its own geometry against. */
export interface FadeBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** An inverted box, which `stretchBox` turns into the bound of whatever it is then given. */
export function emptyBox(): FadeBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

/** Grows `box` to hold one more point. */
export function stretchBox(box: FadeBox, x: number, y: number): void {
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (y < box.minY) box.minY = y;
  if (y > box.maxY) box.maxY = y;
}

/**
 * Whether two map-space boxes touch at all — a mover's footprint against a fade
 * reach or a reveal, or a fader's against the frame's bag of crossings. An
 * empty box (`emptyBox`, never stretched) overlaps nothing, which is the answer
 * a fader with no quads and a bag with no points both want.
 */
export function boxesOverlap(a: FadeBox, b: FadeBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** `box` grown on every side by `by`, written into `out` — an empty box stays empty. */
function grownBox(box: FadeBox, by: number, out: FadeBox): FadeBox {
  out.minX = box.minX - by;
  out.minY = box.minY - by;
  out.maxX = box.maxX + by;
  out.maxY = box.maxY + by;
  return out;
}

/** The widest hole any of this frame's targets opens — how far a crossing can fold. */
function maxFadeRadius(targets: readonly FadeTarget[]): number {
  let radius = 0;
  for (const t of targets) if (t.fadeRadius > radius) radius = t.fadeRadius;
  return radius;
}

/**
 * Scratch for the whole-bag rejects below. Module-level and reused: they run
 * once per fader per frame across a level's thousands of them, and the box
 * never outlives the compare it feeds.
 */
const scratchReach: FadeBox = emptyBox();

/**
 * Everything this frame's fading can reach: the sight box above, grown by the
 * widest hole any of the targets opens. A crossing lies on a sightline and so
 * inside that box, and it folds nothing further than its own radius, so
 * geometry outside this box cannot change — which is what lets
 * `MoverGeometry.updateFading` skip a mesh outright once its faders are also
 * `idle`. See docs/render.md § Mover meshes a frame cannot touch.
 */
export function fadeReach(camX: number, camY: number, targets: FadeTarget[], out: FadeBox): void {
  grownBox(sightBox(camX, camY, targets), maxFadeRadius(targets), out);
}

/**
 * Fades the wall quads currently sitting on a camera→target sightline. `update` only computes
 * that factor; a wall's on-screen alpha is its *product* with fog of war's reveal — two systems
 * driving the same vertex-alpha channel — so `commit` writes the combined value once both are
 * known. See docs/render.md § Wall occlusion fading.
 */
export class WallFader {
  private occluders: WallOccluder[];
  private meshes: Map<string, THREE.Mesh>;
  /**
   * Damped occlusion factor per quad **corner** — four per occluder, in
   * `addWall`'s A/D/C/B order (top-left, bottom-left, bottom-right, top-right).
   * Per corner rather than per edge is what makes the fade a ball rather than a
   * full-height slab of wall.
   */
  private occlusionAlpha: Float32Array;
  /** What `commit` last wrote per corner, so an unchanged quad costs no rewrite. NaN until first written, so the first commit always lands. */
  private lastCombined: Float32Array;
  /** This frame's un-damped target alpha per quad corner, folded down by every crossing that reaches it. */
  private wanted: Float32Array;
  /**
   * Per quad, whether it is the passable gap of its own line — an opening a body can walk through,
   * screened by a **masked** texture a look already passes through, so fading it reveals nothing.
   *
   * **Asked lazily**, of the quads a sightline crosses in pass one and the quads a crossing reaches
   * in pass two, and at most once per quad per frame (`passableStamp`). Deciding it for every quad
   * up front was most of what pass one cost on a map with tens of thousands of them, and on a
   * frame where the camera holds a few hundred units of the level almost none of them are asked.
   */
  private passable: Uint8Array;
  /** The `update` each `passable` entry was last decided on. */
  private passableStamp: Int32Array;
  /** Whether each batch's texture is masked, memoised — one material lookup per texture for the fader's life. */
  private maskedByKey = new Map<string, boolean>();
  private frameStamp = 0;
  /** Reused by `update`'s per-line opening lookup — see `openingInto`. */
  private opening: Opening = { top: 0, bottom: 0 };
  /** Per-target scratch, grown on demand: position, sprite half-height, and the current line side's crossings. */
  private tx = new Float64Array(0);
  private ty = new Float64Array(0);
  private tz = new Float64Array(0);
  private th = new Float64Array(0);
  private hitX = new Float64Array(0);
  private hitY = new Float64Array(0);
  private hitH = new Float64Array(0);
  /** Half the height the target's sprite spans *at the crossing* — the wedge's own half-thickness there. */
  private hitSpread = new Float64Array(0);
  private hitTarget = new Float64Array(0);
  /** This frame's per-target hole dials and cut planes. */
  private planes = new TargetPlanes();
  /** Which group last recorded a crossing for each hit slot — a stamp, so dedup needs no per-group clear. */
  private hitStamp = new Int32Array(0);
  private groupStamp = 0;
  /**
   * `update`'s own bag, for a fader that stands alone: a frame with several of
   * them shares one instead (`collectCrossings`). Allocated on first use, since
   * a level's mover faders — thousands of them — only ever take the shared one.
   */
  private crossings: FadeCrossings | null = null;
  /** Uniform grid over chunk midpoints, so a crossing can find the quads around it without scanning the map. Null below `GRID_MIN_OCCLUDERS`. */
  private grid: {
    cell: number;
    minX: number;
    minY: number;
    cols: number;
    rows: number;
    /** Prefix sums into `items`, one per cell plus a terminator. */
    start: Int32Array;
    items: Int32Array;
  } | null = null;
  /** Occluder indices a crossing might reach, refilled per query (the whole list when there is no grid). */
  private candidates: Int32Array;
  /**
   * Every quad's footprint, boxed — what lets `applyCrossings` drop a crossing,
   * or the frame's whole bag of them, that lands nowhere near this fader.
   * Built once, for the reason `buildGrid` gives: a refresh changes heights,
   * never footprints. Empty on a fader with no quads, which then rejects
   * everything. `MoverGeometry` seeds its mesh bounds from it rather than
   * walking the same quads again.
   */
  readonly footprint: FadeBox = emptyBox();
  /**
   * The runs of quads sharing a line side, which `addWall` emits together —
   * `[runFirst[r], runLast[r]]` plus that side's own segment and linedef. Pass
   * one walks *these* rather than every quad: the box test is per line side
   * already, and on a map with hundreds of thousands of quads the run it
   * belongs to is the only thing most of them would have contributed to. Built
   * once, since a refresh changes a mover quad's heights but never which line
   * side it came from (see `buildGrid` for the same argument about footprints).
   */
  private runFirst: Int32Array;
  private runLast: Int32Array;
  private runLine: Int32Array;
  private runSegAx: Float64Array;
  private runSegAy: Float64Array;
  private runSegBx: Float64Array;
  private runSegBy: Float64Array;
  private runCount = 0;
  /**
   * The quads whose alpha is not settled at 1 — the only ones `update` has to
   * reset, damp and hand to `commit`. A quad joins when a crossing first folds
   * it and leaves once it has relaxed all the way back, so the per-frame cost
   * follows the size of the hole rather than the size of the map.
   * `activeSlot[j]` is where quad `j` sits in `active`, or -1.
   */
  private active: Int32Array;
  private activeSlot: Int32Array;
  private activeCount = 0;
  /**
   * The `update` a still-active quad first came to rest on, or -1 while it is
   * still moving. A quad is kept one extra frame after it settles so the
   * `commit` that follows still writes the value it settled *on*; the next
   * `update` is what drops it.
   */
  private settledStamp: Int32Array;
  /** Set until the first `commit`, which has to write every quad because `lastCombined` starts NaN. */
  private commitAll = true;
  /**
   * The highest combined alpha the last `commit` resolved for each mesh key —
   * zero means every quad that mesh draws is currently invisible, which is what
   * lets a caller skip drawing it entirely (`MoverGeometry.updateFading`).
   * Only filled when `trackVisibility` is on, since maintaining it costs a map
   * lookup per quad per frame and the static batches have tens of thousands of
   * them with no use for the answer.
   * See docs/render.md § Skipping invisible mover meshes.
   */
  readonly maxAlphaByKey = new Map<string, number>();
  private trackVisibility: boolean;
  /** The batches this frame's `commit` wrote into, reused rather than reallocated: a level can hold a couple of thousand faders and every one of them commits every frame. */
  private dirtyKeys = new Set<string>();

  constructor(occluders: WallOccluder[], meshes: Map<string, THREE.Mesh>, trackVisibility = false) {
    this.occluders = occluders;
    this.meshes = meshes;
    this.occlusionAlpha = new Float32Array(occluders.length * 4).fill(1);
    this.lastCombined = new Float32Array(occluders.length * 4).fill(NaN);
    this.wanted = new Float32Array(occluders.length * 4);
    this.passable = new Uint8Array(occluders.length);
    this.passableStamp = new Int32Array(occluders.length).fill(-1);
    this.candidates = new Int32Array(occluders.length);
    this.active = new Int32Array(occluders.length);
    this.activeSlot = new Int32Array(occluders.length).fill(-1);
    this.settledStamp = new Int32Array(occluders.length).fill(-1);
    this.runFirst = new Int32Array(occluders.length);
    this.runLast = new Int32Array(occluders.length);
    this.runLine = new Int32Array(occluders.length);
    this.runSegAx = new Float64Array(occluders.length);
    this.runSegAy = new Float64Array(occluders.length);
    this.runSegBx = new Float64Array(occluders.length);
    this.runSegBy = new Float64Array(occluders.length);
    this.trackVisibility = trackVisibility;
    this.buildRuns();
    if (occluders.length > GRID_MIN_OCCLUDERS) this.buildGrid();
    else for (let i = 0; i < occluders.length; i++) this.candidates[i] = i;
  }

  /**
   * Collects the maximal runs of consecutive quads sharing a line side. A run
   * that broke up would cost an extra crossing solve, never a different answer
   * — the same tolerance pass one always had for its grouping. Takes
   * `footprint` on the way past, since it is the one walk over every quad.
   */
  private buildRuns(): void {
    let line = -1;
    let front = false;
    for (let i = 0; i < this.occluders.length; i++) {
      const o = this.occluders[i];
      stretchBox(this.footprint, o.ax, o.ay);
      stretchBox(this.footprint, o.bx, o.by);
      if (this.runCount === 0 || o.line !== line || o.frontSide !== front) {
        line = o.line;
        front = o.frontSide;
        const r = this.runCount++;
        this.runFirst[r] = i;
        this.runLine[r] = o.line;
        this.runSegAx[r] = o.segAx;
        this.runSegAy[r] = o.segAy;
        this.runSegBx[r] = o.segBx;
        this.runSegBy[r] = o.segBy;
      }
      this.runLast[this.runCount - 1] = i;
    }
    // A line side is many quads on a big map, so the scratch these were built
    // in is mostly slack: keep what was used and let the rest go.
    this.runFirst = this.runFirst.slice(0, this.runCount);
    this.runLast = this.runLast.slice(0, this.runCount);
    this.runLine = this.runLine.slice(0, this.runCount);
    this.runSegAx = this.runSegAx.slice(0, this.runCount);
    this.runSegAy = this.runSegAy.slice(0, this.runCount);
    this.runSegBx = this.runSegBx.slice(0, this.runCount);
    this.runSegBy = this.runSegBy.slice(0, this.runCount);
  }

  /**
   * Puts a quad on the active list if it isn't there, and gives its four
   * corners a fresh `wanted` of 1 as it joins — the reset the whole-array fill
   * used to do for every quad on the map.
   */
  private markActive(j: number): void {
    if (this.activeSlot[j] >= 0) return;
    this.activeSlot[j] = this.activeCount;
    this.active[this.activeCount++] = j;
    this.settledStamp[j] = -1;
    const base = j * 4;
    this.wanted[base] = 1;
    this.wanted[base + 1] = 1;
    this.wanted[base + 2] = 1;
    this.wanted[base + 3] = 1;
  }

  /**
   * Buckets every quad by its midpoint. The cell is sized so the eight
   * neighbours of a crossing's own cell always cover `FADE_RADIUS` plus the
   * furthest a quad's corner can sit from the midpoint that filed it — which is
   * what lets a query stop at 3×3.
   */
  private buildGrid(): void {
    let halfChunk = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const o of this.occluders) {
      const half = Math.hypot(o.bx - o.ax, o.by - o.ay) / 2;
      if (half > halfChunk) halfChunk = half;
      const mx = (o.ax + o.bx) / 2;
      const my = (o.ay + o.by) / 2;
      if (mx < minX) minX = mx;
      if (mx > maxX) maxX = mx;
      if (my < minY) minY = my;
      if (my > maxY) maxY = my;
    }
    const cell = FADE_RADIUS + halfChunk;
    const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    const rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    const start = new Int32Array(cols * rows + 1);
    const items = new Int32Array(this.occluders.length);
    const cellOf = (o: WallOccluder) => {
      const col = Math.min(cols - 1, Math.max(0, Math.floor(((o.ax + o.bx) / 2 - minX) / cell)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor(((o.ay + o.by) / 2 - minY) / cell)));
      return row * cols + col;
    };
    for (const o of this.occluders) start[cellOf(o) + 1]++;
    for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
    const cursor = Int32Array.from(start.subarray(0, cols * rows));
    for (let i = 0; i < this.occluders.length; i++) items[cursor[cellOf(this.occluders[i])]++] = i;
    this.grid = { cell, minX, minY, cols, rows, start, items };
  }

  /** Fills `candidates` with the quads a crossing at (x, y) could reach, and returns how many. */
  private candidatesNear(x: number, y: number): number {
    const g = this.grid;
    if (!g) return this.occluders.length;
    const col = Math.min(g.cols - 1, Math.max(0, Math.floor((x - g.minX) / g.cell)));
    const row = Math.min(g.rows - 1, Math.max(0, Math.floor((y - g.minY) / g.cell)));
    let count = 0;
    for (let r = Math.max(0, row - 1); r <= Math.min(g.rows - 1, row + 1); r++) {
      for (let c = Math.max(0, col - 1); c <= Math.min(g.cols - 1, col + 1); c++) {
        const cellIndex = r * g.cols + c;
        for (let k = g.start[cellIndex]; k < g.start[cellIndex + 1]; k++) this.candidates[count++] = g.items[k];
      }
    }
    return count;
  }

  /**
   * Whether nothing here is faded or still relaxing — so an `update` that can
   * fold none of these quads (see `fadeReach`) would do nothing at all.
   */
  get idle(): boolean {
    return this.activeCount === 0;
  }

  /**
   * Forgets what `commit` believes is in the vertex buffers, so the next one
   * writes every quad again. For the one thing that changes those buffers
   * behind this class's back: `refreshMoverMesh` rewrites a mover's whole
   * colour attribute, alpha channel included, and without this the
   * unchanged-alpha skip keeps a refreshed quad at whatever the *builder* put
   * there — a door in unrevealed space drawn solid while it moves.
   * docs/render.md § Mover meshes a frame cannot touch.
   */
  invalidateWritten(): void {
    this.lastCombined.fill(NaN);
    this.commitAll = true;
  }

  /** Grows the per-target scratch to hold `n` targets. */
  private ensureTargetScratch(n: number): void {
    if (this.tx.length >= n) return;
    this.tx = new Float64Array(n);
    this.ty = new Float64Array(n);
    this.tz = new Float64Array(n);
    this.th = new Float64Array(n);
    this.hitX = new Float64Array(n);
    this.hitY = new Float64Array(n);
    this.hitH = new Float64Array(n);
    this.hitSpread = new Float64Array(n);
    this.hitTarget = new Float64Array(n);
    this.hitStamp = new Int32Array(n).fill(-1);
  }

  /**
   * Camera position in DOOM (x, y, height) coordinates, and every point a wall
   * between the camera and it should fade for — the player plus the nearest
   * awake monsters (`collectFadeTargets`).
   *
   * Two passes. The first finds where each sightline meets something genuinely
   * solid; the second dissolves a ball of geometry around each of those
   * crossing points. The split is what lets the hole span whatever walls it
   * lands on rather than stopping at the crossed linedef's own ends —
   * docs/render.md § The fade is a hole, not a wall.
   *
   * `openingInto` (`World.openingInto`, threaded in as a callback so this class
   * needs no `World` of its own) tells a genuinely solid quad from one that
   * only *renders* solid. The lookup is per line, but the test it feeds is per
   * **quad**, and that distinction is load-bearing: docs/render.md § Wall
   * occlusion fading.
   *
   * Both passes over this fader's own crossings alone — right for a fader that
   * is the only one on the map, which is what the tests build. A level splits
   * its walls across the static batches and one mesh per mover, and those share
   * a bag through `collectCrossings`/`applyCrossings` instead.
   */
  update(
    dt: number,
    camX: number,
    camY: number,
    camZ: number,
    targets: FadeTarget[],
    openingInto: (line: number, out: Opening) => boolean,
  ): void {
    const bag = (this.crossings ??= new FadeCrossings());
    bag.reset();
    this.collectCrossings(camX, camY, camZ, targets, openingInto, bag);
    this.applyCrossings(dt, camX, camY, targets, openingInto, bag);
  }

  /**
   * Pass one, appending to `out` rather than replacing it: where this fader's
   * own walls stop each sightline. The caller resets the bag once for the frame
   * and hands the same one to every fader, so what one fader's wall stops the
   * next fader's geometry still has to make way for —
   * docs/render.md § One hole, whichever mesh it lands in.
   *
   * Pairs with `applyCrossings`, and runs first: it is where the frame's
   * `passable` memo is stamped.
   */
  collectCrossings(
    camX: number,
    camY: number,
    camZ: number,
    targets: FadeTarget[],
    openingInto: (line: number, out: Opening) => boolean,
    out: FadeCrossings,
  ): void {
    const n = targets.length;
    this.frameStamp++;
    this.ensureTargetScratch(n);
    const { minX: boxMinX, maxX: boxMaxX, minY: boxMinY, maxY: boxMaxY } = sightBox(camX, camY, targets);
    for (let k = 0; k < n; k++) {
      const t = targets[k];
      this.tx[k] = t.x;
      this.ty[k] = t.y;
      this.tz[k] = t.z;
      this.th[k] = t.halfHeight;
    }

    // The crossings — the expensive part — are solved once per run of quads
    // sharing a line side (`runFirst`/`runLast`) and reused by every chunk and
    // tier in it, and a run the sight box rejects never reaches its quads at
    // all.
    for (let r = 0; r < this.runCount; r++) {
      const segAx = this.runSegAx[r];
      const segAy = this.runSegAy[r];
      const segBx = this.runSegBx[r];
      const segBy = this.runSegBy[r];
      // Four compares standing in for `n` crossing tests — see `sightBox`. On a big map this
      // rejects nearly every line side, the camera holding a few hundred units of a level with
      // tens of thousands of them.
      if (
        (segAx < segBx ? segAx : segBx) > boxMaxX ||
        (segAx > segBx ? segAx : segBx) < boxMinX ||
        (segAy < segBy ? segAy : segBy) > boxMaxY ||
        (segAy > segBy ? segAy : segBy) < boxMinY
      ) {
        continue;
      }
      this.groupStamp++;
      let hits = 0;
      for (let k = 0; k < n; k++) {
        const cross = segmentCrossT(camX, camY, this.tx[k], this.ty[k], segAx, segAy, segBx, segBy);
        if (cross < 0) continue;
        this.hitX[hits] = camX + (this.tx[k] - camX) * cross;
        this.hitY[hits] = camY + (this.ty[k] - camY) * cross;
        this.hitH[hits] = camZ + (this.tz[k] - camZ) * cross;
        // The sightline is a wedge from the eye to the whole sprite, so it
        // is this thick here — nothing at the camera, the sprite's own
        // half-height at the target.
        this.hitSpread[hits] = this.th[k] * cross;
        this.hitTarget[hits] = k;
        hits++;
      }
      if (hits === 0) continue;
      const hasOpening = openingInto(this.runLine[r], this.opening);

      for (let i = this.runFirst[r]; i <= this.runLast[r]; i++) {
        const o = this.occluders[i];
        const isPassableGap = hasOpening && this.spansOpening(o) && this.masked(o.key);
        this.passable[i] = isPassableGap ? 1 : 0;
        this.passableStamp[i] = this.frameStamp;
        if (isPassableGap) continue;
        for (let h = 0; h < hits; h++) {
          const height = this.hitH[h];
          const spread = this.hitSpread[h];
          if (height + spread <= o.botH || height - spread >= o.topH) continue;
          // One crossing per line side per target, however many tiers of it the
          // sightline passes through — they all name the same point.
          if (this.hitStamp[h] === this.groupStamp) continue;
          this.hitStamp[h] = this.groupStamp;
          out.push(this.hitX[h], this.hitY[h], height, this.hitTarget[h]);
        }
      }
    }
  }

  /**
   * Pass two, over every crossing the frame filed — this fader's own and every
   * other fader's. A ball of the crossing target's own radius around each one,
   * cut off at the target's own plane, softening whatever is left. Height
   * enters as the gap between the crossing and the quad's own band, so a wall
   * the sightline clears keeps standing.
   *
   * Runs after `collectCrossings`, which is what stamps the `passable` memo the
   * quad tests below read.
   */
  applyCrossings(
    dt: number,
    camX: number,
    camY: number,
    targets: FadeTarget[],
    openingInto: (line: number, out: Opening) => boolean,
    hits: FadeCrossings,
  ): void {
    const lerpT = 1 - Math.exp(-FADE_SPEED * dt);
    this.planes.fill(camX, camY, targets);
    // Only what is still fading needs a fresh target: every other quad's
    // `wanted` is read nowhere until a crossing folds it, and `markActive`
    // resets it as it joins.
    for (let a = 0; a < this.activeCount; a++) {
      const base = this.active[a] * 4;
      this.wanted[base] = 1;
      this.wanted[base + 1] = 1;
      this.wanted[base + 2] = 1;
      this.wanted[base + 3] = 1;
    }

    // Nothing in the frame's whole bag can reach this fader, so skip the walk
    // over it rather than reject each crossing in turn. This is the case the
    // shared bag created: a mover fader that is only awake because it is still
    // damping back to 1 used to be handed its own empty bag, and would now walk
    // every crossing on the map to throw them all away. Only the folding is
    // skipped — the damping below still has to run, which is exactly what such
    // a fader is awake for.
    const reachable = boxesOverlap(this.footprint, grownBox(hits.bounds, maxFadeRadius(targets), scratchReach));
    const crossingCount = reachable ? hits.count : 0;

    for (let c = 0; c < crossingCount; c++) {
      const cx = hits.x[c];
      const cy = hits.y[c];
      const ch = hits.h[c];
      const k = hits.target[c];
      const radius = targets[k].fadeRadius;
      // Nothing here is within reach of this crossing. Four compares against
      // the whole fader's footprint, ahead of the grid: a level's mover faders
      // are small and numerous, and each of them is now handed the *frame's*
      // crossings rather than the handful its own walls filed.
      const box = this.footprint;
      if (cx + radius < box.minX || cx - radius > box.maxX || cy + radius < box.minY || cy - radius > box.maxY) {
        continue;
      }
      const floor = targets[k].fadeFloor;
      const nx = this.planes.nx[k];
      const ny = this.planes.ny[k];
      const d0 = this.planes.d0[k];
      const count = this.candidatesNear(cx, cy);
      for (let m = 0; m < count; m++) {
        const j = this.candidates[m];
        if (this.isPassable(j, openingInto)) continue;
        const q = this.occluders[j];
        // Cheapest reject first: the whole band is out of vertical reach.
        const vGap = ch < q.botH ? q.botH - ch : ch > q.topH ? ch - q.topH : 0;
        if (vGap >= radius) continue;
        const dTop = q.topH - ch;
        const dBot = q.botH - ch;
        const vTop2 = dTop * dTop;
        const vBot2 = dBot * dBot;
        const lx = q.ax - cx;
        const ly = q.ay - cy;
        const left2 = lx * lx + ly * ly;
        const rx = q.bx - cx;
        const ry = q.by - cy;
        const right2 = rx * rx + ry * ry;
        // Where each end sits against the target's own plane, which being
        // vertical settles all four corners from the two ends.
        const alongLeft = nx * q.ax + ny * q.ay;
        const alongRight = nx * q.bx + ny * q.by;
        if (alongLeft > d0 && alongRight > d0) continue;
        this.markActive(j);
        // A/D/C/B: top-left, bottom-left, bottom-right, top-right. Each corner
        // measures from its own height, so the hole rounds off vertically too;
        // an end standing past the target is skipped outright.
        if (alongLeft <= d0) {
          this.foldCorner(j * 4, left2 + vTop2, floor, radius);
          this.foldCorner(j * 4 + 1, left2 + vBot2, floor, radius);
        }
        if (alongRight <= d0) {
          this.foldCorner(j * 4 + 2, right2 + vBot2, floor, radius);
          this.foldCorner(j * 4 + 3, right2 + vTop2, floor, radius);
        }
      }
    }

    // Only the active quads: everything else is sitting at 1 with nothing
    // pulling it down, which is the state a quad leaves this list in.
    for (let a = 0; a < this.activeCount; a++) {
      const j = this.active[a];
      const base = j * 4;
      let settled = true;
      for (let e = base; e < base + 4; e++) {
        const want = this.wanted[e];
        // Most corners sit on their target most frames, and `dampenWith` would
        // return it unchanged — skipping the store keeps their cache lines clean.
        if (this.occlusionAlpha[e] !== want) {
          this.occlusionAlpha[e] = dampenWith(this.occlusionAlpha[e], want, lerpT, SNAP_EPS);
        }
        if (this.occlusionAlpha[e] !== 1) settled = false;
      }
      if (!settled) {
        this.settledStamp[j] = -1;
        continue;
      }
      // Fully relaxed. Kept one more frame so this frame's `commit` still
      // writes the value it came to rest on, then dropped by swapping the
      // list's tail into the hole so the walk carries on over what is left.
      if (this.settledStamp[j] < 0) {
        this.settledStamp[j] = this.frameStamp;
        continue;
      }
      const last = this.active[--this.activeCount];
      this.active[a] = last;
      this.activeSlot[last] = a;
      this.activeSlot[j] = -1;
      this.settledStamp[j] = -1;
      a--;
    }
  }

  /**
   * Whether a quad covers its line's whole walkable opening, against the `opening` last looked up.
   * The rule `passable` records, written once: pass one reads it against a per-line-side lookup it
   * already holds, `isPassable` against one it takes itself.
   */
  private spansOpening(o: WallOccluder): boolean {
    return o.botH >= this.opening.bottom && o.topH <= this.opening.top;
  }

  /**
   * Whether this quad's texture is the masked kind — the half of the
   * passable-gap rule that used to be assumed rather than asked.
   *
   * A middle texture living inside its line's opening is a grate, a fence or a
   * barred window *if it has holes*, and then a look passes through it already.
   * A map can just as well hang a solid one there and call it a wall, walkable
   * or not: EPIC.WAD MAP05 at (3231, -5243) is screened by a curved run of
   * two-sided lines carrying `EBIGBRIK` over a full-height opening, and with
   * the premise unchecked that wall was the one thing on the map that never
   * faded. `MaterialBank.get` already answers it — `alphaTest` is non-zero for
   * exactly the bitmaps with fully transparent texels — and `setFrame` keeps it
   * across an animation's frames, so it is stable to read.
   * docs/render.md § The fade is a hole, not a wall.
   */
  private masked(key: string): boolean {
    const cached = this.maskedByKey.get(key);
    if (cached !== undefined) return cached;
    const material = this.meshes.get(key)?.material as THREE.MeshBasicMaterial | undefined;
    const holes = (material?.alphaTest ?? 0) > 0;
    this.maskedByKey.set(key, holes);
    return holes;
  }

  /**
   * Whether quad `j` is its line's passable gap, decided once per quad per `update` — see
   * `passable`. Pass one answers it for the quads it crosses; every other quad first gets asked
   * here, by the crossing that would otherwise fade it.
   */
  private isPassable(j: number, openingInto: (line: number, out: Opening) => boolean): boolean {
    if (this.passableStamp[j] === this.frameStamp) return this.passable[j] === 1;
    const o = this.occluders[j];
    const gap = openingInto(o.line, this.opening) && this.spansOpening(o) && this.masked(o.key);
    this.passable[j] = gap ? 1 : 0;
    this.passableStamp[j] = this.frameStamp;
    return gap;
  }

  /** Pulls one corner toward `floor` by how far it sits from the crossing, keeping whichever crossing fades it hardest. */
  private foldCorner(slot: number, distanceSquared: number, floor: number, radius: number): void {
    const a = holeAlpha(distanceSquared, floor, radius);
    if (a < this.wanted[slot]) this.wanted[slot] = a;
  }

  /**
   * Writes base × occlusion × fog-of-war combined alpha into each wall's
   * vertex-colour alpha channel. `fogAlphaOf` is keyed by the wall's index in
   * this list, not by sector: which subsector a wall quad faces into is
   * geometry FogOfWar works out for itself (see its `wallAlpha`), so the mesh
   * builder doesn't have to carry a fog-specific field around.
   *
   * The base is the quad's own permanent translucency (a Boom 260 midtexture)
   * — a *third* input to this one channel, and the only one that never changes
   * after the build. docs/render.md § Wall occlusion fading.
   */
  commit(fogAlphaOf: (occluderIndex: number) => number, fogChanged?: ChangedQuads | null): void {
    const dirty = this.dirtyKeys;
    dirty.clear();
    if (this.trackVisibility) this.maxAlphaByKey.clear();
    // Everything, whenever a partial pass can't be trusted: the first commit
    // (`lastCombined` starts NaN), a caller rebuilding `maxAlphaByKey` — which
    // is only as complete as what this pass visits — or a caller that doesn't
    // say which quads fog of war moved.
    const visitAll = this.commitAll || this.trackVisibility || !fogChanged;
    this.commitAll = false;
    const count = visitAll ? this.occluders.length : this.activeCount + fogChanged.count;
    for (let v = 0; v < count; v++) {
      // The two partial sources, in one walk: what this frame's fade touched,
      // then what the reveal did. A quad in both is written once and skipped
      // the second time by the unchanged-alpha test below.
      const i = visitAll ? v : v < this.activeCount ? this.active[v] : fogChanged.indices[v - this.activeCount];
      const o = this.occluders[i];
      const scale = (o.baseAlpha ?? 1) * fogAlphaOf(i);
      // Slots 0/1/2/3 of each quad are its A/D/C/B corners, `addWall`'s order.
      const base = i * 4;
      const a = scale * this.occlusionAlpha[base];
      const d = scale * this.occlusionAlpha[base + 1];
      const c = scale * this.occlusionAlpha[base + 2];
      const b = scale * this.occlusionAlpha[base + 3];
      // Before the unchanged-alpha early-out below, not after: a mesh whose
      // alpha happens not to have moved this frame is still as visible as it
      // was, and skipping it here would report it as invisible.
      if (this.trackVisibility) {
        const combined = Math.max(a, b, c, d);
        const seen = this.maxAlphaByKey.get(o.key);
        if (seen === undefined || combined > seen) this.maxAlphaByKey.set(o.key, combined);
      }
      // Compared against what was last written rather than read back off the
      // attribute: the corners differ, so no one vertex stands for the quad.
      if (
        a === this.lastCombined[base] &&
        d === this.lastCombined[base + 1] &&
        c === this.lastCombined[base + 2] &&
        b === this.lastCombined[base + 3]
      ) {
        continue;
      }
      const attr = this.meshes.get(o.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      this.lastCombined[base] = a;
      this.lastCombined[base + 1] = d;
      this.lastCombined[base + 2] = c;
      this.lastCombined[base + 3] = b;
      // addWall's fixed [A, D, C, A, C, B] push order.
      attr.setW(o.vertexStart, a);
      attr.setW(o.vertexStart + 1, d);
      attr.setW(o.vertexStart + 2, c);
      attr.setW(o.vertexStart + 3, a);
      attr.setW(o.vertexStart + 4, c);
      attr.setW(o.vertexStart + 5, b);
      dirty.add(o.key);
    }

    for (const key of dirty) {
      const attr = this.meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}

/**
 * Fades a raised floor sitting between the camera and a fade target below it — `WallFader` for a
 * horizontal plane. Ceilings are left out (`renderCeilings` is a debug toggle, and a room's own
 * ceiling would flag itself). See docs/render.md § Wall occlusion fading.
 */
export class FlatFader {
  private surfaces: FlatSurface[];
  private meshes: Map<string, THREE.Mesh>;
  /** Damped occlusion factor per drawn *vertex*, not per fan, so a big platform fades around the sightline instead of whole. `vertexStart` indexes into it. */
  private alpha: Float32Array;
  /** What `commit` last wrote per vertex — `WallFader.lastCombined`'s twin. */
  private lastCombined: Float32Array;
  /** Where each surface's vertices start in `alpha`/`lastCombined`, plus the count the layout was built from (a mover rebuild can repoint a fan at a differently-shaped one). */
  private vertexStart: Int32Array;
  private vertexCount: Int32Array;
  /** This surface's target alpha per vertex, folded across pierce points before damping. */
  private scratch = new Float64Array(0);
  /** `WallFader.crossings`'s twin — `update`'s own bag, for a flat fader that stands alone, and allocated on first use for the same reason. */
  private pierces: FadeCrossings | null = null;
  /** This frame's per-target hole dials and cut planes — `WallFader` keeps the twin. */
  private planes = new TargetPlanes();
  /** Each fan's centre and the radius that covers it, so a crossing nowhere near it costs one compare instead of a walk over every vertex. */
  private boundX = new Float64Array(0);
  private boundY = new Float64Array(0);
  private boundR = new Float64Array(0);
  /** Which way each fan's ring winds, memoised beside the bound circles: `segmentMeetsConvexPolygon` needs it, and a shoelace per fan per target per frame is pure repeat over rings that only a mover rebuild reshapes. */
  private windSign = new Int8Array(0);
  /** Whether `update` moved any of a fan's vertices this frame — with a fan diced to hundreds of vertices, a settled one must cost nothing to re-commit. */
  private moved = new Uint8Array(0);
  /** Whether any of a fan's vertices is currently below 1 — a fan that is neither faded nor pierced this frame has nothing to damp, and `update` skips its vertices entirely. */
  private faded = new Uint8Array(0);
  /** How many entries of `faded` are set, so `idle` costs no scan. */
  private fadedCount = 0;
  /** The base x fog scale `commit` last applied per fan, so a fog change still reaches a settled one. */
  private lastScale = new Float64Array(0);
  /** Fans a sightline could reach at all this frame, refilled per `collectPierces` — see there. */
  private candidates = new Int32Array(0);
  /** `WallFader.maxAlphaByKey`'s twin, same opt-in — the two are read together, since one mesh can hold both kinds. */
  readonly maxAlphaByKey = new Map<string, number>();
  /** `WallFader.dirtyKeys`'s twin, reused for the same reason. */
  private dirtyKeys = new Set<string>();
  private trackVisibility: boolean;

  constructor(surfaces: FlatSurface[], meshes: Map<string, THREE.Mesh>, trackVisibility = false) {
    this.surfaces = surfaces;
    this.meshes = meshes;
    this.vertexStart = new Int32Array(surfaces.length);
    this.vertexCount = new Int32Array(surfaces.length);
    this.alpha = new Float32Array(0);
    this.lastCombined = new Float32Array(0);
    this.buildLayout();
    this.trackVisibility = trackVisibility;
  }

  /** (Re)lays the per-vertex arrays out over the current fans, resetting the fade to "not faded". */
  private buildLayout(): void {
    let total = 0;
    let widest = 0;
    for (let i = 0; i < this.surfaces.length; i++) {
      const count = this.surfaces[i].vertexCount;
      this.vertexStart[i] = total;
      this.vertexCount[i] = count;
      total += count;
      if (count > widest) widest = count;
    }
    this.alpha = new Float32Array(total).fill(1);
    this.lastCombined = new Float32Array(total).fill(NaN);
    this.scratch = new Float64Array(widest);

    this.moved = new Uint8Array(this.surfaces.length).fill(1);
    this.faded = new Uint8Array(this.surfaces.length);
    this.fadedCount = 0;
    this.lastScale = new Float64Array(this.surfaces.length).fill(NaN);
    this.boundX = new Float64Array(this.surfaces.length);
    this.boundY = new Float64Array(this.surfaces.length);
    this.boundR = new Float64Array(this.surfaces.length);
    this.windSign = new Int8Array(this.surfaces.length);
    this.candidates = new Int32Array(this.surfaces.length);
    for (let i = 0; i < this.surfaces.length; i++) {
      const { vertexXY, points } = this.surfaces[i];
      // Ahead of the empty-fan skip below: every surface must carry a usable
      // sign, since `collectPierces` reads it without re-checking the fan.
      this.windSign[i] = signedPolygonArea2(points) < 0 ? -1 : 1;
      const count = vertexXY.length / 2;
      if (count === 0) continue;
      const { x: cx, y: cy } = polygonCentroid(vertexXY);
      let far = 0;
      for (let p = 0; p < count; p++) {
        const dx = vertexXY[p * 2] - cx;
        const dy = vertexXY[p * 2 + 1] - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > far) far = d2;
      }
      this.boundX[i] = cx;
      this.boundY[i] = cy;
      this.boundR[i] = Math.sqrt(far);
    }
  }

  /** True once the layout matches the surfaces again — a no-op unless a mover rebuild reshaped a fan. */
  private layoutValid(): boolean {
    for (let i = 0; i < this.surfaces.length; i++) {
      if (this.vertexCount[i] !== this.surfaces[i].vertexCount) return false;
    }
    return true;
  }

  /**
   * Pass one: the points where a sightline actually lands *on* a floor rather
   * than merely crossing the infinite plane that floor sits in. A crossing
   * point that falls outside every fan at that height is open air — the floor
   * beside it hides nothing and must not fade. docs/render.md § Flats.
   *
   * A given target's crossing point depends only on the height, so the first
   * fan that claims one settles that height for that target and the rest skip
   * the footprint test.
   *
   * `WallFader.collectCrossings`'s twin, and appends to `out` the same way and
   * for the same reason: one bag holds the frame's pierces across every flat
   * fader, so the fan a mover owns makes way for a hole the static floor beside
   * it opened. Pairs with `applyPierces`, and runs first.
   */
  collectPierces(camX: number, camY: number, camZ: number, targets: FadeTarget[], out: FadeCrossings): void {
    if (!this.layoutValid()) this.buildLayout();
    // `WallFader`'s reject (see `sightBox`), applied to a fan's bounding circle instead of a
    // segment — and taken once for the frame rather than once per target, which is the whole
    // point: what it replaces is a walk over every fan on the map per target. The per-frame
    // filters fold in here too, so the per-target loop below carries only what varies with it.
    const box = sightBox(camX, camY, targets);
    let candidateCount = 0;
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      if (s.isCeiling || s.height >= camZ || (s.baseAlpha ?? 1) < 1) continue;
      const r = this.boundR[i];
      if (
        this.boundX[i] + r < box.minX ||
        this.boundX[i] - r > box.maxX ||
        this.boundY[i] + r < box.minY ||
        this.boundY[i] - r > box.maxY
      ) {
        continue;
      }
      this.candidates[candidateCount++] = i;
    }

    for (let k = 0; k < targets.length; k++) {
      const pt = targets[k];
      const dx = pt.x - camX;
      const dy = pt.y - camY;
      // A sprite point at height `z` meets a plane at `h` at `(h - camZ) / (z - camZ)`
      // along the camera→target line, so the three heights the span needs share
      // one reciprocal each and the per-fan work is a multiply rather than a
      // divide. `camZ` is above every candidate (`collectPierces`'s own filter)
      // and above `pt.z` with it, so neither the middle's divisor nor the feet's
      // can be zero; the top's can, and the `zTop >= s.height` branch is what
      // never reads it when it is.
      const zTop = pt.z + pt.halfHeight;
      const perMiddle = 1 / (pt.z - camZ);
      const perTop = 1 / (zTop - camZ);
      const perFeet = 1 / (pt.z - pt.halfHeight - camZ);
      // Lets the reject below measure a fan's distance to the span in the
      // camera→target line's own parameter space, so it needs no endpoints.
      // Zero when the camera stands exactly over the target in plan, which
      // collapses the span to the camera point — the honest answer there.
      const len2 = dx * dx + dy * dy;
      const invLen2 = len2 > 0 ? 1 / len2 : 0;
      // Where this target's own pierces start: two targets standing on the same
      // spot file the same point twice, and each keeps its own fade floor.
      const mine = out.count;
      for (let m = 0; m < candidateCount; m++) {
        const i = this.candidates[m];
        const s = this.surfaces[i];
        if (s.height <= pt.z) continue;
        const rise = s.height - camZ;
        const t = rise * perMiddle;
        if (t <= 0 || t >= 1) continue;
        // The sprite has height, so this plane is crossed over a *span* of the
        // camera→target line rather than at `t` alone — docs/render.md § The
        // target is the billboard.
        const tNear = zTop >= s.height ? 1 : rise * perTop;
        const tFar = rise * perFeet;
        // Nowhere near this fan: still the cheapest reject, so it goes ahead of
        // both the dedup scan and the footprint walk — and it runs on the span's
        // parameters rather than its endpoints, so a rejected fan never pays for
        // the four coordinates only the footprint walk needs.
        const px = this.boundX[i] - camX;
        const py = this.boundY[i] - camY;
        let tp = (px * dx + py * dy) * invLen2;
        if (tp < tFar) tp = tFar;
        else if (tp > tNear) tp = tNear;
        const offX = px - dx * tp;
        const offY = py - dy * tp;
        if (offX * offX + offY * offY > this.boundR[i] * this.boundR[i]) continue;
        const x = camX + dx * t;
        const y = camY + dy * t;
        let known = false;
        for (let p = mine; p < out.count && !known; p++) {
          known = out.h[p] === s.height && out.x[p] === x && out.y[p] === y;
        }
        if (known) continue;
        const nearX = camX + dx * tNear;
        const nearY = camY + dy * tNear;
        const farX = camX + dx * tFar;
        const farY = camY + dy * tFar;
        if (!segmentMeetsConvexPolygon(farX, farY, nearX, nearY, s.points, this.windSign[i])) continue;
        // Filed at the middle of the sprite's own crossing, not at whichever end
        // of the span this fan caught — what keeps one platform's many fans to a
        // single pierce (docs/render.md § The target is the billboard).
        out.push(x, y, s.height, k);
      }
    }
  }

  /**
   * Camera position in DOOM (x, y, height) coordinates, and every point a
   * floor between the camera and it should fade for — see `WallFader.update`'s
   * doc for why this is a list rather than just the player.
   *
   * Two passes, the same split `WallFader` runs on: `collectPierces` finds
   * where the view is genuinely blocked, then a ball around each of those
   * points dissolves every fan **at that height** it reaches. Over this fader's
   * own pierces alone, for the reason `WallFader.update`'s doc gives.
   */
  update(dt: number, camX: number, camY: number, camZ: number, targets: FadeTarget[]): void {
    const bag = (this.pierces ??= new FadeCrossings());
    bag.reset();
    this.collectPierces(camX, camY, camZ, targets, bag);
    this.applyPierces(dt, camX, camY, targets, bag);
  }

  /**
   * Pass two, over every pierce the frame filed — this fader's own and every
   * other flat fader's: a ball around each of them dissolves every fan **at
   * that height** it reaches. `WallFader.applyCrossings`'s twin.
   *
   * Runs after `collectPierces`, which is what refreshes the vertex layout the
   * walk below indexes through.
   */
  applyPierces(dt: number, camX: number, camY: number, targets: FadeTarget[], hits: FadeCrossings): void {
    const lerpT = 1 - Math.exp(-FADE_SPEED * dt);
    this.planes.fill(camX, camY, targets);
    // Where the whole bag stands, so a fan near none of it skips the walk over
    // it — the per-pierce circle test below, hoisted to the bag. Worth taking
    // on a map diced to tens of thousands of fans, since the fan loop cannot be
    // skipped (a faded one still has to damp) and every fan in it would
    // otherwise pay one compare per pierce on the map. The bag carries its own
    // bound, so this costs nothing per fader (`FadeCrossings.bounds`).
    const bag = hits.bounds;

    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      const start = this.vertexStart[i];
      const count = this.vertexCount[i];
      // A surface that is already see-through hides nothing, so fading it has
      // nothing to reveal — and a 242 water surface, the only flat with a base
      // alpha, would lose whichever fans the sightline crosses while the sheet
      // around them stayed, punching a hole over a submerged player.
      // docs/render.md § Wall occlusion fading.
      if ((s.baseAlpha ?? 1) < 1) {
        if (this.faded[i] === 0) continue;
        for (let p = 0; p < count; p++) this.alpha[start + p] = 1;
        this.faded[i] = 0;
        this.fadedCount--;
        this.moved[i] = 1;
        continue;
      }

      // A pierce is filed under the height it landed at, so matching on height
      // is what keeps the hole to the one platform level the sightline was
      // actually stopped by. A ceiling drawn at a floor's height would match
      // it, hence the explicit test.
      const reach = this.boundR[i] + FADE_RADIUS;
      let pierced = false;
      const reachable =
        !s.isCeiling &&
        this.boundX[i] + reach >= bag.minX &&
        this.boundX[i] - reach <= bag.maxX &&
        this.boundY[i] + reach >= bag.minY &&
        this.boundY[i] - reach <= bag.maxY;
      const pierceCount = reachable ? hits.count : 0;
      for (let c = 0; c < pierceCount; c++) {
        if (hits.h[c] !== s.height) continue;
        const x = hits.x[c];
        const y = hits.y[c];
        // Nowhere near this fan: skip it whole rather than walk its vertices.
        const bx = this.boundX[i] - x;
        const by = this.boundY[i] - y;
        if (bx * bx + by * by > reach * reach) continue;
        // The fill is deferred to here: on any real map the overwhelming
        // majority of fans are reached by no pierce at all, and a fan that is
        // also not currently faded has nothing to damp — see the skip below.
        if (!pierced) {
          for (let p = 0; p < count; p++) this.scratch[p] = 1;
          pierced = true;
        }
        const k = hits.target[c];
        const floor = targets[k].fadeFloor;
        const radius = targets[k].fadeRadius;
        const nx = this.planes.nx[k];
        const ny = this.planes.ny[k];
        const d0 = this.planes.d0[k];
        for (let p = 0; p < count; p++) {
          const vx = s.vertexXY[p * 2];
          const vy = s.vertexXY[p * 2 + 1];
          // Past the target: nothing there can be hiding it, so it stays whole.
          if (nx * vx + ny * vy > d0) continue;
          const dx = vx - x;
          const dy = vy - y;
          const a = holeAlpha(dx * dx + dy * dy, floor, radius);
          if (a < this.scratch[p]) this.scratch[p] = a;
        }
      }
      // Untouched by any pierce and already sitting at 1 everywhere: damping
      // would return 1 for every vertex, so walking them is pure cost. This is
      // the whole steady-state saving on a map diced to hundreds of thousands
      // of vertices — `commit`'s `moved` skip is the same idea downstream.
      if (!pierced) {
        if (this.faded[i] === 0) continue;
        for (let p = 0; p < count; p++) this.scratch[p] = 1;
      }

      let stillFaded = false;
      for (let p = 0; p < count; p++) {
        const next = dampenWith(this.alpha[start + p], this.scratch[p], lerpT, SNAP_EPS);
        if (next < 1) stillFaded = true;
        if (next === this.alpha[start + p]) continue;
        this.alpha[start + p] = next;
        this.moved[i] = 1;
      }
      const nowFaded = stillFaded ? 1 : 0;
      if (nowFaded !== this.faded[i]) this.fadedCount += nowFaded === 1 ? 1 : -1;
      this.faded[i] = nowFaded;
    }
  }

  /** `WallFader.idle`'s twin: no fan is faded, so nothing here has anything to relax. */
  get idle(): boolean {
    return this.fadedCount === 0;
  }

  /** `WallFader.invalidateWritten`'s twin — `moved` and `lastScale` are this fader's own record of what the buffers hold. */
  invalidateWritten(): void {
    this.lastCombined.fill(NaN);
    this.lastScale.fill(NaN);
    this.moved.fill(1);
  }

  /** Same base × occlusion × fog-of-war write as `WallFader.commit` — here the base is a water surface's, and the alpha varies across the fan. */
  commit(fogAlphaOf: (subsector: number) => number): void {
    const dirty = this.dirtyKeys;
    dirty.clear();
    if (this.trackVisibility) this.maxAlphaByKey.clear();
    // Guarded here as well as in `update`, since fog of war can commit a frame
    // this fader never updated — and a stale layout would read points that
    // aren't there.
    if (!this.layoutValid()) this.buildLayout();

    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      const start = this.vertexStart[i];
      const count = this.vertexCount[i];
      const scale = (s.baseAlpha ?? 1) * fogAlphaOf(s.subsector);
      // Nothing damped and the same fog: this fan already holds what it should,
      // and walking its vertices to prove it is the whole cost on a big map.
      const settled = this.moved[i] === 0 && scale === this.lastScale[i];
      // A settled fan only has to be walked at all to report its visibility,
      // which only the mover faders ask for.
      if (settled && !this.trackVisibility) continue;

      let changed = false;
      let highest = 0;
      if (settled) {
        // Only reachable under `trackVisibility` (the early-out above), and
        // then only to report what this fan already holds.
        for (let p = 0; p < count; p++) {
          const combined = this.lastCombined[start + p];
          if (combined > highest) highest = combined;
        }
      } else {
        for (let p = 0; p < count; p++) {
          const combined = scale * this.alpha[start + p];
          this.scratch[p] = combined;
          if (combined !== this.lastCombined[start + p]) changed = true;
          if (combined > highest) highest = combined;
        }
      }
      // Ahead of the early-out, for the reason `WallFader.commit` gives.
      if (this.trackVisibility) {
        const seen = this.maxAlphaByKey.get(s.key);
        if (seen === undefined || highest > seen) this.maxAlphaByKey.set(s.key, highest);
      }
      this.moved[i] = 0;
      this.lastScale[i] = scale;
      if (settled || !changed) continue;
      const attr = this.meshes.get(s.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      for (let p = 0; p < count; p++) {
        this.lastCombined[start + p] = this.scratch[p];
        attr.setW(s.vertexStart + p, this.scratch[p]);
      }
      dirty.add(s.key);
    }

    for (const key of dirty) {
      const attr = this.meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}

/**
 * The accumulated texture offsets this scroller draws, in map units — the read
 * side of `game/specials/forces.ts: Forces`, declared structurally so the
 * render layer keeps no import edge into the game layer (the `SwitchPairLookup`
 * precedent). `scrollingLines`/`scrollingFlats` are read once, at index time.
 */
export interface ScrollOffsets {
  scrollingLines(): readonly number[];
  scrollingFlats(): readonly { sector: number; isCeiling: boolean }[];
  sideOffset(lineIndex: number): { readonly x: number; readonly y: number };
  flatOffset(sectorIndex: number, isCeiling: boolean): { readonly x: number; readonly y: number };
}

/** One static-batch wall quad a scroller animates, with everything needed to rewrite its UVs each frame without re-deriving them from the linedef. */
interface ScrollingWall {
  key: string;
  line: number;
  vertexStart: number;
  /** The quad's own original U at its left/right edges and V at its top/bottom (indices 0/1/3 vs. 2/4/5, and 0 vs. 1 — see `addWall`'s fixed `[A, D, C, A, C, B]` push order in mapmesh.ts), read back once from the geometry at index time rather than recomputed, so this doesn't need to know xOffset/yOffset/texture length itself. */
  u0: number;
  u1: number;
  vTop: number;
  vBot: number;
  /** UV units per map unit of scroll — `1 / textureWidth` and `1 / textureHeight`, so a narrow texture's pattern visibly cycles faster than a wide one for the same rate, matching vanilla's own offset-over-dimension UV math. */
  uPerUnit: number;
  vPerUnit: number;
  /** Last offset written into the buffer, so an unchanged surface costs no rewrite and no re-upload. */
  lastDu: number;
  lastDv: number;
}

/** One static-batch flat fan a scroller animates. Flats are arbitrary-length fans, so their untouched UVs are kept whole rather than as two edge values. */
interface ScrollingFlat {
  key: string;
  sector: number;
  isCeiling: boolean;
  vertexStart: number;
  /** `[u, v]` per vertex as built, the base every frame's offset is added to. */
  base: Float32Array;
  /** Last offset written into the buffer — see `ScrollingWall`. */
  lastDu: number;
  lastDv: number;
}

/**
 * Every flat is 64×64 and aligned to the world grid (`mapmesh.ts: processFlat`
 * divides by the same 64), so a flat scroller's offset converts with this
 * rather than a per-texture size lookup.
 */
const FLAT_SIZE = 64;

/**
 * Draws Boom's scrolling surfaces — walls (48, 85, 254, 255 and the
 * displacement/accelerative variants) and floor/ceiling flats (250-253) —
 * by rewriting the indexed quads' and fans' UVs from the offsets
 * `game/specials/forces.ts` accumulated. The offsets are simulation state; this
 * only applies them. **Static-batch geometry only** — a sector that both
 * scrolls and moves keeps its mover mesh unscrolled.
 * See docs/render.md § Scrolling textures.
 */
export class SurfaceScroller {
  private wallMeshes: Map<string, THREE.Mesh>;
  private flatMeshes: Map<string, THREE.Mesh>;
  private walls: ScrollingWall[] = [];
  private flats: ScrollingFlat[] = [];

  constructor(
    offsets: ScrollOffsets,
    occluders: readonly WallOccluder[],
    wallMeshes: Map<string, THREE.Mesh>,
    flatSurfaces: readonly FlatSurface[],
    flatMeshes: Map<string, THREE.Mesh>,
    bank: MaterialBank,
  ) {
    this.wallMeshes = wallMeshes;
    this.flatMeshes = flatMeshes;

    const lines = new Set(offsets.scrollingLines());
    for (const o of occluders) {
      if (!lines.has(o.line) || !o.frontSide) continue;
      const attr = wallMeshes.get(o.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const dim = bank.size('wall', textureOf(o.key));
      if (!dim || dim.w <= 0 || dim.h <= 0) continue;
      this.walls.push({
        key: o.key,
        line: o.line,
        vertexStart: o.vertexStart,
        u0: attr.getX(o.vertexStart), // index 0: one of the quad's two "A" copies (see addWall's push order)
        u1: attr.getX(o.vertexStart + 2), // index 2: one of the quad's two "C" copies
        vTop: attr.getY(o.vertexStart),
        vBot: attr.getY(o.vertexStart + 1), // index 1: "D", the quad's bottom-left
        uPerUnit: 1 / dim.w,
        vPerUnit: 1 / dim.h,
        lastDu: 0,
        lastDv: 0,
      });
    }

    const flats = new Set(offsets.scrollingFlats().map((f) => flatKey(f.sector, f.isCeiling)));
    for (const s of flatSurfaces) {
      if (!flats.has(flatKey(s.sector, s.isCeiling))) continue;
      const attr = flatMeshes.get(s.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const base = new Float32Array(s.vertexCount * 2);
      for (let v = 0; v < s.vertexCount; v++) {
        base[v * 2] = attr.getX(s.vertexStart + v);
        base[v * 2 + 1] = attr.getY(s.vertexStart + v);
      }
      this.flats.push({
        key: s.key,
        sector: s.sector,
        isCeiling: s.isCeiling,
        vertexStart: s.vertexStart,
        base,
        lastDu: 0,
        lastDv: 0,
      });
    }
  }

  update(offsets: ScrollOffsets): void {
    const dirty = new Set<string>();
    for (const w of this.walls) {
      const attr = this.wallMeshes.get(w.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const offset = offsets.sideOffset(w.line);
      // Bounded to [0, 1) so the value actually written into the (single-
      // precision) buffer never grows large enough to lose precision over a
      // long session — three.js's RepeatWrapping (see MaterialBank.toTexture)
      // already makes an unwrapped UV outside [0, 1] render correctly on its
      // own, so this wrap is purely a float32-precision safeguard, not a
      // correctness requirement.
      const du = (offset.x * w.uPerUnit) % 1;
      const dv = (offset.y * w.vPerUnit) % 1;
      // A displacement/accelerative scroller sits at rate 0 whenever its control
      // sector is idle, so its offset is unchanged most frames — and a batch key
      // covers every wall sharing a texture, so re-uploading one costs the whole
      // buffer. Same skip-if-unchanged shape as `WallFader.commit`.
      if (du === w.lastDu && dv === w.lastDv) continue;
      w.lastDu = du;
      w.lastDv = dv;
      const u0 = w.u0 + du;
      const u1 = w.u1 + du;
      const vTop = w.vTop + dv;
      const vBot = w.vBot + dv;
      // Matches addWall's fixed [A, D, C, A, C, B] vertex push order:
      // indices 0/1/3 are the quad's left edge (u0), 2/4/5 its right (u1);
      // 0/3/5 its top (vTop), 1/2/4 its bottom (vBot).
      attr.setXY(w.vertexStart, u0, vTop);
      attr.setXY(w.vertexStart + 1, u0, vBot);
      attr.setXY(w.vertexStart + 2, u1, vBot);
      attr.setXY(w.vertexStart + 3, u0, vTop);
      attr.setXY(w.vertexStart + 4, u1, vBot);
      attr.setXY(w.vertexStart + 5, u1, vTop);
      dirty.add(w.key);
    }
    for (const key of dirty) {
      const attr = this.wallMeshes.get(key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }

    dirty.clear();
    for (const f of this.flats) {
      const attr = this.flatMeshes.get(f.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const offset = offsets.flatOffset(f.sector, f.isCeiling);
      const du = (offset.x / FLAT_SIZE) % 1;
      const dv = (offset.y / FLAT_SIZE) % 1;
      if (du === f.lastDu && dv === f.lastDv) continue;
      f.lastDu = du;
      f.lastDv = dv;
      for (let v = 0; v < f.base.length / 2; v++) {
        attr.setXY(f.vertexStart + v, f.base[v * 2] + du, f.base[v * 2 + 1] + dv);
      }
      dirty.add(f.key);
    }
    for (const key of dirty) {
      const attr = this.flatMeshes.get(key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}

/** A batch key is `<kind>:<texture>` — see `BatchSet.get` in mapmesh.ts. */
function textureOf(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

function flatKey(sector: number, isCeiling: boolean): number {
  return sector * 2 + (isCeiling ? 1 : 0);
}
