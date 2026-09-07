/**
 * The shapes a built map is handed around as — the wall quads and flat fans the faders, the
 * scroller and fog of war all index, and what a mover's own mesh is rebuilt from — plus the chunk
 * grid every one of them is diced on. See docs/render.md § Mesh building.
 */
import * as THREE from 'three';
import type { DoomMap } from '../../wad/map.ts';
import type { SubSectorPoly } from '../bsp.ts';
import type { MaterialBank } from '../textures.ts';
import type { Pos2 } from '../../types.ts';
import { vecLength } from '../../util/geom.ts';

/**
 * Boom's render transfers, as much of them as the mesh builder needs:
 * a sector's drawn floor/ceiling light, the height its water surface sits at,
 * and which linedefs draw a translucent midtexture.
 *
 * Declared structurally here, like `ScrollOffsets` in render/scroller.ts, so
 * the renderer keeps no import edge into `game/` — `game/specials/transfers.ts`
 * implements it. See docs/render.md § Sector lighting and § Deep water.
 */
export interface SectorTransfers {
  floorLight(sectorIndex: number): number;
  ceilingLight(sectorIndex: number): number;
  /** Which sector that light came from, for the relight indexes. */
  floorLightSector(sectorIndex: number): number;
  ceilingLightSector(sectorIndex: number): number;
  /** The 242 control sector, or -1. */
  heightSec(sectorIndex: number): number;
  /**
   * The control sector a pool bottom draws with, or -1 where the sector never had water over it.
   */
  poolBottom(sectorIndex: number): number;
  /** The ceiling this sector draws at — its 242 control sector's, else its own. */
  drawnCeiling(sectorIndex: number): number;
  /** The floor this sector draws at where only one is drawn — a 242 fake floor, else its own. */
  drawnFloor(sectorIndex: number): number;
  /** Where this sector's water surface is drawn, or null where there is none. */
  waterHeight(sectorIndex: number): number | null;
  /** The water sector this one is walled in by, or -1 where it is not an island in a pool. */
  poolIsland(sectorIndex: number): number;
  translucentLine(lineIndex: number): boolean;
  midtexSuppressed(lineIndex: number): boolean;
  /** Whether a sidedef texture name is really a colormap lump (a 242 control line's own). */
  colormapName(name: string): boolean;
}

export interface MapMeshOptions {
  /** Ceilings block a top-down camera, so they are off by default. */
  renderCeilings?: boolean;
  /**
   * The level's Boom render transfers. Omitted (tests, and any caller that has
   * no map-wide scan handy) means every sector lights and draws itself.
   */
  transfers?: SectorTransfers;
  /** Walls above this height above their floor are omitted (0 = no limit). */
  wallHeightCap?: number;
  /**
   * Sectors a specials mover drives (game/specials.ts). Every line touching one is left out of the
   * static batches — *both* its sides, since a moving height changes which quads exist on each —
   * and a lid baked against one's height is suppressed too, so an incomplete set leaves stale
   * geometry behind. `buildMoverMesh` builds those sides instead. docs/render.md § Mover meshes.
   */
  movableSectors?: Set<number>;
  /**
   * The subset of `movableSectors` whose planes a special can actually *move* (`scanSectors`'
   * `moving`), as against the ones pulled out only so a switch texture can be swapped. It decides
   * whether a mover's walls dice vertically; omitted means assume they all move.
   * docs/render.md § A mover dices vertically only where nothing moves.
   */
  movingSectors?: Set<number>;
  /**
   * `World.subsectorAt`, injected so the renderer keeps no import edge into `game/`. Supplied,
   * every surface carries the
   * leaf it faces into, which is what lets a dynamic light stop at a wall (docs/lights.md § Light
   * stops at walls); omitted, nothing is gated.
   */
  subsectorAt?: (x: number, y: number) => number;
}

export interface BuiltMap {
  group: THREE.Group;
  /** Names of textures referenced by the map but missing from the WAD. */
  missingTextures: string[];
  triangles: number;
  /**
   * How many upper steps the ceiling-trim rule left out of these batches, which `game.ts` reports
   * at level load. The static geometry's own tally: a line touching a mover is built by
   * `buildMoverMesh` instead and counted nowhere. docs/render.md § Ceiling trims.
   */
  trimmedUppers: number;
  /** Every rendered wall quad, for occlusion-fading the ones between camera and player. */
  occluders: WallOccluder[];
  /** Wall batch meshes by key, so occlusion fading can reach their vertex-alpha attribute. */
  wallMeshes: Map<string, THREE.Mesh>;
  /** Every rendered floor/ceiling triangle fan's vertex range, for fog-of-war fading. */
  flatSurfaces: FlatSurface[];
  /** Flat batch meshes by key, so fog-of-war can reach their vertex-alpha attribute. */
  flatMeshes: Map<string, THREE.Mesh>;
  /**
   * Subsector polygons computed for this build — reused by `buildMoverMesh` so it never re-walks
   * the BSP.
   */
  polys: SubSectorPoly[];
}

/**
 * One rendered wall quad's footprint (2D segment + height range) and its
 * vertex range within its batch, so `WallFader` (render/occlusion.ts) can
 * test it against the camera-player sightline and rewrite just its alpha.
 */
export interface WallOccluder {
  key: string;
  vertexStart: number;
  vertexCount: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  botH: number;
  topH: number;
  /**
   * The full line-side segment this quad was cut from — `WallFader` crosses the sightline against
   * it once per line side, not once per chunk.
   */
  segAx: number;
  segAy: number;
  segBx: number;
  segBy: number;
  /** Sector whose light level this quad was coloured from — for specials-driven relight. */
  sector: number;
  /**
   * Linedef this quad was built from — for `SurfaceScroller` (render/scroller.ts) to find a
   * scrolling line's front side.
   */
  line: number;
  /**
   * The wall texture this quad draws, which `key` encodes — recorded rather than recovered from
   * the key, which would make `batchKey`'s encoding load-bearing in both directions. The
   * `FlatSurface.texName` precedent; `SurfaceScroller` sizes its UV step from it.
   */
  texName: string;
  /**
   * True if this quad came from the linedef's front (right) sidedef — vanilla's `sidenum[0]`, the
   * only side a scrolling special ever animates.
   */
  frontSide: boolean;
  /**
   * The BSP leaf this quad's face looks into, or -1 with no probe — resolved by `fillWallCells`.
   */
  subsector: number;
  /**
   * Permanent translucency, multiplied into the vertex alpha the faders write
   * (render/occlusion.ts). Only a Boom 260 midtexture has one.
   */
  baseAlpha?: number;
}

/**
 * The longest quad `addWall` emits before cutting a wall into several, so the occlusion fade has
 * vertices to put a gradient on. **Tuned by feel** against vertex count, which grows with
 * `1 / this`, and carrying an unenforced relationship to `occlusion.ts`'s `FADE_CORE` —
 * docs/render.md § The fade is a hole, not a wall.
 *
 * The *vertical* cut is the one a mover cannot always have, since the band count follows the
 * height: docs/render.md § A mover dices vertically only where nothing moves, and
 * `Build.holdsStill`.
 */
export const WALL_CHUNK_LEN = 128;

/**
 * How far past a wall's face its leaf is probed. A face sits exactly on the boundary between the
 * room it looks into and whatever is behind it, so the sample has to step off it. **Tuned by
 * feel**: far enough to clear whatever rounding the boundary left, far short of anything the BSP
 * would put on the other side.
 */
const WALL_PROBE_OFFSET = 1.5;

/**
 * The point a wall quad's leaf is probed at: the face's midpoint, stepped `WALL_PROBE_OFFSET` off
 * the front side (`addWall` builds every quad facing right of a→b). The one definition, so fog of
 * war cannot disagree about which room a quad faces — docs/fogofwar.md § Mover wall quads. Writes
 * into `out`: the fog path runs it per mover quad per refresh.
 */
export function wallProbePoint(ax: number, ay: number, bx: number, by: number, out: Pos2): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = vecLength(dx, dy) || 1;
  out.x = (ax + bx) / 2 + (dy / len) * WALL_PROBE_OFFSET;
  out.y = (ay + by) / 2 + (-dx / len) * WALL_PROBE_OFFSET;
}

/**
 * One rendered floor/ceiling triangle fan's vertex range within its batch,
 * so `FogOfWar` (game/fogofwar.ts) can rewrite its alpha the same way
 * `WallOccluder` lets `WallFader` rewrite a wall's. Keyed by subsector, not
 * sector — see FogOfWar's class doc for why the distinction matters.
 */
export interface FlatSurface {
  key: string;
  /**
   * The texture this fan draws, which `key` encodes — kept apart so a refresh can match without
   * building one.
   */
  texName: string;
  vertexStart: number;
  vertexCount: number;
  subsector: number;
  /** Sector this fan belongs to — for specials-driven relight. */
  sector: number;
  /**
   * Sector this fan's colour was taken from — its own, unless a Boom light
   * transfer or a deep-water bottom borrowed another's (docs/specials.md
   * § Render transfers). This is what `MoverGeometry` files its relight index
   * under, so recoloring the *source* repaints everything drawing from it.
   */
  lightSector: number;
  /**
   * DOOM (x, y) footprint of this subsector, flattened — the outline, used to place things against
   * the fan.
   */
  points: Float64Array;
  /**
   * DOOM (x, y) of every vertex this fan drew, in draw order — what `FlatFader` measures each
   * vertex's own fade from. Separate from `points` because the fan is diced finer than its outline
   * (`addFlatFan`), and single-precision because the only thing read off it is a distance.
   */
  vertexXY: Float32Array;
  /** World height (floor or ceiling) this surface sits at. */
  height: number;
  /**
   * The light level this fan's colour was last written from — carried here rather than recovered
   * from the colour attribute, which cannot answer for it. docs/render.md § Mover meshes.
   */
  light: number;
  isCeiling: boolean;
  /**
   * Permanent translucency, multiplied into the vertex alpha the faders write
   * (render/occlusion.ts). Only a 242 water surface has one.
   */
  baseAlpha?: number;
}

/**
 * The world-aligned grid `addFlatFan` dices a flat on. Derived rather than tuned: a square cell
 * split by its diagonal leaves that diagonal as its longest edge, so this is the widest cell whose
 * edges still obey `WALL_CHUNK_LEN`. docs/render.md § Flats are diced on a world grid.
 */
export const FLAT_GRID_LEN = WALL_CHUNK_LEN / Math.SQRT2;

/**
 * How far a diced flat cell reaches from the centre of the grid square it was cut out of: half
 * that square's diagonal, `WALL_CHUNK_LEN / 2` = 64. What `addFlatFan` hands `LightCells.cellFor`,
 * and one of the two halves `LIGHT_CELL_MARGIN` is sized against.
 */
export const FLAT_CELL_EXTENT = (FLAT_GRID_LEN * Math.SQRT2) / 2;

/**
 * Every flat lump is 64x64 and aligned to the world grid, so a flat's UVs divide by this rather
 * than by a per-texture size — `render/scroller.ts` steps a scrolling flat's offset by the same
 * number.
 */
export const FLAT_TEX_SIZE = 64;

/**
 * Which subsectors and linedefs a sector owns — what keeps a rebuild proportional to the sector
 * rather than to the map. Declared structurally here like `SectorTransfers`, and supplied by
 * `game/specials/movergeometry.ts`. docs/render.md § Mover meshes.
 */
export interface MoverIndex {
  subsectorsOf(sectorIndex: number): readonly number[];
  linesOf(sectorIndex: number): readonly number[];
}

/**
 * What building or refreshing a mover's mesh takes beside the sector index — one record, since
 * `buildMoverMesh` and `refreshMoverMesh` need exactly the same and `MoverGeometry` holds it for
 * the level's lifetime.
 */
export interface MoverBuild {
  map: DoomMap;
  /**
   * The array `buildMapMesh` returned, or an equivalent from `buildSubSectorPolys`: subsector
   * footprints don't depend on sector height, so recomputing them per mover per frame would be
   * pure waste.
   */
  polys: SubSectorPoly[];
  bank: MaterialBank;
  /**
   * `movableSectors` is required here, not merely honoured — it is what decides which of a shared
   * line's two sides this mover owns, and without it a line between two movers would have both of
   * them build both sides — so the type demands it rather than leaving it to prose.
   */
  options: MapMeshOptions & { movableSectors: Set<number> };
  /** What keeps a rebuild proportional to the sector rather than to the map. */
  index: MoverIndex;
}

/** One sector's worth of dynamic geometry — see `buildMoverMesh`. */
export interface MoverMesh {
  group: THREE.Group;
  meshes: Map<string, THREE.Mesh>;
  /**
   * How many of `meshes` draw walls, which a refresh compares its rebuilt batches against to
   * decide whether the buffers still fit. Recorded rather than recovered from the keys, which
   * would make `batchKey`'s encoding load-bearing in both directions.
   */
  wallMeshCount: number;
  wallQuads: WallOccluder[];
  flatFans: FlatSurface[];
  /** How many upper steps this sector's build left out — `BuiltMap.trimmedUppers`' twin. */
  trimmedUppers: number;
}
