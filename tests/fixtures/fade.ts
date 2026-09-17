/**
 * What the occlusion-fade tests share: the diced wall they run over, the `FadeTarget` the faders
 * aim at, the opening lookup their wall half takes, and the vertex-alpha readbacks their
 * assertions are written against. Built once here so a dial added to
 * `FadeTarget`, or a change to how `commit` writes alpha, does not mean editing
 * every case in every fade test. The dials are still *read* from the source
 * rather than mirrored (docs/render-occlusion.md § The fade is a hole, not a wall).
 */
import * as THREE from 'three';
import { FADE_ALPHA, FADE_RADIUS, type FadeFrame, type FadeTarget } from '../../src/render/occlusion.ts';
import { buildMapMesh, WALL_CHUNK_LEN, type WallOccluder } from '../../src/render/mapmesh.ts';
import { Transfers } from '../../src/game/specials/transfers.ts';
import { NO_SIDE } from '../../src/wad/map.ts';
import { World, type Opening } from '../../src/game/world.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';
import { gridMap } from './gridmap.ts';
import { BANK } from './specialsrig.ts';

/** The chunk a wall is diced into, which every fixture below sizes itself from. */
export const CHUNK = WALL_CHUNK_LEN;

/** Cells long enough that a wall runs both several chunks and several hole-widths, whole chunks either way. */
export const CELL = CHUNK * Math.max(4, Math.ceil((4 * FADE_RADIUS) / CHUNK));

/** The texture every wall the fade tests build is hung with. */
export const WALLTEX = 'WALL';

/**
 * Three open cells in a row, walled north and south, at `CELL` per cell — so each open cell's north
 * edge is one linedef several chunks wide. Upper textures go on every side, since a `#` cell is a
 * zero-height sector and the step up to it is what draws.
 */
export function walledRow(cell = CELL) {
  const grid = gridMap(['###', '...', '###'], { cell });
  for (const l of grid.map.linedefs) {
    if (l.right !== NO_SIDE) grid.map.sidedefs[l.right].upper = WALLTEX;
    if (l.left !== NO_SIDE) grid.map.sidedefs[l.left].upper = WALLTEX;
  }
  const built = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
  return { grid, ...built, world: new World(grid.map) };
}

/** Every quad cut from one line side, in build order. */
export function group(occluders: readonly WallOccluder[], line: number, frontSide: boolean): WallOccluder[] {
  return occluders.filter((o) => o.line === line && o.frontSide === frontSide);
}

/** The line running east-west at `y`, whichever index it landed on. */
export function lineAtY(grid: ReturnType<typeof gridMap>, y: number, x: number): number {
  const { map } = grid;
  for (const [i, l] of map.linedefs.entries()) {
    const v1 = map.vertexes[l.v1];
    const v2 = map.vertexes[l.v2];
    if (v1.y !== y || v2.y !== y) continue;
    if (Math.min(v1.x, v2.x) <= x && x <= Math.max(v1.x, v2.x)) return i;
  }
  throw new Error(`no east-west line at y=${y} spanning x=${x}`);
}

/**
 * A quad's four corner alphas as `commit` wrote them, with the map position each belongs to —
 * `addWall` pushes [A, D, C, A, C, B], so indices 0/1/2/5 are top-left, bottom-left, bottom-right,
 * top-right. The one place that layout is walked, as `lowestAlphaAt` is for the whole quad.
 */
export function corners(meshes: ReadonlyMap<string, THREE.Mesh>, o: WallOccluder) {
  const attr = meshes.get(o.key)!.geometry.getAttribute('color') as THREE.BufferAttribute;
  return {
    topLeft: { a: attr.getW(o.vertexStart), x: o.ax, y: o.ay, z: o.topH },
    botLeft: { a: attr.getW(o.vertexStart + 1), x: o.ax, y: o.ay, z: o.botH },
    botRight: { a: attr.getW(o.vertexStart + 2), x: o.bx, y: o.by, z: o.botH },
    topRight: { a: attr.getW(o.vertexStart + 5), x: o.bx, y: o.by, z: o.topH },
  };
}

/** Every corner of a quad, as a flat list. */
export function cornerList(meshes: ReadonlyMap<string, THREE.Mesh>, o: WallOccluder) {
  const c = corners(meshes, o);
  return [c.topLeft, c.botLeft, c.botRight, c.topRight];
}

/** A player-strength fade target at a point, with any dial overridden — `over` is for the cases that vary one. */
export function targetAt(x: number, y: number, z: number, over: Partial<FadeTarget> = {}): FadeTarget {
  return {
    x,
    y,
    z,
    halfHeight: PLAYER_HEIGHT / 2,
    fadeFloor: FADE_ALPHA,
    fadeRadius: FADE_RADIUS,
    ...over,
  };
}

/** The real opening lookup, in the shape the wall fade takes it. */
export function openingsOf(world: World): (line: number, out: Opening) => boolean {
  return (line, out) => world.openingInto(line, out);
}

/** The alpha channel of a mesh's vertex colours, or `undefined` for a batch that has none. */
function alphaOf(mesh: THREE.Mesh | undefined): THREE.BufferAttribute | undefined {
  return mesh?.geometry?.getAttribute?.('color') as THREE.BufferAttribute | undefined;
}

/**
 * The lowest alpha `commit` has written anywhere in a batch of meshes — every
 * vertex, whichever quad or fan wrote it. A minimum over everything, so it
 * answers "did anything fade at all" rather than "did *this* wall fade".
 */
export function lowestAlpha(meshes: ReadonlyMap<string, THREE.Mesh>): number {
  let low = 1;
  for (const mesh of meshes.values()) {
    const attr = alphaOf(mesh);
    if (!attr) continue;
    for (let v = 0; v < attr.count; v++) low = Math.min(low, attr.getW(v));
  }
  return low;
}

/**
 * The same over the wall quads standing at `x` alone, walked through each
 * occluder's own vertex range. For a case about one wall on a map that has
 * others, where a minimum over everything would answer about the wrong one.
 */
export function lowestAlphaAt(
  occluders: readonly WallOccluder[],
  meshes: ReadonlyMap<string, THREE.Mesh>,
  x: number,
): number {
  let low = 1;
  for (const o of occluders) {
    if (Math.min(o.ax, o.bx) > x || Math.max(o.ax, o.bx) < x) continue;
    const attr = alphaOf(meshes.get(o.key));
    if (!attr) continue;
    for (let v = 0; v < o.vertexCount; v++) low = Math.min(low, attr.getW(o.vertexStart + v));
  }
  return low;
}

/**
 * One frame's worth of fade input for a test driving a fader directly, in the order the faders
 * used to take these as arguments — `FadeFrame` is what they take now (render/occlusion.ts).
 */
export function fadeFrame(
  dt: number,
  camX: number,
  camY: number,
  camZ: number,
  targets: FadeTarget[],
  openingInto: FadeFrame['openingInto'] = () => false,
): FadeFrame {
  return { dt, camX, camY, camZ, targets, openingInto };
}
