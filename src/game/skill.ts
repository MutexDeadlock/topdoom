/** DOOM skill levels, 1 (baby) through 5 (nightmare). */
export type Skill = 1 | 2 | 3 | 4 | 5;

/** Vanilla DOOM's own default when a new game is started. */
export const DEFAULT_SKILL: Skill = 3;

export const SKILL_NAMES: Record<Skill, string> = {
  1: "I'm Too Young to Die",
  2: 'Hey, Not Too Rough',
  3: 'Hurt Me Plenty',
  4: 'Ultra-Violence',
  5: 'Nightmare!',
};

/** THING flag bits gating which skills a thing spawns on. */
const SKILL_FLAG = {
  EASY: 0x0001, // skills 1-2
  MEDIUM: 0x0002, // skill 3
  HARD: 0x0004, // skills 4-5
} as const;

/** True if a THING carrying these flags spawns at the given skill. */
export function spawnsAtSkill(flags: number, skill: Skill): boolean {
  if (skill <= 2) return (flags & SKILL_FLAG.EASY) !== 0;
  if (skill === 3) return (flags & SKILL_FLAG.MEDIUM) !== 0;
  return (flags & SKILL_FLAG.HARD) !== 0;
}

/** THING flag bit marking a thing as multiplayer-only (vanilla's `MTF_NOTSINGLE`). */
const MULTIPLAYER_ONLY = 0x0010;

/**
 * True if this THING should be skipped because vanilla only spawns it in a
 * netgame: `P_LoadThings` reads `if (!netgame && (options & MTF_NOTSINGLE))
 * continue;` — unconditional on skill, only on whether other players are
 * present. Deathmatch weapon stashes and similar multiplayer-only placements
 * carry this flag so they don't clutter a single-player game. This engine
 * has no multiplayer mode at all, so netgame is always false and the flag
 * always applies.
 */
export function isMultiplayerOnly(flags: number): boolean {
  return (flags & MULTIPLAYER_ONLY) !== 0;
}

/** THING flag bit marking a thing "ambush" in the editor — vanilla's `MF_AMBUSH`, commonly called "deaf". */
const AMBUSH = 0x0008;

/**
 * True if this THING is deaf to gunfire: vanilla's `A_Look` only lets an
 * ambush-flagged monster react to its sector's sound target (`World.noiseAlert`)
 * if it can actually see the source, rather than waking on sound alone the
 * way every other monster does. It can still wake normally by directly
 * spotting the player in its own field of view — the flag only removes the
 * "hears you through the wall" shortcut, matching vanilla exactly.
 */
export function isAmbush(flags: number): boolean {
  return (flags & AMBUSH) !== 0;
}
