/**
 * The savegame state payload: the `GameSnapshot` interface tree every
 * subsystem's `snapshot()`/`restore()` pair speaks, plus the pure encoding
 * helpers that make the awkward corners JSON-safe (Sets, `Infinity`, the fog
 * bitmap). Types and pure functions only — no THREE, no DOM — so the format
 * round-trips in Node tests. docs/savegames.md § The format and its version.
 */
import {
  AMMO_TYPES,
  KEY_COLORS,
  KEY_SLOTS,
  POWER_IDS,
  createInventory,
  keySlotColor,
  type AmmoType,
  type Inventory,
  type KeyColor,
  type KeySlot,
  type PowerId,
  type WeaponId,
} from './inventory.ts';
import { DI_NODIR } from './monsters/defs.ts';
import type { Mover, LightState } from './specials.ts';
import type { LevelKillItemStats, PosedThing } from './things/defs.ts';
import type { Projectile } from './spritefx/defs.ts';
import type { DoomMap } from '../wad/map.ts';
import type { Pos3 } from '../types.ts';

export interface PlayerSnapshot {
  x: number;
  y: number;
  z: number;
  angle: number;
  velX: number;
  velY: number;
  velZ: number;
  knockVelX: number;
  knockVelY: number;
}

/**
 * `Inventory` with its two Sets as arrays and its `Infinity` powers run
 * through the `-1` sentinel — see `encodeSeconds`.
 */
export interface InventorySnapshot {
  health: number;
  armor: number;
  armorType: 0 | 1 | 2;
  ammo: Record<AmmoType, number>;
  /**
   * Key *colors*, what saves have always stored. Still written (derived from
   * `keySlots`) so a save stays readable by builds from before card/skull
   * tracking; a reader prefers `keySlots` when present.
   */
  keys: KeyColor[];
  /**
   * Exact card/skull slots, optional per the no-`SAVE_VERSION`-bump rule
   * (docs/savegames.md § The format and its version): absent means a pre-slot
   * save, restored as both slots of each stored color — exactly what those
   * builds' merged-slot semantics meant.
   */
  keySlots?: KeySlot[];
  weapons: WeaponId[];
  currentWeapon: WeaponId;
  powers: Record<PowerId, number>;
  backpack: boolean;
}

/**
 * `WeaponSystem`'s private fire-timing and selection state — `beginLevel`'s reset list minus
 * `weaponLastFrame`, which `restore` derives from the restored inventory
 * instead (docs/savegames.md § Apply order).
 */
export interface WeaponsSnapshot {
  cooldownTics: number;
  previousWeapon: WeaponId | null;
  /**
   * The weapon last selected out of each slot, indexed like `WEAPON_SLOTS`.
   * Optional for the same no-bump reason `reloadTic` is: absent means only the
   * restored weapon's own slot is remembered, which is what a save from before
   * it restored to.
   */
  slotWeapon?: (WeaponId | null)[];
  sawIdleTimer: number;
  /**
   * Tics into the super shotgun's reload sequence, -1 for none in flight.
   * Optional because it was added without a `SAVE_VERSION` bump: absent means
   * no reload, which is exactly what a save from before it restored to.
   */
  reloadTic?: number;
  refire: number;
  refireWeapon: WeaponId | null;
}

/**
 * The mutable `Sector` fields specials rewrite at runtime. Applied to the
 * freshly loaded `DoomMap` *before* the mesh build so everything downstream
 * bakes restored geometry — docs/savegames.md § Apply order.
 */
export interface SectorSnapshot {
  floorHeight: number;
  ceilHeight: number;
  light: number;
  special: number;
  floorTex: string;
  /**
   * Only Boom's generalized ceiling changes rewrite this, so it's optional per
   * the no-`SAVE_VERSION`-bump rule: absent (every pre-Boom save, and any
   * sector whose ceiling flat is untouched) means the WAD's own.
   */
  ceilTex?: string;
}

/**
 * `[sectorIndex, fields]` for one sector that no longer matches the map as the
 * WAD authored it. Only those are saved: a restore applies them to a freshly
 * loaded map, so every sector left out is already correct — and most of a level
 * is never touched (docs/savegames.md § Storage).
 */
export type SectorEntry = [number, SectorSnapshot];

/** `SectorEffects`' own two counters; `totalSecrets` is re-counted from the map, not saved. */
export interface SectorEffectsSnapshot {
  secretsFound: number;
  timer: number;
}

export interface SpecialsSnapshot {
  /**
   * `[sectorIndex, mover]` entries for the **floor** slot; `Mover` is plain
   * data throughout (see its export note). A save written before the
   * floor/ceiling split holds every kind here, which the reader handles by
   * sorting on `mover.kind` rather than trusting the field —
   * docs/specials.md § One mover per sector.
   */
  movers: [number, Mover][];
  /**
   * The ceiling slot (doors, ceilings, crushers). Optional per the
   * no-`SAVE_VERSION`-bump rule: absent is a pre-split save, whose ceiling
   * movers are in `movers` above.
   */
  ceilingMovers?: [number, Mover][];
  usedOnce: number[];
  /** `[lineIndex, secondsLeft]` for switches currently showing their on-texture. */
  switchFlashes: [number, number][];
  lightStates: [number, LightState][];
  moveSoundTimer: number;
  crushDamageTimer: number;
  prevX: number;
  prevY: number;
  /**
   * Line indices whose generalized stair direction is flipped from the
   * authored special (Boom's retrigger alternation mutates `line.special`).
   * Optional per the no-`SAVE_VERSION`-bump rule: absent means none flipped.
   */
  stairFlips?: number[];
}

/**
 * Which `PosedThing` fields a killable thing's `MonsterFields` block can
 * carry — the one list `snapshotThings` and `restoreThings` both loop over, so
 * a field can't be saved and then not restored. Everything not named here is
 * either re-derived by `pushThing` on restore or deliberately dropped —
 * including `dead` (⟺ `health <= 0`, every death/revive site maintains it) and
 * `deathFrameCount` (recomputed by `enterDeathPose` on a restored corpse)
 * (docs/savegames.md § What is saved and what is deliberately not).
 */
export const MONSTER_SAVE_KEYS = [
  'health',
  'angle',
  'spawnX',
  'spawnY',
  'spawnAngle',
  'deadTime',
  'barrelExploded',
  'explodeSource',
  'velX',
  'velY',
  'velZ',
  'alerted',
  'lookTimer',
  'targetId',
  'attackPause',
  'burstLeft',
  'burstTimer',
  'swinging',
  'chargeTimer',
  'chargeAngle',
  'painTimer',
  'inFloat',
  'movedir',
  'movecount',
  'chaseTimer',
  'moveBlocked',
  'threshold',
  'justHit',
  'justAttacked',
  'reactionTicks',
  'refiring',
  'homingBias',
  'walkSoundTimer',
  'walkSoundStep',
] as const;

/**
 * The mutable AI/damage state of a killable thing (a monster or a barrel).
 * Present on a `ThingState` exactly when the live thing's `health` was finite;
 * everything here stays at `pushThing`'s spawn defaults for any other thing.
 * `Pick`ed off the live record rather than re-declared, so a renamed or
 * retyped `PosedThing` field is a compile error here instead of a save that
 * silently stores something else.
 */
export type MonsterFields = Pick<PosedThing, (typeof MONSTER_SAVE_KEYS)[number]>;

/**
 * Spawn defaults for the sparse encoding: a field equal to its entry here is
 * omitted from the saved block, and the restore loop lets `pushThing`'s own
 * default stand for any absent key. `pushThing` spreads this very table into
 * the thing it builds, so the elision baseline *is* the spawn record rather
 * than a copy of it — a default changed in one place and not the other would
 * otherwise elide a field that restores to something else. Mapped over the key
 * tuple so adding a key to `MONSTER_SAVE_KEYS` without deciding its default is
 * a compile error.
 * Six keys have no constant spawn default and are special-cased in
 * `snapshotThings`: `health` (per type, `spawnHealthFor`), `angle`
 * (`facingDeg` in radians, already in every `ThingState`), `homingBias`
 * (a random draw — always saved), and the three `spawn*` fields, whose default
 * is wherever this particular thing was created — so each is written only when
 * it no longer matches the `x`/`y`/`facingDeg` the same `ThingState` carries,
 * which for anything that never moved is never.
 * docs/savegames.md § The format and its version.
 */
export const MONSTER_FIELD_DEFAULTS: {
  readonly [K in Exclude<
    (typeof MONSTER_SAVE_KEYS)[number],
    'health' | 'angle' | 'homingBias' | 'spawnX' | 'spawnY' | 'spawnAngle'
  >]: MonsterFields[K];
} = {
  deadTime: 0,
  barrelExploded: false,
  explodeSource: null,
  velX: 0,
  velY: 0,
  velZ: 0,
  alerted: false,
  lookTimer: 0,
  targetId: null,
  attackPause: 0,
  burstLeft: 0,
  burstTimer: 0,
  swinging: false,
  chargeTimer: 0,
  chargeAngle: 0,
  painTimer: 0,
  inFloat: false,
  movedir: DI_NODIR,
  movecount: 0,
  chaseTimer: 0,
  moveBlocked: false,
  threshold: 0,
  justHit: false,
  justAttacked: false,
  reactionTicks: 0,
  refiring: false,
  walkSoundTimer: 0,
  walkSoundStep: 0,
};

/**
 * The keys the sparse loop can decide by table lookup — every `MONSTER_SAVE_KEYS`
 * entry except the three `MONSTER_FIELD_DEFAULTS` deliberately omits, which
 * `snapshotThings` handles on its own.
 */
export const MONSTER_KEYS_WITH_DEFAULTS = Object.keys(MONSTER_FIELD_DEFAULTS) as (keyof typeof MONSTER_FIELD_DEFAULTS)[];

/**
 * Copies one `MONSTER_SAVE_KEYS` field, in either direction — a live
 * `PosedThing` is structurally a `MonsterFields`, so this serves both the
 * snapshot and the restore loop, and a key absent from a sparse saved block is
 * a no-op (the `pushThing` spawn default stands). Generic in the key so
 * `to[key]` and `from[key]` are the *same* type at every key rather than the
 * union of all of them, which is what an inline `to[key] = from[key]` can't
 * express.
 */
export function copyMonsterField<K extends keyof MonsterFields>(
  to: Partial<MonsterFields>,
  from: Partial<MonsterFields>,
  key: K,
): void {
  const value = from[key];
  if (value !== undefined) to[key] = value;
}

/**
 * One `PosedThing`, saved in `posed` order so IDs stay implicit — the array
 * index *is* `PosedThing.id`, which is what keeps every saved `targetId`/
 * `sourceId` reference valid. Type-derived fields (`anim`, `scale`,
 * `blockRadius`, the frame tables) are never saved; `pushThing` re-derives
 * them on restore. The flags are present only when true, and the monster
 * block is sparse (`MONSTER_FIELD_DEFAULTS`): a 10k-thing map pays for every
 * byte of this record (docs/savegames.md § Storage).
 */
export interface ThingState {
  type: number;
  x: number;
  y: number;
  z: number;
  facingDeg: number;
  picked?: boolean;
  hidden?: boolean;
  dropped?: boolean;
  ambush?: boolean;
  monster?: Partial<MonsterFields>;
}

export interface ThingsSnapshot {
  clock: number;
  stats: LevelKillItemStats;
  things: ThingState[];
}

export interface CubeState {
  x: number;
  y: number;
  z: number;
  angleRad: number;
  /**
   * Index into `IconSnapshot.targets` — the live cube holds an object reference into that array.
   */
  targetIndex: number;
  remaining: number;
  soundTimer: number;
}

export interface IconSnapshot {
  targets: Pos3[];
  targetIndex: number;
  easy: boolean;
  awake: boolean;
  spitTimer: number;
  exitTimer: number;
  explodeTimer: number;
  cubes: CubeState[];
}

/** A `Projectile` minus its animator, which restore rebuilds from `sprite`. */
export type ProjectileSnapshot = Omit<Projectile, 'anim'>;

/**
 * A teleport-fog puff mid-animation: where it is and how far into its ~1.7 s it
 * has got. The animator, the sector light and `drawPrev*` are all re-derived by
 * the ordinary `spawn` on restore rather than saved — a fog never moves, so
 * `drawPrev*` is its own position, and re-sampling the light picks up a sector
 * whose lighting has since changed. docs/savegames.md § What is saved and what
 * is deliberately not.
 */
export interface TeleportFogState extends Pos3 {
  elapsed: number;
}

export interface GameSnapshot {
  levelTime: number;
  cameraYawDeg: number;
  /**
   * Carried through so a `?pos=` run can't become best-time-eligible by being saved and restored.
   */
  recordsEligible: boolean;
  player: PlayerSnapshot;
  inventory: InventorySnapshot;
  weapons: WeaponsSnapshot;
  /** Only the sectors that differ from the freshly loaded map — see `snapshotSectors`. */
  sectors: SectorEntry[];
  specials: SpecialsSnapshot;
  sectorEffects: SectorEffectsSnapshot;
  /** `encodeRuns` of the fog-of-war `explored` bitmap. */
  fog: number[];
  /**
   * Sector indices of `World.soundAlertedSectors` — the live set holds `Sector` object references.
   */
  soundAlerted: number[];
  things: ThingsSnapshot;
  icon: IconSnapshot | null;
  projectiles: ProjectileSnapshot[];
  /**
   * The teleport fogs still playing — the one `SpriteFxLayer` transient long
   * enough (~1.7 s) to be caught mid-animation by a save. Optional because it
   * was added without a `SAVE_VERSION` bump: absent means no fogs, which is
   * exactly what a save from before it restored to.
   */
  teleportFogs?: TeleportFogState[];
  /**
   * Where the level's voodoo dolls have been carried to, in map order. Optional
   * because it was added without a `SAVE_VERSION` bump: absent means every doll
   * is still standing on its own player start, which is exactly what a save
   * from before dolls existed restored to.
   */
  voodoo?: VoodooSnapshot[];
  /**
   * The accelerative scrollers' built-up speed, `[scrollerIndex, vdx, vdy]` for
   * each one that has any. Optional because it was added without a
   * `SAVE_VERSION` bump: absent means every integrator is at zero, which is
   * what a save from before it restored to.
   */
  scrollers?: ScrollerSnapshot[];
  /**
   * The cheats currently switched on. Optional because it was added without a
   * `SAVE_VERSION` bump — and written only while one *is* on, so an honest run
   * saves nothing: absent means neither cheat, which is exactly what a save
   * from before them restored to. docs/cheats.md § Saves and best times.
   */
  cheats?: CheatSnapshot;
  /**
   * The two random-table cursors. Restored after every other step — docs/savegames.md § Apply
   * order.
   */
  rng: { p: number; m: number };
}

/**
 * IDDQD's and IDCLIP's toggles — `game/cheats.ts`. IDKFA leaves nothing behind but the inventory it
 * filled.
 */
export interface CheatSnapshot {
  god: boolean;
  noclip: boolean;
}

/**
 * One accelerative scroller's integrator: its index in the level's spawn order,
 * then `vdx`/`vdy` — `game/specials/forces.ts`. A tuple rather than a record
 * because a conveyor-heavy map can carry hundreds and this rides in every save
 * of it.
 */
export type ScrollerSnapshot = [number, number, number];

/** One voodoo doll's mutable state — `game/voodoo.ts`. */
export interface VoodooSnapshot {
  x: number;
  y: number;
  z: number;
  angle: number;
  momX: number;
  momY: number;
}

/**
 * `JSON.stringify(Infinity)` silently yields `null`, so every possibly-forever
 * duration (the berserk/computer-map powers) goes through this `-1` sentinel
 * instead. docs/savegames.md § The format and its version.
 */
export function encodeSeconds(seconds: number): number {
  return seconds === Infinity ? -1 : seconds;
}

export function decodeSeconds(encoded: number): number {
  return encoded === -1 ? Infinity : encoded;
}

/**
 * `JSON.stringify` replacer that rounds every number to 6 decimals —
 * dt-accumulated doubles otherwise serialize with 17-digit tails, and those
 * tails are most of a float's JSON cost. 6 decimals keeps the error at 1e-6 map
 * units/radians/seconds, far below anything observable (collision radii are
 * 16+, a tic is 1/35 s). Integers — sector heights, the RNG cursors, the `-1`
 * sentinel — pass through exactly; everything else is untouched. A replacer
 * rather than a pass over the tree: the rounding only ever matters in the
 * stored text, and a second copy of the largest object the feature builds is
 * the last thing to allocate next to the quota this exists to protect.
 * docs/savegames.md § The format and its version.
 */
export function roundFloat(_key: string, value: unknown): unknown {
  return typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value;
}

/**
 * Run-length encodes a 0/1 byte array (the fog-of-war `explored` bitmap) as
 * alternating run lengths, the first run counting zeros — a possibly-empty
 * first run, so an array starting with 1s encodes as `[0, n, ...]`. Chosen
 * over base64 because the result is JSON-native numbers.
 */
export function encodeRuns(data: Uint8Array): number[] {
  const runs: number[] = [];
  let value = 0;
  let run = 0;
  for (let i = 0; i < data.length; i++) {
    const bit = data[i] === 0 ? 0 : 1;
    if (bit === value) {
      run++;
      continue;
    }
    runs.push(run);
    value = bit;
    run = 1;
  }
  if (run > 0) runs.push(run);
  return runs;
}

/**
 * Decodes `encodeRuns` output into a fresh array of `length` bytes; surplus runs past `length` are
 * dropped.
 */
export function decodeRuns(runs: number[], length: number): Uint8Array {
  const data = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < runs.length && at < length; i++) {
    const run = Math.min(Math.max(0, runs[i]), length - at);
    if (i % 2 === 1) data.fill(1, at, at + run);
    at += run;
  }
  return data;
}

/**
 * Every sector's savable fields in index order, taken off a map. `Game` takes
 * one of these per level load, straight out of `loadMap` and before anything
 * has run — that is the baseline `snapshotSectors` diffs against, and it is
 * exactly the state a later restore's `applySectors` writes into.
 */
export function sectorBaseline(map: DoomMap): SectorSnapshot[] {
  return map.sectors.map((sector) => ({
    floorHeight: sector.floorHeight,
    ceilHeight: sector.ceilHeight,
    light: sector.light,
    special: sector.special,
    floorTex: sector.floorTex,
    ceilTex: sector.ceilTex,
  }));
}

/**
 * The sectors that no longer match `baseline`, as `[index, fields]`. A whole
 * level's sectors written out cost ~24 KB of JSON on DOOM2 MAP15 and are
 * identical to the freshly loaded map in all but the handful a door, lift or
 * light has touched — so only those are stored (docs/savegames.md § Storage).
 */
export function snapshotSectors(map: DoomMap, baseline: SectorSnapshot[]): SectorEntry[] {
  const out: SectorEntry[] = [];
  for (let i = 0; i < map.sectors.length; i++) {
    const sector = map.sectors[i];
    const was = baseline[i] as SectorSnapshot | undefined;
    if (
      was &&
      sector.floorHeight === was.floorHeight &&
      sector.ceilHeight === was.ceilHeight &&
      sector.light === was.light &&
      sector.special === was.special &&
      sector.floorTex === was.floorTex &&
      sector.ceilTex === was.ceilTex
    ) {
      continue;
    }
    out.push([
      i,
      {
        floorHeight: sector.floorHeight,
        ceilHeight: sector.ceilHeight,
        light: sector.light,
        special: sector.special,
        floorTex: sector.floorTex,
        ceilTex: sector.ceilTex,
      },
    ]);
  }
  return out;
}

/**
 * Applies saved sector entries to a freshly loaded `DoomMap` in place; a sector
 * with no entry is left as the WAD authored it, which is what the sparse format
 * means. Must run *before* any geometry or world construction so everything
 * downstream bakes restored heights and lights — docs/savegames.md § Apply order.
 */
export function applySectors(map: DoomMap, entries: SectorEntry[]): void {
  for (const entry of entries) {
    const sector = map.sectors[entry?.[0]];
    const saved = entry?.[1];
    if (!sector || !saved) continue;
    sector.floorHeight = saved.floorHeight;
    sector.ceilHeight = saved.ceilHeight;
    sector.light = saved.light;
    sector.special = saved.special;
    sector.floorTex = saved.floorTex;
    if (saved.ceilTex !== undefined) sector.ceilTex = saved.ceilTex;
  }
}

export function serializeInventory(inv: Inventory): InventorySnapshot {
  const powers = {} as Record<PowerId, number>;
  for (const p of POWER_IDS) powers[p] = encodeSeconds(inv.powers[p]);
  return {
    health: inv.health,
    armor: inv.armor,
    armorType: inv.armorType,
    ammo: { ...inv.ammo },
    keys: [...new Set([...inv.keys].map(keySlotColor))],
    keySlots: [...inv.keys],
    weapons: [...inv.weapons],
    currentWeapon: inv.currentWeapon,
    powers,
    backpack: inv.backpack,
  };
}

/**
 * Rebuilds an `Inventory` from its snapshot, starting from `createInventory`'s
 * defaults so a field a malformed save lacks degrades to the new-game value
 * rather than `undefined` — the same fail-soft stance `besttimes.ts` takes on
 * its own records.
 */
export function deserializeInventory(s: InventorySnapshot): Inventory {
  const inv = createInventory();
  if (Number.isFinite(s.health)) inv.health = s.health;
  if (Number.isFinite(s.armor)) inv.armor = s.armor;
  if (s.armorType === 0 || s.armorType === 1 || s.armorType === 2) inv.armorType = s.armorType;
  for (const t of AMMO_TYPES) {
    if (Number.isFinite(s.ammo?.[t])) inv.ammo[t] = s.ammo[t];
  }
  inv.keys = Array.isArray(s.keySlots)
    ? new Set(s.keySlots.filter((k): k is KeySlot => (KEY_SLOTS as readonly string[]).includes(k)))
    : new Set(
        (s.keys ?? [])
          .filter((k): k is KeyColor => (KEY_COLORS as readonly string[]).includes(k))
          .flatMap((c): KeySlot[] => [`${c}Card`, `${c}Skull`]),
      );
  if (Array.isArray(s.weapons) && s.weapons.length > 0) inv.weapons = new Set(s.weapons);
  if (typeof s.currentWeapon === 'string') inv.currentWeapon = s.currentWeapon;
  for (const p of POWER_IDS) {
    const v = s.powers?.[p];
    if (Number.isFinite(v)) inv.powers[p] = decodeSeconds(v);
  }
  inv.backpack = s.backpack === true;
  return inv;
}
