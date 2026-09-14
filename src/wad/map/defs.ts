/**
 * The records a map is made of — vertices, linedefs/sidedefs, sectors, the BSP leaves and THINGS —
 * and the sentinels the WAD encodes them with. Every format seam in this directory writes these,
 * and `map.ts` assembles a {@link DoomMap} out of them and re-exports the lot. See docs/wad.md.
 */

/** Which encoding a map's geometry lumps use. docs/wad.md § Map formats and § UDMF. */
export type MapFormat = 'doom' | 'hexen' | 'udmf';

export type NodeFormat =
  | 'vanilla'
  | 'deep-v4'
  | 'xnod'
  | 'znod'
  | 'xgln'
  | 'zgln'
  | 'xgl2'
  | 'zgl2'
  | 'xgl3'
  | 'zgl3';

export const NO_SIDE = 0xffff;

/**
 * DOOM's sky flat. A sector using it as its ceiling texture renders no ceiling
 * at all, and vanilla's own "don't shoot the sky" rule keys off the same name
 * (`World.hitsSky`), which is why this lives with the map rather than with the
 * renderer that draws it.
 */
export const SKY_FLAT = 'F_SKY1';

/**
 * DOOM's sentinel for "no texture assigned" in a sidedef's texture slot. Lives here beside
 * {@link SKY_FLAT} for the same reason: it is what the WAD writes, read by the renderer and by
 * `game/specials.ts` alike, not a decision either of them makes.
 */
const NO_TEXTURE = '-';

/**
 * Whether a texture slot names art to look up. The empty string is a second spelling of the
 * sentinel — a binary map's `name8` yields it for an all-zero slot — so nothing may test
 * `!== NO_TEXTURE` alone.
 */
export function isTextured(name: string): boolean {
  return name !== NO_TEXTURE && name !== '';
}

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
interface LineAction {
  special: number;
  args: readonly number[];
}

export interface LineDef {
  v1: number;
  v2: number;
  flags: number;
  /** The Doom/Boom special. Always 0 on a Hexen-format map — see {@link LineDef.action}. */
  special: number;
  tag: number;
  right: number; // sidedef index, or NO_SIDE
  left: number;
  /** Hexen-format maps only; `undefined` on a Doom-format one. */
  action?: LineAction;
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

/**
 * {@link Seg.linedef} on a GL miniseg — the edge a BSP split introduced, which lies on no linedef
 * at all. -1, so it indexes {@link DoomMap.linedefs} as `undefined` whatever the map's line count.
 * docs/wad.md § GL nodes.
 */
export const NO_LINE = -1;

export interface Seg {
  v1: number;
  v2: number;
  angle: number;
  /** The line this edge runs on, or {@link NO_LINE} on a GL miniseg. docs/wad.md § GL nodes. */
  linedef: number;
  /** 0 = same direction as the linedef, 1 = opposite. */
  direction: number;
  offset: number;
}

/**
 * The sidedef a seg uses, and the one across the line from it ({@link NO_SIDE} on a one-sided
 * line) — the one home for {@link Seg.direction}'s winding convention.
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

/**
 * Bit in a node child that marks a subsector reference instead of a node.
 * PrBoom+'s `NF_SUBSECTOR`: the 32-bit position vanilla's 0x8000 disk flag is
 * normalized to at load, so consumers never see a format difference.
 */
export const SUBSECTOR_BIT = 0x80000000;

/**
 * A BSP partition line and its two children. A class rather than a literal shape so its hidden
 * class has a transition tree of its own: `World.subsectorAt` reads one per step of every point
 * query, and a literal's tree is shared with every other six-field literal opening with `x`, `y`.
 * docs/wad.md § Node formats.
 */
export class Node {
  x: number;
  y: number;
  dx: number;
  dy: number;
  rightChild: number;
  leftChild: number;

  constructor(fields: Node) {
    this.x = fields.x;
    this.y = fields.y;
    this.dx = fields.dx;
    this.dy = fields.dy;
    this.rightChild = fields.rightChild;
    this.leftChild = fields.leftChild;
  }
}

export interface Thing {
  x: number;
  y: number;
  angle: number;
  type: number;
  flags: number;
}

export interface DoomMap {
  name: string;
  /** Which on-disk encoding LINEDEFS and THINGS shipped in (`loadMap`). */
  format: MapFormat;
  /** Which on-disk BSP encoding the map shipped (`readBsp` normalizes them all). */
  nodeFormat: NodeFormat;
  /** A UDMF map's namespace, lowercased (`''` when TEXTMAP named none); absent otherwise. */
  udmfNamespace?: string;
  vertexes: Vertex[];
  sectors: Sector[];
  sidedefs: SideDef[];
  linedefs: LineDef[];
  segs: Seg[];
  subsectors: SubSector[];
  nodes: Node[];
  things: Thing[];
  /**
   * The REJECT matrix — one bit per ordered sector pair — or `undefined` when the map has none
   * worth consulting (`readReject`).
   */
  reject: Uint8Array | undefined;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}
