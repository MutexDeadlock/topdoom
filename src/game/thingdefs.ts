import { DOOM_TIC } from '../constants.ts';

/**
 * DOOM thing type (doomednum) to the sprite it spawns with, covering
 * monsters, weapons, ammo, health/armor, keys, powerups and common
 * decorations from both DOOM and DOOM II. Player starts, deathmatch spots,
 * teleport landings and boss shooter cubes are intentionally absent — DOOM
 * itself renders none of those, they are spawn markers only.
 */
export const THING_SPRITES: Record<number, string> = {
  // Monsters
  3004: 'POSS',
  9: 'SPOS',
  3001: 'TROO',
  3002: 'SARG',
  58: 'SARG',
  3006: 'SKUL',
  3005: 'HEAD',
  3003: 'BOSS',
  69: 'BOS2',
  7: 'SPID',
  16: 'CYBR',
  71: 'PAIN',
  65: 'CPOS',
  66: 'SKEL',
  67: 'FATT',
  68: 'BSPI',
  64: 'VILE',
  84: 'SSWV',
  72: 'KEEN',
  88: 'BBRN',

  // Weapons
  2001: 'SHOT',
  82: 'SGN2',
  2002: 'MGUN',
  2003: 'LAUN',
  2004: 'PLAS',
  2005: 'CSAW',
  2006: 'BFUG',

  // Ammo
  2007: 'CLIP',
  2048: 'AMMO',
  2010: 'ROCK',
  2046: 'BROK',
  2047: 'CELL',
  17: 'CELP',
  2008: 'SHEL',
  2049: 'SBOX',
  8: 'BPAK',

  // Health & armor
  2011: 'STIM',
  2012: 'MEDI',
  2013: 'SOUL',
  2014: 'BON1',
  2015: 'BON2',
  2018: 'ARM1',
  2019: 'ARM2',
  83: 'MEGA',

  // Keys
  5: 'BKEY',
  40: 'BSKU',
  13: 'RKEY',
  38: 'RSKU',
  6: 'YKEY',
  39: 'YSKU',

  // Powerups
  2022: 'PINV',
  2023: 'PSTR',
  2024: 'PINS',
  2025: 'SUIT',
  2026: 'PMAP',
  2045: 'PVIS',

  // Obstacles & decorations
  2035: 'BAR1',
  2028: 'COLU',
  34: 'CAND',
  35: 'CBRA',
  30: 'COL1',
  31: 'COL2',
  32: 'COL3',
  33: 'COL4',
  36: 'COL5',
  37: 'COL6',
  41: 'CEYE',
  42: 'FSKU',
  44: 'TBLU',
  45: 'TGRN',
  46: 'TRED',
  55: 'SMBT',
  56: 'SMGT',
  57: 'SMRT',
  47: 'SMIT',
  48: 'ELEC',
  70: 'FCAN',
  85: 'TLMP',
  86: 'TLP2',
  43: 'TRE1',
  54: 'TRE2',
  25: 'POL1',
  26: 'POL6',
  27: 'POL4',
  28: 'POL2',
  29: 'POL3',

  // Gore & corpses — floor-standing, non-solid unless noted
  10: 'PLAY', // Bloody mess
  12: 'PLAY', // Bloody mess (vanilla places the same art under two editor numbers)
  15: 'PLAY', // Dead player
  18: 'POSS', // Dead former human
  19: 'SPOS', // Dead former sergeant
  20: 'TROO', // Dead imp
  21: 'SARG', // Dead demon
  22: 'HEAD', // Dead cacodemon
  23: 'SKUL', // Dead lost soul (invisible in vanilla — no MF_SOLID/MF_NOBLOCKMAP either)
  24: 'POL5', // Pool of blood and flesh
  79: 'POB1', // Colon gibs
  80: 'POB2', // Small pool of blood
  81: 'BRS1', // Brain stem

  // Gore — hangs from the ceiling (MF_SPAWNCEILING); solid variants block, "Hanging …" ones don't
  49: 'GOR1',
  50: 'GOR2',
  51: 'GOR3',
  52: 'GOR4',
  53: 'GOR5',
  59: 'GOR2',
  60: 'GOR4',
  61: 'GOR3',
  62: 'GOR5',
  63: 'GOR1',
  73: 'HDB1',
  74: 'HDB2',
  75: 'HDB3',
  76: 'HDB4',
  77: 'HDB5',
  78: 'HDB6',
};

/**
 * Doomednums of the "Monsters" block above — the things auto-aim (game/weapons.ts's
 * click-to-target, wired up in game.ts's `ThingLayer.pickMonster`) is willing to
 * snap a shot onto, minus `NO_AUTO_AIM_TYPES` below, and the set
 * `game/monsters.ts`'s AI ticks. This table only
 * decides which doomednums count as a monster at all (for targeting, AI, and
 * every other `MONSTER_TYPES.has(...)` check across the game/ tree) — the AI
 * behavior itself (waking, chasing, attacking, infighting) lives in
 * `game/monsters.ts`, not here.
 */
export const MONSTER_TYPES = new Set([
  3004, 9, 3001, 3002, 58, 3006, 3005, 3003, 69, 7, 16, 71, 65, 66, 67, 68, 64, 84, 72, 88,
]);

/**
 * `MONSTER_TYPES` members auto-aim refuses to lock onto — everything else about them is unchanged.
 * Only the Icon of Sin's brain (88), which sits in a recess whose one opening is *above* its whole
 * body, so a locked-on shot can never reach it and the lock only steals the player's aim. See
 * docs/combat.md § Auto-aim.
 */
export const NO_AUTO_AIM_TYPES = new Set([88]);

/**
 * Doomednums of the "Ammo", "Health & armor", "Keys" and "Powerups" blocks above — the small
 * collectibles `game/things.ts`'s `pickupScaleFor` draws at `PICKUP_SCALE` (1.4×) their native WAD
 * pixel size, since those are what actually suffer from this engine's far, tilted top-down camera
 * (see that constant's own doc). A whitelist rather than "everything but monsters/weapons": solid
 * decorations, gore props and the barrel are large enough on their own, and inflating them by 40%
 * on top of vanilla's own size reads as oversized rather than more readable.
 */
export const PICKUP_SCALE_TYPES = new Set([
  // Ammo
  2007, // CLIP clip
  2048, // AMMO box of bullets
  2010, // ROCK rocket
  2046, // BROK box of rockets
  2047, // CELL cell
  17, // CELP cell pack
  2008, // SHEL shells
  2049, // SBOX box of shells
  8, // BPAK backpack

  // Health & armor
  2011, // STIM stimpack
  2012, // MEDI medikit
  2013, // SOUL soulsphere
  2014, // BON1 health bonus
  2015, // BON2 armor bonus
  2018, // ARM1 green armor
  2019, // ARM2 blue armor
  83, // MEGA megasphere

  // Keys
  5, // BKEY blue keycard
  40, // BSKU blue skull key
  13, // RKEY red keycard
  38, // RSKU red skull key
  6, // YKEY yellow keycard
  39, // YSKU yellow skull key

  // Powerups
  2022, // PINV invulnerability
  2023, // PSTR berserk
  2024, // PINS partial invisibility
  2025, // SUIT radiation suit
  2026, // PMAP computer area map
  2045, // PVIS light amp. visor
]);

/**
 * Doomednums from the "Obstacles & decorations" and "Gore & corpses" blocks above that carry
 * vanilla's `MF_SOLID` flag, confirmed against `linuxdoom-1.10/info.c`'s `mobjinfo` table: the
 * column, candelabra, all six pillars, the evil eye, skull rock, all six torches, the stalagmite,
 * the tech pillar, the burning barrel, both techno lamps, both trees, the five pole/skull
 * decorations, the solid "hanging victim" quintet (49/50/51/52/53) and DOOM II's six solid `HDB*`
 * body bags (73-78) — `CEILING_HUNG_HEIGHT`'s other five entries (59/60/61/62/63) reuse the same
 * `GOR*` sprites at vanilla's genuinely non-solid, wider-radius placement and are deliberately not
 * in this set. The exploding barrel (2035, `MT_BARREL`) is solid too but already has its own
 * `BARREL_TYPE` handling in `game/things.ts` and is deliberately not repeated here. Two decorations
 * in these blocks are
 * genuinely **not** solid in vanilla and are excluded on purpose: the plain candle (34,
 * `MT_MISC49`, `flags: 0`) and every dead-monster/blood-pool prop (10-24, 79-81) — see
 * docs/movement.md § Solid decorations.
 */
export const SOLID_DECORATION_TYPES = new Set([
  2028, 30, 31, 32, 33, 35, 36, 37, 41, 42, 44, 45, 46, 47, 48, 55, 56, 57, 70, 85, 86, 43, 54, 25,
  26, 27, 28, 29, 49, 50, 51, 52, 53, 73, 74, 75, 76, 77, 78,
]);

/** Vanilla `mobjinfo` radius shared by every entry in `SOLID_DECORATION_TYPES` except `SOLID_DECORATION_RADIUS_OVERRIDE`'s keys — confirmed against `info.c`. */
export const SOLID_DECORATION_RADIUS = 16;

/**
 * The one `SOLID_DECORATION_TYPES` entry whose real vanilla radius isn't the shared 16 units: the
 * big tree (54, `MT_MISC76`) is 32 in `info.c`. Every other entry in the set genuinely does share
 * the 16-unit radius, so this stays a single-key override rather than promoting every entry to a
 * per-type table.
 */
export const SOLID_DECORATION_RADIUS_OVERRIDE: Record<number, number> = { 54: 32 };

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
  49: 68, // GOR1 (solid) hanging victim, twitching
  50: 84, // GOR2 (solid) hanging victim, guts removed
  51: 84, // GOR3 (solid) hanging victim, guts and brain removed
  52: 68, // GOR4 (solid) hanging torso, looking down
  53: 52, // GOR5 (solid) hanging torso, open skull
  59: 84, // GOR2 (non-solid) hanging pair of legs
  60: 68, // GOR4 (non-solid) hanging victim, 1-legged
  61: 52, // GOR3 (non-solid) hanging victim, arms out
  62: 52, // GOR5 (non-solid) hanging leg
  63: 68, // GOR1 (non-solid) hanging victim, twitching
  73: 88, // HDB1
  74: 88, // HDB2
  75: 64, // HDB3
  76: 64, // HDB4
  77: 64, // HDB5
  78: 64, // HDB6
  72: 72, // KEEN commander keen — MF_SPAWNCEILING like the gore above, just shootable
};

/**
 * Spawn-frame letters for the `MONSTER_TYPES` members whose `mobjinfo.spawnstate` **isn't** a walk
 * cycle, overriding `buildThingSprites`'s shared `MONSTER_WALK_FRAMES` default. Only the two types
 * with no AI qualify: `S_KEENSTND` and `S_BRAIN` are both single held frames (`tics: -1`), and for
 * both of them the letters `MONSTER_WALK_FRAMES` would otherwise cycle through are death art.
 *
 * Load-bearing even though neither type's animator currently advances: `animating` is only ever
 * turned on by the AI branch in `update()`, which these two never enter, so today they hold frame 0
 * by accident rather than by rule. docs/monsters.md § Commander Keen.
 */
export const MONSTER_IDLE_FRAMES: Record<number, string[]> = {
  72: ['A'], // KEEN, S_KEENSTND
  88: ['A'], // BBRN, S_BRAIN
};

/**
 * `A_SpawnFly`'s monster lottery — the type an Icon of Sin spawn cube turns into on arrival, as
 * ordered upper bounds on one `P_Random()` roll (0-255): the first entry the roll falls under wins,
 * and the last is the `else`. Transcribed from `p_enemy.c`'s own if/else chain, with each `MT_*`
 * resolved to its `info.c` doomednum. The weights are deliberately lopsided and stay that way — an
 * arch-vile is 2/256 where an imp is 50/256. docs/monsters.md § The spawn cube.
 */
export const SPAWN_CUBE_MONSTERS: readonly { below: number; type: number }[] = [
  { below: 50, type: 3001 }, // MT_TROOP imp
  { below: 90, type: 3002 }, // MT_SERGEANT demon
  { below: 120, type: 58 }, // MT_SHADOWS spectre
  { below: 130, type: 71 }, // MT_PAIN pain elemental
  { below: 160, type: 3005 }, // MT_HEAD cacodemon
  { below: 162, type: 64 }, // MT_VILE arch-vile
  { below: 172, type: 66 }, // MT_UNDEAD revenant
  { below: 192, type: 68 }, // MT_BABY arachnotron
  { below: 222, type: 67 }, // MT_FATSO mancubus
  { below: 246, type: 69 }, // MT_KNIGHT hell knight
  { below: 256, type: 3003 }, // MT_BRUISER baron of hell
];

/**
 * `MONSTER_TYPES` entries that carry vanilla's `MF_COUNTKILL` flag — every monster except the
 * lost soul (3006) and the Icon of Sin's brain (88), neither of which does in `info.c`'s
 * `mobjinfo` table. `MONSTER_TYPES` exists for targeting/AI and isn't the same list vanilla uses
 * for the level's kill total.
 */
export const COUNTKILL_TYPES = new Set([
  3004, 9, 3001, 3002, 58, 3005, 3003, 69, 7, 16, 71, 65, 66, 67, 68, 64, 84, 72,
]);

/**
 * Doomednums with vanilla's `MF_COUNTITEM` flag, confirmed against `info.c`'s `mobjinfo` table —
 * health/armor bonus, soulsphere, invulnerability, berserk, invisibility, computer map, light
 * visor, megasphere. Deliberately excludes keys, the backpack, weapons, ammo, and the radiation
 * suit (2025): none of those carry the flag in vanilla, matching the well-known behavior that the
 * backpack doesn't count toward a level's item percentage.
 */
export const COUNTITEM_TYPES = new Set([2014, 2015, 2013, 2022, 2023, 2024, 2026, 2045, 83]);

/**
 * The five monster types real vanilla's `A_BossDeath` (`p_enemy.c`) can fire for — confirmed
 * against `info.c`'s `mobjinfo` doomednums. See docs/specials.md § Boss death.
 */
export const BOSS_DEATH_TYPES = {
  baron: 3003,
  cyberdemon: 16,
  spiderMastermind: 7,
  mancubus: 67,
  arachnotron: 68,
} as const;

/** Vanilla `mobjinfo` spawn health, confirmed against the Doom Wiki's monster table. */
export const MONSTER_HEALTH: Record<number, number> = {
  3004: 20, // POSS zombieman
  9: 30, // SPOS shotgun guy
  3001: 60, // TROO imp
  3002: 150, // SARG demon
  58: 150, // SARG spectre
  3006: 100, // SKUL lost soul
  3005: 400, // HEAD cacodemon
  3003: 1000, // BOSS baron of hell
  69: 500, // BOS2 hell knight
  7: 3000, // SPID spider mastermind
  16: 4000, // CYBR cyberdemon
  71: 400, // PAIN pain elemental
  65: 70, // CPOS heavy weapon dude
  66: 300, // SKEL revenant
  67: 600, // FATT mancubus
  68: 500, // BSPI arachnotron
  64: 700, // VILE arch-vile
  84: 50, // SSWV wolfenstein SS
  72: 100, // KEEN commander keen
  88: 250, // BBRN boss brain
};

/**
 * Regular-death sprite frame letters per doomednum — confirmed against the
 * real DOOM.WAD/DOOM2.WAD lump names, and cross-checked against `info.c`.
 * Death art is rotation-0 only, so where a sprite's directional frames stop
 * marks where death art starts; DIE is the front of that tail, XDIE the back.
 * That derivation doesn't reach the two AI-less types at the bottom, whose
 * whole sprite is rotation-0 — theirs come straight off `info.c`'s own chains.
 * docs/monsters.md § Pain, and attack/pain poses.
 */
export const MONSTER_DEATH_FRAMES: Record<number, string[]> = {
  3004: ['H', 'I', 'J', 'K', 'L'], // POSS
  9: ['H', 'I', 'J', 'K', 'L'], // SPOS
  3001: ['I', 'J', 'K', 'L', 'M'], // TROO
  3002: ['I', 'J', 'K', 'L', 'M', 'N'], // SARG
  58: ['I', 'J', 'K', 'L', 'M', 'N'], // SARG (spectre)
  // Starts at F, not G: S_SKULL_DIE1 follows 2 walk + 2 attack + 1 pain (A-E).
  3006: ['F', 'G', 'H', 'I', 'J', 'K'], // SKUL
  3005: ['G', 'H', 'I', 'J', 'K', 'L'], // HEAD
  3003: ['I', 'J', 'K', 'L', 'M', 'N', 'O'], // BOSS
  69: ['I', 'J', 'K', 'L', 'M', 'N', 'O'], // BOS2
  7: ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S'], // SPID
  16: ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'], // CYBR
  71: ['H', 'I', 'J', 'K', 'L', 'M'], // PAIN
  // Seven death states (H-N) before XDEATH starts at O, not five.
  65: ['H', 'I', 'J', 'K', 'L', 'M', 'N'], // CPOS
  // Starts at L: S_SKEL_DIE1 reuses S_SKEL_PAIN's own letter — a real info.c
  // quirk, so the rotation-0 tail starts one letter earlier than it looks.
  66: ['L', 'M', 'N', 'O', 'P', 'Q'], // SKEL
  67: ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'], // FATT
  68: ['J', 'K', 'L', 'M', 'N', 'O', 'P'], // BSPI
  // Starts at Q: same shared pain/DIE1 letter quirk as SKEL above.
  64: ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'], // VILE
  84: ['I', 'J', 'K', 'L', 'M'], // SSWV
  // S_COMMKEEN..S_COMMKEEN12 — twelve frames starting at A, the same letter
  // S_KEENSTND holds (see MONSTER_IDLE_FRAMES). The corpse keeps hanging: Keen
  // is MF_SPAWNCEILING, so `update()` goes on measuring its z off the ceiling.
  72: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'], // KEEN
  // S_BRAIN_DIE1-4 all hold BBRN frame 0 — the brain has no death art at all,
  // it just sits there for 120 tics while A_BrainScream detonates around it.
  // Listed anyway so `damage()` holds the sprite instead of hiding it, and so
  // `deathFrameCount` is 1 rather than 0. game/icon.ts owns the rest.
  88: ['A'], // BBRN
};

/**
 * Gib (XDeath) frame letters — the back of the same rotation-0 tail
 * `MONSTER_DEATH_FRAMES` takes its front from. **Only five stock types have
 * one at all** (the human grunts and the imp); everything else has no
 * `xdeathstate` in `mobjinfo` and always plays its plain death.
 * `ThingLayer.damage` picks between the two by `P_KillMobj`'s overkill rule —
 * docs/combat.md § Monster death.
 */
export const MONSTER_XDEATH_FRAMES: Record<number, string[]> = {
  3004: ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // POSS
  9: ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // SPOS
  3001: ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // TROO
  // Starts at O, right after the DEATH table's own N — the two must not overlap.
  65: ['O', 'P', 'Q', 'R', 'S', 'T'], // CPOS
  84: ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'], // SSWV
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
 * corpse. See docs/combat.md § Monster death.
 */
export const MONSTER_CORPSE_VANISHES = new Set([3006, 71]); // SKUL, PAIN

/**
 * Attack sprite frame letters per doomednum. Unlike the death tables these
 * aren't structurally derivable from the WAD, so they're lifted from `info.c`'s
 * `missilestate` chains and cross-checked letter-by-letter against the real
 * sprite lumps — the discipline that surfaced the four death-table bugs above.
 * docs/monsters.md § Pain, and attack/pain poses.
 *
 * Only letters distinct from the walk cycle and from each other are kept:
 * vanilla repeats frames mid-sequence purely to hold a pose, a no-op against
 * `playOnce`'s flat per-frame duration, and `SPID`/`BSPI`'s `A_FaceTarget`
 * frame reuses their idle letter. `SKEL`'s five letters cover *both* its
 * attack kinds as one sequence — the sprite layer has no "which attack" signal
 * to key off, only the AI knows, and by then the pose is just "attacking".
 */
export const MONSTER_ATTACK_FRAMES: Record<number, string[]> = {
  3004: ['E', 'F'], // POSS
  9: ['E', 'F'], // SPOS
  3001: ['E', 'F', 'G'], // TROO
  3002: ['E', 'F', 'G'], // SARG
  58: ['E', 'F', 'G'], // SARG (spectre)
  3006: ['C', 'D'], // SKUL
  3005: ['B', 'C', 'D'], // HEAD
  3003: ['E', 'F', 'G'], // BOSS
  69: ['E', 'F', 'G'], // BOS2
  7: ['G', 'H'], // SPID
  16: ['E', 'F'], // CYBR
  71: ['D', 'E', 'F'], // PAIN
  65: ['E', 'F'], // CPOS
  66: ['G', 'H', 'I', 'J', 'K'], // SKEL
  67: ['G', 'H', 'I'], // FATT
  68: ['G', 'H'], // BSPI
  64: ['G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'], // VILE
  84: ['E', 'F', 'G'], // SSWV
};

/**
 * Pain (flinch) sprite frame letters, derived the same way and with the same
 * WAD cross-check as `MONSTER_ATTACK_FRAMES` above. Every monster in stock
 * DOOM has exactly one pain frame except the cacodemon (`HEAD`), whose
 * `S_HEAD_PAIN3` genuinely is a second, distinct recoil frame — confirmed
 * against the WAD, not an accident of the derivation. `ThingLayer.damage`
 * only plays this when a hit actually rolls past the monster's own
 * `painChance` (`game/monsters.ts`) — a hit that fails the roll flinches by
 * vanilla rule, not just by art.
 */
export const MONSTER_PAIN_FRAMES: Record<number, string[]> = {
  3004: ['G'], // POSS
  9: ['G'], // SPOS
  3001: ['H'], // TROO
  3002: ['H'], // SARG
  58: ['H'], // SARG (spectre)
  3006: ['E'], // SKUL
  3005: ['E', 'F'], // HEAD
  3003: ['H'], // BOSS
  69: ['H'], // BOS2
  7: ['I'], // SPID
  16: ['G'], // CYBR
  71: ['G'], // PAIN
  65: ['G'], // CPOS
  66: ['L'], // SKEL
  67: ['J'], // FATT
  68: ['I'], // BSPI
  64: ['Q'], // VILE
  84: ['H'], // SSWV
  // The two AI-less types. Both have a real painstate and effectively always
  // enter it (painchance 256 and 255 of 256), but neither has `MONSTER_STATS`
  // to roll against — `ThingLayer.damage`'s `INERT_SHOOTABLE` branch flinches
  // them unconditionally instead. docs/monsters.md § Commander Keen.
  72: ['M'], // KEEN, S_KEENPAIN
  88: ['B'], // BBRN, S_BRAIN_PAIN
};

/**
 * Flat per-frame duration for both tables above — the same "one uniform rate
 * instead of vanilla's own per-state tic count" simplification
 * `MONSTER_DEATH_FRAME_SECONDS` already makes, just faster: vanilla's attack/
 * pain states mostly hold 3-10 tics (vs. death's 5-8), and a flinch or a
 * punch/muzzle-flash reads as snappier than a death collapse regardless.
 */
export const MONSTER_ACTION_FRAME_SECONDS = 3 * DOOM_TIC;

/**
 * Resurrection frame letters — `mobjinfo.raisestate`, the arch-vile's
 * `A_VileChase` target. Only 13 types have one at all; no entry means "not
 * raisable", the same convention `MONSTER_XDEATH_FRAMES` uses.
 *
 * **Not simply the reverse of `MONSTER_DEATH_FRAMES`** — that was tried and is
 * wrong, since vanilla's raise sequences are hand-authored per type with no
 * shared derivation rule. Every letter is read off `info.c`'s `S_*_RAISE*`
 * table directly. docs/monsters.md § The arch-vile.
 *
 * Played via `playOnce` after `revive()` undoes `die()`, reusing
 * `MONSTER_DEATH_FRAME_SECONDS` — vanilla's raise states hold 5-8 tics,
 * squarely inside death's own range, so a dedicated constant would tune nothing.
 */
export const MONSTER_RAISE_FRAMES: Record<number, string[]> = {
  3004: ['K', 'J', 'I'], // POSS
  9: ['L', 'K', 'J', 'I'], // SPOS
  3001: ['M', 'L', 'K', 'J'], // TROO
  3002: ['N', 'M', 'L', 'K', 'J'], // SARG
  58: ['N', 'M', 'L', 'K', 'J'], // SARG (spectre)
  3005: ['L', 'K', 'J', 'I', 'H'], // HEAD
  3003: ['O', 'N', 'M', 'L', 'K', 'J'], // BOSS
  69: ['O', 'N', 'M', 'L', 'K', 'J'], // BOS2
  65: ['N', 'M', 'L', 'K', 'J', 'I'], // CPOS
  66: ['Q', 'P', 'O', 'N', 'M'], // SKEL
  67: ['R', 'Q', 'P', 'O', 'N', 'M', 'L'], // FATT
  68: ['P', 'O', 'N', 'M', 'L', 'K'], // BSPI
  71: ['M', 'L', 'K', 'J', 'I'], // PAIN
  84: ['M', 'L', 'K', 'J'], // SSWV
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
 * when they finish. docs/combat.md § Player death.
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
  3004: 2007, // POSS zombieman -> CLIP
  84: 2007, // SSWV wolfenstein SS -> CLIP
  9: 2001, // SPOS shotgun guy -> SHOTGUN
  65: 2002, // CPOS chaingunner -> CHAINGUN
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
 * A doomednum absent from this table either has vanilla `tics: -1` (genuinely
 * static — STIM/MEDI, the plain column, both candles, ammo/weapon pickups) or
 * spawns at its sprite's literal `'A'` frame (most solid decorations, blood
 * pools, hanging corpses) — both cases already match `buildThingSprites`'s
 * default and don't need an entry.
 *
 * `frameSeconds` is one flat rate per entry standing in for vanilla's own
 * per-state tic counts, the same accepted simplification `BARREL_IDLE_FRAME_SECONDS`
 * and `MONSTER_DEATH_FRAME_SECONDS` already make (ARM1's real A/B split is 6/7
 * tics, not perfectly even, but a second constant for one doomednum would tune
 * nothing anyone could see); meaningless for a single-frame entry, which never animates.
 */
export const THING_ANIM_FRAMES: Record<number, { frames: string[]; frameSeconds: number }> = {
  // Health & armor
  2013: { frames: ['A', 'B', 'C', 'D', 'C', 'B'], frameSeconds: 6 * DOOM_TIC }, // SOUL soulsphere
  2014: { frames: ['A', 'B', 'C', 'D', 'C', 'B'], frameSeconds: 6 * DOOM_TIC }, // BON1 health bonus
  2015: { frames: ['A', 'B', 'C', 'D', 'C', 'B'], frameSeconds: 6 * DOOM_TIC }, // BON2 armor bonus
  2018: { frames: ['A', 'B'], frameSeconds: 6 * DOOM_TIC }, // ARM1 green armor
  2019: { frames: ['A', 'B'], frameSeconds: 6 * DOOM_TIC }, // ARM2 blue armor
  83: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 6 * DOOM_TIC }, // MEGA megasphere

  // Keys — all six blink identically (S_*KEY <-> S_*KEY2)
  5: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC }, // BKEY blue keycard
  40: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC }, // BSKU blue skull key
  13: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC }, // RKEY red keycard
  38: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC }, // RSKU red skull key
  6: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC }, // YKEY yellow keycard
  39: { frames: ['A', 'B'], frameSeconds: 10 * DOOM_TIC }, // YSKU yellow skull key

  // Powerups
  2022: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 6 * DOOM_TIC }, // PINV invulnerability
  2024: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 6 * DOOM_TIC }, // PINS partial invisibility
  2026: { frames: ['A', 'B', 'C', 'D', 'C', 'B'], frameSeconds: 6 * DOOM_TIC }, // PMAP computer area map
  2045: { frames: ['A', 'B'], frameSeconds: 6 * DOOM_TIC }, // PVIS light amp. visor

  // Obstacles & decorations
  41: { frames: ['A', 'B', 'C', 'B'], frameSeconds: 6 * DOOM_TIC }, // CEYE evil eye
  42: { frames: ['A', 'B', 'C'], frameSeconds: 6 * DOOM_TIC }, // FSKU floating skull-rock
  36: { frames: ['A', 'B'], frameSeconds: 14 * DOOM_TIC }, // COL5 heart column
  44: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC }, // TBLU tall blue firestick
  45: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC }, // TGRN tall green torch
  46: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC }, // TRED tall red torch
  55: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC }, // SMBT short blue torch
  56: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC }, // SMGT short green torch
  57: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC }, // SMRT short red torch
  70: { frames: ['A', 'B', 'C'], frameSeconds: 4 * DOOM_TIC }, // FCAN burning barrel
  85: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC }, // TLMP tall techno lamp
  86: { frames: ['A', 'B', 'C', 'D'], frameSeconds: 4 * DOOM_TIC }, // TLP2 large techno lamp
  26: { frames: ['A', 'B'], frameSeconds: 7 * DOOM_TIC }, // POL6 twitching impaled human — real split is 6/8 tics
  29: { frames: ['A', 'B'], frameSeconds: 6 * DOOM_TIC }, // POL3 pile of skulls and candles

  // Gore & corpses — fixed art at a non-'A' death-cycle frame, held forever (see doc above)
  10: { frames: ['W'], frameSeconds: 6 * DOOM_TIC }, // PLAY bloody mess (S_PLAY_XDIE9)
  12: { frames: ['W'], frameSeconds: 6 * DOOM_TIC }, // PLAY bloody mess (S_PLAY_XDIE9)
  15: { frames: ['N'], frameSeconds: 6 * DOOM_TIC }, // PLAY dead player (S_PLAY_DIE7)
  18: { frames: ['L'], frameSeconds: 6 * DOOM_TIC }, // POSS dead former human (S_POSS_DIE5)
  19: { frames: ['L'], frameSeconds: 6 * DOOM_TIC }, // SPOS dead former sergeant (S_SPOS_DIE5)
  20: { frames: ['M'], frameSeconds: 6 * DOOM_TIC }, // TROO dead imp (S_TROO_DIE5)
  21: { frames: ['N'], frameSeconds: 6 * DOOM_TIC }, // SARG dead demon (S_SARG_DIE6)
  22: { frames: ['L'], frameSeconds: 6 * DOOM_TIC }, // HEAD dead cacodemon (S_HEAD_DIE6)
  23: { frames: ['K'], frameSeconds: 6 * DOOM_TIC }, // SKUL dead lost soul (S_SKULL_DIE6)

  // Gore — ceiling-hung, 'A,B,C,B' twitch loop (both the solid and non-solid GOR1 placements)
  49: { frames: ['A', 'B', 'C', 'B'], frameSeconds: 10 * DOOM_TIC }, // GOR1 — real cycle is 10/15/8/6 tics
  63: { frames: ['A', 'B', 'C', 'B'], frameSeconds: 10 * DOOM_TIC }, // GOR1 — same cycle, non-blocking placement
};

/**
 * The exploding barrel's own `A_Explode` — vanilla's literal
 * `P_RadiusAttack(thingy, thingy->target, 128)`, identical radius and damage to
 * the rocket launcher's own splash (`weapons.ts`'s `rocketLauncher.splash`).
 * Table data, so it lives here rather than with the barrel's runtime state in
 * `things.ts`: that keeps `combat.ts`'s import of `things.ts` type-only, which
 * is what lets `monsters.ts` reach `applyRadiusDamage` without a cycle.
 */
export const BARREL_SPLASH_RADIUS = 128;
export const BARREL_SPLASH_DAMAGE = 128;
