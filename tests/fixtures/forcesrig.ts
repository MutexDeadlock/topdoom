/**
 * A `Forces` over a gridMap with one tagged sector and one Boom parameter line driving it — the
 * shape the conveyor, pusher and friction suites all stand on, since all three configure a sector
 * exactly that way and differ only in which special and which sector bit.
 * docs/specials-forces.md, docs/testing.md § Shared helpers.
 */
import { Forces } from '../../src/game/specials/forces.ts';
import { makeTouchCache, World } from '../../src/game/world.ts';
import { addControlLine, gridMap, type CellHeights } from './gridmap.ts';

/** The tag every rig below hangs its control line and its sector on. */
export const TAG = 7;

export interface ForcesRigOptions {
  /** The control line's vector: length and direction, which is the dial each of these specials reads. */
  dx?: number;
  dy?: number;
  /** The generalized sector bit the special needs, where it needs one (`PUSH_MASK`, `FRICTION_MASK`). */
  sectorBit?: number;
  /** The playfield, where a case needs more than three open cells. */
  art?: readonly string[];
  heights?: Record<string, CellHeights>;
}

/**
 * Three cells in a row by default, the middle one tagged and driven by `special`.
 *
 * @returns the grid, the middle cell's sector index, the live `Forces` with one tic already run,
 *          and the touch cache its per-body queries take
 */
export function forcesRig(special: number, options: ForcesRigOptions = {}) {
  const { dx = 128, dy = 0, sectorBit = 0, art = ['...'], heights } = options;
  const grid = gridMap(art, heights ? { heights } : {});
  const middle = grid.index(1, 0);
  grid.map.sectors[middle].tag = TAG;
  if (sectorBit !== 0) grid.map.sectors[middle].special = sectorBit;
  addControlLine(grid.map, dx, dy, special, TAG);
  const forces = new Forces(grid.map, new World(grid.map));
  forces.tick();
  return { grid, middle, forces, cache: makeTouchCache() };
}
