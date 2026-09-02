/**
 * The bridges between a DEHACKED patch's array indices and this engine's own keys, plus the
 * classifiers that decide how far each record and field gets. Kept beside the appliers so
 * `scripts/inspect-wad.ts`'s coverage report can't drift out of step with what actually lands —
 * the arrangement `classifyLineSpecial` has with the specials table. See docs/dehacked.md.
 */
import { SFX_NAMES, type SfxId } from '../../audio/sfx.ts';
import type { DamageCause } from '../combat.ts';
import type { AmmoType, InventoryLimits, WeaponId } from '../inventory.ts';
import { ThingType } from '../things/doomednums.ts';
import type {
  DehFrameEdit, DehRecordKind, DehShortfall, DehSupport, StatePointer, WeaponStatePointer,
} from './defs.ts';
import { fireChainStates, isFlashState, isPspriteState, STATES, WEAPON_STATES } from './states.ts';

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

/**
 * Which monster owns each of `p_enemy.c`'s attack actions — the bridge a repointed attack chain
 * reads its *identity* through. The walker says which action a chain now fires; this says whose
 * roll, projectile and splash that action is, and the applier copies that type's own `AttackStats`
 * onto the repointed chain (docs/dehacked.md § Action pointers).
 *
 * A bridge rather than a second table of rolls: every one of those figures is already written once
 * in `MONSTER_SEED` with its `p_enemy.c` citation, and a copy here would be exactly the drift the
 * one-home rule exists to prevent. It is the reasoning `MISSILE_SINKS` rests on — in vanilla the
 * imp's fireball *is* one shared `mobjinfo`, so the owning type's own numbers are the faithful
 * answer rather than an approximation.
 *
 * `A_BrainSpit` has no row on purpose: the Icon of Sin's cube is not an `AttackStats` at all, and
 * carries its own constants in `monsters/iconofsin.ts`.
 */
export const ATTACK_ACTION_SOURCES: Record<string, number> = {
  A_PosAttack: ThingType.zombieman,
  A_SPosAttack: ThingType.shotgunGuy,
  A_CPosAttack: ThingType.heavyWeaponDude,
  A_TroopAttack: ThingType.imp,
  A_SargAttack: ThingType.demon,
  A_HeadAttack: ThingType.cacodemon,
  A_BruisAttack: ThingType.baronOfHell,
  A_SkullAttack: ThingType.lostSoul,
  A_PainAttack: ThingType.painElemental,
  A_SkelFist: ThingType.revenant,
  A_SkelMissile: ThingType.revenant,
  A_FatAttack1: ThingType.mancubus,
  A_FatAttack2: ThingType.mancubus,
  A_FatAttack3: ThingType.mancubus,
  A_BspiAttack: ThingType.arachnotron,
  A_CyberAttack: ThingType.cyberdemon,
  A_VileAttack: ThingType.archVile,
};

/**
 * Which weapon owns each of `p_pspr.c`'s nine firing actions — `ATTACK_ACTION_SOURCES` for the
 * player's side, and read the same way. The walker says which action a repointed fire chain now
 * carries; this says whose roll, spread, ammo cost and projectile that action is, and the applier
 * copies that weapon's own `WeaponDef` onto the repointed one (docs/dehacked.md § Action pointers).
 *
 * Every one of the nine is here and the mapping is 1:1 — vanilla writes one action per weapon, and
 * the two chains that carry two firing actions (`S_SAW1`/`S_SAW2`, `S_CHAIN1`/`S_CHAIN2`) repeat
 * their own.
 */
export const WEAPON_ACTION_SOURCES: Record<string, WeaponId> = {
  A_Punch: 'fist',
  A_Saw: 'chainsaw',
  A_FirePistol: 'pistol',
  A_FireShotgun: 'shotgun',
  A_FireShotgun2: 'supershotgun',
  A_FireCGun: 'chaingun',
  A_FireMissile: 'rocketLauncher',
  A_FirePlasma: 'plasmaRifle',
  A_FireBFG: 'bfg',
};

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
 * Which `mobjinfo` state pointer each `Thing` frame line repoints — `d_deh.c`'s own spellings onto
 * `MOBJ_STATES`' field names. The applier walks the repointed chain to re-derive the type's letter
 * lists; docs/dehacked.md § Frames.
 */
export const THING_STATE_FIELDS: Record<string, StatePointer> = {
  'initial frame': 'spawn',
  'first moving frame': 'see',
  'injury frame': 'pain',
  'close attack frame': 'melee',
  'far attack frame': 'missile',
  'death frame': 'death',
  'exploding frame': 'xdeath',
  'respawn frame': 'raise',
};

/**
 * `d_deh.c`'s `deh_mobjinfo[]` field names, spelled exactly as a patch writes them, mapped to how
 * far each gets here. Matched case-insensitively, as `deh_strcasecmp` does.
 *
 * `Reaction time` has no per-type home: `monsters/ai.ts` seeds one shared `REACTION_CHASES`, and
 * vanilla's own value is 8 for every monster. `Dropped item`, `Blood color` and `Bits2` are
 * MBF21's, not read yet. `ID #` is permanently out — docs/dehacked.md § What is not supported.
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
  ...appliedRows(THING_STATE_FIELDS),

  'id #': 'unsupported',
  'reaction time': 'unsupported',
  bits2: 'unsupported',
  'dropped item': 'unsupported',
  'blood color': 'unsupported',
};

/**
 * `d_deh.c`'s `deh_state[]`: which `DehFrameEdit` field each `Frame` line lands in. `Unknown 1`/
 * `Unknown 2` are `state_t.misc1`/`misc2`, which vanilla's own actions never read, so they classify
 * `noTarget` below rather than being carried.
 */
export const FRAME_FIELD_SINKS: Record<string, Exclude<keyof DehFrameEdit, 'index' | 'args'>> = {
  'sprite number': 'spriteNum',
  'sprite subnumber': 'subNumber',
  duration: 'duration',
  'next frame': 'nextFrame',
};

/**
 * `state_t`'s two general-purpose fields onto their slot in `DehFrameEdit.args`. Vanilla leaves
 * both zero everywhere and reads neither; MBF's own pointers are what give them a meaning
 * (`A_Spawn`'s type and z, `A_PlaySound`'s sound, `A_Scratch`'s damage) — docs/dehacked.md
 * § Action pointers.
 */
export const FRAME_ARG_FIELDS: Record<string, number> = {
  'unknown 1': 0,
  'unknown 2': 1,
};

const FRAME_FIELDS: Record<string, DehSupport> = {
  ...appliedRows(FRAME_FIELD_SINKS),
  ...appliedRows(FRAME_ARG_FIELDS),
};

/**
 * Which `weaponinfo` state pointer each `Weapon` frame line repoints — `d_deh.c`'s own spellings
 * onto `WEAPON_STATES`' field names. Note the first two: `deh_weapon[]` labels `upstate` "Deselect
 * frame" and `downstate` "Select frame", the two the wrong way round, and the labels are what a
 * patch writes. Only a repointed `Shooting frame` changes anything here — it is the chain the fire
 * rate is walked from (docs/weapons.md § Fire rates); the other four are read so the record is
 * carried whole.
 */
export const WEAPON_STATE_FIELDS: Record<string, WeaponStatePointer> = {
  'deselect frame': 'up',
  'select frame': 'down',
  'bobbing frame': 'ready',
  'shooting frame': 'atk',
  'firing frame': 'flash',
};

/**
 * `d_deh.c`'s `deh_weapon[]` — an ammo type and five state pointers, and nothing else: vanilla's
 * `weaponinfo[]` carries no damage and no fire rate, because a weapon's rate *is* its fire chain's
 * durations. All six land. docs/dehacked.md § Weapon, Ammo and Misc.
 */
const WEAPON_FIELDS: Record<string, DehSupport> = {
  'ammo type': 'applied',
  ...appliedRows(WEAPON_STATE_FIELDS),
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
  // The two cheats this engine has: IDDQD's health and IDKFA's armor (docs/cheats.md).
  'god mode health': { limit: 'godModeHealth' },
  'idkfa armor': { limit: 'idkfaArmor' },
  'idkfa armor class': { limit: 'idkfaArmorClass' },
};

/**
 * `d_deh.c`'s `deh_misc[]`. The `IDFA` rows have no target because that cheat isn't implemented
 * here (the three that are reach their own rows in `MISC_SINKS` above), and `Monsters Infight` none
 * because infighting here is not a single global switch (docs/monster-ai.md § Infighting).
 */
const MISC_FIELDS: Record<string, DehSupport> = {
  ...appliedRows(MISC_SINKS),

  'idfa armor': 'noTarget',
  'idfa armor class': 'noTarget',
  'monsters infight': 'noTarget',
};

/**
 * `OB_*` obituary mnemonics and the `DamageCause` whose whole line each one replaces
 * (`things/tables.ts`'s `OBITUARIES`, `game/combat.ts`'s `DamageCause`). `'default'` is not a
 * cause but the fallback line an unattributed death draws.
 *
 * Neither reference set is vanilla — DOOM has no obituaries — and the two disagree about scope, so
 * both are accepted: Eternity's BEX string table defines only the attacker-less causes, ZDoom's
 * `LANGUAGE` adds the per-monster ones. Where the two name one sink twice the aliases sit on
 * separate rows and the later row here wins — a patch setting both meant the same thing by them.
 * docs/dehacked.md § Obituaries.
 */
export const OBITUARY_SINKS: Record<string, DamageCause | 'default'> = {
  OB_CRUSH: 'crush',
  OB_SLIME: 'slime',
  OB_BARREL: ThingType.barrel,
  OB_ROCKET_SELF: 'self', // Eternity's BEX name for the player's own splash
  OB_R_SPLASH: 'self', // ZDoom's
  OB_DEFAULT: 'default',

  OB_ZOMBIE: ThingType.zombieman,
  OB_SHOTGUY: ThingType.shotgunGuy,
  OB_VILE: ThingType.archVile,
  OB_UNDEAD: ThingType.revenant,
  OB_FATSO: ThingType.mancubus,
  OB_CHAINGUY: ThingType.heavyWeaponDude,
  OB_SKULL: ThingType.lostSoul,
  OB_IMP: ThingType.imp,
  OB_CACO: ThingType.cacodemon,
  OB_BARON: ThingType.baronOfHell,
  OB_KNIGHT: ThingType.hellKnight,
  OB_SPIDER: ThingType.spiderMastermind,
  OB_BABY: ThingType.arachnotron,
  OB_CYBORG: ThingType.cyberdemon,
  OB_WOLFSS: ThingType.wolfensteinSS,
  // The demon and the spectre never attack at range, so ZDoom gives them no ranged mnemonic and
  // the `*HIT` form is the type's only obituary. Every other `*HIT` stays `noTarget`: a
  // `DamageCause` is the doomednum alone and does not carry which of the type's attacks landed,
  // so a melee-only line for a type that also has a ranged one has nowhere separate to go.
  OB_DEMONHIT: ThingType.demon,
  OB_SPECTREHIT: ThingType.spectre,
};

/**
 * The `PD_*` mnemonics this engine has a line for — `specials/tables.ts`'s `LOCKED_LINES`, the
 * fifteen `d_englsh.h` strings vanilla and Boom define between them.
 *
 * Spelled out here rather than read off that table because this module is on the **read** side:
 * `wad/library.ts` and the manifest plugin classify a patch without a `Game`, and importing the
 * specials tables to do it would pull the game layer into the menu's graph
 * (docs/dehacked.md § The two entry points). `tests/game/dehacked-apply.test.ts` cross-checks the
 * two lists, which is what keeps the duplication honest.
 */
const LOCK_LINE_MNEMONICS: readonly string[] = [
  'PD_BLUEO', 'PD_REDO', 'PD_YELLOWO',
  'PD_BLUEK', 'PD_REDK', 'PD_YELLOWK',
  'PD_BLUEC', 'PD_REDC', 'PD_YELLOWC',
  'PD_BLUES', 'PD_REDS', 'PD_YELLOWS',
  'PD_ANY', 'PD_ALL3', 'PD_ALL6',
];

/**
 * The `STSTR_*` mnemonics this engine has a response for — `game/cheats.ts`'s `CHEAT_MESSAGES`,
 * the five `d_englsh.h` strings the three implemented cheats print. Spelled out here rather than
 * imported for the same read-side reason `LOCK_LINE_MNEMONICS` is, and cross-checked by the same
 * test.
 */
const CHEAT_MESSAGE_MNEMONICS: readonly string[] = [
  'STSTR_DQDON', 'STSTR_DQDOFF',
  'STSTR_KFAADDED',
  'STSTR_NCON', 'STSTR_NCOFF',
];

/**
 * BEX `[STRINGS]` mnemonic prefixes and what this engine can do with them. Checked longest-prefix
 * first, so `HUSTR_E1M1` and `HUSTR_1` both land on the level-title row while `HUSTR_PLRRED`
 * doesn't. Anything unlisted is `unknown`.
 *
 * **A `noTarget` row here is this table's whole purpose**: it is what marks a mnemonic as
 * recognised-and-deliberately-homeless, so the parser can pass over it in silence and report only
 * what it failed to recognise. The `OB_*` and `PD_*` rows catch the mnemonics with no sink; the
 * ones that have one are whole keys in `STRING_KEYS` below.
 */
const STRING_PREFIXES: readonly (readonly [string, DehSupport])[] = [
  ['HUSTR_PLR', 'noTarget'], // multiplayer player names
  ['HUSTR_', 'applied'], // level titles, and the two mission-specific sets below
  ['PHUSTR_', 'applied'],
  ['THUSTR_', 'applied'],
  ['GOT', 'noTarget'], // pickup messages
  ['PD_', 'noTarget'], // locked-door lines with no lock rule here
  ['OB_', 'noTarget'], // obituaries with no killer here to name
  ['CC_', 'noTarget'], // cast-call names
  ['TAG_', 'noTarget'], // weapon names
  ['STSTR_', 'noTarget'], // the cheat responses with no cheat here; the five that have one are whole keys below
  ['AMSTR_', 'noTarget'], // automap messages
  ['BGFLAT', 'noTarget'], // intermission backgrounds
  ['QUITMSG', 'noTarget'], // quit messages
  ['STARTUP', 'noTarget'], // startup banner
  ['SKILL_', 'noTarget'], // skill names
  ['TXT_', 'noTarget'], // episode text
];

/** Whole-mnemonic `[STRINGS]` keys that no prefix covers, or that a prefix would classify wrong. */
const STRING_KEYS: Record<string, DehSupport> = {
  // Every mnemonic with a sink, so the `OB_`/`PD_` prefix rows are left holding exactly the rest.
  ...Object.fromEntries(Object.keys(OBITUARY_SINKS).map((key) => [key, 'applied'])),
  ...Object.fromEntries(LOCK_LINE_MNEMONICS.map((key) => [key, 'applied'])),
  ...Object.fromEntries(CHEAT_MESSAGE_MNEMONICS.map((key) => [key, 'applied'])),

  NIGHTMARE: 'noTarget', // a skill name
  DOSY: 'noTarget', // a quit message
  // The finale text, `E1TEXT`-`C6TEXT`: no finale screen here to crawl it over.
  E1TEXT: 'noTarget',
  E2TEXT: 'noTarget',
  E3TEXT: 'noTarget',
  E4TEXT: 'noTarget',
  C1TEXT: 'noTarget',
  C2TEXT: 'noTarget',
  C3TEXT: 'noTarget',
  C4TEXT: 'noTarget',
  C5TEXT: 'noTarget',
  C6TEXT: 'noTarget',
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
  frame: { kind: 'frame', support: 'applied' },
  pointer: { kind: 'pointer', support: 'applied' },
  // The numeric record moves a pointer into the exe's own string table, like `Sound N`; only the
  // BEX section names a sprite this engine can redirect.
  sprite: { kind: 'sprite', support: 'noTarget' },
  cheat: { kind: 'cheat', support: 'noTarget' },
  '[strings]': { kind: 'strings', support: 'applied' },
  '[pars]': { kind: 'pars', support: 'applied' },
  '[codeptr]': { kind: 'codeptr', support: 'applied' },
  '[helper]': { kind: 'helper', support: 'unsupported' },
  '[sprites]': { kind: 'sprite', support: 'applied' },
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
    case 'frame':
      return FRAME_FIELDS[key] ?? 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * How far one `Frame N` record gets, by which state it names. A world state applies, and so does a
 * **fire-chain** state: its tics *are* this engine's fire rate, walked back out of the chain
 * (docs/weapons.md § Fire rates). Every other first-person state is `noTarget` — a muzzle flash
 * because there is no weapon here to flash, and a bob, raise or lower state because this engine
 * draws no weapon sprite to animate. docs/dehacked.md § Frames.
 *
 * `stateCount` is the table the patch is growing (docs/dehacked.md § Extended states), which is
 * what an index is held against rather than `STATES.length`: a record naming a row past the end is
 * what grows it, and only one past the growth limit names nothing.
 */
export function classifyDehackedFrame(index: number, stateCount: number = STATES.length): DehSupport {
  if (!Number.isInteger(index) || index < 0 || index >= stateCount) return 'unknown';
  if (isFlashState(index)) return 'noTarget';
  if (isPspriteState(index)) return FIRE_CHAIN_STATES.has(index) ? 'applied' : 'noTarget';
  return 'applied';
}

/**
 * Every state vanilla's nine fire chains occupy. A `Frame` on one of these retunes a fire rate; a
 * psprite state outside them is a weapon's bob, raise or lower, which this engine has nothing to
 * draw and no clock to hold.
 *
 * Read off **pristine** `WEAPON_STATES`: a patch's own `Shooting frame` repoint is applied after
 * the parse, and vanilla's chains are what a patch writes its `Frame` records against anyway.
 */
const FIRE_CHAIN_STATES: ReadonlySet<number> = new Set(
  WEAPON_STATES.flatMap((w) => fireChainStates(STATES, w.atk)),
);

/** How far one `Bits` mnemonic gets, and whether it is worth reporting at all. */
export function classifyDehackedFlag(mnemonic: string): FlagRow | undefined {
  return MF_FLAGS[mnemonic.trim().toUpperCase().replace(/^MF_/, '')];
}

/**
 * How far one `[STRINGS]` mnemonic gets.
 *
 * **A `noTarget` here is reported nowhere** — `parse.ts` passes over it silently. The tables above
 * are the standing list of what this engine deliberately has no home for, and a report row per
 * family only ever repeated that: no cast call, no automap, no deathmatch. `unknown` is the one
 * shortfall worth a reader's attention, because it means the parser did not recognise the mnemonic
 * at all. docs/dehacked.md § The coverage report.
 */
export function classifyDehackedString(key: string): DehSupport {
  const upper = key.trim().toUpperCase();
  const whole = STRING_KEYS[upper];
  if (whole) return whole;
  for (const [prefix, support] of STRING_PREFIXES) {
    if (upper.startsWith(prefix)) return support;
  }
  return 'unknown';
}
