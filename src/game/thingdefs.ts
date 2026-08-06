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
 * Commander Keen and the boss brain are deliberately absent (no DIE state and
 * no death art respectively) — `ThingLayer.damage` just hides them.
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
export const MONSTER_DEATH_FRAME_SECONDS = 6 / 35;

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
