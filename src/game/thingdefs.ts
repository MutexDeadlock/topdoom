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
 * click-to-target, wired up in main.ts) is willing to snap a shot onto. There's
 * still no monster AI (see CLAUDE.md's "Current state"), so these things never
 * move or fight back; this only decides what counts as a valid click-target,
 * not anything about combat itself.
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
  3006: ['G', 'H', 'I', 'J', 'K'], // SKUL
  3005: ['G', 'H', 'I', 'J', 'K', 'L'], // HEAD
  3003: ['I', 'J', 'K', 'L', 'M', 'N', 'O'], // BOSS
  69: ['I', 'J', 'K', 'L', 'M', 'N', 'O'], // BOS2
  7: ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S'], // SPID
  16: ['H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'], // CYBR
  71: ['H', 'I', 'J', 'K', 'L', 'M'], // PAIN
  65: ['H', 'I', 'J', 'K', 'L'], // CPOS
  66: ['M', 'N', 'O', 'P', 'Q'], // SKEL
  67: ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'], // FATT
  68: ['J', 'K', 'L', 'M', 'N', 'O', 'P'], // BSPI
  64: ['R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'], // VILE
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
  65: ['M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'], // CPOS
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
