/**
 * Writes a parsed patch into the engine's tables, and puts them back afterwards. The tables are
 * module-level constants every consumer imports directly, so a patch mutates them in place and a
 * pristine snapshot taken at import is what a reset restores from.
 * See docs/dehacked.md § Applying: reset, then patch.
 */
import {
  INERT_SHOOTABLE,
  forEachProjectileAttack,
  MONSTER_STATS,
  rebuildDerivedMonsterStats,
} from '../monsters/tables.ts';
import * as things from '../things/tables.ts';
import { BARREL_CHAIN, type AttackPose } from '../things/defs.ts';
import { MELEE_RANGE, type AttackStats, type MonsterSounds } from '../monsters/defs.ts';
import {
  IMPACT_EFFECTS,
  ITEM_FOG,
  PROJECTILE_FRAMES,
  PROJECTILE_RADIUS,
  PROJECTILE_SOUNDS,
  TELEPORT_FOG,
} from '../spritefx/tables.ts';
import { LOCKED_LINES } from '../specials/tables.ts';
import { CHEAT_MESSAGES } from '../cheats.ts';
import {
  resetInventoryLimits,
  setClipAmmo,
  setInventoryLimits,
  setMaxAmmo,
  type AmmoType,
  type InventoryLimits,
  type WeaponId,
} from '../inventory.ts';
import { resetSoundLumps, setSoundLump, type SfxId } from '../../audio/sfx.ts';
import { resetMusicLumps, setMusicLump } from '../../audio/music/tables.ts';
import { resetSpriteLumps, setSpriteLump } from '../../wad/sprites.ts';
import { PICKUP_LINES, WEAPON_PICKUPS } from '../inventory/tables.ts';
import { WEAPONS, type WeaponDef } from '../weapons.ts';
import type { DehAmmoEdit, DehFrameEdit, DehPatch, DehPointerEdit, DehThingEdit, DehWeaponEdit } from './defs.ts';
import {
  deriveFrameTables,
  type MissileFrames,
  type MonsterFrames,
  type OneShotFrames,
  patchStates,
  pristineFrameTables,
} from './frames.ts';
import {
  AMMO_ORDER,
  ATTACK_ACTION_SOURCES,
  MF_FLAGS,
  SFX_ORDER,
  MISC_SINKS,
  MISSILE_SINKS,
  MOBJ_INFO,
  OBITUARY_SINKS,
  WEAPON_ACTION_SOURCES,
  WEAPON_ORDER,
} from './tables.ts';

/**
 * The five flag `Set`s a `Bits` mask can add a doomednum to or remove it from — this engine has no
 * flags bitfield, so every `MF_*` with a sink is a membership edit somewhere. Each row carries the
 * predicate over the mask that decides membership, because one of them is not a single bit
 * ({@link isSolidDecoration}). The one list both {@link applyBits} and the pristine snapshot walk,
 * so a `Set` can never be patched without being restored.
 */
const FLAG_SETS: readonly (readonly [Set<number>, (mask: number) => boolean])[] = [
  [things.COUNTKILL_TYPES, (mask) => Boolean(mask & MF_FLAGS.COUNTKILL.bit)],
  [things.COUNTITEM_TYPES, (mask) => Boolean(mask & MF_FLAGS.COUNTITEM.bit)],
  [things.MONSTER_TYPES, (mask) => Boolean(mask & MF_FLAGS.SHOOTABLE.bit)],
  [things.SOLID_DECORATION_TYPES, isSolidDecoration],
  [things.FUZZ_TYPES, (mask) => Boolean(mask & MF_FLAGS.SHADOW.bit)],
];

/**
 * Every patchable record table, as the one list {@link resetDehacked} walks — the shape
 * {@link FLAG_SETS} has for the `Set`s, and for the same reason: registering a table here is the
 * only edit needed, so a table can never be patched without being restored.
 */
const PATCHED_TABLES: readonly (() => void)[] = [
  patchable(MONSTER_STATS),
  patchable(INERT_SHOOTABLE),
  patchable(things.MONSTER_HEALTH),
  patchable(things.MONSTER_DROPS),
  patchable(things.CEILING_HUNG_HEIGHT),
  patchable(things.SOLID_DECORATION_RADIUS_OVERRIDE),
  patchable(PROJECTILE_RADIUS),
  patchable(WEAPONS),
  patchable(WEAPON_PICKUPS),
  patchable(things.OBITUARIES),
  patchable(LOCKED_LINES),
  patchable(CHEAT_MESSAGES),
  patchable(PICKUP_LINES),
  // What a `Frame` record or a repointed `Thing` re-derives — docs/dehacked.md § Frames.
  patchable(things.THING_SPRITES),
  patchable(things.THING_ANIM_FRAMES),
  patchable(things.MONSTER_WALK_FRAMES_OVERRIDE),
  patchable(things.MONSTER_IDLE_FRAMES),
  patchable(things.MONSTER_STAND_FRAMES),
  patchable(things.MONSTER_DEATH_FRAMES),
  patchable(things.MONSTER_XDEATH_FRAMES),
  patchable(things.MONSTER_DEATH_SPRITE_OVERRIDE),
  patchable(things.MONSTER_ATTACK_POSE),
  patchable(things.MONSTER_PAIN_FRAMES),
  patchable(things.MONSTER_RAISE_FRAMES),
  patchable(PROJECTILE_FRAMES),
  patchable(IMPACT_EFFECTS),
  patchable(PROJECTILE_SOUNDS),
  patchable(BARREL_CHAIN),
  patchable(things.CORPSE_GIB),
  patchable(TELEPORT_FOG),
  patchable(ITEM_FOG),
];

/**
 * Every patchable `Set` — the flag sets plus the one the frame walker writes — as arrays, since
 * `structuredClone` is not used on them.
 */
const PATCHED_SETS: readonly Set<number>[] = [...FLAG_SETS.map(([set]) => set), things.MONSTER_CORPSE_VANISHES];
const PRISTINE_SETS = PATCHED_SETS.map((set) => [...set]);

/**
 * Whether the session applied any `Thing` record — that is, whether {@link things.MONSTER_HEALTH}
 * and the stat tables still read as vanilla left them. `snapshotThings` asks, to write a monster's
 * `health` unconditionally rather than elide it against a patched baseline.
 * docs/dehacked.md § Savegames and patched tables.
 */
export function thingStatsPatched(): boolean {
  return patchedThings;
}

let patchedThings = false;

/**
 * Puts every patchable table back to vanilla's values. Called immediately **before**
 * {@link applyDehacked}, not after a session ends, so a `Game` that throws mid-construction leaves
 * nothing patched. docs/dehacked.md § Applying: reset, then patch.
 */
export function resetDehacked(): void {
  for (const restoreTable of PATCHED_TABLES) restoreTable();

  PATCHED_SETS.forEach((set, i) => {
    set.clear();
    for (const value of PRISTINE_SETS[i]) set.add(value);
  });

  resetInventoryLimits();
  resetSoundLumps();
  resetMusicLumps();
  resetSpriteLumps();
  things.rebuildFullbrightFrames();
  rebuildDerivedMonsterStats();
  patchedThings = false;
}

/**
 * Writes a patch's `Thing`, `Frame`, `Weapon`, `Ammo` and `Misc` edits into the tables. Must run
 * **before** `buildThingSprites`, the `SoundBank` and the `SpriteBank`, which `game.ts`'s
 * constructor holds. docs/dehacked.md § Applying: reset, then patch.
 */
export function applyDehacked(patch: DehPatch): void {
  patchedThings ||= patch.thingEdits.length > 0;
  for (const edit of patch.thingEdits) applyThing(edit);
  for (const edit of patch.ammoEdits) applyAmmo(edit);
  for (const edit of patch.weaponEdits) applyWeapon(edit.index, edit.ammoType);
  applyMisc(patch.misc);
  applyObituaries(patch.strings);
  replaceByMnemonic(LOCKED_LINES, patch.strings); // PD_*
  replaceByMnemonic(CHEAT_MESSAGES, patch.strings); // STSTR_*
  replaceByMnemonic(PICKUP_LINES, patch.strings); // GOT*
  for (const [name, lump] of patch.soundLumps) setSoundLump(name, lump);
  for (const [mnemonic, lump] of patch.musicLumps) setMusicLump(mnemonic, lump);
  for (const [name, to] of patch.spriteRenames) setSpriteLump(name, to);
  // After the `Thing` loop, whose `Speed` scaling it composes with, and before the rebuild below,
  // which derives from the durations it writes.
  applyFrames(patch.frameEdits, patch.thingEdits, patch.weaponEdits, patch.pointerEdits, patch.stateCount);
  // Last, because `MONSTER_STATS` is what it derives from and every edit above may have moved it.
  rebuildDerivedMonsterStats();
}

/**
 * Pairs one patchable record table with its pristine clone, taken at import — before any `Game`
 * exists, so it can only ever capture the vanilla values.
 *
 * `structuredClone` rather than a shallow copy because `MonsterStats` nests three levels deep
 * (`ranged.projectile.pairOffsetsRad` is an array of arrays, `sounds.walk.sounds` an array); a
 * shallow copy would hand a patched sub-object straight back on reset.
 *
 * @returns the function that puts the table back
 */
function patchable<T extends object>(table: T): () => void {
  const pristine = structuredClone(table);
  return () => restore(table, pristine);
}

/**
 * Empties a record and refills it from a clone, so the pristine copy is never handed to a mutator.
 */
function restore<T extends object>(table: T, from: T): void {
  const keyed = table as Record<string, unknown>;
  for (const key of Object.keys(keyed)) delete keyed[key];
  Object.assign(table, structuredClone(from));
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

  if (edit.health !== undefined) things.MONSTER_HEALTH[dn] = edit.health;
  if (edit.mass !== undefined && stats) {
    stats.mass = edit.mass;
  }
  if (edit.painChance !== undefined && stats) {
    stats.painChance = edit.painChance;
  }

  if (edit.radius !== undefined) {
    if (stats) stats.radius = edit.radius;
    if (inert) inert.radius = edit.radius;
    // The membership this record *ends* with, not the one it started with: `Bits` is applied last
    // (it needs the patched height), so a record that turns a prop solid and resizes it in one go
    // would otherwise write no override and leave it at the shared 16 units.
    const solid = edit.bits === undefined ? things.SOLID_DECORATION_TYPES.has(dn) : isSolidDecoration(edit.bits);
    if (solid) things.SOLID_DECORATION_RADIUS_OVERRIDE[dn] = edit.radius;
  }
  if (edit.height !== undefined) {
    if (stats) stats.height = edit.height;
    if (inert) inert.height = edit.height;
    if (dn in things.CEILING_HUNG_HEIGHT) things.CEILING_HUNG_HEIGHT[dn] = edit.height;
  }

  // A walker's `Speed` arrives in vanilla's own map-units-per-`A_Chase`, and is applied by
  // scaling: `MonsterStats.speed` is units/sec derived through the walk loop's tic count, and
  // that count is stored nowhere to recompute from. docs/dehacked.md § Units.
  if (edit.speed !== undefined && stats && !sink && row.speed > 0) {
    stats.speed *= edit.speed / row.speed;
  }

  if (edit.sounds) applySounds(stats, inert, edit.sounds);
  if (edit.bits !== undefined) applyBits(dn, edit.bits, edit.height ?? stats?.height ?? inert?.height);
}

/**
 * A `Thing` record's sound fields, onto {@link MonsterSounds} and — for the two types that carry
 * their own pain/death sounds outside the stat table — {@link INERT_SHOOTABLE}. A `null` is
 * `sfx_None`, and deletes the field rather than setting it, which is what makes the monster silent
 * there.
 */
function applySounds(
  stats: (typeof MONSTER_STATS)[number] | undefined,
  inert: (typeof INERT_SHOOTABLE)[number] | undefined,
  sounds: NonNullable<DehThingEdit['sounds']>,
): void {
  for (const [slot, name] of Object.entries(sounds)) {
    if (stats) {
      if (name === null) delete stats.sounds[slot as 'see'];
      else stats.sounds[slot as 'see'] = name as SfxId;
      // `attacksound` has a second sink here: `A_Chase` plays it on entering
      // meleestate, which is `MonsterSounds.meleeWindup` — the `attack` slot is
      // only the hitscan actions' own sound. See that field's doc.
      if (slot === 'attack' && stats.melee) {
        if (name === null) delete stats.sounds.meleeWindup;
        else stats.sounds.meleeWindup = name as SfxId;
      }
    }
    if (inert && name !== null && (slot === 'pain' || slot === 'death')) {
      if (slot === 'pain') inert.painSound = name as SfxId;
      else inert.deathSound = name as SfxId;
    }
  }
}

/**
 * A missile's edits, onto every table keyed by its flight sprite. In vanilla one `mobjinfo` is the
 * imp's fireball wherever it comes from, so every {@link MONSTER_STATS} entry naming that sprite
 * moves together — which is the faithful answer, not an approximation.
 */
function applyMissile(sink: (typeof MISSILE_SINKS)[string], edit: DehThingEdit): void {
  if (edit.radius !== undefined) PROJECTILE_RADIUS[sink.sprite] = edit.radius;

  forEachProjectileAttack(sink.sprite, (attack) => {
    if (edit.speed !== undefined) attack.projectile.speed = edit.speed;
    // `PIT_CheckThing`: `damage = ((P_Random()%8)+1) * info->damage`, which is this engine's
    // `diceSides` of 8 times `diceMult` — so `Missile damage` is the multiplier.
    if (edit.damage !== undefined) attack.diceMult = edit.damage;
  });

  for (const id of sink.weapons ?? []) {
    const weapon = WEAPONS[id];
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
  for (const [set, member] of FLAG_SETS) {
    if (member(mask)) set.add(dn);
    else set.delete(dn);
  }

  // `MF_SHOOTABLE` without a health entry would leave `spawnHealthFor` returning Infinity, so a
  // type that gains it and gave no `Hit points` takes vanilla's default rather than being
  // unkillable; one that loses it stops being shootable at all.
  if (mask & MF_FLAGS.SHOOTABLE.bit) things.MONSTER_HEALTH[dn] ??= 1000;
  else delete things.MONSTER_HEALTH[dn];

  if (mask & MF_FLAGS.SPAWNCEILING.bit) things.CEILING_HUNG_HEIGHT[dn] ??= height ?? 0;
  else delete things.CEILING_HUNG_HEIGHT[dn];

  // The exact pair `MonsterStats.flies`' own doc names: vanilla floats a monster with both.
  const stats = MONSTER_STATS[dn];
  if (stats) stats.flies = Boolean(mask & MF_FLAGS.FLOAT.bit) && Boolean(mask & MF_FLAGS.NOGRAVITY.bit);
}

/**
 * Whether a mask makes its type a member of {@link things.SOLID_DECORATION_TYPES}, which is
 * `MF_SOLID` **and not `MF_SHOOTABLE`** — not vanilla's `MF_SOLID` alone, which every monster in
 * `info.c` carries too (docs/movement.md § Solid decorations).
 */
function isSolidDecoration(mask: number): boolean {
  return Boolean(mask & MF_FLAGS.SOLID.bit) && !(mask & MF_FLAGS.SHOOTABLE.bit);
}

/**
 * `Misc`'s values, each routed to whatever {@link MISC_SINKS} says it writes: an
 * {@link InventoryLimits} field for all but one, and `weaponinfo[wp_bfg].ammopershot` for
 * `BFG Cells/Shot`. docs/dehacked.md § Weapon, Ammo and Misc.
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

/**
 * ZDoom's obituary format tokens, in the second person the overlay speaks. `%o` is the victim,
 * which here is only ever the player being shown the line. `%hself` is matched ahead of `%h` by the
 * alternation that reads this, which is what makes it `yourself` rather than `youself`.
 * docs/dehacked.md § Obituaries.
 */
const OBITUARY_TOKENS: Record<string, string> = {
  '%hself': 'yourself',
  '%o': 'you',
  '%g': 'you',
  '%h': 'you',
  '%p': 'your',
  '%s': 'yours',
};

/**
 * Every `OB_*` string the patch set, onto the {@link things.OBITUARIES} line each one replaces, put
 * into the second person — docs/dehacked.md § Obituaries.
 */
function applyObituaries(strings: ReadonlyMap<string, string>): void {
  for (const [mnemonic, sink] of Object.entries(OBITUARY_SINKS)) {
    const text = strings.get(mnemonic);
    if (text === undefined) continue;
    const line = text
      .replace(/%hself|%[oghps]/g, (token) => OBITUARY_TOKENS[token])
      .trim()
      .replace(/\byou was\b/, 'you were');
    things.OBITUARIES[sink] = line.charAt(0).toUpperCase() + line.slice(1);
  }
}

/**
 * Every string the patch set whose mnemonic this table already keys, replaced outright — no
 * transform, unlike an `OB_*`: these tables hold whole second-person sentences.
 * docs/dehacked.md § Locked-door lines, § Cheat responses.
 */
function replaceByMnemonic(table: Record<string, string>, strings: ReadonlyMap<string, string>): void {
  for (const mnemonic of Object.keys(table)) {
    const text = strings.get(mnemonic);
    if (text !== undefined) table[mnemonic] = text;
  }
}

/** `Ammo N`'s two fields, `d_deh.c`'s `deh_ammo[]`. */
function applyAmmo(edit: DehAmmoEdit): void {
  const type: AmmoType | undefined = AMMO_ORDER[edit.index];
  if (!type) return;
  if (edit.maxAmmo !== undefined) setMaxAmmo(type, edit.maxAmmo);
  if (edit.perAmmo !== undefined) setClipAmmo(type, edit.perAmmo);
}

/**
 * `Weapon N`'s ammo type, which lands twice: on what the weapon spends, and on what its map pickup
 * hands over — `P_GiveWeapon` reads one `weaponinfo` field for both, this engine keys the grant by
 * doomednum. docs/items.md § Ammo counts, and what a patch can move. Its five state pointers are
 * applied by {@link applyFrames} instead — docs/dehacked.md § Weapon, Ammo and Misc.
 *
 * @param ammoIndex  -1 when the record wrote no `Ammo type` line, which leaves the weapon's own
 *                   class alone; without that guard a record that only repoints frames would
 *                   disarm the weapon
 */
function applyWeapon(index: number, ammoIndex: number): void {
  const id = WEAPON_ORDER[index];
  if (!id || ammoIndex < 0) return;
  // vanilla's `am_noammo` is 5, past the four real classes — the fist and chainsaw use it.
  const type = AMMO_ORDER[ammoIndex] ?? null;
  WEAPONS[id].ammoType = type;
  for (const pickup of Object.values(WEAPON_PICKUPS)) {
    if (pickup.weapon !== id) continue;
    pickup.ammoType = type;
    pickup.clips = type === null ? 0 : WEAPON_PICKUP_CLIPS;
  }
}

/** `P_GiveWeapon`'s own literal: what a weapon lying on the map hands over, in clips. */
const WEAPON_PICKUP_CLIPS = 2;

/** Structural equality over the small plain values the tables hold. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Writes `value` under `key`, or deletes the key for null — one entry of a diff. */
function put<T>(table: Record<number | string, T>, key: number | string, value: T | null | undefined): void {
  if (value === null || value === undefined) {
    delete table[key];
  }
  else table[key] = structuredClone(value);
}

/**
 * Writes a patch's frame edits into the engine's tables: derive from the patched frame table,
 * derive from vanilla's, and write only what differs (docs/dehacked.md § Frames).
 *
 * A patch with no frame edits at all returns before cloning the frame table: {@link resetDehacked}
 * runs immediately before this and has already refilled every sink from vanilla.
 *
 * @param stateCount  how far the patch grew the frame table (docs/dehacked.md § Extended states);
 *                    growth on its own moves nothing, so it is not itself a reason to walk
 */
function applyFrames(
  frameEdits: readonly DehFrameEdit[],
  thingEdits: readonly DehThingEdit[],
  weaponEdits: readonly DehWeaponEdit[],
  pointerEdits: readonly DehPointerEdit[],
  stateCount: number,
): void {
  const repointed = thingEdits.some((edit) => edit.states) || weaponEdits.some((edit) => edit.states);
  if (frameEdits.length === 0 && !repointed && pointerEdits.length === 0) return;

  const patched = patchStates(frameEdits, thingEdits, weaponEdits, pointerEdits, stateCount);
  // Only a `Frame` record can move a fullbright bit — a `Thing` state repoint moves pointers
  // between rows, never the rows' own sprite/frame words. Which rows those are is also what lets an
  // MBF or extended state vote at all (`rebuildFullbrightFrames`).
  if (frameEdits.length > 0) things.rebuildFullbrightFrames(patched.states, patched.written);

  const before = pristineFrameTables();
  const after = deriveFrameTables(patched);

  for (const key of Object.keys(after.monsters)) {
    const dn = Number(key);
    const a = before.monsters[dn];
    const b = after.monsters[dn];
    if (!a || same(a, b)) continue;
    writeMonster(dn, a, b);
  }
  for (const [index, id] of WEAPON_ORDER.entries()) {
    const rate = after.weapons[index];
    if (!rate || same(before.weapons[index], rate)) continue;
    borrowWeapon(id, before.weapons[index].action, rate.action);
    WEAPONS[id].cooldown = rate.cooldown;
  }
  for (const key of Object.keys(after.sprites)) {
    const dn = Number(key);
    if (!same(before.sprites[dn], after.sprites[dn])) things.THING_SPRITES[dn] = after.sprites[dn];
  }
  for (const key of Object.keys(after.anims)) {
    const dn = Number(key);
    if (!same(before.anims[dn], after.anims[dn])) put(things.THING_ANIM_FRAMES, dn, after.anims[dn]);
  }
  for (const sprite of Object.keys(after.missiles)) {
    if (!same(before.missiles[sprite], after.missiles[sprite])) writeMissile(sprite, before.missiles[sprite], after.missiles[sprite]);
  }
  // A patch that repoints `S_GIBS` moves what a crushed corpse is drawn as — the one derived pose
  // no `mobjinfo` chain reaches. docs/specials-crushers.md § Crushed corpses.
  if (after.gibs && !same(before.gibs, after.gibs)) {
    things.CORPSE_GIB.sprite = after.gibs.sprite;
    things.CORPSE_GIB.frames = after.gibs.frames;
  }
  // The two fogs, whose rows no placeable doomednum reaches. docs/dehacked.md § Frames.
  if (!same(before.teleportFog, after.teleportFog)) writeOneShot(TELEPORT_FOG, after.teleportFog);
  if (!same(before.itemFog, after.itemFog)) writeOneShot(ITEM_FOG, after.itemFog);
  if (after.barrel && !same(before.barrel, after.barrel)) {
    BARREL_CHAIN.idleFrames = after.barrel.idleFrames;
    BARREL_CHAIN.idleFrameSeconds = after.barrel.idleFrameSeconds;
    if (after.barrel.deathSprite !== undefined) BARREL_CHAIN.deathSprite = after.barrel.deathSprite;
    BARREL_CHAIN.deathFrames = after.barrel.deathFrames;
    if (after.barrel.explodeDelaySeconds !== null) BARREL_CHAIN.explodeDelaySeconds = after.barrel.explodeDelaySeconds;
  }
}

/** One monster type's changed entries, field by field, onto the pose tables and its stat block. */
function writeMonster(dn: number, a: MonsterFrames, b: MonsterFrames): void {
  if (b.sprite !== undefined && a.sprite !== b.sprite) {
    things.THING_SPRITES[dn] = b.sprite;
  }
  if (!same(a.walk, b.walk)) put(things.MONSTER_WALK_FRAMES_OVERRIDE, dn, same(b.walk, things.MONSTER_WALK_FRAMES) || b.walk.length === 0 ? null : b.walk);
  if (!same(a.idle, b.idle)) put(things.MONSTER_IDLE_FRAMES, dn, b.idle);
  if (!same(a.stand, b.stand)) put(things.MONSTER_STAND_FRAMES, dn, b.stand);
  if (!same(a.death, b.death)) put(things.MONSTER_DEATH_FRAMES, dn, b.death);
  if (!same(a.xdeath, b.xdeath)) put(things.MONSTER_XDEATH_FRAMES, dn, b.xdeath);
  if (!same(a.deathSprite, b.deathSprite)) put(things.MONSTER_DEATH_SPRITE_OVERRIDE, dn, b.deathSprite);
  if (a.vanishes !== b.vanishes) {
    if (b.vanishes) things.MONSTER_CORPSE_VANISHES.add(dn);
    else things.MONSTER_CORPSE_VANISHES.delete(dn);
  }
  if (!same(a.pain, b.pain)) put(things.MONSTER_PAIN_FRAMES, dn, b.pain);
  if (!same(a.meleePose, b.meleePose) || !same(a.rangedPose, b.rangedPose)) {
    const pose: { melee?: AttackPose; ranged?: AttackPose } = {};
    if (b.meleePose) pose.melee = b.meleePose;
    if (b.rangedPose) pose.ranged = b.rangedPose;
    put(things.MONSTER_ATTACK_POSE, dn, Object.keys(pose).length ? pose : null);
  }
  if (!same(a.raise, b.raise)) put(things.MONSTER_RAISE_FRAMES, dn, b.raise);

  const stats = MONSTER_STATS[dn];
  if (!stats) return;
  if (a.painDuration !== b.painDuration) stats.painDuration = b.painDuration;
  // A chain that fires a *different* action is a different attack, not a retimed one: the roll,
  // the projectile and the splash come from whichever type owns that action in vanilla, and the
  // timings below then land on the new shape. Written before them for exactly that reason.
  const meleeRepointed = a.meleeAction !== b.meleeAction;
  const rangedRepointed = a.rangedAction !== b.rangedAction;
  // Which fields the chain writes. A repointed slot holds a fresh clone of the *donor* type's
  // stats, so every figure the chain implies goes onto it outright; an unrepointed one stays a
  // diff, written only where the walk actually moved.
  const meleeMoved = <T,>(before: T, after: T): boolean => meleeRepointed || before !== after;
  const rangedMoved = <T,>(before: T, after: T): boolean => rangedRepointed || before !== after;
  if (meleeRepointed || !same(a.meleeArgs, b.meleeArgs)) {
    stats.melee = attackFor(b.meleeAction, 'melee', stats.melee, b.meleeArgs);
  }
  if (rangedRepointed || !same(a.rangedArgs, b.rangedArgs)) {
    stats.ranged = attackFor(b.rangedAction, 'ranged', stats.ranged, b.rangedArgs);
  }
  if (stats.melee && b.meleeDuration !== null && meleeMoved(a.meleeDuration, b.meleeDuration)) {
    stats.melee.duration = b.meleeDuration;
  }
  if (stats.ranged && b.rangedDuration !== null && rangedMoved(a.rangedDuration, b.rangedDuration)) {
    stats.ranged.duration = b.rangedDuration;
  }
  // Only where the type already models a windup: the lost soul's charge and the pain elemental's
  // spawn never read it (see their `MONSTER_STATS` entries), so writing one would be a trap.
  if (stats.melee?.startDelaySeconds !== undefined && meleeMoved(a.meleeDelay, b.meleeDelay)) {
    stats.melee.startDelaySeconds = b.meleeDelay ?? 0;
  }
  if (stats.ranged?.startDelaySeconds !== undefined && rangedMoved(a.rangedDelay, b.rangedDelay)) {
    stats.ranged.startDelaySeconds = b.rangedDelay ?? 0;
  }
  // A volley's shape follows its chain too: how many `A_*Attack` calls it carries and how far
  // apart they sit. Written the way `monsters/tables.ts` derives them from vanilla's own chains —
  // a single-shot chain leaves both unset and reads as vanilla's default of one shot — so a patch
  // that *adds* a firing action to a chain that had one gets the extra shot, rather than the shot
  // count being frozen at whatever the type happened to model.
  if (rangedMoved(a.rangedShots, b.rangedShots) && stats.ranged) {
    if (b.rangedShots > 1) stats.ranged.shots = b.rangedShots;
    else delete stats.ranged.shots;
  }
  if (stats.ranged && b.rangedInterval !== null && rangedMoved(a.rangedInterval, b.rangedInterval)) {
    stats.ranged.shotInterval = b.rangedInterval;
  }
  // And whether the pass re-enters itself: the `A_*Refire` loop is the chain's, not the type's,
  // so it travels with a repoint in both directions.
  if (stats.ranged && rangedMoved(a.rangedRefires, b.rangedRefires)) {
    if (b.rangedRefires) stats.ranged.refire = true;
    else delete stats.ranged.refire;
  }
  // And what each of those shots *is*, where they are not all the same attack.
  // No `rangedRepointed` disjunct here: `rangedAction` *is* `rangedActions[0]`
  // (`frames.ts: deriveMonster`), so a repoint always shows up in the list comparison.
  if (stats.ranged && !same(a.rangedActions, b.rangedActions)) {
    const perShot = shotAttacksFor(stats.ranged, b.rangedActions);
    if (perShot) stats.ranged.shotAttacks = perShot;
    else delete stats.ranged.shotAttacks;
  }
  // MBF's `A_PlaySound`, and `A_Scratch`'s own `misc2` alongside it: both are read off the chain by
  // the walker, since a sound is a per-type property here rather than something a state carries.
  // docs/dehacked.md § Action pointers.
  if (b.meleeSound !== null && b.meleeSound !== a.meleeSound) {
    putSound(stats.sounds, 'melee', b.meleeSound);
  }
  if (b.rangedSound !== null && b.rangedSound !== a.rangedSound) {
    putSound(stats.sounds, 'attack', b.rangedSound);
  }
  if (b.painSound !== null && b.painSound !== a.painSound) {
    putSound(stats.sounds, 'pain', b.painSound);
  }
  if (b.deathSound !== null && b.deathSound !== a.deathSound) {
    putSound(stats.sounds, 'death', b.deathSound);
  }
  // `A_Spawn` on a death chain is what this engine already models as a drop. Its `misc1` is a
  // 1-based `mobjinfo` index; a type no map can place has no doomednum to drop.
  if (b.drop !== null && b.drop !== a.drop) {
    const dropped = MOBJ_INFO[b.drop - 1]?.doomednum ?? -1;
    if (dropped !== -1) put(things.MONSTER_DROPS, dn, dropped);
  }
  // The walk loop changed: the chase clock follows it outright, and `speed` — already scaled by any
  // `Speed` line `applyThing` read — is rescaled by the loop factor's change, so the two compose in
  // either order. docs/dehacked.md § Units.
  if (b.chase && a.chase && !same(a.chase, b.chase)) {
    stats.chaseInterval = b.chase.interval;
    stats.speed *= b.chase.factor / a.chase.factor;
  }
}

/**
 * One `S_sfx[]` index onto a {@link MonsterSounds} field; index 0 is `sfx_None`, which means
 * silence.
 */
function putSound(sounds: MonsterSounds, slot: 'melee' | 'attack' | 'pain' | 'death', index: number): void {
  const name = SFX_ORDER[index];
  if (name === undefined) return;
  if (index === 0) delete sounds[slot];
  else sounds[slot] = name as SfxId;
}

/**
 * The per-shot attacks of a volley whose firing actions don't all belong to the same monster —
 * {@link AttackStats.shotAttacks}. Each entry borrows its roll and its projectile from whoever owns
 * that action in vanilla, exactly as a whole-chain repoint does; the chain's own attack still
 * supplies the timings and the pose, and stands in wherever the bridge names nobody.
 *
 * Undefined unless the *owners* differ, not merely the action names: the mancubus's chain carries
 * three distinct `A_FatAttack*` that are one attack fanned by `pairOffsetsRad`, and all three name
 * the mancubus. docs/dehacked.md § Action pointers.
 */
function shotAttacksFor(chain: AttackStats, actions: readonly string[]): AttackStats[] | undefined {
  if (actions.length < 2) return undefined;
  if (new Set(actions.map((name) => ATTACK_ACTION_SOURCES[name])).size < 2) return undefined;
  // Cloned rather than aliased wherever the chain's own attack is the answer: `same` walks these
  // blocks with `JSON.stringify`, which a self-reference would throw on. The clone drops any
  // `shotAttacks` of its own, which nothing reads a level down.
  const ownShot = (): AttackStats => {
    const copy = structuredClone(chain);
    delete copy.shotAttacks;
    return copy;
  };
  return actions.map((name, i) => (i === 0 ? ownShot() : attackFor(name, 'ranged', chain, null) ?? ownShot()));
}

/**
 * The {@link AttackStats} a repointed chain carries: a copy of the attack the action's own type
 * fires in vanilla ({@link ATTACK_ACTION_SOURCES}), taken **after** {@link applyThing}, or null
 * where the chain fires nothing at all. An action the bridge doesn't name keeps the type's existing
 * attack, and a type with no attack in *this* slot lends its other.
 * docs/dehacked.md § Action pointers.
 */
function attackFor(
  action: string | null,
  slot: 'melee' | 'ranged',
  current: AttackStats | null,
  args: readonly number[] | null,
): AttackStats | null {
  if (action === null) return null;
  // MBF's own attack is the one that isn't a type's: `A_Scratch` deals its `misc1` flat, so it is
  // built from the state rather than borrowed. A one-sided die is how a flat roll is written here
  // — `(rand % 1 + 1) * misc1` — which needs no new shape in `AttackStats`.
  if (action === 'A_Scratch') {
    const damage = args?.[0] ?? 0;
    // `duration` is a placeholder: the caller writes the chain's own, measured, right after.
    return damage > 0 ? { range: MELEE_RANGE, diceSides: 1, diceMult: damage, duration: 0 } : current;
  }
  const source = ATTACK_ACTION_SOURCES[action];
  if (source === undefined) return current;
  const stats = MONSTER_STATS[source];
  const shape = stats?.[slot] ?? stats?.[slot === 'melee' ? 'ranged' : 'melee'];
  return shape ? structuredClone(shape) : current;
}

/**
 * The {@link WeaponDef} fields a repointed fire chain does **not** borrow:
 * {@link WeaponDef.ammoType} is the `Weapon` record's own line, {@link WeaponDef.cooldown} is
 * walked off the chain itself, and {@link WeaponDef.iconLump} is the pickup's art rather than
 * anything the shot does. Everything else is what the weapon fires, so it is stated as the
 * exclusion — a field added to {@link WeaponDef} later describes the shot until it says otherwise.
 */
const WEAPON_OWN_FIELDS: readonly (keyof WeaponDef)[] = ['ammoType', 'cooldown', 'iconLump'];

/**
 * What a repointed fire chain now *fires*: the {@link WeaponDef} of the weapon whose firing action
 * it took, copied bar {@link WEAPON_OWN_FIELDS} and **after** {@link applyWeapon} and
 * {@link applyMisc}; an action the bridge doesn't name leaves the weapon's shot alone, as in
 * {@link attackFor}. {@link WeaponDef.skinWeapon} rides along; a shot that resolves to no weapon
 * clears it, and `playerSkinWeapon` takes the whole shipped set out of use.
 * docs/dehacked.md § Action pointers.
 */
function borrowWeapon(id: WeaponId, before: string | null, after: string | null): void {
  if (after === before) return;
  const source = after === null ? undefined : WEAPON_ACTION_SOURCES[after];
  if (source === undefined) {
    WEAPONS[id].skinWeapon = null;
    return;
  }
  if (source === id) return;
  const borrowed = Object.entries(WEAPONS[source])
    .filter(([field]) => !WEAPON_OWN_FIELDS.includes(field as keyof WeaponDef));
  Object.assign(WEAPONS[id], structuredClone(Object.fromEntries(borrowed)));
}

/**
 * One missile's changed art. A patched flight sprite moves the missile to a new key in every
 * sprite-keyed table — {@link applyMissile}'s fan-out, plus the two tables the walker doesn't
 * derive ({@link PROJECTILE_RADIUS}, {@link PROJECTILE_SOUNDS}), which carry over under the new
 * name.
 */
function writeMissile(sprite: string, a: MissileFrames | undefined, b: MissileFrames): void {
  let key = sprite;
  if (b.flightSprite !== undefined && b.flightSprite !== sprite) {
    key = b.flightSprite;
    PROJECTILE_RADIUS[key] ??= PROJECTILE_RADIUS[sprite];
    PROJECTILE_SOUNDS[key] ??= PROJECTILE_SOUNDS[sprite];
    forEachProjectileAttack(sprite, (attack) => {
      attack.projectile.sprite = key;
    });
    for (const weapon of Object.values(WEAPONS)) {
      if (weapon.projectileSprite === sprite) weapon.projectileSprite = key;
    }
    put(PROJECTILE_FRAMES, key, b.flight);
    put(IMPACT_EFFECTS, key, b.impact);
    return;
  }
  if (!same(a?.flight, b.flight)) put(PROJECTILE_FRAMES, key, b.flight);
  if (!same(a?.impact, b.impact)) put(IMPACT_EFFECTS, key, b.impact);
}

/**
 * One fog's changed chain onto its record. A chain that draws nothing empties the record rather
 * than leaving vanilla's art standing, and the effect layer then spawns nothing for it.
 */
function writeOneShot(record: OneShotFrames, chain: OneShotFrames | null): void {
  Object.assign(record, chain ?? { sprite: '', frames: [], frameSeconds: 0 });
}
