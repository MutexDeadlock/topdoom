/**
 * The WAD-derived tables every thing type is looked up in: sprite names, health, drops, animation
 * frames, barrel and splash constants — data only, confirmed against `info.c`, and keyed
 * throughout on `things/doomednums.ts`. The runtime layer reading these is `game/things.ts`; the
 * record shapes it passes around are `things/defs.ts`. See docs/sprites.md and docs/items.md.
 */
import { DOOM_TIC } from '../../constants.ts';
import { ThingType } from './doomednums.ts';
import { pristineFrameTables } from '../dehacked/frames.ts';
import type { AttackPose } from './defs.ts';
import {
  FF_FULLBRIGHT, frameLetter, MBF_STATES_START, SPRITE_NAMES, STATES, type StateRow,
} from '../dehacked/states.ts';
// Type-only: `combat.ts` imports the barrel constants below at runtime, and a
// value import back would close that loop.
import type { DamageCause } from '../combat.ts';

/**
 * DOOM thing type (doomednum) to the sprite it spawns with, covering
 * monsters, weapons, ammo, health/armor, keys, powerups and common
 * decorations from both DOOM and DOOM II. Player starts, deathmatch spots,
 * teleport landings and boss shooter cubes are intentionally absent — DOOM
 * itself renders none of those, they are spawn markers only.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const THING_SPRITES: Record<number, string> = {};

/**
 * Doomednums carrying vanilla's `MF_SHADOW`, which `r_things.c: R_ProjectSprite` draws with the
 * fuzz effect instead of its own art (`vis->colormap = NULL`). In `info.c`'s `mobjinfo` that is
 * `MT_SHADOWS` and nothing else, so this set holds exactly the spectre — the player's
 * invisibility powerup is the flag's only other user and doesn't come through here
 * (docs/items.md § Powerups and the backpack). The flag survives death: `P_KillMobj` clears
 * `MF_SHOOTABLE|MF_FLOAT|MF_SKULLFLY` and never `MF_SHADOW`, so a spectre's corpse stays fuzzed.
 * docs/sprites.md § The spectre's fuzz.
 */
export const FUZZ_TYPES: Set<number> = new Set([ThingType.spectre]);

/**
 * Doomednums of the "Monsters" block above — the things auto-aim (game/weapons.ts's
 * click-to-target, wired up in game.ts's `ThingLayer.pickMonster`) is willing to
 * snap a shot onto, minus `NO_AUTO_AIM_TYPES` below, and the set
 * `game/monsters/ai.ts`'s AI ticks. This table only
 * decides which doomednums count as a monster at all (for targeting, AI, and
 * every other `MONSTER_TYPES.has(...)` check across the game/ tree) — the AI
 * behavior itself (waking, chasing, attacking, infighting) lives in
 * `game/monsters/ai.ts`, not here.
 */
export const MONSTER_TYPES: Set<number> = new Set([
  ThingType.zombieman,
  ThingType.shotgunGuy,
  ThingType.imp,
  ThingType.demon,
  ThingType.spectre,
  ThingType.lostSoul,
  ThingType.cacodemon,
  ThingType.baronOfHell,
  ThingType.hellKnight,
  ThingType.spiderMastermind,
  ThingType.cyberdemon,
  ThingType.painElemental,
  ThingType.heavyWeaponDude,
  ThingType.revenant,
  ThingType.mancubus,
  ThingType.arachnotron,
  ThingType.archVile,
  ThingType.wolfensteinSS,
  ThingType.commanderKeen,
  ThingType.bossBrain,
]);

/**
 * `MONSTER_TYPES` members auto-aim refuses to lock onto — everything else about them is unchanged.
 * Only the Icon of Sin's brain (88), which sits in a recess whose one opening is *above* its whole
 * body, so a locked-on shot can never reach it and the lock only steals the player's aim. See
 * docs/combat.md § Auto-aim.
 */
export const NO_AUTO_AIM_TYPES: Set<number> = new Set([ThingType.bossBrain]);

/**
 * Doomednums from the decoration/gore blocks above that carry vanilla's `MF_SOLID` flag, confirmed
 * against `linuxdoom-1.10/info.c`'s `mobjinfo` — membership is that flag, nothing else. Deliberate
 * absences: the exploding barrel (2035, has its own `ThingType.barrel` handling), the five
 * non-solid `GOR*` hangers (59-63), the plain candle (34, `flags: 0`) and every
 * dead-monster/blood-pool prop. See docs/movement.md § Solid decorations.
 */
export const SOLID_DECORATION_TYPES: Set<number> = new Set([
  ThingType.floorLamp,
  ThingType.tallGreenPillar,
  ThingType.shortGreenPillar,
  ThingType.tallRedPillar,
  ThingType.shortRedPillar,
  ThingType.candelabra,
  ThingType.shortGreenPillarHeart,
  ThingType.shortRedPillarSkull,
  ThingType.evilEye,
  ThingType.floatingSkullRock,
  ThingType.tallBlueTorch,
  ThingType.tallGreenTorch,
  ThingType.tallRedTorch,
  ThingType.stalagmite,
  ThingType.techPillar,
  ThingType.shortBlueTorch,
  ThingType.shortGreenTorch,
  ThingType.shortRedTorch,
  ThingType.burningBarrel,
  ThingType.tallTechnoLamp,
  ThingType.shortTechnoLamp,
  ThingType.burntTree,
  ThingType.largeBrownTree,
  ThingType.impaledHuman,
  ThingType.twitchingImpaledHuman,
  ThingType.skullOnPole,
  ThingType.fiveSkullShishKebab,
  ThingType.pileOfSkullsAndCandles,
  ThingType.hangingVictimTwitching,
  ThingType.hangingVictimArmsOut,
  ThingType.hangingVictimOneLegged,
  ThingType.hangingPairOfLegs,
  ThingType.hangingLeg,
  ThingType.hangingVictimGutsRemoved,
  ThingType.hangingVictimGutsAndBrainRemoved,
  ThingType.hangingTorsoLookingDown,
  ThingType.hangingTorsoOpenSkull,
  ThingType.hangingTorsoLookingUp,
  ThingType.hangingTorsoBrainRemoved,
]);

/**
 * Vanilla `mobjinfo` radius shared by every entry in `SOLID_DECORATION_TYPES` except
 * `SOLID_DECORATION_RADIUS_OVERRIDE`'s keys — confirmed against `info.c`.
 */
export const SOLID_DECORATION_RADIUS = 16;

/**
 * The one `SOLID_DECORATION_TYPES` entry whose real vanilla radius isn't the shared 16 units: the
 * big tree (54, `MT_MISC76`) is 32 in `info.c`. Every other entry in the set genuinely does share
 * the 16-unit radius, so this stays a single-key override rather than promoting every entry to a
 * per-type table.
 */
export const SOLID_DECORATION_RADIUS_OVERRIDE: Record<number, number> = {
  [ThingType.largeBrownTree]: 32,
};

/**
 * Doomednums carrying vanilla's `MF_SPAWNCEILING` — every ceiling-hung gore prop, the five
 * vanilla "hanging victim" doomednums (both the solid and the non-solid, wider-radius reuse of
 * the same sprites) plus DOOM II's six `HDB*` body bags. Presence in this table means
 * `buildThingSprites`/`ThingLayer.update` measure `z` down from the sector's own `ceilHeight`
 * instead of up from `floorHeight` — the value is vanilla `mobjinfo.height`, confirmed against
 * `info.c`, i.e. exactly far enough that the sprite's bottom-anchored plane touches the ceiling.
 * A moving ceiling (crusher, closing door) carries these along every frame the same way a solid
 * decoration already rides a moving floor — see docs/movement.md § Solid decorations.
 */
export const CEILING_HUNG_HEIGHT: Record<number, number> = {
  [ThingType.hangingVictimTwitching]: 68,
  [ThingType.hangingVictimArmsOut]: 84,
  [ThingType.hangingVictimOneLegged]: 84,
  [ThingType.hangingPairOfLegs]: 68,
  [ThingType.hangingLeg]: 52,
  [ThingType.hangingVictimArmsOutNoBlock]: 84,
  [ThingType.hangingPairOfLegsNoBlock]: 68,
  // 52, not the blocking twin's 84: the non-solid one-legged victim is the one pair whose two
  // `mobjinfo` heights genuinely differ, so it hangs lower than the art suggests.
  [ThingType.hangingVictimOneLeggedNoBlock]: 52,
  [ThingType.hangingLegNoBlock]: 52,
  [ThingType.hangingVictimTwitchingNoBlock]: 68,
  [ThingType.hangingVictimGutsRemoved]: 88,
  [ThingType.hangingVictimGutsAndBrainRemoved]: 88,
  [ThingType.hangingTorsoLookingDown]: 64,
  [ThingType.hangingTorsoOpenSkull]: 64,
  [ThingType.hangingTorsoLookingUp]: 64,
  [ThingType.hangingTorsoBrainRemoved]: 64,
  [ThingType.commanderKeen]: 72, // MF_SPAWNCEILING like the gore above, just shootable
};

/**
 * Spawn-frame letters for the `MONSTER_TYPES` members whose `mobjinfo.spawnstate` **isn't** a walk
 * cycle, overriding `buildThingSprites`'s shared `MONSTER_WALK_FRAMES` default. Only `S_KEENSTND`
 * and `S_BRAIN` qualify, both single held frames whose walk-cycle letters would be death art.
 * Load-bearing even though neither animator advances today — docs/monster-ai.md § Commander Keen.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_IDLE_FRAMES: Record<number, string[]> = {};

/**
 * The loop a dormant monster stands in: its `spawnstate` chain, the states `A_Look` runs on —
 * `S_SPID_STND`/`S_SPID_STND2` are `SPID` `A` and `B` for 10 tics each (`info.c`). Played while
 * the monster is not alerted (`SpriteAnimator.standing`). The cacodemon and pain elemental loop a
 * lone `A` and have no entry, nor do the two `MONSTER_IDLE_FRAMES` types.
 * docs/sprites.md § Pain, and attack/pain poses.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_STAND_FRAMES: Record<number, { frames: string[]; frameSeconds: number }> = {};

/**
 * DOOM's usual walk cycle: 4 frames (A-D), the same one `PLAY` uses, held by
 * every type absent from `MONSTER_WALK_FRAMES_OVERRIDE` below.
 */
export const MONSTER_WALK_FRAMES = ['A', 'B', 'C', 'D'];

/**
 * The walk cycles that **aren't** A-D, read off each type's `seestate` chain in `info.c` (walk the
 * chain to where it loops and keep the distinct frames; vanilla holds most for two states each,
 * which the flat per-frame duration here makes a no-op). The cacodemon is the one that gets
 * *noticed* — docs/sprites.md § Pain, and attack/pain poses.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_WALK_FRAMES_OVERRIDE: Record<number, string[]> = {};

/**
 * `A_SpawnFly`'s monster lottery — the type an Icon of Sin spawn cube turns into on arrival, as
 * ordered upper bounds on one `P_Random()` roll (0-255): the first entry the roll falls under wins,
 * and the last is the `else`. Transcribed from `p_enemy.c`'s own if/else chain, with each `MT_*`
 * resolved to its `info.c` doomednum. The weights are deliberately lopsided and stay that way — an
 * arch-vile is 2/256 where an imp is 50/256. docs/monster-iconofsin.md § The spawn cube.
 */
export const SPAWN_CUBE_MONSTERS: readonly { below: number; type: number }[] = [
  { below: 50, type: ThingType.imp }, // MT_TROOP imp
  { below: 90, type: ThingType.demon }, // MT_SERGEANT demon
  { below: 120, type: ThingType.spectre }, // MT_SHADOWS spectre
  { below: 130, type: ThingType.painElemental }, // MT_PAIN pain elemental
  { below: 160, type: ThingType.cacodemon }, // MT_HEAD cacodemon
  { below: 162, type: ThingType.archVile },
  { below: 172, type: ThingType.revenant }, // MT_UNDEAD revenant
  { below: 192, type: ThingType.arachnotron }, // MT_BABY arachnotron
  { below: 222, type: ThingType.mancubus }, // MT_FATSO mancubus
  { below: 246, type: ThingType.hellKnight }, // MT_KNIGHT hell knight
  { below: 256, type: ThingType.baronOfHell }, // MT_BRUISER baron of hell
];

/**
 * `MONSTER_TYPES` entries that carry vanilla's `MF_COUNTKILL` flag — every monster except the
 * lost soul (3006) and the Icon of Sin's brain (88), neither of which does in `info.c`'s
 * `mobjinfo` table. `MONSTER_TYPES` exists for targeting/AI and isn't the same list vanilla uses
 * for the level's kill total.
 */
export const COUNTKILL_TYPES: Set<number> = new Set([
  ThingType.zombieman,
  ThingType.shotgunGuy,
  ThingType.imp,
  ThingType.demon,
  ThingType.spectre,
  ThingType.cacodemon,
  ThingType.baronOfHell,
  ThingType.hellKnight,
  ThingType.spiderMastermind,
  ThingType.cyberdemon,
  ThingType.painElemental,
  ThingType.heavyWeaponDude,
  ThingType.revenant,
  ThingType.mancubus,
  ThingType.arachnotron,
  ThingType.archVile,
  ThingType.wolfensteinSS,
  ThingType.commanderKeen,
]);

/**
 * Doomednums with vanilla's `MF_COUNTITEM` flag, confirmed against `info.c`'s `mobjinfo` table —
 * health/armor bonus, soulsphere, invulnerability, berserk, invisibility, computer map, light
 * visor, megasphere. Deliberately excludes keys, the backpack, weapons, ammo, and the radiation
 * suit (2025): none of those carry the flag in vanilla, matching the well-known behavior that the
 * backpack doesn't count toward a level's item percentage.
 */
export const COUNTITEM_TYPES: Set<number> = new Set([
  ThingType.healthBonus,
  ThingType.armorBonus,
  ThingType.soulsphere,
  ThingType.invulnerability,
  ThingType.berserk,
  ThingType.invisibility,
  ThingType.computerMap,
  ThingType.lightAmpVisor,
  ThingType.megasphere,
]);

/**
 * The five monster types real vanilla's `A_BossDeath` (`p_enemy.c`) can fire for — confirmed
 * against `info.c`'s `mobjinfo` doomednums. See docs/death.md § Boss death.
 */
export const BOSS_DEATH_TYPES = {
  baron: ThingType.baronOfHell,
  cyberdemon: ThingType.cyberdemon,
  spiderMastermind: ThingType.spiderMastermind,
  mancubus: ThingType.mancubus,
  arachnotron: ThingType.arachnotron,
} as const;

/**
 * Health each monster spawns with — `mobjinfo.spawnhealth`, confirmed against
 * `linuxdoom-1.10/info.c`.
 */
export const MONSTER_HEALTH: Record<number, number> = {
  [ThingType.zombieman]: 20,
  [ThingType.shotgunGuy]: 30,
  [ThingType.imp]: 60,
  [ThingType.demon]: 150,
  [ThingType.spectre]: 150,
  [ThingType.lostSoul]: 100,
  [ThingType.cacodemon]: 400,
  [ThingType.baronOfHell]: 1000,
  [ThingType.hellKnight]: 500,
  [ThingType.spiderMastermind]: 3000,
  [ThingType.cyberdemon]: 4000,
  [ThingType.painElemental]: 400,
  [ThingType.heavyWeaponDude]: 70,
  [ThingType.revenant]: 300,
  [ThingType.mancubus]: 600,
  [ThingType.arachnotron]: 500,
  [ThingType.archVile]: 700,
  [ThingType.wolfensteinSS]: 50,
  [ThingType.commanderKeen]: 100,
  [ThingType.bossBrain]: 250,
};

/**
 * Regular-death sprite frame letters per doomednum — confirmed against the real DOOM.WAD/DOOM2.WAD
 * lump names, and cross-checked against `info.c`. Derived from where a sprite's directional frames
 * stop, except for the two AI-less types at the bottom, whose whole sprite is rotation-0 and whose
 * letters come straight off `info.c`. docs/death.md § Monster death.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_DEATH_FRAMES: Record<number, string[]> = {};

/**
 * A monster whose death art is a different sprite lump than its own — vanilla's `deathstate`/
 * `xdeathstate` chain naming another `sprnames[]` entry. Empty for the stock roster: every
 * `info.c` monster dies in its own sprite, and only the exploding barrel (`BARREL_CHAIN`) doesn't.
 * A DEHACKED patch fills it in — EPIC.WAD aims a hanging body's death at the imp's `TROO` gib
 * chain — and `enterDeathPose` hands the entry to `SpriteAnimator.die`'s sprite argument, the same
 * seam the barrel uses. docs/dehacked.md § Frames.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_DEATH_SPRITE_OVERRIDE: Record<number, { death?: string; xdeath?: string }> = {};

/**
 * Gib (XDeath) frame letters — the back of the same rotation-0 tail
 * `MONSTER_DEATH_FRAMES` takes its front from. **Only five stock types have
 * one at all** (the human grunts and the imp); everything else has no
 * `xdeathstate` in `mobjinfo` and always plays its plain death.
 * `ThingLayer.damage` picks between the two by `P_KillMobj`'s overkill rule —
 * docs/death.md § Monster death.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_XDEATH_FRAMES: Record<number, string[]> = {};

/**
 * Flat per-frame duration for a death animation, regular or gib. Vanilla's
 * states each hold their own tic count; collapsing that to one constant is an
 * accepted simplification, same as `GRAVITY` and the weapon fire rates.
 */
export const MONSTER_DEATH_FRAME_SECONDS = 6 * DOOM_TIC;

/**
 * The pool of blood a corpse becomes when a moving plane leaves it no headroom — `S_GIBS`, which
 * `PIT_ChangeSector` sets on any corpse it catches. `POL5`, one held frame (that state holds at
 * `tics = -1`), **walked out of vanilla's own state table** rather than transcribed, and mutable
 * for the same reason `BARREL_CHAIN` is: a DEHACKED patch re-derives it and `dehacked/apply.ts`
 * snapshots and restores it like any other table (docs/dehacked.md § Frames).
 *
 * `frames` is empty only where a patch left `S_GIBS` drawing nothing — `crushCorpse` then leaves
 * the corpse alone rather than posing it on art that isn't there.
 * See docs/specials-crushers.md § Crushed corpses.
 */
export const CORPSE_GIB: { sprite: string; frames: string[] } = {
  sprite: pristineFrameTables().gibs?.sprite ?? '',
  frames: pristineFrameTables().gibs?.frames ?? [],
};

/**
 * The two monster types whose corpse doesn't stay on screen once its death animation finishes:
 * `S_SKULL_DIE6` and `S_PAIN_DIE6` are the only final death states that expire into `S_NULL`. This
 * is also what makes a dead pain elemental unresurrectable despite its real `raisestate`, needing
 * no second special case here. docs/death.md § Monster death.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_CORPSE_VANISHES: Set<number> = new Set();

/**
 * Attack poses per doomednum, **split by attack kind** and taken from `info.c`'s `meleestate` and
 * `missilestate` chains — the states, their letters and their own tic counts, cross-checked against
 * the real sprite lumps. Per-state tics rather than a flat rate, and split by kind because a type's
 * two chains are genuinely different animations — only the revenant has both (`SKEL` `G`-`I`
 * punches, `J`-`K` throws). Both rules are load-bearing: docs/sprites.md § Pain, and attack/pain
 * poses.
 *
 * The span is what that type's `AttackStats.duration` covers: the whole chain, or — for the
 * chaingunner and the two spiders, whose `A_*Refire` loops — the loop alone.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_ATTACK_POSE: Record<number, { melee?: AttackPose; ranged?: AttackPose }> = {};

/**
 * Every frame letter a type can strike a pose on, both kinds together — for the cross-checks in
 * `tests/game/tables.test.ts`.
 */
export function attackPoseLetters(type: number): string[] {
  const pose = MONSTER_ATTACK_POSE[type];
  return [...new Set([...(pose?.melee?.frames ?? []), ...(pose?.ranged?.frames ?? [])])];
}

/**
 * Pain (flinch) sprite frame letters, derived the same way and with the same WAD cross-check as
 * `MONSTER_ATTACK_POSE` above. One frame per type except the cacodemon, whose `S_HEAD_PAIN3` is a
 * genuine second recoil frame. Played only when a hit rolls past the type's own `painChance` —
 * docs/sprites.md § Pain, and attack/pain poses.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_PAIN_FRAMES: Record<number, string[]> = {};

/**
 * Flat per-frame duration for `MONSTER_PAIN_FRAMES` — the same "one uniform
 * rate instead of vanilla's own per-state tic count" simplification
 * `MONSTER_DEATH_FRAME_SECONDS` already makes, just faster: vanilla's pain
 * states mostly hold 3-10 tics (vs. death's 5-8), and a flinch reads as
 * snappier than a death collapse regardless. Also the fallback rate for
 * `attackPoseFrameSeconds` below.
 */
export const MONSTER_ACTION_FRAME_SECONDS = 3 * DOOM_TIC;

/**
 * How long each frame of an attack pose is held: the pose's own `tics`, scaled to fill
 * `attackSeconds` — the length of the attack it poses for. The factor is 1 whenever the attack runs
 * its full length, and is not when a volley's later shot re-enters a pose spanning only what is
 * left. Keeping vanilla's *proportions* is what puts the firing frame under the shot —
 * docs/sprites.md § Pain, and attack/pain poses.
 *
 * The degenerate guard is not defensive tidiness: a zero rate would freeze the pose on its first
 * frame *forever*, since `FrameSequence.advance` clears a one-shot sequence only by advancing past
 * its end.
 */
export function attackPoseFrameSeconds(pose: AttackPose, attackSeconds: number): number[] {
  const total = pose.tics.reduce((sum, t) => sum + t, 0);
  if (total <= 0 || attackSeconds <= 0) return pose.frames.map(() => MONSTER_ACTION_FRAME_SECONDS);
  return pose.tics.map((t) => (attackSeconds * t) / total);
}

/**
 * Resurrection frame letters — `mobjinfo.raisestate`, the arch-vile's `A_VileChase` target. Only 14
 * types have one; no entry means "not raisable", the same convention `MONSTER_XDEATH_FRAMES` uses.
 * **Not the reverse of `MONSTER_DEATH_FRAMES`** — every letter is read off `info.c`'s `S_*_RAISE*`
 * chains directly (docs/monster-archvile.md § Resurrection). Played via `playOnce` after `revive()`
 * undoes `die()`, reusing `MONSTER_DEATH_FRAME_SECONDS`, whose range vanilla's raise states sit
 * squarely inside.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const MONSTER_RAISE_FRAMES: Record<number, string[]> = {};

/**
 * The player's own frame letters, the `PLAY`-lump counterparts of the `MONSTER_*_FRAMES` tables
 * above — scalars rather than doomednum-keyed records, there being exactly one player, and here
 * rather than in `game/player.ts`, which owns no sprite. Death is confirmed against `PLAY`'s lump
 * names (its rotation-0 tail runs H-W, DIE1-7 then the XDIE gib variant this engine doesn't model);
 * attack and pain come from `info.c` and play via `SpriteAnimator.playOnce`, handing back to the
 * walk cycle when they finish. docs/death.md § Player death.
 */
export const PLAYER_DEATH_FRAMES = ['H', 'I', 'J', 'K', 'L', 'M', 'N'];
export const PLAYER_DEATH_FRAME_SECONDS = 6 * DOOM_TIC;
export const PLAYER_ATTACK_FRAMES = ['E', 'F'];
export const PLAYER_PAIN_FRAMES = ['G'];
export const PLAYER_ACTION_FRAME_SECONDS = 3 * DOOM_TIC;

/**
 * Item a monster leaves behind on death (doomednum of the pickup to spawn),
 * lifted straight from vanilla's `P_KillMobj` — only three `switch` cases
 * exist there at all, so only three monster types actually drop anything:
 * the zombieman and Wolfenstein SS both drop a clip, the shotgun guy a
 * shotgun, the chaingunner a chaingun. Every other monster, including ones
 * that feel like they obviously should (the imp, the demon), drops nothing
 * in vanilla and doesn't here either. A drop always spawns regardless of
 * *how* the kill happened — direct hit, splash, gib or not — matching
 * vanilla, which drops from the same `P_KillMobj` no matter the cause.
 */
export const MONSTER_DROPS: Record<number, number> = {
  [ThingType.zombieman]: ThingType.clip,
  [ThingType.wolfensteinSS]: ThingType.clip,
  [ThingType.shotgunGuy]: ThingType.shotgun,
  [ThingType.heavyWeaponDude]: ThingType.chaingun,
};

/**
 * Per-doomednum sprite frame(s) for non-monster, non-barrel things, overriding
 * `buildThingSprites`'s single-held-`'A'`-frame default, confirmed letter-by-letter against
 * `linuxdoom-1.10/info.c`'s `states[]` (not the wiki). Two reasons a doomednum is here: an idle
 * animation of more than one frame, or a corpse/gib prop whose fixed art isn't frame `'A'` —
 * docs/sprites.md § Which things spawn. An absent doomednum already matches the default.
 * `frameSeconds` is one flat rate standing in for vanilla's per-state tics, the same accepted
 * simplification `MONSTER_DEATH_FRAME_SECONDS` makes.
 *
 * Filled at the bottom of this file by walking vanilla's own state chains —
 * docs/dehacked.md § Frames.
 */
export const THING_ANIM_FRAMES: Record<number, { frames: string[]; frameSeconds: number }> = {};

/**
 * Fills every table above from the walker's reading of vanilla's own `states[]`
 * (docs/dehacked.md § Frames). These are not transcribed any more: one `mobjinfo` row's eight
 * state pointers decide its sprite, its walk/idle/stand/death/pain/raise letters and both attack
 * poses, so walking the chains is what *defines* them here and `tests/fixtures/frametables.ts` is
 * the independent reading that pins the result.
 *
 * Runs at import, before `dehacked/apply.ts` snapshots these tables for `resetDehacked`. A patch
 * re-derives the same way and writes only what differs.
 */
for (const [key, m] of Object.entries(pristineFrameTables().monsters)) {
  const dn = Number(key);
  if (m.sprite !== undefined) THING_SPRITES[dn] = m.sprite;
  // A walk cycle that is not the shared `A,B,C,D` earns an override row; a type that holds an idle
  // frame instead has no cycle at all.
  if (m.walk.length && !sameLetters(m.walk, MONSTER_WALK_FRAMES)) {
    MONSTER_WALK_FRAMES_OVERRIDE[dn] = m.walk;
  }
  if (m.idle) MONSTER_IDLE_FRAMES[dn] = m.idle;
  if (m.stand) MONSTER_STAND_FRAMES[dn] = m.stand;
  if (m.death) MONSTER_DEATH_FRAMES[dn] = m.death;
  if (m.xdeath) MONSTER_XDEATH_FRAMES[dn] = m.xdeath;
  if (m.deathSprite) MONSTER_DEATH_SPRITE_OVERRIDE[dn] = m.deathSprite;
  if (m.vanishes) MONSTER_CORPSE_VANISHES.add(dn);
  if (m.pain) MONSTER_PAIN_FRAMES[dn] = m.pain;
  if (m.raise) MONSTER_RAISE_FRAMES[dn] = m.raise;
  if (m.meleePose || m.rangedPose) {
    const pose: { melee?: AttackPose; ranged?: AttackPose } = {};
    if (m.meleePose) pose.melee = m.meleePose;
    if (m.rangedPose) pose.ranged = m.rangedPose;
    MONSTER_ATTACK_POSE[dn] = pose;
  }
}
for (const [key, sprite] of Object.entries(pristineFrameTables().sprites)) {
  THING_SPRITES[Number(key)] = sprite;
}
for (const [key, anim] of Object.entries(pristineFrameTables().anims)) {
  if (anim) THING_ANIM_FRAMES[Number(key)] = anim;
}

/**
 * The one pose the walker reads differently from the hand-curated reading, kept at the shipped
 * value on purpose. `A_CPosRefire` makes the SS's chain a loop, and the walker's rule measures the
 * loop alone (§ Frames) — which correctly drops the chaingunner's and the two spiders' lead-in
 * `A_FaceTarget` state, but here also drops the `E` the SS visibly winds up on. Vanilla holds that
 * frame, so this engine does too; `tests/fixtures/frametables.ts` carries the same reading and
 * `tests/game/dehacked-frames.test.ts` lists it as a known divergence.
 *
 * A DEHACKED patch that edits the SS's frames overrides this like any other entry — the diff in
 * `dehacked/apply.ts` writes off the walker, which is what a patch is asking for.
 */
MONSTER_ATTACK_POSE[ThingType.wolfensteinSS] = {
  ranged: { frames: ['E', 'F', 'G', 'F', 'G', 'F'], tics: [10, 10, 4, 6, 4, 1] },
};

/** Frame-letter list equality — the walker's lists are short and flat. */
function sameLetters(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((letter, i) => letter === b[i]);
}

/**
 * Every `(sprite, letter)` vanilla draws at full light, as `SPRITE + LETTER` keys (`TREDA`,
 * `SKULB`): `FF_FULLBRIGHT` in `info.c`'s `states[]`. Read at draw time by `things.ts`,
 * `spritefx.ts` and the player's `SpriteActor` to lift the sprite to light 255 whatever its sector
 * says, and rebuilt from a DEHACKED patch's `states[]` by `rebuildFullbrightFrames`.
 *
 * Keyed per `(sprite, letter)` rather than per state, because the animator knows no state; where
 * vanilla splits a letter across bright and dim states the states vote and a tie is bright.
 * docs/sprites.md § Fullbright frames.
 */
export const FULLBRIGHT_FRAMES: Set<string> = new Set();

/**
 * Refills `FULLBRIGHT_FRAMES` from a frame table — vanilla's own `STATES`, or a patched copy of it.
 *
 * **Only vanilla's rows vote, plus the ones `written` names.** The states past `MBF_STATES_START`
 * are dummies nothing reaches until a `Frame` record writes one (docs/dehacked.md § Extended
 * states), and letting them vote unasked would change the unpatched game: MBF's grenade is a bright
 * `MISL A` against vanilla's one dim `S_ROCKET`, and a tie draws bright — the rocket in flight
 * would glow.
 */
export function rebuildFullbrightFrames(
  states: readonly StateRow[] = STATES,
  written?: ReadonlySet<number>,
): void {
  const votes = new Map<string, number>();
  for (let i = 0; i < states.length; i++) {
    if (i >= MBF_STATES_START && !written?.has(i)) continue;
    const [sprite, frame] = states[i];
    const key = SPRITE_NAMES[sprite] + frameLetter(frame);
    votes.set(key, (votes.get(key) ?? 0) + (frame & FF_FULLBRIGHT ? 1 : -1));
  }
  FULLBRIGHT_FRAMES.clear();
  for (const [key, vote] of votes) if (vote >= 0) FULLBRIGHT_FRAMES.add(key);
}

rebuildFullbrightFrames();

/**
 * The exploding barrel's own `A_Explode` — vanilla's literal
 * `P_RadiusAttack(thingy, thingy->target, 128)`, identical radius and damage to
 * the rocket launcher's own splash (`weapons.ts`'s `rocketLauncher.splash`).
 * Table data, so it lives here rather than with the barrel's runtime state in
 * `things.ts`: that keeps `combat.ts`'s import of `things.ts` type-only, which
 * is what lets `monsters/vile.ts` reach `applyRadiusDamage` without a cycle.
 */
export const BARREL_SPLASH_RADIUS = 128;
export const BARREL_SPLASH_DAMAGE = 128;

/**
 * The death overlay's middle line, in full, keyed by the `DamageCause` it answers — plus
 * `'default'`, the fallback for an unattributed death. Only what can land a killing blow is listed:
 * every monster, plus the exploding barrel. Whole sentences rather than a name to interpolate —
 * docs/death.md § Who killed the player, docs/dehacked.md § Obituaries. Vanilla has no obituaries,
 * so nothing here is a fidelity claim.
 */
export const OBITUARIES: Record<number | string, string> = {
  self: 'You blew yourself up',
  crush: 'You were crushed',
  slime: 'You forgot to wear a protection suit',
  default: '',

  [ThingType.zombieman]: 'You were killed by a Zombieman',
  [ThingType.shotgunGuy]: 'You were killed by a Shotgun Guy',
  [ThingType.imp]: 'You were killed by an Imp',
  [ThingType.demon]: 'You were killed by a Demon',
  [ThingType.spectre]: 'You were killed by a Spectre',
  [ThingType.lostSoul]: 'You were killed by a Lost Soul',
  [ThingType.cacodemon]: 'You were killed by a Cacodemon',
  [ThingType.baronOfHell]: 'You were killed by a Baron of Hell',
  [ThingType.hellKnight]: 'You were killed by a Hell Knight',
  [ThingType.spiderMastermind]: 'You were killed by a Spider Mastermind',
  [ThingType.cyberdemon]: 'You were killed by a Cyberdemon',
  [ThingType.painElemental]: 'You were killed by a Pain Elemental',
  [ThingType.heavyWeaponDude]: 'You were killed by a Heavy Weapon Dude',
  [ThingType.revenant]: 'You were killed by a Revenant',
  [ThingType.mancubus]: 'You were killed by a Mancubus',
  [ThingType.arachnotron]: 'You were killed by an Arachnotron',
  [ThingType.archVile]: 'You were killed by an Arch-Vile',
  [ThingType.wolfensteinSS]: 'You were killed by a Wolfenstein SS',
  [ThingType.commanderKeen]: 'You were killed by Commander Keen',
  [ThingType.bossBrain]: 'You were killed by the Icon of Sin',
  [ThingType.barrel]: 'You were killed by an exploding barrel',
};

/**
 * The death overlay's middle line, or `''` when there is nothing to say — which the overlay then
 * draws exactly as it did before there was a line at all. `OBITUARIES` holds the text, so a patch
 * that replaced a line is read here without this having to know.
 * See docs/death.md § Who killed the player.
 */
export function obituary(cause: DamageCause | undefined): string {
  return (cause === undefined ? undefined : OBITUARIES[cause]) ?? OBITUARIES.default;
}
