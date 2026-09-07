/**
 * `LightCells`: the index space the dynamic-light lists are kept in — one cell per BSP leaf, and a
 * grid of them across a leaf too big for one, so a fragment on a huge open floor walks only the
 * lights near it. What `aLightCell` indexes and `DynamicLights.commit` fills. See docs/lights.md
 * § Light cells.
 */
import { polygonBounds, type PolygonBounds } from '../../util/geom.ts';
import type { SectorPoly } from '../bsp.ts';

/**
 * Edge of a sub-cell, in map units. Measured on NUTS.WAD MAP01 with the monsters awake: its arena
 * leaf is 12000 units across, and at 256 a floor fragment walks the lights within about 400 units
 * of it rather than the 16 nearest the camera the whole leaf could hold. Smaller costs cells per
 * light in `commit` and texels in the visibility texture for little more per fragment.
 */
export const LIGHT_CELL_SIZE = 256;

/**
 * How far a surface filed under a cell may reach past the point it was filed by — half a wall
 * chunk (`mapmesh.ts`'s `WALL_CHUNK_LEN`, 128) and half the diagonal of the grid square a flat
 * cell is diced out of (`mapmesh.ts`'s `FLAT_CELL_EXTENT`), both 64, plus a unit so a dice cell's
 * own rounding never tips it over. A
 * light is listed in every cell within `radius + this` of it, so nothing filed under a cell can
 * be lit by a light the cell does not list; `tests/render/lightcells.test.ts` holds the two
 * against it. A surface wider than this is filed under its leaf's catch-all cell instead
 * (`cellFor`).
 */
export const LIGHT_CELL_MARGIN = 65;

/** One layout per polygon set: `mapmesh.ts` files surfaces and `lights/vis.ts` fills lists by it. */
const layouts = new WeakMap<readonly SectorPoly[], LightCells>();

export function lightCellsOf(polys: readonly SectorPoly[]): LightCells {
  let hit = layouts.get(polys);
  if (!hit) {
    hit = new LightCells(polys);
    layouts.set(polys, hit);
  }
  return hit;
}

export class LightCells {
  /** How many cells the level has: the texel count of the visibility texture. */
  readonly cellCount: number;
  /**
   * Per leaf, its first cell. A leaf that fits one cell has only that one; a split leaf's first
   * cell is its catch-all, followed by `cols * rows` sub-cells row by row from its south-west
   * corner.
   */
  private start: Int32Array;
  private cols: Int32Array;
  private rows: Int32Array;
  private minX: Float64Array;
  private minY: Float64Array;

  constructor(polys: readonly SectorPoly[]) {
    const n = polys.length;
    this.start = new Int32Array(n + 1);
    this.cols = new Int32Array(n);
    this.rows = new Int32Array(n);
    this.minX = new Float64Array(n);
    this.minY = new Float64Array(n);
    let next = 0;
    const box: PolygonBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    for (let i = 0; i < n; i++) {
      const pts = polys[i].points;
      polygonBounds(pts, box);
      const cols = pts.length < 6 ? 1 : Math.max(1, Math.ceil((box.maxX - box.minX) / LIGHT_CELL_SIZE));
      const rows = pts.length < 6 ? 1 : Math.max(1, Math.ceil((box.maxY - box.minY) / LIGHT_CELL_SIZE));
      this.start[i] = next;
      this.minX[i] = box.minX;
      this.minY[i] = box.minY;
      if (cols * rows > 1) {
        this.cols[i] = cols;
        this.rows[i] = rows;
        next += 1 + cols * rows;
      } else {
        this.cols[i] = 0;
        this.rows[i] = 0;
        next += 1;
      }
    }
    this.start[n] = next;
    this.cellCount = next;
  }

  /**
   * Whether the leaf is gridded at all; false for one that fits a single cell. Derived state with
   * no reader in `src/` — `tests/render/lightcells.test.ts` is what asks, since every assertion
   * about a sub-cell needs the leaf under it to have been split at all.
   */
  isSplit(leaf: number): boolean {
    return this.cols[leaf] > 0;
  }

  /** The leaf's whole-leaf cell: its only one, or a split leaf's catch-all. */
  wholeCell(leaf: number): number {
    return this.start[leaf];
  }

  /** The cell a point of the leaf falls in, clamped onto the grid for one on its boundary. */
  cellOf(leaf: number, x: number, y: number): number {
    const cols = this.cols[leaf];
    if (cols === 0) return this.start[leaf];
    const col = clampIndex((x - this.minX[leaf]) / LIGHT_CELL_SIZE, cols);
    const row = clampIndex((y - this.minY[leaf]) / LIGHT_CELL_SIZE, this.rows[leaf]);
    return this.start[leaf] + 1 + row * cols + col;
  }

  /**
   * The cell a surface is filed under: the one its anchor (`x`, `y`) falls in where every point of
   * it lies within `extent` of that anchor, the catch-all otherwise. `extent` past
   * `LIGHT_CELL_MARGIN` is what a sub-cell's list cannot vouch for.
   */
  cellFor(leaf: number, x: number, y: number, extent: number): number {
    if (extent > LIGHT_CELL_MARGIN) return this.start[leaf];
    return this.cellOf(leaf, x, y);
  }

  /**
   * Appends to `out` every cell of the leaf a light's box touches: the catch-all, and on a split
   * leaf each sub-cell overlapping `[minX, maxX] x [minY, maxY]`.
   */
  cellsWithin(leaf: number, minX: number, minY: number, maxX: number, maxY: number, out: number[]): void {
    const first = this.start[leaf];
    out.push(first);
    const cols = this.cols[leaf];
    if (cols === 0) return;
    const rows = this.rows[leaf];
    const c0 = clampIndex((minX - this.minX[leaf]) / LIGHT_CELL_SIZE, cols);
    const c1 = clampIndex((maxX - this.minX[leaf]) / LIGHT_CELL_SIZE, cols);
    const r0 = clampIndex((minY - this.minY[leaf]) / LIGHT_CELL_SIZE, rows);
    const r1 = clampIndex((maxY - this.minY[leaf]) / LIGHT_CELL_SIZE, rows);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) out.push(first + 1 + r * cols + c);
    }
  }
}

/** `Math.floor(v)` held inside `[0, count)`. */
function clampIndex(v: number, count: number): number {
  const i = Math.floor(v);
  return i < 0 ? 0 : i >= count ? count - 1 : i;
}
