/**
 * The map lumps decoded into a `DoomMap`: vertices, linedefs/sidedefs, sectors, the BSP
 * (nodes/segs/subsectors, any format `map/nodes.ts` knows) and THINGS. Everything but the
 * BSP and, on a Hexen-format map, the two lumps `map/hexen.ts` re-decodes is stored exactly as
 * the WAD encodes it. This file is the layer's one entry point (docs/conventions.md § File names):
 * `map/` holds the two format seams and nothing else reaches into them. See docs/wad.md.
 */
import type { Wad } from './wad.ts';
import { records, type Reader } from './reader.ts';
import * as hexen from './map/hexen.ts';
import { readBsp, type NodeFormat } from './map/nodes.ts';

export { NO_LINE, SUBSECTOR_BIT, type NodeFormat } from './map/nodes.ts';

export const NO_SIDE = 0xffff;

/** Which encoding a map's LINEDEFS and THINGS lumps use. docs/wad.md § Map formats. */
export type MapFormat = 'doom' | 'hexen';

/**
 * DOOM's sky flat. A sector using it as its ceiling texture renders no ceiling
 * at all, and vanilla's own "don't shoot the sky" rule keys off the same name
 * (`World.hitsSky`), which is why this lives with the map rather than with the
 * renderer that draws it.
 */
export const SKY_FLAT = 'F_SKY1';

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

/**
 * A Hexen line's action special and its five arguments, kept raw. Nothing dispatches
 * one. docs/wad.md § What a Hexen map does not get.
 */
export interface LineAction {
  special: number;
  args: readonly number[];
}

export interface LineDef {
  v1: number;
  v2: number;
  flags: number;
  /** The Doom/Boom special. Always 0 on a Hexen-format map — see `action`. */
  special: number;
  tag: number;
  right: number; // sidedef index, or NO_SIDE
  left: number;
  /** Hexen-format maps only; `undefined` on a Doom-format one. */
  action?: LineAction;
}

export interface Seg {
  v1: number;
  v2: number;
  angle: number;
  /** The line this edge runs on, or `NO_LINE` on a GL miniseg. docs/wad.md § GL nodes. */
  linedef: number;
  /** 0 = same direction as the linedef, 1 = opposite. */
  direction: number;
  offset: number;
}

/**
 * The sidedef a seg uses, and the one across the line from it (`NO_SIDE` on a
 * one-sided line) — the one home for `Seg.direction`'s winding convention.
 */
export function segSide(line: LineDef, direction: number): number {
  return direction === 0 ? line.right : line.left;
}

export function segBackSide(line: LineDef, direction: number): number {
  return direction === 0 ? line.left : line.right;
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
  /** Boom: a use action goes on to lines behind this one (`doomdata.h: ML_PASSUSE`). */
  PASSUSE: 0x0200,
} as const;

export interface DoomMap {
  name: string;
  /** Which on-disk encoding LINEDEFS and THINGS shipped in (`readMapFormat`). */
  format: MapFormat;
  /** Which on-disk BSP encoding the map shipped (`readBsp` normalizes them all). */
  nodeFormat: NodeFormat;
  vertexes: Vertex[];
  sectors: Sector[];
  sidedefs: SideDef[];
  linedefs: LineDef[];
  segs: Seg[];
  subsectors: SubSector[];
  nodes: Node[];
  things: Thing[];
  /** The REJECT matrix — one bit per ordered sector pair — or `undefined` when the map has none worth consulting (`readReject`). */
  reject: Uint8Array | undefined;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * The lumps that belong to a map, in the order they follow its marker. Exported because
 * `wad/support.ts` walks the same group over a directory it hasn't loaded, and two lists of what a
 * map is made of would drift (docs/wad.md § Will it run?).
 */
export const MAP_LUMPS = [
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
  'BEHAVIOR', // Hexen only, and always last — its presence is what names the format
];

/** Finds the lumps belonging to a map marker; they follow it directly in the directory. */
function mapLumps(wad: Wad, name: string): Map<string, number> {
  const marker = wad.find(name);
  if (!marker) throw new Error(`map ${name} not found in WAD`);
  const out = new Map<string, number>();
  for (let i = marker.index + 1; i <= marker.index + MAP_LUMPS.length; i++) {
    const l = wad.lumpAt(i);
    if (!l) break;
    if (!MAP_LUMPS.includes(l.name)) break;
    if (!out.has(l.name)) out.set(l.name, i);
  }
  return out;
}

/**
 * The REJECT lump, or `undefined` when consulting it could not change an
 * answer: absent, too short for `sectorCount²` bits, or all-zero.
 *
 * Dropping a *short* table is a deliberate departure — vanilla indexes
 * `rejectmatrix` unchecked (`p_sight.c: P_CheckSight`). docs/wad.md § REJECT.
 */
function readReject(wad: Wad, lumps: Map<string, number>, sectorCount: number): Uint8Array | undefined {
  const idx = lumps.get('REJECT');
  if (idx === undefined) return undefined;
  const lump = wad.lumpAt(idx)!;
  const need = Math.ceil((sectorCount * sectorCount) / 8);
  if (lump.size < need) return undefined;
  const bytes = wad.data(lump).subarray(0, need);
  return bytes.some((b) => b !== 0) ? bytes : undefined;
}

export function loadMap(wad: Wad, name: string): DoomMap {
  const lumps = mapLumps(wad, name);
  // A BEHAVIOR lump — compiled ACS, which only a Hexen map carries — is what names the encoding
  // LINEDEFS and THINGS shipped in, the same signal gzdoom's `LoadLevel` uses; record-size
  // arithmetic is not a substitute. docs/wad.md § Map formats.
  const format: MapFormat = lumps.has('BEHAVIOR') ? 'hexen' : 'doom';
  const rawLump = (lumpName: string): Uint8Array | undefined => {
    const idx = lumps.get(lumpName);
    return idx === undefined ? undefined : wad.data(wad.lumpAt(idx)!);
  };
  const read = <T>(lumpName: string, recordSize: number, fn: (r: Reader) => T): T[] =>
    records(rawLump(lumpName), 0, recordSize, fn);

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

  // May append vertexes (XNOD/ZNOD carry their own split vertexes), so runs
  // before the bounds pass below.
  const bsp = readBsp(vertexes, rawLump('SEGS'), rawLump('SSECTORS'), rawLump('NODES'));

  const linedefs =
    format === 'hexen'
      ? hexen.readLinedefs(rawLump('LINEDEFS'))
      : read('LINEDEFS', 14, (r) => ({
          v1: r.u16(),
          v2: r.u16(),
          flags: r.u16(),
          special: r.u16(),
          tag: r.u16(),
          right: r.u16(),
          left: r.u16(),
        }));

  const things =
    format === 'hexen'
      ? hexen.readThings(rawLump('THINGS'))
      : read('THINGS', 10, (r) => ({
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
    format,
    nodeFormat: bsp.format,
    vertexes,
    sectors,
    sidedefs,
    linedefs,
    segs: bsp.segs,
    subsectors: bsp.subsectors,
    nodes: bsp.nodes,
    things,
    reject: readReject(wad, lumps, sectors.length),
    bounds: { minX, minY, maxX, maxY },
  };
}
