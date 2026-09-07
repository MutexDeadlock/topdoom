/**
 * The build a mesh is accumulated into: one `Batch` per texture, the vertex push every surface
 * goes through, and turning a finished batch into a three.js mesh.
 * See docs/render.md § Mesh building.
 */
import * as THREE from 'three';
import type { DoomMap } from '../../wad/map.ts';
import type { LeafGraph, SubSectorPoly } from '../bsp.ts';
import type { LightCells } from '../lights.ts';
import type { MaterialBank, Size, SurfaceKind } from '../textures.ts';
import type { Pos2 } from '../../types.ts';
import { vecLength } from '../../util/geom.ts';
import { lightSegment } from '../sectorlight.ts';
import { wallProbePoint, type FlatSurface, type SectorTransfers, type WallOccluder } from './defs.ts';

/** The batches a build is accumulating into, one per `batchKey`. */
export class BatchSet {
  private batches = new Map<string, Batch>();

  get(kind: SurfaceKind, texture: string): Batch {
    const key = batchKey(kind, texture);
    let b = this.batches.get(key);
    if (!b) {
      b = { key, kind, texture, positions: [], uvs: [], colors: [], segs: [], cells: [], shade: [], sky: [] };
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

export type SizeFn = (kind: SurfaceKind, name: string) => Size | null;

/**
 * The working set every builder below threads: the map, the options resolved once, and the
 * batches and records they append to. One covers either the whole map's static geometry or a
 * single mover's sector — which of the two is `holdsStill`/`includeSide`, and nothing else here
 * knows the difference. See docs/render.md § Mesh building.
 */
export interface Build {
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
  /** How many upper steps this build left out as ceiling trims — see `BuiltMap.trimmedUppers`. */
  trimmedUppers: number;
  renderCeilings: boolean;
  wallHeightCap: number;
  movableSectors?: Set<number>;
  subsectorAt?: (x: number, y: number) => number;
  /** The cells surfaces file their light lists under — `aLightCell`, docs/lights.md § Light cells. */
  lightCells: LightCells;
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
 * One vertex into a batch's attribute arrays. Scalars rather than a record, and the file's
 * only signature this long: it runs once per emitted vertex, so a point parameter would allocate
 * one per vertex — docs/conventions.md § Named arguments.
 */
export function pushVertex(
  b: Batch,
  x: number,
  y: number,
  z: number,
  u: number,
  v: number,
  /** How lit the surface is — `lightSegment` of its light and fake contrast, for `Batch.segs`. */
  seg: number,
  alpha = 1,
  /**
   * -1 leaves the cell unresolved: wall quads get theirs from `fillWallCells` once the occluders
   * exist.
   */
  cell = -1,
  /** 1 marks the vertex as standing under sky; 0, the default, is indoors. */
  sky = 0,
  /** 0 leaves the vertex unshaded, which every wall and every open stretch of floor is. */
  shade = 0,
): void {
  b.positions.push(x, y, z);
  b.uvs.push(u, v);
  // RGB is a flat 1 — the shader multiplies the light in. Only alpha varies, and the faders own it.
  b.colors.push(1, 1, 1, alpha);
  b.segs.push(seg);
  b.cells.push(cell);
  b.shade.push(shade);
  b.sky.push(sky);
}

/**
 * Resolves each wall quad's leaf and stamps the light cell it files under onto that quad's
 * vertices — the cell of the quad's midpoint in that leaf, the chunk reaching at most half
 * `WALL_CHUNK_LEN` from it — so the dynamic-light shader can ask whether a light reached the room
 * this wall faces. Runs once the quads exist rather than inside `addWall`, for a value the
 * occluder records anyway. Without `MapMeshOptions.subsectorAt` (tests, tools) the quads stay at
 * -1, which the shader reads as an empty light list — unlit. docs/lights.md § Light stops at
 * walls, § Light cells.
 */
export function fillWallCells(build: Build): void {
  const { subsectorAt, batches, lightCells } = build;
  if (!subsectorAt) return;
  const probe: Pos2 = { x: 0, y: 0 };
  for (const o of build.occluders) {
    const halfLen = vecLength(o.bx - o.ax, o.by - o.ay) / 2;
    if (halfLen < 1e-6) continue;
    wallProbePoint(o.ax, o.ay, o.bx, o.by, probe);
    o.subsector = subsectorAt(probe.x, probe.y);
    const cells = batches.byKey(o.key)?.cells;
    if (!cells) continue;
    const cell = o.subsector < 0 ? -1 : lightCells.cellFor(o.subsector, (o.ax + o.bx) / 2, (o.ay + o.by) / 2, halfLen);
    for (let v = 0; v < o.vertexCount; v++) cells[o.vertexStart + v] = cell;
  }
}

/** The batches that end up on screen: the ones that emitted anything and whose art the bank has. */
export function drawnBatches(build: Build): Batch[] {
  return build.batches.all().filter((b) => b.positions.length > 0 && build.bank.get(b.kind, b.texture));
}

/** One batch as a three.js mesh: the attributes it actually carries, named by its key. */
export function batchMesh(batch: Batch, material: THREE.Material): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(batch.colors, 4));
  // A plain byte, not normalized: the shader wants the segment 0-15 as it is.
  geom.setAttribute('aLightSeg', new THREE.Uint8BufferAttribute(batch.segs, 1));
  geom.setAttribute('aLightCell', new THREE.Float32BufferAttribute(batch.cells, 1));
  setUnitAttribute(geom, 'aWallShade', batch.shade);
  setUnitAttribute(geom, 'aSkyLit', batch.sky);
  geom.computeBoundingSphere();

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = batch.key;
  return mesh;
}

export function writeAttribute(geom: THREE.BufferGeometry, name: string, values: number[]): void {
  const attr = geom.getAttribute(name) as THREE.BufferAttribute;
  (attr.array as Float32Array | Uint8Array).set(values);
  attr.needsUpdate = true;
}

/**
 * Relights one run of vertices to `light` — one byte each, and the whole of a relight, since no
 * brightness is stored per vertex. `MoverGeometry.recolorSector` is the other caller.
 * docs/render.md § Distance lighting.
 */
export function relightRange(
  geom: THREE.BufferGeometry,
  start: number,
  count: number,
  light: number,
  contrast = 0,
): void {
  const seg = geom.getAttribute('aLightSeg') as THREE.BufferAttribute;
  const s = lightSegment(light, contrast);
  for (let v = start; v < start + count; v++) seg.setX(v, s);
}

/** Flags what `relightRange` wrote for upload. */
export function markRelit(geom: THREE.BufferGeometry | undefined): void {
  if (!geom) return;
  geom.getAttribute('aLightSeg').needsUpdate = true;
}

interface Batch {
  key: string;
  kind: SurfaceKind;
  texture: string;
  positions: number[];
  uvs: number[];
  /** Per vertex RGBA, but only A carries anything: RGB is a flat 1 — see `pushVertex`. */
  colors: number[];
  /**
   * Per vertex, the light segment the shader samples the ramp at — the `aLightSeg` attribute, and
   * the only record of how lit a surface is (docs/render.md § Distance lighting). Constant across
   * a quad or a fan, and the one thing a relight rewrites.
   */
  segs: number[];
  /**
   * Per vertex, the light cell the surface faces into — the `aLightCell` attribute (docs/lights.md
   * § Light stops at walls, § Light cells).
   */
  cells: number[];
  /**
   * Per vertex, how occluded by a wall standing on it this point is — the `aWallShade` attribute
   * (docs/render.md § Wall contact shading). Zero everywhere but a floor near a wall.
   */
  shade: number[];
  /**
   * Per vertex, 1 where the surface faces a sector roofed with sky — the `aSkyLit` attribute
   * (docs/render.md § Outdoor sky tint). Constant across a quad or a fan; per vertex because that
   * is where the shader can read it.
   */
  sky: number[];
}

/** A batch's identity, and the key `MoverMesh.meshes` files its three.js mesh under. */
function batchKey(kind: SurfaceKind, texture: string): string {
  return kind + ':' + texture;
}

/**
 * One per-vertex amount in [0, 1] as a normalized byte, or no attribute at all where every value
 * is 0 — see docs/render.md § What the buffers cost for both halves and what each saves. An
 * attribute three never binds reads back as 0 in the shader, which is what both of these already
 * mean, so dropping it changes nothing a draw can see.
 */
function setUnitAttribute(geom: THREE.BufferGeometry, name: string, values: number[]): void {
  const bytes = new Uint8Array(values.length);
  let any = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0) continue;
    bytes[i] = Math.round(values[i] * 255);
    any = true;
  }
  if (any) geom.setAttribute(name, new THREE.Uint8BufferAttribute(bytes, 1, true));
}
