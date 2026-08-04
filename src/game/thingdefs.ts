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
};

/**
 * Doomednums of the "Monsters" block above — the things auto-aim (game/weapons.ts's
 * click-to-target, wired up in game.ts's `ThingLayer.pickMonster`) is willing to
 * snap a shot onto, and the set `game/monsters.ts`'s AI ticks. This table only
 * decides which doomednums count as a monster at all (for targeting, AI, and
 * every other `MONSTER_TYPES.has(...)` check across the game/ tree) — the AI
 * behavior itself (waking, chasing, attacking, infighting) lives in
 * `game/monsters.ts`, not here.
 */
export const MONSTER_TYPES = new Set([
  3004, 9, 3001, 3002, 58, 3006, 3005, 3003, 69, 7, 16, 71, 65, 66, 67, 68, 64, 84, 72, 88,
]);

/** Doomednums of the "Weapons" block above — kept out of `game/things.ts`'s pickup up-scale, see there for why. */
export const WEAPON_TYPES = new Set([2001, 82, 2002, 2003, 2004, 2005, 2006]);

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
 * Regular-death sprite frame letters, one entry per doomednum that shares its
 * sprite's DIE (not gib/XDIE) sequence — confirmed against the actual lump
 * names in DOOM.WAD/DOOM2.WAD rather than guessed. Death art in vanilla is
 * rotation-0 (omnidirectional) only, so the point where a sprite's
 * directional (rotation 1-8) frames stop and its rotation-0 tail begins marks
 * exactly where movement/attack/pain art ends and death art starts; DIE is
 * the *front* portion of that tail — the back portion is XDIE (see
 * `MONSTER_XDEATH_FRAMES` below), vanilla's own extra-gib animation, played
 * instead of this one when a killing blow overkills by a wide enough margin.
 * Commander Keen (72, a pain-cascade "death" with no distinct DIE state) and
 * the boss brain (88, only 2 sprite frames total, no death art at all) are
 * deliberately absent; `ThingLayer.damage` falls back to just hiding a
 * killed monster with no entry here.
 */
export const MONSTER_DEATH_FRAMES: Record<number, string[]> = {
  3004: ['H', 'I', 'J', 'K', 'L'], // POSS
  9: ['H', 'I', 'J', 'K', 'L'], // SPOS
  3001: ['I', 'J', 'K', 'L', 'M'], // TROO
  3002: ['I', 'J', 'K', 'L', 'M', 'N'], // SARG
  58: ['I', 'J', 'K', 'L', 'M', 'N'], // SARG (spectre)
  // SKUL: was ['G',...] missing DIE1='F' — info.c's S_SKULL_DIE1 uses frame F
  // (2 walk + 2 attack + 1 pain frame before it: A,B/C,D/E), confirmed against
  // the real WAD, which has SKULF0 alongside G0-K0. The 5-entry table this
  // replaced silently dropped the animation's very first frame.
  3006: ['F', 'G', 'H', 'I', 'J', 'K'], // SKUL
  3005: ['G', 'H', 'I', 'J', 'K', 'L'], // HEAD
  3003: ['I', 'J', 'K', 'L', 'M', 'N', 'O'], // BOSS
  69: ['I', 'J', 'K', 'L', 'M', 'N', 'O'], // BOS2
  7: ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S'], // SPID
  16: ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'], // CYBR
  71: ['H', 'I', 'J', 'K', 'L', 'M'], // PAIN
  // CPOS: was ['H','I','J','K','L'], missing DIE6/DIE7 ('M','N') — info.c has
  // seven CPOS death states (H-N) before the XDEATH tail starts at 'O', not
  // five; the WAD's own CPOSM0/CPOSN0 lumps exist and were going unused.
  65: ['H', 'I', 'J', 'K', 'L', 'M', 'N'], // CPOS
  // SKEL: was ['M',...] missing DIE1='L' — info.c's S_SKEL_DIE1 reuses the
  // exact same frame letter as S_SKEL_PAIN/PAIN2 (a genuine vanilla quirk,
  // not a transcription slip), so the WAD-confirmed rotation-0 tail (L-Q)
  // starts one letter earlier than the previous table had it.
  66: ['L', 'M', 'N', 'O', 'P', 'Q'], // SKEL
  67: ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'], // FATT
  68: ['J', 'K', 'L', 'M', 'N', 'O', 'P'], // BSPI
  // VILE: was ['R',...] missing DIE1='Q' — same shared pain/DIE1 letter quirk
  // as SKEL above (S_VILE_DIE1 reuses S_VILE_PAIN's frame Q).
  64: ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'], // VILE
  84: ['I', 'J', 'K', 'L', 'M'], // SSWV
};

/**
 * Gib (XDeath) sprite frame letters — the back portion of the same
 * rotation-0 tail `MONSTER_DEATH_FRAMES` takes its front portion from, also
 * confirmed against the real WAD lump names. Only five monster types in
 * stock DOOM actually have one at all: the human grunts (zombieman, shotgun
 * guy, chaingunner, Wolfenstein SS) and the imp — every other monster,
 * including ones that are otherwise similarly sized (the demon, for
 * instance), simply has no `xdeathstate` in vanilla's own `mobjinfo` and
 * always plays its plain death. `ThingLayer.damage` picks between this and
 * `MONSTER_DEATH_FRAMES` the same way vanilla's `P_KillMobj` does: gib only
 * if overkill damage pushed health below *minus* the monster's own max
 * health (`MONSTER_HEALTH`), and only if an entry exists here at all.
 */
export const MONSTER_XDEATH_FRAMES: Record<number, string[]> = {
  3004: ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // POSS
  9: ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // SPOS
  3001: ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'], // TROO
  // CPOS: was ['M',...] wrongly overlapping MONSTER_DEATH_FRAMES' own 'M'/'N'
  // — with the DEATH table above now correctly running through 'N', XDEATH
  // starts right after it at 'O', not two letters early.
  65: ['O', 'P', 'Q', 'R', 'S', 'T'], // CPOS
  84: ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'], // SSWV
};

/**
 * Flat per-frame duration for a monster's death animation, regular or gib
 * alike. Vanilla's actual death/xdeath states each hold for their own tic
 * count rather than one uniform rate; collapsing that to a single constant
 * is the same simplification player.ts's GRAVITY and weapons.ts's fire rates
 * already make for anything that doesn't survive a dt-scaled model cleanly.
 */
export const MONSTER_DEATH_FRAME_SECONDS = 6 / 35;

/**
 * Attack sprite frame letters, one entry per doomednum — unlike the death
 * tables above, these aren't structurally derivable from the WAD (attack
 * frames sit among ordinary rotation 1-8 art, indistinguishable by structure
 * from walk frames the way the rotation-0-only death tail is), so guessing
 * them risked silently wrong art, which is why `game/things.ts`'s
 * `MONSTER_WALK_FRAMES` doc long treated attack/pain as out of scope. This
 * table is instead lifted directly from vanilla's own `info.c` `missilestate`
 * chains (`linuxdoom-1.10/info.c`, `S_*_ATK*`) and cross-checked letter-by-
 * letter against the real DOOM.WAD/DOOM2.WAD sprite lumps via
 * `SpriteBank` — every monster's total frame-letter count (walk + attack +
 * pain + death \[+ xdeath\]) matches its WAD-confirmed rotation-1..8 letter
 * range exactly, the same discipline `MONSTER_DEATH_FRAMES` already holds
 * itself to (and the cross-check is what surfaced the four death-table bugs
 * fixed above). Only the letters distinct from the monster's own walk cycle
 * and from each other are kept — vanilla repeats some attack frames
 * mid-sequence (e.g. POSS's `E,F,E`) purely to hold a pose longer, which
 * would be a no-op here since `SpriteAnimator.playOnce` already holds each
 * frame for a flat duration. `SPID`/`BSPI`'s own first attack frame
 * (`A_FaceTarget`) reuses their idle letter `A` outright and is dropped
 * entirely for the same reason. `SKEL`'s five letters cover both of its
 * distinct attack kinds (melee fist `G,H,I` and missile `J,K`) as one
 * sequence — vanilla itself has no separate "which attack is this" signal
 * available to key off of at the sprite layer, only the monster's own AI
 * decision (`game/monsters.ts`) knows that, and by the time a `MonsterAttack`
 * comes back out of it the sprite pose is just "attacking".
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
};

/**
 * Flat per-frame duration for both tables above — the same "one uniform rate
 * instead of vanilla's own per-state tic count" simplification
 * `MONSTER_DEATH_FRAME_SECONDS` already makes, just faster: vanilla's attack/
 * pain states mostly hold 3-10 tics (vs. death's 5-8), and a flinch or a
 * punch/muzzle-flash reads as snappier than a death collapse regardless.
 */
export const MONSTER_ACTION_FRAME_SECONDS = 3 / 35;

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
