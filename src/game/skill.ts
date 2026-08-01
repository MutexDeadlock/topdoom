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
