/**
 * The netgame rules the host sets — deathmatch, friendly fire, the frag and time limits — plus the
 * frag and clock arithmetic a death, the scoreboard and the limits share. The three a tic reads are
 * session settings `replay/settings.ts` captures and pins; the mode is the host's stored pick
 * alone. docs/multiplayer-deathmatch.md.
 */
import { TICRATE } from '../constants.ts';
import { readStorage, writeStorage } from '../util/storage.ts';
import type { PlayerHit } from './combat.ts';

/** `G_DeathMatchSpawnPlayer`'s `for (j=0 ; j<20 ; j++)` (`g_game.c`): draws before giving up. */
export const DM_START_TRIES = 20;

/** `P_SpawnSpecials`' `-timer` (`p_spec.c`): `levelTimeCount = minutes * 60 * TICRATE`. */
export const TICS_PER_MINUTE = 60 * TICRATE;

/**
 * The last seconds of a time limit the center message counts down, one line a second. No vanilla
 * counterpart — `P_UpdateSpecials` ends the level unannounced; ten is tuned by feel.
 * docs/multiplayer-deathmatch.md § Limits.
 */
export const TIME_LIMIT_COUNTDOWN_SECONDS = 10;

/**
 * How near the kill limit a player's kill is announced from, in kills. No counterpart in Boom,
 * whose `-frags` ends the level unannounced; three is tuned by feel.
 * docs/multiplayer-deathmatch.md § Limits.
 */
export const KILL_LIMIT_WARNING = 3;

const DEATHMATCH_STORAGE_KEY = 'deathmatch';
const FRIENDLY_FIRE_STORAGE_KEY = 'friendlyFire';
const FRAG_LIMIT_STORAGE_KEY = 'fragLimit';
const TIME_LIMIT_STORAGE_KEY = 'timeLimit';

/**
 * Whether the host's next room runs as a deathmatch — vanilla's `-altdeath` rules, the only
 * deathmatch here (docs/multiplayer-deathmatch.md § Rules). Never pinned and never read by a tic:
 * the room carries it in `NetRules`, and `Game` decides the mode once. Shaped like every persisted
 * setting — docs/menu.md § Persisted settings.
 */
let deathmatch = readStorage(DEATHMATCH_STORAGE_KEY, false);
/**
 * Whether a coop player's shots and missiles hit the other players — vanilla's always-on rule,
 * off by default here. docs/multiplayer-deathmatch.md § Friendly fire.
 */
let friendlyFire = readStorage(FRIENDLY_FIRE_STORAGE_KEY, false);
/** Net frags that end a deathmatch level, 0 for none — Boom's `-frags`. */
let fragLimit = readStorage(FRAG_LIMIT_STORAGE_KEY, 0);
/** Minutes that end a deathmatch level, 0 for none — vanilla's `-timer`. */
let timeLimit = readStorage(TIME_LIMIT_STORAGE_KEY, 0);

export function getDeathmatch(): boolean {
  return deathmatch;
}

export function setDeathmatch(enabled: boolean): void {
  deathmatch = enabled;
  writeStorage(DEATHMATCH_STORAGE_KEY, enabled);
}

export function getFriendlyFire(): boolean {
  return friendlyFire;
}

export function setFriendlyFire(enabled: boolean): void {
  friendlyFire = enabled;
  writeStorage(FRIENDLY_FIRE_STORAGE_KEY, enabled);
}

export function overrideFriendlyFire(enabled: boolean | null): void {
  friendlyFire = enabled ?? readStorage(FRIENDLY_FIRE_STORAGE_KEY, false);
}

export function getFragLimit(): number {
  return fragLimit;
}

export function setFragLimit(limit: number): void {
  fragLimit = asLimit(limit);
  writeStorage(FRAG_LIMIT_STORAGE_KEY, fragLimit);
}

export function overrideFragLimit(limit: number | null): void {
  fragLimit = limit === null ? readStorage(FRAG_LIMIT_STORAGE_KEY, 0) : asLimit(limit);
}

export function getTimeLimit(): number {
  return timeLimit;
}

export function setTimeLimit(minutes: number): void {
  timeLimit = asLimit(minutes);
  writeStorage(TIME_LIMIT_STORAGE_KEY, timeLimit);
}

export function overrideTimeLimit(minutes: number | null): void {
  timeLimit = minutes === null ? readStorage(TIME_LIMIT_STORAGE_KEY, 0) : asLimit(minutes);
}

/**
 * A player's net frags: everyone else they killed, minus themselves — `WI_fragSum` (`wi_stuff.c`)
 * and the status bar's `st_fragscount` (`st_stuff.c`) agree on it. The suicide slot counts against
 * you, so a match can go negative. docs/multiplayer-deathmatch.md § Frags.
 *
 * @param frags  the player's own row, indexed by the slot they killed
 * @param self  the player's slot
 */
export function fragSum(frags: readonly number[], self: number): number {
  let sum = 0;
  for (let slot = 0; slot < frags.length; slot++) sum += slot === self ? -frags[slot] : frags[slot];
  return sum;
}

/**
 * Whose frag a player's death is — `P_KillMobj` (`p_inter.c`): the player who dealt the killing
 * hit, the victim themselves for their own; nobody for a monster's (`source` a mobj that is no
 * player); the victim for a hit nothing dealt (`!source`). docs/multiplayer-deathmatch.md § Frags.
 *
 * @param victim  the dying player's slot
 * @returns the slot whose `frags[victim]` counts it, or null for none
 */
export function fragCredit(victim: number, hit: PlayerHit): number | null {
  if (hit.slot !== undefined) return hit.slot;
  return hit.source ? null : victim;
}

/**
 * The second a time limit's countdown reaches on this tic: a whole second of the last
 * {@link TIME_LIMIT_COUNTDOWN_SECONDS}, on the one tic the clock stands on it.
 * docs/multiplayer-deathmatch.md § Limits.
 *
 * @param levelTics  the level's clock in tics
 * @param minutes    the time limit, 0 for none
 * @returns null on every other tic, and with no limit
 */
export function timeLimitCountdown(levelTics: number, minutes: number): number | null {
  const left = minutes * TICS_PER_MINUTE - levelTics;
  if (minutes <= 0 || left <= 0 || left % TICRATE !== 0) return null;
  return left <= TIME_LIMIT_COUNTDOWN_SECONDS * TICRATE ? left / TICRATE : null;
}

/**
 * What the HUD clock reads under a time limit: the whole seconds left, rounded up, so it stands on
 * a second exactly when the countdown names it. docs/multiplayer-deathmatch.md § Limits.
 *
 * @param levelTics  the level's clock in tics
 * @param minutes    the time limit, 0 for none
 * @returns null with no limit
 */
export function timeLimitLeft(levelTics: number, minutes: number): number | null {
  return minutes > 0 ? secondsUntil(levelTics, minutes * TICS_PER_MINUTE) : null;
}

/**
 * The whole seconds from `tics` to `dueTics`, rounded up and never negative: what a countdown
 * line reads, so the HUD clock and the death overlay's count agree on the last second.
 */
export function secondsUntil(tics: number, dueTics: number): number {
  return Math.max(0, Math.ceil((dueTics - tics) / TICRATE));
}

/**
 * The kills a player still needs to reach the kill limit, where their net kills stand within
 * {@link KILL_LIMIT_WARNING} of it. docs/multiplayer-deathmatch.md § Limits.
 *
 * @param netFrags   the player's net kills
 * @param fragLimit  the limit, 0 for none
 * @returns null with no limit, further off, or at it
 */
export function killsToLimit(netFrags: number, fragLimit: number): number | null {
  const left = fragLimit - netFrags;
  return fragLimit > 0 && left > 0 && left <= KILL_LIMIT_WARNING ? left : null;
}

/** A limit as it is stored: a whole, non-negative number; anything else is none. */
function asLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}
