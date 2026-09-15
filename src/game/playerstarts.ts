/**
 * Where a player enters a level and where a dead one comes back: the four player starts a map
 * places (doomednums 1–4), the level-start pick, `G_DoReborn`'s spot, and a deathmatch's random
 * draw over its own starts (doomednum 11). Pure over a {@link World}; collision is the caller's.
 * docs/multiplayer-coop.md § Starts and § Respawn, docs/multiplayer-deathmatch.md § Starts.
 */
import { ThingType } from './things/doomednums.ts';
import type { World } from './world.ts';
import { spawnAngleDeg } from './skill.ts';
import { DM_START_TRIES } from './rules.ts';
import { pRandom } from '../util/random.ts';
import type { Placement, Pos2 } from '../types.ts';

/** `MAXPLAYERS` (`doomdef.h`): as many slots as there are coop starts. */
export const MAX_PLAYERS = 4;

/** The doomednum of each slot's start, by slot. */
export const START_TYPES: readonly number[] = [ThingType.playerStart, ThingType.playerStart2, ThingType.playerStart3, ThingType.playerStart4];

/**
 * Each slot's start as the map places it, null where it places none — vanilla's
 * `playerstarts[type - 1]` ({@link World.placedStart}). Slot 0's is {@link World.playerStart},
 * map-centre fallback included.
 */
export function coopStarts(world: World): (Placement | null)[] {
  const starts: (Placement | null)[] = [world.playerStart()];
  for (let slot = 1; slot < MAX_PLAYERS; slot++) starts.push(world.placedStart(START_TYPES[slot]));
  return starts;
}

/**
 * Where `slot` enters the level: its own start, with no occupancy test (`P_SpawnPlayer`). A map
 * placing no start for it — where vanilla spawns no body at all — gives it the first start no
 * earlier slot took, and player 1's when every one is taken. docs/multiplayer-coop.md § Starts.
 *
 * @param taken  where the earlier slots stand
 */
export function levelStartFor(starts: readonly (Placement | null)[], slot: number, taken: readonly Pos2[]): Placement {
  const own = starts[slot];
  if (own) return own;
  for (const start of starts) {
    if (start && !spotTaken(taken, start)) return start;
  }
  return starts[0]!;
}

/** Whether an earlier slot already stands on `at` — {@link levelStartFor}'s occupancy test. */
export function spotTaken(taken: readonly Pos2[], at: Pos2): boolean {
  return taken.some((t) => t.x === at.x && t.y === at.y);
}

/**
 * `G_DoReborn`'s spot for a coop respawn: `own` when `blocked` refuses nothing there, else the
 * first start in slot order that is free — arriving the way that start faces — else `own` anyway
 * ("he's going to be inside something. Too bad."). docs/multiplayer-coop.md § Respawn.
 *
 * @param blocked  `G_CheckSpot`'s `P_CheckPosition`
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

/**
 * Every deathmatch start the map places, in map order — `P_SpawnMapThing`'s `deathmatchstarts`,
 * with Boom's unlimited count (`prboom p_mobj.c`, killough 1/11/98) rather than vanilla's ten.
 * docs/multiplayer-deathmatch.md § Starts.
 */
export function deathmatchStarts(world: World): Placement[] {
  return world
    .thingsOfType(ThingType.deathmatchStart)
    .map((t) => ({ x: t.x, y: t.y, angle: (spawnAngleDeg(t.angle) * Math.PI) / 180 }));
}

/**
 * `G_DeathMatchSpawnPlayer`'s pick (`g_game.c`): up to {@link DM_START_TRIES} draws of
 * `P_Random() % selections`, the first start `blocked` allows; null when every draw was refused —
 * the caller falls back on the slot's coop start, as vanilla does on `playerstarts[playernum]`.
 * **Deviation:** any number of starts is played, where vanilla refuses fewer than four; a map with
 * none is a coop-starts game. docs/multiplayer-deathmatch.md § Starts.
 *
 * @param draw  the random draw, {@link pRandom} unless a test supplies one
 */
export function deathmatchSpot(
  starts: readonly Placement[],
  blocked: (at: Pos2) => boolean,
  draw: () => number = pRandom,
): Placement | null {
  if (starts.length === 0) return null;
  for (let tries = 0; tries < DM_START_TRIES; tries++) {
    const start = starts[draw() % starts.length];
    if (!blocked(start)) return start;
  }
  return null;
}
