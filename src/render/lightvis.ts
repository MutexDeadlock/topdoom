/**
 * `LightVisibility`: which subsectors a dynamic light actually reaches — a flood fill out of the
 * emitter's own BSP leaf that crosses a boundary only where sight does, so a torch stops at its
 * wall instead of shining through it. See docs/lights.md § Light stops at walls.
 */
import { closestTOnSegment, distSqToSegment, polygonCentroid, segmentCrossT, vecLength } from '../util/geom.ts';
import type { DoomMap } from '../wad/map.ts';
import type { SubSectorPoly } from './bsp.ts';
import { lightCellsOf, type LightCells } from './lightcells.ts';

/**
 * How far past a leaf's edge the neighbour probe steps. **Tuned by feel**, and the same 1.5 units
 * `mapmesh.ts` pushes a wall probe (`WALL_PROBE_OFFSET`): far enough to leave the leaf whatever
 * rounding the clip left at the boundary, far short of anything the BSP would put on the other
 * side.
 */
const EDGE_PROBE_OFFSET = 1.5;

/**
 * Angular resolution of a light's shadow map — how many directions out of the light get their own
 * nearest-blocker distance. **Tuned by feel**, against the arithmetic: one bin is 360/256 = 1.4
 * degrees, which at the far edge of a 100-unit light is 2.5 map units of stair-stepping along a
 * shadow's edge, and under a unit where the lights are brightest. Each step costs four bytes per
 * light per frame in the texture, and a segment covers only the bins it actually spans.
 */
export const SHADOW_STEPS = 256;

/**
 * Ceiling on how many subsectors one light may flood into. A light's radius normally stops it long
 * before this; the cap is what bounds the fill on a map where it doesn't — a huge radius in open
 * geometry — so a single frame can't walk the whole BSP. Tuned by feel.
 */
const MAX_REACH = 512;

/**
 * The part of `game/world.ts`'s `World` this needs, taken structurally — the same seam `MoverIndex`
 * and `SectorTransfers` use in render/mapmesh.ts, so the renderer keeps no import edge into
 * `game/`.
 */
export interface LightWorld {
  subsectorAt(x: number, y: number): number;
  subsectorsAlongSegment(x1: number, y1: number, x2: number, y2: number, out: number[]): void;
  blocksSight(lineIndex: number): boolean;
  linesNearInto(x: number, y: number, radius: number, out: number[]): void;
  forEachLineAlongSegment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    visit: (lineIndex: number) => boolean | void,
  ): number;
}

/**
 * One leaf's boundary, split across two arrays because half of it is indices and half geometry.
 * `ints` is `[neighbour, blockerCount, ...linedefs]` per record; `geom` is `[ax, ay, bx, by]` per
 * record, in the same order. A record is one *neighbour* across a polygon edge, so an edge that
 * borders several leaves contributes several — see `edgesOf`.
 */
interface Edges {
  ints: Int32Array;
  geom: Float64Array;
}

const NO_EDGES: Edges = { ints: new Int32Array(0), geom: new Float64Array(0) };

/**
 * The shadow map's angular indexing: bin 0 is due west and bin `SHADOW_STEPS / 2` due east.
 * Exported because all three readers — `castShadows` here, `DynamicLights.unshadowed` and the
 * fragment shader `render/textures.ts` splices these into — must index with the one convention,
 * or the map is read half a turn out.
 */
export const BIN_PER_RADIAN = SHADOW_STEPS / (2 * Math.PI);
export const BIN_HALF = SHADOW_STEPS / 2;

/**
 * The level's subsector adjacency, and the flood fill `DynamicLights.commit` runs over it once per
 * committed light per frame.
 *
 * Adjacency is **built lazily, per subsector, and kept**: each edge costs a BSP descent and a short
 * linedef walk, and lights only ever touch the small part of a map they stand in. Which linedefs
 * stand in an edge is fixed geometry and cached with it; whether they *block* is asked live, so a
 * door opening lets light through on the tic it opens.
 */
export class LightVisibility {
  readonly subsectorCount: number;
  /** The cells the reached leaves' lists are kept in — docs/lights.md § Light cells. */
  readonly cells: LightCells;

  private map: DoomMap;
  private polys: SubSectorPoly[];
  private world: LightWorld;
  private edges: (Edges | null)[];
  /**
   * `reach`'s frontier, a binary heap of leaves ordered by `cost` — see `heapPush`. A leaf enters
   * once per path that improved on its cost, so an entry may be stale by the time it surfaces;
   * `settled` is what tells. Reused across calls.
   */
  private heap: number[] = [];
  /** Per subsector, the `stamp` of the last `reach` that gave it a cost (`seen`) and settled it. */
  private seen: Int32Array;
  private settled: Int32Array;
  private stamp = 0;
  /** Per subsector, how far the light's path ran to reach it and where it entered — see `reach`. */
  private cost: Float64Array;
  private entry: Float64Array;
  /**
   * The light `castShadows` is currently tracing, parked here rather than captured: it runs once
   * per committed light per frame, and a fresh visitor closure per light is the allocation
   * `reach`'s out-array signature exists to avoid.
   */
  private castX = 0;
  private castZ = 0;
  private castRadius = 0;
  private castOut: Float32Array = new Float32Array(0);
  private castOffset = 0;
  /** `castShadows`'s own candidate list — see `World.linesNearInto`. */
  private castLines: number[] = [];

  constructor(map: DoomMap, polys: SubSectorPoly[], world: LightWorld) {
    this.map = map;
    this.polys = polys;
    this.world = world;
    this.subsectorCount = polys.length;
    this.cells = lightCellsOf(polys);
    this.edges = new Array(this.subsectorCount).fill(null);
    this.seen = new Int32Array(this.subsectorCount);
    this.settled = new Int32Array(this.subsectorCount);
    this.cost = new Float64Array(this.subsectorCount);
    this.entry = new Float64Array(this.subsectorCount * 2);
  }

  subsectorAt(x: number, y: number): number {
    return this.world.subsectorAt(x, y);
  }

  /**
   * Appends to `out` every subsector a light at (x, y) in leaf `from` reaches within `radius`,
   * `from` included, nearest path first. An out array rather than a visitor because this runs once
   * per committed light per frame, and a callback would allocate a closure per light.
   *
   * Two rules decide what is reached: a boundary is crossed only where `World.blocksSight` lets it
   * be, asked live so a door works, and `radius` bounds the **path** the light took rather than the
   * straight line to it. Attenuation stays straight-line, matching the shader.
   * docs/lights.md § Light stops at walls.
   */
  reach(from: number, x: number, y: number, radius: number, out: number[]): void {
    if (from < 0 || from >= this.subsectorCount) return;
    const stamp = ++this.stamp;
    const seen = this.seen;
    const settled = this.settled;
    const cost = this.cost;
    const entry = this.entry;
    const heap = this.heap;
    heap.length = 0;
    seen[from] = stamp;
    cost[from] = 0;
    entry[from * 2] = x;
    entry[from * 2 + 1] = y;
    this.heapPush(from);
    let visited = 0;
    while (heap.length > 0) {
      const s = this.heapPop();
      // A stale entry: a cheaper path settled this leaf since it was pushed.
      if (settled[s] === stamp) continue;
      settled[s] = stamp;
      out.push(s);
      if (++visited >= MAX_REACH) return;
      const { ints, geom } = this.edgesOf(s);
      const fromX = entry[s * 2];
      const fromY = entry[s * 2 + 1];
      const fromCost = cost[s];
      for (let i = 0, edge = 0; i < ints.length; edge++) {
        const nb = ints[i];
        const lines = ints[i + 1];
        const first = i + 2;
        i = first + lines;
        if (settled[nb] === stamp) continue;
        let blocked = false;
        for (let l = first; l < first + lines && !blocked; l++) blocked = this.world.blocksSight(ints[l]);
        if (blocked) continue;
        // Where the path crosses this edge: its nearest point to wherever the path entered `s`.
        // The straight-line funnel a proper geodesic would compute is finer than this and costs
        // more than the fill it would be bounding.
        const g = edge * 4;
        const t = closestTOnSegment(fromX, fromY, geom[g], geom[g + 1], geom[g + 2], geom[g + 3]);
        const px = geom[g] + (geom[g + 2] - geom[g]) * t;
        const py = geom[g + 1] + (geom[g + 3] - geom[g + 1]) * t;
        const d = fromCost + vecLength(px - fromX, py - fromY);
        // A hop past the radius leaves the leaf as it was: another route may still fit, and only
        // a cheaper one replaces what the leaf already holds. docs/lights.md § Light stops at
        // walls, "The radius bounds the path".
        if (d > radius || (seen[nb] === stamp && d >= cost[nb])) continue;
        seen[nb] = stamp;
        cost[nb] = d;
        entry[nb * 2] = px;
        entry[nb * 2 + 1] = py;
        this.heapPush(nb);
      }
    }
  }

  /**
   * A token that changes whenever any answer `blocksSight` could give has changed: a hash over
   * every sector's floor and ceiling, which is all `World.blocksSight` reads. What
   * `DynamicLights` keys its per-emitter memo of `reach`/`castShadows` on, so a light that has
   * not moved in a level where nothing has moved is flooded once, not once per frame.
   *
   * **Derived, not bumped.** A version counter raised by whoever moves a sector is a contract the
   * next mover can forget, and forgetting it looks like light shining through a closed door;
   * nobody can forget this. One pass over `map.sectors`, once per frame.
   */
  sightVersion(): number {
    let h = 0;
    for (const sector of this.map.sectors) {
      // Scaled before truncating so a mover's sub-unit step still moves the hash; the heights are
      // fractional only while something is in motion, which is the case that misses anyway. The
      // 64 is **tuned by feel**: fine enough that no mover step this engine produces hashes equal
      // to the one before it, coarse enough that float noise in a resting height cannot.
      h = (Math.imul(h, 31) + Math.trunc(sector.floorHeight * 64)) | 0;
      h = (Math.imul(h, 31) + Math.trunc(sector.ceilHeight * 64)) | 0;
    }
    return h;
  }

  /**
   * Writes one light's shadow map into `out[offset .. offset + SHADOW_STEPS)`: per angular bin, how
   * far the light gets before a sight blocker stops it, or `radius` where nothing does. This is the
   * per-pixel half of the occlusion the leaf fill does per room — GZDoom keeps a 1D shadow map per
   * light for the same job (`hw_shadowmap.cpp`). docs/lights.md § Light stops at walls.
   *
   * Angles are measured in **three.js space** (x east, z south) rather than DOOM's, so the shader
   * can take `atan` of a world position straight off the varying with no axis flip.
   */
  castShadows(x: number, y: number, radius: number, out: Float32Array, offset: number): void {
    out.fill(radius, offset, offset + SHADOW_STEPS);
    this.castX = x;
    this.castZ = -y;
    this.castRadius = radius;
    this.castOut = out;
    this.castOffset = offset;
    this.world.linesNearInto(x, y, radius, this.castLines);
    for (const line of this.castLines) this.castVisit(line);
  }

  /**
   * A leaf's edges, computed on first use and kept: per edge, the leaf across it and every linedef
   * standing between the two.
   *
   * One polygon edge is **split into a record per leaf across it**, walking the BSP along the edge
   * pushed `EDGE_PROBE_OFFSET` out — a single midpoint probe answers for whichever neighbour the
   * midpoint lands in and loses every other, which is how a light stops dead at a doorway in the
   * open half of a wall it shares its edge with.
   *
   * Which linedefs stand in a record is a **crossing test from the leaf's own centre, not a
   * collinearity one** — the load-bearing choice here, and the reason an out-of-map probe needs no
   * special case. docs/lights.md § The adjacency graph.
   */
  private edgesOf(subsector: number): Edges {
    const hit = this.edges[subsector];
    if (hit) return hit;
    const pts = this.polys[subsector]?.points;
    if (!pts || pts.length < 6) {
      this.edges[subsector] = NO_EDGES;
      return NO_EDGES;
    }
    const n = pts.length / 2;
    const { x: cx, y: cy } = polygonCentroid(pts);

    const ints: number[] = [];
    const geom: number[] = [];
    const runs: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2];
      const ay = pts[i * 2 + 1];
      const bx = pts[j * 2];
      const by = pts[j * 2 + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = vecLength(dx, dy);
      if (len < 1e-6) continue;
      let nx = dy / len;
      let ny = -dx / len;
      if (nx * ((ax + bx) / 2 - cx) + ny * ((ay + by) / 2 - cy) < 0) {
        nx = -nx;
        ny = -ny;
      }
      // Both ends pulled in, so a corner probes this edge's own neighbours rather than a leaf that
      // only touches the polygon at that point. `len / 4` caps the pull-in on a short edge at a
      // quarter of it, leaving half the edge to probe along however short it is — **tuned by
      // feel**, against nothing but that requirement.
      const inset = Math.min(EDGE_PROBE_OFFSET, len / 4) / len;
      // Two segments in step: `s`->`e` runs along the polygon edge itself, which is what a record
      // stores as its geometry, and `p`->`q` is that same span pushed out into the neighbour,
      // which is what the BSP is walked along. A run's fractions index either one.
      const sx = ax + dx * inset;
      const sy = ay + dy * inset;
      const ex = bx - dx * inset;
      const ey = by - dy * inset;
      const px = sx + nx * EDGE_PROBE_OFFSET;
      const py = sy + ny * EDGE_PROBE_OFFSET;
      const qx = ex + nx * EDGE_PROBE_OFFSET;
      const qy = ey + ny * EDGE_PROBE_OFFSET;
      runs.length = 0;
      this.world.subsectorsAlongSegment(px, py, qx, qy, runs);
      for (let r = 0; r < runs.length; r += 3) {
        const nb = runs[r + 2];
        if (nb === subsector || nb < 0 || nb >= this.subsectorCount) continue;
        const t0 = runs[r];
        const t1 = runs[r + 1];
        const x0 = sx + (ex - sx) * t0;
        const y0 = sy + (ey - sy) * t0;
        const x1 = sx + (ex - sx) * t1;
        const y1 = sy + (ey - sy) * t1;
        const at = ints.length;
        ints.push(nb, 0);
        // Aimed at the middle of the run's own share of the probe segment, so a record that covers
        // a slice of the edge tests the lines standing across *that* slice.
        this.linesAcross(cx, cy, px + (qx - px) * ((t0 + t1) / 2), py + (qy - py) * ((t0 + t1) / 2), ints);
        ints[at + 1] = ints.length - at - 2;
        geom.push(x0, y0, x1, y1);
      }
    }
    const edges: Edges = { ints: Int32Array.from(ints), geom: Float64Array.from(geom) };
    this.edges[subsector] = edges;
    return edges;
  }

  /**
   * One sight blocker's bite out of the light `castShadows` set up. A pre-bound field rather than
   * a closure passed per call — see the `cast*` scratch above.
   */
  private castVisit = (line: number): void => {
    if (!this.world.blocksSight(line)) return;
    const ld = this.map.linedefs[line];
    const v1 = this.map.vertexes[ld.v1];
    const v2 = this.map.vertexes[ld.v2];
    if (!v1 || !v2) return;
    const radius = this.castRadius;
    const out = this.castOut;
    const px = v1.x - this.castX;
    const pz = -v1.y - this.castZ;
    const qx = v2.x - this.castX;
    const qz = -v2.y - this.castZ;
    if (distSqToSegment(0, 0, px, pz, qx, qz) > radius * radius) return;
    // The bins the segment covers: the *shorter* arc between its ends, which is the one it
    // actually subtends — a segment can only span half the circle by passing through the light,
    // and one that does is skipped rather than wrapped the wrong way round.
    const a0 = Math.atan2(pz, px);
    const a1 = Math.atan2(qz, qx);
    let span = a1 - a0;
    if (span > Math.PI) span -= 2 * Math.PI;
    else if (span < -Math.PI) span += 2 * Math.PI;
    if (Math.abs(span) < 1e-6 || Math.abs(Math.abs(span) - Math.PI) < 1e-6) return;
    const steps = Math.ceil(Math.abs(span) * BIN_PER_RADIAN) + 1;
    const sx = qx - px;
    const sz = qz - pz;
    // `segmentCrossT` written out: the crossing's numerator is fixed by the segment, so it is
    // hoisted out of the per-bin loop below — only the ray direction varies with `k`.
    const cross = px * sz - pz * sx;
    const start = a0 * BIN_PER_RADIAN + BIN_HALF;
    const step = (span * BIN_PER_RADIAN) / steps;
    for (let k = 0; k <= steps; k++) {
      const slot = Math.round(start + step * k);
      const theta = (slot - BIN_HALF) / BIN_PER_RADIAN;
      const rx = Math.cos(theta);
      const rz = Math.sin(theta);
      const denom = rx * sz - rz * sx;
      if (denom > -1e-9 && denom < 1e-9) continue;
      const t = cross / denom;
      if (t <= 0 || t >= radius) continue;
      const u = (px * rz - pz * rx) / denom;
      if (u < 0 || u > 1) continue;
      const at = this.castOffset + (((slot % SHADOW_STEPS) + SHADOW_STEPS) % SHADOW_STEPS);
      if (t < out[at]) out[at] = t;
    }
  };

  /** Appends every linedef crossing the segment from the leaf's centre out to the neighbour. */
  private linesAcross(x1: number, y1: number, x2: number, y2: number, out: number[]): void {
    this.world.forEachLineAlongSegment(x1, y1, x2, y2, (line) => {
      const ld = this.map.linedefs[line];
      if (!ld) return;
      const v1 = this.map.vertexes[ld.v1];
      const v2 = this.map.vertexes[ld.v2];
      if (!v1 || !v2) return;
      if (segmentCrossT(x1, y1, x2, y2, v1.x, v1.y, v2.x, v2.y) >= 0) out.push(line);
    });
  }

  /**
   * `reach`'s frontier as a binary min-heap on `cost`, kept by hand because the fill runs once per
   * committed light per frame and a sorted insert over the handful of leaves a light touches is
   * cheaper than any allocation. Duplicates are allowed — a leaf is pushed again when a cheaper
   * path turns up — and `reach` drops the stale ones on the way out.
   */
  private heapPush(leaf: number): void {
    const heap = this.heap;
    const cost = this.cost;
    let i = heap.length;
    heap.push(leaf);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (cost[heap[parent]] <= cost[leaf]) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = leaf;
  }

  private heapPop(): number {
    const heap = this.heap;
    const cost = this.cost;
    const top = heap[0];
    const last = heap.pop()!;
    const n = heap.length;
    if (n === 0) return top;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      const child = right < n && cost[heap[right]] < cost[heap[left]] ? right : left;
      if (cost[heap[child]] >= cost[last]) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
    return top;
  }
}
