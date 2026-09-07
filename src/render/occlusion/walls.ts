/**
 * `WallFader`: the wall quads a camera→target sightline crosses, dissolved so the target behind
 * them stays visible. See docs/render.md § Wall occlusion fading.
 */
import * as THREE from 'three';
import type { WallOccluder } from '../mapmesh.ts';
import { segmentCrossT, vecLength } from '../../util/geom.ts';
import { dampenWith } from '../../util/damping.ts';
import type { Opening } from '../../game/world.ts';
import {
  boxesOverlap,
  emptyBox,
  FADE_RADIUS,
  FADE_SPEED,
  FadeCrossings,
  grownBox,
  holeAlpha,
  maxFadeRadius,
  resolveColorAttrs,
  sightBox,
  SNAP_EPS,
  stretchBox,
  TargetPlanes,
  type ChangedQuads,
  type FadeBox,
  type FadeFrame,
} from './defs.ts';

/**
 * Total occluder count below which `WallFader` scans them all instead of building an index: over a
 * short list the 3x3 cell walk costs more than the scan it replaces. **Tuned by feel.** A mover
 * fader is not excluded — the grid is indexed on quad midpoints, and a refresh moves a mover's
 * heights, never a quad's footprint, so the buckets stay true across one.
 */
const GRID_MIN_OCCLUDERS = 256;

/**
 * Scratch for the whole-bag rejects below. Module-level and reused: they run
 * once per fader per frame across a level's thousands of them, and the box
 * never outlives the compare it feeds.
 */
const scratchReach: FadeBox = emptyBox();

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
  /**
   * What `commit` last wrote per corner, so an unchanged quad costs no rewrite. NaN until first
   * written, so the first commit always lands.
   */
  private lastCombined: Float32Array;
  /**
   * This frame's un-damped target alpha per quad corner, folded down by every crossing that reaches
   * it.
   */
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
  /**
   * Whether each batch's texture is masked, memoised — one material lookup per texture for the
   * fader's life.
   */
  private maskedByKey = new Map<string, boolean>();
  private frameStamp = 0;
  /** Reused by `update`'s per-line opening lookup — see `openingInto`. */
  private opening: Opening = { top: 0, bottom: 0 };
  /**
   * Per-target scratch, grown on demand: position, sprite half-height, and the current line side's
   * crossings.
   */
  private tx = new Float64Array(0);
  private ty = new Float64Array(0);
  private tz = new Float64Array(0);
  private th = new Float64Array(0);
  private hitX = new Float64Array(0);
  private hitY = new Float64Array(0);
  private hitH = new Float64Array(0);
  /**
   * Half the height the target's sprite spans *at the crossing* — the wedge's own half-thickness
   * there.
   */
  private hitSpread = new Float64Array(0);
  private hitTarget = new Float64Array(0);
  /** This frame's per-target hole dials and cut planes. */
  private planes = new TargetPlanes();
  /**
   * Which group last recorded a crossing for each hit slot — a stamp, so dedup needs no per-group
   * clear.
   */
  private hitStamp = new Int32Array(0);
  private groupStamp = 0;
  /**
   * `update`'s own bag, for a fader that stands alone: a frame with several of
   * them shares one instead (`collectCrossings`). Allocated on first use, since
   * a level's mover faders — thousands of them — only ever take the shared one.
   */
  private crossings: FadeCrossings | null = null;
  /**
   * Uniform grid over chunk midpoints, so a crossing can find the quads around it without scanning
   * the map. Null below `GRID_MIN_OCCLUDERS`.
   */
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
  /**
   * Occluder indices a crossing might reach, refilled per query (the whole list when there is no
   * grid).
   */
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
  /**
   * Set until the first `commit`, which has to write every quad because `lastCombined` starts NaN.
   */
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
  /**
   * The batches this frame's `commit` wrote into, reused rather than reallocated: a level can hold
   * a couple of thousand faders and every one of them commits every frame.
   */
  private dirtyBuffers = new Set<THREE.BufferAttribute>();
  /**
   * Each quad's colour buffer, by occluder index — resolved here rather than looked up per quad per
   * frame. Re-resolved by `invalidateWritten`, which is called on the one path that can move a quad
   * to a different batch (`refreshMoverMesh` rewrites `key` through `copyRefreshedQuad`).
   */
  private attrs: (THREE.BufferAttribute | undefined)[] = [];

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
    resolveColorAttrs(this.occluders, this.meshes, this.attrs);
    if (occluders.length > GRID_MIN_OCCLUDERS) this.buildGrid();
    else for (let i = 0; i < occluders.length; i++) this.candidates[i] = i;
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
    // The same refresh that rewrote the buffers may have moved a quad to another batch.
    resolveColorAttrs(this.occluders, this.meshes, this.attrs);
  }

  /**
   * Both passes over this fader's own crossings alone — right for a fader that is the only one on
   * the map, which is what the tests build. A level splits its walls across the static batches and
   * one mesh per mover, and those share a bag through `collectCrossings`/`applyCrossings` instead.
   *
   * `FadeFrame.openingInto` tells a genuinely solid quad from one that only *renders* solid; the
   * lookup is per line but the test it feeds is per **quad**, which is load-bearing.
   * docs/render.md § Wall occlusion fading.
   */
  update(frame: FadeFrame): void {
    const bag = (this.crossings ??= new FadeCrossings());
    bag.reset();
    this.collectCrossings(frame, bag);
    this.applyCrossings(frame, bag);
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
  collectCrossings(frame: FadeFrame, out: FadeCrossings): void {
    const { camX, camY, camZ, targets, openingInto } = frame;
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
  applyCrossings(frame: FadeFrame, hits: FadeCrossings): void {
    const { dt, camX, camY, targets, openingInto } = frame;
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

    // Nothing in the frame's whole bag can reach this fader, so skip the walk over it rather than
    // reject each crossing in turn — the shared bag hands every fader the map's crossings, a mover
    // fader awake only because it is still damping back to 1 included. Only the folding is skipped;
    // the damping below still has to run, which is exactly what such a fader is awake for.
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
      // are small and numerous, and each of them is handed the *frame's*
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
    const dirty = this.dirtyBuffers;
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
        if (seen === undefined || combined > seen) {
          this.maxAlphaByKey.set(o.key, combined);
        }
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
      const attr = this.attrs[i];
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
      dirty.add(attr);
    }

    for (const attr of dirty) attr.needsUpdate = true;
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
   * corners a fresh `wanted` of 1 as it joins — the reset that would otherwise
   * be a fill across every quad on the map.
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
    const bounds = emptyBox();
    for (const o of this.occluders) {
      const half = vecLength(o.bx - o.ax, o.by - o.ay) / 2;
      if (half > halfChunk) halfChunk = half;
      stretchBox(bounds, (o.ax + o.bx) / 2, (o.ay + o.by) / 2);
    }
    const { minX, minY } = bounds;
    const cell = FADE_RADIUS + halfChunk;
    const cols = Math.max(1, Math.ceil((bounds.maxX - minX) / cell) + 1);
    const rows = Math.max(1, Math.ceil((bounds.maxY - minY) / cell) + 1);
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
    this.th = new Float64Array(n);
    this.hitX = new Float64Array(n);
    this.hitY = new Float64Array(n);
    this.hitH = new Float64Array(n);
    this.hitSpread = new Float64Array(n);
    this.hitTarget = new Float64Array(n);
    this.hitStamp = new Int32Array(n).fill(-1);
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
   * Whether this quad's texture is the masked kind — the half of the passable-gap rule that has to
   * be **asked** rather than assumed, since a map can hang a solid texture inside an opening and
   * call it a wall (repro: EPIC.WAD MAP05 at (3231, -5243)). Read off the batch's own material,
   * whose `alphaTest` survives an animation's frames. docs/render.md § The fade is a hole, not a
   * wall.
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

  /**
   * Pulls one corner toward `floor` by how far it sits from the crossing, keeping whichever
   * crossing fades it hardest.
   */
  private foldCorner(slot: number, distanceSquared: number, floor: number, radius: number): void {
    const a = holeAlpha(distanceSquared, floor, radius);
    if (a < this.wanted[slot]) this.wanted[slot] = a;
  }
}
