/**
 * The flat half of the build: a subsector's floor and ceiling fans, the solid caps and closed-hole
 * fills a top-down camera needs and vanilla never draws, and the grid they are diced on.
 * See docs/render.md § Mesh building and § Solid structures.
 */
import * as THREE from 'three';
import { isTextured, NO_LINE, NO_SIDE, segBackSide, segSide, SKY_FLAT, type DoomMap } from '../../wad/map.ts';
import type { SectorPoly, SubSectorPoly } from '../bsp.ts';
import { findSolidCaps, pointInPolygon, type SolidCap } from '../solids.ts';
import type { Size, SurfaceKind } from '../textures.ts';
import { WATER_SURFACE_ALPHA } from '../../constants.ts';
import { clipConvexPolygon, polygonBounds, signedPolygonArea2, type PolygonBounds } from '../../util/geom.ts';
import { beginWallShade, wallShadeAt } from '../wallshadow.ts';
import { skyLitSector } from '../skytint.ts';
import { lightSegment } from '../sectorlight.ts';
import { pushVertex, type Build, type SizeFn } from './build.ts';
import { FLAT_CELL_EXTENT, FLAT_GRID_LEN, FLAT_TEX_SIZE } from './defs.ts';

/** Floors and ceilings, triangulated per subsector (each one is convex). */
export function buildFlats(build: Build): void {
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
export function buildSolidCaps(build: Build): void {
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
export function beginHoleFills(build: Build): void {
  const leafCount = build.polys.length;
  const signature = floorSignature(build.map);
  // Every mover redoing this per refresh is most of a frame on a detailed map; nothing it reads has
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
export function closedHoleFill(leaf: number): number {
  return holeFills.stamp[leaf] === holeFills.pass ? holeFills.fills[leaf] : -1;
}

/**
 * Which fans one leaf draws and with what — every decision `processFlat` makes before a vertex
 * exists, written into `out` (grown as needed) and counted back. Split out from the emission so a
 * refresh can re-decide without re-dicing. docs/render.md § Mover meshes.
 */
export function flatSpecsOf(
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
    bottom && bottom.floorTex !== SKY_FLAT && isTextured(bottom.floorTex) ? bottom.floorTex : undefined;
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
export const flatSpecs: FlatSpec[] = [];

export function processFlat(build: Build, poly: SubSectorPoly, ss: number, holeFill: number): void {
  const count = flatSpecsOf(build, poly, holeFill, flatSpecs);
  for (let i = 0; i < count; i++) addFlatFan(build, poly, ss, flatSpecs[i]);
}

/**
 * The art a flat fan would draw with, or null where there is none — sky and the unset slot are
 * holes by design, a name the WAD has no lump for is one by accident. Shared with
 * `planFlatRefresh`, which must reach the same verdict about a fan it is *not* emitting.
 */
export function flatArt(kind: SurfaceKind, texName: string, size: SizeFn): Size | null {
  if (texName === SKY_FLAT || !isTextured(texName)) return null;
  return size(kind, texName);
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
      if (isTextured(own.lower)) continue;
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
  holeStepOut.textured = isTextured(own.lower);
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

/**
 * Below this a diced cell is degeneracy rather than geometry — a ring clipped by a grid line it
 * only grazes comes back as three near-collinear points. **Tuned by feel**: a robustness floor,
 * anywhere well under a square map unit and well over the clip's float noise.
 */
const FLAT_CELL_MIN_AREA = 0.05;

/** `diceOnGrid`'s ring box, reused for the same reason its clip buffers are. */
const ringBox: PolygonBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
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
function diceOnGrid(ring: ArrayLike<number>, fan: (cell: ArrayLike<number>, cx: number, cy: number) => void): void {
  polygonBounds(ring, ringBox);
  const { minX, maxX, maxY } = ringBox;
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
      // The scratch is handed straight on: `fan` copies what it reads before the next cell. The
      // grid square's centre goes with it — the cell lies wholly inside that square, so it is an
      // anchor `fan` needs no measurement of its own to have.
      if (cell.length >= 6 && Math.abs(signedPolygonArea2(cell)) > FLAT_CELL_MIN_AREA * 2) {
        fan(cell, (c + 0.5) * g, (r + 0.5) * g);
      }
    }
  }
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
  const seg = lightSegment(spec.light);
  const alpha = spec.baseAlpha ?? 1;
  const batch = build.batches.get(kind, texName);
  const vertexStart = batch.positions.length / 3;
  const xy: number[] = [];

  // Floors keep the polygon's winding (normal up); a ceiling gets the ring wound the other way.
  const ring = isCeiling ? reversedRing(poly.points) : poly.points;

  // A ceiling is never shaded — it is not drawn at all — so the query is asked only for a floor,
  // once per fan, and read back per vertex below.
  const shaded = !isCeiling && beginWallShade(build.map, build.transfers, poly, height);
  const sky = skyLitSector(build.map.sectors[poly.sector]) ? 1 : 0;

  // The light cell the fan being emitted files under — see `fanCell`.
  let lightCell = build.lightCells.wholeCell(ss);
  const emit = (cell: ArrayLike<number>, i: number): void => {
    const x = cell[i * 2];
    const y = cell[i * 2 + 1];
    pushVertex(batch, x, height, -y, x / uw, -y / uh, seg, alpha, lightCell, sky, shaded ? wallShadeAt(x, y) : 0);
    xy.push(x, y);
  };
  // Each grid cell is convex and small, so fanning it costs no slivers — see `diceOnGrid`. Its
  // light cell is the one the grid square's centre falls in: the cell lies wholly inside that
  // square, so every vertex is within `FLAT_CELL_EXTENT` of the centre (docs/lights.md § Light
  // cells).
  const fanCell = (cell: ArrayLike<number>, cx: number, cy: number): void => {
    lightCell = build.lightCells.cellFor(ss, cx, cy, FLAT_CELL_EXTENT);
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
