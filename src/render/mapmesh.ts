import * as THREE from 'three';
import { LF, NO_SIDE, type DoomMap, type SideDef, type Sector } from '../wad/map.ts';
import { buildSubSectorPolys } from './bsp.ts';
import type { MaterialBank, SurfaceKind } from './textures.ts';

export const SKY_FLAT = 'F_SKY1';
const NO_TEXTURE = '-';

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

/** Sector light level (0..255) as a linear-ish vertex colour, plus fake contrast. */
export function lightToColor(light: number, contrast = 0): number {
  const l = Math.max(0, Math.min(255, light + contrast)) / 255;
  // Slight lift so pitch-dark sectors stay readable from a top-down camera.
  return Math.pow(l, 0.85) * 0.9 + 0.1;
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
}

export function buildMapMesh(
  map: DoomMap,
  bank: MaterialBank,
  options: MapMeshOptions = {},
): BuiltMap {
  const { renderCeilings = false, wallHeightCap = 0 } = options;
  const batches = new BatchSet();
  const missing = new Set<string>();
  const occluders: WallOccluder[] = [];
  const flatSurfaces: FlatSurface[] = [];

  const texSize = (kind: SurfaceKind, name: string) => {
    const s = bank.size(kind, name);
    if (!s) missing.add(kind + ':' + name);
    return s;
  };

  buildFlats(map, batches, texSize, renderCeilings, flatSurfaces);
  buildWalls(map, batches, texSize, wallHeightCap, occluders);

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

  return { group, missingTextures: [...missing].sort(), triangles, occluders, wallMeshes, flatSurfaces, flatMeshes };
}

type SizeFn = (kind: SurfaceKind, name: string) => { w: number; h: number } | null;

/** Floors and ceilings, triangulated per subsector (each one is convex). */
function buildFlats(
  map: DoomMap,
  batches: BatchSet,
  size: SizeFn,
  renderCeilings: boolean,
  flatSurfaces: FlatSurface[],
): void {
  const polys = buildSubSectorPolys(map);

  for (let ss = 0; ss < polys.length; ss++) {
    const poly = polys[ss];
    const n = poly.points.length / 2;
    if (n < 3) continue;
    const sector = map.sectors[poly.sector];
    if (!sector) continue;

    for (const isCeiling of renderCeilings ? [false, true] : [false]) {
      const texName = isCeiling ? sector.ceilTex : sector.floorTex;
      if (texName === SKY_FLAT || texName === NO_TEXTURE || texName === '') continue;
      if (!size('flat', texName)) continue;

      const height = isCeiling ? sector.ceilHeight : sector.floorHeight;
      const color = lightToColor(sector.light);
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
      if (vertexCount > 0) flatSurfaces.push({ key: batch.key, vertexStart, vertexCount, subsector: ss });
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

  // DOOM brightens east-west walls and darkens north-south ones so that
  // corners stay legible without real lighting.
  const contrast = dy === 0 ? 16 : dx === 0 ? -16 : 0;
  const color = lightToColor(spec.light, contrast);

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
  occluders.push({ key: batch.key, vertexStart, vertexCount: 6, ax, ay, bx, by, botH, topH });
}

function buildWalls(
  map: DoomMap,
  batches: BatchSet,
  size: SizeFn,
  wallHeightCap: number,
  occluders: WallOccluder[],
): void {
  for (const line of map.linedefs) {
    const v1 = map.vertexes[line.v1];
    const v2 = map.vertexes[line.v2];
    if (!v1 || !v2) continue;

    const front = line.right !== NO_SIDE ? map.sidedefs[line.right] : undefined;
    const back = line.left !== NO_SIDE ? map.sidedefs[line.left] : undefined;
    const frontSec = front ? map.sectors[front.sector] : undefined;
    const backSec = back ? map.sectors[back.sector] : undefined;

    const cap = (sec: Sector, top: number) =>
      wallHeightCap > 0 ? Math.min(top, sec.floorHeight + wallHeightCap) : top;

    if (front && frontSec && !backSec) {
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
        },
        occluders,
      );
      continue;
    }

    if (!front || !back || !frontSec || !backSec) continue;

    // Two-sided line: each side gets its own step-up/step-down pieces.
    addTwoSidedSide(batches, size, line.flags, v1, v2, front, frontSec, backSec, cap, occluders);
    addTwoSidedSide(batches, size, line.flags, v2, v1, back, backSec, frontSec, cap, occluders);
  }
}

function addTwoSidedSide(
  batches: BatchSet,
  size: SizeFn,
  flags: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  side: SideDef,
  sec: Sector,
  other: Sector,
  cap: (sec: Sector, top: number) => number,
  occluders: WallOccluder[],
): void {
  const base = { ax: a.x, ay: a.y, bx: b.x, by: b.y, xOffset: side.xOffset, yOffset: side.yOffset, light: sec.light };
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
