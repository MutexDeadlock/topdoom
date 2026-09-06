/**
 * The map lumps decoded into a `DoomMap`: vertices, linedefs/sidedefs, sectors, the BSP
 * (nodes/segs/subsectors, any format `map/nodes.ts` knows) and THINGS. Everything but the
 * BSP, the two lumps a Hexen-format map re-encodes (`map/hexen.ts`) and a UDMF map's one
 * TEXTMAP lump (`map/udmf.ts`) is stored exactly as the WAD encodes it. This file is the
 * layer's one entry point (docs/conventions.md § File names): `map/` holds the records
 * themselves (`map/defs.ts`) and the three format seams, and nothing else reaches into it.
 * See docs/wad.md.
 */
import { MAP_MARKER, type Wad } from './wad.ts';
import { records, type Reader } from './reader.ts';
import * as hexen from './map/hexen.ts';
import * as udmf from './map/udmf.ts';
import { readBsp, readBspZnodes, type BspData } from './map/nodes.ts';
import { decodeTextLump } from './textlump.ts';
import type { DoomMap, LineDef, MapFormat, Sector, SideDef, Thing, Vertex } from './map/defs.ts';

export {
  isTextured,
  LF,
  NO_LINE,
  NO_SIDE,
  Node,
  SKY_FLAT,
  segBackSide,
  segSide,
  SUBSECTOR_BIT,
  type DoomMap,
  type LineDef,
  type Sector,
  type Seg,
  type SideDef,
  type SubSector,
  type Thing,
  type Vertex,
} from './map/defs.ts';
export { sniffUdmfNamespace, udmfDoomSpecials } from './map/udmf.ts';

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

/**
 * Roughly how many binary `LINEDEFS` bytes a TEXTMAP byte stands for, keeping
 * `mapLinedefBytes`'s unit the same whichever format a map ships in: text encodes the whole
 * map at about ten times the binary size, of which linedefs are about a quarter. Tuned by
 * feel — it only ever moves a loading-screen estimate.
 */
const TEXTMAP_BYTES_PER_LINEDEF_BYTE = 40;

/**
 * The size of a map's `LINEDEFS` lump — for a UDMF map, its `TEXTMAP` scaled to the same
 * unit — without reading a byte of it: a directory lookup and the entry's own length.
 * `game.ts` estimates what building the map will cost from this, which is why it must stay
 * a lookup: the point is to answer *before* the map is loaded.
 * See docs/menu.md § The loading screen.
 */
export function mapLinedefBytes(wad: Wad, name: string): number {
  // `mapLumps` throws where the marker is missing; a caller asking about a map that isn't there
  // wants an estimate of zero, not a load failure it has no way to act on.
  if (!wad.find(name)) return 0;
  const lumps = mapLumps(wad, name);
  const textmap = lumps.get('TEXTMAP');
  if (textmap !== undefined) return wad.lumpAt(textmap)!.size / TEXTMAP_BYTES_PER_LINEDEF_BYTE;
  const index = lumps.get('LINEDEFS');
  return index === undefined ? 0 : wad.lumpAt(index)!.size;
}

export function loadMap(wad: Wad, name: string): DoomMap {
  const lumps = mapLumps(wad, name);
  const rawLump: RawLump = (lumpName) => {
    const idx = lumps.get(lumpName);
    return idx === undefined ? undefined : wad.data(wad.lumpAt(idx)!);
  };

  // A TEXTMAP lump is a UDMF map, tested first — such a map may carry a BEHAVIOR lump too.
  // Otherwise a BEHAVIOR lump — compiled ACS, which only a Hexen map carries — is what names
  // the encoding LINEDEFS and THINGS shipped in, the same signal gzdoom's `LoadLevel` uses;
  // record-size arithmetic is not a substitute. docs/wad.md § Map formats.
  let geometry: MapGeometry;
  if (lumps.has('TEXTMAP')) {
    // ENDMAP is the group's required closing lump (udmf.txt § II.B); without it there is no
    // saying which of the lumps that follow are the map's.
    if (!lumps.has('ENDMAP')) throw new Error(`map ${name}: a TEXTMAP with no closing ENDMAP`);
    geometry = readUdmfGeometry(rawLump);
  } else {
    geometry = readBinaryGeometry(lumps.has('BEHAVIOR') ? 'hexen' : 'doom', rawLump);
  }

  const { vertexes, sectors, bsp } = geometry;
  return {
    name,
    format: geometry.format,
    udmfNamespace: geometry.udmfNamespace,
    nodeFormat: bsp.format,
    vertexes,
    sectors,
    sidedefs: geometry.sidedefs,
    linedefs: geometry.linedefs,
    segs: bsp.segs,
    subsectors: bsp.subsectors,
    nodes: bsp.nodes,
    things: geometry.things,
    reject: readReject(wad, lumps, sectors.length),
    bounds: boundsOf(vertexes),
  };
}

/** Finds the lumps belonging to a map marker; they follow it directly in the directory. */
function mapLumps(wad: Wad, name: string): Map<string, number> {
  const marker = wad.find(name);
  if (!marker) throw new Error(`map ${name} not found in WAD`);
  const out = new Map<string, number>();
  // A UDMF group is bracketed rather than listed, so it is walked to its ENDMAP whatever the
  // lumps between are named; the next map marker bounds the walk where ENDMAP is missing.
  // docs/wad.md § UDMF.
  if (wad.lumpAt(marker.index + 1)?.name === 'TEXTMAP') {
    for (let i = marker.index + 1; ; i++) {
      const l = wad.lumpAt(i);
      if (!l || MAP_MARKER.test(l.name)) break;
      if (!out.has(l.name)) out.set(l.name, i);
      if (l.name === 'ENDMAP') break;
    }
    return out;
  }
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

function boundsOf(vertexes: Vertex[]): DoomMap['bounds'] {
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
  return { minX, minY, maxX, maxY };
}

/** One map's lump bytes by name, `undefined` where the group has no such lump. */
type RawLump = (lumpName: string) => Uint8Array | undefined;

/**
 * What a format seam yields: the records it decoded plus the BSP its own node lumps carry.
 * `loadMap` assembles the `DoomMap` from this alone, so the two seams share one tail rather
 * than each writing out the whole map.
 */
interface MapGeometry {
  format: MapFormat;
  udmfNamespace?: string;
  vertexes: Vertex[];
  sectors: Sector[];
  sidedefs: SideDef[];
  linedefs: LineDef[];
  things: Thing[];
  bsp: BspData;
}

function readUdmfGeometry(rawLump: RawLump): MapGeometry {
  const parsed = udmf.parseTextmap(decodeTextLump(rawLump('TEXTMAP')));
  return {
    format: 'udmf',
    udmfNamespace: parsed.namespace,
    vertexes: parsed.vertexes,
    sectors: parsed.sectors,
    sidedefs: parsed.sidedefs,
    linedefs: parsed.linedefs,
    things: parsed.things,
    // May append vertexes (split vertexes ride in the payload), so runs before the bounds pass.
    bsp: readBspZnodes(parsed.vertexes, rawLump('ZNODES')),
  };
}

function readBinaryGeometry(format: MapFormat, rawLump: RawLump): MapGeometry {
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

  return { format, vertexes, sectors, sidedefs, linedefs, things, bsp };
}
