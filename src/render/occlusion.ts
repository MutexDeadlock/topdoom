/**
 * Fades the walls (and overhanging flats) that sit between the camera and the player, as a
 * dithered discard rather than alpha blending — plus `SurfaceScroller`, which walks the same
 * static-batch geometry to apply Boom's scrolling texture offsets.
 * See docs/render.md § Wall occlusion fading and § Scrolling textures.
 */
import * as THREE from 'three';
import type { FlatSurface, WallOccluder } from './mapmesh.ts';
import type { MaterialBank } from './textures.ts';
import { pointInConvexPolygon, polygonCentroid, segmentCrossT } from '../util/geom.ts';
import { dampenWith } from '../util/damping.ts';
import { PLAYER_HEIGHT } from '../game/player.ts';
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
 * it is one shape. Both **tuned by feel**: wide enough to see the player and
 * what they're about to walk into, narrow enough that a wall doesn't dissolve
 * end to end. Their relationship to `mapmesh.ts`'s `WALL_CHUNK_LEN`, and why
 * the tests read these rather than mirroring them:
 * docs/render.md § The fade is a hole, not a wall.
 */
export const FADE_RADIUS = 96;
export const FADE_CORE = FADE_RADIUS / 2;

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
 * A point occlusion is tested against — the player, or an awake monster (see
 * `WallFader.update`'s doc). `fadeFloor` is how far down this target alone
 * pulls what hides it; `FADE_ALPHA` is full strength.
 */
export type FadeTarget = Pos3 & { fadeFloor: number };

/**
 * The alpha one crossing pulls a point at `distanceSquared` from it down to:
 * `floor` inside `FADE_CORE`, smoothstepped back to 1 by `FADE_RADIUS`, and 1
 * beyond. The one ramp both faders window with — a hole spanning a floor and
 * the wall behind it is one shape because this is one function.
 * docs/render.md § The fade is a hole, not a wall.
 */
function holeAlpha(distanceSquared: number, floor: number): number {
  if (distanceSquared >= FADE_RADIUS * FADE_RADIUS) return 1;
  const d = Math.sqrt(distanceSquared);
  if (d <= FADE_CORE) return floor;
  const t = (d - FADE_CORE) / (FADE_RADIUS - FADE_CORE);
  return floor + (1 - floor) * t * t * (3 - 2 * t);
}

/**
 * A growable bag of the points a pass-one sweep found — where a sightline was
 * actually stopped, and how hard the target behind it fades. Both faders file
 * the same four channels, so they share one structure rather than two sets of
 * parallel arrays.
 */
class PointBag {
  x: Float64Array = new Float64Array(64);
  y: Float64Array = new Float64Array(64);
  /** The height the sightline was stopped at: a wall crossing's, or the plane a floor pierce sits in. */
  h: Float64Array = new Float64Array(64);
  /** The stopping target's own `fadeFloor`, so two targets over one point keep their own strengths. */
  floor: Float64Array = new Float64Array(64);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  push(x: number, y: number, h: number, floor: number): void {
    if (this.count === this.x.length) {
      this.x = grow(this.x);
      this.y = grow(this.y);
      this.h = grow(this.h);
      this.floor = grow(this.floor);
    }
    this.x[this.count] = x;
    this.y[this.count] = y;
    this.h[this.count] = h;
    this.floor[this.count] = floor;
    this.count++;
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
 * monster. Both reuse `PLAYER_HEIGHT / 2` as the target height, same as
 * `hasLineOfSight`, there being no per-species table.
 */
export function collectFadeTargets(player: Pos3, awakeMonsters: readonly Pos3[]): FadeTarget[] {
  const nearby = awakeMonsters
    .map((m) => ({ m, d: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((e) => e.d <= MONSTER_FADE_RANGE);
  nearby.sort((a, b) => a.d - b.d);
  return [
    { x: player.x, y: player.y, z: player.z + PLAYER_HEIGHT / 2, fadeFloor: FADE_ALPHA },
    ...nearby.slice(0, MAX_FADE_TARGETS).map((e) => ({
      x: e.m.x,
      y: e.m.y,
      z: e.m.z + PLAYER_HEIGHT / 2,
      // Full strength beside the player, easing to no fade at all by the range
      // cap: a monster the player can barely make out shouldn't cost a wall,
      // and a fade that reached the cap at full strength would pop as the
      // monster crossed it. Linear, **tuned by feel**.
      fadeFloor: FADE_ALPHA + (1 - FADE_ALPHA) * (e.d / MONSTER_FADE_RANGE),
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
   * which must not fade however solid the texture over it looks.
   *
   * **Asked lazily**, of the quads a sightline crosses in pass one and the quads a crossing reaches
   * in pass two, and at most once per quad per frame (`passableStamp`). Deciding it for every quad
   * up front was most of what pass one cost on a map with tens of thousands of them, and on a
   * frame where the camera holds a few hundred units of the level almost none of them are asked.
   */
  private passable: Uint8Array;
  /** The `update` each `passable` entry was last decided on. */
  private passableStamp: Int32Array;
  private frameStamp = 0;
  /** Reused by `update`'s per-line opening lookup — see `openingInto`. */
  private opening: Opening = { top: 0, bottom: 0 };
  /** Per-target scratch, grown on demand: position, fade floor, and the current line side's crossings. */
  private tx = new Float64Array(0);
  private ty = new Float64Array(0);
  private tz = new Float64Array(0);
  private tFloor = new Float64Array(0);
  private hitX = new Float64Array(0);
  private hitY = new Float64Array(0);
  private hitH = new Float64Array(0);
  private hitFloor = new Float64Array(0);
  /** Which group last recorded a crossing for each hit slot — a stamp, so dedup needs no per-group clear. */
  private hitStamp = new Int32Array(0);
  private groupStamp = 0;
  /** This frame's crossing points: where a sightline actually meets something solid. */
  private crossings = new PointBag();
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

  constructor(occluders: WallOccluder[], meshes: Map<string, THREE.Mesh>, trackVisibility = false) {
    this.occluders = occluders;
    this.meshes = meshes;
    this.occlusionAlpha = new Float32Array(occluders.length * 4).fill(1);
    this.lastCombined = new Float32Array(occluders.length * 4).fill(NaN);
    this.wanted = new Float32Array(occluders.length * 4);
    this.passable = new Uint8Array(occluders.length);
    this.passableStamp = new Int32Array(occluders.length).fill(-1);
    this.candidates = new Int32Array(occluders.length);
    this.trackVisibility = trackVisibility;
    if (occluders.length > GRID_MIN_OCCLUDERS) this.buildGrid();
    else for (let i = 0; i < occluders.length; i++) this.candidates[i] = i;
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

  /** Grows the per-target scratch to hold `n` targets. */
  private ensureTargetScratch(n: number): void {
    if (this.tx.length >= n) return;
    this.tx = new Float64Array(n);
    this.ty = new Float64Array(n);
    this.tz = new Float64Array(n);
    this.tFloor = new Float64Array(n);
    this.hitX = new Float64Array(n);
    this.hitY = new Float64Array(n);
    this.hitH = new Float64Array(n);
    this.hitFloor = new Float64Array(n);
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
   */
  update(
    dt: number,
    camX: number,
    camY: number,
    camZ: number,
    targets: FadeTarget[],
    openingInto: (line: number, out: Opening) => boolean,
  ): void {
    const lerpT = 1 - Math.exp(-FADE_SPEED * dt);
    const n = targets.length;
    this.frameStamp++;
    this.ensureTargetScratch(n);
    const { minX: boxMinX, maxX: boxMaxX, minY: boxMinY, maxY: boxMaxY } = sightBox(camX, camY, targets);
    for (let k = 0; k < n; k++) {
      const t = targets[k];
      this.tx[k] = t.x;
      this.ty[k] = t.y;
      this.tz[k] = t.z;
      this.tFloor[k] = t.fadeFloor;
    }
    this.wanted.fill(1);

    // Pass one. The crossings — the expensive part — are solved once per run of
    // quads sharing a line side and reused by every chunk and tier in it, since
    // `addWall` emits them together. Only the cost rides on that: a run that
    // broke up would recompute, not answer differently.
    this.crossings.reset();
    let groupLine = -1;
    let groupFront = false;
    let hasOpening = false;
    let hits = 0;

    for (let i = 0; i < this.occluders.length; i++) {
      const o = this.occluders[i];
      if (o.line !== groupLine || o.frontSide !== groupFront) {
        groupLine = o.line;
        groupFront = o.frontSide;
        this.groupStamp++;
        hits = 0;
        hasOpening = false;
        // Four compares standing in for `n` crossing tests — see `sightBox`. On a big map this
        // rejects nearly every line side, the camera holding a few hundred units of a level with
        // tens of thousands of them.
        const boxed =
          (o.segAx < o.segBx ? o.segAx : o.segBx) <= boxMaxX &&
          (o.segAx > o.segBx ? o.segAx : o.segBx) >= boxMinX &&
          (o.segAy < o.segBy ? o.segAy : o.segBy) <= boxMaxY &&
          (o.segAy > o.segBy ? o.segAy : o.segBy) >= boxMinY;
        if (boxed) {
          hasOpening = openingInto(o.line, this.opening);
          for (let k = 0; k < n; k++) {
            const cross = segmentCrossT(camX, camY, this.tx[k], this.ty[k], o.segAx, o.segAy, o.segBx, o.segBy);
            if (cross < 0) continue;
            this.hitX[hits] = camX + (this.tx[k] - camX) * cross;
            this.hitY[hits] = camY + (this.ty[k] - camY) * cross;
            this.hitH[hits] = camZ + (this.tz[k] - camZ) * cross;
            this.hitFloor[hits] = this.tFloor[k];
            hits++;
          }
        }
      }

      if (hits === 0) continue;
      const isPassableGap = hasOpening && this.spansOpening(o);
      this.passable[i] = isPassableGap ? 1 : 0;
      this.passableStamp[i] = this.frameStamp;
      if (isPassableGap) continue;
      for (let h = 0; h < hits; h++) {
        const height = this.hitH[h];
        if (height <= o.botH || height >= o.topH) continue;
        // One crossing per line side per target, however many tiers of it the
        // sightline passes through — they all name the same point.
        if (this.hitStamp[h] === this.groupStamp) continue;
        this.hitStamp[h] = this.groupStamp;
        this.crossings.push(this.hitX[h], this.hitY[h], height, this.hitFloor[h]);
      }
    }

    // Pass two: a ball of radius FADE_RADIUS around each crossing, softening
    // whatever it reaches. Height enters as the gap between the crossing and
    // the quad's own band, so a wall the sightline clears keeps standing.
    for (let c = 0; c < this.crossings.count; c++) {
      const cx = this.crossings.x[c];
      const cy = this.crossings.y[c];
      const ch = this.crossings.h[c];
      const floor = this.crossings.floor[c];
      const count = this.candidatesNear(cx, cy);
      for (let m = 0; m < count; m++) {
        const j = this.candidates[m];
        if (this.isPassable(j, openingInto)) continue;
        const q = this.occluders[j];
        // Cheapest reject first: the whole band is out of vertical reach.
        const vGap = ch < q.botH ? q.botH - ch : ch > q.topH ? ch - q.topH : 0;
        if (vGap >= FADE_RADIUS) continue;
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
        // A/D/C/B: top-left, bottom-left, bottom-right, top-right. Each corner
        // measures from its own height, so the hole rounds off vertically too.
        this.foldCorner(j * 4, left2 + vTop2, floor);
        this.foldCorner(j * 4 + 1, left2 + vBot2, floor);
        this.foldCorner(j * 4 + 2, right2 + vBot2, floor);
        this.foldCorner(j * 4 + 3, right2 + vTop2, floor);
      }
    }

    for (let e = 0; e < this.occlusionAlpha.length; e++) {
      // Most corners sit on their target most frames, and `dampenWith` would
      // return it unchanged — skipping the store keeps their cache lines clean.
      if (this.occlusionAlpha[e] === this.wanted[e]) continue;
      this.occlusionAlpha[e] = dampenWith(this.occlusionAlpha[e], this.wanted[e], lerpT, SNAP_EPS);
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
   * Whether quad `j` is its line's passable gap, decided once per quad per `update` — see
   * `passable`. Pass one answers it for the quads it crosses; every other quad first gets asked
   * here, by the crossing that would otherwise fade it.
   */
  private isPassable(j: number, openingInto: (line: number, out: Opening) => boolean): boolean {
    if (this.passableStamp[j] === this.frameStamp) return this.passable[j] === 1;
    const o = this.occluders[j];
    const gap = openingInto(o.line, this.opening) && this.spansOpening(o);
    this.passable[j] = gap ? 1 : 0;
    this.passableStamp[j] = this.frameStamp;
    return gap;
  }

  /** Pulls one corner toward `floor` by how far it sits from the crossing, keeping whichever crossing fades it hardest. */
  private foldCorner(slot: number, distanceSquared: number, floor: number): void {
    const a = holeAlpha(distanceSquared, floor);
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
  commit(fogAlphaOf: (occluderIndex: number) => number): void {
    const dirty = new Set<string>();
    if (this.trackVisibility) this.maxAlphaByKey.clear();

    for (let i = 0; i < this.occluders.length; i++) {
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
  /** This frame's pierce points: where a sightline actually lands *on* a floor. */
  private pierces = new PointBag();
  /** Each fan's centre and the radius that covers it, so a crossing nowhere near it costs one compare instead of a walk over every vertex. */
  private boundX = new Float64Array(0);
  private boundY = new Float64Array(0);
  private boundR = new Float64Array(0);
  /** Whether `update` moved any of a fan's vertices this frame — with a fan diced to hundreds of vertices, a settled one must cost nothing to re-commit. */
  private moved = new Uint8Array(0);
  /** Whether any of a fan's vertices is currently below 1 — a fan that is neither faded nor pierced this frame has nothing to damp, and `update` skips its vertices entirely. */
  private faded = new Uint8Array(0);
  /** The base x fog scale `commit` last applied per fan, so a fog change still reaches a settled one. */
  private lastScale = new Float64Array(0);
  /** Fans a sightline could reach at all this frame, refilled per `collectPierces` — see there. */
  private candidates = new Int32Array(0);
  /** `WallFader.maxAlphaByKey`'s twin, same opt-in — the two are read together, since one mesh can hold both kinds. */
  readonly maxAlphaByKey = new Map<string, number>();
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
    this.lastScale = new Float64Array(this.surfaces.length).fill(NaN);
    this.boundX = new Float64Array(this.surfaces.length);
    this.boundY = new Float64Array(this.surfaces.length);
    this.boundR = new Float64Array(this.surfaces.length);
    this.candidates = new Int32Array(this.surfaces.length);
    for (let i = 0; i < this.surfaces.length; i++) {
      const { vertexXY } = this.surfaces[i];
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
   */
  private collectPierces(camX: number, camY: number, camZ: number, targets: FadeTarget[]): void {
    this.pierces.reset();
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

    for (const pt of targets) {
      // Where this target's own pierces start: two targets standing on the same
      // spot file the same point twice, and each keeps its own fade floor.
      const mine = this.pierces.count;
      for (let m = 0; m < candidateCount; m++) {
        const i = this.candidates[m];
        const s = this.surfaces[i];
        if (s.height <= pt.z) continue;
        const t = (s.height - camZ) / (pt.z - camZ);
        if (t <= 0 || t >= 1) continue;
        const x = camX + (pt.x - camX) * t;
        const y = camY + (pt.y - camY) * t;
        // Nowhere near this fan: the cheapest reject, so it goes ahead of both
        // the dedup scan and the footprint walk.
        const bx = this.boundX[i] - x;
        const by = this.boundY[i] - y;
        if (bx * bx + by * by > this.boundR[i] * this.boundR[i]) continue;
        let known = false;
        for (let p = mine; p < this.pierces.count && !known; p++) {
          known = this.pierces.h[p] === s.height && this.pierces.x[p] === x && this.pierces.y[p] === y;
        }
        if (known) continue;
        if (!pointInConvexPolygon(x, y, s.points)) continue;
        this.pierces.push(x, y, s.height, pt.fadeFloor);
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
   * points dissolves every fan **at that height** it reaches.
   */
  update(dt: number, camX: number, camY: number, camZ: number, targets: FadeTarget[]): void {
    if (!this.layoutValid()) this.buildLayout();
    const lerpT = 1 - Math.exp(-FADE_SPEED * dt);
    this.collectPierces(camX, camY, camZ, targets);

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
        this.moved[i] = 1;
        continue;
      }

      // A pierce is filed under the height it landed at, so matching on height
      // is what keeps the hole to the one platform level the sightline was
      // actually stopped by. A ceiling drawn at a floor's height would match
      // it, hence the explicit test.
      const reach = this.boundR[i] + FADE_RADIUS;
      let pierced = false;
      for (let c = 0; !s.isCeiling && c < this.pierces.count; c++) {
        if (this.pierces.h[c] !== s.height) continue;
        const x = this.pierces.x[c];
        const y = this.pierces.y[c];
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
        const floor = this.pierces.floor[c];
        for (let p = 0; p < count; p++) {
          const dx = s.vertexXY[p * 2] - x;
          const dy = s.vertexXY[p * 2 + 1] - y;
          const a = holeAlpha(dx * dx + dy * dy, floor);
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
      this.faded[i] = stillFaded ? 1 : 0;
    }
  }

  /** Same base × occlusion × fog-of-war write as `WallFader.commit` — here the base is a water surface's, and the alpha varies across the fan. */
  commit(fogAlphaOf: (subsector: number) => number): void {
    const dirty = new Set<string>();
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
