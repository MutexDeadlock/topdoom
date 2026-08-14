import { LF, NO_SIDE, SUBSECTOR_BIT } from '../../src/wad/map.ts';
import type {
  DoomMap,
  LineDef,
  Node,
  Sector,
  Seg,
  SideDef,
  SubSector,
  Thing,
  Vertex,
} from '../../src/wad/map.ts';
import type { Pos2 } from '../../src/types.ts';

/**
 * Builds a real `DoomMap` out of ASCII art, so a test can state its geometry in
 * two lines instead of hand-numbering vertexes. Every cell of the grid is its
 * own sector *and* its own subsector, and walls are zero-height sectors rather
 * than void — see docs/testing.md § The grid fixture for why, and for the
 * winding and partition conventions the code below depends on.
 */

/** Floor/ceiling heights one grid glyph stands for. */
export interface CellHeights {
  floor: number;
  ceil: number;
}

export interface GridMapOptions {
  name?: string;
  /**
   * Map units per grid cell. Must exceed any single move a test makes plus the
   * mover's radius: `positionBlocked` only consults lines its *destination*
   * box touches, so a long enough step lands clean inside the next cell and
   * reports free. That is the engine's real behaviour (vanilla `P_TryMove` has
   * it too), not a fixture artifact — but it is easy to trip over by accident.
   * See docs/testing.md § Cell size and tunnelling.
   */
  cell?: number;
  /** Extra or overridden glyph heights, merged over the defaults. */
  heights?: Record<string, CellHeights>;
  /** Glyphs whose adjacent linedefs also carry `LF.BLOCKING`. Default `'#'`. */
  solidGlyphs?: string;
  things?: Thing[];
  /** A REJECT matrix for the finished map — one bit per ordered sector pair, as `loadMap` would hand one over. */
  reject?: Uint8Array;
}

/**
 * `.` open floor, `#` solid wall, `+` shut door. `#` and `+` are both
 * zero-opening; they differ only in `LF.BLOCKING`, which is exactly the
 * `isSolidWall`-vs-`blocksSight` divergence docs/fogofwar.md documents.
 */
const DEFAULT_HEIGHTS: Record<string, CellHeights> = {
  '.': { floor: 0, ceil: 128 },
  '#': { floor: 0, ceil: 0 },
  '+': { floor: 0, ceil: 0 },
};

export interface GridMap {
  map: DoomMap;
  cell: number;
  cols: number;
  rows: number;
  /** Centre of a cell in DOOM coordinates. Row 0 is the *top* row, i.e. highest y. */
  centre(col: number, row: number): Pos2;
  /** Sector index of a cell — the same number as its subsector index. */
  index(col: number, row: number): number;
}

export function gridMap(art: readonly string[], options: GridMapOptions = {}): GridMap {
  const cell = options.cell ?? 128;
  const heights = { ...DEFAULT_HEIGHTS, ...options.heights };
  const solid = new Set((options.solidGlyphs ?? '#').split(''));
  const rows = art.length;
  const cols = art[0]?.length ?? 0;
  if (rows === 0 || cols === 0) throw new Error('gridMap: empty art');
  for (const row of art) {
    if (row.length !== cols) throw new Error(`gridMap: ragged art, expected ${cols} columns`);
  }

  const glyph = (c: number, r: number): string | null =>
    c < 0 || r < 0 || c >= cols || r >= rows ? null : art[r][c];
  const index = (c: number, r: number): number => r * cols + c;
  /** Grid corner (ci, ri) -> vertex index. `ri` counts *down* from the top, like `art`. */
  const pt = (ci: number, ri: number): number => ri * (cols + 1) + ci;

  const vertexes: Vertex[] = [];
  for (let ri = 0; ri <= rows; ri++) {
    for (let ci = 0; ci <= cols; ci++) vertexes.push({ x: ci * cell, y: (rows - ri) * cell });
  }

  const sectors: Sector[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = heights[art[r][c]];
      if (!h) throw new Error(`gridMap: no heights for glyph ${JSON.stringify(art[r][c])}`);
      sectors.push({
        floorHeight: h.floor,
        ceilHeight: h.ceil,
        floorTex: 'FLOOR0_1',
        ceilTex: 'CEIL1_1',
        light: 160,
        special: 0,
        tag: 0,
      });
    }
  }

  const sidedefs: SideDef[] = [];
  const linedefs: LineDef[] = [];
  /** Edge key -> the linedef built for it, so the segs can pick up its direction. */
  const edges = new Map<string, { line: number; v1: number }>();

  const side = (sector: number): number =>
    sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector }) - 1;

  const flagsFor = (a: string | null, b: string | null): number =>
    a === null || b === null
      ? LF.BLOCKING
      : LF.TWO_SIDED | (solid.has(a) || solid.has(b) ? LF.BLOCKING : 0);

  const line = (
    key: string,
    v1: number,
    v2: number,
    right: number,
    left: number | null,
    flags: number,
  ): void => {
    linedefs.push({
      v1,
      v2,
      flags,
      special: 0,
      tag: 0,
      right: side(right),
      left: left === null ? NO_SIDE : side(left),
    });
    edges.set(key, { line: linedefs.length - 1, v1 });
  };

  // Vertical edges. The west cell lies to the right of a line running -Y, so an
  // edge with a west neighbour is wound that way and the east cell takes `left`.
  for (let ci = 0; ci <= cols; ci++) {
    for (let r = 0; r < rows; r++) {
      const w = glyph(ci - 1, r);
      const e = glyph(ci, r);
      const flags = flagsFor(w, e);
      const key = `v:${ci}:${r}`;
      if (w !== null) {
        line(key, pt(ci, r), pt(ci, r + 1), index(ci - 1, r), e === null ? null : index(ci, r), flags);
      } else {
        line(key, pt(ci, r + 1), pt(ci, r), index(ci, r), null, flags);
      }
    }
  }

  // Horizontal edges. The south cell lies to the right of a line running +X.
  for (let ri = 0; ri <= rows; ri++) {
    for (let c = 0; c < cols; c++) {
      const n = glyph(c, ri - 1);
      const s = glyph(c, ri);
      const flags = flagsFor(n, s);
      const key = `h:${ri}:${c}`;
      if (s !== null) {
        line(key, pt(c, ri), pt(c + 1, ri), index(c, ri), n === null ? null : index(c, ri - 1), flags);
      } else {
        line(key, pt(c + 1, ri), pt(c, ri), index(c, ri - 1), null, flags);
      }
    }
  }

  // One subsector per cell, its four edges wound clockwise so the cell interior
  // is on each seg's right — which is the half `clipConvexPolygon` keeps, and
  // the side `sectorOfSubSector` reads `direction` against.
  const segs: Seg[] = [];
  const subsectors: SubSector[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const first = segs.length;
      const walk: [string, number, number][] = [
        [`v:${c}:${r}`, pt(c, r + 1), pt(c, r)], // west,  +Y
        [`h:${r}:${c}`, pt(c, r), pt(c + 1, r)], // north, +X
        [`v:${c + 1}:${r}`, pt(c + 1, r), pt(c + 1, r + 1)], // east, -Y
        [`h:${r + 1}:${c}`, pt(c + 1, r + 1), pt(c, r + 1)], // south, -X
      ];
      for (const [key, v1, v2] of walk) {
        const edge = edges.get(key)!;
        segs.push({
          v1,
          v2,
          angle: 0,
          linedef: edge.line,
          direction: edge.v1 === v1 ? 0 : 1,
          offset: 0,
        });
      }
      subsectors[index(c, r)] = { count: 4, first };
    }
  }

  // A column chain, with a row chain inside each column. Every builder pushes
  // its own node *after* recursing, so the tree's root lands last — which is
  // where `World.subsectorAt` and `buildSubSectorPolys` both look for it.
  const nodes: Node[] = [];
  const buildRows = (c: number, lo: number, hi: number): number => {
    if (lo === hi) return SUBSECTOR_BIT | index(c, lo);
    const mid = (lo + hi) >> 1;
    const south = buildRows(c, mid + 1, hi);
    const north = buildRows(c, lo, mid);
    nodes.push({
      x: 0,
      y: (rows - (mid + 1)) * cell,
      dx: 1,
      dy: 0,
      rightChild: south,
      leftChild: north,
    });
    return nodes.length - 1;
  };
  const buildCols = (lo: number, hi: number): number => {
    if (lo === hi) return buildRows(lo, 0, rows - 1);
    const mid = (lo + hi) >> 1;
    const right = buildCols(mid + 1, hi);
    const left = buildCols(lo, mid);
    nodes.push({ x: (mid + 1) * cell, y: 0, dx: 0, dy: 1, rightChild: right, leftChild: left });
    return nodes.length - 1;
  };
  buildCols(0, cols - 1);

  return {
    map: {
      name: options.name ?? 'TEST01',
      vertexes,
      sectors,
      sidedefs,
      linedefs,
      segs,
      subsectors,
      nodes,
      things: options.things ?? [],
      reject: options.reject,
      bounds: { minX: 0, minY: 0, maxX: cols * cell, maxY: rows * cell },
    },
    cell,
    cols,
    rows,
    centre: (c, r) => ({ x: c * cell + cell / 2, y: (rows - 1 - r) * cell + cell / 2 }),
    index,
  };
}

/** A `Thing` at a cell centre. `angle` is the WAD's own degrees, not radians. */
export function thingAt(
  grid: GridMap,
  col: number,
  row: number,
  type: number,
  angle = 0,
): Thing {
  const p = grid.centre(col, row);
  return { x: p.x, y: p.y, angle, type, flags: 7 };
}
