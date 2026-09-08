/**
 * The contact shading a wall lays on the floor at its foot, baked per flat vertex at mesh build
 * time: from overhead a room otherwise reads as a flat-lit cutout, since nothing in vanilla's
 * lighting varies within a sector. See docs/render-lighting.md § Wall contact shading.
 */
import { NO_SIDE, type DoomMap } from '../wad/map.ts';
import { distSqToSegment } from '../util/geom.ts';
import { readStorage, writeStorage } from '../util/storage.ts';
import { MAX_STEP_UP, sectorLines } from '../game/world.ts';
import type { SectorPoly } from './bsp.ts';
import type { SectorTransfers } from './mapmesh.ts';

const STORAGE_KEY = 'wallShade';

/**
 * How far the darkening reaches from a wall, in map units. Tuned by feel, and it may not drop under
 * `FLAT_GRID_LEN` — docs/render-lighting.md § Wall contact shading. Exported for the test, which
 * sizes its samples from it rather than mirroring the number.
 */
export const RADIUS = 112;

/**
 * How dark the floor goes where it meets a wall, as a fraction of its lit colour. Tuned by feel —
 * this is the whole dial, and the toggle below is it against zero.
 */
export const STRENGTH = 0.35;

/**
 * Whether the shading is drawn at all. On by default. Shaped like every persisted setting —
 * docs/menu.md § Persisted settings — and carried as a live uniform rather than baked into the
 * vertex colours, so the menu reaches a level already running (docs/render-lighting.md § Turning
 * it off).
 */
let enabled = readStorage(STORAGE_KEY, true);

/** Every linedef facing one sector: endpoints flattened, and the sector across each (-1 for none). */
interface SectorWalls {
  xy: Float64Array;
  other: Int32Array;
}

/**
 * What `sectorWalls` answers with, weak on the map and built once: a mover's rebuild asks the same
 * question of the same fixed geometry every tic.
 */
const sectorWallCache = new WeakMap<DoomMap, SectorWalls[]>();

/**
 * The walls in reach of the fan being emitted, flattened endpoints, and how many of those numbers
 * are live. Module scratch reused across every flat on the map — `mapmesh.ts`'s own idiom
 * (`flatSpecs`), and for the same reason: this runs per leaf on a map with tens of thousands.
 */
const near: number[] = [];
let nearCount = 0;

/**
 * The strength every map material multiplies `aWallShade` by (`textures.ts`). One object shared by
 * every program, the `LightUniforms` pattern: three reads it per draw, so writing it here is the
 * whole of turning the effect off.
 */
export const wallShadeUniform = { value: enabled ? STRENGTH : 0 };

export function getWallShade(): boolean {
  return enabled;
}

export function setWallShade(on: boolean): void {
  enabled = on;
  wallShadeUniform.value = on ? STRENGTH : 0;
  writeStorage(STORAGE_KEY, on);
}

/**
 * Collects the walls that can shade one fan — its sector's own lines, which is where a wall
 * bounding it can stand — and answers whether any did, so the caller can skip `wallShadeAt` for a
 * fan nothing stands on. `wallShadeAt` reads what this left behind, so the two are one call apart.
 */
export function beginWallShade(
  map: DoomMap,
  transfers: SectorTransfers,
  poly: SectorPoly,
  height: number,
): boolean {
  nearCount = 0;
  const sector = sectorWalls(map)[poly.sector];
  if (!sector) return false;
  const { points } = poly;
  let loX = Infinity;
  let loY = Infinity;
  let hiX = -Infinity;
  let hiY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    if (points[i] < loX) loX = points[i];
    if (points[i] > hiX) hiX = points[i];
    if (points[i + 1] < loY) loY = points[i + 1];
    if (points[i + 1] > hiY) hiY = points[i + 1];
  }
  loX -= RADIUS;
  loY -= RADIUS;
  hiX += RADIUS;
  hiY += RADIUS;
  for (let i = 0; i < sector.other.length; i++) {
    const ax = sector.xy[i * 4];
    const ay = sector.xy[i * 4 + 1];
    const bx = sector.xy[i * 4 + 2];
    const by = sector.xy[i * 4 + 3];
    // The fan's footprint grown by the radius: a line clear of it on either axis reaches no vertex
    // of the fan, and growing it by the same radius either side of a BSP split is what makes two
    // leaves of one sector agree along the edge they share.
    if (ax < loX && bx < loX) continue;
    if (ax > hiX && bx > hiX) continue;
    if (ay < loY && by < loY) continue;
    if (ay > hiY && by > hiY) continue;
    if (!risesAbove(sector.other[i], height, transfers)) continue;
    near[nearCount++] = ax;
    near[nearCount++] = ay;
    near[nearCount++] = bx;
    near[nearCount++] = by;
  }
  return nearCount > 0;
}

/**
 * How occluded this point on the fan is, 0 (open floor) to 1 (against a wall) — what the
 * `aWallShade` attribute carries. Quadratic, so the darkening sits against the wall instead of
 * spreading evenly over the whole radius.
 */
export function wallShadeAt(x: number, y: number): number {
  let best = RADIUS * RADIUS;
  for (let i = 0; i < nearCount; i += 4) {
    const d2 = distSqToSegment(x, y, near[i], near[i + 1], near[i + 2], near[i + 3]);
    if (d2 < best) best = d2;
  }
  const t = Math.sqrt(best) / RADIUS;
  return (1 - t) * (1 - t);
}

/**
 * `sectorLines`' own lines (`game/world.ts`, vanilla's `sec->lines[]`) with the endpoints and the
 * sector across each hoisted out of the WAD records, because the filter above runs once per line
 * per leaf.
 */
function sectorWalls(map: DoomMap): SectorWalls[] {
  const hit = sectorWallCache.get(map);
  if (hit) return hit;

  const built = map.sectors.map((_, s) => {
    const lines = sectorLines(map, s);
    const xy = new Float64Array(lines.length * 4);
    const other = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const line = map.linedefs[lines[i]];
      const a = map.vertexes[line.v1];
      const b = map.vertexes[line.v2];
      if (a && b) {
        xy[i * 4] = a.x;
        xy[i * 4 + 1] = a.y;
        xy[i * 4 + 2] = b.x;
        xy[i * 4 + 3] = b.y;
      }
      const front = line.right === NO_SIDE ? undefined : map.sidedefs[line.right]?.sector;
      const back = line.left === NO_SIDE ? undefined : map.sidedefs[line.left]?.sector;
      const across = front === s ? back : front;
      other[i] = across ?? -1;
    }
    return { xy, other };
  });
  sectorWallCache.set(map, built);
  return built;
}

/**
 * Whether a wall stands on this floor along that line: void across it, a step up too tall to walk,
 * or a ceiling across it already down at this floor (a closed door). A neighbour whose ceiling
 * merely hangs lower casts nothing — the floor is what this shades, and that wall never reaches it.
 */
function risesAbove(other: number, height: number, transfers: SectorTransfers): boolean {
  if (other < 0) return true;
  // A rise the player walks up is floor, not wall: shading every 8-unit stair tread turns a
  // staircase into stripes. `MAX_STEP_UP` is vanilla's `MAXSTEPSIZE` (`game/world.ts`).
  if (transfers.drawnFloor(other) - height >= MAX_STEP_UP) return true;
  return transfers.drawnCeiling(other) - height < MAX_STEP_UP;
}
