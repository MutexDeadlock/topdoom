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
