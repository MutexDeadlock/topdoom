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
import {
  CEILING_HUNG_HEIGHT,
  COUNTITEM_TYPES,
  COUNTKILL_TYPES,
  FUZZ_TYPES,
  MONSTER_ATTACK_POSE,
  MONSTER_CORPSE_VANISHES,
  MONSTER_DEATH_FRAMES,
  MONSTER_DEATH_SPRITE_OVERRIDE,
  MONSTER_HEALTH,
  MONSTER_IDLE_FRAMES,
  MONSTER_WALK_FRAMES,
  MONSTER_PAIN_FRAMES,
  MONSTER_RAISE_FRAMES,
  MONSTER_TYPES,
  MONSTER_WALK_FRAMES_OVERRIDE,
  MONSTER_XDEATH_FRAMES,
  OBITUARIES,
  rebuildFullbrightFrames,
  SOLID_DECORATION_RADIUS_OVERRIDE,
  SOLID_DECORATION_TYPES,
  THING_ANIM_FRAMES,
  THING_SPRITES,
} from '../things/tables.ts';
import { BARREL_CHAIN, type AttackPose } from '../things/defs.ts';
import { IMPACT_EFFECTS, PROJECTILE_FRAMES, PROJECTILE_RADIUS, PROJECTILE_SOUNDS } from '../spritefx/tables.ts';
import { LOCKED_LINES } from '../specials/tables.ts';
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
import { resetSpriteLumps, setSpriteLump } from '../../wad/sprites.ts';
import { WEAPONS } from '../weapons.ts';
import type { DehAmmoEdit, DehFrameEdit, DehPatch, DehThingEdit, DehWeaponEdit } from './defs.ts';
import {
  deriveFrameTables,
  type MissileFrames,
  type MonsterFrames,
  patchStates,
  pristineFrameTables,
} from './frames.ts';
import {
  AMMO_ORDER,
  MF_FLAGS,
  MISC_SINKS,
  MISSILE_SINKS,
  MOBJ_INFO,
  OBITUARY_SINKS,
  WEAPON_ORDER,
} from './tables.ts';

/**
 * The five flag `Set`s a `Bits` mask can add a doomednum to or remove it from — this engine has no
 * flags bitfield, so every `MF_*` with a sink is a membership edit somewhere. Each row carries the
 * predicate over the mask that decides membership, because one of them is not a single bit
 * (`isSolidDecoration`). The one list both `applyBits` and the pristine snapshot walk, so a `Set`
 * can never be patched without being restored.
 */
const FLAG_SETS: readonly (readonly [Set<number>, (mask: number) => boolean])[] = [
  [COUNTKILL_TYPES, (mask) => Boolean(mask & MF_FLAGS.COUNTKILL.bit)],
  [COUNTITEM_TYPES, (mask) => Boolean(mask & MF_FLAGS.COUNTITEM.bit)],
  [MONSTER_TYPES, (mask) => Boolean(mask & MF_FLAGS.SHOOTABLE.bit)],
  [SOLID_DECORATION_TYPES, isSolidDecoration],
  [FUZZ_TYPES, (mask) => Boolean(mask & MF_FLAGS.SHADOW.bit)],
];

/**
 * Whether a mask makes its type a member of `SOLID_DECORATION_TYPES`, which is `MF_SOLID` **and not
 * `MF_SHOOTABLE`** — a prop that blocks movement but that a shot passes through, not vanilla's
 * `MF_SOLID` alone (docs/movement.md § Solid decorations). Every monster in `info.c` carries
 * `MF_SOLID` too, so keying membership on that bit by itself would put any patched monster in the
 * set and `things.ts` would then skip it in the hitscan, projectile and splash paths.
 */
function isSolidDecoration(mask: number): boolean {
  return Boolean(mask & MF_FLAGS.SOLID.bit) && !(mask & MF_FLAGS.SHOOTABLE.bit);
}

/**
 * Pairs one patchable record table with its pristine clone, taken at import — before any `Game`
 * exists, so it can only ever capture the vanilla values — and returns the function that puts it
 * back.
 *
 * `structuredClone` rather than a shallow copy because `MonsterStats` nests three levels deep
 * (`ranged.projectile.pairOffsetsRad` is an array of arrays, `sounds.walk.sounds` an array); a
 * shallow copy would hand a patched sub-object straight back on reset.
 */
function patchable<T>(table: Record<number | string, T>): () => void {
  const pristine = structuredClone(table);
  return () => restore(table, pristine);
}

/**
 * Every patchable record table, as the one list `resetDehacked` walks — the shape `FLAG_SETS` has
 * for the `Set`s, and for the same reason: registering a table here is the only edit needed, so a
 * table can never be patched without being restored.
 */
const PATCHED_TABLES: readonly (() => void)[] = [
  patchable(MONSTER_STATS),
  patchable(INERT_SHOOTABLE),
  patchable(MONSTER_HEALTH),
  patchable(CEILING_HUNG_HEIGHT),
  patchable(SOLID_DECORATION_RADIUS_OVERRIDE),
  patchable(PROJECTILE_RADIUS),
  patchable(WEAPONS),
  patchable(OBITUARIES),
  patchable(LOCKED_LINES),
  // What a `Frame` record or a repointed `Thing` re-derives — docs/dehacked.md § Frames.
  patchable(THING_SPRITES),
  patchable(THING_ANIM_FRAMES),
  patchable(MONSTER_WALK_FRAMES_OVERRIDE),
  patchable(MONSTER_IDLE_FRAMES),
  patchable(MONSTER_DEATH_FRAMES),
  patchable(MONSTER_XDEATH_FRAMES),
  patchable(MONSTER_DEATH_SPRITE_OVERRIDE),
  patchable(MONSTER_ATTACK_POSE),
  patchable(MONSTER_PAIN_FRAMES),
  patchable(MONSTER_RAISE_FRAMES),
  patchable(PROJECTILE_FRAMES),
  patchable(IMPACT_EFFECTS),
  patchable(PROJECTILE_SOUNDS),
  patchable(BARREL_CHAIN),
];

/** Every patchable `Set` — the flag sets plus the one the frame walker writes — as arrays, since `structuredClone` is not used on them. */
const PATCHED_SETS: readonly Set<number>[] = [...FLAG_SETS.map(([set]) => set), MONSTER_CORPSE_VANISHES];
const PRISTINE_SETS = PATCHED_SETS.map((set) => [...set]);

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
  for (const restoreTable of PATCHED_TABLES) restoreTable();

  PATCHED_SETS.forEach((set, i) => {
    set.clear();
    for (const value of PRISTINE_SETS[i]) set.add(value);
  });

  resetInventoryLimits();
  resetSoundLumps();
  resetMusicLumps();
  resetSpriteLumps();
  rebuildFullbrightFrames();
  rebuildDerivedMonsterStats();
  patchedThings = false;
}

/**
 * Writes a patch's `Thing`, `Frame`, `Weapon`, `Ammo` and `Misc` edits into the tables.
 *
 * Must run **before** `createThingLayer`, which resolves the stat table once per level and
 * snapshots each thing's radius and height at spawn, before the `SoundBank`, which pre-decodes on
 * construction, and before the `SpriteBank`, which indexes `[SPRITES]` renames as it is built.
 * `game.ts`'s constructor is where all three orderings hold.
 */
export function applyDehacked(patch: DehPatch): void {
  patchedThings ||= patch.thingEdits.length > 0;
  for (const edit of patch.thingEdits) applyThing(edit);
  for (const edit of patch.ammoEdits) applyAmmo(edit);
  for (const edit of patch.weaponEdits) applyWeapon(edit.index, edit.ammoType);
  applyMisc(patch.misc);
  applyObituaries(patch.strings);
  applyLockedLines(patch.strings);
  for (const [name, lump] of patch.soundLumps) setSoundLump(name, lump);
  for (const [mnemonic, lump] of patch.musicLumps) setMusicLump(mnemonic, lump);
  for (const [name, to] of patch.spriteRenames) setSpriteLump(name, to);
  // After the `Thing` loop, whose `Speed` scaling it composes with, and before the rebuild below,
  // which derives from the durations it writes.
  applyFrames(patch.frameEdits, patch.thingEdits, patch.weaponEdits);
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
    // The membership this record *ends* with, not the one it started with: `Bits` is applied last
    // (it needs the patched height), so a record that turns a prop solid and resizes it in one go
    // would otherwise write no override and leave it at the shared 16 units.
    const solid = edit.bits === undefined ? SOLID_DECORATION_TYPES.has(dn) : isSolidDecoration(edit.bits);
    if (solid) SOLID_DECORATION_RADIUS_OVERRIDE[dn] = edit.radius;
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

  if (edit.sounds) applySounds(stats, inert, edit.sounds);
  if (edit.bits !== undefined) applyBits(dn, edit.bits, edit.height ?? stats?.height ?? inert?.height);
}

/**
 * A `Thing` record's sound fields, onto `MonsterSounds` and — for the two types that carry their
 * own pain/death sounds outside the stat table — `INERT_SHOOTABLE`. A `null` is `sfx_None`, and
 * deletes the field rather than setting it, which is what makes the monster silent there.
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
 * Every `OB_*` string the patch set, onto the `DamageCause` line each one replaces. Whole lines,
 * not names: `OBITUARIES` is shaped that way precisely so a patch has something to replace.
 *
 * The text is written about a third-person victim (ZDoom's `%o was squished.`) and this overlay
 * has one player and speaks to them, so the tokens go to second person and the line is capitalised
 * wherever `%o` left it. One verb then disagrees and gets corrected — `you was` becomes
 * `you were` — and that single rule covers both reference sets end to end; see
 * docs/dehacked.md § Obituaries for the audit behind it.
 */
function applyObituaries(strings: ReadonlyMap<string, string>): void {
  for (const [mnemonic, sink] of Object.entries(OBITUARY_SINKS)) {
    const text = strings.get(mnemonic);
    if (text === undefined) continue;
    const line = text
      .replace(/%hself|%[oghps]/g, (token) => OBITUARY_TOKENS[token])
      .trim()
      .replace(/\byou was\b/, 'you were');
    OBITUARIES[sink] = line.charAt(0).toUpperCase() + line.slice(1);
  }
}

/**
 * Every `PD_*` string the patch set, onto the locked-door line it names. No transform: unlike an
 * `OB_*` these are already whole second-person sentences addressed to the player, and the color
 * words `ui/hud/message.ts` picks out are found in the finished text rather than composed into it.
 * docs/dehacked.md § Locked-door lines.
 */
function applyLockedLines(strings: ReadonlyMap<string, string>): void {
  for (const mnemonic of Object.keys(LOCKED_LINES)) {
    const text = strings.get(mnemonic);
    if (text !== undefined) LOCKED_LINES[mnemonic] = text;
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
 * `Weapon N`'s ammo type. Its five state pointers are applied by `applyFrames` instead, which walks
 * the repointed fire chain — docs/dehacked.md § Weapon, Ammo and Misc.
 *
 * An index of -1 is "the record wrote no `Ammo type` line" and leaves the weapon's own class alone;
 * without that guard a record that only repoints frames would disarm the weapon.
 */
function applyWeapon(index: number, ammoIndex: number): void {
  const id = WEAPON_ORDER[index];
  if (!id || ammoIndex < 0) return;
  // vanilla's `am_noammo` is 5, past the four real classes — the fist and chainsaw use it.
  WEAPONS[id].ammoType = AMMO_ORDER[ammoIndex] ?? null;
}

/** Structural equality over the small plain values the tables hold. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Writes `value` under `key`, or deletes the key for null — one entry of a diff. */
function put<T>(table: Record<number | string, T>, key: number | string, value: T | null | undefined): void {
  if (value === null || value === undefined) delete table[key];
  else table[key] = structuredClone(value);
}

/**
 * Writes a patch's frame edits into the engine's tables: derive from the patched frame table,
 * derive from vanilla's, and write only what differs. The diff is what keeps a hand-curated entry
 * the walker reads differently (docs/dehacked.md § Frames lists them) and every unpatched type
 * exactly as they were.
 *
 * A patch with no frame edits at all returns before cloning the 967-row table: `resetDehacked`
 * runs immediately before this and has already refilled every sink from vanilla.
 */
export function applyFrames(
  frameEdits: readonly DehFrameEdit[],
  thingEdits: readonly DehThingEdit[],
  weaponEdits: readonly DehWeaponEdit[] = [],
): void {
  const repointed = thingEdits.some((edit) => edit.states) || weaponEdits.some((edit) => edit.states);
  if (frameEdits.length === 0 && !repointed) return;

  const patched = patchStates(frameEdits, thingEdits, weaponEdits);
  // Only a `Frame` record can move a fullbright bit — a `Thing` state repoint moves pointers
  // between rows, never the rows' own sprite/frame words.
  if (frameEdits.length > 0) rebuildFullbrightFrames(patched.states);

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
    if (rate && !same(before.weapons[index], rate)) WEAPONS[id].cooldown = rate.cooldown;
  }
  for (const key of Object.keys(after.sprites)) {
    const dn = Number(key);
    if (!same(before.sprites[dn], after.sprites[dn])) THING_SPRITES[dn] = after.sprites[dn];
  }
  for (const key of Object.keys(after.anims)) {
    const dn = Number(key);
    if (!same(before.anims[dn], after.anims[dn])) put(THING_ANIM_FRAMES, dn, after.anims[dn]);
  }
  for (const sprite of Object.keys(after.missiles)) {
    if (!same(before.missiles[sprite], after.missiles[sprite])) writeMissile(sprite, before.missiles[sprite], after.missiles[sprite]);
  }
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
  if (b.sprite !== undefined && a.sprite !== b.sprite) THING_SPRITES[dn] = b.sprite;
  if (!same(a.walk, b.walk)) put(MONSTER_WALK_FRAMES_OVERRIDE, dn, same(b.walk, MONSTER_WALK_FRAMES) || b.walk.length === 0 ? null : b.walk);
  if (!same(a.idle, b.idle)) put(MONSTER_IDLE_FRAMES, dn, b.idle);
  if (!same(a.death, b.death)) put(MONSTER_DEATH_FRAMES, dn, b.death);
  if (!same(a.xdeath, b.xdeath)) put(MONSTER_XDEATH_FRAMES, dn, b.xdeath);
  if (!same(a.deathSprite, b.deathSprite)) put(MONSTER_DEATH_SPRITE_OVERRIDE, dn, b.deathSprite);
  if (a.vanishes !== b.vanishes) {
    if (b.vanishes) MONSTER_CORPSE_VANISHES.add(dn);
    else MONSTER_CORPSE_VANISHES.delete(dn);
  }
  if (!same(a.pain, b.pain)) put(MONSTER_PAIN_FRAMES, dn, b.pain);
  if (!same(a.meleePose, b.meleePose) || !same(a.rangedPose, b.rangedPose)) {
    const pose: { melee?: AttackPose; ranged?: AttackPose } = {};
    if (b.meleePose) pose.melee = b.meleePose;
    if (b.rangedPose) pose.ranged = b.rangedPose;
    put(MONSTER_ATTACK_POSE, dn, Object.keys(pose).length ? pose : null);
  }
  if (!same(a.raise, b.raise)) put(MONSTER_RAISE_FRAMES, dn, b.raise);

  const stats = MONSTER_STATS[dn];
  if (!stats) return;
  if (a.painDuration !== b.painDuration) stats.painDuration = b.painDuration;
  if (stats.melee && b.meleeDuration !== null && a.meleeDuration !== b.meleeDuration) stats.melee.duration = b.meleeDuration;
  if (stats.ranged && b.rangedDuration !== null && a.rangedDuration !== b.rangedDuration) stats.ranged.duration = b.rangedDuration;
  // Only where the type already models a windup: the lost soul's charge and the pain elemental's
  // spawn never read it (see their `MONSTER_STATS` entries), so writing one would be a trap.
  if (stats.ranged?.startDelaySeconds !== undefined && a.rangedDelay !== b.rangedDelay) {
    stats.ranged.startDelaySeconds = b.rangedDelay ?? 0;
  }
  // A volley's shape follows its chain too: how many `A_*Attack` calls it carries and how far
  // apart they sit. Only where the type already models one — a single-shot attack leaves both
  // unset and reads as vanilla's default of one shot.
  if (stats.ranged?.shots !== undefined && a.rangedShots !== b.rangedShots) stats.ranged.shots = b.rangedShots;
  if (stats.ranged?.shotInterval !== undefined && b.rangedInterval !== null && a.rangedInterval !== b.rangedInterval) {
    stats.ranged.shotInterval = b.rangedInterval;
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
 * One missile's changed art. A patched flight sprite moves the missile to a new key in every
 * sprite-keyed table — `applyMissile`'s fan-out, plus the two tables the walker doesn't derive
 * (`PROJECTILE_RADIUS`, `PROJECTILE_SOUNDS`), which carry over under the new name.
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
