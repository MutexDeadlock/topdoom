/**
 * Builds the level's three.js meshes from the subsector polygons and linedefs — floors and walls
 * batched by texture, lit per sector (`render/sectorlight.ts`) — and owns {@link doomToWorld}/
 * {@link worldToDoom}, the one place DOOM space and three.js space meet.
 * See docs/render.md § Mesh building.
 */
import * as THREE from 'three';
import { isTextured, type DoomMap } from '../wad/map.ts';
import { buildLeafGraph, buildSubSectorPolys, type SubSectorPoly } from './bsp.ts';
import { lightCellsOf } from './lights.ts';
import type { MaterialBank } from './textures.ts';
import type { Pos3 } from '../types.ts';
import { batchMesh, BatchSet, drawnBatches, fillWallCells, writeAttribute, type Build, type SizeFn } from './mapmesh/build.ts';
import type { BuiltMap, MapMeshOptions, MoverBuild, MoverMesh, SectorTransfers } from './mapmesh/defs.ts';
import { buildFlats, buildSolidCaps } from './mapmesh/flats.ts';
import { applyFlatRefresh, buildMoverFlats, buildMoverWalls, copyRefreshedQuad, planFlatRefresh } from './mapmesh/movers.ts';
import { buildWalls, trimIndex } from './mapmesh/walls.ts';

/** The directory's own surface, handed out here so no importer names an inner file. */
export { markRelit, relightRange } from './mapmesh/build.ts';
export {
  type BuiltMap,
  FLAT_GRID_LEN,
  FLAT_TEX_SIZE,
  type FlatSurface,
  type MapMeshOptions,
  type MoverBuild,
  type MoverIndex,
  type MoverMesh,
  type SectorTransfers,
  WALL_CHUNK_LEN,
  type WallOccluder,
  wallProbePoint,
} from './mapmesh/defs.ts';
export { newDrawnBands, twoSidedBands } from './mapmesh/walls.ts';

/**
 * DOOM's map plane is (x, y) with z as height. three.js is y-up, so a DOOM
 * point (x, y, z) becomes (x, z, -y). Everything below works in DOOM units.
 */
export function doomToWorld(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
}

/**
 * {@link doomToWorld} the other way: a three.js point (x, y, z) is the DOOM point (x, -z, y). A
 * pure axis permutation with no translation, so it maps a *direction* as faithfully as a position
 * — the reason `render/tracer.ts` reuses {@link doomToWorld} the same way.
 * @param out  for a caller on a hot path
 */
export function worldToDoom(x: number, y: number, z: number, out: Pos3 = { x: 0, y: 0, z: 0 }): Pos3 {
  out.x = x;
  out.y = -z;
  out.z = y;
  return out;
}

/**
 * What a map with no Boom transfer lines resolves to: every sector lights and draws itself. Handed
 * to the builders so nothing below branches on whether there is a transfer table at all.
 */
export function ownTransfers(map: DoomMap): SectorTransfers {
  const light = (s: number) => map.sectors[s]?.light ?? 0;
  return {
    floorLight: light,
    ceilingLight: light,
    floorLightSector: (s) => s,
    ceilingLightSector: (s) => s,
    heightSec: () => -1,
    poolBottom: () => -1,
    poolIsland: () => -1,
    drawnCeiling: (s) => map.sectors[s]?.ceilHeight ?? 0,
    drawnFloor: (s) => map.sectors[s]?.floorHeight ?? 0,
    waterHeight: () => null,
    translucentLine: () => false,
    midtexSuppressed: () => false,
    colormapName: () => false,
  };
}

export function buildMapMesh(map: DoomMap, bank: MaterialBank, options: MapMeshOptions = {}): BuiltMap {
  const build = beginBuild(map, buildSubSectorPolys(map), bank, options);
  buildFlats(build);
  buildWalls(build);
  buildSolidCaps(build);
  fillWallCells(build);

  const group = new THREE.Group();
  group.name = 'map:' + map.name;
  let triangles = 0;
  const wallMeshes = new Map<string, THREE.Mesh>();
  const flatMeshes = new Map<string, THREE.Mesh>();

  for (const b of drawnBatches(build)) {
    const mesh = batchMesh(b, bank.get(b.kind, b.texture)!);
    group.add(mesh);
    triangles += b.positions.length / 9;
    if (b.kind === 'wall') wallMeshes.set(b.key, mesh);
    else flatMeshes.set(b.key, mesh);
  }

  // A solid structure's lid is drawn with a *wall* texture (`buildSolidCaps`),
  // so its batch is registered above as a wall mesh — but the lid is a
  // `FlatSurface`, and both `FlatFader` and `MoverGeometry`'s relight index
  // look a surface's mesh up in `flatMeshes`. Register it under both, so a lid
  // fades and relights like the floors it is filed with.
  for (const surface of build.flatSurfaces) {
    if (flatMeshes.has(surface.key)) continue;
    const mesh = wallMeshes.get(surface.key);
    if (mesh) flatMeshes.set(surface.key, mesh);
  }

  return {
    group,
    missingTextures: [...build.missing].sort(),
    triangles,
    trimmedUppers: build.trimmedUppers,
    occluders: build.occluders,
    wallMeshes,
    flatSurfaces: build.flatSurfaces,
    flatMeshes,
    polys: build.polys,
  };
}

/**
 * One sector's touching geometry (its own flats, plus every wall quad on
 * either side of a line bordering it) as a small standalone mesh, for
 * game/specials.ts to own and rebuild whenever that sector's height changes.
 */
export function buildMoverMesh(mover: MoverBuild, sectorIndex: number): MoverMesh {
  const build = beginMoverBuild(mover, sectorIndex);
  buildMoverFlats(build, sectorIndex, mover.index);
  buildMoverWalls(build, sectorIndex, mover.index);
  fillWallCells(build);

  const drawn = drawnBatches(build);
  const group = new THREE.Group();
  const meshes = new Map<string, THREE.Mesh>();
  for (const b of drawn) {
    const mesh = batchMesh(b, mover.bank.get(b.kind, b.texture)!);
    group.add(mesh);
    meshes.set(b.key, mesh);
  }

  return {
    group,
    meshes,
    wallMeshCount: drawn.reduce((n, b) => n + (b.kind === 'wall' ? 1 : 0), 0),
    wallQuads: build.occluders,
    flatFans: build.flatSurfaces,
    trimmedUppers: build.trimmedUppers,
  };
}

/**
 * Rewrites a mover mesh from its sector's current heights **in place**, returning false — mesh
 * untouched — when the geometry no longer fits the buffers it was built with, which is the
 * caller's cue to build a fresh one. Records are updated field-by-field rather than replaced,
 * because the faders hold the arrays. docs/render.md § Mover meshes.
 */
export function refreshMoverMesh(mesh: MoverMesh, mover: MoverBuild, sectorIndex: number): boolean {
  const build = beginMoverBuild(mover, sectorIndex);

  // The flats: re-decided, never re-diced. A leaf whose *set* of fans changed refuses here, before
  // anything is written; what the rest are to move to comes back in `plan`.
  const plan = planFlatRefresh(build, mesh, sectorIndex, mover.index);
  if (plan === null) return false;

  // The walls: rebuilt outright, since a moving height changes which tiers exist at all.
  buildMoverWalls(build, sectorIndex, mover.index);
  const wallQuads = build.occluders;
  const drawn = drawnBatches(build);
  if (drawn.length !== mesh.wallMeshCount || wallQuads.length !== mesh.wallQuads.length) return false;
  // Validated before anything is written, so a refusal can't leave the mesh half-rewritten.
  for (const b of drawn) {
    const attr = mesh.meshes.get(b.key)?.geometry.getAttribute('position');
    if (!attr || attr.array.length !== b.positions.length) return false;
  }

  for (const b of drawn) {
    const geom = mesh.meshes.get(b.key)!.geometry;
    writeAttribute(geom, 'position', b.positions);
    writeAttribute(geom, 'uv', b.uvs);
    writeAttribute(geom, 'color', b.colors);
    writeAttribute(geom, 'aLightSeg', b.segs);
    // `aLightCell` is deliberately not rewritten: a mover changes heights, never a quad's
    // footprint, so the leaf each vertex faces into is the one it was built with.
    geom.computeBoundingSphere();
  }
  for (let i = 0; i < wallQuads.length; i++) copyRefreshedQuad(mesh.wallQuads[i], wallQuads[i]);
  applyFlatRefresh(mesh, plan);
  return true;
}

/**
 * A build over the whole map's static geometry: {@link buildWalls} and {@link buildFlats} drop
 * every line and leaf touching a mover wholesale, so {@link Build.holdsStill} answers true for
 * everything and every side is this build's.
 */
function beginBuild(map: DoomMap, polys: SubSectorPoly[], bank: MaterialBank, options: MapMeshOptions): Build {
  const transfers = options.transfers ?? ownTransfers(map);
  const missing = new Set<string>();
  const size: SizeFn = (kind, name) => {
    // `-`/`''` names no lump that could exist, so it answers without a lookup: the
    // peg-reference probes ask before `addWall`'s own guard — routinely so on a UDMF map's
    // untextured one-sided lines — and `buildMoverWalls` re-probes on every refresh while a
    // mover runs.
    if (!isTextured(name)) return null;
    const s = bank.size(kind, name);
    // A 242 control line's sidedef names colormaps, not textures — absent art
    // there is the feature working, not a hole in the WAD.
    if (!s && !transfers.colormapName(name)) {
      missing.add(kind + ':' + name);
    }
    return s;
  };
  // The one caller with the art, so the one that can seed the trim index — after which the auto
  // camera's rays read the same verdict this build drew. docs/render.md § Ceiling trims.
  trimIndex(map, size);
  return {
    map,
    polys,
    graph: buildLeafGraph(map),
    bank,
    batches: new BatchSet(),
    size,
    missing,
    transfers,
    occluders: [],
    flatSurfaces: [],
    trimmedUppers: 0,
    rebuiltWithNeighbours: false,
    renderCeilings: options.renderCeilings ?? false,
    wallHeightCap: options.wallHeightCap ?? 0,
    movableSectors: options.movableSectors,
    subsectorAt: options.subsectorAt,
    lightCells: lightCellsOf(polys),
    holdsStill: () => true,
  };
}

/** A build over one mover's sector, for {@link buildMoverMesh} and {@link refreshMoverMesh}. */
function beginMoverBuild(mover: MoverBuild, sectorIndex: number): Build {
  const build = beginBuild(mover.map, mover.polys, mover.bank, mover.options);
  const { movingSectors, movableSectors } = mover.options;
  // A sector pulled out of the static batch only so a switch texture can be
  // swapped on it never moves a vertex, so it dices like static geometry.
  // Omitted `movingSectors` means assume they all move, which is the safe half.
  build.holdsStill = (s) => movingSectors !== undefined && !movingSectors.has(s);
  // Own sides always; a neighbour's side only when that neighbour is static —
  // it has no mover of its own to build it, and its upper/lower step is sized
  // from *this* sector's moving heights.
  build.includeSide = (s) => s === sectorIndex || !movableSectors?.has(s);
  build.rebuiltWithNeighbours = true;
  return build;
}
