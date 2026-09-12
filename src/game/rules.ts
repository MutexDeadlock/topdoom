/**
 * The netgame rules the host sets — deathmatch, friendly fire, the frag and time limits — plus the
 * frag arithmetic a death, the scoreboard and the frag limit share. The three a tic reads are
 * session settings `replay/settings.ts` captures and pins; the mode is the host's stored pick
 * alone. docs/multiplayer-deathmatch.md.
 */
import { readStorage, writeStorage } from '../util/storage.ts';
import type { PlayerHit } from './combat.ts';

/** `G_DeathMatchSpawnPlayer`'s `for (j=0 ; j<20 ; j++)` (`g_game.c`): draws before giving up. */
export const DM_START_TRIES = 20;

/** `P_SpawnSpecials`' `-timer` (`p_spec.c`): `levelTimeCount = minutes * 60 * TICRATE`. */
export const TICS_PER_MINUTE = 60 * 35;

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

/** A limit as it is stored: a whole, non-negative number; anything else is none. */
function asLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}
