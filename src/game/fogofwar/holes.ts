/**
 * The holes in the wall: sectors too small to be a place — a sound channel or a vent through the
 * wall mass — which the fog explores like any other and never draws. docs/fogofwar.md § Holes in
 * the wall.
 */
import { vecLength } from '../../util/geom.ts';
import { NO_SIDE } from '../../wad/map.ts';
import type { World } from '../world.ts';

/**
 * A hole in the wall is lower than this (tuned by feel: an 8-high sound channel is one, a 24-high
 * crawlspace is not) — the first of {@link findHoleSectors}' limits.
 * docs/fogofwar.md § Holes in the wall.
 */
const HOLE_BELOW_HEIGHT = 16;
/** …no wider than this across its bounding box (tuned by feel)… */
const HOLE_MAX_WIDTH = 16;
/** …walled in, by one-sided or shut lines, for at least this share of its boundary (tuned by feel)… */
const HOLE_MIN_WALLED = 0.5;
/** …and has no opening line this long, a body's width (tuned by feel). */
const HOLE_OPENING_BELOW = 32;

/**
 * The sectors too small to be a place — within all four `HOLE_*` limits, roofed (its ceiling below
 * that of every open neighbour a body fits in, so the top of a block standing just under a ceiling
 * is not one), and nothing a special drives. Read off the heights the map loads with.
 * docs/fogofwar.md § Holes in the wall.
 *
 * @returns per sector, 1 for a hole
 */
export function findHoleSectors(world: World, movable: ReadonlySet<number>): Uint8Array {
  const map = world.map;
  const n = map.sectors.length;
  const minX = new Float64Array(n).fill(Infinity);
  const minY = new Float64Array(n).fill(Infinity);
  const maxX = new Float64Array(n).fill(-Infinity);
  const maxY = new Float64Array(n).fill(-Infinity);
  const perimeter = new Float64Array(n);
  const walled = new Float64Array(n);
  const wideOpening = new Uint8Array(n);
  const roof = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < map.linedefs.length; i++) {
    const line = map.linedefs[i];
    const a = map.vertexes[line.v1];
    const b = map.vertexes[line.v2];
    const front = map.sidedefs[line.right]?.sector ?? -1;
    const back = line.left === NO_SIDE ? -1 : (map.sidedefs[line.left]?.sector ?? -1);
    // Sides by index rather than over a pair array: this runs per line of the map at level load.
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? front : back;
      if (s < 0) continue;
      minX[s] = Math.min(minX[s], a.x, b.x);
      minY[s] = Math.min(minY[s], a.y, b.y);
      maxX[s] = Math.max(maxX[s], a.x, b.x);
      maxY[s] = Math.max(maxY[s], a.y, b.y);
    }
    // A line with the same sector on both sides runs through the sector, not round it.
    if (front < 0 || front === back) continue;
    const len = vecLength(b.x - a.x, b.y - a.y);
    if (back < 0) {
      perimeter[front] += len;
      walled[front] += len;
      continue;
    }
    const shut = world.blocksSight(i);
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? front : back;
      const other = map.sectors[side === 0 ? back : front];
      perimeter[s] += len;
      if (shut) {
        walled[s] += len;
        continue;
      }
      if (len >= HOLE_OPENING_BELOW) wideOpening[s] = 1;
      // A neighbour too low for a body is the same channel carrying on, not a room over it.
      if (other.ceilHeight - other.floorHeight >= HOLE_BELOW_HEIGHT) roof[s] = Math.min(roof[s], other.ceilHeight);
    }
  }
  const holes = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    const sector = map.sectors[s];
    const height = sector.ceilHeight - sector.floorHeight;
    if (height <= 0 || height >= HOLE_BELOW_HEIGHT || movable.has(s) || wideOpening[s]) continue;
    if (sector.ceilHeight >= roof[s]) continue;
    if (Math.min(maxX[s] - minX[s], maxY[s] - minY[s]) > HOLE_MAX_WIDTH) continue;
    if (perimeter[s] === 0 || walled[s] < perimeter[s] * HOLE_MIN_WALLED) continue;
    holes[s] = 1;
  }
  return holes;
}
