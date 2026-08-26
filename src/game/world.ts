/**
 * `World`: the loaded map's shared spatial queries — subsector/sector lookup, floor heights,
 * collision (`positionBlocked`, `slideMove`), line of sight, vertical openings and shot tracing
 * (`shotPath`). Every layer reads the level through this. See docs/world.md and docs/movement.md.
 */
import { LF, NO_SIDE, SKY_FLAT, SUBSECTOR_BIT, type DoomMap, type Sector, type Thing } from '../wad/map.ts';
import { buildSubSectorPolys } from '../render/bsp.ts';
import { segmentCrossT, segmentIntersect } from '../util/geom.ts';
import { PLAYER_HEIGHT, SIGHT_EYE_HEIGHT } from './player.ts';
import { spawnAngleDeg } from './skill.ts';
import { ThingType } from './things/doomednums.ts';
import type { Placement, Pos2, Pos3 } from '../types.ts';

/** Vanilla DOOM value, in map units. */
export const MAX_STEP_UP = 24;

/**
 * A feet height that vacates both of `checkPosition`'s z-relative gates, so
 * only the line's own geometry is tested — vanilla's pre-`floatok` subset of
 * `P_TryMove`. `monsters/ai.ts: testStep` is the only caller that wants it.
 */
export const ANY_HEIGHT = Infinity;

const GRID_CELL = 128;

/**
 * Each candidate wall is extended this far past both endpoints before a ray is tested against it.
 * Two walls meeting at a shared vertex otherwise let a ray aimed right at that point pass outside
 * the end of both and hit neither — one constant for every trace that has the problem: shots and
 * projectiles here, sight blockers in `game/fogofwar.ts`. The extended endpoints themselves are
 * precomputed in `lineOverlapEnds`.
 */
export const WALL_OVERLAP = 0.25;

/**
 * Vanilla's `slopetype_t` (`p_local.h`), assigned per linedef by
 * `P_LoadLineDefs` (`p_setup.c`) and read only by `boxOnLineSide`, which picks
 * which pair of box corners to test from it.
 */
const ST_HORIZONTAL = 0;
const ST_VERTICAL = 1;
const ST_POSITIVE = 2;
const ST_NEGATIVE = 3;

/** Vanilla's `BOXTOP`…`BOXRIGHT` (`p_local.h`), the order `World.lineBox` packs each linedef's bounds in. */
const BOX_TOP = 0;
const BOX_BOTTOM = 1;
const BOX_LEFT = 2;
const BOX_RIGHT = 3;

export interface Opening {
  top: number;
  bottom: number;
}

/**
 * One body's cached `sectorsTouching` result — see `World.sectorsTouchingCached`.
 * `x`/`y`/`radius` are the query the list was computed for; NaN (the
 * `makeTouchCache` seed) matches nothing, so the first call always fills it.
 */
export interface SectorTouchCache {
  x: number;
  y: number;
  radius: number;
  sectors: number[];
}

export function makeTouchCache(): SectorTouchCache {
  return { x: NaN, y: NaN, radius: NaN, sectors: [] };
}

/** One body's captured neighborhood heights — see `World.captureHeights`. */
export interface HeightsStamp {
  sectors: number[];
  /** floorHeight, ceilHeight per stamped sector, interleaved. */
  heights: number[];
}

export function makeHeightsStamp(): HeightsStamp {
  return { sectors: [], heights: [] };
}

/**
 * One body's pinned-body memo: a proven "this exact position under this exact
 * push goes nowhere" outcome, valid until any stamped nearby sector height
 * changes (`World.capturePin`/`pinMatches`). `velX`/`velY` are whatever push
 * the caller proved the outcome under — a knockback velocity, a tic's summed
 * impulse. Allocated once per body and refilled in place, never per capture;
 * `active` gates whether the rest means anything.
 * docs/movement.md § Pinned-body memo.
 */
export interface PinnedMemo {
  active: boolean;
  x: number;
  y: number;
  z: number;
  velX: number;
  velY: number;
  stamp: HeightsStamp;
}

export function makePinnedMemo(): PinnedMemo {
  return { active: false, x: 0, y: 0, z: 0, velX: 0, velY: 0, stamp: makeHeightsStamp() };
}

/**
 * Broadphase slop (map units) widening a pin's stamped box past the attempted
 * move — generous on purpose: stamping an extra sector is harmless, while
 * missing one leaves a body pinned against a door that has since opened.
 */
const PIN_STAMP_SLOP = 4;

/**
 * The map plus the queries the game logic needs: where am I, how high is the
 * floor here, and which lines are close enough to bump into.
 */
export class World {
  private grid = new Map<number, number[]>();
  private gridMinX: number;
  private gridMinY: number;
  private gridCols: number;
  private gridRows: number;
  /** Adjacency list for `noiseAlert`'s flood, precomputed once instead of rescanning every linedef per visited sector. */
  private sectorNeighbors: { neighbor: number; lineIndex: number }[][] = [];
  /** Sectors a noise has ever reached (`noiseAlert`) — never cleared, matching vanilla's own `soundtarget`, which persists for the rest of the level once set. */
  private soundAlertedSectors = new Set<Sector>();
  /**
   * Per-linedef "last query that already visited this line" stamps, so
   * `forEachLineAlongSegment` can dedupe a line that spans several of the
   * cells it walks without allocating a `Set` per call. `linesNear` allocates
   * one every time, which is fine at its call rate but not at a sightline
   * check's — see `hasLineOfSight`.
   */
  private lineStamp: Int32Array;
  private queryId = 0;

  /**
   * The per-linedef geometry vanilla precomputes in `P_LoadLineDefs` and its
   * collision reads on every probe: each line's own bounding box (packed four
   * to a line in `BOX_*` order), its `dx`/`dy`, its first vertex, and its
   * `slopetype`. Parallel typed arrays indexed by linedef index, the same
   * discipline `lineStamp` uses — this is read once per candidate line per
   * movement probe, which is the hottest query in the engine.
   * See docs/movement.md § Collision.
   */
  private lineBox: Float64Array;
  /** Each linedef's own direction — vanilla's `ld->dx`/`ld->dy`, what `P_HitSlideLine` projects a refused move onto. */
  readonly lineDX: Float64Array;
  readonly lineDY: Float64Array;
  private lineV1X: Float64Array;
  private lineV1Y: Float64Array;
  private lineSlope: Int8Array;

  /**
   * Every linedef's endpoints extended `WALL_OVERLAP` past both ends, packed x1,y1,x2,y2 per line:
   * what every ray-vs-wall crossing test in the engine actually tests against. Precomputed with
   * the rest because vertexes never move, so the normalize-and-extend it replaces was pure
   * repeated work — per candidate line, per shot, per projectile step and per fog sight ray.
   */
  readonly lineOverlapEnds: Float64Array;

  /**
   * Subsector index -> its sector index (vanilla's `subsector->sector`), built
   * once at load so every sector lookup — `sectorIndexAt`, `sectorAt` and the
   * heights over them, the REJECT probe — costs one typed-array read rather
   * than the seg -> linedef -> sidedef walk `sectorOfSubSector` does. Taken
   * from `SubSectorPoly.physicalSector`, so a leaf a node builder misfiled
   * under its neighbour answers the sector it really lies in.
   * See docs/world.md § Point-to-sector lookups.
   */
  private subsectorSector: Int32Array;

  /**
   * Scratch `Opening` records for `openingInto`'s two callers in this file. Two rather than
   * one because `openingOf` hands its copy out while `blocksSight` runs per candidate line inside
   * traces that `openingOf` itself appears in. Callers elsewhere bring their own record.
   */
  private openingScratch: Opening = { top: 0, bottom: 0 };
  private sightScratch: Opening = { top: 0, bottom: 0 };

  readonly map: DoomMap;

  /**
   * The map's bounding-box diagonal: the longest straight line that fits inside
   * it, and so a trace length no in-map flight can be cut short by. What a
   * missile passes to `shotPath`, which needs *some* finite range for a thing
   * vanilla gives no range budget at all — see docs/combat.md § shotPath.
   */
  readonly mapSpan: number;

  constructor(map: DoomMap) {
    this.map = map;
    const { minX, minY, maxX, maxY } = map.bounds;
    this.mapSpan = Math.hypot(maxX - minX, maxY - minY);
    this.gridMinX = minX;
    this.gridMinY = minY;
    this.gridCols = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL) + 1);
    this.gridRows = Math.max(1, Math.ceil((maxY - minY) / GRID_CELL) + 1);
    this.lineStamp = new Int32Array(map.linedefs.length);
    this.lineBox = new Float64Array(map.linedefs.length * 4);
    this.lineDX = new Float64Array(map.linedefs.length);
    this.lineDY = new Float64Array(map.linedefs.length);
    this.lineV1X = new Float64Array(map.linedefs.length);
    this.lineV1Y = new Float64Array(map.linedefs.length);
    this.lineSlope = new Int8Array(map.linedefs.length);
    this.lineOverlapEnds = new Float64Array(map.linedefs.length * 4);
    this.subsectorSector = new Int32Array(map.subsectors.length);
    const polys = buildSubSectorPolys(map);
    for (let i = 0; i < map.subsectors.length; i++) this.subsectorSector[i] = polys[i].physicalSector;
    this.buildLineData();
    this.buildGrid();
    this.buildSectorNeighbors();
  }

  /**
   * Fills the per-linedef geometry tables — `P_LoadLineDefs`'s own derivation
   * (`p_setup.c`): `dx`/`dy` off the two vertexes, the bbox as their min/max,
   * and the slopetype from `!dx` first (so a degenerate zero-length line lands
   * on `ST_VERTICAL`, exactly as vanilla's ordering has it), then `!dy`, then
   * the sign of `dy/dx`.
   */
  private buildLineData(): void {
    for (let i = 0; i < this.map.linedefs.length; i++) {
      const line = this.map.linedefs[i];
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      this.lineDX[i] = dx;
      this.lineDY[i] = dy;
      this.lineV1X[i] = a.x;
      this.lineV1Y[i] = a.y;
      this.lineSlope[i] = dx === 0 ? ST_VERTICAL : dy === 0 ? ST_HORIZONTAL : dy / dx > 0 ? ST_POSITIVE : ST_NEGATIVE;
      const base = i * 4;
      this.lineBox[base + BOX_TOP] = Math.max(a.y, b.y);
      this.lineBox[base + BOX_BOTTOM] = Math.min(a.y, b.y);
      this.lineBox[base + BOX_LEFT] = Math.min(a.x, b.x);
      this.lineBox[base + BOX_RIGHT] = Math.max(a.x, b.x);

      const len = Math.hypot(dx, dy);
      const ex = len > 0 ? (dx / len) * WALL_OVERLAP : 0;
      const ey = len > 0 ? (dy / len) * WALL_OVERLAP : 0;
      this.lineOverlapEnds[base] = a.x - ex;
      this.lineOverlapEnds[base + 1] = a.y - ey;
      this.lineOverlapEnds[base + 2] = b.x + ex;
      this.lineOverlapEnds[base + 3] = b.y + ey;
    }
  }

  /**
   * Which side of linedef `lineIndex` the point (x, y) lies on — vanilla's
   * `P_PointOnLineSide` (`p_maputl.c`): 0 front, 1 back, and a point exactly
   * *on* the line counts as the back side, which its `right < left` test is
   * what decides. The axis-aligned fast paths are vanilla's own.
   *
   * Vanilla truncates `dy` to whole units before multiplying
   * (`FixedMul(line->dy>>FRACBITS, dx)`); this doesn't, which is a precision
   * improvement over the original rather than a behavior choice.
   */
  pointOnLineSide(x: number, y: number, lineIndex: number): number {
    const dx = this.lineDX[lineIndex];
    const dy = this.lineDY[lineIndex];
    if (dx === 0) {
      if (x <= this.lineV1X[lineIndex]) return dy > 0 ? 1 : 0;
      return dy < 0 ? 1 : 0;
    }
    if (dy === 0) {
      if (y <= this.lineV1Y[lineIndex]) return dx < 0 ? 1 : 0;
      return dx > 0 ? 1 : 0;
    }
    const left = dy * (x - this.lineV1X[lineIndex]);
    const right = (y - this.lineV1Y[lineIndex]) * dx;
    return right < left ? 0 : 1;
  }

  /**
   * Which side of linedef `lineIndex` an axis-aligned box lies on, or `-1` if
   * it spans the line — vanilla's `P_BoxOnLineSide` (`p_maputl.c`), and the
   * test that replaced this engine's original collision *circle*. The
   * slopetype picks which two opposing corners decide it, so only two point
   * tests run rather than four. See docs/movement.md § Collision.
   */
  boxOnLineSide(left: number, bottom: number, right: number, top: number, lineIndex: number): number {
    let p1 = 0;
    let p2 = 0;
    switch (this.lineSlope[lineIndex]) {
      case ST_HORIZONTAL:
        p1 = top > this.lineV1Y[lineIndex] ? 1 : 0;
        p2 = bottom > this.lineV1Y[lineIndex] ? 1 : 0;
        if (this.lineDX[lineIndex] < 0) {
          p1 ^= 1;
          p2 ^= 1;
        }
        break;
      case ST_VERTICAL:
        p1 = right < this.lineV1X[lineIndex] ? 1 : 0;
        p2 = left < this.lineV1X[lineIndex] ? 1 : 0;
        if (this.lineDY[lineIndex] < 0) {
          p1 ^= 1;
          p2 ^= 1;
        }
        break;
      case ST_POSITIVE:
        p1 = this.pointOnLineSide(left, top, lineIndex);
        p2 = this.pointOnLineSide(right, bottom, lineIndex);
        break;
      case ST_NEGATIVE:
        p1 = this.pointOnLineSide(right, top, lineIndex);
        p2 = this.pointOnLineSide(left, bottom, lineIndex);
        break;
    }
    return p1 === p2 ? p1 : -1;
  }

  /**
   * True if a box overlaps linedef `lineIndex`'s own bounding box —
   * `PIT_CheckLine`'s cheap reject, run before `boxOnLineSide`. Exactly flush
   * is deliberately *not* an overlap, matching vanilla's `<=`/`>=` and the
   * strict `< radius²` boundary the circle test it replaced also had.
   */
  boxOverlapsLine(left: number, bottom: number, right: number, top: number, lineIndex: number): boolean {
    const base = lineIndex * 4;
    return !(
      right <= this.lineBox[base + BOX_LEFT] ||
      left >= this.lineBox[base + BOX_RIGHT] ||
      top <= this.lineBox[base + BOX_BOTTOM] ||
      bottom >= this.lineBox[base + BOX_TOP]
    );
  }

  /**
   * The sound-alerted set as sector indices, for a savegame — the live set
   * holds `Sector` object references into `map.sectors`, which is also why
   * `restoreSoundAlerted` must resolve through the *current* map's array.
   */
  snapshotSoundAlerted(): number[] {
    const indices: number[] = [];
    for (let i = 0; i < this.map.sectors.length; i++) {
      if (this.soundAlertedSectors.has(this.map.sectors[i])) indices.push(i);
    }
    return indices;
  }

  restoreSoundAlerted(indices: number[]): void {
    this.soundAlertedSectors.clear();
    for (const i of indices) {
      const sector = this.map.sectors[i];
      if (sector) this.soundAlertedSectors.add(sector);
    }
  }

  /** Every sector's two-sided-line neighbors, for `noiseAlert`'s flood — built once rather than rescanning all linedefs per visited sector. */
  private buildSectorNeighbors(): void {
    this.sectorNeighbors = this.map.sectors.map(() => []);
    for (let li = 0; li < this.map.linedefs.length; li++) {
      const line = this.map.linedefs[li];
      if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
      const front = this.map.sidedefs[line.right]?.sector;
      const back = this.map.sidedefs[line.left]?.sector;
      if (front === undefined || back === undefined) continue;
      this.sectorNeighbors[front]?.push({ neighbor: back, lineIndex: li });
      this.sectorNeighbors[back]?.push({ neighbor: front, lineIndex: li });
    }
  }

  /** Buckets every linedef into the cells its bounding box touches. */
  private buildGrid(): void {
    for (let i = 0; i < this.map.linedefs.length; i++) {
      const line = this.map.linedefs[i];
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;

      const c0 = this.cellX(Math.min(a.x, b.x));
      const c1 = this.cellX(Math.max(a.x, b.x));
      const r0 = this.cellY(Math.min(a.y, b.y));
      const r1 = this.cellY(Math.max(a.y, b.y));

      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const key = cy * this.gridCols + cx;
          let bucket = this.grid.get(key);
          if (!bucket) this.grid.set(key, (bucket = []));
          bucket.push(i);
        }
      }
    }
  }

  private cellX(x: number): number {
    return Math.max(0, Math.min(this.gridCols - 1, Math.floor((x - this.gridMinX) / GRID_CELL)));
  }

  private cellY(y: number): number {
    return Math.max(0, Math.min(this.gridRows - 1, Math.floor((y - this.gridMinY) / GRID_CELL)));
  }

  /**
   * `linesNear` without its array: every linedef whose cell overlaps the box around (x, y), each
   * visited at most once. The visitor may return `true` to stop the walk early, the way a `break`
   * would.
   *
   * This is the form a **per-frame** caller wants — `LightVisibility.castShadows` runs it once per
   * committed light per frame, where `linesNear`'s `Set` plus spread would be a pair of
   * allocations per light. Dedup rides the same `lineStamp` cursor `forEachLineAlongSegment` uses.
   */
  forEachLineNear(x: number, y: number, radius: number, visit: (lineIndex: number) => boolean | void): void {
    const stamp = ++this.queryId;
    const c0 = this.cellX(x - radius);
    const c1 = this.cellX(x + radius);
    const r0 = this.cellY(y - radius);
    const r1 = this.cellY(y + radius);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const bucket = this.grid.get(cy * this.gridCols + cx);
        if (!bucket) continue;
        for (const i of bucket) {
          if (this.lineStamp[i] === stamp) continue;
          this.lineStamp[i] = stamp;
          if (visit(i) === true) return;
        }
      }
    }
  }

  /** Linedef indices whose cell overlaps the box around (x, y) with the given radius. */
  linesNear(x: number, y: number, radius: number): number[] {
    const seen = new Set<number>();
    const c0 = this.cellX(x - radius);
    const c1 = this.cellX(x + radius);
    const r0 = this.cellY(y - radius);
    const r1 = this.cellY(y + radius);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const bucket = this.grid.get(cy * this.gridCols + cx);
        if (bucket) for (const i of bucket) seen.add(i);
      }
    }
    return [...seen];
  }

  /**
   * Every linedef bucketed into a grid cell the segment (x1, y1)-(x2, y2)
   * passes through, each visited at most once. The visitor may return `true`
   * to stop the walk early, the way a `break` would.
   *
   * This is the query a **sightline** wants; `linesNear`'s radius box is
   * O(dist²) in cells for a thin line and was the engine's biggest single cost
   * on a crowded map. Allocation-free by design (stamp array, callback), since
   * it runs thousands of times per frame. docs/world.md § hasLineOfSight
   * covers why this is both sound and necessary.
   *
   * Returns what the walk cost — cells stepped plus lines handed to `visit` — so a caller that
   * budgets its traces can charge the real figure instead of estimating one from the cell size,
   * which is this class's own business (`FogOfWar`'s sweep; docs/fogofwar.md § Sight testing).
   * Callers that don't budget ignore it.
   */
  forEachLineAlongSegment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    visit: (lineIndex: number) => boolean | void,
  ): number {
    const stamp = ++this.queryId;
    let cx = this.cellX(x1);
    let cy = this.cellY(y1);
    const ex = this.cellX(x2);
    const ey = this.cellY(y2);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const stepX = dx >= 0 ? 1 : -1;
    const stepY = dy >= 0 ? 1 : -1;
    // How far along the segment (in its own 0..1 parameter) one full cell of
    // travel costs on each axis, and how far to the first cell boundary.
    const tDeltaX = dx !== 0 ? Math.abs(GRID_CELL / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(GRID_CELL / dy) : Infinity;
    let tMaxX =
      dx !== 0 ? (this.gridMinX + (cx + (stepX > 0 ? 1 : 0)) * GRID_CELL - x1) / dx : Infinity;
    let tMaxY =
      dy !== 0 ? (this.gridMinY + (cy + (stepY > 0 ? 1 : 0)) * GRID_CELL - y1) / dy : Infinity;

    // Bounded rather than "until (cx,cy) reaches (ex,ey)": cellX/cellY clamp to
    // the grid, so a segment starting or ending outside the map can otherwise
    // never reach its end cell.
    const maxSteps = this.gridCols + this.gridRows + 2;
    let work = 0;
    for (let step = 0; ; step++) {
      work++;
      const bucket = this.grid.get(cy * this.gridCols + cx);
      if (bucket) {
        for (const i of bucket) {
          if (this.lineStamp[i] === stamp) continue;
          this.lineStamp[i] = stamp;
          work++;
          if (visit(i) === true) return work;
        }
      }
      if ((cx === ex && cy === ey) || step >= maxSteps) return work;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        tMaxY += tDeltaY;
        cy += stepY;
      }
    }
  }

  /** Walks the BSP tree down to the subsector containing the point. */
  subsectorAt(x: number, y: number): number {
    const nodes = this.map.nodes;
    if (nodes.length === 0) return 0;
    let child = nodes.length - 1;
    while ((child & SUBSECTOR_BIT) === 0) {
      const node = nodes[child];
      if (!node) return 0;
      // Same side test as the renderer: cross < 0 means the front (right) side.
      const cross = node.dx * (y - node.y) - node.dy * (x - node.x);
      child = cross < 0 ? node.rightChild : node.leftChild;
    }
    return child & ~SUBSECTOR_BIT;
  }

  /**
   * The segment form of `subsectorAt`: appends to `out` a `t0, t1, subsector` triple per BSP leaf
   * the segment (x1, y1) -> (x2, y2) passes through, in order, `t` being the fraction along it.
   * Adjacent runs naming the same leaf are merged.
   *
   * Here rather than in its one caller so the BSP stays behind this class's seam — the walk
   * repeats `subsectorAt`'s side test rather than sharing it, since that one is a per-sprite
   * per-frame path and a helper call measured no faster; a sign fix has to land in both. What
   * needs this is `LightVisibility`: one subsector polygon edge can border several leaves at
   * once, and a single midpoint probe answers for only the one it happens to land in
   * (docs/lights.md § The adjacency graph). See docs/world.md § Point-to-sector lookups.
   */
  subsectorsAlongSegment(x1: number, y1: number, x2: number, y2: number, out: number[]): void {
    if (this.map.nodes.length === 0) {
      out.push(0, 1, 0);
      return;
    }
    this.walkSegmentLeaves(this.map.nodes.length - 1, x1, y1, x2, y2, 0, 1, out);
  }

  /**
   * One subtree's share of `subsectorsAlongSegment`. The near half of a split recurses; the far
   * half continues in the loop, so the recursion depth is the tree's and not the segment's.
   */
  private walkSegmentLeaves(
    child: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    t0: number,
    t1: number,
    out: number[],
  ): void {
    while ((child & SUBSECTOR_BIT) === 0) {
      const node = this.map.nodes[child];
      if (!node) return;
      const c1 = node.dx * (y1 - node.y) - node.dy * (x1 - node.x);
      const c2 = node.dx * (y2 - node.y) - node.dy * (x2 - node.x);
      const front1 = c1 < 0;
      if (front1 === (c2 < 0)) {
        child = front1 ? node.rightChild : node.leftChild;
        continue;
      }
      // The ends straddle the partition; c1 and c2 have strict opposite signs, so the split
      // fraction is well defined.
      const t = c1 / (c1 - c2);
      const mx = x1 + (x2 - x1) * t;
      const my = y1 + (y2 - y1) * t;
      const tm = t0 + (t1 - t0) * t;
      this.walkSegmentLeaves(front1 ? node.rightChild : node.leftChild, x1, y1, mx, my, t0, tm, out);
      child = front1 ? node.leftChild : node.rightChild;
      x1 = mx;
      y1 = my;
      t0 = tm;
    }
    const leaf = child & ~SUBSECTOR_BIT;
    if (out.length >= 3 && out[out.length - 1] === leaf) out[out.length - 2] = t1;
    else out.push(t0, t1, leaf);
  }

  /**
   * The sector a subsector belongs to, off the precomputed table. A subsector
   * index this map doesn't have answers sector 0.
   * See docs/world.md § Point-to-sector lookups.
   */
  sectorIndexOfSubsector(subsector: number): number {
    return subsector >= 0 && subsector < this.subsectorSector.length ? this.subsectorSector[subsector] : 0;
  }

  sectorIndexAt(x: number, y: number): number {
    return this.sectorIndexOfSubsector(this.subsectorAt(x, y));
  }

  /**
   * Vanilla's trivial sight rejection (`p_sight.c: P_CheckSight`), and the
   * whole of what `hasLineOfSight` needs to decide it: the REJECT bit at
   * `s1 * numsectors + s2`, false whenever the map ships no usable table.
   *
   * The two subsector arguments are the *hints* `hasLineOfSight` was handed —
   * anything below zero is resolved here, so a map without a table never pays
   * the descent. See docs/world.md § REJECT.
   */
  sightRejected(from: Pos2, to: Pos2, fromSubsector: number, toSubsector: number): boolean {
    const reject = this.map.reject;
    if (!reject) return false;
    const table = this.subsectorSector;
    const a = fromSubsector >= 0 ? fromSubsector : this.subsectorAt(from.x, from.y);
    const b = toSubsector >= 0 ? toSubsector : this.subsectorAt(to.x, to.y);
    // A hint naming no subsector this map has is rejected by nothing, rather
    // than answering for whatever sector the out-of-range read produces.
    if (a >= table.length || b >= table.length) return false;
    const pnum = table[a] * this.map.sectors.length + table[b];
    return (reject[pnum >> 3] & (1 << (pnum & 7))) !== 0;
  }

  /** The sector a subsector belongs to, for a caller that already has the subsector `sectorAt` would descend the BSP to find. */
  sectorOfSubsector(subsector: number): Sector | undefined {
    return this.map.sectors[this.sectorIndexOfSubsector(subsector)];
  }

  sectorAt(x: number, y: number): Sector | undefined {
    return this.map.sectors[this.sectorIndexAt(x, y)];
  }

  /**
   * Every sector a body of this radius overlaps, centre sector first — vanilla's
   * `touching_sectorlist` (`P_CreateSecNodeList`/`PIT_GetSectors`), filtered by
   * the same two tests: the box must overlap the line's bounding box, and must
   * not lie wholly on one side of it. Both of a crossed line's sectors count.
   *
   * The point queries beside this one answer for the centre alone, which is
   * wrong for anything a body can straddle — a conveyor's edge, an ice patch
   * half underfoot. Written into the caller's `out` (cleared first) and
   * returned, so the per-tic force queries don't allocate a fresh array each
   * time. See docs/world.md § Sectors under a body.
   */
  sectorsTouching(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0;
    out.push(this.sectorIndexAt(x, y));
    const left = x - radius;
    const right = x + radius;
    const bottom = y - radius;
    const top = y + radius;
    // The `+ 1` is broadphase slop only, as in `checkPosition`.
    for (const i of this.linesNear(x, y, radius + 1)) {
      if (!this.boxOverlapsLine(left, bottom, right, top, i)) continue;
      if (this.boxOnLineSide(left, bottom, right, top, i) !== -1) continue;
      const line = this.map.linedefs[i];
      // Both sides written out rather than looped over a `[right, left]` pair:
      // that pair would be a fresh array per candidate line, in the method whose
      // whole point is not to allocate per tic per body.
      this.addTouchedSector(out, line.right);
      this.addTouchedSector(out, line.left);
    }
    return out;
  }

  /** `sectorsTouching`'s accumulator: the sector behind one sidedef, if it isn't already listed. */
  private addTouchedSector(out: number[], side: number): void {
    if (side === NO_SIDE) return;
    const sector = this.map.sidedefs[side]?.sector;
    // Linear scan rather than a Set: this list is a handful of entries long
    // even on the worst geometry, and it runs every tic per body.
    if (sector !== undefined && !out.includes(sector)) out.push(sector);
  }

  /**
   * `sectorsTouching` through a per-body cache: the touched-sector list is a
   * pure function of (x, y, radius) over *static* line geometry — sector
   * heights play no part in it — so it stays valid for as long as the body
   * stands still, which for most bodies on a level is almost always.
   * Recomputed only when the position the cache was filled at differs.
   * The cache belongs to **one body**; sharing one across bodies re-derives
   * the list every call and silently loses the whole point.
   * See docs/world.md § Sectors under a body.
   */
  sectorsTouchingCached(x: number, y: number, radius: number, cache: SectorTouchCache): readonly number[] {
    if (cache.x !== x || cache.y !== y || cache.radius !== radius) {
      this.sectorsTouching(x, y, radius, cache.sectors);
      cache.x = x;
      cache.y = y;
      cache.radius = radius;
    }
    return cache.sectors;
  }

  /**
   * Fills `stamp` with every sector adjacent to a line within `radius` of
   * (x, y) — plus the sector under the point itself — and their current
   * floor/ceiling heights. `heightsMatch` then answers whether any of them has
   * moved since. Together they are the invalidation half of a "this body's
   * blocked move is a proven no-op" memo: a blocked `slideMove`/
   * `positionBlocked`/`groundFloor` outcome can only change if a sector height
   * inside its query box changes (line geometry is static), so a caller that
   * captures the box once may skip the re-derivation every tic the stamp still
   * matches. docs/movement.md § Pinned-body memo.
   */
  captureHeights(x: number, y: number, radius: number, stamp: HeightsStamp): void {
    const sectors = stamp.sectors;
    sectors.length = 0;
    sectors.push(this.sectorIndexAt(x, y));
    for (const i of this.linesNear(x, y, radius)) {
      const line = this.map.linedefs[i];
      this.addTouchedSector(sectors, line.right);
      this.addTouchedSector(sectors, line.left);
    }
    stamp.heights.length = sectors.length * 2;
    for (let k = 0; k < sectors.length; k++) {
      const s = this.map.sectors[sectors[k]];
      stamp.heights[k * 2] = s ? s.floorHeight : 0;
      stamp.heights[k * 2 + 1] = s ? s.ceilHeight : 0;
    }
  }

  /**
   * Whether `memo` still proves the caller's blocked state a no-op: same
   * position, same push, and no stamped nearby sector height has changed.
   * `capturePin`'s other half — anything the caller's outcome additionally
   * depends on (a doll's residual momentum, a teleport) stays a gate at the
   * call site. docs/movement.md § Pinned-body memo.
   */
  pinMatches(memo: PinnedMemo, x: number, y: number, z: number, velX: number, velY: number): boolean {
    return (
      memo.active &&
      memo.x === x &&
      memo.y === y &&
      memo.z === z &&
      memo.velX === velX &&
      memo.velY === velY &&
      this.heightsMatch(memo.stamp)
    );
  }

  /**
   * Records a proven no-op into `memo`: this position under this push went
   * nowhere. The stamp's radius covers everything the blocked move could have
   * read — the body box plus the attempted step, plus `PIN_STAMP_SLOP` — so
   * `pinMatches` holds exactly until a height inside that box changes. Refills
   * the caller-owned memo in place; nothing is allocated.
   */
  capturePin(memo: PinnedMemo, x: number, y: number, z: number, velX: number, velY: number, radius: number, dt: number): void {
    this.captureHeights(x, y, radius + Math.hypot(velX, velY) * dt + PIN_STAMP_SLOP, memo.stamp);
    memo.active = true;
    memo.x = x;
    memo.y = y;
    memo.z = z;
    memo.velX = velX;
    memo.velY = velY;
  }

  /** Whether every sector `captureHeights` stamped still has the heights it had then. */
  heightsMatch(stamp: HeightsStamp): boolean {
    const { sectors, heights } = stamp;
    for (let k = 0; k < sectors.length; k++) {
      const s = this.map.sectors[sectors[k]];
      const floor = s ? s.floorHeight : 0;
      const ceil = s ? s.ceilHeight : 0;
      if (heights[k * 2] !== floor || heights[k * 2 + 1] !== ceil) return false;
    }
    return true;
  }

  floorAt(x: number, y: number): number {
    return this.sectorAt(x, y)?.floorHeight ?? 0;
  }

  ceilingAt(x: number, y: number): number {
    return this.sectorAt(x, y)?.ceilHeight ?? 0;
  }

  /**
   * Whether a shot stopping on this line at height `z` ran into sky rather
   * than something that can show an impact — vanilla's "don't shoot the sky"
   * pair of tests in `PTR_ShootTraverse`, both keyed off the *front* sector
   * (the linedef's own `right` side, whichever direction the shot came from,
   * as `line_t.frontsector` is). Only the bullet puff reads this: vanilla runs
   * `P_ShootSpecialLine` before the test, so a shoot-trigger on a sky wall
   * still fires. See docs/combat.md § Bullet puffs.
   */
  hitsSky(lineIndex: number, z: number): boolean {
    const line = this.map.linedefs[lineIndex];
    if (!line) return false;
    const front = this.map.sectors[this.map.sidedefs[line.right]?.sector];
    if (!front || front.ceilTex !== SKY_FLAT) return false;
    if (z > front.ceilHeight) return true;
    // The sky-hack wall: a two-sided line with sky on both sides is the seam
    // between two open-air sectors, not a surface anything can splash on.
    if (line.left === NO_SIDE) return false;
    return this.map.sectors[this.map.sidedefs[line.left]?.sector]?.ceilTex === SKY_FLAT;
  }

  /** Gap a two-sided line leaves free, or null if the line is impassable. */
  openingOf(lineIndex: number): Opening | null {
    return this.openingInto(lineIndex, this.openingScratch) ? { ...this.openingScratch } : null;
  }

  /**
   * `openingOf` without the record: writes vanilla's `P_LineOpening` pair into a caller-owned
   * `Opening` and answers whether the line has one at all. The predicates that run per candidate
   * line — `blocksSight` above all — call this so the allocation stays with the callers that
   * actually want a record. See docs/world.md § Point-to-sector lookups.
   */
  openingInto(lineIndex: number, out: Opening): boolean {
    const line = this.map.linedefs[lineIndex];
    if (!line) return false;
    if (line.left === NO_SIDE || line.right === NO_SIDE) return false;
    const front = this.map.sectors[this.map.sidedefs[line.right]?.sector];
    const back = this.map.sectors[this.map.sidedefs[line.left]?.sector];
    if (!front || !back) return false;
    out.top = front.ceilHeight < back.ceilHeight ? front.ceilHeight : back.ceilHeight;
    out.bottom = front.floorHeight > back.floorHeight ? front.floorHeight : back.floorHeight;
    return true;
  }

  /**
   * The height a body of this radius should rest at, standing here: the local
   * sector's floor, raised to the bottom of any two-sided opening its box
   * currently spans — vanilla's `thing->floorz` in `P_TryMove`, which
   * keeps a mover pinned to a ledge's high side while its box still spans
   * that ledge's line. Point-sampling the floor instead deadlocks a fall off a
   * ledge; see docs/movement.md § Collision.
   */
  groundFloor(x: number, y: number, radius: number, forMonster = false): number {
    return checkPosition(this, x, y, radius, ANY_HEIGHT, ANY_HEIGHT, forMonster, undefined, undefined, false).floorZ;
  }

  /**
   * The lowest ceiling a body of this radius must clear, standing here — the
   * mirror of `groundFloor`: the local sector's ceiling, lowered to the top
   * of any two-sided opening its box currently spans. Exists so a
   * rising floor's headroom check (`game.ts: blocksFloorRise`) can see a
   * lower-ceilinged neighbor sector the player's box still overlaps, not
   * just the rising sector's own ceiling — see docs/movement.md § Collision.
   */
  groundCeiling(x: number, y: number, radius: number, forMonster = false): number {
    return checkPosition(this, x, y, radius, ANY_HEIGHT, ANY_HEIGHT, forMonster, undefined, undefined, false).ceilingZ;
  }

  /**
   * True if this line is a hard wall regardless of height — no opening to
   * test. `forMonster` additionally treats an `LF.BLOCK_MONSTERS` line as
   * solid — vanilla's own `ML_BLOCKMONSTERS`, a line that fences monsters
   * out of an area (or off a ledge) while leaving the player free to walk
   * through; the player's own movement never passes `forMonster: true`, so
   * this only ever narrows what a monster can cross, never the player.
   */
  isSolidWall(lineIndex: number, forMonster = false): boolean {
    const line = this.map.linedefs[lineIndex];
    if (!line) return true;
    if (line.flags & LF.BLOCKING) return true;
    if (forMonster && line.flags & LF.BLOCK_MONSTERS) return true;
    return line.left === NO_SIDE || line.right === NO_SIDE;
  }

  /**
   * True if this line stops a line of sight through it (game/fogofwar.ts).
   *
   * The test is the vertical opening, what vanilla's `P_CheckSight` keys off —
   * deliberately *not* `isSolidWall`, which is wrong in both directions here
   * (a closed door isn't `BLOCKING`; a window/railing is). docs/fogofwar.md
   * has both cases.
   */
  blocksSight(lineIndex: number): boolean {
    const o = this.sightScratch;
    return !this.openingInto(lineIndex, o) || o.top <= o.bottom;
  }

  thingsOfType(type: number): Thing[] {
    return this.map.things.filter((t) => t.type === type);
  }

  /**
   * Player 1 start (thing type 1); falls back to the map centre.
   *
   * The **last** doomednum-1 thing, not the first — every earlier one is a
   * voodoo doll, and spawning on top of one is a real bug. See docs/wad.md §
   * Player start.
   */
  playerStart(): Placement {
    const starts = this.thingsOfType(ThingType.playerStart);
    const t = starts[starts.length - 1];
    if (t) return { x: t.x, y: t.y, angle: (spawnAngleDeg(t.angle) * Math.PI) / 180 };
    const { minX, minY, maxX, maxY } = this.map.bounds;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, angle: 0 };
  }

  /**
   * Floods a noise outward from the sector at (x, y) through every two-sided
   * line — vanilla's `P_NoiseAlert`/`P_RecursiveSound`. Marked sectors stay
   * marked for the rest of the level (`sector->soundtarget` is never cleared
   * either). See docs/monster-ai.md § Waking up for the propagation rules.
   *
   * The search state is a `(sector, hasCrossedABlockLine)` pair, not just a
   * sector, so one reached first via a sound-blocked path can still be
   * re-entered and propagate further via a later unblocked one — vanilla's
   * `soundtraversed <= soundblocks+1` guard.
   */
  noiseAlert(x: number, y: number): void {
    const start = this.sectorIndexAt(x, y);
    const visited = new Set<number>();
    const stack: number[] = [start * 2];
    while (stack.length > 0) {
      const state = stack.pop()!;
      if (visited.has(state)) continue;
      visited.add(state);
      const sectorIndex = state >> 1;
      const soundBlocked = state & 1;
      const sector = this.map.sectors[sectorIndex];
      if (!sector) continue;
      this.soundAlertedSectors.add(sector);

      for (const { neighbor, lineIndex } of this.sectorNeighbors[sectorIndex] ?? []) {
        const opening = this.openingOf(lineIndex);
        if (!opening || opening.top <= opening.bottom) continue; // closed door: stops sound outright
        if (this.map.linedefs[lineIndex]?.flags & LF.BLOCK_SOUND) {
          if (soundBlocked === 0) stack.push(neighbor * 2 + 1);
        } else {
          stack.push(neighbor * 2 + soundBlocked);
        }
      }
    }
  }

  /** True if a noise (`noiseAlert`) has ever reached this sector this level. */
  isSoundAlerted(sector: Sector): boolean {
    return this.soundAlertedSectors.has(sector);
  }
}

/**
 * A ray whose origin sits essentially *on* a wall (a rocket exploding against
 * one) would otherwise register a self-intersection with it at t≈0 and report
 * every direction blocked. Crossings closer than this to the ray's start are
 * skipped — the near-end counterpart to `WALL_OVERLAP`.
 */
const SELF_HIT_MARGIN = 1;

/** How far apart (map units) to sample sector floor/ceiling along a sightline. */
const SIGHT_HEIGHT_SAMPLE_STEP = 64;

/**
 * Cap on floor/ceiling samples per sightline, whatever its length — the step
 * stretches instead of the count growing. 32 keeps full precision within
 * `WEAPON_RANGE` (2048/64 = 32) so nothing that can end in a monster's shot
 * changes; a player's longer shot never consults this function at all.
 * See docs/world.md § hasLineOfSight.
 */
const SIGHT_MAX_HEIGHT_SAMPLES = 32;

/**
 * True if a straight 3D line between two points is crossed by no
 * sight-blocking line (`World.blocksSight`) **and** keeps an unbroken sight
 * wedge through the floor/ceiling of every sector along the way.
 *
 * The wedge starts from a *fixed eye height* (`player.ts`'s `SIGHT_EYE_HEIGHT`,
 * vanilla's `sightzstart`) rather than interpolating toward `z2` — vanilla's
 * `P_CheckSight` (`sightzstart`/`topslope`/`bottomslope`). Both the fixed
 * origin and the floor/ceiling half are load-bearing, and this is the engine's
 * most performance-sensitive query: docs/world.md § hasLineOfSight covers why,
 * and what keeps it affordable.
 *
 * That constant is read *inside* this body, like every other `player.ts` value
 * in this file: `world.ts` and `player.ts` import from each other, so hoisting
 * one to module scope here hits the cycle's initialization order — "Cannot
 * access 'PLAYER_HEIGHT' before initialization".
 *
 * It opens with `World.sightRejected`, vanilla's own first test. The two
 * subsector arguments are hints for it: a caller that already keeps its
 * subsector (`PosedThing.subsector`) passes it instead of paying a BSP descent
 * to re-derive it, and `-1` means "look it up".
 */
export function hasLineOfSight(
  world: World,
  from: Pos3,
  to: Pos3,
  fromSubsector = -1,
  toSubsector = -1,
): boolean {
  if (world.sightRejected(from, to, fromSubsector, toSubsector)) return false;

  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist === 0) return true;

  const eyeZ = from.z + SIGHT_EYE_HEIGHT;
  let topSlope = (to.z + PLAYER_HEIGHT - eyeZ) / dist;
  let bottomSlope = (to.z - eyeZ) / dist;

  // Walks only the cells the sightline crosses; `linesNear`'s radius query is
  // O(dist²) in cells here — see `World.forEachLineAlongSegment`. A fully
  // blocking line stops the trace outright; an open two-sided one narrows the
  // sight wedge at its real opening, matching `P_SightTraverse` — the reason
  // this exists alongside the periodic sampling below is docs/world.md §
  // hasLineOfSight.
  let blocked = false;
  world.forEachLineAlongSegment(from.x, from.y, to.x, to.y, (i) => {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) return;
    // The two sectors are resolved once here and the blocking test done inline off them, rather
    // than through `blocksSight` — which would resolve the same pair and throw it away, leaving
    // the open branch below to look it up a second time for every line the trace walks.
    const front = world.map.sectors[world.map.sidedefs[line.right]?.sector ?? -1];
    const back = world.map.sectors[world.map.sidedefs[line.left]?.sector ?? -1];
    const openTop = front && back ? Math.min(front.ceilHeight, back.ceilHeight) : 0;
    const openBottom = front && back ? Math.max(front.floorHeight, back.floorHeight) : 0;
    if (line.left === NO_SIDE || line.right === NO_SIDE || !front || !back || openTop <= openBottom) {
      const t = segmentCrossT(from.x, from.y, to.x, to.y, a.x, a.y, b.x, b.y);
      if (t >= 0 && t * dist > SELF_HIT_MARGIN) return (blocked = true);
      return;
    }
    // Two-sided and open. Skip the segment math entirely for a flat
    // pass-through (equal floors and equal ceilings on both sides) — it
    // can't narrow the wedge, and it's most of a level's connective tissue —
    // mirroring `P_SightTraverse`'s own frontsector/backsector inequality
    // guards.
    if (front.floorHeight === back.floorHeight && front.ceilHeight === back.ceilHeight) return;
    const t = segmentCrossT(from.x, from.y, to.x, to.y, a.x, a.y, b.x, b.y);
    if (t < 0 || t * dist <= SELF_HIT_MARGIN) return;
    const crossDist = t * dist;
    const crossBottomSlope = (openBottom - eyeZ) / crossDist;
    const crossTopSlope = (openTop - eyeZ) / crossDist;
    if (crossBottomSlope > bottomSlope) bottomSlope = crossBottomSlope;
    if (crossTopSlope < topSlope) topSlope = crossTopSlope;
    if (topSlope <= bottomSlope) return (blocked = true);
  });
  if (blocked) return false;

  const steps = Math.min(
    SIGHT_MAX_HEIGHT_SAMPLES,
    Math.max(1, Math.ceil(dist / SIGHT_HEIGHT_SAMPLE_STEP)),
  );
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sector = world.sectorAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (!sector) continue;
    const sampleDist = dist * t;
    const floorSlope = (sector.floorHeight - eyeZ) / sampleDist;
    const ceilSlope = (sector.ceilHeight - eyeZ) / sampleDist;
    if (floorSlope > bottomSlope) bottomSlope = floorSlope;
    if (ceilSlope < topSlope) topSlope = ceilSlope;
    if (topSlope <= bottomSlope) return false;
  }
  return true;
}

/**
 * Vanilla's `P_GroupLines` `sec->lines[]`: every linedef bordering a sector,
 * by sector index, in ascending linedef order — the order vanilla itself
 * enumerates a sector's lines in, which several specials react to (see
 * `neighborSectorIndices`). One- and two-sided lines alike; callers keep their
 * own filters.
 *
 * Built once per `DoomMap` and memoized against it. The adjacency is static —
 * nothing at runtime writes `LineDef.left`/`right` or `SideDef.sector`, unlike
 * the sector *heights* every query here reads live — so this is a pure
 * function of the map that happens to be expensive to recompute. Keyed by the
 * map object rather than held on `World` because the load-time scans
 * (`scanSectors`, reached from `mapmesh.ts`) run before any `World`
 * exists. See docs/world.md § Neighbor-height queries.
 */
const sectorLineIndexes = new WeakMap<DoomMap, number[][]>();

function buildSectorLines(map: DoomMap): number[][] {
  const out: number[][] = Array.from({ length: map.sectors.length }, () => []);
  for (let i = 0; i < map.linedefs.length; i++) {
    const line = map.linedefs[i];
    const front = line.right !== NO_SIDE ? map.sidedefs[line.right]?.sector : undefined;
    const back = line.left !== NO_SIDE ? map.sidedefs[line.left]?.sector : undefined;
    if (front !== undefined && out[front]) out[front].push(i);
    // A line whose two sides name the same sector is one of that sector's
    // lines once, not twice — matching `P_GroupLines`' own per-sector count.
    if (back !== undefined && back !== front && out[back]) out[back].push(i);
  }
  return out;
}

const NO_LINES: readonly number[] = [];

/** The linedefs bordering `sectorIndex` — see `sectorLineIndexes`. */
export function sectorLines(map: DoomMap, sectorIndex: number): readonly number[] {
  let index = sectorLineIndexes.get(map);
  if (!index) {
    index = buildSectorLines(map);
    sectorLineIndexes.set(map, index);
  }
  return index[sectorIndex] ?? NO_LINES;
}

/**
 * Sectors and linedefs grouped by tag — vanilla's `P_FindSectorFromLineTag`
 * and `P_FindLineFromLineTag`, which both linear-scan on every call. Ascending
 * index order, matching those scans, since "the first match" is load-bearing
 * for several specials.
 *
 * **Tag 0 is deliberately not indexed.** Every caller already refuses it
 * upstream (`resolveTargets`, `SpecialDef.requiresTag`, vanilla's own
 * `P_CheckTag`), and on a large map most sectors and lines carry it — so
 * indexing it would cost the one bucket nobody reads.
 *
 * Memoized against the `DoomMap` for the same reason `sectorLineIndexes` is,
 * and safe for the same reason: `Sector.tag`/`LineDef.tag` are written once by
 * `loadMap` and never at runtime. See docs/world.md § The tag indexes.
 */
const tagIndexes = new WeakMap<DoomMap, { sectors: Map<number, number[]>; lines: Map<number, number[]> }>();

function buildTagIndex(map: DoomMap): { sectors: Map<number, number[]>; lines: Map<number, number[]> } {
  const sectors = new Map<number, number[]>();
  const lines = new Map<number, number[]>();
  const push = (into: Map<number, number[]>, tag: number, index: number) => {
    if (tag === 0) return;
    const bucket = into.get(tag);
    if (bucket) bucket.push(index);
    else into.set(tag, [index]);
  };
  for (let i = 0; i < map.sectors.length; i++) push(sectors, map.sectors[i].tag, i);
  for (let i = 0; i < map.linedefs.length; i++) push(lines, map.linedefs[i].tag, i);
  return { sectors, lines };
}

function tagIndex(map: DoomMap): { sectors: Map<number, number[]>; lines: Map<number, number[]> } {
  let index = tagIndexes.get(map);
  if (!index) {
    index = buildTagIndex(map);
    tagIndexes.set(map, index);
  }
  return index;
}

const NO_MATCHES: readonly number[] = [];

/** The sectors carrying `tag`, ascending — `P_FindSectorFromLineTag`. See `tagIndexes`. */
export function sectorsByTag(map: DoomMap, tag: number): readonly number[] {
  return tagIndex(map).sectors.get(tag) ?? NO_MATCHES;
}

/** The linedefs carrying `tag`, ascending — `P_FindLineFromLineTag`. See `tagIndexes`. */
export function linesByTag(map: DoomMap, tag: number): readonly number[] {
  return tagIndex(map).lines.get(tag) ?? NO_MATCHES;
}

/** Sectors on the other side of a two-sided line from `sectorIndex`. */
function neighborSectors(map: DoomMap, sectorIndex: number): Sector[] {
  const out: Sector[] = [];
  for (const lineIndex of sectorLines(map, sectorIndex)) {
    const line = map.linedefs[lineIndex];
    if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
    const frontSec = map.sidedefs[line.right]?.sector;
    const backSec = map.sidedefs[line.left]?.sector;
    let neighborIndex: number | undefined;
    if (frontSec === sectorIndex) neighborIndex = backSec;
    else if (backSec === sectorIndex) neighborIndex = frontSec;
    if (neighborIndex === undefined) continue;
    const sec = map.sectors[neighborIndex];
    if (sec) out.push(sec);
  }
  return out;
}

/**
 * Neighbor-height queries a specials mover needs to resolve a target height —
 * vanilla's `P_FindLowestFloorSurrounding` family. The `found` flag (rather
 * than seeding with the sector's own height) is load-bearing; see
 * docs/world.md § Neighbor-height queries.
 */
export function lowestNeighborFloor(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.floorHeight ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.floorHeight < result) result = n.floorHeight;
    found = true;
  }
  return result;
}

export function highestNeighborFloor(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.floorHeight ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.floorHeight > result) result = n.floorHeight;
    found = true;
  }
  return result;
}

export function nextHigherFloor(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  const base = sector?.floorHeight ?? 0;
  let result = base;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (n.floorHeight > base && (!found || n.floorHeight < result)) {
      result = n.floorHeight;
      found = true;
    }
  }
  return result;
}

export function nextLowerFloor(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  const base = sector?.floorHeight ?? 0;
  let result = base;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (n.floorHeight < base && (!found || n.floorHeight > result)) {
      result = n.floorHeight;
      found = true;
    }
  }
  return result;
}

export function lowestNeighborCeiling(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.ceilHeight ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.ceilHeight < result) result = n.ceilHeight;
    found = true;
  }
  return result;
}

export function highestNeighborCeiling(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.ceilHeight ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.ceilHeight > result) result = n.ceilHeight;
    found = true;
  }
  return result;
}

/** Boom `P_FindNextHighestCeiling` — the generalized ceilings' `CtoNnC` with the direction bit up. Same no-candidate fallback shape as `nextHigherFloor`. */
export function nextHigherCeiling(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  const base = sector?.ceilHeight ?? 0;
  let result = base;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (n.ceilHeight > base && (!found || n.ceilHeight < result)) {
      result = n.ceilHeight;
      found = true;
    }
  }
  return result;
}

/** Boom `P_FindNextLowestCeiling` — `CtoNnC` with the direction bit down. */
export function nextLowerCeiling(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  const base = sector?.ceilHeight ?? 0;
  let result = base;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (n.ceilHeight < base && (!found || n.ceilHeight > result)) {
      result = n.ceilHeight;
      found = true;
    }
  }
  return result;
}

/**
 * The "minlight" a blink/glow special dims to: `P_FindMinSurroundingLight`,
 * which vanilla always calls with the sector's own level as its `max` and only
 * ever lowers from there. So a sector whose neighbours are all *brighter* dims
 * to its own level — i.e. not at all — rather than up to the darkest of them.
 */
export function darkestNeighborLight(map: DoomMap, sectorIndex: number): number {
  let result = map.sectors[sectorIndex]?.light ?? 0;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (n.light < result) result = n.light;
  }
  return result;
}

const INFINITE_TALL_STORAGE_KEY = 'topdoom.infiniteTallActors';

/**
 * Whether solid bodies block over their entire vertical extent, vanilla's
 * "infinitely tall actors". Off by default, a deliberate deviation —
 * docs/movement.md § Collision has the rule and its sources. Read by
 * `blockedByThings` and `bodyFloor`, the two functions it changes.
 *
 * Module-level rather than per-`World`, for the reason `getAutorun` is: it is a
 * settings-tab preference that must apply to the level already running, and a
 * `World` is rebuilt every map load.
 */
let infiniteTallActors = globalThis.localStorage?.getItem(INFINITE_TALL_STORAGE_KEY) === 'true';

export function getInfiniteTallActors(): boolean {
  return infiniteTallActors;
}

export function setInfiniteTallActors(enabled: boolean): void {
  infiniteTallActors = enabled;
  globalThis.localStorage?.setItem(INFINITE_TALL_STORAGE_KEY, String(enabled));
}

/**
 * A body (monster or player) that other bodies physically bump into —
 * vanilla's `MF_SOLID` things, tested by `PIT_CheckThing`. Callers pass the
 * set of *other* bodies; nothing here filters out the mover itself.
 *
 * `z`/`height` are the body's own vertical extent, read only while infinite-tall
 * actors is off (`getInfiniteTallActors`) — vanilla compares neither.
 *
 * Every literal of this shape — `blockersFor`'s pool, `solidBodies`,
 * `things.ts`'s hand-built player blocker, the fixtures — writes these five
 * keys **in this order**: the two loops below are hot enough that one site
 * spelled differently would make them polymorphic.
 */
export interface ThingBlocker extends Pos3 {
  radius: number;
  height: number;
}

/**
 * True if a body of `radius` standing at (x, y) overlaps one of `blockers` —
 * vanilla's `PIT_CheckThing` overlap test, an axis-aligned **box** check on
 * the summed radii — the same shape the line tests use, and vanilla's own
 * `PIT_CheckThing` (docs/monster-ai.md § Movement).
 *
 * `from`, when given, is where the mover currently stands: a blocker already
 * overlapped there only refuses the move if it presses further in, which is
 * what lets two touching bodies work free instead of freezing forever
 * (docs/movement.md § Collision). A blocker not yet touched at `from` is
 * unaffected — you still can't walk into a thing you weren't already
 * overlapping.
 *
 * Unless infinite-tall actors is on, the mover's own `z`/`height` span
 * additionally passes a blocker it clears entirely, over or under —
 * docs/movement.md § Collision. A span of `ANY_HEIGHT` at either end has
 * nothing to clear with, so it keeps vanilla's blocking whatever the setting
 * says; one `Number.isFinite` over the sum covers both.
 */
function blockedByThings(
  x: number,
  y: number,
  radius: number,
  z: number,
  height: number,
  blockers: readonly ThingBlocker[] | undefined,
  from?: Pos2,
): boolean {
  if (!blockers) return false;
  const zAware = !infiniteTallActors && Number.isFinite(z + height);
  for (const b of blockers) {
    const reach = radius + b.radius;
    if (Math.abs(b.x - x) >= reach || Math.abs(b.y - y) >= reach) continue;
    if (zAware && (z >= b.z + b.height || z + height <= b.z)) continue;
    if (from && Math.abs(b.x - from.x) < reach && Math.abs(b.y - from.y) < reach) {
      if (Math.hypot(b.x - x, b.y - y) >= Math.hypot(b.x - from.x, b.y - from.y)) continue;
    }
    return true;
  }
  return false;
}

/**
 * The highest solid body a mover of `radius` at (x, y) with its feet at `z` is
 * standing on — `-Infinity` when none is, which is what a caller `Math.max`es
 * against the sector's own `groundFloor`. Always `-Infinity` while infinite-tall
 * actors is on, where a body is a wall rather than a surface.
 *
 * Only a body already below the mover counts (`top <= z`). Vanilla has no
 * equivalent at all, and bodies are ground for the player alone — the rule and
 * why it is shaped this way are docs/movement.md § Vertical physics: stairs,
 * falling, gap-crossing.
 */
export function bodyFloor(
  x: number,
  y: number,
  radius: number,
  z: number,
  blockers: readonly ThingBlocker[] | undefined,
): number {
  if (!blockers || infiniteTallActors) return -Infinity;
  let best = -Infinity;
  for (const b of blockers) {
    const reach = radius + b.radius;
    if (Math.abs(b.x - x) >= reach || Math.abs(b.y - y) >= reach) continue;
    const top = b.z + b.height;
    if (top <= z && top > best) best = top;
  }
  return best;
}

/**
 * Everything one `P_CheckPosition` pass reports about a candidate position: is
 * it refused, and the three heights `PIT_CheckLine` accumulates on the way —
 * `tmfloorz`, `tmceilingz`, `tmdropoffz`.
 *
 * Reused in place rather than returned fresh (see `checkPosition`), so read the
 * fields before the next call.
 */
export interface PositionCheck {
  blocked: boolean;
  floorZ: number;
  ceilingZ: number;
  dropoffZ: number;
  /**
   * The floor under (x, y) alone, before the box walk raises `floorZ` — i.e.
   * `floorAt(x, y)`, off the descent this walk already made. Kept so a caller
   * comparing centre floors (`monsters/ai.ts: dropoffRefuses`) needn't re-descend
   * the BSP at a point this call just resolved.
   */
  centreFloorZ: number;
}

const positionScratch: PositionCheck = { blocked: false, floorZ: 0, ceilingZ: 0, dropoffZ: 0, centreFloorZ: 0 };

/**
 * `P_TryMove`'s three height gates against a `P_LineOpening`, in vanilla's
 * order: too short to stand in at all, too big a step up, or the top too low
 * for this body's own `z`. `zFinite` false (`ANY_HEIGHT`) drops the two
 * feet-relative gates and tests the opening's own height alone.
 *
 * **The one home of this rule.** `checkPosition` decides whether a position is
 * refused and `slideTraverse` decides which wall to slide along; they must
 * agree on what "refused" means, and stating it twice in opposite polarity is
 * exactly how the two drift apart. See docs/movement.md § Collision.
 */
function openingRefuses(openTop: number, openBottom: number, z: number, zFinite: boolean): boolean {
  if (openTop - openBottom < PLAYER_HEIGHT) return true;
  if (!zFinite) return false;
  return openBottom - z > MAX_STEP_UP || openTop - z < PLAYER_HEIGHT;
}

/**
 * One `P_CheckPosition` over the lines a body's box at (x, y) spans, filling
 * `out` with the verdict and all three accumulated heights at once — vanilla
 * accumulates them in a single `PIT_CheckLine` walk, and so does this.
 *
 * `stopOnBlock` returns on the first refusing line, as `P_CheckPosition` does;
 * the heights are then only partly accumulated, which is safe for a caller that
 * wants nothing but the verdict. A caller needing the heights *and* the verdict
 * (`monsters/ai.ts: testStep`, and the dropoff test below) passes `false` and
 * gets both from the same walk.
 *
 * `forMonster` — see `World.isSolidWall`. `dropoffZ` deliberately ignores it: a
 * `BLOCK_MONSTERS` line fences a monster's *movement* but its far side is still
 * real floor, so it must not read as a dropoff.
 *
 * `moverHeight` is the mover's own body height and reaches nothing but
 * `blockedByThings` — the opening gates below measure against `PLAYER_HEIGHT`
 * whoever is asking (`openingRefuses`), and a monster's real height is applied
 * separately by `monsters/ai.ts: testStep`. Pass the real height where the
 * caller has one and `ANY_HEIGHT` where there is no body at all
 * (`groundFloor`); it is unread either way once `z` is `ANY_HEIGHT`.
 */
export function checkPosition(
  world: World,
  x: number,
  y: number,
  radius: number,
  z: number,
  moverHeight: number,
  forMonster: boolean,
  blockers: readonly ThingBlocker[] | undefined,
  from: Pos2 | undefined,
  stopOnBlock: boolean,
  out: PositionCheck = positionScratch,
): PositionCheck {
  // One BSP descent for both heights — `floorAt`/`ceilingAt` would walk it twice.
  const here = world.sectorAt(x, y);
  out.blocked = blockedByThings(x, y, radius, z, moverHeight, blockers, from);
  out.floorZ = here?.floorHeight ?? 0;
  out.ceilingZ = here?.ceilHeight ?? 0;
  out.dropoffZ = out.floorZ;
  out.centreFloorZ = out.floorZ;
  if (out.blocked && stopOnBlock) return out;

  const left = x - radius;
  const right = x + radius;
  const bottom = y - radius;
  const top = y + radius;
  const zFinite = Number.isFinite(z);
  // The `+ 1` is broadphase slop only; `boxOverlapsLine` below is exact.
  for (const i of world.linesNear(x, y, radius + 1)) {
    if (!world.boxOverlapsLine(left, bottom, right, top, i)) continue;
    if (world.boxOnLineSide(left, bottom, right, top, i) !== -1) continue;

    const solid = world.isSolidWall(i, forMonster);
    // A `BLOCK_MONSTERS` line fences a monster's *movement* but its far side is
    // still real floor, hence the second test. Only a monster ever consults
    // `dropoffZ` at all, so everyone else skips the accumulation — the player
    // falls off ledges on purpose (docs/movement.md § Vertical physics).
    if (forMonster && (!solid || !world.isSolidWall(i, false))) {
      const fenced = world.map.linedefs[i];
      const front = world.map.sectors[world.map.sidedefs[fenced.right]?.sector];
      const back = world.map.sectors[world.map.sidedefs[fenced.left]?.sector];
      if (front && back) out.dropoffZ = Math.min(out.dropoffZ, front.floorHeight, back.floorHeight);
    }
    if (solid) {
      out.blocked = true;
      if (stopOnBlock) return out;
      continue;
    }

    // `P_LineOpening` inline: `openingOf` allocates a record, and this is the
    // hottest loop in the engine.
    const line = world.map.linedefs[i];
    const front = world.map.sectors[world.map.sidedefs[line.right]?.sector];
    const back = world.map.sectors[world.map.sidedefs[line.left]?.sector];
    if (!front || !back) {
      out.blocked = true;
      if (stopOnBlock) return out;
      continue;
    }
    const openTop = front.ceilHeight < back.ceilHeight ? front.ceilHeight : back.ceilHeight;
    const openBottom = front.floorHeight > back.floorHeight ? front.floorHeight : back.floorHeight;
    if (openBottom > out.floorZ) out.floorZ = openBottom;
    if (openTop < out.ceilingZ) out.ceilingZ = openTop;
    if (openingRefuses(openTop, openBottom, z, zFinite)) {
      out.blocked = true;
      if (stopOnBlock) return out;
    }
  }
  return out;
}

/**
 * True if a body's collision **box** at (x, y) — half-width `radius`, vanilla's
 * own `mobjinfo.radius` — overlaps any line that blocks it. This is
 * `P_CheckPosition`'s line half, and each line goes through `PIT_CheckLine`'s
 * two gates in vanilla's order: the line's own bounding box, then
 * `boxOnLineSide`. `forMonster` — see `World.isSolidWall`. `blockers` are the
 * other solid bodies in the way (see `ThingBlocker`); omitting them means only
 * geometry blocks.
 *
 * A solid wall is refused on the *same* straddle test as a two-sided opening,
 * not on mere proximity — see docs/movement.md § Collision for why that is what
 * keeps a body from catching on a wall's endpoint.
 *
 * **Geometry and bodies only.** `P_TryMove`'s dropoff rule is not here: it is
 * a monster's alone and lives with the rest of the chase step in
 * `monsters/ai.ts: testStep`, which reads `dropoffZ` off its own
 * `checkPosition` walk (docs/monster-ai.md § The dropoff rule).
 *
 * `from` — see `blockedByThings`: the mover's current position, so a body
 * already touching one of `blockers` can still move away from it.
 */
export function positionBlocked(
  world: World,
  x: number,
  y: number,
  radius: number,
  z: number,
  moverHeight: number,
  forMonster = false,
  blockers?: readonly ThingBlocker[],
  from?: Pos2,
): boolean {
  // The first refusing line is the whole answer, so the walk stops there.
  return checkPosition(world, x, y, radius, z, moverHeight, forMonster, blockers, from, true).blocked;
}

/** How many walls one `slideMove` projects against before giving up — vanilla's own `hitcount == 3`. */
const SLIDE_ATTEMPTS = 3;

/**
 * `P_SlideMove`'s `0x800` fudge, as a fraction of the traced move: it stops the
 * mover a thirty-second of a step short of the wall a trace found, so the
 * position it commits to is reliably clear of that wall rather than exactly on
 * it.
 */
export const SLIDE_FUDGE = 1 / 32;

/**
 * Where a slide trace ran into a wall — vanilla's `bestslidefrac`/`bestslideline`,
 * as the smallest fraction along the traced move and the line that produced it.
 * Module-level and overwritten in place rather than returned: `slideMove` runs
 * three traces per attempt per moving body per tic, and this is the one
 * allocation that would show up.
 */
const slideHit = { frac: Infinity, line: -1 };

/**
 * `PTR_SlideTraverse`: walks one corner's path from (cornerX, cornerY) along
 * (mx, my) and keeps the nearest blocking line along it in `slideHit`. A
 * one-sided line blocks unless the mover already stands behind it; a two-sided
 * one blocks on `openingRefuses`, the same predicate that decides whether a
 * position is refused. `PLAYER_HEIGHT` throughout, since `P_SlideMove` is the
 * player's alone.
 *
 * No sort is needed, and it carries two deliberate deviations from vanilla —
 * one of them the fix for a real dead-stop bug. All three are
 * docs/movement.md § slideMove.
 */
function slideTraverse(
  world: World,
  moverX: number,
  moverY: number,
  cornerX: number,
  cornerY: number,
  mx: number,
  my: number,
  z: number,
): void {
  const zFinite = Number.isFinite(z);
  world.forEachLineAlongSegment(cornerX, cornerY, cornerX + mx, cornerY + my, (i) => {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) return;
    // Intersect before classifying: most lines in a cell the corner path clips
    // are not crossed by it, and the opening lookup is the expensive half.
    const cross = segmentIntersect(cornerX, cornerY, cornerX + mx, cornerY + my, a.x, a.y, b.x, b.y);
    if (!cross || cross.t >= slideHit.frac) return;

    if (line.left === NO_SIDE || line.right === NO_SIDE) {
      // Vanilla's "don't hit the back side": behind a one-sided line is void.
      if (world.pointOnLineSide(moverX, moverY, i) === 1) return;
    } else if (!(line.flags & LF.BLOCKING)) {
      const front = world.map.sectors[world.map.sidedefs[line.right]?.sector];
      const back = world.map.sectors[world.map.sidedefs[line.left]?.sector];
      if (!front || !back) return;
      const openTop = front.ceilHeight < back.ceilHeight ? front.ceilHeight : back.ceilHeight;
      const openBottom = front.floorHeight > back.floorHeight ? front.floorHeight : back.floorHeight;
      if (!openingRefuses(openTop, openBottom, z, zFinite)) return;
    }
    slideHit.frac = cross.t;
    slideHit.line = i;
  });
}

/**
 * Moves a body's collision box by (dx, dy), sliding along whatever it runs into,
 * and returns the position actually reached — vanilla's `P_SlideMove`
 * (`p_map.c`), which is the player's alone: a monster gets `P_Move`'s
 * all-or-nothing step instead (`game/monsters/ai.ts`).
 *
 * Three of the box's four corners are traced to find the nearest wall, the move
 * commits to just short of it, and the remainder is projected onto that wall's
 * own direction and retried, `SLIDE_ATTEMPTS` walls deep. When no trace finds a
 * wall — which includes a solid *body* refusing the move, since a thing produces
 * no line intercept — it falls to vanilla's `stairstep`: one axis at a time, Y
 * before X. See docs/movement.md § slideMove.
 */
export function slideMove(
  world: World,
  from: Pos3,
  dx: number,
  dy: number,
  radius: number,
  blockers?: readonly ThingBlocker[],
): Pos2 {
  const z = from.z;
  let curX = from.x;
  let curY = from.y;
  let mx = dx;
  let my = dy;

  // `from` stays the *original* position for every probe, so a body that began
  // the tic already overlapping another can still work free of it
  // (`blockedByThings`) without a multi-attempt slide creeping further in.
  const free = (x: number, y: number): boolean =>
    !positionBlocked(world, x, y, radius, z, PLAYER_HEIGHT, false, blockers, from);

  // `P_XYMovement` only reaches `P_SlideMove` once the whole move is refused.
  if (free(curX + mx, curY + my)) return { x: curX + mx, y: curY + my };

  for (let attempt = 0; attempt < SLIDE_ATTEMPTS; attempt++) {
    // Vanilla traces the leading corner and the two beside it, never the
    // trailing one. A zero component takes the same branch a negative one does.
    const leadX = mx > 0 ? curX + radius : curX - radius;
    const trailX = mx > 0 ? curX - radius : curX + radius;
    const leadY = my > 0 ? curY + radius : curY - radius;
    const trailY = my > 0 ? curY - radius : curY + radius;

    slideHit.frac = Infinity;
    slideHit.line = -1;
    slideTraverse(world, curX, curY, leadX, leadY, mx, my, z);
    slideTraverse(world, curX, curY, trailX, leadY, mx, my, z);
    slideTraverse(world, curX, curY, leadX, trailY, mx, my, z);

    if (slideHit.line < 0) break;

    const frac = slideHit.frac - SLIDE_FUDGE;
    if (frac > 0) {
      const nx = curX + mx * frac;
      const ny = curY + my * frac;
      if (!free(nx, ny)) break;
      curX = nx;
      curY = ny;
    }

    // Vanilla clamps the remainder to FRACUNIT here; `segmentIntersect` already
    // bounds the fraction to [0, 1], so the clamp cannot fire.
    const rest = 1 - slideHit.frac;
    if (rest <= 0) return { x: curX, y: curY };

    // `P_HitSlideLine`: what is left of the move projected onto the wall's own
    // direction, so the along-wall component survives and the into-wall one is
    // gone. Vanilla's angle arithmetic and its `P_AproxDistance` reduce to
    // exactly this projection, without that function's ~12% magnitude error.
    const ldx = world.lineDX[slideHit.line];
    const ldy = world.lineDY[slideHit.line];
    const lenSq = ldx * ldx + ldy * ldy;
    if (lenSq === 0) break;
    const along = (rest * (mx * ldx + my * ldy)) / lenSq;
    mx = ldx * along;
    my = ldy * along;

    if (free(curX + mx, curY + my)) return { x: curX + mx, y: curY + my };
  }

  // `stairstep`. X is tried only if Y was refused, exactly as vanilla nests it;
  // with `my` zero the Y attempt is the mover's own position and succeeds, which
  // is why a purely lateral move stopped by a body does not fall through to X.
  if (free(curX, curY + my)) return { x: curX, y: curY + my };
  if (free(curX + mx, curY)) return { x: curX + mx, y: curY };
  return { x: curX, y: curY };
}

/** Vanilla's `MISSILERANGE` (`32*64`), what every *monster* hitscan attack passes to `P_LineAttack`. */
export const WEAPON_RANGE = 2048;

/**
 * What a **player's** free hitscan is bounded by instead. ZDoom's
 * `PLAYERMISSILERANGE` (`p_local.h`, `A_FireBullets`'s `range` default), not
 * vanilla's shared `MISSILERANGE` — the one place this engine follows ZDoom
 * over `linuxdoom-1.10`, for the reason recorded in docs/combat.md § Range.
 */
export const PLAYER_WEAPON_RANGE = 8192;

/**
 * How far one of the *player's* shots flies. A locked-on shot ends at its
 * target (`undefined` lets `shotPath` stop there); a free one needs its own
 * bound, and neither kind takes `shotPath`'s `WEAPON_RANGE` default — that is a
 * *monster's* bullet. A missile crosses the whole map, a bullet reaches
 * `PLAYER_WEAPON_RANGE`. See docs/combat.md § Range.
 */
export function playerShotRange(
  kind: 'hitscan' | 'projectile',
  target: Pos3 | null,
  mapSpan: number,
): number | undefined {
  if (target !== null) return undefined;
  return kind === 'projectile' ? mapSpan : PLAYER_WEAPON_RANGE;
}

/**
 * True if this line stops a shot passing through it at height `z` — wherever
 * *this* shot's (possibly sloped) line is when it crosses, not one height for
 * the whole flight. The **single-ray** form, for a shot whose slope is already
 * fixed; a locked-on shot gets `shotPath`'s wedge instead.
 *
 * Deliberately **not** `isSolidWall` — `PTR_ShootTraverse` never reads
 * `ML_BLOCKING`, so a shot passes through bars it can't walk through. See
 * docs/combat.md § shotPath.
 */
function blocksShot(world: World, lineIndex: number, z: number): boolean {
  const line = world.map.linedefs[lineIndex];
  if (!line || line.left === NO_SIDE || line.right === NO_SIDE) return true;
  const opening = world.openingOf(lineIndex);
  if (!opening || opening.top <= opening.bottom) return true;
  return z < opening.bottom || z > opening.top;
}

/**
 * The lock a player's shot was fired under: the target's own body for the wedge
 * to start from, and this pellet's jitter. Passing one is what puts `shotPath`
 * on its locked-on branch at all. See docs/combat.md § shotPath.
 */
export interface ShotLock {
  /** Half the target's real `mobjinfo.height` (`MonsterRef.height`); `target.z` is its centre. */
  halfHeight: number;
  /** `A_FireShotgun2`'s per-pellet `bulletslope + ((P_Random()-P_Random())<<5)`, added after the wedge clamps. */
  slopeOffset: number;
}

/**
 * Where one frame of a *curving* projectile's flight ran into geometry, or
 * null if the step is clear — the per-step counterpart to `shotPath`'s single
 * launch-time trace, for the one projectile whose path isn't straight and so
 * can't have its stopping point resolved up front: the revenant's homing
 * missile (`game/projectiles.ts: advanceHoming`, docs/monster-attacks.md § The
 * revenant's homing missile).
 *
 * Blocking is `blocksShot` at the height the step is at where it crosses each
 * line. A crossing within `SELF_HIT_MARGIN` of the step's start is skipped for
 * the reason `hasLineOfSight` skips one: a missile that just passed through an
 * opening starts the next step sitting essentially on it.
 */
export function projectileStepBlocker(
  world: World,
  from: Pos3,
  to: Pos3,
): { x: number; y: number; z: number; lineIndex: number } | null {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist === 0) return null;
  let nearestT = Infinity;
  let hitLine = -1;
  world.forEachLineAlongSegment(from.x, from.y, to.x, to.y, (i) => {
    const e = i * 4;
    const ends = world.lineOverlapEnds;
    const t = segmentCrossT(from.x, from.y, to.x, to.y, ends[e], ends[e + 1], ends[e + 2], ends[e + 3]);
    if (t < 0 || t >= nearestT || t * dist <= SELF_HIT_MARGIN) return;
    if (!blocksShot(world, i, from.z + (to.z - from.z) * t)) return;
    nearestT = t;
    hitLine = i;
  });
  if (hitLine < 0) return null;
  return {
    x: from.x + (to.x - from.x) * nearestT,
    y: from.y + (to.y - from.y) * nearestT,
    z: from.z + (to.z - from.z) * nearestT,
    lineIndex: hitLine,
  };
}

/** Where a shot actually ends up: the point it stopped at, the height it was at there, and how far that was. */
export interface ShotPath extends Pos3 {
  dist: number;
  /** The line that actually stopped it short (a wall, a shut door), or null if it ran out its range unobstructed — the shoot-triggered specials (`game/specials.ts: triggerShot`) key off this. */
  lineIndex: number | null;
}

/**
 * Traces a shot fired from `origin` along `angleRad` and returns where it ends
 * up, stopped at the nearest line that blocks it. Used both for a hitscan
 * weapon's tracer endpoint and for how far a projectile may fly
 * (game/weapons.ts, game.ts).
 *
 * `target` supplies the **slope** — the trace rises or falls from `origin.z`
 * toward the target's height, and the origin stays the shooter's own height so
 * a rendered tracer never starts mid-air. With no target the shot is flat.
 *
 * `range` is how far it flies, and is deliberately **separate from the aim**:
 * it defaults to stopping *at* the target (a player's locked-on shot, whose
 * target can't move mid-flight) but a caller can pass its own, because a shot
 * keeps going down the aimed slope whether or not the target is still there. A
 * monster's bullet passes `WEAPON_RANGE` (`P_LineAttack`'s `MISSILERANGE`), a
 * player's free bullet the longer `PLAYER_WEAPON_RANGE`, and a missile — which
 * has no range budget in vanilla at all — `World.mapSpan`. See docs/combat.md
 * § Range and docs/monster-attacks.md § Hitscan vs. projectile.
 *
 * **A `lock` switches blocking** from `blocksShot`'s single fixed ray to a
 * **slope wedge**, vanilla's `P_AimLineAttack` — the auto-aim leniency — and
 * re-aims the shot at the wedge it cleared (`PTR_AimTraverse`'s `aimslope`), so
 * the slope fired is one the geometry admits. A monster's own fired shot passes
 * none: it needs `target` to aim, but has no "you clicked it" promise to honor.
 * See docs/combat.md § shotPath.
 */
export function shotPath(
  world: World,
  origin: Pos3,
  angleRad: number,
  target: Pos3 | null = null,
  range?: number,
  lock: ShotLock | null = null,
): ShotPath {
  const { x, y, z } = origin;
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  const toTarget = target ? Math.hypot(target.x - x, target.y - y) : 0;
  const maxRange = range ?? (target ? toTarget : WEAPON_RANGE);
  // Held for the whole trace, so a `range` past the target keeps climbing or
  // falling at the rate the aim set — `P_LineAttack`'s `slope`, `momz`. The
  // locked-on branch below may re-aim it within the wedge it cleared.
  const slope = target && toTarget > 0 ? (target.z - z) / toTarget : 0;
  let aimSlope = slope;
  const tx = x + dx * maxRange;
  const ty = y + dy * maxRange;
  let nearestT = 1;
  let blockingLine: number | null = null;

  /** This line's crossing point along the shot, or null — off `World.lineOverlapEnds`, which carries the corner-leak extension documented on `WALL_OVERLAP`. */
  const crossingT = (i: number): number | null => {
    const e = i * 4;
    const ends = world.lineOverlapEnds;
    const t = segmentCrossT(x, y, tx, ty, ends[e], ends[e + 1], ends[e + 2], ends[e + 3]);
    return t < 0 ? null : t;
  };

  if (!lock) {
    // Walked along the trace, not gathered from a radius box around its start:
    // a missile's `range` is the whole map (see `World.mapSpan`), and
    // `linesNear` is O(range²) in cells for what is one thin line.
    world.forEachLineAlongSegment(x, y, tx, ty, (i) => {
      const t = crossingT(i);
      if (t === null || t >= nearestT) return;
      if (blocksShot(world, i, z + slope * maxRange * t)) {
        nearestT = t;
        blockingLine = i;
      }
    });
  } else {
    // Vanilla's P_AimLineAttack wedge — see this function's doc. Crossings have
    // to be walked nearest-first for the narrowing to mean anything, so unlike
    // the single-ray branch above (which can early-out on `nearestT` in any
    // order) this one collects and sorts first.
    const crossings: { t: number; i: number }[] = [];
    world.forEachLineAlongSegment(x, y, tx, ty, (i) => {
      const t = crossingT(i);
      if (t !== null) crossings.push({ t, i });
    });
    crossings.sort((p, q) => p.t - q.t);

    // The target's own silhouette, `PTR_AimTraverse`'s
    // `thingtopslope`/`thingbottomslope` — `target.z` is the body's centre, so
    // the pair spans `[z, z + height]`.
    let bottomSlope = slope - lock.halfHeight / maxRange;
    let topSlope = slope + lock.halfHeight / maxRange;
    for (const { t, i } of crossings) {
      const line = world.map.linedefs[i];
      // A genuinely solid wall or a shut door stops any shot outright, the
      // same two cases `blocksShot` leads with.
      if (line.left === NO_SIDE || line.right === NO_SIDE) {
        nearestT = t;
        blockingLine = i;
        break;
      }
      const opening = world.openingOf(i);
      if (!opening || opening.top <= opening.bottom) {
        nearestT = t;
        blockingLine = i;
        break;
      }
      const d = maxRange * t;
      if (d <= 0) continue; // a line the shot starts on contributes no constraint
      const bottom = (opening.bottom - z) / d;
      const topOfGap = (opening.top - z) / d;
      if (bottom > bottomSlope) bottomSlope = bottom;
      if (topOfGap < topSlope) topSlope = topOfGap;
      if (topSlope <= bottomSlope) {
        nearestT = t;
        blockingLine = i;
        break;
      }
    }
    // `PTR_AimTraverse`'s `aimslope`, the middle of what survived, plus the
    // pellet's own jitter — docs/combat.md § shotPath for why the shot is aimed
    // at the wedge rather than at the target, and why the jitter comes after. A
    // collapsed wedge keeps the raw slope: the shot stops at that line anyway.
    aimSlope = (topSlope > bottomSlope ? (bottomSlope + topSlope) / 2 : slope) + lock.slopeOffset;
  }

  const dist = maxRange * nearestT;
  return { x: x + dx * dist, y: y + dy * dist, z: z + aimSlope * dist, dist, lineIndex: blockingLine };
}
