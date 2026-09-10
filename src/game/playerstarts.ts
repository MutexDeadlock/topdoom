/**
 * Where a player enters a level and where a dead one comes back in coop: the four player starts a
 * map places (doomednums 1–4), the level-start pick, and `G_DoReborn`'s spot. Pure over a `World`;
 * the collision test is the caller's. docs/multiplayer-coop.md § Starts and § Respawn.
 */
import { ThingType } from './things/doomednums.ts';
import type { World } from './world.ts';
import type { Placement, Pos2 } from '../types.ts';

/** `MAXPLAYERS` (`doomdef.h`): as many slots as there are coop starts. */
export const MAX_PLAYERS = 4;

/** The doomednum of each slot's start, by slot. */
const START_TYPES = [ThingType.playerStart, ThingType.playerStart2, ThingType.playerStart3, ThingType.playerStart4];

/**
 * Each slot's start as the map places it, null where it places none — vanilla's
 * `playerstarts[type - 1]` (`World.placedStart`). Slot 0's is `World.playerStart`, map-centre
 * fallback included.
 */
export function coopStarts(world: World): (Placement | null)[] {
  const starts: (Placement | null)[] = [world.playerStart()];
  for (let slot = 1; slot < MAX_PLAYERS; slot++) starts.push(world.placedStart(START_TYPES[slot]));
  return starts;
}

/**
 * Where `slot` enters the level: its own start, with no occupancy test (`P_SpawnPlayer`). A map
 * placing no start for it — where vanilla spawns no body at all — gives it the first start no
 * earlier slot took, and player 1's when every one is taken. `taken` is where the earlier slots
 * stand. docs/multiplayer-coop.md § Starts.
 */
export function levelStartFor(starts: readonly (Placement | null)[], slot: number, taken: readonly Pos2[]): Placement {
  const own = starts[slot];
  if (own) return own;
  for (const start of starts) {
    if (start && !taken.some((at) => at.x === start.x && at.y === start.y)) return start;
  }
  return starts[0]!;
}

/**
 * `G_DoReborn`'s spot for a coop respawn: `own` when `blocked` refuses nothing there, else the
 * first start in slot order that is free — arriving the way that start faces — else `own` anyway
 * ("he's going to be inside something. Too bad."). `blocked` is `G_CheckSpot`'s
 * `P_CheckPosition`. docs/multiplayer-coop.md § Respawn.
 */
export function rebornSpot(
  starts: readonly (Placement | null)[],
  own: Placement,
  blocked: (at: Pos2) => boolean,
): Placement {
  if (!blocked(own)) return own;
  for (const start of starts) {
    if (start && !blocked(start)) return start;
  }
  return own;
}
