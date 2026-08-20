/**
 * Writes a parsed patch into the engine's tables, and puts them back afterwards. The tables are
 * module-level constants every consumer imports directly, so a patch mutates them in place and a
 * pristine snapshot taken at import is what a reset restores from.
 * See docs/dehacked.md § Applying: reset, then patch.
 */
import {
  INERT_SHOOTABLE,
  MONSTER_STATS,
  rebuildDerivedMonsterStats,
} from '../monsters/tables.ts';
import {
  CEILING_HUNG_HEIGHT,
  COUNTITEM_TYPES,
  COUNTKILL_TYPES,
  FUZZ_TYPES,
  MONSTER_HEALTH,
  MONSTER_TYPES,
  SOLID_DECORATION_RADIUS_OVERRIDE,
  SOLID_DECORATION_TYPES,
} from '../things/tables.ts';
import { PROJECTILE_RADIUS } from '../spritefx/tables.ts';
import {
  resetInventoryLimits,
  setClipAmmo,
  setInventoryLimits,
  setMaxAmmo,
  type AmmoType,
  type InventoryLimits,
} from '../inventory.ts';
import { resetSoundLumps, setSoundLump, type SfxId } from '../../audio/sfx.ts';
import { resetMusicLumps, setMusicLump } from '../../audio/music/tables.ts';
import { WEAPONS } from '../weapons.ts';
import type { DehAmmoEdit, DehPatch, DehThingEdit } from './defs.ts';
import { AMMO_ORDER, MF_FLAGS, MISC_SINKS, MISSILE_SINKS, MOBJ_INFO, WEAPON_ORDER } from './tables.ts';

/**
 * The five flag `Set`s a `Bits` mask can add a doomednum to or remove it from — this engine has no
 * flags bitfield, so every `MF_*` with a sink is a membership edit somewhere. The one list both
 * `applyBits` and the pristine snapshot walk, so a `Set` can never be patched without being
 * restored.
 */
const FLAG_SETS: readonly (readonly [keyof typeof MF_FLAGS, Set<number>])[] = [
  ['COUNTKILL', COUNTKILL_TYPES],
  ['COUNTITEM', COUNTITEM_TYPES],
  ['SHOOTABLE', MONSTER_TYPES],
  ['SOLID', SOLID_DECORATION_TYPES],
  ['SHADOW', FUZZ_TYPES],
];

/**
 * Every patchable table as it reads with no patch applied, deep-cloned once at import — before any
 * `Game` exists, so it can only ever capture the vanilla values.
 *
 * `structuredClone` rather than a shallow copy because `MonsterStats` nests three levels deep
 * (`ranged.projectile.pairOffsetsRad` is an array of arrays, `sounds.walk.sounds` an array); a
 * shallow copy would hand a patched sub-object straight back on reset. `Set`s are kept as arrays
 * because `structuredClone` is not used on them.
 */
const PRISTINE = {
  monsterStats: structuredClone(MONSTER_STATS),
  inertShootable: structuredClone(INERT_SHOOTABLE),
  monsterHealth: { ...MONSTER_HEALTH },
  ceilingHung: { ...CEILING_HUNG_HEIGHT },
  solidRadius: { ...SOLID_DECORATION_RADIUS_OVERRIDE },
  projectileRadius: { ...PROJECTILE_RADIUS },
  weapons: structuredClone(WEAPONS),
  sets: FLAG_SETS.map(([, set]) => [...set]),
};

/**
 * Whether the session applied any `Thing` record — that is, whether `MONSTER_HEALTH` and the stat
 * tables still read as vanilla left them.
 *
 * `snapshotThings` asks, because it elides a monster's `health` against `spawnHealthFor`, which
 * reads `MONSTER_HEALTH`. With a patch loaded that baseline is a patched value, so an elided
 * `health` would restore differently under a set without the patch; writing it unconditionally
 * makes the baseline stop mattering. docs/dehacked.md § Savegames and patched tables.
 */
export function thingStatsPatched(): boolean {
  return patchedThings;
}

let patchedThings = false;

/** Empties a record and refills it from a clone, so the pristine copy is never handed to a mutator. */
function restore<T>(table: Record<number | string, T>, from: Record<number | string, T>): void {
  for (const key of Object.keys(table)) delete table[key];
  Object.assign(table, structuredClone(from));
}

/**
 * Puts every patchable table back to vanilla's values.
 *
 * Called immediately **before** `applyDehacked`, not after a session ends: a `Game` that throws
 * mid-construction would otherwise leave the tables patched, and resetting on the way in makes a
 * session read the same tables whatever the previous one loaded. That is the failure mode
 * mutating shared tables is most exposed to, so it is closed by ordering rather than by cleanup.
 */
export function resetDehacked(): void {
  restore(MONSTER_STATS, PRISTINE.monsterStats);
  restore(INERT_SHOOTABLE, PRISTINE.inertShootable);
  restore(MONSTER_HEALTH, PRISTINE.monsterHealth);
  restore(CEILING_HUNG_HEIGHT, PRISTINE.ceilingHung);
  restore(SOLID_DECORATION_RADIUS_OVERRIDE, PRISTINE.solidRadius);
  restore(PROJECTILE_RADIUS, PRISTINE.projectileRadius);
  restore(WEAPONS, PRISTINE.weapons);

  FLAG_SETS.forEach(([, set], i) => {
    set.clear();
    for (const value of PRISTINE.sets[i]) set.add(value);
  });

  resetInventoryLimits();
  resetSoundLumps();
  resetMusicLumps();
  rebuildDerivedMonsterStats();
  patchedThings = false;
}

/**
 * Writes a patch's `Thing`, `Weapon`, `Ammo` and `Misc` edits into the tables.
 *
 * Must run **before** `createThingLayer`, which resolves the stat table once per level and
 * snapshots each thing's radius and height at spawn, and before the `SoundBank`, which pre-decodes
 * on construction. `game.ts`'s constructor is where both orderings hold.
 */
export function applyDehacked(patch: DehPatch): void {
  patchedThings ||= patch.thingEdits.length > 0;
  for (const edit of patch.thingEdits) applyThing(edit);
  for (const edit of patch.ammoEdits) applyAmmo(edit);
  for (const edit of patch.weaponEdits) applyWeapon(edit.index, edit.ammoType);
  applyMisc(patch.misc);
  for (const [name, lump] of patch.soundLumps) setSoundLump(name, lump);
  for (const [mnemonic, lump] of patch.musicLumps) setMusicLump(mnemonic, lump);
  // Last, because `MONSTER_STATS` is what it derives from and every edit above may have moved it.
  rebuildDerivedMonsterStats();
}

/** One `Thing` record, onto whichever of this engine's tables key the type it names. */
function applyThing(edit: DehThingEdit): void {
  const row = MOBJ_INFO[edit.index - 1];
  if (!row) return;
  const dn = row.doomednum;
  const sink = MISSILE_SINKS[row.type];

  if (sink) applyMissile(sink, edit);
  if (dn === -1) return;

  const stats = MONSTER_STATS[dn];
  const inert = INERT_SHOOTABLE[dn];

  if (edit.health !== undefined) MONSTER_HEALTH[dn] = edit.health;
  if (edit.mass !== undefined && stats) stats.mass = edit.mass;
  if (edit.painChance !== undefined && stats) stats.painChance = edit.painChance;

  if (edit.radius !== undefined) {
    if (stats) stats.radius = edit.radius;
    if (inert) inert.radius = edit.radius;
    if (SOLID_DECORATION_TYPES.has(dn)) SOLID_DECORATION_RADIUS_OVERRIDE[dn] = edit.radius;
  }
  if (edit.height !== undefined) {
    if (stats) stats.height = edit.height;
    if (inert) inert.height = edit.height;
    if (dn in CEILING_HUNG_HEIGHT) CEILING_HUNG_HEIGHT[dn] = edit.height;
  }

  // A walker's `Speed` arrives in vanilla's own map-units-per-`A_Chase`, and is applied by
  // scaling: `MonsterStats.speed` is units/sec derived through the walk loop's tic count, and
  // that count is stored nowhere to recompute from. docs/dehacked.md § Units.
  if (edit.speed !== undefined && stats && !sink && row.speed > 0) {
    stats.speed *= edit.speed / row.speed;
  }

  if (edit.sounds) applySounds(dn, edit.sounds);
  if (edit.bits !== undefined) applyBits(dn, edit.bits, edit.height ?? stats?.height ?? inert?.height);
}

/**
 * A `Thing` record's sound fields, onto `MonsterSounds` and — for the two types that carry their
 * own pain/death sounds outside the stat table — `INERT_SHOOTABLE`. A `null` is `sfx_None`, and
 * deletes the field rather than setting it, which is what makes the monster silent there.
 */
function applySounds(dn: number, sounds: NonNullable<DehThingEdit['sounds']>): void {
  const stats = MONSTER_STATS[dn];
  const inert = INERT_SHOOTABLE[dn];
  for (const [slot, name] of Object.entries(sounds)) {
    if (stats) {
      if (name === null) delete stats.sounds[slot as 'see'];
      else stats.sounds[slot as 'see'] = name as SfxId;
    }
    if (inert && name !== null && (slot === 'pain' || slot === 'death')) {
      if (slot === 'pain') inert.painSound = name as SfxId;
      else inert.deathSound = name as SfxId;
    }
  }
}

/**
 * A missile's edits, onto every table keyed by its flight sprite. In vanilla one `mobjinfo` is the
 * imp's fireball wherever it comes from, so every `MONSTER_STATS` entry naming that sprite moves
 * together — which is the faithful answer, not an approximation.
 */
function applyMissile(sink: { sprite: string; weapons?: readonly string[] }, edit: DehThingEdit): void {
  if (edit.radius !== undefined) PROJECTILE_RADIUS[sink.sprite] = edit.radius;

  for (const stats of Object.values(MONSTER_STATS)) {
    for (const attack of [stats.melee, stats.ranged]) {
      if (attack?.projectile?.sprite !== sink.sprite) continue;
      if (edit.speed !== undefined) attack.projectile.speed = edit.speed;
      // `PIT_CheckThing`: `damage = ((P_Random()%8)+1) * info->damage`, which is this engine's
      // `diceSides` of 8 times `diceMult` — so `Missile damage` is the multiplier.
      if (edit.damage !== undefined) attack.diceMult = edit.damage;
    }
  }

  for (const id of sink.weapons ?? []) {
    const weapon = WEAPONS[id as keyof typeof WEAPONS];
    if (!weapon) continue;
    if (edit.speed !== undefined) weapon.projectileSpeed = edit.speed;
    if (edit.damage !== undefined) weapon.damageDiceMultiplier = edit.damage;
  }
}

/**
 * A `Bits` mask, decomposed across the membership `Set`s and stat fields that stand in for
 * vanilla's flags word. **A replacement, not a delta** — a flag the mask omits is removed.
 * docs/dehacked.md § Bits.
 */
function applyBits(dn: number, mask: number, height: number | undefined): void {
  for (const [name, set] of FLAG_SETS) {
    if (mask & MF_FLAGS[name].bit) set.add(dn);
    else set.delete(dn);
  }

  // `MF_SHOOTABLE` without a health entry would leave `spawnHealthFor` returning Infinity, so a
  // type that gains it and gave no `Hit points` takes vanilla's default rather than being
  // unkillable; one that loses it stops being shootable at all.
  if (mask & MF_FLAGS.SHOOTABLE.bit) MONSTER_HEALTH[dn] ??= 1000;
  else delete MONSTER_HEALTH[dn];

  if (mask & MF_FLAGS.SPAWNCEILING.bit) CEILING_HUNG_HEIGHT[dn] ??= height ?? 0;
  else delete CEILING_HUNG_HEIGHT[dn];

  // The exact pair `MonsterStats.flies`' own doc names: vanilla floats a monster with both.
  const stats = MONSTER_STATS[dn];
  if (stats) stats.flies = Boolean(mask & MF_FLAGS.FLOAT.bit) && Boolean(mask & MF_FLAGS.NOGRAVITY.bit);
}

/**
 * `Misc`'s values, each routed to whatever `MISC_SINKS` says it writes: an `InventoryLimits` field
 * for all but one, and `weaponinfo[wp_bfg].ammopershot` for `BFG Cells/Shot`.
 * docs/dehacked.md § Weapon, Ammo and Misc.
 */
function applyMisc(misc: Readonly<Record<string, number>>): void {
  const limits: Partial<InventoryLimits> = {};
  for (const [name, value] of Object.entries(misc)) {
    const sink = MISC_SINKS[name];
    if (!sink) continue;
    if ('limit' in sink) limits[sink.limit] = value;
    else WEAPONS[sink.weapon][sink.field] = value;
  }
  if (Object.keys(limits).length) setInventoryLimits(limits);
}

/** `Ammo N`'s two fields, `d_deh.c`'s `deh_ammo[]`. */
function applyAmmo(edit: DehAmmoEdit): void {
  const type: AmmoType | undefined = AMMO_ORDER[edit.index];
  if (!type) return;
  if (edit.maxAmmo !== undefined) setMaxAmmo(type, edit.maxAmmo);
  if (edit.perAmmo !== undefined) setClipAmmo(type, edit.perAmmo);
}

/** `Weapon N`'s one field this engine has anywhere to put — see docs/dehacked.md § Weapon, Ammo and Misc. */
function applyWeapon(index: number, ammoIndex: number): void {
  const id = WEAPON_ORDER[index];
  const type = AMMO_ORDER[ammoIndex];
  if (!id || !WEAPONS[id]) return;
  // vanilla's `am_noammo` is 5, past the four real classes — the fist and chainsaw use it.
  WEAPONS[id].ammoType = type ?? null;
}
