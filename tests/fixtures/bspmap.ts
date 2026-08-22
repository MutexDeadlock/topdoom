/**
 * Hand-built `DoomMap`s with a deliberately chosen BSP, for the render tests that have to
 * reproduce what a node builder left behind — a wall stub sitting inside a leaf, a line
 * whose two sides face one sector. `gridmap.ts` cannot express either: it always emits a
 * correct tree with every edge as a seg. See docs/testing.md § The BSP fixture.
 */
import { NO_SIDE, SUBSECTOR_BIT, type DoomMap, type Vertex } from '../../src/wad/map.ts';

type Linedef = DoomMap['linedefs'][number];
type Seg = DoomMap['segs'][number];
type Node = DoomMap['nodes'][number];

/** A one-sided wall from `v1` to `v2`; its right side — the side it faces — is sidedef `side`. */
export function wall(v1: number, v2: number, side = 0): Linedef {
  return { v1, v2, flags: 0, special: 0, tag: 0, right: side, left: NO_SIDE };
}

/** A two-sided line, `right`/`left` naming its two sidedefs. */
export function twoSided(v1: number, v2: number, right: number, left: number): Linedef {
  return { v1, v2, flags: 0, special: 0, tag: 0, right, left };
}

/** The seg for `linedef`, running along it from `v1` to `v2`; `direction` 1 is its back side. */
export function seg(v1: number, v2: number, linedef: number, direction = 0): Seg {
  return { v1, v2, angle: 0, linedef, direction, offset: 0 };
}

/** Child reference to subsector `i`, the way NODES encodes one. */
export function leaf(i: number): number {
  return (SUBSECTOR_BIT | i) >>> 0;
}

/** A partition through `(x, y)` along `(dx, dy)`; its right side is `cross <= 0` — see util/geom.ts. */
export function plane(x: number, y: number, dx: number, dy: number, rightChild: number, leftChild: number): Node {
  return { x, y, dx, dy, rightChild, leftChild };
}

export interface BspMapParts {
  vertexes: Vertex[];
  /** Floor height per sector; everything else about them is identical. Defaults to one flat sector. */
  floors?: number[];
  /** The sector each sidedef faces. */
  sidedefs: number[];
  linedefs: Linedef[];
  segs: Seg[];
  /** `[first seg, seg count]` per subsector. */
  subsectors: [number, number][];
  nodes: Node[];
  /** Map bounds, as a square `±half` about the origin. */
  half: number;
}

/** Fills in everything `buildSubSectorPolys` never reads, so a fixture states only its geometry. */
export function bspMap(parts: BspMapParts): DoomMap {
  return {
    name: 'TEST',
    format: 'doom',
    nodeFormat: 'vanilla',
    vertexes: parts.vertexes,
    sectors: (parts.floors ?? [0]).map((floorHeight) => ({
      floorHeight,
      ceilHeight: 128,
      floorTex: 'FLAT1',
      ceilTex: 'FLAT1',
      light: 160,
      special: 0,
      tag: 0,
    })),
    sidedefs: parts.sidedefs.map((sector) => ({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: 'WALL', sector })),
    linedefs: parts.linedefs,
    segs: parts.segs,
    subsectors: parts.subsectors.map(([first, count]) => ({ first, count })),
    nodes: parts.nodes,
    things: [],
    reject: undefined,
    bounds: { minX: -parts.half, minY: -parts.half, maxX: parts.half, maxY: parts.half },
  };
}
