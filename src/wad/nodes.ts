/**
 * Decodes the three BSP lumps (SEGS/SSECTORS/NODES) in every format Boom-era maps
 * ship — vanilla 16-bit, DeePBSP V4 and ZDoom XNOD/ZNOD — and normalizes them to
 * one in-memory convention: 32-bit node children flagged with `SUBSECTOR_BIT`.
 * Record layouts follow PrBoom+'s `doomdata.h`/`p_setup.c`. See docs/wad.md § Node formats.
 */
import { Reader, records } from './reader.ts';
import { inflateZlib } from '../util/inflate.ts';
import type { Node, Seg, SubSector, Vertex } from './map.ts';

/**
 * Bit in a node child that marks a subsector reference instead of a node.
 * PrBoom+'s `NF_SUBSECTOR`: the 32-bit position vanilla's 0x8000 disk flag is
 * normalized to at load, so consumers never see a format difference.
 */
export const SUBSECTOR_BIT = 0x80000000;

export type NodeFormat = 'vanilla' | 'deep-v4' | 'xnod' | 'znod';

export interface BspData {
  format: NodeFormat;
  segs: Seg[];
  subsectors: SubSector[];
  nodes: Node[];
}

/** ZDoom GL-node signatures (found in SSECTORS). This engine clips subsector polys from plain nodes and has no use for GL segs. */
const GL_SIGNATURES = ['XGLN', 'ZGLN', 'XGL2', 'ZGL2', 'XGL3', 'ZGL3'];

function startsWith(data: Uint8Array | undefined, sig: string): boolean {
  if (!data || data.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (data[i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Format detection, following PrBoom+ `p_setup.c` (`P_CheckForZDoomNodes`,
 * `P_CheckForDeePBSPv4Nodes`): DeePBSP V4 and the ZDoom formats sign the NODES
 * lump; GL nodes sign SSECTORS.
 */
function detectNodeFormat(ssectorsData: Uint8Array | undefined, nodesData: Uint8Array | undefined): NodeFormat {
  for (const sig of GL_SIGNATURES) {
    if (startsWith(ssectorsData, sig)) {
      throw new Error(`GL node format ${sig} is not supported — rebuild the map with plain or ZDoom (XNOD) nodes`);
    }
  }
  if (startsWith(nodesData, 'xNd4\0\0\0\0')) return 'deep-v4';
  if (startsWith(nodesData, 'XNOD')) return 'xnod';
  if (startsWith(nodesData, 'ZNOD')) return 'znod';
  return 'vanilla';
}

/**
 * Vanilla 16-bit node child -> the normalized 32-bit convention, per PrBoom+
 * `P_LoadNodes`: 0xFFFF means "no child" and resolves to subsector 0 (that is
 * where PrBoom's -1 lands in `R_PointInSubsector`), and a subsector index past
 * the end of SSECTORS is clamped to 0 rather than left to crash a BSP walk.
 */
function normalizeChild(child: number, subsectorCount: number): number {
  if (child === 0xffff) return SUBSECTOR_BIT >>> 0;
  if ((child & 0x8000) === 0) return child;
  const index = child & 0x7fff;
  return (SUBSECTOR_BIT | (index < subsectorCount ? index : 0)) >>> 0;
}

function readVanilla(segsData: Uint8Array | undefined, ssectorsData: Uint8Array | undefined, nodesData: Uint8Array | undefined): BspData {
  const segs = records(segsData, 0, 12, (r) => ({
    v1: r.u16(),
    v2: r.u16(),
    angle: r.i16(),
    linedef: r.u16(),
    direction: r.u16(),
    offset: r.i16(),
  }));
  const subsectors = records(ssectorsData, 0, 4, (r) => ({ count: r.u16(), first: r.u16() }));
  const nodes = records(nodesData, 0, 28, (r) => {
    const x = r.i16();
    const y = r.i16();
    const dx = r.i16();
    const dy = r.i16();
    r.seek(r.pos + 16); // skip both bounding boxes
    return {
      x,
      y,
      dx,
      dy,
      rightChild: normalizeChild(r.u16(), subsectors.length),
      leftChild: normalizeChild(r.u16(), subsectors.length),
    };
  });
  return { format: 'vanilla', segs, subsectors, nodes };
}

/** DeePBSP V4: `mapseg_v4_t` / `mapsubsector_v4_t` / `mapnode_v4_t`; children already carry the 0x80000000 flag on disk. */
function readDeepV4(segsData: Uint8Array | undefined, ssectorsData: Uint8Array | undefined, nodesData: Uint8Array | undefined): BspData {
  const segs = records(segsData, 0, 16, (r) => ({
    v1: r.i32(),
    v2: r.i32(),
    angle: r.u16(),
    linedef: r.u16(),
    direction: r.i16(),
    offset: r.u16(),
  }));
  const subsectors = records(ssectorsData, 0, 6, (r) => ({ count: r.u16(), first: r.i32() }));
  const nodes = records(nodesData, 8, 32, (r) => {
    const x = r.i16();
    const y = r.i16();
    const dx = r.i16();
    const dy = r.i16();
    r.seek(r.pos + 16); // skip both bounding boxes
    return { x, y, dx, dy, rightChild: r.u32(), leftChild: r.u32() };
  });
  return { format: 'deep-v4', segs, subsectors, nodes };
}

/**
 * ZDoom XNOD payload (after the 4-byte signature): new vertexes in 16.16 fixed
 * point appended to the map's own, per-subsector seg counts with the start index
 * implicit, `mapseg_znod_t` segs and `mapnode_znod_t` nodes. The SEGS and
 * SSECTORS lumps are empty in this format. Appends to `vertexes` in place.
 */
function readXnod(format: NodeFormat, payload: Uint8Array, vertexes: Vertex[]): BspData {
  const r = new Reader(payload.buffer, payload.byteOffset, payload.byteLength);

  const orgVerts = r.u32();
  const newVerts = r.u32();
  if (orgVerts > vertexes.length) {
    throw new Error(`ZDoom nodes expect ${orgVerts} map vertexes, VERTEXES has ${vertexes.length}`);
  }
  vertexes.length = orgVerts;
  for (let i = 0; i < newVerts; i++) {
    vertexes.push({ x: r.i32() / 65536, y: r.i32() / 65536 });
  }

  const numSubs = r.u32();
  const subsectors: SubSector[] = new Array(numSubs);
  let first = 0;
  for (let i = 0; i < numSubs; i++) {
    const count = r.u32();
    subsectors[i] = { count, first };
    first += count;
  }

  const numSegs = r.u32();
  const segs: Seg[] = new Array(numSegs);
  for (let i = 0; i < numSegs; i++) {
    const v1 = r.u32();
    const v2 = r.u32();
    const linedef = r.u16();
    const side = r.u8();
    // The format stores no angle/offset; nothing in the engine reads them.
    segs[i] = { v1, v2, angle: 0, linedef, direction: side, offset: 0 };
  }

  const numNodes = r.u32();
  const nodes: Node[] = new Array(numNodes);
  for (let i = 0; i < numNodes; i++) {
    const x = r.i16();
    const y = r.i16();
    const dx = r.i16();
    const dy = r.i16();
    r.seek(r.pos + 16); // skip both bounding boxes
    nodes[i] = { x, y, dx, dy, rightChild: r.u32(), leftChild: r.u32() };
  }

  return { format, segs, subsectors, nodes };
}

/**
 * Reads a map's BSP in whatever format it ships. XNOD/ZNOD maps get their extra
 * vertexes appended to `vertexes` in place.
 */
export function readBsp(
  vertexes: Vertex[],
  segsData: Uint8Array | undefined,
  ssectorsData: Uint8Array | undefined,
  nodesData: Uint8Array | undefined,
): BspData {
  const format = detectNodeFormat(ssectorsData, nodesData);
  switch (format) {
    case 'vanilla':
      return readVanilla(segsData, ssectorsData, nodesData);
    case 'deep-v4':
      return readDeepV4(segsData, ssectorsData, nodesData);
    case 'xnod':
      return readXnod('xnod', nodesData!.subarray(4), vertexes);
    case 'znod':
      return readXnod('znod', inflateZlib(nodesData!.subarray(4)), vertexes);
  }
}
