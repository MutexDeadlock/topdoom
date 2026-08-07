import * as THREE from 'three';
import { LF, NO_SIDE, SKY_FLAT, type DoomMap, type LineDef, type SideDef, type Sector } from '../wad/map.ts';
import { buildSubSectorPolys, type SubSectorPoly } from './bsp.ts';
import type { MaterialBank, Size, SurfaceKind } from './textures.ts';
import type { Pos2 } from '../types.ts';
import { BRIGHTNESS_LIFT } from '../constants.ts';

/** DOOM's sentinel for "no texture assigned" in a sidedef texture slot — also used by `game/specials.ts`'s `raiseToTexture` to skip unset bottom textures. */
export const NO_TEXTURE = '-';

/**
 * DOOM's map plane is (x, y) with z as height. three.js is y-up, so a DOOM
 * point (x, y, z) becomes (x, z, -y). Everything below works in DOOM units.
 */
export function doomToWorld(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
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
 * multiplier.
 *
 * Vanilla never scales a colour by the light level directly — it picks a row
 * of the `COLORMAP` lump and remaps every palette index through it, and that
 * ramp is nothing like linear in light level. These numbers are *measured*
 * from the real lump rather than modelled: for each colormap row, the mean
 * ratio of remapped to original luminance across the PLAYPAL colours bright
 * enough for the ratio to mean anything. Same rigor as the sprite/death-frame
 * tables elsewhere — and DOOM.WAD's and DOOM2.WAD's COLORMAPs are byte for
 * byte identical, with Freedoom's within 0.003, so one baked table serves all
 * three. (Per-colour spread is ~12% of the mean, so a single scalar per row is
 * a fair summary; the colormap desaturates slightly as it darkens.)
 *
 * `r_main.c` builds the row index as `startmap - scale/DISTMAP`, where
 * `startmap = (15 - lightnum) * 4` and the subtracted term grows as a surface
 * gets *closer* — vanilla's lighting diminishes with distance, so the light
 * level really sets how fast a surface falls off rather than a flat
 * brightness. This engine has no distance lighting (the camera hangs at a
 * near-constant distance from everything it draws), so the ramp is sampled at
 * one fixed reference distance: `REFERENCE_STEPS` is that subtracted term.
 * 4 corresponds to a ~300-unit viewing distance, and is chosen because it puts
 * a uniform ~0.12 of display brightness between adjacent light segments across
 * light 112-208 — 88% of every sector in the stock IWADs. It is the knob to
 * turn if the whole game reads too dark or too bright; raising it brightens
 * and eventually flattens the bright end, lowering it darkens.
 *
 * Note both ends necessarily saturate: vanilla spends 4 colormap rows per
 * light segment, so its 16 segments want 64 rows and only 32 exist. Light
 * <= 96 (2.8% of stock sectors) all bottom out together, as do 224 and 240
 * (9%). That is vanilla's own ramp, not a shortcut — it simply doesn't show
 * up in vanilla, where distance fills the range back in.
 */
const COLORMAP_GAIN = [
  1.0, 0.9662, 0.9055, 0.8253, 0.7552, 0.6956, 0.6437, 0.584,
  0.5366, 0.4949, 0.4492, 0.4067, 0.3632, 0.3282, 0.2946, 0.2627,
  0.2317, 0.2023, 0.1765, 0.1526, 0.1312, 0.1086, 0.0918, 0.0758,
  0.0621, 0.0492, 0.0383, 0.0288, 0.0202, 0.0142, 0.0082, 0.0034,
];

/** See above: vanilla's distance term, sampled at one fixed viewing distance. */
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
 * drift apart the way they once did.
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

function pushVertex(b: Batch, x: number, y: number, z: number, u: number, v: number, c: number, alpha = 1): void {
  b.positions.push(x, y, z);
  b.uvs.push(u, v);
  b.colors.push(c, c, c, alpha);
}

export interface MapMeshOptions {
  /** Ceilings block a top-down camera, so they are off by default. */
  renderCeilings?: boolean;
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
   * rebuilds on demand.
   */
  movableSectors?: Set<number>;
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
  /** Linedef this quad was built from — for `TextureScroller` (render/occlusion.ts) to find special-48's front side. */
  line: number;
  /** True if this quad came from the linedef's front (right) sidedef — vanilla's `sidenum[0]`, the only side a scrolling special ever animates. */
  frontSide: boolean;
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
  /** DOOM (x, y) footprint of this subsector, flattened — see FlatFader. */
  points: Float64Array;
  /** World height (floor or ceiling) this surface sits at. */
  height: number;
  isCeiling: boolean;
}

/** One sector's worth of dynamic geometry — see `buildMoverMesh`. */
export interface MoverMesh {
  group: THREE.Group;
  meshes: Map<string, THREE.Mesh>;
  wallQuads: WallOccluder[];
  flatFans: FlatSurface[];
}

export function buildMapMesh(map: DoomMap, bank: MaterialBank, options: MapMeshOptions = {}): BuiltMap {
  const { renderCeilings = false, wallHeightCap = 0, movableSectors } = options;
  const batches = new BatchSet();
  const missing = new Set<string>();
  const occluders: WallOccluder[] = [];
  const flatSurfaces: FlatSurface[] = [];

  const texSize = (kind: SurfaceKind, name: string) => {
    const s = bank.size(kind, name);
    if (!s) missing.add(kind + ':' + name);
    return s;
  };

  const polys = buildSubSectorPolys(map);
  buildFlats(map, polys, batches, texSize, renderCeilings, flatSurfaces, movableSectors);
  buildWalls(map, batches, texSize, wallHeightCap, occluders, movableSectors);

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
 */
export function buildMoverMesh(
  map: DoomMap,
  polys: SubSectorPoly[],
  sectorIndex: number,
  bank: MaterialBank,
  options: MapMeshOptions = {},
): MoverMesh {
  const { renderCeilings = false, wallHeightCap = 0, movableSectors } = options;
  const batches = new BatchSet();
  const texSize = (kind: SurfaceKind, name: string) => bank.size(kind, name);
  const wallQuads: WallOccluder[] = [];
  const flatFans: FlatSurface[] = [];

  for (let ss = 0; ss < polys.length; ss++) {
    if (polys[ss].sector !== sectorIndex) continue;
    processFlat(map, polys[ss], ss, batches, texSize, renderCeilings, flatFans);
  }

  // Own sides always; a neighbour's side only when that neighbour is static —
  // it has no mover of its own to build it, and its upper/lower step is sized
  // from *this* sector's moving heights. A neighbour that is itself movable
  // builds its own side and is rebuilt alongside this one (see
  // SpecialsController's neighbour propagation).
  const includeSide = (s: number) => s === sectorIndex || !movableSectors?.has(s);

  for (const [lineIndex, line] of map.linedefs.entries()) {
    if (!touchesSector(map, line, sectorIndex)) continue;
    processLine(map, line, lineIndex, batches, texSize, wallHeightCap, wallQuads, includeSide);
  }

  const group = new THREE.Group();
  const meshes = new Map<string, THREE.Mesh>();
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
    group.add(mesh);
    meshes.set(b.key, mesh);
  }

  return { group, meshes, wallQuads, flatFans };
}

/** True if either side of `line` belongs to `sectorIndex`. */
function touchesSector(map: DoomMap, line: LineDef, sectorIndex: number): boolean {
  const front = line.right !== NO_SIDE ? map.sidedefs[line.right] : undefined;
  const back = line.left !== NO_SIDE ? map.sidedefs[line.left] : undefined;
  return front?.sector === sectorIndex || back?.sector === sectorIndex;
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
  movableSectors?: Set<number>,
): void {
  for (let ss = 0; ss < polys.length; ss++) {
    if (movableSectors && movableSectors.has(polys[ss].sector)) continue;
    processFlat(map, polys[ss], ss, batches, size, renderCeilings, flatSurfaces);
  }
}

function processFlat(
  map: DoomMap,
  poly: SubSectorPoly,
  ss: number,
  batches: BatchSet,
  size: SizeFn,
  renderCeilings: boolean,
  flatSurfaces: FlatSurface[],
): void {
  const n = poly.points.length / 2;
  if (n < 3) return;
  const sector = map.sectors[poly.sector];
  if (!sector) return;

  for (const isCeiling of renderCeilings ? [false, true] : [false]) {
    const texName = isCeiling ? sector.ceilTex : sector.floorTex;
    if (texName === SKY_FLAT || texName === NO_TEXTURE || texName === '') continue;
    if (!size('flat', texName)) continue;

    const height = isCeiling ? sector.ceilHeight : sector.floorHeight;
    const color = litColor(sector.light);
    const batch = batches.get('flat', texName);
    const vertexStart = batch.positions.length / 3;

    // Fan triangulation around vertex 0. Floors keep the polygon's winding
    // (normal up), ceilings are reversed so their normal points down.
    for (let i = 1; i < n - 1; i++) {
      const idx = isCeiling ? [0, i + 1, i] : [0, i, i + 1];
      for (const k of idx) {
        const x = poly.points[k * 2];
        const y = poly.points[k * 2 + 1];
        // Flats are 64x64 and aligned to the world grid, never to the sector.
        pushVertex(batch, x, height, -y, x / 64, -y / 64, color);
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
        points: poly.points,
        height,
        isCeiling,
      });
    }
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
  /** Linedef this quad belongs to, and whether it's the front (right) side — carried onto the occluder record for `TextureScroller`. */
  line: number;
  frontSide: boolean;
}

function addWall(batches: BatchSet, size: SizeFn, spec: WallSpec, occluders: WallOccluder[]): void {
  if (spec.topH <= spec.botH) return;
  if (spec.texture === NO_TEXTURE || spec.texture === '') return;
  const dim = size('wall', spec.texture);
  if (!dim) return;

  const dx = spec.bx - spec.ax;
  const dy = spec.by - spec.ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;

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
    pushVertex(batch, v[0], v[1], v[2], v[3], v[4], color);
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
  });
}

function buildWalls(
  map: DoomMap,
  batches: BatchSet,
  size: SizeFn,
  wallHeightCap: number,
  occluders: WallOccluder[],
  movableSectors?: Set<number>,
): void {
  for (const [lineIndex, line] of map.linedefs.entries()) {
    // Whole line, both sides: a static neighbour's step is sized from the
    // moving sector's heights, so it can't stay in a batch nobody rebuilds
    // (see MapMeshOptions.movableSectors).
    if (movableSectors && touchesAny(map, line, movableSectors)) continue;
    processLine(map, line, lineIndex, batches, size, wallHeightCap, occluders);
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
    // Solid wall: the middle texture spans the whole sector height.
    const unpegged = (line.flags & LF.LOWER_UNPEGGED) !== 0;
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
        botH: frontSec.floorHeight,
        texture: front.middle,
        xOffset: front.xOffset,
        yOffset: front.yOffset,
        pegRef: unpegged ? frontSec.floorHeight + (dim?.h ?? 128) : frontSec.ceilHeight,
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

  // Two-sided line: each side gets its own step-up/step-down pieces.
  if (!includeSide || includeSide(front.sector)) {
    addTwoSidedSide(batches, size, line.flags, v1, v2, front, front.sector, frontSec, backSec, cap, occluders, lineIndex, true);
  }
  if (!includeSide || includeSide(back.sector)) {
    addTwoSidedSide(batches, size, line.flags, v2, v1, back, back.sector, backSec, frontSec, cap, occluders, lineIndex, false);
  }
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
  other: Sector,
  cap: (sec: Sector, top: number) => number,
  occluders: WallOccluder[],
  lineIndex: number,
  frontSide: boolean,
): void {
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
  if (sec.ceilHeight > other.ceilHeight && !(sec.ceilTex === SKY_FLAT && other.ceilTex === SKY_FLAT)) {
    const dim = size('wall', side.upper);
    addWall(
      batches,
      size,
      {
        ...base,
        topH: cap(sec, sec.ceilHeight),
        botH: Math.min(cap(sec, sec.ceilHeight), other.ceilHeight),
        texture: side.upper,
        pegRef: upperUnpegged ? sec.ceilHeight : other.ceilHeight + (dim?.h ?? 128),
      },
      occluders,
    );
  }

  // Lower: the neighbour's floor is higher, so a step faces this side.
  if (other.floorHeight > sec.floorHeight) {
    addWall(
      batches,
      size,
      {
        ...base,
        topH: other.floorHeight,
        botH: sec.floorHeight,
        texture: side.lower,
        pegRef: lowerUnpegged ? sec.ceilHeight : other.floorHeight,
      },
      occluders,
    );
  }

  // Middle: optional masked texture (grates, bars) inside the opening.
  if (side.middle !== NO_TEXTURE && side.middle !== '') {
    const dim = size('wall', side.middle);
    if (dim) {
      const openTop = Math.min(sec.ceilHeight, other.ceilHeight);
      const openBot = Math.max(sec.floorHeight, other.floorHeight);
      let top: number;
      let bot: number;
      if (lowerUnpegged) {
        bot = openBot;
        top = Math.min(openTop, openBot + dim.h);
      } else {
        top = openTop;
        bot = Math.max(openBot, openTop - dim.h);
      }
      addWall(batches, size, { ...base, topH: top, botH: bot, texture: side.middle, pegRef: top }, occluders);
    }
  }
}
