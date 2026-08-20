/**
 * The bridges between a DEHACKED patch's array indices and this engine's own keys, plus the
 * classifiers that decide how far each record and field gets. Kept beside the appliers so
 * `scripts/inspect-wad.ts`'s coverage report can't drift out of step with what actually lands —
 * the arrangement `classifyLineSpecial` has with the specials table. See docs/dehacked.md.
 */
import { DOOM1_MUSIC, DOOM2_MUSIC } from '../../audio/music/tables.ts';
import { SFX_NAMES, type SfxId } from '../../audio/sfx.ts';
import type { AmmoType, InventoryLimits, WeaponId } from '../inventory.ts';
import type { DehRecordKind, DehShortfall, DehSupport } from './defs.ts';

/** One row of `linuxdoom-1.10/info.c`'s `mobjinfo[]`, in `info.h`'s `mobjtype_t` order. */
export interface MobjRow {
  /** The `mobjtype_t` name, for reports and for keying `MISSILE_SINKS`. */
  type: string;
  /**
   * `mobjinfo.doomednum` — the key every type-keyed table here uses — or -1 for a type no map can
   * place (projectiles, puffs, fog, gibs).
   */
  doomednum: number;
  /**
   * `mobjinfo.speed` exactly as `info.c` writes it: map units per `A_Chase` for a walker, 16.16
   * fixed point for an `MF_MISSILE`. Zero for anything that doesn't move.
   */
  speed: number;
  /** Whether `info.c` gives this type `MF_MISSILE`, which decides how a patched `Speed` is read —
      docs/dehacked.md § Units. */
  missile?: boolean;
}

/**
 * All 137 of `mobjinfo[]`, transcribed mechanically from `linuxdoom-1.10/info.c` rather than by
 * hand. DEH addresses a thing by its **1-based** index here: `Thing 97` is `MOBJ_INFO[96]`.
 *
 * This is the checkable data twin of the `// MT_*` comments in `things/doomednums.ts` — those name
 * the pairing in prose, this makes it something a test can cross-check, and does.
 */
export const MOBJ_INFO: readonly MobjRow[] = [
  { type: 'MT_PLAYER', doomednum: -1, speed: 0 }, // 1
  { type: 'MT_POSSESSED', doomednum: 3004, speed: 8 }, // 2
  { type: 'MT_SHOTGUY', doomednum: 9, speed: 8 }, // 3
  { type: 'MT_VILE', doomednum: 64, speed: 15 }, // 4
  { type: 'MT_FIRE', doomednum: -1, speed: 0 }, // 5
  { type: 'MT_UNDEAD', doomednum: 66, speed: 10 }, // 6
  { type: 'MT_TRACER', doomednum: -1, speed: 655360, missile: true }, // 7
  { type: 'MT_SMOKE', doomednum: -1, speed: 0 }, // 8
  { type: 'MT_FATSO', doomednum: 67, speed: 8 }, // 9
  { type: 'MT_FATSHOT', doomednum: -1, speed: 1310720, missile: true }, // 10
  { type: 'MT_CHAINGUY', doomednum: 65, speed: 8 }, // 11
  { type: 'MT_TROOP', doomednum: 3001, speed: 8 }, // 12
  { type: 'MT_SERGEANT', doomednum: 3002, speed: 10 }, // 13
  { type: 'MT_SHADOWS', doomednum: 58, speed: 10 }, // 14
  { type: 'MT_HEAD', doomednum: 3005, speed: 8 }, // 15
  { type: 'MT_BRUISER', doomednum: 3003, speed: 8 }, // 16
  { type: 'MT_BRUISERSHOT', doomednum: -1, speed: 983040, missile: true }, // 17
  { type: 'MT_KNIGHT', doomednum: 69, speed: 8 }, // 18
  { type: 'MT_SKULL', doomednum: 3006, speed: 8 }, // 19
  { type: 'MT_SPIDER', doomednum: 7, speed: 12 }, // 20
  { type: 'MT_BABY', doomednum: 68, speed: 12 }, // 21
  { type: 'MT_CYBORG', doomednum: 16, speed: 16 }, // 22
  { type: 'MT_PAIN', doomednum: 71, speed: 8 }, // 23
  { type: 'MT_WOLFSS', doomednum: 84, speed: 8 }, // 24
  { type: 'MT_KEEN', doomednum: 72, speed: 0 }, // 25
  { type: 'MT_BOSSBRAIN', doomednum: 88, speed: 0 }, // 26
  { type: 'MT_BOSSSPIT', doomednum: 89, speed: 0 }, // 27
  { type: 'MT_BOSSTARGET', doomednum: 87, speed: 0 }, // 28
  { type: 'MT_SPAWNSHOT', doomednum: -1, speed: 655360, missile: true }, // 29
  { type: 'MT_SPAWNFIRE', doomednum: -1, speed: 0 }, // 30
  { type: 'MT_BARREL', doomednum: 2035, speed: 0 }, // 31
  { type: 'MT_TROOPSHOT', doomednum: -1, speed: 655360, missile: true }, // 32
  { type: 'MT_HEADSHOT', doomednum: -1, speed: 655360, missile: true }, // 33
  { type: 'MT_ROCKET', doomednum: -1, speed: 1310720, missile: true }, // 34
  { type: 'MT_PLASMA', doomednum: -1, speed: 1638400, missile: true }, // 35
  { type: 'MT_BFG', doomednum: -1, speed: 1638400, missile: true }, // 36
  { type: 'MT_ARACHPLAZ', doomednum: -1, speed: 1638400, missile: true }, // 37
  { type: 'MT_PUFF', doomednum: -1, speed: 0 }, // 38
  { type: 'MT_BLOOD', doomednum: -1, speed: 0 }, // 39
  { type: 'MT_TFOG', doomednum: -1, speed: 0 }, // 40
  { type: 'MT_IFOG', doomednum: -1, speed: 0 }, // 41
  { type: 'MT_TELEPORTMAN', doomednum: 14, speed: 0 }, // 42
  { type: 'MT_EXTRABFG', doomednum: -1, speed: 0 }, // 43
  { type: 'MT_MISC0', doomednum: 2018, speed: 0 }, // 44
  { type: 'MT_MISC1', doomednum: 2019, speed: 0 }, // 45
  { type: 'MT_MISC2', doomednum: 2014, speed: 0 }, // 46
  { type: 'MT_MISC3', doomednum: 2015, speed: 0 }, // 47
  { type: 'MT_MISC4', doomednum: 5, speed: 0 }, // 48
  { type: 'MT_MISC5', doomednum: 13, speed: 0 }, // 49
  { type: 'MT_MISC6', doomednum: 6, speed: 0 }, // 50
  { type: 'MT_MISC7', doomednum: 39, speed: 0 }, // 51
  { type: 'MT_MISC8', doomednum: 38, speed: 0 }, // 52
  { type: 'MT_MISC9', doomednum: 40, speed: 0 }, // 53
  { type: 'MT_MISC10', doomednum: 2011, speed: 0 }, // 54
  { type: 'MT_MISC11', doomednum: 2012, speed: 0 }, // 55
  { type: 'MT_MISC12', doomednum: 2013, speed: 0 }, // 56
  { type: 'MT_INV', doomednum: 2022, speed: 0 }, // 57
  { type: 'MT_MISC13', doomednum: 2023, speed: 0 }, // 58
  { type: 'MT_INS', doomednum: 2024, speed: 0 }, // 59
  { type: 'MT_MISC14', doomednum: 2025, speed: 0 }, // 60
  { type: 'MT_MISC15', doomednum: 2026, speed: 0 }, // 61
  { type: 'MT_MISC16', doomednum: 2045, speed: 0 }, // 62
  { type: 'MT_MEGA', doomednum: 83, speed: 0 }, // 63
  { type: 'MT_CLIP', doomednum: 2007, speed: 0 }, // 64
  { type: 'MT_MISC17', doomednum: 2048, speed: 0 }, // 65
  { type: 'MT_MISC18', doomednum: 2010, speed: 0 }, // 66
  { type: 'MT_MISC19', doomednum: 2046, speed: 0 }, // 67
  { type: 'MT_MISC20', doomednum: 2047, speed: 0 }, // 68
  { type: 'MT_MISC21', doomednum: 17, speed: 0 }, // 69
  { type: 'MT_MISC22', doomednum: 2008, speed: 0 }, // 70
  { type: 'MT_MISC23', doomednum: 2049, speed: 0 }, // 71
  { type: 'MT_MISC24', doomednum: 8, speed: 0 }, // 72
  { type: 'MT_MISC25', doomednum: 2006, speed: 0 }, // 73
  { type: 'MT_CHAINGUN', doomednum: 2002, speed: 0 }, // 74
  { type: 'MT_MISC26', doomednum: 2005, speed: 0 }, // 75
  { type: 'MT_MISC27', doomednum: 2003, speed: 0 }, // 76
  { type: 'MT_MISC28', doomednum: 2004, speed: 0 }, // 77
  { type: 'MT_SHOTGUN', doomednum: 2001, speed: 0 }, // 78
  { type: 'MT_SUPERSHOTGUN', doomednum: 82, speed: 0 }, // 79
  { type: 'MT_MISC29', doomednum: 85, speed: 0 }, // 80
  { type: 'MT_MISC30', doomednum: 86, speed: 0 }, // 81
  { type: 'MT_MISC31', doomednum: 2028, speed: 0 }, // 82
  { type: 'MT_MISC32', doomednum: 30, speed: 0 }, // 83
  { type: 'MT_MISC33', doomednum: 31, speed: 0 }, // 84
  { type: 'MT_MISC34', doomednum: 32, speed: 0 }, // 85
  { type: 'MT_MISC35', doomednum: 33, speed: 0 }, // 86
  { type: 'MT_MISC36', doomednum: 37, speed: 0 }, // 87
  { type: 'MT_MISC37', doomednum: 36, speed: 0 }, // 88
  { type: 'MT_MISC38', doomednum: 41, speed: 0 }, // 89
  { type: 'MT_MISC39', doomednum: 42, speed: 0 }, // 90
  { type: 'MT_MISC40', doomednum: 43, speed: 0 }, // 91
  { type: 'MT_MISC41', doomednum: 44, speed: 0 }, // 92
  { type: 'MT_MISC42', doomednum: 45, speed: 0 }, // 93
  { type: 'MT_MISC43', doomednum: 46, speed: 0 }, // 94
  { type: 'MT_MISC44', doomednum: 55, speed: 0 }, // 95
  { type: 'MT_MISC45', doomednum: 56, speed: 0 }, // 96
  { type: 'MT_MISC46', doomednum: 57, speed: 0 }, // 97
  { type: 'MT_MISC47', doomednum: 47, speed: 0 }, // 98
  { type: 'MT_MISC48', doomednum: 48, speed: 0 }, // 99
  { type: 'MT_MISC49', doomednum: 34, speed: 0 }, // 100
  { type: 'MT_MISC50', doomednum: 35, speed: 0 }, // 101
  { type: 'MT_MISC51', doomednum: 49, speed: 0 }, // 102
  { type: 'MT_MISC52', doomednum: 50, speed: 0 }, // 103
  { type: 'MT_MISC53', doomednum: 51, speed: 0 }, // 104
  { type: 'MT_MISC54', doomednum: 52, speed: 0 }, // 105
  { type: 'MT_MISC55', doomednum: 53, speed: 0 }, // 106
  { type: 'MT_MISC56', doomednum: 59, speed: 0 }, // 107
  { type: 'MT_MISC57', doomednum: 60, speed: 0 }, // 108
  { type: 'MT_MISC58', doomednum: 61, speed: 0 }, // 109
  { type: 'MT_MISC59', doomednum: 62, speed: 0 }, // 110
  { type: 'MT_MISC60', doomednum: 63, speed: 0 }, // 111
  { type: 'MT_MISC61', doomednum: 22, speed: 0 }, // 112
  { type: 'MT_MISC62', doomednum: 15, speed: 0 }, // 113
  { type: 'MT_MISC63', doomednum: 18, speed: 0 }, // 114
  { type: 'MT_MISC64', doomednum: 21, speed: 0 }, // 115
  { type: 'MT_MISC65', doomednum: 23, speed: 0 }, // 116
  { type: 'MT_MISC66', doomednum: 20, speed: 0 }, // 117
  { type: 'MT_MISC67', doomednum: 19, speed: 0 }, // 118
  { type: 'MT_MISC68', doomednum: 10, speed: 0 }, // 119
  { type: 'MT_MISC69', doomednum: 12, speed: 0 }, // 120
  { type: 'MT_MISC70', doomednum: 28, speed: 0 }, // 121
  { type: 'MT_MISC71', doomednum: 24, speed: 0 }, // 122
  { type: 'MT_MISC72', doomednum: 27, speed: 0 }, // 123
  { type: 'MT_MISC73', doomednum: 29, speed: 0 }, // 124
  { type: 'MT_MISC74', doomednum: 25, speed: 0 }, // 125
  { type: 'MT_MISC75', doomednum: 26, speed: 0 }, // 126
  { type: 'MT_MISC76', doomednum: 54, speed: 0 }, // 127
  { type: 'MT_MISC77', doomednum: 70, speed: 0 }, // 128
  { type: 'MT_MISC78', doomednum: 73, speed: 0 }, // 129
  { type: 'MT_MISC79', doomednum: 74, speed: 0 }, // 130
  { type: 'MT_MISC80', doomednum: 75, speed: 0 }, // 131
  { type: 'MT_MISC81', doomednum: 76, speed: 0 }, // 132
  { type: 'MT_MISC82', doomednum: 77, speed: 0 }, // 133
  { type: 'MT_MISC83', doomednum: 78, speed: 0 }, // 134
  { type: 'MT_MISC84', doomednum: 79, speed: 0 }, // 135
  { type: 'MT_MISC85', doomednum: 80, speed: 0 }, // 136
  { type: 'MT_MISC86', doomednum: 81, speed: 0 }, // 137
];

/**
 * Where a missile `mobjtype_t`'s patchable fields actually land. One vanilla `mobjinfo` can drive
 * several sinks at once — `MT_ROCKET` is the rocket launcher's missile, the cyberdemon's missile
 * and the flight radius `PROJECTILE_RADIUS` keys, and a `Speed` edit has to reach all of them —
 * so this is a record of optional sinks rather than a union.
 *
 * Keyed by flight sprite because that is what this engine keys a missile by
 * (`AttackStats.projectile.sprite`, `PROJECTILE_RADIUS`, `WeaponDef.projectileSprite`): in vanilla
 * the imp's fireball *is* one shared `mobjinfo`, so rewriting every stat block that names `BAL1`
 * is the faithful answer, not an approximation.
 *
 * `MT_SPAWNSHOT` is deliberately absent. The Icon of Sin's cube is not sprite-keyed — it carries
 * its own constants in `monsters/iconofsin.ts` — so it has no sink here and classifies `noTarget`.
 */
export const MISSILE_SINKS: Record<string, { sprite: string; weapons?: readonly WeaponId[] }> = {
  MT_TROOPSHOT: { sprite: 'BAL1' },
  MT_HEADSHOT: { sprite: 'BAL2' },
  MT_BRUISERSHOT: { sprite: 'BAL7' },
  MT_FATSHOT: { sprite: 'MANF' },
  MT_TRACER: { sprite: 'FATB' },
  MT_ARACHPLAZ: { sprite: 'APLS' },
  MT_ROCKET: { sprite: 'MISL', weapons: ['rocketLauncher'] },
  MT_PLASMA: { sprite: 'PLSS', weapons: ['plasmaRifle'] },
  MT_BFG: { sprite: 'BFS1', weapons: ['bfg'] },
};

/**
 * `weapontype_t` in `p_pspr.h` order, which is the order `d_items.c`'s `weaponinfo[]` is written
 * in and the order a DEH `Weapon N` record indexes, **0-based**.
 *
 * Not the same as `WEAPON_SLOTS` or `WEAPON_CYCLE`: the chainsaw and super shotgun come last here
 * because they were added after the original seven, not where the player reaches them.
 */
export const WEAPON_ORDER: readonly WeaponId[] = [
  'fist',
  'pistol',
  'shotgun',
  'chaingun',
  'rocketLauncher',
  'plasmaRifle',
  'bfg',
  'chainsaw',
  'supershotgun',
];

/**
 * `ammotype_t` in `doomdef.h` order, which a DEH `Ammo N` record indexes **0-based**. The trap
 * worth naming: slot 2 is cells and slot 3 is rockets, which is not the order the engine's own
 * `AmmoType` union happens to be written in.
 */
export const AMMO_ORDER: readonly AmmoType[] = ['bullets', 'shells', 'cells', 'rockets'];

/**
 * `sfxenum_t` order, which a DEH `Sound N` record indexes. Slot 0 is `sfx_None` and is `null`
 * rather than an `SfxId`: a patch that sets a sound field to 0 is asking for silence, and
 * `MonsterSounds`' fields are already optional, so that maps to deleting the field.
 *
 * **Derived, not transcribed a second time.** `audio/sfx.ts`'s `SFX` already *is* `S_sfx[]` in
 * `sounds.h` order — the whole table, in vanilla's own sequence — so restating those 108 names
 * here would only create a copy that could drift from the original. What that costs is a
 * dependency on `SFX`'s declaration order staying vanilla's, which is exactly what the pinned
 * indices in `tests/game/dehacked-tables.test.ts` exist to catch.
 */
export const SFX_ORDER: readonly (SfxId | null)[] = [null, ...SFX_NAMES];

/**
 * `musicenum_t` order, which a DEH `Music N` record indexes. Slot 0 is `mus_None`. Values are the
 * lump name minus its `D_` prefix, the form `i_sound.c`'s `sprintf(buf, "d_%s", …)` takes.
 *
 * Composed from `audio/music/tables.ts`' own `S_music[]` slices the way `SFX_ORDER` composes
 * `SFX_NAMES`, rather than transcribed a second time: the level tracks are the same 59 names, and
 * two copies would let one be corrected without the other. Only the non-level entries between and
 * after them — the intermission, title and finale tracks — are listed here.
 *
 * No reader yet: a numeric `Music N` record only moves a pointer into the exe's own string table,
 * so `RECORD_KINDS` classifies it `noTarget` outright and only BEX's `[MUSIC]` mnemonic form names
 * a lump this engine can resolve. Kept as the index bridge a `Music N` sink would need.
 * docs/dehacked.md § Sounds and music.
 */
export const MUSIC_ORDER: readonly (string | null)[] = [
  null,
  ...DOOM1_MUSIC,
  'inter', 'intro', 'bunny', 'victor', 'introa',
  ...DOOM2_MUSIC,
  'read_m', 'dm2ttl', 'dm2int',
];

/** One `mobjflag_t` bit and what this engine can do about it. */
interface FlagRow {
  /** The bit `p_mobj.h` gives it. */
  bit: number;
  support: DehSupport;
  /**
   * Whether a missing sink is the *right* answer and so not worth reporting: vanilla bookkeeping
   * this engine replaced outright, or per-actor runtime state that is never a type property.
   * These classify `noTarget` and are filtered out of the coverage report.
   */
  quiet?: boolean;
}

/**
 * `p_mobj.h`'s `mobjflag_t`, keyed by the mnemonic Boom's `deh_procThing` accepts (vanilla's names
 * without the `MF_`). A `Bits` line replaces the whole mask, so the applier walks every row here
 * and adds or removes its sink — docs/dehacked.md § Bits.
 *
 * `TRANSLATION` is the one entry that is not a single bit: `0xc000000` is a two-bit player-colour
 * field, which is why the completeness test checks powers of two everywhere else and exempts it.
 */
export const MF_FLAGS: Record<string, FlagRow> = {
  // Real sinks: the seven doomednum-keyed `Set`s in `things/tables.ts`, plus `MonsterStats.flies`.
  SOLID: { bit: 0x2, support: 'applied' },
  SHOOTABLE: { bit: 0x4, support: 'applied' },
  SPAWNCEILING: { bit: 0x100, support: 'applied' },
  NOGRAVITY: { bit: 0x200, support: 'applied' },
  FLOAT: { bit: 0x4000, support: 'applied' },
  SHADOW: { bit: 0x40000, support: 'applied' },
  COUNTKILL: { bit: 0x400000, support: 'applied' },
  COUNTITEM: { bit: 0x800000, support: 'applied' },
  // Not a sink of its own: it decides how this record's `Speed` is read (§ Units).
  MISSILE: { bit: 0x10000, support: 'applied' },

  // Vanilla's own spatial-index bookkeeping, which this engine's monster grid replaces.
  NOSECTOR: { bit: 0x8, support: 'noTarget', quiet: true },
  NOBLOCKMAP: { bit: 0x10, support: 'noTarget', quiet: true },
  // A per-*thing* map flag, never a type property — the WAD's own thing record carries it.
  AMBUSH: { bit: 0x20, support: 'noTarget', quiet: true },
  // Per-actor runtime state, zero in every `info.c` entry.
  JUSTHIT: { bit: 0x40, support: 'noTarget', quiet: true },
  JUSTATTACKED: { bit: 0x80, support: 'noTarget', quiet: true },
  DROPPED: { bit: 0x20000, support: 'noTarget', quiet: true },
  CORPSE: { bit: 0x100000, support: 'noTarget', quiet: true },
  INFLOAT: { bit: 0x200000, support: 'noTarget', quiet: true },
  SKULLFLY: { bit: 0x1000000, support: 'noTarget', quiet: true },
  // Deathmatch and player colour, neither of which exists in a single-player top-down game.
  NOTDMATCH: { bit: 0x2000000, support: 'noTarget', quiet: true },
  TRANSLATION: { bit: 0xc000000, support: 'noTarget', quiet: true },

  // Sinks that could exist and deliberately don't yet — these are worth reporting.
  SPECIAL: { bit: 0x1, support: 'unsupported' },
  DROPOFF: { bit: 0x400, support: 'unsupported' },
  PICKUP: { bit: 0x800, support: 'unsupported' },
  NOCLIP: { bit: 0x1000, support: 'unsupported' },
  SLIDE: { bit: 0x2000, support: 'unsupported' },
  TELEPORT: { bit: 0x8000, support: 'unsupported' },
  NOBLOOD: { bit: 0x80000, support: 'unsupported' },

  // Boom/MBF extensions, named so a report can say which one a patch wanted. Bits 28-31 of
  // MBF's `p_mobj.h` (killough 7/11/98, 7/18/98, 11/98; `MF_TRANSLUCENT` is Phares').
  TOUCHY: { bit: 0x10000000, support: 'unsupported' },
  BOUNCES: { bit: 0x20000000, support: 'unsupported' },
  FRIEND: { bit: 0x40000000, support: 'unsupported' },
  TRANSLUCENT: { bit: 0x80000000, support: 'unsupported' },
};

/**
 * Every flag a `Bits` mask asks for that this engine does not honour, for the coverage report.
 *
 * Raised from the mask rather than from the field name, which is the only place that knows what a
 * patch actually wanted: the `Bits` line itself always applies, so without this the individual
 * flags it silently drops would never be reported. `quiet` rows are skipped here, at the source —
 * for them a missing sink is the right answer. docs/dehacked.md § Bits.
 */
export function unhonoredFlags(mask: number): { name: string; support: DehShortfall }[] {
  const rows: { name: string; support: DehShortfall }[] = [];
  for (const [name, row] of Object.entries(MF_FLAGS)) {
    if (row.support === 'applied' || row.quiet || !(mask & row.bit)) continue;
    rows.push({ name, support: row.support });
  }
  return rows;
}

/** Which `MonsterSounds` field each `Thing` sound line names — `mobjinfo.seesound` and friends. */
export const THING_SOUND_FIELDS: Record<string, 'see' | 'attack' | 'pain' | 'death' | 'active'> = {
  'alert sound': 'see',
  'attack sound': 'attack',
  'pain sound': 'pain',
  'death sound': 'death',
  'action sound': 'active',
};

/**
 * Marks every key of a field-to-sink mapping `applied`. The classifier rows below are derived from
 * the mappings rather than listed beside them, because the two disagreeing fails silently in both
 * directions: a name only in the mapping is dropped as `unknown` before the applier sees it, and
 * one only in the classifier is written under its raw DEH spelling.
 */
function appliedRows(mapping: Record<string, unknown>): Record<string, DehSupport> {
  return Object.fromEntries(Object.keys(mapping).map((key) => [key, 'applied' as DehSupport]));
}

/**
 * `d_deh.c`'s `deh_mobjinfo[]` field names, spelled exactly as a patch writes them, mapped to how
 * far each gets here. Matched case-insensitively, as `deh_strcasecmp` does.
 *
 * The frame fields are the whole reason DEH support stops where it does: this engine has no
 * `states[]` array — a monster's animation is per-type letter lists in `things/tables.ts`, not a
 * state machine — so a patch that rebuilds a monster out of reassigned frames has nothing to
 * reassign. docs/dehacked.md § What is not supported.
 */
const THING_FIELDS: Record<string, DehSupport> = {
  'hit points': 'applied',
  'pain chance': 'applied',
  speed: 'applied',
  width: 'applied',
  height: 'applied',
  mass: 'applied',
  'missile damage': 'applied',
  bits: 'applied',

  ...appliedRows(THING_SOUND_FIELDS),

  'id #': 'unsupported',
  'initial frame': 'unsupported',
  'first moving frame': 'unsupported',
  'reaction time': 'unsupported',
  'injury frame': 'unsupported',
  'close attack frame': 'unsupported',
  'far attack frame': 'unsupported',
  'death frame': 'unsupported',
  'exploding frame': 'unsupported',
  'respawn frame': 'unsupported',
  bits2: 'unsupported',
  'dropped item': 'unsupported',
  'blood color': 'unsupported',
};

/**
 * `d_deh.c`'s `deh_weapon[]`. Vanilla's `weaponinfo[]` holds an ammo type and five state pointers
 * and nothing else — no damage, no fire rate — so `Ammo type` is the only line of a `Weapon`
 * record this engine has anywhere to put. A patch that retunes a weapon does it by editing the
 * frames' durations, which is out of scope. docs/dehacked.md § Weapon, Ammo and Misc.
 */
const WEAPON_FIELDS: Record<string, DehSupport> = {
  'ammo type': 'applied',
  'deselect frame': 'unsupported',
  'select frame': 'unsupported',
  'bobbing frame': 'unsupported',
  'shooting frame': 'unsupported',
  'firing frame': 'unsupported',
};

/** `d_deh.c`'s `deh_ammo[]`: vanilla's `maxammo[]` and `clipammo[]`. Both have a real sink. */
const AMMO_FIELDS: Record<string, DehSupport> = {
  'max ammo': 'applied',
  'per ammo': 'applied',
};

/**
 * Where one `Misc` line lands: an `InventoryLimits` field, or a field of one `WEAPONS` entry.
 * Typed rather than a bare string so the applier writes through a checked key and `MISC_FIELDS`
 * can be derived from it — "is it applied" and "where does it land" were two independent
 * statements before, and only one of them was ever checked.
 */
export type MiscSink =
  | { limit: keyof InventoryLimits }
  | { weapon: WeaponId; field: 'ammoPerShot' };

/**
 * `d_deh.c`'s `deh_misc[]` names and the sink each one has here. `Max Health` is vanilla's
 * `maxhealth`, the cap an ordinary medikit stops at; `Max Soulsphere` is `max_soul`, the higher one
 * the bonus items may push past it. `BFG Cells/Shot` is the one row that is not a limit at all —
 * vanilla's `deh_bfgcells` writes `weaponinfo[wp_bfg].ammopershot`.
 *
 * A name is in this table exactly when it has somewhere to go, which is what `MISC_FIELDS` reads
 * to classify it.
 */
export const MISC_SINKS: Record<string, MiscSink> = {
  'initial health': { limit: 'initialHealth' },
  'initial bullets': { limit: 'initialBullets' },
  'max health': { limit: 'maxHealth' },
  'max armor': { limit: 'maxArmor' },
  'green armor class': { limit: 'greenArmorClass' },
  'blue armor class': { limit: 'blueArmorClass' },
  'max soulsphere': { limit: 'maxHealthBonus' },
  'soulsphere health': { limit: 'soulsphereHealth' },
  'megasphere health': { limit: 'megasphereHealth' },
  'bfg cells/shot': { weapon: 'bfg', field: 'ammoPerShot' },
};

/**
 * `d_deh.c`'s `deh_misc[]`. The cheat-related rows have no target because this engine has no
 * cheats, and `Monsters Infight` none because infighting here is not a single global switch
 * (docs/monster-ai.md § Infighting).
 */
const MISC_FIELDS: Record<string, DehSupport> = {
  ...appliedRows(MISC_SINKS),

  'god mode health': 'noTarget',
  'idfa armor': 'noTarget',
  'idfa armor class': 'noTarget',
  'idkfa armor': 'noTarget',
  'idkfa armor class': 'noTarget',
  'monsters infight': 'noTarget',
};

/**
 * BEX `[STRINGS]` mnemonic prefixes and what this engine can do with them. Checked longest-prefix
 * first, so `HUSTR_E1M1` and `HUSTR_1` both land on the level-title row while `HUSTR_PLRRED`
 * doesn't. Anything unlisted is `unknown`.
 *
 * `PD_*` (the locked-door lines, `ui/hud/message.ts`) and `OB_*` (obituaries, `things/tables.ts`'s
 * `THING_NAMES`) are the two that genuinely have a sink and are still `noTarget`: both are split
 * into interpolated fragments here rather than held as whole format strings, so honoring them
 * means restructuring those first. They are the cheapest follow-ons — docs/dehacked.md § What is
 * not supported.
 */
const STRING_PREFIXES: readonly (readonly [string, DehSupport, string])[] = [
  ['HUSTR_PLR', 'noTarget', 'multiplayer player names'],
  ['HUSTR_', 'applied', 'level titles'],
  ['PHUSTR_', 'applied', 'level titles'],
  ['THUSTR_', 'applied', 'level titles'],
  ['GOT', 'noTarget', 'pickup messages'],
  ['PD_', 'noTarget', 'locked-door messages'],
  ['OB_', 'noTarget', 'obituaries'],
  ['CC_', 'noTarget', 'cast-call names'],
  ['TAG_', 'noTarget', 'weapon names'],
  ['STSTR_', 'noTarget', 'cheat responses'],
  ['AMSTR_', 'noTarget', 'automap messages'],
  ['BGFLAT', 'noTarget', 'intermission backgrounds'],
  ['QUITMSG', 'noTarget', 'quit messages'],
  ['STARTUP', 'noTarget', 'startup banner'],
  ['SKILL_', 'noTarget', 'skill names'],
  ['TXT_', 'noTarget', 'episode text'],
];

/** Whole-mnemonic `[STRINGS]` keys that no prefix covers, each with the group it reports under. */
const STRING_KEYS: Record<string, readonly [DehSupport, string]> = {
  NIGHTMARE: ['noTarget', 'skill names'],
  DOSY: ['noTarget', 'quit messages'],
  E1TEXT: ['noTarget', 'finale text'],
  E2TEXT: ['noTarget', 'finale text'],
  E3TEXT: ['noTarget', 'finale text'],
  E4TEXT: ['noTarget', 'finale text'],
  C1TEXT: ['noTarget', 'finale text'],
  C2TEXT: ['noTarget', 'finale text'],
  C3TEXT: ['noTarget', 'finale text'],
  C4TEXT: ['noTarget', 'finale text'],
  C5TEXT: ['noTarget', 'finale text'],
  C6TEXT: ['noTarget', 'finale text'],
};

/** Which record kinds are read at all, and how far a record of that kind gets on its own. */
const RECORD_KINDS: Record<string, { kind: DehRecordKind; support: DehSupport }> = {
  thing: { kind: 'thing', support: 'applied' },
  weapon: { kind: 'weapon', support: 'applied' },
  ammo: { kind: 'ammo', support: 'applied' },
  misc: { kind: 'misc', support: 'applied' },
  sound: { kind: 'sound', support: 'noTarget' },
  music: { kind: 'music', support: 'noTarget' },
  text: { kind: 'text', support: 'applied' },
  frame: { kind: 'frame', support: 'unsupported' },
  pointer: { kind: 'pointer', support: 'unsupported' },
  sprite: { kind: 'sprite', support: 'unsupported' },
  cheat: { kind: 'cheat', support: 'noTarget' },
  '[strings]': { kind: 'strings', support: 'applied' },
  '[pars]': { kind: 'pars', support: 'applied' },
  '[codeptr]': { kind: 'codeptr', support: 'unsupported' },
  '[helper]': { kind: 'helper', support: 'unsupported' },
  '[sprites]': { kind: 'sprite', support: 'unsupported' },
  '[sounds]': { kind: 'sound', support: 'applied' },
  '[music]': { kind: 'music', support: 'applied' },
};

/**
 * Which record a header line opens, and how far that kind gets. `header` covers the
 * `Doom version` / `Patch format` lines, which carry no edit of their own — a patch may repeat
 * them mid-file (EPIC.WAD does), and doing so must not be read as a new record.
 */
export function classifyDehackedRecord(word: string): { kind: DehRecordKind; support: DehSupport } {
  return RECORD_KINDS[word.toLowerCase()] ?? { kind: 'header', support: 'unknown' };
}

/**
 * How far one `key = value` line inside a record gets. `Thing` is the only kind whose answer
 * depends on the target as well as the field: `Speed` on a type with a real sink applies, while
 * the same line on a puff or a fog has nowhere to land at all.
 */
export function classifyDehackedField(kind: DehRecordKind, field: string, row?: MobjRow): DehSupport {
  const key = field.trim().toLowerCase();
  switch (kind) {
    case 'thing': {
      const support = THING_FIELDS[key];
      if (support === undefined) return 'unknown';
      if (support !== 'applied') return support;
      // A type no map can place and that isn't one of the sprite-keyed missiles has no table row
      // to write into, whatever the field says.
      const targeted = row !== undefined && (row.doomednum !== -1 || row.type in MISSILE_SINKS);
      return targeted ? 'applied' : 'noTarget';
    }
    case 'weapon':
      return WEAPON_FIELDS[key] ?? 'unknown';
    case 'ammo':
      return AMMO_FIELDS[key] ?? 'unknown';
    case 'misc':
      return MISC_FIELDS[key] ?? 'unknown';
    default:
      return 'unknown';
  }
}

/** How far one `Bits` mnemonic gets, and whether it is worth reporting at all. */
export function classifyDehackedFlag(mnemonic: string): FlagRow | undefined {
  return MF_FLAGS[mnemonic.trim().toUpperCase().replace(/^MF_/, '')];
}

/**
 * How far one `[STRINGS]` mnemonic gets, and which group it reports under. The group is what keeps
 * the report readable: freedoom2's DEHACKED sets 132 strings this engine has no home for, and
 * naming each one would bury the seven `Frame` records that actually matter under 132 rows.
 */
export function classifyDehackedString(key: string): { support: DehSupport; group: string } {
  const upper = key.trim().toUpperCase();
  const whole = STRING_KEYS[upper];
  if (whole) return { support: whole[0], group: whole[1] };
  for (const [prefix, support, group] of STRING_PREFIXES) {
    if (upper.startsWith(prefix)) return { support, group };
  }
  return { support: 'unknown', group: 'unrecognised' };
}
