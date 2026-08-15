/**
 * The WAD-derived tables every thing type is looked up in: sprite names, health, drops, animation
 * frames, barrel and splash constants — data only, confirmed against `info.c`, and keyed
 * throughout on `things/doomednums.ts`. The runtime layer reading these is `game/things.ts`; the
 * record shapes it passes around are `things/defs.ts`. See docs/sprites.md and docs/items.md.
 */
import { DOOM_TIC } from '../../constants.ts';
import { ThingType } from './doomednums.ts';
// Type-only: `combat.ts` imports the barrel constants below at runtime, and a
// value import back would close that loop.
import type { DamageCause } from '../combat.ts';

/**
 * DOOM thing type (doomednum) to the sprite it spawns with, covering
 * monsters, weapons, ammo, health/armor, keys, powerups and common
 * decorations from both DOOM and DOOM II. Player starts, deathmatch spots,
 * teleport landings and boss shooter cubes are intentionally absent — DOOM
 * itself renders none of those, they are spawn markers only.
 */
export const THING_SPRITES: Record<number, string> = {
  // Monsters
  [ThingType.zombieman]: 'POSS',
  [ThingType.shotgunGuy]: 'SPOS',
  [ThingType.imp]: 'TROO',
  [ThingType.demon]: 'SARG',
  [ThingType.spectre]: 'SARG',
  [ThingType.lostSoul]: 'SKUL',
  [ThingType.cacodemon]: 'HEAD',
  [ThingType.baronOfHell]: 'BOSS',
  [ThingType.hellKnight]: 'BOS2',
  [ThingType.spiderMastermind]: 'SPID',
  [ThingType.cyberdemon]: 'CYBR',
  [ThingType.painElemental]: 'PAIN',
  [ThingType.heavyWeaponDude]: 'CPOS',
  [ThingType.revenant]: 'SKEL',
  [ThingType.mancubus]: 'FATT',
  [ThingType.arachnotron]: 'BSPI',
  [ThingType.archVile]: 'VILE',
  [ThingType.wolfensteinSS]: 'SSWV',
  [ThingType.commanderKeen]: 'KEEN',
  [ThingType.bossBrain]: 'BBRN',

  // Weapons
  [ThingType.shotgun]: 'SHOT',
  [ThingType.superShotgun]: 'SGN2',
  [ThingType.chaingun]: 'MGUN',
  [ThingType.rocketLauncher]: 'LAUN',
  [ThingType.plasmaRifle]: 'PLAS',
  [ThingType.chainsaw]: 'CSAW',
  [ThingType.bfg9000]: 'BFUG',

  // Ammo
  [ThingType.clip]: 'CLIP',
  [ThingType.boxOfBullets]: 'AMMO',
  [ThingType.rocket]: 'ROCK',
  [ThingType.boxOfRockets]: 'BROK',
  [ThingType.cellCharge]: 'CELL',
  [ThingType.cellChargePack]: 'CELP',
  [ThingType.shells]: 'SHEL',
  [ThingType.boxOfShells]: 'SBOX',
  [ThingType.backpack]: 'BPAK',

  // Health & armor
  [ThingType.stimpack]: 'STIM',
  [ThingType.medikit]: 'MEDI',
  [ThingType.soulsphere]: 'SOUL',
  [ThingType.healthBonus]: 'BON1',
  [ThingType.armorBonus]: 'BON2',
  [ThingType.greenArmor]: 'ARM1',
  [ThingType.blueArmor]: 'ARM2',
  [ThingType.megasphere]: 'MEGA',

  // Keys
  [ThingType.blueKeycard]: 'BKEY',
  [ThingType.blueSkullKey]: 'BSKU',
  [ThingType.redKeycard]: 'RKEY',
  [ThingType.redSkullKey]: 'RSKU',
  [ThingType.yellowKeycard]: 'YKEY',
  [ThingType.yellowSkullKey]: 'YSKU',

  // Powerups
  [ThingType.invulnerability]: 'PINV',
  [ThingType.berserk]: 'PSTR',
  [ThingType.invisibility]: 'PINS',
  [ThingType.radiationSuit]: 'SUIT',
  [ThingType.computerMap]: 'PMAP',
  [ThingType.lightAmpVisor]: 'PVIS',

  // Obstacles & decorations
  [ThingType.barrel]: 'BAR1',
  [ThingType.floorLamp]: 'COLU',
  [ThingType.candle]: 'CAND',
  [ThingType.candelabra]: 'CBRA',
  [ThingType.tallGreenPillar]: 'COL1',
  [ThingType.shortGreenPillar]: 'COL2',
  [ThingType.tallRedPillar]: 'COL3',
  [ThingType.shortRedPillar]: 'COL4',
  [ThingType.shortGreenPillarHeart]: 'COL5',
  [ThingType.shortRedPillarSkull]: 'COL6',
  [ThingType.evilEye]: 'CEYE',
  [ThingType.floatingSkullRock]: 'FSKU',
  [ThingType.tallBlueTorch]: 'TBLU',
  [ThingType.tallGreenTorch]: 'TGRN',
  [ThingType.tallRedTorch]: 'TRED',
  [ThingType.shortBlueTorch]: 'SMBT',
  [ThingType.shortGreenTorch]: 'SMGT',
  [ThingType.shortRedTorch]: 'SMRT',
  [ThingType.stalagmite]: 'SMIT',
  [ThingType.techPillar]: 'ELEC',
  [ThingType.burningBarrel]: 'FCAN',
  [ThingType.tallTechnoLamp]: 'TLMP',
  [ThingType.shortTechnoLamp]: 'TLP2',
  [ThingType.burntTree]: 'TRE1',
  [ThingType.largeBrownTree]: 'TRE2',
  [ThingType.impaledHuman]: 'POL1',
  [ThingType.twitchingImpaledHuman]: 'POL6',
  [ThingType.skullOnPole]: 'POL4',
  [ThingType.fiveSkullShishKebab]: 'POL2',
  [ThingType.pileOfSkullsAndCandles]: 'POL3',

  // Gore & corpses — floor-standing, non-solid unless noted
  [ThingType.bloodyMess]: 'PLAY',
  [ThingType.bloodyMessAlt]: 'PLAY',
  [ThingType.deadPlayer]: 'PLAY',
  [ThingType.deadZombieman]: 'POSS',
  [ThingType.deadShotgunGuy]: 'SPOS',
  [ThingType.deadImp]: 'TROO',
  [ThingType.deadDemon]: 'SARG',
  [ThingType.deadCacodemon]: 'HEAD',
  [ThingType.deadLostSoul]: 'SKUL', // Invisible in vanilla — no MF_SOLID/MF_NOBLOCKMAP either
  [ThingType.poolOfBloodAndFlesh]: 'POL5',
  [ThingType.colonGibs]: 'POB1',
  [ThingType.smallPoolOfBlood]: 'POB2',
  [ThingType.brainStem]: 'BRS1',

  // Gore — hangs from the ceiling (MF_SPAWNCEILING); solid variants block, "Hanging …" ones don't
  [ThingType.hangingVictimTwitching]: 'GOR1',
  [ThingType.hangingVictimArmsOut]: 'GOR2',
  [ThingType.hangingVictimOneLegged]: 'GOR3',
  [ThingType.hangingPairOfLegs]: 'GOR4',
  [ThingType.hangingLeg]: 'GOR5',
  [ThingType.hangingVictimArmsOutNoBlock]: 'GOR2',
  [ThingType.hangingPairOfLegsNoBlock]: 'GOR4',
  [ThingType.hangingVictimOneLeggedNoBlock]: 'GOR3',
  [ThingType.hangingLegNoBlock]: 'GOR5',
  [ThingType.hangingVictimTwitchingNoBlock]: 'GOR1',
  [ThingType.hangingVictimGutsRemoved]: 'HDB1',
  [ThingType.hangingVictimGutsAndBrainRemoved]: 'HDB2',
  [ThingType.hangingTorsoLookingDown]: 'HDB3',
  [ThingType.hangingTorsoOpenSkull]: 'HDB4',
  [ThingType.hangingTorsoLookingUp]: 'HDB5',
  [ThingType.hangingTorsoBrainRemoved]: 'HDB6',
};

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

/** Vanilla `mobjinfo` radius shared by every entry in `SOLID_DECORATION_TYPES` except `SOLID_DECORATION_RADIUS_OVERRIDE`'s keys — confirmed against `info.c`. */
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
 * cycle, overriding `buildThingSprites`'s shared `MONSTER_WALK_FRAMES` default. Only the two types
 * with no AI qualify: `S_KEENSTND` and `S_BRAIN` are both single held frames (`tics: -1`), and for
 * both of them the letters `MONSTER_WALK_FRAMES` would otherwise cycle through are death art.
 *
 * Load-bearing even though neither type's animator currently advances: `animating` is only ever
 * turned on by the AI branch in `update()`, which these two never enter, so today they hold frame 0
 * by accident rather than by rule. docs/monster-ai.md § Commander Keen.
 */
export const MONSTER_IDLE_FRAMES: Record<number, string[]> = {
  [ThingType.commanderKeen]: ['A'], // KEEN, S_KEENSTND
  [ThingType.bossBrain]: ['A'], // BBRN, S_BRAIN
};

/**
 * DOOM's usual walk cycle: 4 frames (A-D), the same one `PLAY` uses, held by
 * every type absent from `MONSTER_WALK_FRAMES_OVERRIDE` below.
 */
export const MONSTER_WALK_FRAMES = ['A', 'B', 'C', 'D'];

/**
 * The walk cycles that **aren't** A-D, read off each type's `seestate` chain in
 * `info.c` (walk the chain to where it loops and keep the distinct frames;
 * vanilla holds most of them for two states each, which the flat per-frame
 * duration here makes a no-op).
 *
 * The cacodemon is the one that gets *noticed*: `S_HEAD_RUN1` is a single state
 * looping to itself on frame A, and `HEAD`'s B/C are its `missilestate` mouth —
 * the same letters `MONSTER_ATTACK_FRAMES` uses — so the shared 4-frame default
 * had it biting the air continuously as it drifted. docs/sprites.md § Pain,
 * and attack/pain poses.
 */
export const MONSTER_WALK_FRAMES_OVERRIDE: Record<number, string[]> = {
  [ThingType.cacodemon]: ['A'], // HEAD — S_HEAD_RUN1 alone
  [ThingType.lostSoul]: ['A', 'B'], // SKUL
  [ThingType.painElemental]: ['A', 'B', 'C'], // PAIN
  [ThingType.archVile]: ['A', 'B', 'C', 'D', 'E', 'F'], // VILE
  [ThingType.revenant]: ['A', 'B', 'C', 'D', 'E', 'F'], // SKEL
  [ThingType.mancubus]: ['A', 'B', 'C', 'D', 'E', 'F'], // FATT
  [ThingType.arachnotron]: ['A', 'B', 'C', 'D', 'E', 'F'], // BSPI — S_BSPI_SIGHT's own frame A leads into the same cycle
  [ThingType.spiderMastermind]: ['A', 'B', 'C', 'D', 'E', 'F'], // SPID
};

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

/** Vanilla `mobjinfo` spawn health, confirmed against the Doom Wiki's monster table. */
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
 * Regular-death sprite frame letters per doomednum — confirmed against the
 * real DOOM.WAD/DOOM2.WAD lump names, and cross-checked against `info.c`.
 * Death art is rotation-0 only, so where a sprite's directional frames stop
 * marks where death art starts; DIE is the front of that tail, XDIE the back.
 * That derivation doesn't reach the two AI-less types at the bottom, whose
 * whole sprite is rotation-0 — theirs come straight off `info.c`'s own chains.
 * docs/sprites.md § Pain, and attack/pain poses.
 */
export const MONSTER_DEATH_FRAMES: Record<number, string[]> = {
  [ThingType.zombieman]: ['H', 'I', 'J', 'K', 'L'], // POSS
  [ThingType.shotgunGuy]: ['H', 'I', 'J', 'K', 'L'], // SPOS
  [ThingType.imp]: ['I', 'J', 'K', 'L', 'M'], // TROO
  [ThingType.demon]: ['I', 'J', 'K', 'L', 'M', 'N'], // SARG
  [ThingType.spectre]: ['I', 'J', 'K', 'L', 'M', 'N'], // SARG (spectre)
  // Starts at F, not G: S_SKULL_DIE1 follows 2 walk + 2 attack + 1 pain (A-E).
  [ThingType.lostSoul]: ['F', 'G', 'H', 'I', 'J', 'K'], // SKUL
  [ThingType.cacodemon]: ['G', 'H', 'I', 'J', 'K', 'L'], // HEAD
  [ThingType.baronOfHell]: ['I', 'J', 'K', 'L', 'M', 'N', 'O'], // BOSS
  [ThingType.hellKnight]: ['I', 'J', 'K', 'L', 'M', 'N', 'O'], // BOS2
  [ThingType.spiderMastermind]: ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S'], // SPID
  [ThingType.cyberdemon]: ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'], // CYBR
  [ThingType.painElemental]: ['H', 'I', 'J', 'K', 'L', 'M'], // PAIN
  // Seven death states (H-N) before XDEATH starts at O, not five.
  [ThingType.heavyWeaponDude]: ['H', 'I', 'J', 'K', 'L', 'M', 'N'], // CPOS
  // Starts at L: S_SKEL_DIE1 reuses S_SKEL_PAIN's own letter — a real info.c
  // quirk, so the rotation-0 tail starts one letter earlier than it looks.
  [ThingType.revenant]: ['L', 'M', 'N', 'O', 'P', 'Q'], // SKEL
  [ThingType.mancubus]: ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'], // FATT
  [ThingType.arachnotron]: ['J', 'K', 'L', 'M', 'N', 'O', 'P'], // BSPI
  // Starts at Q: same shared pain/DIE1 letter quirk as SKEL above.
  [ThingType.archVile]: ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'], // VILE
  [ThingType.wolfensteinSS]: ['I', 'J', 'K', 'L', 'M'], // SSWV
  // S_COMMKEEN..S_COMMKEEN12 — twelve frames starting at A, the same letter
  // S_KEENSTND holds (see MONSTER_IDLE_FRAMES). The corpse keeps hanging: Keen
  // is MF_SPAWNCEILING, so `update()` goes on measuring its z off the ceiling.
  [ThingType.commanderKeen]: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'], // KEEN
  // S_BRAIN_DIE1-4 all hold BBRN frame 0 — the brain has no death art at all,
  // it just sits there for 120 tics while A_BrainScream detonates around it.
  // Listed anyway so `damage()` holds the sprite instead of hiding it, and so
  // `deathFrameCount` is 1 rather than 0. game/monsters/iconofsin.ts owns the rest.
  [ThingType.bossBrain]: ['A'], // BBRN
};

/**
 * Gib (XDeath) frame letters — the back of the same rotation-0 tail
 * `MONSTER_DEATH_FRAMES` takes its front from. **Only five stock types have
 * one at all** (the human grunts and the imp); everything else has no
 * `xdeathstate` in `mobjinfo` and always plays its plain death.
 * `ThingLayer.damage` picks between the two by `P_KillMobj`'s overkill rule —
 * docs/death.md § Monster death.
 */
export const MONSTER_XDEATH_FRAMES: Record<number, string[]> = {
  [ThingType.zombieman]: ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // POSS
  [ThingType.shotgunGuy]: ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // SPOS
  [ThingType.imp]: ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // TROO
  // Starts at O, right after the DEATH table's own N — the two must not overlap.
  [ThingType.heavyWeaponDude]: ['O', 'P', 'Q', 'R', 'S', 'T'], // CPOS
  [ThingType.wolfensteinSS]: ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'], // SSWV
};

/**
 * Flat per-frame duration for a death animation, regular or gib. Vanilla's
 * states each hold their own tic count; collapsing that to one constant is an
 * accepted simplification, same as `GRAVITY` and the weapon fire rates.
 */
export const MONSTER_DEATH_FRAME_SECONDS = 6 * DOOM_TIC;

/**
 * The two monster types whose corpse doesn't stay on screen once its death
 * animation finishes. Every monster's final death state holds at `tics: -1`
 * except `S_SKULL_DIE6` and `S_PAIN_DIE6`, which expire into `S_NULL` and so
 * get `P_RemoveMobj`'d outright.
 *
 * This also makes a dead pain elemental unresurrectable despite its real
 * `raisestate` — a genuine vanilla dead-data quirk, reproduced here without a
 * second special case because `rebuildBlockerGrid` never buckets a `hidden`
 * corpse. See docs/death.md § Monster death.
 */
export const MONSTER_CORPSE_VANISHES: Set<number> = new Set([ThingType.lostSoul, ThingType.painElemental]);

/**
 * Attack sprite frame letters per doomednum. Unlike the death tables these
 * aren't structurally derivable from the WAD, so they're lifted from `info.c`'s
 * `missilestate` chains and cross-checked letter-by-letter against the real
 * sprite lumps — the discipline that surfaced the four death-table bugs above.
 * docs/sprites.md § Pain, and attack/pain poses.
 *
 * Only letters distinct from the walk cycle and from each other are kept:
 * vanilla repeats frames mid-sequence purely to hold a pose, a no-op against
 * `playOnce`'s flat per-frame duration, and `SPID`/`BSPI`'s `A_FaceTarget`
 * frame reuses their idle letter. `SKEL`'s five letters cover *both* its
 * attack kinds as one sequence — the sprite layer has no "which attack" signal
 * to key off, only the AI knows, and by then the pose is just "attacking".
 */
export const MONSTER_ATTACK_FRAMES: Record<number, string[]> = {
  [ThingType.zombieman]: ['E', 'F'], // POSS
  [ThingType.shotgunGuy]: ['E', 'F'], // SPOS
  [ThingType.imp]: ['E', 'F', 'G'], // TROO
  [ThingType.demon]: ['E', 'F', 'G'], // SARG
  [ThingType.spectre]: ['E', 'F', 'G'], // SARG (spectre)
  [ThingType.lostSoul]: ['C', 'D'], // SKUL
  [ThingType.cacodemon]: ['B', 'C', 'D'], // HEAD
  [ThingType.baronOfHell]: ['E', 'F', 'G'], // BOSS
  [ThingType.hellKnight]: ['E', 'F', 'G'], // BOS2
  [ThingType.spiderMastermind]: ['G', 'H'], // SPID
  [ThingType.cyberdemon]: ['E', 'F'], // CYBR
  [ThingType.painElemental]: ['D', 'E', 'F'], // PAIN
  [ThingType.heavyWeaponDude]: ['E', 'F'], // CPOS
  [ThingType.revenant]: ['G', 'H', 'I', 'J', 'K'], // SKEL
  [ThingType.mancubus]: ['G', 'H', 'I'], // FATT
  [ThingType.arachnotron]: ['G', 'H'], // BSPI
  [ThingType.archVile]: ['G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'], // VILE
  [ThingType.wolfensteinSS]: ['E', 'F', 'G'], // SSWV
};

/**
 * Pain (flinch) sprite frame letters, derived the same way and with the same
 * WAD cross-check as `MONSTER_ATTACK_FRAMES` above. Every monster in stock
 * DOOM has exactly one pain frame except the cacodemon (`HEAD`), whose
 * `S_HEAD_PAIN3` genuinely is a second, distinct recoil frame — confirmed
 * against the WAD, not an accident of the derivation. `ThingLayer.damage`
 * only plays this when a hit actually rolls past the monster's own
 * `painChance` (`game/monsters/tables.ts`) — a hit that fails the roll flinches by
 * vanilla rule, not just by art.
 */
export const MONSTER_PAIN_FRAMES: Record<number, string[]> = {
  [ThingType.zombieman]: ['G'], // POSS
  [ThingType.shotgunGuy]: ['G'], // SPOS
  [ThingType.imp]: ['H'], // TROO
  [ThingType.demon]: ['H'], // SARG
  [ThingType.spectre]: ['H'], // SARG (spectre)
  [ThingType.lostSoul]: ['E'], // SKUL
  [ThingType.cacodemon]: ['E', 'F'], // HEAD
  [ThingType.baronOfHell]: ['H'], // BOSS
  [ThingType.hellKnight]: ['H'], // BOS2
  [ThingType.spiderMastermind]: ['I'], // SPID
  [ThingType.cyberdemon]: ['G'], // CYBR
  [ThingType.painElemental]: ['G'], // PAIN
  [ThingType.heavyWeaponDude]: ['G'], // CPOS
  [ThingType.revenant]: ['L'], // SKEL
  [ThingType.mancubus]: ['J'], // FATT
  [ThingType.arachnotron]: ['I'], // BSPI
  [ThingType.archVile]: ['Q'], // VILE
  [ThingType.wolfensteinSS]: ['H'], // SSWV
  // The two AI-less types. Both have a real painstate and effectively always
  // enter it (painchance 256 and 255 of 256), but neither has `MONSTER_STATS`
  // to roll against — `ThingLayer.damage`'s `INERT_SHOOTABLE` branch flinches
  // them unconditionally instead. docs/monster-ai.md § Commander Keen.
  [ThingType.commanderKeen]: ['M'], // KEEN, S_KEENPAIN
  [ThingType.bossBrain]: ['B'], // BBRN, S_BRAIN_PAIN
};

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
 * Per-frame duration for `MONSTER_ATTACK_FRAMES`, which — unlike the pain pose
 * — is **not** flat: the letters are spread evenly over `attackSeconds`, the
 * length of the attack they pose for.
 *
 * The pose and the wait are the same vanilla states: `AttackStats.duration` is
 * the `missilestate`/`meleestate` chain's summed tics, and those states are
 * exactly the frames this table lists. A flat rate makes the two disagree, and
 * the mismatch grows with the chain — the arch-vile's cast is 94 tics of `VILE`
 * `G`-`P`, so 3 tics a frame left it posed for 30 of them and standing in its
 * idle frame for the other 64, through the entire back half of the windup and
 * the blast itself. docs/sprites.md § Pain, and attack/pain poses.
 *
 * The degenerate guard is not defensive tidiness: a zero rate would freeze the
 * pose on its first frame *forever*, since `FrameSequence.advance` clears a
 * one-shot sequence only by advancing past its end.
 */
export function attackPoseFrameSeconds(frames: readonly string[], attackSeconds: number): number {
  if (frames.length === 0 || attackSeconds <= 0) return MONSTER_ACTION_FRAME_SECONDS;
  return attackSeconds / frames.length;
}

/**
 * Resurrection frame letters — `mobjinfo.raisestate`, the arch-vile's
 * `A_VileChase` target. Only 13 types have one at all; no entry means "not
 * raisable", the same convention `MONSTER_XDEATH_FRAMES` uses.
 *
 * **Not simply the reverse of `MONSTER_DEATH_FRAMES`** — that was tried and is
 * wrong, since vanilla's raise sequences are hand-authored per type with no
 * shared derivation rule. Every letter is read off `info.c`'s `S_*_RAISE*`
 * table directly. docs/monster-archvile.md.
 *
 * Played via `playOnce` after `revive()` undoes `die()`, reusing
 * `MONSTER_DEATH_FRAME_SECONDS` — vanilla's raise states hold 5-8 tics,
 * squarely inside death's own range, so a dedicated constant would tune nothing.
 */
export const MONSTER_RAISE_FRAMES: Record<number, string[]> = {
  [ThingType.zombieman]: ['K', 'J', 'I'], // POSS
  [ThingType.shotgunGuy]: ['L', 'K', 'J', 'I'], // SPOS
  [ThingType.imp]: ['M', 'L', 'K', 'J'], // TROO
  [ThingType.demon]: ['N', 'M', 'L', 'K', 'J'], // SARG
  [ThingType.spectre]: ['N', 'M', 'L', 'K', 'J'], // SARG (spectre)
  [ThingType.cacodemon]: ['L', 'K', 'J', 'I', 'H'], // HEAD
  [ThingType.baronOfHell]: ['O', 'N', 'M', 'L', 'K', 'J'], // BOSS
  [ThingType.hellKnight]: ['O', 'N', 'M', 'L', 'K', 'J'], // BOS2
  [ThingType.heavyWeaponDude]: ['N', 'M', 'L', 'K', 'J', 'I'], // CPOS
  [ThingType.revenant]: ['Q', 'P', 'O', 'N', 'M'], // SKEL
  [ThingType.mancubus]: ['R', 'Q', 'P', 'O', 'N', 'M', 'L'], // FATT
  [ThingType.arachnotron]: ['P', 'O', 'N', 'M', 'L', 'K'], // BSPI
  [ThingType.painElemental]: ['M', 'L', 'K', 'J', 'I'], // PAIN
  [ThingType.wolfensteinSS]: ['M', 'L', 'K', 'J'], // SSWV
};

/**
 * The player's own frame letters, the `PLAY`-lump counterparts of the
 * `MONSTER_*_FRAMES` tables above — scalars rather than doomednum-keyed
 * records, there being exactly one player. They live here, with every other
 * sprite-frame table, rather than in `game/player.ts`: that file is the
 * movement/collision controller and owns no sprite at all.
 *
 * Death is confirmed against `PLAY`'s lump names: its rotation-0-only tail runs
 * H-W, split as DIE1-7 (H-N, this sequence) then XDIE1-9 (O-W, the gib variant
 * this engine doesn't model). Attack and pain come from `info.c`, which puts
 * `S_PLAY_ATK1`/`ATK2` at `E`/`F` and `S_PLAY_PAIN`/`PAIN2` at `G`, right
 * before the death sequence starts at `H`. The two action frames play via
 * `SpriteAnimator.playOnce`, not `die`: both hand back to the walk/idle cycle
 * when they finish. docs/death.md § Player death.
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
 * `buildThingSprites`'s single-held-`'A'`-frame default. Two distinct reasons a
 * doomednum ends up here, confirmed letter-by-letter against
 * `linuxdoom-1.10/info.c`'s `states[]` table (not the wiki):
 *
 * - **Idle animation** — decorations, health/armor, keys, powerups whose vanilla
 *   `mobjinfo` state cycle loops through more than one frame (`frames.length > 1`).
 * - **A corpse/gib prop's fixed art isn't frame `'A'`** — the "Dead …" and "Bloody
 *   mess" doomednums (10, 12, 15, 18-23) spawn vanilla's own already-mid-death-cycle
 *   `spawnstate`, e.g. `S_HEAD_DIE6` for the dead cacodemon prop — a single-element
 *   `frames` array naming that exact letter, which `SpriteAnimator` then holds
 *   forever the same way it holds `'A'` for anything with no entry at all.
 *
 * A doomednum absent from this table either has vanilla `tics: -1` (genuinely static) or spawns
 * at its sprite's literal `'A'` frame — both already match `buildThingSprites`'s default.
 * `frameSeconds` is one flat rate per entry standing in for vanilla's per-state tic counts, the
 * same accepted simplification `MONSTER_DEATH_FRAME_SECONDS` makes.
 */
export const THING_ANIM_FRAMES: Record<number, { frames: string[]; frameSeconds: number }> = {
  // Health & armor
  [ThingType.soulsphere]: { frames: ['A', 'B', 'C', 'D', 'C', 'B'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.healthBonus]: { frames: ['A', 'B', 'C', 'D', 'C', 'B'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.armorBonus]: { frames: ['A', 'B', 'C', 'D', 'C', 'B'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.greenArmor]: { frames: ['A', 'B'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.blueArmor]: { frames: ['A', 'B'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.megasphere]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 6 * DOOM_TIC },

  // Keys — all six blink identically (S_*KEY <-> S_*KEY2)
  [ThingType.blueKeycard]: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC },
  [ThingType.blueSkullKey]: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC },
  [ThingType.redKeycard]: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC },
  [ThingType.redSkullKey]: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC },
  [ThingType.yellowKeycard]: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC },
  [ThingType.yellowSkullKey]: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC },

  // Powerups
  [ThingType.invulnerability]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.invisibility]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.computerMap]: { frames: ['A', 'B', 'C', 'D', 'C', 'B'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.lightAmpVisor]: { frames: ['A', 'B'], frameSeconds: 6 * DOOM_TIC },

  // Obstacles & decorations
  [ThingType.evilEye]: { frames: ['A', 'B', 'C', 'B'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.floatingSkullRock]: { frames: ['A', 'B', 'C'], frameSeconds: 6 * DOOM_TIC },
  [ThingType.shortGreenPillarHeart]: { frames: ['A', 'B'], frameSeconds: 14 * DOOM_TIC },
  [ThingType.tallBlueTorch]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.tallGreenTorch]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.tallRedTorch]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.shortBlueTorch]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.shortGreenTorch]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.shortRedTorch]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.burningBarrel]: { frames: ['A', 'B', 'C'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.tallTechnoLamp]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.shortTechnoLamp]: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC },
  [ThingType.twitchingImpaledHuman]: { frames: ['A', 'B'], frameSeconds: 7 * DOOM_TIC }, // Real split is 6/8 tics
  [ThingType.pileOfSkullsAndCandles]: { frames: ['A', 'B'], frameSeconds: 6 * DOOM_TIC },

  // Gore & corpses — fixed art at a non-'A' death-cycle frame, held forever (see doc above)
  [ThingType.bloodyMess]: { frames: ['W'], frameSeconds: 6 * DOOM_TIC }, // PLAY bloody mess (S_PLAY_XDIE9)
  [ThingType.bloodyMessAlt]: { frames: ['W'], frameSeconds: 6 * DOOM_TIC }, // PLAY bloody mess (S_PLAY_XDIE9)
  [ThingType.deadPlayer]: { frames: ['N'], frameSeconds: 6 * DOOM_TIC }, // PLAY dead player (S_PLAY_DIE7)
  [ThingType.deadZombieman]: { frames: ['L'], frameSeconds: 6 * DOOM_TIC }, // POSS dead former human (S_POSS_DIE5)
  [ThingType.deadShotgunGuy]: { frames: ['L'], frameSeconds: 6 * DOOM_TIC }, // SPOS dead former sergeant (S_SPOS_DIE5)
  [ThingType.deadImp]: { frames: ['M'], frameSeconds: 6 * DOOM_TIC }, // TROO dead imp (S_TROO_DIE5)
  [ThingType.deadDemon]: { frames: ['N'], frameSeconds: 6 * DOOM_TIC }, // SARG dead demon (S_SARG_DIE6)
  [ThingType.deadCacodemon]: { frames: ['L'], frameSeconds: 6 * DOOM_TIC }, // HEAD dead cacodemon (S_HEAD_DIE6)
  [ThingType.deadLostSoul]: { frames: ['K'], frameSeconds: 6 * DOOM_TIC }, // SKUL dead lost soul (S_SKULL_DIE6)

  // Gore — ceiling-hung, 'A,B,C,B' twitch loop (both the solid and non-solid GOR1 placements)
  [ThingType.hangingVictimTwitching]: { frames: ['A', 'B', 'C', 'B'], frameSeconds: 10 * DOOM_TIC }, // GOR1 — real cycle is 10/15/8/6 tics
  [ThingType.hangingVictimTwitchingNoBlock]: { frames: ['A', 'B', 'C', 'B'], frameSeconds: 10 * DOOM_TIC }, // GOR1 — same cycle, non-blocking placement
};

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
 * What to call a thing that killed the player, on the death overlay. The
 * article is part of the value rather than derived, so the two names that don't
 * take "a"/"an" (Commander Keen, the Icon of Sin) need no exception.
 *
 * Vanilla has no obituaries at all, so nothing here is a fidelity claim: these
 * are the standard manual/editor names for the types, as player-facing text.
 * Only what can actually land a killing blow is listed — every monster, plus
 * the exploding barrel. See docs/death.md § Player death.
 */
export const THING_NAMES: Record<number, string> = {
  [ThingType.zombieman]: 'a Zombieman',
  [ThingType.shotgunGuy]: 'a Shotgun Guy',
  [ThingType.imp]: 'an Imp',
  [ThingType.demon]: 'a Demon',
  [ThingType.spectre]: 'a Spectre',
  [ThingType.lostSoul]: 'a Lost Soul',
  [ThingType.cacodemon]: 'a Cacodemon',
  [ThingType.baronOfHell]: 'a Baron of Hell',
  [ThingType.hellKnight]: 'a Hell Knight',
  [ThingType.spiderMastermind]: 'a Spider Mastermind',
  [ThingType.cyberdemon]: 'a Cyberdemon',
  [ThingType.painElemental]: 'a Pain Elemental',
  [ThingType.heavyWeaponDude]: 'a Heavy Weapon Dude',
  [ThingType.revenant]: 'a Revenant',
  [ThingType.mancubus]: 'a Mancubus',
  [ThingType.arachnotron]: 'an Arachnotron',
  [ThingType.archVile]: 'an Arch-Vile',
  [ThingType.wolfensteinSS]: 'a Wolfenstein SS',
  [ThingType.commanderKeen]: 'Commander Keen',
  [ThingType.bossBrain]: 'the Icon of Sin',
  [ThingType.barrel]: 'an exploding barrel',
};

/**
 * The death overlay's line under "YOU DIED", or `''` when there is nothing to
 * say — a cause no call site attributed, or a doomednum with no name here,
 * which the overlay then draws exactly as it did before there was a line at
 * all. See docs/death.md § Player death.
 */
export function obituary(cause: DamageCause | undefined): string {
  if (cause === 'self') return 'You blew yourself up';
  if (cause === 'crush') return 'You were crushed';
  if (cause === 'slime') return 'You forgot to wear a protection suit';
  const name = typeof cause === 'number' ? THING_NAMES[cause] : undefined;
  return name ? `You were killed by ${name}` : '';
}
