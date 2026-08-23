/**
 * Builds the level's three.js meshes from the subsector polygons and linedefs — floors and walls
 * batched by texture, lit per sector — and owns `doomToWorld`/`worldToDoom`, the one place DOOM space
 * and three.js space meet. See docs/render.md § Mesh building and § Sector lighting.
 */
import * as THREE from 'three';
import { LF, NO_SIDE, SKY_FLAT, type DoomMap, type LineDef, type SideDef, type Sector } from '../wad/map.ts';
import { buildSubSectorPolys, type SectorPoly, type SubSectorPoly } from './bsp.ts';
import { findSolidCaps, pointInPolygon, type SolidCap } from './solids.ts';
import type { MaterialBank, Size, SurfaceKind } from './textures.ts';
import type { Pos2, Pos3 } from '../types.ts';
import { BRIGHTNESS_LIFT, WATER_SURFACE_ALPHA } from '../constants.ts';

/** DOOM's sentinel for "no texture assigned" in a sidedef texture slot — also used by `game/specials.ts`'s `raiseToTexture` to skip unset bottom textures. */
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

interface Batch {
  key: string;
  kind: SurfaceKind;
  texture: string;
  positions: number[];
  uvs: number[];
  colors: number[];
}

class BatchSet {
  private batches = new Map<string, Batch>();

  get(kind: SurfaceKind, texture: string): Batch {
    const key = kind + ':' + texture;
    let b = this.batches.get(key);
    if (!b) {
      b = { key, kind, texture, positions: [], uvs: [], colors: [] };
      this.batches.set(key, b);
    }
    return b;
  }

  all(): Batch[] {
    return [...this.batches.values()];
  }
}

/**
 * What each of `COLORMAP`'s 32 rows does to brightness, as a **linear-light**
 * multiplier — *measured* from the real lump rather than modelled, since
 * vanilla remaps palette indices through a colormap row instead of scaling a
 * colour by the light level. One baked table serves DOOM, DOOM2 and Freedoom.
 * docs/render.md § Sector lighting.
 */
const COLORMAP_GAIN = [
  1.0, 0.9662, 0.9055, 0.8253, 0.7552, 0.6956, 0.6437, 0.584,
  0.5366, 0.4949, 0.4492, 0.4067, 0.3632, 0.3282, 0.2946, 0.2627,
  0.2317, 0.2023, 0.1765, 0.1526, 0.1312, 0.1086, 0.0918, 0.0758,
  0.0621, 0.0492, 0.0383, 0.0288, 0.0202, 0.0142, 0.0082, 0.0034,
];

/**
 * `r_main.c`'s `scale/DISTMAP` distance term, sampled at one fixed viewing
 * distance since this engine has no distance lighting. **The knob to turn if
 * the whole game reads too dark or too bright** — docs/render.md § Sector
 * lighting for why 4, and why both ends of the ramp saturate.
 */
const REFERENCE_STEPS = 4;

/** `COLORMAP_GAIN` folded down to one entry per light segment, built once. */
const LIGHT_GAIN = Array.from({ length: 16 }, (_, seg) => {
  const row = (15 - seg) * 4 - REFERENCE_STEPS;
  return COLORMAP_GAIN[Math.max(0, Math.min(31, row))];
});

/**
 * Sector light level (0..255) as a linear vertex colour, plus fake contrast.
 *
 * The result is deliberately linear-light, not a display value: vertex colours
 * (and `material.color.setScalar`, for the non-batched sprites) are consumed
 * as-is by the shader, and the renderer's `outputColorSpace` (`SRGBColorSpace`,
 * `game.ts`) encodes the final fragment to sRGB on the way out. Returning a
 * display-space value here would get it gamma-encoded a second time.
 *
 * `contrast` is the fake-contrast offset in light units; vanilla nudges its
 * *segment* index by one (`lightnum--`/`++`), which is exactly what +/-16 here
 * amounts to after the shift below.
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
 * A "lift" toward full brightness: pushes `linear` up by a fraction `lift` of
 * its remaining headroom `(1 - linear)`, so a pitch-black surface (linear = 0)
 * brightens by the full `lift` while an already-bright one barely moves — the
 * effect a surface gets is proportional to how dark it already is. `lift = 0`
 * is a no-op, `lift = 1` flattens everything to full bright.
 */
export function applyBrightnessLift(linear: number, lift: number): number {
  const l = Math.max(0, Math.min(1, lift));
  return linear + l * (1 - linear);
}

/**
 * `lightToColor` plus `BRIGHTNESS_LIFT` (`constants.ts`) — what everything
 * should actually be drawn with. `lightToColor` itself stays pure and
 * vanilla-exact so it's easy to verify in isolation; every real draw call
 * (walls, flats, sprites) goes through this instead.
 */
export function litColor(light: number, contrast = 0): number {
  return applyBrightnessLift(lightToColor(light, contrast), BRIGHTNESS_LIFT);
}

/**
 * How opaque a Boom 260 midtexture draws. Vanilla blends it through a `TRANMAP`
 * generated at `tran_filter_pct` percent, whose default is 66 (`m_misc.c`'s
 * config table); custom tranmap lumps have no meaning to an RGBA renderer, so
 * every 260 line gets this one value — docs/specials.md § Translucent midtextures.
 */
const TRANSLUCENT_ALPHA = 0.66;

/**
 * How much water a Boom 242 sector needs before its surface is drawn over a
 * pool bottom rather than simply *being* the drawn floor. **Tuned by feel**,
 * against the artifact it exists to stop: BOOMEDIT MAP01 sector 405 is one map
 * unit deep, and two fans that close together z-fight into a shimmering mess.
 * docs/specials.md § Deep water.
 */
const WATER_MIN_DEPTH = 8;

/** `processFlat`'s two loop bodies, hoisted out of a function a mover rebuild runs per subsector per tic. */
const FLOOR_ONLY = [false];
const FLOOR_AND_CEILING = [false, true];

function pushVertex(b: Batch, x: number, y: number, z: number, u: number, v: number, c: number, alpha = 1): void {
  b.positions.push(x, y, z);
  b.uvs.push(u, v);
  b.colors.push(c, c, c, alpha);
}

/**
 * Boom's render transfers, as much of them as the mesh builder needs:
 * a sector's drawn floor/ceiling light, the height its water surface sits at,
 * and which linedefs draw a translucent midtexture.
 *
 * Declared structurally here, like `ScrollOffsets` in render/occlusion.ts, so
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
  /** The control sector a pool bottom draws with, or -1 where the sector never had water over it. */
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
   * Sectors driven by a specials mover (game/specials.ts): every line that
   * touches one is left out of the static batches here entirely — *both* its
   * sides, not just the one the mover owns. A moving door/lift changes not
   * just vertex positions but which quads exist at all (an upper step shrinks
   * to nothing as a door opens), and that is just as true of the *neighbour's*
   * side: DOOM puts a platform's visible front texture on the sidedef of the
   * lower sector looking at it, i.e. on the static room's side of the line, not
   * the lift's. Leaving that side static froze the lift's front wall at its
   * raised height while the platform slid down behind it. `buildMoverMesh`
   * builds those sides too, in its own small per-sector mesh the mover
   * rebuilds on demand. It also suppresses a lid baked against a movable
   * neighbour's height (`closedHoleFill`), so an incomplete set leaves stale
   * ones behind.
   */
  movableSectors?: Set<number>;
  /**
   * The linedefs bordering a sector — vanilla's `sec->lines[]`, the same seam
   * `MoverIndex.linesOf` uses and for the same reason: `game/world.ts` already
   * builds and memoizes this per map, and the renderer keeps no import edge
   * into `game/`. Omitted (tests, tools) means build a plain adjacency list
   * locally — see `borderingLines`.
   */
  linesOf?: (sectorIndex: number) => readonly number[];
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
  /** Subsector polygons computed for this build — reused by `buildMoverMesh` so it never re-walks the BSP. */
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
  /** Sector whose light level this quad was coloured from — for specials-driven relight. */
  sector: number;
  /** Linedef this quad was built from — for `SurfaceScroller` (render/occlusion.ts) to find a scrolling line's front side. */
  line: number;
  /** True if this quad came from the linedef's front (right) sidedef — vanilla's `sidenum[0]`, the only side a scrolling special ever animates. */
  frontSide: boolean;
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
  /** DOOM (x, y) footprint of this subsector, flattened — see FlatFader. */
  points: Float64Array;
  /** World height (floor or ceiling) this surface sits at. */
  height: number;
  isCeiling: boolean;
  /**
   * Permanent translucency, multiplied into the vertex alpha the faders write
   * (render/occlusion.ts). Only a 242 water surface has one.
   */
  baseAlpha?: number;
}

/**
 * Which subsectors and linedefs a sector owns — what a mover rebuild would
 * otherwise re-derive by scanning the whole map, once per rebuilt sector.
 *
 * Declared structurally here, like `SectorTransfers` above, so the renderer
 * keeps no import edge into `game/`: the linedef half is vanilla's own
 * `sec->lines[]`, which `game/world.ts` already builds and memoizes.
 * `game/specials/movergeometry.ts` supplies both. See docs/render.md
 * § Mover meshes.
 */
export interface MoverIndex {
  subsectorsOf(sectorIndex: number): readonly number[];
  linesOf(sectorIndex: number): readonly number[];
}

/** One sector's worth of dynamic geometry — see `buildMoverMesh`. */
export interface MoverMesh {
  group: THREE.Group;
  meshes: Map<string, THREE.Mesh>;
  wallQuads: WallOccluder[];
  flatFans: FlatSurface[];
}

/**
 * What a map with no Boom transfer lines resolves to: every sector lights and
 * draws itself. Handed to the builders so they never branch on "is there a
 * transfer table", and so a caller that has no scan (tests, tools) is not a
 * special case.
 */
function ownTransfers(map: DoomMap): SectorTransfers {
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
  const { renderCeilings = false, wallHeightCap = 0, movableSectors, linesOf } = options;
  const transfers = options.transfers ?? ownTransfers(map);
  const batches = new BatchSet();
  const missing = new Set<string>();
  const occluders: WallOccluder[] = [];
  const flatSurfaces: FlatSurface[] = [];

  const texSize = (kind: SurfaceKind, name: string) => {
    const s = bank.size(kind, name);
    // A 242 control line's sidedef names colormaps, not textures — absent art
    // there is the feature working, not a hole in the WAD.
    if (!s && !transfers.colormapName(name)) missing.add(kind + ':' + name);
    return s;
  };

  const polys = buildSubSectorPolys(map);
  buildFlats(map, polys, batches, texSize, renderCeilings, flatSurfaces, transfers, linesOf, movableSectors);
  buildWalls(map, batches, texSize, wallHeightCap, occluders, transfers, movableSectors);
  buildSolidCaps(map, polys, batches, texSize, flatSurfaces, transfers);

  const group = new THREE.Group();
  group.name = 'map:' + map.name;
  let triangles = 0;
  const wallMeshes = new Map<string, THREE.Mesh>();
  const flatMeshes = new Map<string, THREE.Mesh>();

  for (const b of batches.all()) {
    if (b.positions.length === 0) continue;
    const material = bank.get(b.kind, b.texture);
    if (!material) continue;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(b.colors, 4));
    geom.computeBoundingSphere();

    const mesh = new THREE.Mesh(geom, material);
    mesh.name = b.key;
    mesh.frustumCulled = true;
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
  for (const surface of flatSurfaces) {
    if (flatMeshes.has(surface.key)) continue;
    const mesh = wallMeshes.get(surface.key);
    if (mesh) flatMeshes.set(surface.key, mesh);
  }

  return { group, missingTextures: [...missing].sort(), triangles, occluders, wallMeshes, flatSurfaces, flatMeshes, polys };
}

/**
 * One sector's touching geometry (its own flats, plus every wall quad on
 * either side of a line bordering it) as a small standalone mesh, for
 * game/specials.ts to own and rebuild whenever that sector's height changes.
 * `polys` must be the same array `buildMapMesh` used (or an equivalent one
 * from `buildSubSectorPolys`) — subsector footprints don't depend on sector
 * height, so recomputing them per mover/per frame would be pure waste.
 * `options.movableSectors` is required (not merely honoured): it is what
 * decides which of a shared line's two sides this mover owns, and without it
 * a line between two movers would have both of them build both sides.
 *
 * `index` is what keeps a rebuild proportional to the sector rather than to the
 * map — see `MoverIndex`.
 */
export function buildMoverMesh(
  map: DoomMap,
  polys: SubSectorPoly[],
  sectorIndex: number,
  bank: MaterialBank,
  options: MapMeshOptions,
  index: MoverIndex,
): MoverMesh {
  const { batches, wallQuads, flatFans } = buildMoverBatches(map, polys, sectorIndex, bank, options, index);

  const group = new THREE.Group();
  const meshes = new Map<string, THREE.Mesh>();
  for (const b of batches) {
    const material = bank.get(b.kind, b.texture)!;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(b.colors, 4));
    geom.computeBoundingSphere();

    const mesh = new THREE.Mesh(geom, material);
    mesh.name = b.key;
    group.add(mesh);
    meshes.set(b.key, mesh);
  }

  return { group, meshes, wallQuads, flatFans };
}

/**
 * Rewrites an existing mover mesh from the sector's current heights **in
 * place**, and returns false — leaving `mesh` untouched — when the sector's
 * geometry no longer fits the buffers it was built with, which is the caller's
 * cue to build a fresh one.
 *
 * The records are updated field-by-field rather than replaced because
 * `WallFader`/`FlatFader` hold the arrays and index smoothing state into them.
 * See docs/render.md § Mover meshes for when the buffers stop fitting and why
 * a moving sector must not reallocate.
 */
export function refreshMoverMesh(
  mesh: MoverMesh,
  map: DoomMap,
  polys: SubSectorPoly[],
  sectorIndex: number,
  bank: MaterialBank,
  options: MapMeshOptions,
  index: MoverIndex,
): boolean {
  const { batches, wallQuads, flatFans } = buildMoverBatches(map, polys, sectorIndex, bank, options, index);
  if (
    batches.length !== mesh.meshes.size ||
    wallQuads.length !== mesh.wallQuads.length ||
    flatFans.length !== mesh.flatFans.length
  ) {
    return false;
  }
  // Validated before anything is written, so a refusal can't leave the mesh
  // half-rewritten.
  for (const b of batches) {
    const attr = mesh.meshes.get(b.key)?.geometry.getAttribute('position');
    if (!attr || attr.array.length !== b.positions.length) return false;
  }

  for (const b of batches) {
    const geom = mesh.meshes.get(b.key)!.geometry;
    writeAttribute(geom, 'position', b.positions);
    writeAttribute(geom, 'uv', b.uvs);
    writeAttribute(geom, 'color', b.colors);
    geom.computeBoundingSphere();
  }
  for (let i = 0; i < wallQuads.length; i++) Object.assign(mesh.wallQuads[i], wallQuads[i]);
  for (let i = 0; i < flatFans.length; i++) Object.assign(mesh.flatFans[i], flatFans[i]);
  return true;
}

function writeAttribute(geom: THREE.BufferGeometry, name: string, values: number[]): void {
  const attr = geom.getAttribute(name) as THREE.BufferAttribute;
  (attr.array as Float32Array).set(values);
  attr.needsUpdate = true;
}

/**
 * `buildMoverMesh`'s geometry pass, shared with `refreshMoverMesh` — everything
 * up to the three.js objects. Only batches that will actually be drawn come
 * back, so both callers agree on what "the sector's batches" are without
 * re-deriving it.
 */
function buildMoverBatches(
  map: DoomMap,
  polys: SubSectorPoly[],
  sectorIndex: number,
  bank: MaterialBank,
  options: MapMeshOptions,
  index: MoverIndex,
): { batches: Batch[]; wallQuads: WallOccluder[]; flatFans: FlatSurface[] } {
  const { renderCeilings = false, wallHeightCap = 0, movableSectors } = options;
  const transfers = options.transfers ?? ownTransfers(map);
  const batches = new BatchSet();
  const texSize = (kind: SurfaceKind, name: string) => bank.size(kind, name);
  const wallQuads: WallOccluder[] = [];
  const flatFans: FlatSurface[] = [];

  // No `movableSectors` here on purpose: a mover is rebuilt alongside its
  // movable neighbours, so its lids cannot go stale against one.
  const holeFill = closedHoleFill(map, sectorIndex, index.linesOf(sectorIndex), transfers);
  for (const ss of index.subsectorsOf(sectorIndex)) {
    processFlat(map, polys[ss], ss, batches, texSize, renderCeilings, flatFans, transfers, holeFill);
  }

  // Own sides always; a neighbour's side only when that neighbour is static —
  // it has no mover of its own to build it, and its upper/lower step is sized
  // from *this* sector's moving heights. A neighbour that is itself movable
  // builds its own side and is rebuilt alongside this one (see
  // SpecialsController's neighbour propagation).
  const includeSide = (s: number) => s === sectorIndex || !movableSectors?.has(s);

  for (const lineIndex of index.linesOf(sectorIndex)) {
    processLine(map, map.linedefs[lineIndex], lineIndex, batches, texSize, wallHeightCap, wallQuads, transfers, includeSide);
  }

  const drawn = batches.all().filter((b) => b.positions.length > 0 && bank.get(b.kind, b.texture));
  return { batches: drawn, wallQuads, flatFans };
}

/** True if either side of `line` belongs to a sector in `sectors`. */
function touchesAny(map: DoomMap, line: LineDef, sectors: Set<number>): boolean {
  const front = line.right !== NO_SIDE ? map.sidedefs[line.right] : undefined;
  const back = line.left !== NO_SIDE ? map.sidedefs[line.left] : undefined;
  return (front !== undefined && sectors.has(front.sector)) || (back !== undefined && sectors.has(back.sector));
}

type SizeFn = (kind: SurfaceKind, name: string) => Size | null;

/** Floors and ceilings, triangulated per subsector (each one is convex). */
function buildFlats(
  map: DoomMap,
  polys: SubSectorPoly[],
  batches: BatchSet,
  size: SizeFn,
  renderCeilings: boolean,
  flatSurfaces: FlatSurface[],
  transfers: SectorTransfers,
  linesOf: ((sectorIndex: number) => readonly number[]) | undefined,
  movableSectors?: Set<number>,
): void {
  const fills = closedHoleFills(map, transfers, linesOf, movableSectors);
  for (let ss = 0; ss < polys.length; ss++) {
    if (movableSectors && movableSectors.has(polys[ss].sector)) continue;
    processFlat(map, polys[ss], ss, batches, size, renderCeilings, flatSurfaces, transfers, fills[polys[ss].sector]);
  }
}

/**
 * Lids over the map's solid structures — the rings of one-sided linedefs that
 * enclose no sector (render/solids.ts). Without them the overhead camera looks
 * straight into a pillar and out the far side, since its walls are drawn
 * single-sided and face away from the inside. docs/render.md § Solid structures.
 *
 * One surface **per triangle**, not one per lid: a ring is often concave, and
 * `FlatFader` tests a surface's footprint with the convex-only helper that
 * every other flat here satisfies. Triangles keep that contract, at the cost of
 * a big lid dissolving in pieces rather than all at once.
 */
function buildSolidCaps(
  map: DoomMap,
  polys: SubSectorPoly[],
  batches: BatchSet,
  size: SizeFn,
  flatSurfaces: FlatSurface[],
  transfers: SectorTransfers,
): void {
  for (const cap of findSolidCaps(map, polys)) {
    if (!size('wall', cap.texture)) continue;
    const subsector = subsectorNear(polys, cap);
    if (subsector < 0) continue;
    const light = transfers.ceilingLight(cap.sector);
    const lightSector = transfers.ceilingLightSector(cap.sector);
    for (const triangle of triangulate(cap.points)) {
      addFlatFan(
        { points: triangle, sector: cap.sector },
        subsector,
        batches,
        size,
        flatSurfaces,
        { texName: cap.texture, height: cap.height, light, lightSector, isCeiling: false },
        'wall',
      );
    }
  }
}

/** The subsector the lid's outside probe lands in — how fog of war decides whether it has been seen. */
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
 * The neighbouring sector a **sector** closes itself over, or -1 where it is
 * ordinary geometry. A sector whose *every* side is a two-sided drop with no
 * lower texture is a hole the mapper never meant to be looked into, and this
 * camera looks into every pit; the lid follows GZDoom's own render hack
 * (`hw_renderhacks.cpp: HandleMissingTextures` / `DoOneSectorLower`).
 * `lines` is every linedef bordering the sector — vanilla's `sec->lines[]`.
 * docs/render.md § Closed holes.
 */
function closedHoleFill(
  map: DoomMap,
  sectorIndex: number,
  lines: readonly number[],
  transfers: SectorTransfers,
  movableSectors?: Set<number>,
): number {
  const self = map.sectors[sectorIndex];
  // Boom's 242 idioms are built *on* missing textures, so the hack keeps clear.
  if (!self || transfers.heightSec(sectorIndex) >= 0) return -1;

  let from = -1;
  for (const lineIndex of lines) {
    const line = map.linedefs[lineIndex];
    if (!line) continue;
    const right = line.right === NO_SIDE ? undefined : map.sidedefs[line.right];
    const left = line.left === NO_SIDE ? undefined : map.sidedefs[line.left];
    // The line seen from this sector: whichever side it owns, and the one behind
    // it. A line with both sides here falls out at `back.sector` below.
    const side = right?.sector === sectorIndex ? right : left;
    if (!side || side.sector !== sectorIndex) continue;
    const back = side === right ? left : right;
    // A one-sided wall means the sector is a room, not a hole.
    if (!back) return -1;
    if (back.sector === sectorIndex) continue;
    const other = map.sectors[back.sector];
    if (!other || transfers.heightSec(back.sector) >= 0) return -1;
    // The lid is baked at this neighbour's height, so a movable one would leave
    // it stale — only `buildMoverBatches`, rebuilt alongside its movable
    // neighbours, passes no set.
    if (movableSectors?.has(back.sector)) return -1;
    // Every side a step down into the sector that draws nothing, and every one
    // of them the same step: the lid is one plane, so it has one height.
    if (other.floorHeight <= self.floorHeight || other.floorTex === SKY_FLAT) return -1;
    if (side.lower !== NO_TEXTURE && side.lower !== '') return -1;
    if (from >= 0 && other.floorHeight !== map.sectors[from].floorHeight) return -1;
    from = back.sector;
  }
  return from;
}

/**
 * Sector→bordering-linedefs for a caller that supplied no `linesOf`. Plain
 * adjacency, and deliberately **not** a second `sec->lines[]`: `closedHoleFill`
 * reads each line from one sector's side and is idempotent in it, so a line
 * listed twice changes no answer. The `P_GroupLines` ordering/dedupe rule has
 * one implementation, `game/world.ts: sectorLines`, which `linesOf` routes to.
 */
function borderingLines(map: DoomMap): number[][] {
  const lines: number[][] = Array.from({ length: map.sectors.length }, () => []);
  for (let i = 0; i < map.linedefs.length; i++) {
    const line = map.linedefs[i];
    for (const sideIndex of [line.right, line.left]) {
      if (sideIndex === NO_SIDE) continue;
      lines[map.sidedefs[sideIndex]?.sector]?.push(i);
    }
  }
  return lines;
}

/**
 * Every sector's `closedHoleFill` in one pass, indexed by sector — what
 * `buildFlats` hands each leaf. A mover builds its one sector's answer straight
 * from `MoverIndex.linesOf` instead.
 */
function closedHoleFills(
  map: DoomMap,
  transfers: SectorTransfers,
  linesOf: ((sectorIndex: number) => readonly number[]) | undefined,
  movableSectors?: Set<number>,
): Int32Array {
  const fallback = linesOf ? undefined : borderingLines(map);
  const fills = new Int32Array(map.sectors.length);
  for (let s = 0; s < fills.length; s++) {
    fills[s] = closedHoleFill(map, s, linesOf ? linesOf(s) : fallback![s], transfers, movableSectors);
  }
  return fills;
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

function processFlat(
  map: DoomMap,
  poly: SubSectorPoly,
  ss: number,
  batches: BatchSet,
  size: SizeFn,
  renderCeilings: boolean,
  flatSurfaces: FlatSurface[],
  transfers: SectorTransfers,
  /** The sector this leaf's own sector closes itself over (`closedHoleFill`), or -1. */
  holeFill: number,
): void {
  const n = poly.points.length / 2;
  if (n < 3) return;
  const sector = map.sectors[poly.sector];
  if (!sector) return;

  // Boom's 242: `R_FakeFlat` picks one of two views by where the eye is, and
  // this draws both at once — the pool bottom below a translucent surface — so
  // the player stays visible under water. Too shallow to hold a body, and there
  // is nothing to see between the two: that case falls back to vanilla's own
  // above-water view, one fan at the surface height wearing the sector's flat,
  // which is also the only way two planes a unit apart avoid z-fighting.
  // Where the control sector sits *below* instead, the one fan goes to
  // `drawnFloor` — vanilla's height for the invisible-platform idiom.
  // docs/specials.md § Deep water.
  const surfaceHeight = transfers.waterHeight(poly.sector);
  const deep = surfaceHeight !== null && surfaceHeight - sector.floorHeight >= WATER_MIN_DEPTH;
  // A pool bottom a mover has raised clear of the surface (`waterHeight` is null
  // once it reaches it) is the same ground it was, so it keeps the control
  // sector's flat and light rather than snapping to the water flat this sector
  // wears for its surface — a deviation from `R_FakeFlat`'s plain branch, which
  // draws that water flat. BOOMEDIT MAP01's stairs in sector 35's pool.
  // docs/specials.md § Deep water.
  const control = deep
    ? transfers.heightSec(poly.sector)
    : surfaceHeight === null
      ? transfers.poolBottom(poly.sector)
      : -1;
  const bottom = control >= 0 ? map.sectors[control] : undefined;
  // The bottom wears the control sector's flat, except where that sector has
  // none to lend (sky, or an unset slot) — falling back to the sector's own
  // keeps a pool with a floor rather than a hole in the level.
  const bottomTex =
    bottom && bottom.floorTex !== SKY_FLAT && bottom.floorTex !== NO_TEXTURE ? bottom.floorTex : undefined;
  const floorLightFrom = bottom ? control : poly.sector;
  // The pool bottom sits at the real floor; a shallow 242 draws its one floor at
  // the surface, exactly as vanilla does; below-floor control sectors land on the
  // fake floor.
  const floorHeight = deep ? sector.floorHeight : (surfaceHeight ?? transfers.drawnFloor(poly.sector));

  for (const isCeiling of renderCeilings ? FLOOR_AND_CEILING : FLOOR_ONLY) {
    addFlatFan(poly, ss, batches, size, flatSurfaces, {
      texName: isCeiling ? sector.ceilTex : (bottomTex ?? sector.floorTex),
      height: isCeiling ? sector.ceilHeight : floorHeight,
      light: isCeiling ? transfers.ceilingLight(poly.sector) : transfers.floorLight(floorLightFrom),
      lightSector: isCeiling
        ? transfers.ceilingLightSector(poly.sector)
        : transfers.floorLightSector(floorLightFrom),
      isCeiling,
    });
  }

  // The lid over a hole in the map (`closedHoleFill`), drawn on top of the real
  // floor as GZDoom draws its own. An ordinary `FlatSurface`, so `FlatFader`
  // dissolves it for a body underneath.
  if (holeFill >= 0) {
    addFlatFan(poly, ss, batches, size, flatSurfaces, {
      texName: map.sectors[holeFill].floorTex,
      height: map.sectors[holeFill].floorHeight,
      light: transfers.floorLight(holeFill),
      lightSector: transfers.floorLightSector(holeFill),
      isCeiling: false,
    });
  }

  // Which pool's surface covers this fan: this sector's own, or — for a sector
  // walled in by a pool but left out of its tag — that pool's, so the sheet runs
  // over the island instead of stopping at it. The island has to be *under* the
  // water for that: a chamber whose ceiling stands above the surface is dry
  // inside, whatever it is surrounded by. docs/specials.md § Deep water.
  const island = deep ? -1 : transfers.poolIsland(poly.sector);
  const islandSurface = island < 0 ? null : transfers.waterHeight(island);
  const submerged = islandSurface !== null && sector.ceilHeight <= islandSurface;
  const pool = deep ? poly.sector : submerged ? island : -1;
  const surfaceAt = deep ? surfaceHeight : islandSurface;
  if (pool >= 0 && surfaceAt !== null && surfaceAt - sector.floorHeight >= WATER_MIN_DEPTH) {
    addFlatFan(poly, ss, batches, size, flatSurfaces, {
      texName: map.sectors[pool].floorTex,
      height: surfaceAt,
      light: transfers.floorLight(pool),
      lightSector: transfers.floorLightSector(pool),
      isCeiling: false,
      baseAlpha: WATER_SURFACE_ALPHA,
    });
  }
}

function addFlatFan(
  poly: SectorPoly,
  ss: number,
  batches: BatchSet,
  size: SizeFn,
  flatSurfaces: FlatSurface[],
  spec: FlatSpec,
  /** Which bank the texture comes from: a solid structure's lid wears a *wall* texture (see `buildSolidCaps`). */
  kind: SurfaceKind = 'flat',
): void {
  const { texName, height, isCeiling } = spec;
  if (texName === SKY_FLAT || texName === NO_TEXTURE || texName === '') return;
  const dim = size(kind, texName);
  if (!dim) return;
  // Flats are 64x64 by definition and aligned to the world grid; a wall
  // texture borrowed for a lid tiles at its own size instead.
  const uw = kind === 'flat' ? 64 : dim.w;
  const uh = kind === 'flat' ? 64 : dim.h;

  const n = poly.points.length / 2;
  const color = litColor(spec.light);
  const alpha = spec.baseAlpha ?? 1;
  const batch = batches.get(kind, texName);
  const vertexStart = batch.positions.length / 3;

  // Fan triangulation around vertex 0. Floors keep the polygon's winding
  // (normal up), ceilings are reversed so their normal points down.
  for (let i = 1; i < n - 1; i++) {
    const idx = isCeiling ? [0, i + 1, i] : [0, i, i + 1];
    for (const k of idx) {
      const x = poly.points[k * 2];
      const y = poly.points[k * 2 + 1];
      pushVertex(batch, x, height, -y, x / uw, -y / uh, color, alpha);
    }
  }

  const vertexCount = batch.positions.length / 3 - vertexStart;
  if (vertexCount > 0) {
    flatSurfaces.push({
      key: batch.key,
      vertexStart,
      vertexCount,
      subsector: ss,
      sector: poly.sector,
      lightSector: spec.lightSector,
      points: poly.points,
      height,
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
  /** Linedef this quad belongs to, and whether it's the front (right) side — carried onto the occluder record for `SurfaceScroller`. */
  line: number;
  frontSide: boolean;
  /** Permanent translucency — a Boom 260 midtexture, and nothing else. */
  baseAlpha?: number;
}

/** True when the quad was drawn — what vanilla's `toptexture`/`bottomtexture` being non-zero decides (see `addTwoSidedSide`'s midtexture clip). */
function addWall(batches: BatchSet, size: SizeFn, spec: WallSpec, occluders: WallOccluder[]): boolean {
  if (spec.topH <= spec.botH) return false;
  if (spec.texture === NO_TEXTURE || spec.texture === '') return false;
  const dim = size('wall', spec.texture);
  if (!dim) return false;

  const dx = spec.bx - spec.ax;
  const dy = spec.by - spec.ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;

  // DOOM darkens east-west walls and brightens north-south ones so that
  // corners stay legible without real lighting (r_segs.c: R_StoreWallRange).
  const color = litColor(spec.light, wallContrast(spec.ax, spec.ay, spec.bx, spec.by));

  const u0 = spec.xOffset / dim.w;
  const u1 = (spec.xOffset + len) / dim.w;
  const vTop = (spec.pegRef - spec.topH + spec.yOffset) / dim.h;
  const vBot = (spec.pegRef - spec.botH + spec.yOffset) / dim.h;

  const batch = batches.get('wall', spec.texture);
  const { ax, ay, bx, by, topH, botH } = spec;

  // A = top-left, B = top-right, C = bottom-right, D = bottom-left, with the
  // face pointing to the right of a->b (DOOM's front side).
  const A = [ax, topH, -ay, u0, vTop] as const;
  const B = [bx, topH, -by, u1, vTop] as const;
  const C = [bx, botH, -by, u1, vBot] as const;
  const D = [ax, botH, -ay, u0, vBot] as const;

  const vertexStart = batch.positions.length / 3;
  for (const v of [A, D, C, A, C, B]) {
    pushVertex(batch, v[0], v[1], v[2], v[3], v[4], color, spec.baseAlpha ?? 1);
  }
  occluders.push({
    key: batch.key,
    vertexStart,
    vertexCount: 6,
    ax,
    ay,
    bx,
    by,
    botH,
    topH,
    sector: spec.sector,
    line: spec.line,
    frontSide: spec.frontSide,
    baseAlpha: spec.baseAlpha,
  });
  return true;
}

function buildWalls(
  map: DoomMap,
  batches: BatchSet,
  size: SizeFn,
  wallHeightCap: number,
  occluders: WallOccluder[],
  transfers: SectorTransfers,
  movableSectors?: Set<number>,
): void {
  for (const [lineIndex, line] of map.linedefs.entries()) {
    // Whole line, both sides: a static neighbour's step is sized from the
    // moving sector's heights, so it can't stay in a batch nobody rebuilds
    // (see MapMeshOptions.movableSectors).
    if (movableSectors && touchesAny(map, line, movableSectors)) continue;
    processLine(map, line, lineIndex, batches, size, wallHeightCap, occluders, transfers);
  }
}

function processLine(
  map: DoomMap,
  line: LineDef,
  lineIndex: number,
  batches: BatchSet,
  size: SizeFn,
  wallHeightCap: number,
  occluders: WallOccluder[],
  transfers: SectorTransfers,
  /**
   * Per-side filter: a side is only built if this returns true for its owning
   * sector (undefined = build every side, the static-batch case, which now
   * excludes movable lines wholesale before it gets here). `buildMoverMesh`
   * needs *side* granularity rather than line granularity for the one case
   * where a line's two sides have different owners: between two movable
   * sectors (e.g. a switch mounted on a lift's own frame) each mover builds
   * only its own side, or both would build both and double every quad.
   */
  includeSide?: (sectorIndex: number) => boolean,
): void {
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
    // Solid wall: the middle texture spans the whole sector height — down to the
    // *drawn* floor, so a 242 fake floor is not left ringed by the gap the flat
    // moved away from (`Transfers.drawnFloor`, docs/render.md § Deep water).
    const unpegged = (line.flags & LF.LOWER_UNPEGGED) !== 0;
    const floor = transfers.drawnFloor(front.sector);
    const dim = size('wall', front.middle);
    addWall(
      batches,
      size,
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
      occluders,
    );
    return;
  }

  if (!front || !back || !frontSec || !backSec) return;

  // Two-sided line: each side gets its own step-up/step-down pieces, sized
  // against the *drawn* heights opposite it. `addTwoSidedSide` resolves those
  // from the two sector indexes rather than taking them apart, so the only thing
  // that differs between the two calls is which side is doing the looking.
  if (!includeSide || includeSide(front.sector)) {
    addTwoSidedSide(batches, size, line.flags, v1, v2, front, front.sector, frontSec, back.sector, backSec, cap, occluders, lineIndex, true, transfers);
  }
  if (!includeSide || includeSide(back.sector)) {
    addTwoSidedSide(batches, size, line.flags, v2, v1, back, back.sector, backSec, front.sector, frontSec, cap, occluders, lineIndex, false, transfers);
  }
}

/**
 * The ceiling a side of a two-sided line is sized against: the neighbour's
 * *drawn* ceiling, which a Boom 242 moves (`Transfers.drawnCeiling`), except
 * where the sector doing the looking has a 242 of its own.
 *
 * That exception is where a mesh built once has to stand in for a branch
 * vanilla picks per frame: an eye *inside* a 242 sector takes `R_FakeFlat`'s
 * above-ceiling branch, which hands the real ceiling straight back. Resolving
 * it against the sector the quads face into costs nothing, because that is the
 * only place they are ever seen from. docs/render.md § Deep water.
 */
function ceilingFacing(transfers: SectorTransfers, other: Sector, otherIndex: number, viewerSector: number): number {
  return transfers.heightSec(viewerSector) >= 0 ? other.ceilHeight : transfers.drawnCeiling(otherIndex);
}

function addTwoSidedSide(
  batches: BatchSet,
  size: SizeFn,
  flags: number,
  a: Pos2,
  b: Pos2,
  side: SideDef,
  secIndex: number,
  sec: Sector,
  otherIndex: number,
  other: Sector,
  cap: (sec: Sector, top: number) => number,
  occluders: WallOccluder[],
  lineIndex: number,
  frontSide: boolean,
  transfers: SectorTransfers,
): void {
  // The heights this side is *sized* against. Boom's 242 moves the floors on
  // both sides of the line and the ceiling only on the neighbour's: vanilla
  // fakes front and back sector alike (`r_bsp.c: R_AddLine`), and only the
  // ceiling half has a branch that turns on where the eye is (`ceilingFacing`).
  // Everything below reads these, never `sec.floorHeight`/`other.ceilHeight` —
  // except the midtexture's peg anchor, which is the one thing 242 leaves alone.
  const otherCeil = ceilingFacing(transfers, other, otherIndex, secIndex);
  const selfFloor = transfers.drawnFloor(secIndex);
  const otherFloor = transfers.drawnFloor(otherIndex);
  const base = {
    ax: a.x,
    ay: a.y,
    bx: b.x,
    by: b.y,
    xOffset: side.xOffset,
    yOffset: side.yOffset,
    light: sec.light,
    sector: secIndex,
    line: lineIndex,
    frontSide,
  };
  const upperUnpegged = (flags & LF.UPPER_UNPEGGED) !== 0;
  const lowerUnpegged = (flags & LF.LOWER_UNPEGGED) !== 0;

  // Upper: this sector's ceiling is higher than the neighbour's.
  let upperDrawn = false;
  if (sec.ceilHeight > otherCeil && !(sec.ceilTex === SKY_FLAT && other.ceilTex === SKY_FLAT)) {
    const dim = size('wall', side.upper);
    upperDrawn = addWall(
      batches,
      size,
      {
        ...base,
        topH: cap(sec, sec.ceilHeight),
        botH: Math.min(cap(sec, sec.ceilHeight), otherCeil),
        texture: side.upper,
        pegRef: upperUnpegged ? sec.ceilHeight : otherCeil + (dim?.h ?? 128),
      },
      occluders,
    );
  }

  // Lower: the neighbour's floor is higher, so a step faces this side. A 242
  // pool's surface never moves this — its bottom is drawn at the real floor, and
  // a step sized to the surface would ring that bottom with a hole. A 242 *fake
  // floor* does, on both sides at once, because there the one drawn floor is the
  // fake one (`Transfers.drawnFloor`, docs/render.md § Deep water).
  let lowerDrawn = false;
  if (otherFloor > selfFloor) {
    lowerDrawn = addWall(
      batches,
      size,
      {
        ...base,
        topH: otherFloor,
        botH: selfFloor,
        texture: side.lower,
        pegRef: lowerUnpegged ? sec.ceilHeight : otherFloor,
      },
      occluders,
    );
  }

  // Middle: optional masked texture (grates, bars) hung across the line. Boom's
  // 260 makes one translucent, and overloads this same name to point at the
  // translucency map — in which case there is no texture to draw at all.
  // docs/specials.md § Translucent midtextures.
  if (side.middle !== NO_TEXTURE && side.middle !== '' && !transfers.midtexSuppressed(lineIndex)) {
    const dim = size('wall', side.middle);
    if (dim) {
      // What the midtexture is cut to: the tiers this side actually drew, which
      // is the opening only where both of them are there. A step whose texture
      // the mapper left off draws nothing and so cuts nothing, and the
      // midtexture runs on to this sector's own floor/ceiling — the barred-gate
      // idiom depends on it (`r_segs.c: R_RenderSegLoop`'s `ceilingclip =
      // yl - 1` / `floorclip = yh + 1`, docs/render.md § Mesh building). Two
      // sky ceilings are vanilla's one exception: `R_StoreWallRange` pulls the
      // front ceiling down to the back's before any of this ("hack to allow
      // height changes in outdoor areas"), so the cut lands there instead.
      const skyPair = sec.ceilTex === SKY_FLAT && other.ceilTex === SKY_FLAT;
      const clipTop = skyPair ? otherCeil : upperDrawn ? Math.min(sec.ceilHeight, otherCeil) : sec.ceilHeight;
      const clipBot = lowerDrawn ? Math.max(selfFloor, otherFloor) : selfFloor;
      // The quad is the texture's own band — one copy hung off the pegged
      // anchor, sidedef y-offset included — clipped to that range, never sized
      // to it: vanilla draws a masked midtexture once and lets the seg's clip
      // arrays cut it (r_segs.c: R_RenderMaskedSegRange).
      //
      // The anchor is the seg's *real* sectors even where the opening is a 242's
      // drawn one: `R_RenderMaskedSegRange` reads `curline->frontsector` and
      // `->backsector` straight off the seg, and runs `R_FakeFlat` only to pick
      // the light level. docs/render.md § Deep water.
      const pegTop = Math.min(sec.ceilHeight, other.ceilHeight);
      const pegBot = Math.max(sec.floorHeight, other.floorHeight);
      const pegRef = lowerUnpegged ? pegBot + dim.h : pegTop;
      const texTop = pegRef + side.yOffset;
      const top = Math.min(clipTop, texTop);
      const bot = Math.max(clipBot, texTop - dim.h);
      addWall(
        batches,
        size,
        {
          ...base,
          topH: top,
          botH: bot,
          texture: side.middle,
          pegRef,
          baseAlpha: transfers.translucentLine(lineIndex) ? TRANSLUCENT_ALPHA : undefined,
        },
        occluders,
      );
    }
  }
}
