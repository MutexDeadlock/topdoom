/**
 * Builds the level's three.js meshes from the subsector polygons and linedefs — floors and walls
 * batched by texture, lit per sector — and owns `doomToWorld`/`worldToDoom`, the one place DOOM
 * space and three.js space meet. See docs/render.md § Mesh building and § Sector lighting.
 */
import * as THREE from 'three';
import {
  LF,
  NO_LINE,
  NO_SIDE,
  segBackSide,
  segSide,
  SKY_FLAT,
  type DoomMap,
  type LineDef,
  type SideDef,
  type Sector,
} from '../wad/map.ts';
import { buildLeafGraph, buildSubSectorPolys, type LeafGraph, type SectorPoly, type SubSectorPoly } from './bsp.ts';
import { findSolidCaps, pointInPolygon, type SolidCap } from './solids.ts';
import type { MaterialBank, Size, SurfaceKind } from './textures.ts';
import type { Pos2, Pos3 } from '../types.ts';
import { BRIGHTNESS_LIFT, WATER_SURFACE_ALPHA } from '../constants.ts';
import { clipConvexPolygon, signedPolygonArea2 } from '../util/geom.ts';

/**
 * DOOM's sentinel for "no texture assigned" in a sidedef texture slot — also used by
 * `game/specials.ts`'s `raiseToTexture` to skip unset bottom textures.
 */
export const NO_TEXTURE = '-';

/**
 * DOOM's map plane is (x, y) with z as height. three.js is y-up, so a DOOM
 * point (x, y, z) becomes (x, z, -y). Everything below works in DOOM units.
 */
export function doomToWorld(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
}

/**
 * `doomToWorld` the other way: a three.js point (x, y, z) is the DOOM point
 * (x, -z, y). A pure axis permutation with no translation, so it maps a
 * *direction* as faithfully as a position — the reason `render/tracer.ts` reuses
 * `doomToWorld` the same way. Takes an optional `out` for a caller on a hot path.
 */
export function worldToDoom(x: number, y: number, z: number, out: Pos3 = { x: 0, y: 0, z: 0 }): Pos3 {
  out.x = x;
  out.y = -z;
  out.z = y;
  return out;
}

/**
 * What each of `COLORMAP`'s 32 rows does to brightness, as a **linear-light** multiplier —
 * measured from the real lump, one baked table for DOOM, DOOM2 and Freedoom.
 * docs/render.md § Sector lighting.
 */
const COLORMAP_GAIN = [
  1.0, 0.9662, 0.9055, 0.8253, 0.7552, 0.6956, 0.6437, 0.584,
  0.5366, 0.4949, 0.4492, 0.4067, 0.3632, 0.3282, 0.2946, 0.2627,
  0.2317, 0.2023, 0.1765, 0.1526, 0.1312, 0.1086, 0.0918, 0.0758,
  0.0621, 0.0492, 0.0383, 0.0288, 0.0202, 0.0142, 0.0082, 0.0034,
];

/**
 * `r_main.c`'s `scale/DISTMAP` distance term, sampled at one fixed viewing distance since this
 * engine has no distance lighting. **The knob to turn if the whole game reads too dark or too
 * bright** — docs/render.md § Sector lighting.
 */
const REFERENCE_STEPS = 4;

/** `COLORMAP_GAIN` folded down to one entry per light segment, built once. */
const LIGHT_GAIN = Array.from({ length: 16 }, (_, seg) => {
  const row = (15 - seg) * 4 - REFERENCE_STEPS;
  return COLORMAP_GAIN[Math.max(0, Math.min(31, row))];
});

/**
 * Sector light level (0..255) as a **linear-light** vertex colour — not a display value, since the
 * renderer's `outputColorSpace` encodes the fragment on the way out. `contrast` is the
 * fake-contrast offset in light units, of which ±16 is vanilla's ±1 segment.
 * docs/render.md § Sector lighting.
 */
export function lightToColor(light: number, contrast = 0): number {
  const clamped = Math.max(0, Math.min(255, light + contrast));
  return LIGHT_GAIN[clamped >> 4];
}

/**
 * The fake-contrast offset for a wall running from (ax,ay) to (bx,by) — the
 * one true copy, so `addWall` and `SpecialsController.recolorSector` (which
 * needs to redo this per-quad when a sector's light changes at runtime) can't
 * drift apart.
 */
export function wallContrast(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dy === 0 ? -16 : dx === 0 ? 16 : 0;
}

/**
 * A "lift" toward full brightness: pushes `linear` up by a fraction `lift` of its remaining
 * headroom `(1 - linear)`, so the darker a surface already is the more it moves. `lift = 0` is a
 * no-op, `lift = 1` flattens everything to full bright. docs/render.md § Sector lighting.
 */
export function applyBrightnessLift(linear: number, lift: number): number {
  const l = Math.max(0, Math.min(1, lift));
  return linear + l * (1 - linear);
}

/**
 * `lightToColor` plus `BRIGHTNESS_LIFT` (`constants.ts`) — what every real draw call uses.
 * `lightToColor` itself stays pure and vanilla-exact, so it can be verified in isolation.
 */
export function litColor(light: number, contrast = 0): number {
  return applyBrightnessLift(lightToColor(light, contrast), BRIGHTNESS_LIFT);
}

/**
 * The longest quad `addWall` emits before cutting a wall into several, so the occlusion fade has
 * vertices to put a gradient on. **Tuned by feel** against vertex count, which grows with
 * `1 / this`, and carrying an unenforced relationship to `occlusion.ts`'s `FADE_CORE` —
 * docs/render.md § The fade is a hole, not a wall.
 *
 * The *vertical* cut is the one a mover cannot always have, since the band count follows the
 * height: docs/render.md § A mover dices vertically only where nothing moves, and `Build.holdsStill`.
 */
export const WALL_CHUNK_LEN = 128;

/**
 * The world-aligned grid `addFlatFan` dices a flat on. Derived rather than tuned: a square cell
 * split by its diagonal leaves that diagonal as its longest edge, so this is the widest cell whose
 * edges still obey `WALL_CHUNK_LEN`. docs/render.md § Flats are diced on a world grid.
 */
export const FLAT_GRID_LEN = WALL_CHUNK_LEN / Math.SQRT2;

/**
 * Every flat lump is 64x64 and aligned to the world grid, so a flat's UVs divide by this rather
 * than by a per-texture size — `render/scroller.ts` steps a scrolling flat's offset by the same
 * number.
 */
export const FLAT_TEX_SIZE = 64;

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
 * into `out`: the fog path runs it per mover quad per tic.
 */
export function wallProbePoint(ax: number, ay: number, bx: number, by: number, out: Pos2): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  out.x = (ax + bx) / 2 + (dy / len) * WALL_PROBE_OFFSET;
  out.y = (ay + by) / 2 + (-dx / len) * WALL_PROBE_OFFSET;
}

/** The two solid tiers one side of a two-sided line draws — see `twoSidedBands`. */
export interface DrawnBands {
  /** The lower step, drawn when `lowerTop > lowerBot`. */
  lowerBot: number;
  lowerTop: number;
  /** The upper step, drawn when `upperTop > upperBot` and not `skyPair`. */
  upperBot: number;
  upperTop: number;
  /** Two sky ceilings, between which vanilla draws no upper at all. */
  skyPair: boolean;
}

/**
 * **Which bands one side of a two-sided line draws, and how tall** — the heights resolved through
 * Boom's 242 transfers rather than read off the two sectors. Exported because the auto camera asks
 * the same question (`autocamera.ts`'s `hidesFromCamera`), and the one owner of the rule so the
 * two cannot drift; written into a caller's record, so neither allocates.
 *
 * `wallHeightCap` is deliberately *not* applied here: no occlusion question wants a wall shortened
 * by a build option. docs/render.md § Mesh building.
 */
export function twoSidedBands(
  transfers: SectorTransfers,
  sec: Sector,
  secIndex: number,
  other: Sector,
  otherIndex: number,
  out: DrawnBands,
): void {
  out.lowerBot = transfers.drawnFloor(secIndex);
  out.lowerTop = transfers.drawnFloor(otherIndex);
  out.upperBot = ceilingFacing(transfers, other, otherIndex, secIndex);
  out.upperTop = sec.ceilHeight;
  out.skyPair = sec.ceilTex === SKY_FLAT && other.ceilTex === SKY_FLAT;
}

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
  /** The BSP leaf this quad's face looks into, or -1 with no probe — resolved by `fillWallCells`. */
  subsector: number;
  /**
   * Permanent translucency, multiplied into the vertex alpha the faders write
   * (render/occlusion.ts). Only a Boom 260 midtexture has one.
   */
  baseAlpha?: number;
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
    // `aLightCell` is deliberately not rewritten: a mover changes heights, never a quad's
    // footprint, so the leaf each vertex faces into is the one it was built with.
    geom.computeBoundingSphere();
  }
  for (let i = 0; i < wallQuads.length; i++) copyRefreshedQuad(mesh.wallQuads[i], wallQuads[i]);
  applyFlatRefresh(mesh, plan);
  return true;
}

interface Batch {
  key: string;
  kind: SurfaceKind;
  texture: string;
  positions: number[];
  uvs: number[];
  colors: number[];
  /**
   * Per vertex, the BSP leaf the surface faces into — the `aLightCell` attribute (docs/lights.md §
   * Light stops at walls).
   */
  cells: number[];
}

/** The batches a build is accumulating into, one per `batchKey`. */
class BatchSet {
  private batches = new Map<string, Batch>();

  get(kind: SurfaceKind, texture: string): Batch {
    const key = batchKey(kind, texture);
    let b = this.batches.get(key);
    if (!b) {
      b = { key, kind, texture, positions: [], uvs: [], colors: [], cells: [] };
      this.batches.set(key, b);
    }
    return b;
  }

  /**
   * The batch `key` names, or undefined — `WallOccluder.key` is the same `kind + ':' + texture`.
   */
  byKey(key: string): Batch | undefined {
    return this.batches.get(key);
  }

  all(): Batch[] {
    return [...this.batches.values()];
  }
}

/** A batch's identity, and the key `MoverMesh.meshes` files its three.js mesh under. */
function batchKey(kind: SurfaceKind, texture: string): string {
  return kind + ':' + texture;
}

/**
 * One vertex into a batch's four attribute arrays. Scalars rather than a record, and the file's
 * only signature this long: it runs once per emitted vertex, so a point parameter would allocate
 * one per vertex — docs/conventions.md § Named arguments.
 */
function pushVertex(
  b: Batch,
  x: number,
  y: number,
  z: number,
  u: number,
  v: number,
  c: number,
  alpha = 1,
  /**
   * -1 leaves the leaf unresolved: wall quads get theirs from `fillWallCells` once the occluders
   * exist.
   */
  cell = -1,
): void {
  b.positions.push(x, y, z);
  b.uvs.push(u, v);
  b.colors.push(c, c, c, alpha);
  b.cells.push(cell);
}

/**
 * Resolves each wall quad's leaf and stamps it onto that quad's vertices, so the dynamic-light
 * shader can ask whether a light reached the room this wall faces. Runs once the quads exist
 * rather than inside `addWall`, for a value the occluder records anyway. Without
 * `MapMeshOptions.subsectorAt` (tests, tools) the quads stay at -1, which the shader reads as an
 * empty light list — unlit. docs/lights.md § Light stops at walls.
 */
function fillWallCells(build: Build): void {
  const { subsectorAt, batches } = build;
  if (!subsectorAt) return;
  const probe: Pos2 = { x: 0, y: 0 };
  for (const o of build.occluders) {
    if (Math.hypot(o.bx - o.ax, o.by - o.ay) < 1e-6) continue;
    wallProbePoint(o.ax, o.ay, o.bx, o.by, probe);
    o.subsector = subsectorAt(probe.x, probe.y);
    const cells = batches.byKey(o.key)?.cells;
    if (!cells) continue;
    for (let v = 0; v < o.vertexCount; v++) cells[o.vertexStart + v] = o.subsector;
  }
}

type SizeFn = (kind: SurfaceKind, name: string) => Size | null;

/**
 * The working set every builder below threads: the map, the options resolved once, and the
 * batches and records they append to. One covers either the whole map's static geometry or a
 * single mover's sector — which of the two is `holdsStill`/`includeSide`, and nothing else here
 * knows the difference. See docs/render.md § Mesh building.
 */
interface Build {
  map: DoomMap;
  /** Subsector footprints, shared with the mover builds — see `MoverBuild.polys`. */
  polys: SubSectorPoly[];
  /** Which leaves border which, over those same footprints — what `floodClosedHole` walks. */
  graph: LeafGraph;
  bank: MaterialBank;
  batches: BatchSet;
  /** Texture dimensions, recording into `missing` whatever the WAD has no lump for. */
  size: SizeFn;
  missing: Set<string>;
  transfers: SectorTransfers;
  /** Every wall quad emitted, appended in draw order. */
  occluders: WallOccluder[];
  /** Every flat fan emitted, appended in draw order. */
  flatSurfaces: FlatSurface[];
  renderCeilings: boolean;
  wallHeightCap: number;
  movableSectors?: Set<number>;
  subsectorAt?: (x: number, y: number) => number;
  /**
   * Whether this build is redone when a *neighbouring* sector moves, which only a mover's is
   * (`MoverGeometry`). It decides whether a closed hole may rest its lid on a movable rim: baked
   * once into the static batches that would go stale, rebuilt alongside it it cannot.
   */
  rebuiltWithNeighbours: boolean;
  /**
   * Whether a sector's floor and ceiling hold still, so a quad sized against it may be diced
   * vertically — see `WALL_CHUNK_LEN` and docs/render.md § A mover dices vertically only where
   * nothing moves.
   */
  holdsStill(sectorIndex: number): boolean;
  /**
   * Which sides this build owns, or undefined for every side. Side granularity rather than line
   * granularity for the one case where a line's two sides have different owners: between two
   * movable sectors (a switch mounted on a lift's own frame, say) each mover builds only its own
   * side, or both would build both and double every quad.
   */
  includeSide?(sectorIndex: number): boolean;
}

/**
 * A build over the whole map's static geometry. Everything left in it is static — `buildWalls`
 * and `buildFlats` drop every line and leaf touching a mover wholesale — so `holdsStill` answers
 * true for everything and every side is this build's.
 */
function beginBuild(map: DoomMap, polys: SubSectorPoly[], bank: MaterialBank, options: MapMeshOptions): Build {
  const transfers = options.transfers ?? ownTransfers(map);
  const missing = new Set<string>();
  return {
    map,
    polys,
    graph: buildLeafGraph(map),
    bank,
    batches: new BatchSet(),
    size: (kind, name) => {
      const s = bank.size(kind, name);
      // A 242 control line's sidedef names colormaps, not textures — absent art
      // there is the feature working, not a hole in the WAD.
      if (!s && !transfers.colormapName(name)) missing.add(kind + ':' + name);
      return s;
    },
    missing,
    transfers,
    occluders: [],
    flatSurfaces: [],
    rebuiltWithNeighbours: false,
    renderCeilings: options.renderCeilings ?? false,
    wallHeightCap: options.wallHeightCap ?? 0,
    movableSectors: options.movableSectors,
    subsectorAt: options.subsectorAt,
    holdsStill: () => true,
  };
}

/** A build over one mover's own sector — `buildMoverMesh` and `refreshMoverMesh` share it. */
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

/** The batches that end up on screen: the ones that emitted anything and whose art the bank has. */
function drawnBatches(build: Build): Batch[] {
  return build.batches.all().filter((b) => b.positions.length > 0 && build.bank.get(b.kind, b.texture));
}

/** One batch as a three.js mesh: the four attributes every surface carries, named by its key. */
function batchMesh(batch: Batch, material: THREE.Material): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(batch.colors, 4));
  geom.setAttribute('aLightCell', new THREE.Float32BufferAttribute(batch.cells, 1));
  geom.computeBoundingSphere();

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = batch.key;
  return mesh;
}

/**
 * What one fan of a refreshed mover is to be moved to — `planFlatRefresh` decides it,
 * `applyFlatRefresh` writes it.
 */
interface FlatPlan {
  height: number;
  light: number;
  lightSector: number;
}

/** `planFlatRefresh`'s output, reused: a mover refresh happens per moving sector per tic. */
const flatPlan: FlatPlan[] = [];

/**
 * Whether a mover's flats can be moved in place, and where to — one entry per `mesh.flatFans`;
 * null is a refusal. A tic can lift a fan's plane and relight it but never change its footprint,
 * so the specs are re-decided without emitting geometry and matched against the fans the mesh
 * holds. docs/render.md § Mover meshes.
 */
function planFlatRefresh(build: Build, mesh: MoverMesh, sectorIndex: number, index: MoverIndex): FlatPlan[] | null {
  const fans = mesh.flatFans;
  beginHoleFills(build);
  let at = 0;
  for (const ss of index.subsectorsOf(sectorIndex)) {
    const count = flatSpecsOf(build, build.polys[ss], closedHoleFill(ss), flatSpecs);
    // A leaf too degenerate to have produced a vertex produced no fan either, and never will.
    // `buildMoverFlats` appended the rest in this same order.
    if (fans[at]?.subsector !== ss) continue;
    for (let i = 0; i < count; i++) {
      const spec = flatSpecs[i];
      if (!flatArt('flat', spec.texName, build.size)) continue;
      const fan = fans[at];
      if (
        fan === undefined ||
        fan.subsector !== ss ||
        fan.texName !== spec.texName ||
        fan.isCeiling !== spec.isCeiling ||
        fan.baseAlpha !== spec.baseAlpha
      ) {
        return null;
      }
      const plan = (flatPlan[at] ??= { height: 0, light: 0, lightSector: 0 });
      plan.height = spec.height;
      plan.light = spec.light;
      plan.lightSector = spec.lightSector;
      at++;
    }
    // A fan of this leaf the specs did not account for: the set changed, which is a refusal.
    if (fans[at]?.subsector === ss) return null;
  }
  return at === fans.length ? flatPlan : null;
}

/** `applyFlatRefresh`'s set of keys to re-upload — module scratch, one mover refresh at a time. */
const touchedFlatKeys = new Set<string>();

/** Lifts every fan of a refreshed mover to the plane and colour `planFlatRefresh` settled on. */
function applyFlatRefresh(mesh: MoverMesh, plan: FlatPlan[]): void {
  const touched = touchedFlatKeys;
  touched.clear();
  for (let i = 0; i < mesh.flatFans.length; i++) {
    const fan = mesh.flatFans[i];
    const { height, light, lightSector } = plan[i];
    fan.lightSector = lightSector;
    // Nothing moved and nothing relit — the common case for a mover's ceiling while its floor
    // runs. Both halves read the fan's own record, before the mesh is looked up at all.
    if (fan.height === height && fan.light === light) continue;
    const geom = mesh.meshes.get(fan.key)?.geometry;
    if (!geom) continue;
    const pos = geom.getAttribute('position').array as Float32Array;
    const col = geom.getAttribute('color').array as Float32Array;
    const color = litColor(light);
    fan.height = height;
    fan.light = light;
    const end = fan.vertexStart + fan.vertexCount;
    for (let v = fan.vertexStart; v < end; v++) {
      // Only the plane: x and z are the footprint, which never moves.
      pos[v * 3 + 1] = height;
      col[v * 4] = color;
      col[v * 4 + 1] = color;
      col[v * 4 + 2] = color;
    }
    touched.add(fan.key);
  }
  for (const key of touched) {
    const geom = mesh.meshes.get(key)!.geometry;
    geom.getAttribute('position').needsUpdate = true;
    geom.getAttribute('color').needsUpdate = true;
    geom.computeBoundingSphere();
  }
}

/**
 * Copies a rebuilt quad over the live one, preserving what a rebuild cannot know: a mover changes
 * heights, never a footprint, so `subsector` keeps the leaf the build-time probe resolved rather
 * than the -1 `buildMoverWalls` emits — re-probing would be a BSP descent per quad per tic. Same
 * rule as `aLightCell` above, stated here so the next footprint-fixed field on `WallOccluder` is
 * handled where the exception already lives.
 */
function copyRefreshedQuad(dst: WallOccluder, src: WallOccluder): void {
  const subsector = dst.subsector;
  Object.assign(dst, src);
  dst.subsector = subsector;
}

function writeAttribute(geom: THREE.BufferGeometry, name: string, values: number[]): void {
  const attr = geom.getAttribute(name) as THREE.BufferAttribute;
  (attr.array as Float32Array).set(values);
  attr.needsUpdate = true;
}

/**
 * The flat half of a mover's geometry: its own sector's leaves, lids included. A refresh
 * re-decides these without emitting any (`planFlatRefresh`), because a mover changes a flat's
 * plane and its light but never its footprint — docs/render.md § Mover meshes.
 */
function buildMoverFlats(build: Build, sectorIndex: number, index: MoverIndex): void {
  // No `movableSectors` here on purpose: a mover is rebuilt alongside its
  // movable neighbours, so its lids cannot go stale against one.
  beginHoleFills(build);
  for (const ss of index.subsectorsOf(sectorIndex)) processFlat(build, build.polys[ss], ss, closedHoleFill(ss));
}

/**
 * The wall half, alone — the half `refreshMoverMesh` must rebuild every tic, because a moving
 * height changes not just where a quad's corners sit but *which* tiers exist (an upper step
 * shrinks to nothing as a door opens).
 */
function buildMoverWalls(build: Build, sectorIndex: number, index: MoverIndex): void {
  for (const lineIndex of index.linesOf(sectorIndex)) {
    processLine(build, build.map.linedefs[lineIndex], lineIndex);
  }
}

/** True if either side of `line` belongs to a sector in `sectors`. */
function touchesAny(map: DoomMap, line: LineDef, sectors: Set<number>): boolean {
  const front = line.right !== NO_SIDE ? map.sidedefs[line.right] : undefined;
  const back = line.left !== NO_SIDE ? map.sidedefs[line.left] : undefined;
  return (front !== undefined && sectors.has(front.sector)) || (back !== undefined && sectors.has(back.sector));
}

/** Floors and ceilings, triangulated per subsector (each one is convex). */
function buildFlats(build: Build): void {
  const { polys, movableSectors } = build;
  beginHoleFills(build);
  for (let ss = 0; ss < polys.length; ss++) {
    if (movableSectors?.has(polys[ss].sector)) continue;
    processFlat(build, polys[ss], ss, closedHoleFill(ss));
  }
}

/**
 * Lids over the map's solid structures — the rings of one-sided linedefs that enclose no sector
 * (`render/solids.ts`). One `FlatSurface` **per triangle**, not one per lid: a ring is often
 * concave, and `FlatFader` tests footprints with a convex-only helper.
 * docs/render.md § Solid structures.
 */
function buildSolidCaps(build: Build): void {
  const { map, polys, size, transfers } = build;
  for (const cap of findSolidCaps(map, polys)) {
    if (!size('wall', cap.texture)) continue;
    const subsector = subsectorNear(polys, cap);
    if (subsector < 0) continue;
    const light = transfers.ceilingLight(cap.sector);
    const lightSector = transfers.ceilingLightSector(cap.sector);
    for (const triangle of triangulate(cap.points)) {
      addFlatFan(
        build,
        { points: triangle, sector: cap.sector },
        subsector,
        { texName: cap.texture, height: cap.height, light, lightSector, isCeiling: false },
        'wall',
      );
    }
  }
}

/**
 * The subsector the lid's outside probe lands in — how fog of war decides whether it has been seen.
 */
function subsectorNear(polys: SubSectorPoly[], cap: SolidCap): number {
  let fallback = -1;
  for (const [ss, poly] of polys.entries()) {
    if (poly.sector !== cap.sector) continue;
    if (fallback < 0) fallback = ss;
    if (pointInPolygon(poly.points, cap.probeX, cap.probeY)) return ss;
  }
  return fallback;
}

/** Ear-clips a ring into triangles, using three's own routine rather than a second copy of one. */
function triangulate(points: Float64Array): Float64Array[] {
  const contour: THREE.Vector2[] = [];
  for (let i = 0; i < points.length; i += 2) contour.push(new THREE.Vector2(points[i], points[i + 1]));
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return [];
  }
  return faces.map((face) => {
    const tri = new Float64Array(6);
    for (const [i, index] of face.entries()) {
      tri[i * 2] = contour[index].x;
      tri[i * 2 + 1] = contour[index].y;
    }
    return tri;
  });
}

/**
 * Most leaves one closed hole may span. **Tuned by feel**: a bound on how far a broken map can
 * drag the flood, well past the largest region any of the committed WADs produces.
 */
const HOLE_REGION_MAX = 4096;

/** A closed hole the flood accepted: every leaf it covers, and the sector whose floor lids them. */
interface HoleRegion {
  leaves: number[];
  fill: number;
}

/** One list per map, weak on it like `bsp.ts`'s polygons — see `holeSeedLeaves`. */
const holeSeeds = new WeakMap<DoomMap, Int32Array>();

/**
 * Which leaves could seed a hole: those with a two-sided seg drawing no lower texture, the
 * `AddLowerMissingTexture` case GZDoom collects while it walks the walls. Whether that seg is a
 * *step* moves with the floors, but which segs are bare does not, so the list is built once — what
 * keeps a pass proportional to the candidates rather than to the level.
 */
function holeSeedLeaves(map: DoomMap): Int32Array {
  const cached = holeSeeds.get(map);
  if (cached) return cached;
  const seeds: number[] = [];
  for (let leaf = 0; leaf < map.subsectors.length; leaf++) {
    const ss = map.subsectors[leaf];
    for (let i = 0; i < ss.count; i++) {
      const seg = map.segs[ss.first + i];
      if (!seg || seg.linedef === NO_LINE) continue;
      const line = map.linedefs[seg.linedef];
      if (!line || line.left === NO_SIDE || line.right === NO_SIDE) continue;
      const own = map.sidedefs[segSide(line, seg.direction)];
      const back = map.sidedefs[segBackSide(line, seg.direction)];
      if (!own || !back || own.sector === back.sector) continue;
      if (own.lower !== NO_TEXTURE && own.lower !== '') continue;
      seeds.push(leaf);
      break;
    }
  }
  const result = Int32Array.from(seeds);
  holeSeeds.set(map, result);
  return result;
}

/**
 * `closedHoleFill`'s answers, one slot per leaf, as module scratch. `stamp` is what spares clearing
 * a map-sized array per pass: a leaf answered in an earlier pass reads as unanswered in this one.
 * The rest is what lets a pass be skipped — see `beginHoleFills`.
 */
const holeFills = {
  fills: new Int32Array(0),
  stamp: new Int32Array(0),
  pass: 0,
  map: null as DoomMap | null,
  signature: 0,
  rimsMayMove: false,
  movable: undefined as Set<number> | undefined,
};

/**
 * A number that changes whenever any floor does — what decides whether the last pass still stands.
 * Nothing else the flood reads moves during a level: which sidedef slots are bare survives a switch
 * swap (a bare slot carries no switch), and a 242 is fixed at load.
 */
function floorSignature(map: DoomMap): number {
  let sum = 0;
  let mix = map.sectors.length;
  for (const sector of map.sectors) {
    sum = (sum + sector.floorHeight) | 0;
    mix = (Math.imul(mix, 0x01000193) ^ sector.floorHeight) | 0;
  }
  return (sum ^ mix) | 0;
}

/**
 * Redecides every hole on the map, at the heights the sectors stand at now — the pass that has to
 * precede any `closedHoleFill`.
 *
 * Running it over the whole map even for a mover, which rebuilds one sector's leaves alone, is a
 * **deliberate deviation** from GZDoom, whose hack is per frame over whatever the wall pass just
 * recorded. A region is seeded from the leaf that carries the missing texture, and that leaf need
 * not be in the sector being rebuilt: overboard.wad MAP02's sunken boat spans 16 sectors, every one
 * of them a mover, and only sector 112's leaves touch the sea it hides under. `holeSeedLeaves`
 * keeps the cost off the level's size.
 */
function beginHoleFills(build: Build): void {
  const leafCount = build.polys.length;
  const signature = floorSignature(build.map);
  // Every mover redoing this per tic is most of a frame on a detailed map; nothing it reads has
  // moved since the last one unless a floor has.
  if (
    holeFills.map === build.map &&
    holeFills.signature === signature &&
    holeFills.rimsMayMove === build.rebuiltWithNeighbours &&
    holeFills.movable === build.movableSectors &&
    holeFills.fills.length >= leafCount
  ) {
    return;
  }
  if (holeFills.fills.length < leafCount) {
    holeFills.fills = new Int32Array(leafCount);
    holeFills.stamp = new Int32Array(leafCount);
    holeFills.pass = 0;
  }
  holeFills.map = build.map;
  holeFills.signature = signature;
  holeFills.rimsMayMove = build.rebuiltWithNeighbours;
  holeFills.movable = build.movableSectors;
  holeFills.pass++;
  for (const seed of holeSeedLeaves(build.map)) {
    if (holeFills.stamp[seed] === holeFills.pass) continue;
    const region = floodClosedHole(build, seed);
    if (!region) continue;
    for (const covered of region.leaves) {
      holeFills.stamp[covered] = holeFills.pass;
      holeFills.fills[covered] = region.fill;
    }
  }
}

/**
 * The neighbouring sector a **leaf** closes itself over, or -1 where it is ordinary geometry: a
 * region of leaves ringed entirely by untextured drops is a hole the mapper never meant anyone to
 * look into, and this camera looks into every pit. Reads what `beginHoleFills` settled.
 * docs/render.md § Closed holes.
 */
function closedHoleFill(leaf: number): number {
  return holeFills.stamp[leaf] === holeFills.pass ? holeFills.fills[leaf] : -1;
}

/**
 * The hole `start` opens onto, or null where it opens onto none. GZDoom's `DoOneSectorLower`
 * (`hw_renderhacks.cpp`): the plane comes from the highest floor the seed's own missing lower
 * textures adjoin, and the flood then spreads across every leaf below it, giving up the moment
 * anything says the region is a room rather than a pit.
 */
function floodClosedHole(build: Build, start: number): HoleRegion | null {
  const { map, polys, graph, transfers } = build;

  // The lid's plane: vanilla's `MissingLowerTextures[i].Planez`, the highest adjoining floor.
  let planez = -Infinity;
  let fill = -1;
  const seedFloor = map.sectors[polys[start]?.sector]?.floorHeight;
  if (seedFloor === undefined) return null;
  const seedSegs = map.subsectors[start];
  for (let i = 0; seedSegs && i < seedSegs.count; i++) {
    const step = holeStep(build, start, i);
    if (!step || step.height <= seedFloor || step.height <= planez) continue;
    if (!rimSector(build, step.sector)) continue;
    if (step.textured) continue;
    planez = step.height;
    fill = step.sector;
  }
  if (fill < 0) return null;

  const region = [start];
  const inRegion = new Set(region);
  for (let at = 0; at < region.length; at++) {
    const covered = region[at];
    const sector = polys[covered].sector;
    // The lid goes *over* the hole: a leaf standing at the rim's own height is not in one.
    if ((map.sectors[sector]?.floorHeight ?? planez) >= planez) return null;
    // Boom's 242 idioms are built *on* missing textures, so the hack keeps clear.
    if (transfers.heightSec(sector) >= 0) return null;
    const leafSegs = map.subsectors[covered];
    for (let i = 0; leafSegs && i < leafSegs.count; i++) {
      const step = holeStep(build, covered, i);
      // A one-sided wall means the region is a room, not a hole.
      if (step === null) return null;
      if (step === undefined) continue;
      if (step.height > planez) return null;
      // Below the plane is more of the hole, which the leaf graph below walks into. At the plane is
      // the rim the lid rests on, and every bit of that has to draw nothing.
      if (step.height < planez) continue;
      if (step.textured || !rimSector(build, step.sector)) return null;
    }
    for (let i = graph.starts[covered]; i < graph.starts[covered + 1]; i++) {
      const other = graph.leaves[i];
      if (inRegion.has(other)) continue;
      // Leaves no seg of this one names: a BSP split, or a probe across a seg filed on the wrong
      // side of its line. Only their height is known, so only their height can be asked.
      const height = map.sectors[polys[other]?.sector]?.floorHeight;
      if (height === undefined || height > planez) return null;
      if (height === planez) continue;
      inRegion.add(other);
      region.push(other);
      if (region.length > HOLE_REGION_MAX) return null;
    }
  }
  return { leaves: region, fill };
}

/**
 * The step the `i`th seg of `leaf` looks across: `null` on a one-sided wall, `undefined` where the
 * seg bounds nothing (a GL miniseg, a self-referencing line). Module scratch — one flood at a time,
 * and it runs per seg per leaf.
 */
const holeStepOut = { height: 0, sector: 0, textured: false };

function holeStep(build: Build, leaf: number, i: number): typeof holeStepOut | null | undefined {
  const { map } = build;
  const ss = map.subsectors[leaf];
  const seg = map.segs[ss.first + i];
  if (!seg || seg.linedef === NO_LINE) return undefined;
  const line = map.linedefs[seg.linedef];
  if (!line) return undefined;
  if (line.left === NO_SIDE || line.right === NO_SIDE) return null;
  const own = map.sidedefs[segSide(line, seg.direction)];
  const back = map.sidedefs[segBackSide(line, seg.direction)];
  if (!own || !back) return null;
  if (own.sector === back.sector) return undefined;
  const other = map.sectors[back.sector];
  if (!other) return null;
  holeStepOut.height = other.floorHeight;
  holeStepOut.sector = back.sector;
  holeStepOut.textured = own.lower !== NO_TEXTURE && own.lower !== '';
  return holeStepOut;
}

/** Whether a sector may carry the lid's plane: a real flat, at a height that will hold still. */
function rimSector(build: Build, sectorIndex: number): boolean {
  if (build.map.sectors[sectorIndex]?.floorTex === SKY_FLAT) return false;
  if (build.transfers.heightSec(sectorIndex) >= 0) return false;
  // A lid baked at this neighbour's height would go stale the moment it moved — unless the build
  // holding it is redone alongside it, which a mover's is.
  return build.rebuiltWithNeighbours || !build.movableSectors?.has(sectorIndex);
}

/** One flat fan's parameters — everything `addFlatFan` needs that isn't the footprint. */
interface FlatSpec {
  texName: string;
  height: number;
  light: number;
  /** Sector the light came from, which a transfer makes different from the fan's own. */
  lightSector: number;
  isCeiling: boolean;
  baseAlpha?: number;
}

/**
 * How much water a Boom 242 sector needs before its surface is drawn over a pool bottom rather
 * than simply *being* the drawn floor. **Tuned by feel** against the artifact it stops: two fans
 * a map unit apart z-fight (BOOMEDIT MAP01 sector 405). docs/specials.md § Deep water.
 */
const WATER_MIN_DEPTH = 8;

/**
 * `processFlat`'s two loop bodies, hoisted out of a function a mover rebuild runs per subsector per
 * tic.
 */
const FLOOR_ONLY = [false];
const FLOOR_AND_CEILING = [false, true];

/**
 * Which fans one leaf draws and with what — every decision `processFlat` makes before a vertex
 * exists, written into `out` (grown as needed) and counted back. Split out from the emission so a
 * refresh can re-decide without re-dicing. docs/render.md § Mover meshes.
 */
function flatSpecsOf(
  build: Build,
  poly: SubSectorPoly,
  /** The sector this leaf's own sector closes itself over (`closedHoleFill`), or -1. */
  holeFill: number,
  out: FlatSpec[],
): number {
  const { map, transfers, renderCeilings } = build;
  let count = 0;
  const n = poly.points.length / 2;
  if (n < 3) return 0;
  const sector = map.sectors[poly.sector];
  if (!sector) return 0;

  // Boom's 242. Vanilla picks one of two views by where the eye is; a deep pool draws both at
  // once, so a player who wades in stays visible. Too shallow for that, and the one fan is
  // vanilla's above-water view; a control sector *below* instead is the invisible-platform idiom,
  // one fan at `drawnFloor`. docs/specials.md § Deep water.
  const surfaceHeight = transfers.waterHeight(poly.sector);
  const deep = surfaceHeight !== null && surfaceHeight - sector.floorHeight >= WATER_MIN_DEPTH;
  // A bottom a mover has raised clear of the surface keeps the control sector's flat and light
  // rather than snapping to the water flat — a deviation from `R_FakeFlat`'s plain branch, which
  // draws that flat. Repro: BOOMEDIT MAP01's stairs in sector 35's pool.
  const control = deep
    ? transfers.heightSec(poly.sector)
    : surfaceHeight === null
      ? transfers.poolBottom(poly.sector)
      : -1;
  const bottom = control >= 0 ? map.sectors[control] : undefined;
  // Where the control sector has no flat to lend (sky, or an unset slot), falling back to the
  // sector's own keeps a pool with a floor rather than a hole in the level.
  const bottomTex =
    bottom && bottom.floorTex !== SKY_FLAT && bottom.floorTex !== NO_TEXTURE ? bottom.floorTex : undefined;
  const floorLightFrom = bottom ? control : poly.sector;
  const floorHeight = deep ? sector.floorHeight : (surfaceHeight ?? transfers.drawnFloor(poly.sector));

  for (const isCeiling of renderCeilings ? FLOOR_AND_CEILING : FLOOR_ONLY) {
    const spec = specAt(out, count++);
    spec.texName = isCeiling ? sector.ceilTex : (bottomTex ?? sector.floorTex);
    spec.height = isCeiling ? sector.ceilHeight : floorHeight;
    spec.light = isCeiling ? transfers.ceilingLight(poly.sector) : transfers.floorLight(floorLightFrom);
    spec.lightSector = isCeiling
      ? transfers.ceilingLightSector(poly.sector)
      : transfers.floorLightSector(floorLightFrom);
    spec.isCeiling = isCeiling;
    spec.baseAlpha = undefined;
  }

  // The lid over a hole in the map (`closedHoleFill`), drawn on top of the real floor. An ordinary
  // `FlatSurface`, so `FlatFader` dissolves it for a body underneath.
  if (holeFill >= 0) {
    const spec = specAt(out, count++);
    spec.texName = map.sectors[holeFill].floorTex;
    spec.height = map.sectors[holeFill].floorHeight;
    spec.light = transfers.floorLight(holeFill);
    spec.lightSector = transfers.floorLightSector(holeFill);
    spec.isCeiling = false;
    spec.baseAlpha = undefined;
  }

  // Which pool's surface covers this fan: this sector's own, or — for a sector walled in by a pool
  // but left out of its tag — that pool's, so the sheet runs over the island rather than stopping
  // at it. Only where the island is submerged: a chamber whose ceiling stands above the surface is
  // dry inside, whatever surrounds it. docs/specials.md § Deep water.
  const island = deep ? -1 : transfers.poolIsland(poly.sector);
  const islandSurface = island < 0 ? null : transfers.waterHeight(island);
  const submerged = islandSurface !== null && sector.ceilHeight <= islandSurface;
  const pool = deep ? poly.sector : submerged ? island : -1;
  const surfaceAt = deep ? surfaceHeight : islandSurface;
  if (pool >= 0 && surfaceAt !== null && surfaceAt - sector.floorHeight >= WATER_MIN_DEPTH) {
    const spec = specAt(out, count++);
    spec.texName = map.sectors[pool].floorTex;
    spec.height = surfaceAt;
    spec.light = transfers.floorLight(pool);
    spec.lightSector = transfers.floorLightSector(pool);
    spec.isCeiling = false;
    spec.baseAlpha = WATER_SURFACE_ALPHA;
  }
  return count;
}

/** `processFlat`'s spec buffer, reused across every leaf — see `flatSpecsOf`. */
const flatSpecs: FlatSpec[] = [];

/**
 * The `at`th spec of `out`, reusing the record already there rather than allocating one per leaf.
 */
function specAt(out: FlatSpec[], at: number): FlatSpec {
  let spec = out[at];
  if (spec === undefined) {
    spec = { texName: '', height: 0, light: 0, lightSector: 0, isCeiling: false, baseAlpha: undefined };
    out.push(spec);
  }
  return spec;
}

function processFlat(build: Build, poly: SubSectorPoly, ss: number, holeFill: number): void {
  const count = flatSpecsOf(build, poly, holeFill, flatSpecs);
  for (let i = 0; i < count; i++) addFlatFan(build, poly, ss, flatSpecs[i]);
}

/**
 * Below this a diced cell is degeneracy rather than geometry — a ring clipped by a grid line it
 * only grazes comes back as three near-collinear points. **Tuned by feel**: a robustness floor,
 * anywhere well under a square map unit and well over the clip's float noise.
 */
const FLAT_CELL_MIN_AREA = 0.05;

/** `diceOnGrid`'s clip buffers, reused across every flat on the map — see there. */
const stripLow: number[] = [];
const stripHigh: number[] = [];
const cellLow: number[] = [];
const cellHigh: number[] = [];
/** The ceiling ring, wound the other way. Reused for the same reason the clip buffers are. */
const reversed: number[] = [];

/** The ring wound backwards, so fanning it gives the same coverage with the opposite normal. */
function reversedRing(points: ArrayLike<number>): number[] {
  const n = points.length / 2;
  reversed.length = 0;
  for (let i = n - 1; i >= 0; i--) reversed.push(points[i * 2], points[i * 2 + 1]);
  return reversed;
}

/**
 * Cuts a convex ring along the world-aligned `FLAT_GRID_LEN` grid and hands each cell to `fan`.
 * Convex in, convex out — which `SubSectorPoly.points` guarantees (`render/bsp.ts`) and which is
 * what lets each cell be fanned. docs/render.md § Flats are diced on a world grid.
 *
 * The buffers are module-level scratch, reused across every flat on the map; nothing here reenters.
 *
 * The cuts go through `util/geom.ts`'s `clipConvexPolygon`, which keeps the `cross <= 0` half-plane
 * of a line given as a point plus a direction. The four axis-aligned halves this needs are that
 * line's degenerate cases — with `at` the grid line:
 *
 * | keep      | point     | direction |
 * |-----------|-----------|-----------|
 * | `x >= at` | `(at, 0)` | `(0, 1)`  |
 * | `x <= at` | `(at, 0)` | `(0, -1)` |
 * | `y >= at` | `(0, at)` | `(-1, 0)` |
 * | `y <= at` | `(0, at)` | `(1, 0)`  |
 */
function diceOnGrid(ring: ArrayLike<number>, fan: (cell: ArrayLike<number>) => void): void {
  const n = ring.length / 2;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2];
    const y = ring[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const g = FLAT_GRID_LEN;
  const c1 = Math.floor(maxX / g);
  const r1 = Math.floor(maxY / g);
  for (let c = Math.floor(minX / g); c <= c1; c++) {
    // The column: the ring cut down to the slab between two grid lines. A cut the ring already
    // lies wholly on one side of is skipped, which is what makes the single-cell case free.
    let strip: ArrayLike<number> = ring;
    if (c * g > minX) {
      clipConvexPolygon(strip, c * g, 0, 0, 1, 0, stripLow);
      strip = stripLow;
    }
    if ((c + 1) * g < maxX) {
      clipConvexPolygon(strip, (c + 1) * g, 0, 0, -1, 0, stripHigh);
      strip = stripHigh;
    }
    if (strip.length < 6) continue;
    // The column's own y-range, so a tall polygon's narrow column visits only the rows it reaches.
    let sMinY = Infinity;
    let sMaxY = -Infinity;
    for (let i = 0; i < strip.length / 2; i++) {
      const y = strip[i * 2 + 1];
      if (y < sMinY) sMinY = y;
      if (y > sMaxY) sMaxY = y;
    }
    const rTop = Math.min(r1, Math.floor(sMaxY / g));
    for (let r = Math.floor(sMinY / g); r <= rTop; r++) {
      let cell: ArrayLike<number> = strip;
      if (r * g > sMinY) {
        clipConvexPolygon(cell, 0, r * g, -1, 0, 0, cellLow);
        cell = cellLow;
      }
      if ((r + 1) * g < sMaxY) {
        clipConvexPolygon(cell, 0, (r + 1) * g, 1, 0, 0, cellHigh);
        cell = cellHigh;
      }
      // The scratch is handed straight on: `fan` copies what it reads before the next cell.
      if (cell.length >= 6 && Math.abs(signedPolygonArea2(cell)) > FLAT_CELL_MIN_AREA * 2) fan(cell);
    }
  }
}

/**
 * The art a flat fan would draw with, or null where there is none — sky and the unset slot are
 * holes by design, a name the WAD has no lump for is one by accident. Shared with
 * `planFlatRefresh`, which must reach the same verdict about a fan it is *not* emitting.
 */
function flatArt(kind: SurfaceKind, texName: string, size: SizeFn): Size | null {
  if (texName === SKY_FLAT || texName === NO_TEXTURE || texName === '') return null;
  return size(kind, texName);
}

function addFlatFan(
  build: Build,
  poly: SectorPoly,
  ss: number,
  spec: FlatSpec,
  /**
   * Which bank the texture comes from: a solid structure's lid wears a *wall* texture (see
   * `buildSolidCaps`).
   */
  kind: SurfaceKind = 'flat',
): void {
  const { texName, height, isCeiling } = spec;
  const dim = flatArt(kind, texName, build.size);
  if (!dim) return;
  // A wall texture borrowed for a lid tiles at its own size; a real flat at `FLAT_TEX_SIZE`.
  const uw = kind === 'flat' ? FLAT_TEX_SIZE : dim.w;
  const uh = kind === 'flat' ? FLAT_TEX_SIZE : dim.h;

  if (poly.points.length < 6) return;
  const color = litColor(spec.light);
  const alpha = spec.baseAlpha ?? 1;
  const batch = build.batches.get(kind, texName);
  const vertexStart = batch.positions.length / 3;
  const xy: number[] = [];

  // Floors keep the polygon's winding (normal up); a ceiling gets the ring wound the other way.
  const ring = isCeiling ? reversedRing(poly.points) : poly.points;

  const emit = (cell: ArrayLike<number>, i: number): void => {
    const x = cell[i * 2];
    const y = cell[i * 2 + 1];
    pushVertex(batch, x, height, -y, x / uw, -y / uh, color, alpha, ss);
    xy.push(x, y);
  };
  // Each grid cell is convex and small, so fanning it costs no slivers — see `diceOnGrid`.
  const fanCell = (cell: ArrayLike<number>): void => {
    for (let i = 1; i + 1 < cell.length / 2; i++) {
      emit(cell, 0);
      emit(cell, i);
      emit(cell, i + 1);
    }
  };
  diceOnGrid(ring, fanCell);

  const vertexCount = batch.positions.length / 3 - vertexStart;
  if (vertexCount > 0) {
    build.flatSurfaces.push({
      key: batch.key,
      texName,
      vertexStart,
      vertexCount,
      subsector: ss,
      sector: poly.sector,
      lightSector: spec.lightSector,
      points: poly.points,
      vertexXY: Float32Array.from(xy),
      height,
      light: spec.light,
      isCeiling,
      baseAlpha: spec.baseAlpha,
    });
  }
}

interface WallSpec {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  topH: number;
  botH: number;
  texture: string;
  xOffset: number;
  yOffset: number;
  /** World height at which texture row 0 sits (DOOM's "pegging"). */
  pegRef: number;
  light: number;
  /** Sector whose light level `light` was read from — carried onto the occluder record. */
  sector: number;
  /**
   * Linedef this quad belongs to, and whether it's the front (right) side — carried onto the
   * occluder record for `SurfaceScroller`.
   */
  line: number;
  frontSide: boolean;
  /** Permanent translucency — a Boom 260 midtexture, and nothing else. */
  baseAlpha?: number;
}

/**
 * True when the quad was drawn — what vanilla's `toptexture`/`bottomtexture` being non-zero decides
 * (see `addTwoSidedSide`'s midtexture clip). `bandVertically` off keeps the wall one quad tall
 * however high it is, which a wall whose height can move must be: `Build.holdsStill` decides it,
 * and `WALL_CHUNK_LEN` says why.
 */
function addWall(build: Build, spec: WallSpec, bandVertically: boolean): boolean {
  if (spec.topH <= spec.botH) return false;
  if (spec.texture === NO_TEXTURE || spec.texture === '') return false;
  const dim = build.size('wall', spec.texture);
  if (!dim) return false;

  const dx = spec.bx - spec.ax;
  const dy = spec.by - spec.ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;

  // Fake contrast: east-west walls darken, north-south brighten, so corners stay legible under
  // flat sector lighting (`r_segs.c: R_StoreWallRange`).
  const color = litColor(spec.light, wallContrast(spec.ax, spec.ay, spec.bx, spec.by));

  const u0 = spec.xOffset / dim.w;
  const u1 = (spec.xOffset + len) / dim.w;
  const vTop = (spec.pegRef - spec.topH + spec.yOffset) / dim.h;
  const vBot = (spec.pegRef - spec.botH + spec.yOffset) / dim.h;

  const batch = build.batches.get('wall', spec.texture);
  const { ax, ay, bx, by, topH, botH } = spec;

  // Cut both ways so the fade can dissolve a ball around the sightline rather than a full-height
  // slab of wall — see `WALL_CHUNK_LEN`.
  const chunks = Math.max(1, Math.ceil(len / WALL_CHUNK_LEN));
  const bands = bandVertically ? Math.max(1, Math.ceil((spec.topH - spec.botH) / WALL_CHUNK_LEN)) : 1;
  const alpha = spec.baseAlpha ?? 1;
  for (let c = 0; c < chunks; c++) {
    const t0 = c / chunks;
    const t1 = (c + 1) / chunks;
    const cax = ax + dx * t0;
    const cay = ay + dy * t0;
    const cbx = ax + dx * t1;
    const cby = ay + dy * t1;
    // U runs linearly with wall length, so a chunk's edge U is the same lerp and shared edges land
    // on identical values. V does the same with height, for the bands.
    const cu0 = u0 + (u1 - u0) * t0;
    const cu1 = u0 + (u1 - u0) * t1;

    for (let r = 0; r < bands; r++) {
      // Bands run bottom-up, so `r`'s top is `r + 1`'s bottom.
      const bandTop = topH + ((botH - topH) * r) / bands;
      const bandBot = topH + ((botH - topH) * (r + 1)) / bands;
      const bandVTop = vTop + ((vBot - vTop) * r) / bands;
      const bandVBot = vTop + ((vBot - vTop) * (r + 1)) / bands;

      // A = top-left, B = top-right, C = bottom-right, D = bottom-left, facing right of a→b
      // (DOOM's front side), as the triangles A-D-C and A-C-B. Written out rather than iterated:
      // the dicing above makes up to `chunks * bands` of these, and a mover re-runs the lot per tic.
      const vertexStart = batch.positions.length / 3;
      pushVertex(batch, cax, bandTop, -cay, cu0, bandVTop, color, alpha); // A
      pushVertex(batch, cax, bandBot, -cay, cu0, bandVBot, color, alpha); // D
      pushVertex(batch, cbx, bandBot, -cby, cu1, bandVBot, color, alpha); // C
      pushVertex(batch, cax, bandTop, -cay, cu0, bandVTop, color, alpha); // A
      pushVertex(batch, cbx, bandBot, -cby, cu1, bandVBot, color, alpha); // C
      pushVertex(batch, cbx, bandTop, -cby, cu1, bandVTop, color, alpha); // B
      build.occluders.push({
        key: batch.key,
        vertexStart,
        vertexCount: 6,
        ax: cax,
        ay: cay,
        bx: cbx,
        by: cby,
        botH: bandBot,
        topH: bandTop,
        segAx: ax,
        segAy: ay,
        segBx: bx,
        segBy: by,
        sector: spec.sector,
        line: spec.line,
        texName: spec.texture,
        frontSide: spec.frontSide,
        subsector: -1,
        baseAlpha: spec.baseAlpha,
      });
    }
  }
  return true;
}

function buildWalls(build: Build): void {
  const { map, movableSectors } = build;
  for (const [lineIndex, line] of map.linedefs.entries()) {
    // Whole line, both sides: a static neighbour's step is sized from the moving sector's heights,
    // so it cannot stay in a batch nobody rebuilds (`MapMeshOptions.movableSectors`).
    if (movableSectors && touchesAny(map, line, movableSectors)) continue;
    processLine(build, line, lineIndex);
  }
}

/** What both sides of a two-sided line share — resolved once per line by `processLine`. */
interface LineView {
  index: number;
  flags: number;
  /** `MapMeshOptions.wallHeightCap` applied: the height a wall in a sector is clipped to. */
  cap: (sec: Sector, top: number) => number;
  /** Whether these quads may be diced vertically — see `Build.holdsStill`. */
  bandVertically: boolean;
}

/**
 * One side of a two-sided line as `addTwoSidedSide` looks at it: the sidedef doing the drawing and
 * the sector across from it. The two calls a line makes differ only in this.
 */
interface SideView {
  /** The line's ends, ordered so the quads face right of a→b — this side's outward normal. */
  a: Pos2;
  b: Pos2;
  side: SideDef;
  secIndex: number;
  sec: Sector;
  otherIndex: number;
  other: Sector;
  frontSide: boolean;
}

function processLine(build: Build, line: LineDef, lineIndex: number): void {
  const { map, transfers, wallHeightCap, holdsStill, includeSide } = build;
  const v1 = map.vertexes[line.v1];
  const v2 = map.vertexes[line.v2];
  if (!v1 || !v2) return;

  const front = line.right !== NO_SIDE ? map.sidedefs[line.right] : undefined;
  const back = line.left !== NO_SIDE ? map.sidedefs[line.left] : undefined;
  const frontSec = front ? map.sectors[front.sector] : undefined;
  const backSec = back ? map.sectors[back.sector] : undefined;

  const cap = (sec: Sector, top: number) => (wallHeightCap > 0 ? Math.min(top, sec.floorHeight + wallHeightCap) : top);

  if (front && frontSec && !backSec) {
    if (includeSide && !includeSide(front.sector)) return;
    // Solid wall: the middle texture spans the sector height, down to the *drawn* floor so a 242
    // fake floor is not left ringed by a gap (docs/render.md § Deep water).
    const unpegged = (line.flags & LF.LOWER_UNPEGGED) !== 0;
    const floor = transfers.drawnFloor(front.sector);
    const dim = build.size('wall', front.middle);
    addWall(
      build,
      {
        ax: v1.x,
        ay: v1.y,
        bx: v2.x,
        by: v2.y,
        topH: cap(frontSec, frontSec.ceilHeight),
        botH: floor,
        texture: front.middle,
        xOffset: front.xOffset,
        yOffset: front.yOffset,
        pegRef: unpegged ? floor + (dim?.h ?? 128) : frontSec.ceilHeight,
        light: frontSec.light,
        sector: front.sector,
        line: lineIndex,
        frontSide: true,
      },
      holdsStill(front.sector),
    );
    return;
  }

  if (!front || !back || !frontSec || !backSec) return;

  // Two-sided line: each side gets its own step-up/step-down pieces, sized
  // against the *drawn* heights opposite it (`twoSidedBands`). Every tier is
  // sized from *both* sectors — the lower from the two floors, the upper from
  // the two ceilings — so one of them moving is enough to leave the whole side
  // undiced.
  const view: LineView = {
    index: lineIndex,
    flags: line.flags,
    cap,
    bandVertically: holdsStill(front.sector) && holdsStill(back.sector),
  };
  if (!includeSide || includeSide(front.sector)) {
    addTwoSidedSide(build, view, {
      a: v1,
      b: v2,
      side: front,
      secIndex: front.sector,
      sec: frontSec,
      otherIndex: back.sector,
      other: backSec,
      frontSide: true,
    });
  }
  if (!includeSide || includeSide(back.sector)) {
    addTwoSidedSide(build, view, {
      a: v2,
      b: v1,
      side: back,
      secIndex: back.sector,
      sec: backSec,
      otherIndex: front.sector,
      other: frontSec,
      frontSide: false,
    });
  }
}

/**
 * The ceiling a side of a two-sided line is sized against: the neighbour's *drawn* ceiling, which
 * a Boom 242 moves, except where the sector doing the looking has a 242 of its own. That exception
 * stands in for a branch vanilla picks per frame from where the eye is — a quad is only ever seen
 * from the sector it faces into. docs/render.md § Deep water.
 */
function ceilingFacing(transfers: SectorTransfers, other: Sector, otherIndex: number, viewerSector: number): number {
  return transfers.heightSec(viewerSector) >= 0 ? other.ceilHeight : transfers.drawnCeiling(otherIndex);
}

/** `addTwoSidedSide`'s own scratch — it is not reentrant, so one record serves every side. */
const sideBands: DrawnBands = { lowerBot: 0, lowerTop: 0, upperBot: 0, upperTop: 0, skyPair: false };

/**
 * How opaque a Boom 260 midtexture draws: `tran_filter_pct`'s default of 66 (`m_misc.c`'s config
 * table), the percentage Boom generates its `TRANMAP` at. Every 260 line gets this one value —
 * docs/specials.md § Translucent midtextures.
 */
const TRANSLUCENT_ALPHA = 0.66;
function addTwoSidedSide(build: Build, line: LineView, view: SideView): void {
  const { size, transfers } = build;
  const { a, b, side, secIndex, sec, otherIndex, other } = view;
  // The heights this side is *sized* against. Everything below reads these, never
  // `sec.floorHeight`/`other.ceilHeight` — except the midtexture's peg anchor, the one thing a 242
  // leaves alone (docs/render.md § Deep water).
  twoSidedBands(transfers, sec, secIndex, other, otherIndex, sideBands);
  const otherCeil = sideBands.upperBot;
  const selfFloor = sideBands.lowerBot;
  const otherFloor = sideBands.lowerTop;
  const skyPair = sideBands.skyPair;
  const base = {
    ax: a.x,
    ay: a.y,
    bx: b.x,
    by: b.y,
    xOffset: side.xOffset,
    yOffset: side.yOffset,
    light: sec.light,
    sector: secIndex,
    line: line.index,
    frontSide: view.frontSide,
  };
  const upperUnpegged = (line.flags & LF.UPPER_UNPEGGED) !== 0;
  const lowerUnpegged = (line.flags & LF.LOWER_UNPEGGED) !== 0;

  // Upper: this sector's ceiling is higher than the neighbour's.
  let upperDrawn = false;
  if (sec.ceilHeight > otherCeil && !skyPair) {
    const dim = size('wall', side.upper);
    upperDrawn = addWall(
      build,
      {
        ...base,
        topH: line.cap(sec, sec.ceilHeight),
        botH: Math.min(line.cap(sec, sec.ceilHeight), otherCeil),
        texture: side.upper,
        pegRef: upperUnpegged ? sec.ceilHeight : otherCeil + (dim?.h ?? 128),
      },
      line.bandVertically,
    );
  }

  // Lower: the neighbour's floor is higher, so a step faces this side. A pool's surface never
  // moves this — a step sized to it would ring the bottom with a hole — but a fake floor does, on
  // both sides at once. docs/render.md § Deep water.
  let lowerDrawn = false;
  if (otherFloor > selfFloor) {
    lowerDrawn = addWall(
      build,
      {
        ...base,
        topH: otherFloor,
        botH: selfFloor,
        texture: side.lower,
        pegRef: lowerUnpegged ? sec.ceilHeight : otherFloor,
      },
      line.bandVertically,
    );
  }

  // Middle: optional masked texture (grates, bars) hung across the line. Boom's 260 makes one
  // translucent and overloads the same name to point at the translucency map, in which case there
  // is no texture to draw at all. docs/specials.md § Translucent midtextures.
  if (side.middle !== NO_TEXTURE && side.middle !== '' && !transfers.midtexSuppressed(line.index)) {
    const dim = size('wall', side.middle);
    if (dim) {
      // What the midtexture is cut to: the tiers this side actually drew, so a step the mapper
      // left untextured cuts nothing and the texture runs on to this sector's own floor and
      // ceiling. Two sky ceilings are vanilla's one exception. docs/render.md § What cuts a
      // midtexture.
      const clipTop = skyPair ? otherCeil : upperDrawn ? Math.min(sec.ceilHeight, otherCeil) : sec.ceilHeight;
      const clipBot = lowerDrawn ? Math.max(selfFloor, otherFloor) : selfFloor;
      // The quad is the texture's own band — one copy hung off the pegged anchor, y-offset
      // included — *clipped* to that range, never sized to it. The anchor reads the **real**
      // sectors even where the opening is a 242's drawn one (docs/render.md § Deep water).
      const pegTop = Math.min(sec.ceilHeight, other.ceilHeight);
      const pegBot = Math.max(sec.floorHeight, other.floorHeight);
      const pegRef = lowerUnpegged ? pegBot + dim.h : pegTop;
      const texTop = pegRef + side.yOffset;
      const top = Math.min(clipTop, texTop);
      const bot = Math.max(clipBot, texTop - dim.h);
      addWall(
        build,
        {
          ...base,
          topH: top,
          botH: bot,
          texture: side.middle,
          pegRef,
          baseAlpha: transfers.translucentLine(line.index) ? TRANSLUCENT_ALPHA : undefined,
        },
        line.bandVertically,
      );
    }
  }
}
