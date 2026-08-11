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
  POWER_IDS,
  createInventory,
  type AmmoType,
  type Inventory,
  type KeyColor,
  type PowerId,
  type WeaponId,
} from './inventory.ts';
import type { Mover, LightState } from './specials.ts';
import type { LevelKillItemStats } from './things/defs.ts';
import type { Projectile } from './spritefxdefs.ts';
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
  keys: KeyColor[];
  weapons: WeaponId[];
  currentWeapon: WeaponId;
  powers: Record<PowerId, number>;
  backpack: boolean;
}

/** `WeaponSystem`'s private fire-timing state — the restore twin of `beginLevel`'s reset list. */
export interface WeaponsSnapshot {
  cooldownTics: number;
  lastWeapon: WeaponId;
  previousWeapon: WeaponId | null;
  sawIdleTimer: number;
  refire: number;
  refireWeapon: WeaponId | null;
}

/**
 * The mutable `Sector`/`SideDef` fields specials rewrite at runtime, one entry
 * per sector, saved verbatim. Applied to the freshly loaded `DoomMap` *before*
 * the mesh build so everything downstream bakes restored geometry —
 * docs/savegames.md § Apply order.
 */
export interface SectorsSnapshot {
  floorHeight: number[];
  ceilHeight: number[];
  light: number[];
  special: number[];
  floorTex: string[];
}

export interface SpecialsSnapshot {
  /** `[sectorIndex, mover]` entries; `Mover` is plain data throughout (see its export note). */
  movers: [number, Mover][];
  usedOnce: number[];
  /** `[lineIndex, secondsLeft]` for switches currently showing their on-texture. */
  switchFlashes: [number, number][];
  lightStates: [number, LightState][];
  moveSoundTimer: number;
  crushDamageTimer: number;
  prevX: number;
  prevY: number;
}

/**
 * The mutable AI/damage state of a killable thing (a monster or a barrel).
 * Present on a `ThingState` exactly when the live thing's `health` was finite;
 * everything here stays at `pushThing`'s spawn defaults for any other thing.
 */
export interface MonsterFields {
  health: number;
  angle: number;
  dead: boolean;
  deadTime: number;
  deathFrameCount: number;
  barrelExploded: boolean;
  explodeSource: { id: number; type: number } | null;
  velX: number;
  velY: number;
  velZ: number;
  alerted: boolean;
  lookTimer: number;
  targetId: number | null;
  attackPause: number;
  burstLeft: number;
  burstTimer: number;
  chargeTimer: number;
  chargeAngle: number;
  painTimer: number;
  inFloat: boolean;
  movedir: number;
  movecount: number;
  chaseTimer: number;
  moveBlocked: boolean;
  threshold: number;
  justHit: boolean;
  justAttacked: boolean;
  reactionTicks: number;
  refiring: boolean;
  homingBias: boolean;
  walkSoundTimer: number;
  walkSoundStep: number;
}

/**
 * One `PosedThing`, saved in `posed` order so ids stay implicit — the array
 * index *is* `PosedThing.id`, which is what keeps every saved `targetId`/
 * `sourceId` reference valid. Type-derived fields (`anim`, `scale`,
 * `blockRadius`, the frame tables) are never saved; `pushThing` re-derives
 * them on restore. The flags are present only when true: a 10k-thing map pays
 * for every byte of this record (docs/savegames.md § Storage and the cap).
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
  monster?: MonsterFields;
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
  /** Index into `IconSnapshot.targets` — the live cube holds an object reference into that array. */
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

export interface GameSnapshot {
  levelTime: number;
  cameraYawDeg: number;
  /** Carried through so a `?pos=` run can't become best-time-eligible by being saved and restored. */
  recordsEligible: boolean;
  player: PlayerSnapshot;
  inventory: InventorySnapshot;
  weapons: WeaponsSnapshot;
  sectors: SectorsSnapshot;
  specials: SpecialsSnapshot;
  sectorEffects: { secretsFound: number; timer: number };
  fog: { runs: number[] };
  /** Sector indices of `World.soundAlertedSectors` — the live set holds `Sector` object references. */
  soundAlerted: number[];
  things: ThingsSnapshot;
  icon: IconSnapshot | null;
  projectiles: ProjectileSnapshot[];
  /** The two random-table cursors. Restored after every other step — docs/savegames.md § Apply order. */
  rng: { p: number; m: number };
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

/** Decodes `encodeRuns` output into a fresh array of `length` bytes; surplus runs past `length` are dropped. */
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

export function snapshotSectors(map: DoomMap): SectorsSnapshot {
  const s: SectorsSnapshot = { floorHeight: [], ceilHeight: [], light: [], special: [], floorTex: [] };
  for (const sector of map.sectors) {
    s.floorHeight.push(sector.floorHeight);
    s.ceilHeight.push(sector.ceilHeight);
    s.light.push(sector.light);
    s.special.push(sector.special);
    s.floorTex.push(sector.floorTex);
  }
  return s;
}

/**
 * Applies a sector snapshot to a freshly loaded `DoomMap` in place. Must run
 * *before* any geometry or world construction so everything downstream bakes
 * restored heights and lights — docs/savegames.md § Apply order.
 */
export function applySectors(map: DoomMap, s: SectorsSnapshot): void {
  for (let i = 0; i < map.sectors.length; i++) {
    const sector = map.sectors[i];
    if (s.floorHeight[i] !== undefined) sector.floorHeight = s.floorHeight[i];
    if (s.ceilHeight[i] !== undefined) sector.ceilHeight = s.ceilHeight[i];
    if (s.light[i] !== undefined) sector.light = s.light[i];
    if (s.special[i] !== undefined) sector.special = s.special[i];
    if (s.floorTex[i] !== undefined) sector.floorTex = s.floorTex[i];
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
    keys: [...inv.keys],
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
  inv.keys = new Set((s.keys ?? []).filter((k): k is KeyColor => (KEY_COLORS as readonly string[]).includes(k)));
  if (Array.isArray(s.weapons) && s.weapons.length > 0) inv.weapons = new Set(s.weapons);
  if (typeof s.currentWeapon === 'string') inv.currentWeapon = s.currentWeapon;
  for (const p of POWER_IDS) {
    const v = s.powers?.[p];
    if (Number.isFinite(v)) inv.powers[p] = decodeSeconds(v);
  }
  inv.backpack = s.backpack === true;
  return inv;
}
