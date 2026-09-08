/**
 * `FlatFader`: the overhanging floors and ceilings a camera→target sightline pierces, dissolved so
 * the target under them stays visible. See docs/render.md § Wall occlusion fading.
 */
import * as THREE from 'three';
import type { FlatSurface } from '../mapmesh.ts';
import { polygonCentroid, segmentMeetsConvexPolygon, signedPolygonArea2 } from '../../util/geom.ts';
import { dampenWith } from '../../util/damping.ts';
import {
  FADE_RADIUS,
  FADE_SPEED,
  FadeCrossings,
  holeAlpha,
  resolveColorAttrs,
  sightBox,
  SNAP_EPS,
  TargetPlanes,
  type FadeFrame,
} from './defs.ts';

/**
 * Fades a raised floor sitting between the camera and a fade target below it — `WallFader` for a
 * horizontal plane. Ceilings are left out (`renderCeilings` is a debug toggle, and a room's own
 * ceiling would flag itself). See docs/render.md § Wall occlusion fading.
 */
export class FlatFader {
  private surfaces: FlatSurface[];
  private meshes: Map<string, THREE.Mesh>;
  /**
   * Damped occlusion factor per drawn *vertex*, not per fan, so a big platform fades around the
   * sightline instead of whole. `vertexStart` indexes into it.
   */
  private alpha: Float32Array;
  /** What `commit` last wrote per vertex — `WallFader.lastCombined`'s twin. */
  private lastCombined: Float32Array;
  /**
   * Where each surface's vertices start in `alpha`/`lastCombined`, plus the count the layout was
   * built from (a mover rebuild can repoint a fan at a differently-shaped one).
   */
  private vertexStart: Int32Array;
  private vertexCount: Int32Array;
  /** This surface's target alpha per vertex, folded across pierce points before damping. */
  private scratch = new Float64Array(0);
  /**
   * `WallFader.crossings`'s twin — `update`'s own bag, for a flat fader that stands alone, and
   * allocated on first use for the same reason.
   */
  private pierces: FadeCrossings | null = null;
  /** This frame's per-target hole dials and cut planes — `WallFader` keeps the twin. */
  private planes = new TargetPlanes();
  /**
   * Each fan's centre and the radius that covers it, so a crossing nowhere near it costs one
   * compare instead of a walk over every vertex.
   */
  private boundX = new Float64Array(0);
  private boundY = new Float64Array(0);
  private boundR = new Float64Array(0);
  /**
   * Which way each fan's ring winds, memoised beside the bound circles: `segmentMeetsConvexPolygon`
   * needs it, and a shoelace per fan per target per frame is pure repeat over rings that only a
   * mover rebuild reshapes.
   */
  private windSign = new Int8Array(0);
  /**
   * Whether `update` moved any of a fan's vertices this frame — with a fan diced to hundreds of
   * vertices, a settled one must cost nothing to re-commit.
   */
  private moved = new Uint8Array(0);
  /**
   * Whether any of a fan's vertices is currently below 1 — a fan that is neither faded nor pierced
   * this frame has nothing to damp, and `update` skips its vertices entirely.
   */
  private faded = new Uint8Array(0);
  /** How many entries of `faded` are set, so `idle` costs no scan. */
  private fadedCount = 0;
  /**
   * The base x fog scale `commit` last applied per fan, so a fog change still reaches a settled
   * one.
   */
  private lastScale = new Float64Array(0);
  /** Fans a sightline could reach at all this frame, refilled per `collectPierces` — see there. */
  private candidates = new Int32Array(0);
  /**
   * `WallFader.maxAlphaByKey`'s twin, same opt-in — the two are read together, since one mesh can
   * hold both kinds.
   */
  readonly maxAlphaByKey = new Map<string, number>();
  /** `WallFader.dirtyBuffers`'s twin, reused for the same reason. */
  private dirtyBuffers = new Set<THREE.BufferAttribute>();
  /** `WallFader.attrs`'s twin, re-resolved by `buildLayout` and `invalidateWritten`. */
  private attrs: (THREE.BufferAttribute | undefined)[] = [];
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

  /**
   * Pass one: the points where a sightline lands *on* a floor rather than merely crossing the
   * infinite plane it sits in — a crossing outside every fan at that height is open air, and the
   * floor beside it must not fade. docs/render.md § Flats.
   *
   * A target's crossing point depends only on the height, so the first fan to claim one settles
   * that height for that target. `WallFader.collectCrossings`'s twin, appending to a bag the whole
   * frame shares for the same reason; pairs with `applyPierces`, and runs first.
   */
  collectPierces(frame: FadeFrame, out: FadeCrossings): void {
    const { camX, camY, camZ, targets } = frame;
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
  update(frame: FadeFrame): void {
    const bag = (this.pierces ??= new FadeCrossings());
    bag.reset();
    this.collectPierces(frame, bag);
    this.applyPierces(frame, bag);
  }

  /**
   * Pass two, over every pierce the frame filed — this fader's own and every
   * other flat fader's: a ball around each of them dissolves every fan **at
   * that height** it reaches. `WallFader.applyCrossings`'s twin.
   *
   * Runs after `collectPierces`, which is what refreshes the vertex layout the
   * walk below indexes through.
   */
  applyPierces(frame: FadeFrame, hits: FadeCrossings): void {
    const { dt, camX, camY, targets } = frame;
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

  /**
   * `WallFader.invalidateWritten`'s twin — `moved` and `lastScale` are this fader's own record of
   * what the buffers hold.
   */
  invalidateWritten(): void {
    this.lastCombined.fill(NaN);
    this.lastScale.fill(NaN);
    this.moved.fill(1);
    resolveColorAttrs(this.surfaces, this.meshes, this.attrs);
  }

  /**
   * Same base × occlusion × fog-of-war write as `WallFader.commit` — here the base is a water
   * surface's, and the alpha varies across the fan.
   */
  commit(fogAlphaOf: (subsector: number) => number): void {
    const dirty = this.dirtyBuffers;
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
      const scale = (s.baseAlpha ?? 1) * fogAlpha(s, fogAlphaOf);
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
        if (seen === undefined || highest > seen) {
          this.maxAlphaByKey.set(s.key, highest);
        }
      }
      this.moved[i] = 0;
      this.lastScale[i] = scale;
      if (settled || !changed) continue;
      const attr = this.attrs[i];
      if (!attr) continue;
      for (let p = 0; p < count; p++) {
        this.lastCombined[start + p] = this.scratch[p];
        attr.setW(s.vertexStart + p, this.scratch[p]);
      }
      dirty.add(attr);
    }

    for (const attr of dirty) attr.needsUpdate = true;
  }

  /**
   * (Re)lays the per-vertex arrays out over the current fans, resetting the fade to "not faded".
   */
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
    resolveColorAttrs(this.surfaces, this.meshes, this.attrs);
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

  /**
   * True once the layout matches the surfaces again — a no-op unless a mover rebuild reshaped a
   * fan.
   */
  private layoutValid(): boolean {
    for (let i = 0; i < this.surfaces.length; i++) {
      if (this.vertexCount[i] !== this.surfaces[i].vertexCount) return false;
    }
    return true;
  }
}

/**
 * How much fog of war lets a fan through. An ordinary flat is one leaf's own floor and answers with
 * its own subsector; a solid structure's cap belongs to no leaf and is revealed by any side of the
 * structure being seen, so it takes the **most** revealed of the leaves its ring borders
 * (`FlatSurface.revealedBy`, docs/render.md § Solid structures).
 */
function fogAlpha(surface: FlatSurface, fogAlphaOf: (subsector: number) => number): number {
  const also = surface.revealedBy;
  if (also === undefined) return fogAlphaOf(surface.subsector);
  let most = 0;
  for (const subsector of also) {
    const alpha = fogAlphaOf(subsector);
    if (alpha > most) most = alpha;
  }
  return most;
}
