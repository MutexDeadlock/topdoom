/**
 * The five skill levels and every rule that reads off one: which things spawn, the damage and
 * ammo multipliers, ambush flags, and nightmare's fast/respawning monsters. A leaf of pure
 * predicates — the systems applying them are `things.ts`, `world.ts` and `inventory.ts`.
 * See docs/menu.md § Difficulty.
 */

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

/** Skill 1 (`sk_baby`) — the two rules below are the only places it differs from skill 2. */
const SKILL_BABY: Skill = 1;
/**
 * `sk_nightmare`. Everything it changes beyond skill 4 is keyed off this: double ammo, fast
 * monsters and respawning monsters.
 */
const SKILL_NIGHTMARE: Skill = 5;

/**
 * Damage actually dealt to the player, halved on skill 1: `P_DamageMobj`'s
 * `if (player && gameskill == sk_baby) damage >>= 1;` (`p_inter.c`). Vanilla halves before
 * anything else looks at the number, so the reduced damage is also what knockback, the pain flash
 * and `playerDeath`'s gib and cry see. Only the *player* gets this — a monster on skill 1 takes
 * what it always took. See docs/items.md § Skill.
 */
export function playerDamageAtSkill(damage: number, skill: Skill): number {
  return skill === SKILL_BABY ? damage >> 1 : damage;
}

/**
 * One pickup's worth of ammo, doubled on skills 1 and 5: `P_GiveAmmo`'s
 * `if (gameskill == sk_baby || gameskill == sk_nightmare) num <<= 1;` (`p_inter.c`) — a trainer
 * bonus at one end and a concession to respawning monsters at the other. Vanilla doubles after
 * halving a dropped pickup, so `applyPickup` applies it in that order too, and the ammo cap still
 * applies afterwards. Reaches every path that grants ammo: plain ammo, a weapon's own ammo, and
 * the backpack. See docs/items.md § Skill.
 */
export function ammoAtSkill(amount: number, skill: Skill): number {
  return skill === SKILL_BABY || skill === SKILL_NIGHTMARE ? amount * 2 : amount;
}

/**
 * Whether this skill runs vanilla's fast monsters — `G_InitNew`'s
 * `if (fastparm || (skill == sk_nightmare && …))` (`g_game.c`). There is no `-fast` switch here,
 * so nightmare is the only way to get them. What "fast" actually changes is a much smaller list
 * than the name suggests: see `FAST_MONSTER_STATS` in game/monsters/tables.ts.
 */
export function fastMonsters(skill: Skill): boolean {
  return skill === SKILL_NIGHTMARE;
}

/**
 * Whether killed monsters come back — `G_InitNew`'s
 * `if (skill == sk_nightmare || respawnparm) respawnmonsters = true;` (`g_game.c`). As with
 * {@link fastMonsters} there is no command-line switch here, so nightmare is the only source.
 * What that actually does to a corpse is docs/monster-ai.md § Respawning monsters.
 */
export function respawnMonsters(skill: Skill): boolean {
  return skill === SKILL_NIGHTMARE;
}

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
 * carry this flag so they don't clutter a single-player game; a netgame spawns
 * them (docs/multiplayer-coop.md § Netgame).
 */
export function isMultiplayerOnly(flags: number): boolean {
  return (flags & MULTIPLAYER_ONLY) !== 0;
}

/**
 * Boom's two netgame-mode flags (`doomdef.h`: `MTF_NOTDM` bit 5, `MTF_NOTCOOP` bit 6), and the
 * reserved bit that voids them: `P_SpawnMapThing` (`prboom p_mobj.c`, killough 11/98) ignores every
 * bit vanilla never read when bit 8 is set — a vanilla-era editor that put ones in the unused bits.
 */
const NOT_DEATHMATCH = 0x0020;
const NOT_COOP = 0x0040;
const RESERVED = 0x0100;

/**
 * True if this THING stays out of a deathmatch — `P_SpawnMapThing`'s
 * `if (netgame && deathmatch && options & MTF_NOTDM) return;` (`prboom p_mobj.c`, jff 3/30/98).
 * docs/multiplayer-deathmatch.md § Rules.
 */
export function isNotDeathmatch(flags: number): boolean {
  return (flags & RESERVED) === 0 && (flags & NOT_DEATHMATCH) !== 0;
}

/**
 * True if this THING stays out of a coop game — the sibling
 * `if ((coop_spawns || netgame) && !deathmatch && options & MTF_NOTCOOP) return;`.
 * docs/multiplayer-coop.md § Netgame.
 */
export function isNotCoop(flags: number): boolean {
  return (flags & RESERVED) === 0 && (flags & NOT_COOP) !== 0;
}

/**
 * A map THING's facing as vanilla actually spawns it, in degrees: snapped to a
 * multiple of 45°. Both `P_SpawnMapThing` and `P_SpawnPlayer` (`p_mobj.c`) do
 * `mobj->angle = ANG45 * (mthing->angle/45)`, and C's integer division
 * truncates toward zero — hence `Math.trunc`, not `Math.floor`, since the WAD
 * field is a signed short. An editor-placed 250° therefore faces 225° in game.
 *
 * Every consumer of a spawn angle goes through this: a monster's wake-up cone
 * reads it unchanged until it wakes (docs/monster-ai.md § Waking up), and it
 * also picks the sprite rotation a still thing shows. DOOM/DOOM2 place all but
 * one thing on the 45° grid; `freedoom2.wad` does not.
 */
export function spawnAngleDeg(angle: number): number {
  return Math.trunc(angle / 45) * 45;
}

/**
 * THING flag bit marking a thing "ambush" in the editor — vanilla's `MF_AMBUSH`, commonly called
 * "deaf".
 */
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
