/**
 * Answers "which sector is this point in" and "could this piece be that sector's floor"
 * straight from the linedefs, the way a mapper would, without consulting the BSP — the
 * tree is what `bsp.ts` is rebuilding when it asks, so it cannot be the authority.
 * See docs/render-bsp.md § Walls that stop inside their cell.
 */
import { NO_SIDE, type DoomMap } from '../wad/map.ts';
import { distSqToSegment } from '../util/geom.ts';

/**
 * Whether both sidedefs of this linedef face the same sector — the Boom-era
 * self-referencing-sector trick (hidden monster closets, invisible lifts).
 * docs/render-bsp.md § Self-referencing sectors.
 */
export function selfReferencing(map: DoomMap, lineIndex: number): boolean {
  const line = map.linedefs[lineIndex];
  if (!line || line.right === NO_SIDE || line.left === NO_SIDE) return false;
  const right = map.sidedefs[line.right];
  const left = map.sidedefs[line.left];
  return right !== undefined && left !== undefined && right.sector === left.sector;
}

/**
 * Side of the bucket grid the linedefs are binned into, in map units. Measured over the committed
 * WADs, not guessed: below this the empty bucket per cell costs more than the lines it saves
 * scanning.
 */
const GRID_CELL = 256;

/**
 * The map's linedefs bucketed on a coarse grid, so a point query scans a
 * neighbourhood instead of the level, with the fields the queries read hoisted
 * out of the WAD records — the inner loop runs a few hundred times per probe, so
 * chasing `linedefs -> vertexes -> sidedefs` per candidate is most of its cost.
 * Build it lazily: a map with neither a wall stub inside a leaf nor a
 * self-referencing sector never asks it anything.
 */
export class SectorProbe {
  private cols: number;
  private rows: number;
  private minX: number;
  private minY: number;
  private buckets: number[][];
  /** Endpoints of every bucketed linedef, and the sector each of its sides faces (-1 for none). */
  private ax: Float64Array;
  private ay: Float64Array;
  private bx: Float64Array;
  private by: Float64Array;
  private rightSector: Int32Array;
  private leftSector: Int32Array;
  private selfRef: Uint8Array;
  /** Each sector's own extent, over the vertexes of every linedef that faces it. */
  private sectorMinX: Float64Array;
  private sectorMinY: Float64Array;
  private sectorMaxX: Float64Array;
  private sectorMaxY: Float64Array;

  constructor(map: DoomMap) {
    const { bounds } = map;
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / GRID_CELL) + 1);
    this.rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / GRID_CELL) + 1);
    this.minX = bounds.minX;
    this.minY = bounds.minY;
    this.buckets = [];
    for (let i = 0; i < this.cols * this.rows; i++) this.buckets.push([]);

    const lines = map.linedefs.length;
    this.ax = new Float64Array(lines);
    this.ay = new Float64Array(lines);
    this.bx = new Float64Array(lines);
    this.by = new Float64Array(lines);
    this.rightSector = new Int32Array(lines).fill(-1);
    this.leftSector = new Int32Array(lines).fill(-1);
    this.selfRef = new Uint8Array(lines);

    const sectors = map.sectors.length;
    this.sectorMinX = new Float64Array(sectors).fill(Infinity);
    this.sectorMinY = new Float64Array(sectors).fill(Infinity);
    this.sectorMaxX = new Float64Array(sectors).fill(-Infinity);
    this.sectorMaxY = new Float64Array(sectors).fill(-Infinity);

    for (const [i, line] of map.linedefs.entries()) {
      const a = map.vertexes[line.v1];
      const b = map.vertexes[line.v2];
      if (!a || !b) continue;
      this.ax[i] = a.x;
      this.ay[i] = a.y;
      this.bx[i] = b.x;
      this.by[i] = b.y;
      this.selfRef[i] = selfReferencing(map, i) ? 1 : 0;

      if (line.right !== NO_SIDE) this.rightSector[i] = map.sidedefs[line.right]?.sector ?? -1;
      if (line.left !== NO_SIDE) this.leftSector[i] = map.sidedefs[line.left]?.sector ?? -1;
      for (const s of [this.rightSector[i], this.leftSector[i]]) {
        if (s < 0 || s >= sectors) continue;
        this.sectorMinX[s] = Math.min(this.sectorMinX[s], a.x, b.x);
        this.sectorMaxX[s] = Math.max(this.sectorMaxX[s], a.x, b.x);
        this.sectorMinY[s] = Math.min(this.sectorMinY[s], a.y, b.y);
        this.sectorMaxY[s] = Math.max(this.sectorMaxY[s], a.y, b.y);
      }

      const cx0 = this.clampCol((Math.min(a.x, b.x) - bounds.minX) / GRID_CELL);
      const cx1 = this.clampCol((Math.max(a.x, b.x) - bounds.minX) / GRID_CELL);
      const cy0 = this.clampRow((Math.min(a.y, b.y) - bounds.minY) / GRID_CELL);
      const cy1 = this.clampRow((Math.max(a.y, b.y) - bounds.minY) / GRID_CELL);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) this.buckets[cy * this.cols + cx].push(i);
      }
    }
  }

  /**
   * Which sector a point is in, or -1 for void — the nearest linedef decides,
   * by which side of it the point falls on. Rings of grid cells are scanned
   * outwards until one can no longer reach closer than the best line in hand.
   * `ignoreSelfRef` skips self-referencing lines, for asking which sector
   * *encloses* such a construct rather than landing back on the construct.
   */
  sectorIndexAt(x: number, y: number, ignoreSelfRef = false): number {
    let bestDistSq = Infinity;
    let bestLine = -1;
    let bestSide = 0;
    const cx = Math.floor((x - this.minX) / GRID_CELL);
    const cy = Math.floor((y - this.minY) / GRID_CELL);
    const maxRing = Math.max(this.cols, this.rows);
    for (let ring = 0; ring < maxRing; ring++) {
      const reach = (ring - 1) * GRID_CELL;
      if (bestLine >= 0 && bestDistSq <= reach * reach) break;
      for (let gy = cy - ring; gy <= cy + ring; gy++) {
        if (gy < 0 || gy >= this.rows) continue;
        const edgeRow = gy === cy - ring || gy === cy + ring;
        for (let gx = cx - ring; gx <= cx + ring; gx++) {
          if (gx < 0 || gx >= this.cols) continue;
          // Only the ring's own edge; the inside was covered by earlier rings.
          if (!edgeRow && gx !== cx - ring && gx !== cx + ring) continue;
          for (const i of this.buckets[gy * this.cols + gx]) {
            if (ignoreSelfRef && this.selfRef[i]) continue;
            const ax = this.ax[i];
            const ay = this.ay[i];
            const dx = this.bx[i] - ax;
            const dy = this.by[i] - ay;
            if (dx === 0 && dy === 0) continue;
            const distSq = distSqToSegment(x, y, ax, ay, this.bx[i], this.by[i]);
            if (distSq >= bestDistSq) continue;
            bestDistSq = distSq;
            bestLine = i;
            bestSide = dx * (y - ay) - dy * (x - ax);
          }
        }
      }
    }
    if (bestLine < 0) return -1;
    return bestSide > 0 ? this.leftSector[bestLine] : this.rightSector[bestLine];
  }

  /**
   * Whether every corner of `poly` could be inside `sector`, its extent padded
   * by `pad` — the widest slack a seg clip is ever given, so this can never cut
   * into the overshoot those tolerances deliberately leave behind.
   */
  withinSector(sector: number, poly: number[], pad: number): boolean {
    if (sector < 0 || sector >= this.sectorMinX.length) return false;
    for (let i = 0; i < poly.length; i += 2) {
      const x = poly[i];
      const y = poly[i + 1];
      if (x < this.sectorMinX[sector] - pad || x > this.sectorMaxX[sector] + pad) return false;
      if (y < this.sectorMinY[sector] - pad || y > this.sectorMaxY[sector] + pad) return false;
    }
    return true;
  }

  private clampCol(v: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor(v)));
  }

  private clampRow(v: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor(v)));
  }
}
