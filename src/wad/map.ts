import type { Wad } from './wad.ts';

export const NO_SIDE = 0xffff;

export interface Vertex {
  x: number;
  y: number;
}

export interface Sector {
  floorHeight: number;
  ceilHeight: number;
  floorTex: string;
  ceilTex: string;
  light: number;
  special: number;
  tag: number;
}

export interface SideDef {
  xOffset: number;
  yOffset: number;
  upper: string;
  lower: string;
  middle: string;
  sector: number;
}

export interface LineDef {
  v1: number;
  v2: number;
  flags: number;
  special: number;
  tag: number;
  right: number; // sidedef index, or NO_SIDE
  left: number;
}

export interface Seg {
  v1: number;
  v2: number;
  angle: number;
  linedef: number;
  /** 0 = same direction as the linedef, 1 = opposite. */
  direction: number;
  offset: number;
}

export interface SubSector {
  count: number;
  first: number;
}

export interface Node {
  x: number;
  y: number;
  dx: number;
  dy: number;
  rightChild: number;
  leftChild: number;
}

export interface Thing {
  x: number;
  y: number;
  angle: number;
  type: number;
  flags: number;
}

/** Linedef flags (subset). */
export const LF = {
  BLOCKING: 0x0001,
  BLOCK_MONSTERS: 0x0002,
  TWO_SIDED: 0x0004,
  UPPER_UNPEGGED: 0x0008,
  LOWER_UNPEGGED: 0x0010,
  SECRET: 0x0020,
  BLOCK_SOUND: 0x0040,
  NEVER_ON_MAP: 0x0080,
  ALWAYS_ON_MAP: 0x0100,
} as const;

/** Bit in a node child that marks a subsector reference instead of a node. */
export const SUBSECTOR_BIT = 0x8000;

export interface DoomMap {
  name: string;
  vertexes: Vertex[];
  sectors: Sector[];
  sidedefs: SideDef[];
  linedefs: LineDef[];
  segs: Seg[];
  subsectors: SubSector[];
  nodes: Node[];
  things: Thing[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const MAP_LUMPS = [
  'THINGS',
  'LINEDEFS',
  'SIDEDEFS',
  'VERTEXES',
  'SEGS',
  'SSECTORS',
  'NODES',
  'SECTORS',
  'REJECT',
  'BLOCKMAP',
];

/** Finds the lumps belonging to a map marker; they follow it directly in the directory. */
function mapLumps(wad: Wad, name: string): Map<string, number> {
  const marker = wad.find(name);
  if (!marker) throw new Error(`map ${name} not found in WAD`);
  const out = new Map<string, number>();
  for (let i = marker.index + 1; i < marker.index + 12; i++) {
    const l = wad.lumpAt(i);
    if (!l) break;
    if (!MAP_LUMPS.includes(l.name)) break;
    if (!out.has(l.name)) out.set(l.name, i);
  }
  return out;
}

export function loadMap(wad: Wad, name: string): DoomMap {
  const lumps = mapLumps(wad, name);
  const read = <T>(lumpName: string, recordSize: number, fn: (r: ReturnType<Wad['reader']>) => T): T[] => {
    const idx = lumps.get(lumpName);
    if (idx === undefined) return [];
    const lump = wad.lumpAt(idx)!;
    const r = wad.reader(lump);
    const n = Math.floor(lump.size / recordSize);
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) {
      r.seek(i * recordSize);
      out[i] = fn(r);
    }
    return out;
  };

  const vertexes = read('VERTEXES', 4, (r) => ({ x: r.i16(), y: r.i16() }));

  const sectors = read('SECTORS', 26, (r) => ({
    floorHeight: r.i16(),
    ceilHeight: r.i16(),
    floorTex: r.name8(),
    ceilTex: r.name8(),
    light: r.u16(),
    special: r.u16(),
    tag: r.u16(),
  }));

  const sidedefs = read('SIDEDEFS', 30, (r) => ({
    xOffset: r.i16(),
    yOffset: r.i16(),
    upper: r.name8(),
    lower: r.name8(),
    middle: r.name8(),
    sector: r.u16(),
  }));

  const linedefs = read('LINEDEFS', 14, (r) => ({
    v1: r.u16(),
    v2: r.u16(),
    flags: r.u16(),
    special: r.u16(),
    tag: r.u16(),
    right: r.u16(),
    left: r.u16(),
  }));

  const segs = read('SEGS', 12, (r) => ({
    v1: r.u16(),
    v2: r.u16(),
    angle: r.i16(),
    linedef: r.u16(),
    direction: r.u16(),
    offset: r.i16(),
  }));

  const subsectors = read('SSECTORS', 4, (r) => ({ count: r.u16(), first: r.u16() }));

  const nodes = read('NODES', 28, (r) => {
    const x = r.i16();
    const y = r.i16();
    const dx = r.i16();
    const dy = r.i16();
    r.seek(r.pos + 16); // skip both bounding boxes
    return { x, y, dx, dy, rightChild: r.u16(), leftChild: r.u16() };
  });

  const things = read('THINGS', 10, (r) => ({
    x: r.i16(),
    y: r.i16(),
    angle: r.i16(),
    type: r.u16(),
    flags: r.u16(),
  }));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of vertexes) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }

  return {
    name,
    vertexes,
    sectors,
    sidedefs,
    linedefs,
    segs,
    subsectors,
    nodes,
    things,
    bounds: { minX, minY, maxX, maxY },
  };
}
