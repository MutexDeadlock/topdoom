/**
 * Decodes the three BSP lumps (SEGS/SSECTORS/NODES) in every format Boom- and ZDoom-era
 * maps ship — vanilla 16-bit, DeePBSP V4, and the eight extended signatures: the plain
 * pair XNOD/ZNOD and the GL family XGLN/XGL2/XGL3 — and normalizes them to one in-memory
 * convention: 32-bit node children flagged with `SUBSECTOR_BIT`. Record layouts follow
 * PrBoom+'s `doomdata.h`/`p_setup.c` and gzdoom's `maploader.cpp`.
 * See docs/wad.md § Node formats.
 */
import { Reader, records } from '../reader.ts';
import { inflateZlib } from '../../util/inflate.ts';
import { NO_LINE, SUBSECTOR_BIT, type Node, type NodeFormat, type Seg, type SubSector, type Vertex } from './defs.ts';

export interface BspData {
  format: NodeFormat;
  segs: Seg[];
  subsectors: SubSector[];
  nodes: Node[];
}

/**
 * What each extended signature says about the payload behind it: whether it is
 * zlib-compressed, and its **GL level** — 0 for the plain pair and 1/2/3 for
 * XGLN/XGL2/XGL3. The level carries which lump signs it (0 signs NODES, the GL family
 * SSECTORS) along with the seg record and the node's partition precision, so those three
 * never disagree. The signature-to-level mapping is gzdoom's
 * `maploader.cpp: LoadExtendedNodes`.
 */
interface Extended {
  format: NodeFormat;
  gl: 0 | 1 | 2 | 3;
  compressed: boolean;
}

const EXTENDED: Record<string, Extended> = {
  XNOD: { format: 'xnod', gl: 0, compressed: false },
  ZNOD: { format: 'znod', gl: 0, compressed: true },
  XGLN: { format: 'xgln', gl: 1, compressed: false },
  ZGLN: { format: 'zgln', gl: 1, compressed: true },
  XGL2: { format: 'xgl2', gl: 2, compressed: false },
  ZGL2: { format: 'zgl2', gl: 2, compressed: true },
  XGL3: { format: 'xgl3', gl: 3, compressed: false },
  ZGL3: { format: 'zgl3', gl: 3, compressed: true },
};

/**
 * Reads a map's BSP in whatever format it ships. An extended one gets its extra
 * vertexes appended to `vertexes` in place.
 */
export function readBsp(
  vertexes: Vertex[],
  segsData: Uint8Array | undefined,
  ssectorsData: Uint8Array | undefined,
  nodesData: Uint8Array | undefined,
): BspData {
  // DeePBSP signs NODES too, and its signature is not one of `EXTENDED`'s.
  if (startsWith(nodesData, 'xNd4\0\0\0\0')) return readDeepV4(segsData, ssectorsData, nodesData);
  const extended = extendedPayload(ssectorsData, nodesData);
  if (!extended) return readVanilla(segsData, ssectorsData, nodesData);
  return readExtendedLump(extended.entry, extended.data, vertexes);
}

/**
 * A UDMF map's BSP: the whole payload in the one ZNODES lump, behind any of the eight
 * extended signatures — plain or GL, there is no second lump to disambiguate against.
 * Absent or unsigned data reads as no BSP at all; `wad/support.ts` is what warns about
 * that before the map is picked. docs/wad.md § UDMF.
 */
export function readBspZnodes(vertexes: Vertex[], data: Uint8Array | undefined): BspData {
  const entry = data && EXTENDED[signature(data)];
  if (!entry) return { format: 'vanilla', segs: [], subsectors: [], nodes: [] };
  return readExtendedLump(entry, data, vertexes);
}

function startsWith(data: Uint8Array | undefined, sig: string): boolean {
  if (!data || data.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (data[i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

/** The four bytes a lump opens with, or '' where it has none to read. */
function signature(data: Uint8Array | undefined): string {
  if (!data || data.length < 4) return '';
  return String.fromCharCode(data[0], data[1], data[2], data[3]);
}

/**
 * The extended payload a map ships and how to read it, or null when it ships none.
 * **NODES is tested before SSECTORS**, as gzdoom's `LoadLevel` does: a map built with
 * both (`zdbsp -g -X`) carries XNOD in NODES beside XGLN in SSECTORS, and the plain
 * nodes are the ones it means for a renderer that isn't drawing from GL segs.
 */
function extendedPayload(
  ssectorsData: Uint8Array | undefined,
  nodesData: Uint8Array | undefined,
): { entry: Extended; data: Uint8Array } | null {
  const plain = EXTENDED[signature(nodesData)];
  if (plain && plain.gl === 0) return { entry: plain, data: nodesData! };
  const gl = EXTENDED[signature(ssectorsData)];
  if (gl && gl.gl > 0) return { entry: gl, data: ssectorsData! };
  return null;
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

/**
 * DeePBSP V4: `mapseg_v4_t` / `mapsubsector_v4_t` / `mapnode_v4_t`; children already carry the
 * 0x80000000 flag on disk.
 */
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
 * `mapseg_znod_t`: both endpoints stored, and no angle/offset — nothing in the engine reads either.
 */
function readPlainSegs(r: Reader, count: number): Seg[] {
  const segs: Seg[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const v1 = r.u32();
    const v2 = r.u32();
    const linedef = r.u16();
    segs[i] = { v1, v2, angle: 0, linedef, direction: r.u8(), offset: 0 };
  }
  return segs;
}

/**
 * GL segs, which store no second vertex: a leaf's segs run in order around its boundary,
 * so each one's `v2` is the next one's `v1`, wrapping at the end of the leaf — the
 * ordering gzdoom's `LoadGLZSegs` reconstructs them from. `partner`, the seg facing this
 * one from the leaf across the edge, is read past: nothing here walks between leaves.
 * docs/wad.md § GL nodes.
 */
function readGlSegs(r: Reader, gl: number, subsectors: SubSector[], total: number, count: number): Seg[] {
  // gzdoom's own check (`LoadZNodes`): the two disagreeing means every seg index past the
  // first short leaf names a different edge than the file does.
  if (total !== count) throw new Error(`GL nodes: ${count} segs for ${total} the subsectors claim`);

  // XGLN names the line in a u16, XGL2 and XGL3 in a u32, each with an all-ones miniseg.
  const wide = gl >= 2;
  const noLine = wide ? 0xffffffff : 0xffff;
  const segs: Seg[] = new Array(count);
  for (const ss of subsectors) {
    for (let i = 0; i < ss.count; i++) {
      const v1 = r.u32();
      r.u32(); // partner seg
      const line = wide ? r.u32() : r.u16();
      segs[ss.first + i] = {
        v1,
        v2: 0,
        angle: 0,
        linedef: line === noLine ? NO_LINE : line,
        direction: r.u8(),
        offset: 0,
      };
    }
    // Close the ring now that the leaf's own `v1`s are all in: each seg ends where the next begins.
    for (let i = 0; i < ss.count; i++) segs[ss.first + i].v2 = segs[ss.first + ((i + 1) % ss.count)].v1;
  }
  return segs;
}

/**
 * An extended payload (after its 4-byte signature, decompressed): new vertexes in 16.16
 * fixed point appended to the map's own, per-subsector seg counts with the start index
 * implicit, then the segs its GL level names and `mapnode_znod_t` nodes. The lump it did
 * not come from is empty in every one of these formats. Appends to `vertexes` in place.
 */
function readExtended(entry: Extended, payload: Uint8Array, vertexes: Vertex[]): BspData {
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
  // `first` ends as the total seg count the subsectors claim, which is what a GL payload is checked
  // against.
  let first = 0;
  for (let i = 0; i < numSubs; i++) {
    const count = r.u32();
    subsectors[i] = { count, first };
    first += count;
  }

  const numSegs = r.u32();
  const segs =
    entry.gl === 0 ? readPlainSegs(r, numSegs) : readGlSegs(r, entry.gl, subsectors, first, numSegs);

  // XGL3 alone stores the partition line in 16.16 fixed point rather than whole units.
  const partition = entry.gl === 3 ? () => r.i32() / 65536 : () => r.i16();
  const numNodes = r.u32();
  const nodes: Node[] = new Array(numNodes);
  for (let i = 0; i < numNodes; i++) {
    const x = partition();
    const y = partition();
    const dx = partition();
    const dy = partition();
    r.seek(r.pos + 16); // skip both bounding boxes
    nodes[i] = { x, y, dx, dy, rightChild: r.u32(), leftChild: r.u32() };
  }

  return { format: entry.format, segs, subsectors, nodes };
}

/** An extended payload past its four signature bytes, inflated where the signature says so. */
function readExtendedLump(entry: Extended, data: Uint8Array, vertexes: Vertex[]): BspData {
  const body = data.subarray(4);
  return readExtended(entry, entry.compressed ? inflateZlib(body) : body, vertexes);
}
