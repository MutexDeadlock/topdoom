/**
 * The savegame state payload: the {@link GameSnapshot} interface tree every subsystem's
 * `snapshot()`/`restore()` pair speaks, plus the pure encoding helpers that make the awkward
 * corners JSON-safe (Sets, `Infinity`, the fog bitmap). Types and pure functions only — no THREE,
 * no DOM — so the format round-trips in Node tests.
 * docs/savegames.md § The format and its version.
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
import type { DamageCause } from './combat.ts';
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
 * {@link Inventory} with its two Sets as arrays and its `Infinity` powers run through the `-1`
 * sentinel — see {@link encodeSeconds}.
 */
export interface InventorySnapshot {
  health: number;
  armor: number;
  armorType: 0 | 1 | 2;
  ammo: Record<AmmoType, number>;
  /**
   * Key *colors*, written (derived from {@link InventorySnapshot.keySlots}) so a save stays
   * readable by builds from before card/skull tracking; a reader prefers
   * {@link InventorySnapshot.keySlots} when present.
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
   * The weapon last selected out of each slot, indexed like `WEAPON_SLOTS`. Optional for the same
   * no-bump reason {@link WeaponsSnapshot.reloadTic} is: absent means only the restored weapon's
   * own slot is remembered, which is what a save from before it restored to.
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
  /**
   * Whether a fire chain is still waiting for its `A_ReFire`. One tic wide and
   * invisible to a player reloading a save, but a replay's keyframe has to land
   * on the tic the recording ran (docs/replays.md § Seeking). Optional because
   * it was added without a `SAVE_VERSION` bump: absent means no chain, which is
   * what a save from before it restored to.
   */
  chainEnding?: boolean;
}

/**
 * The mutable `Sector` fields specials rewrite at runtime. Applied to the freshly loaded
 * {@link DoomMap} *before* the mesh build so everything downstream bakes restored geometry —
 * docs/savegames.md § Apply order.
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

/** `SectorEffects`' own counters; `totalSecrets` is re-counted from the map, not saved. */
export interface SectorEffectsSnapshot {
  secretsFound: number;
  /** Each slot's damage-floor countdown, by slot. */
  timers: number[];
}

export interface SpecialsSnapshot {
  /**
   * `[sectorIndex, mover]` entries for the **floor** slot; {@link Mover} is plain data throughout
   * (see its export note). A save written before the floor/ceiling split holds every kind here,
   * which the reader handles by sorting on {@link Mover.kind} rather than trusting the field —
   * docs/specials.md § One mover per sector.
   */
  movers: [number, Mover][];
  /**
   * The ceiling slot (doors, ceilings, crushers). Optional per the no-`SAVE_VERSION`-bump rule:
   * absent is a pre-split save, whose ceiling movers are in {@link SpecialsSnapshot.movers} above.
   */
  ceilingMovers?: [number, Mover][];
  usedOnce: number[];
  /** `[lineIndex, secondsLeft]` for switches currently showing their on-texture. */
  switchFlashes: [number, number][];
  lightStates: [number, LightState][];
  moveSoundTimer: number;
  crushDamageTimer: number;
  /** Where each slot's walk-trigger crossing test starts from next tic, by slot. */
  prev: [x: number, y: number][];
  /**
   * Line indices whose generalized stair direction is flipped from the
   * authored special (Boom's retrigger alternation mutates `line.special`).
   * Optional per the no-`SAVE_VERSION`-bump rule: absent means none flipped.
   */
  stairFlips?: number[];
}

/**
 * Which {@link PosedThing} fields a killable thing's {@link MonsterFields} block can carry — the
 * one list `snapshotThings` and `restoreThings` both loop over, so a field can't be saved and then
 * not restored. Everything else, {@link PosedThing.dead} and {@link PosedThing.deathFrameCount}
 * among it, is re-derived on restore or deliberately dropped
 * (docs/savegames.md § What is saved and what is deliberately not).
 */
export const MONSTER_SAVE_KEYS = [
  'health',
  'angle',
  'spawnX',
  'spawnY',
  'spawnAngle',
  'deadTime',
  'crushed',
  'barrelExploded',
  'explodeSource',
  'velX',
  'velY',
  'velZ',
  'alerted',
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
 * The mutable AI/damage state of a killable thing (a monster or a barrel). Present on a
 * {@link ThingState} exactly when the live thing's {@link PosedThing.health} was finite;
 * everything here stays at `pushThing`'s spawn defaults for any other thing. `Pick`ed off the live
 * record rather than re-declared, so a renamed or retyped {@link PosedThing} field is a compile
 * error here instead of a save that silently stores something else.
 */
export type MonsterFields = Pick<PosedThing, (typeof MONSTER_SAVE_KEYS)[number]>;

/**
 * Spawn defaults for the sparse encoding: a field equal to its entry here is omitted from the saved
 * block. `pushThing` spreads this very table into the thing it builds, so the elision baseline *is*
 * the spawn record rather than a copy of it. Mapped over the key tuple, so adding a key to
 * {@link MONSTER_SAVE_KEYS} without deciding its default is a compile error.
 *
 * Six keys have no constant spawn default and are special-cased in `snapshotThings`:
 * {@link PosedThing.health} (per type), {@link PosedThing.angle} (already in every
 * {@link ThingState}), {@link PosedThing.homingBias} (a random draw, always saved), and the three
 * `spawn*` fields, written only where they no longer match the
 * {@link ThingState.x}/{@link ThingState.y}/{@link ThingState.facingDeg} beside them.
 * docs/savegames.md § The format and its version.
 */
export const MONSTER_FIELD_DEFAULTS: {
  readonly [K in Exclude<
    (typeof MONSTER_SAVE_KEYS)[number],
    'health' | 'angle' | 'homingBias' | 'spawnX' | 'spawnY' | 'spawnAngle'
  >]: MonsterFields[K];
} = {
  deadTime: 0,
  // Absent from a block written before crushed corpses existed, which reads back as a corpse no
  // plane has caught — the behavior those saves were written under.
  crushed: false,
  barrelExploded: false,
  // Also what a block written before a barrel carried its player holds for a player's kill: that
  // blast's kills count for nobody.
  explodeSource: null,
  velX: 0,
  velY: 0,
  velZ: 0,
  alerted: false,
  targetId: -1,
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
 * The keys the sparse loop can decide by table lookup — every {@link MONSTER_SAVE_KEYS} entry
 * except those {@link MONSTER_FIELD_DEFAULTS} deliberately omits, which `snapshotThings` decides on
 * its own (that table's doc names them).
 */
export const MONSTER_KEYS_WITH_DEFAULTS = Object.keys(MONSTER_FIELD_DEFAULTS) as (keyof typeof MONSTER_FIELD_DEFAULTS)[];

/**
 * Copies one {@link MONSTER_SAVE_KEYS} field, in either direction — a live {@link PosedThing} is
 * structurally a {@link MonsterFields}, so this serves both the snapshot and the restore loop, and
 * a key absent from a sparse saved block is a no-op (the `pushThing` spawn default stands).
 * Generic in the key so `to[key]` and `from[key]` are the *same* type at every key rather than the
 * union of all of them, which is what an inline `to[key] = from[key]` can't express.
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
 * One {@link PosedThing}, saved in `posed` order so IDs stay implicit — the array index *is*
 * {@link PosedThing.id}, which is what keeps every saved
 * {@link PosedThing.targetId}/{@link Projectile.sourceId} reference valid. Type-derived fields
 * ({@link PosedThing.anim}, {@link PosedThing.scale}, {@link PosedThing.blockRadius}, the frame
 * tables) are never saved; `pushThing` re-derives them on restore. The flags are present only when
 * true, and the monster block is sparse ({@link MONSTER_FIELD_DEFAULTS}): a 10k-thing map pays for
 * every byte of this record (docs/savegames.md § Storage).
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
  /**
   * Only the things no longer as this map spawned them, as `[id, state]` pairs in ascending id.
   * A restore re-spawns the level from the map and reads these over it, so a thing nothing has
   * touched costs nothing; an id past the spawn count is one the run itself made, and is pushed in
   * order. A save holding the whole list this replaced is refused as damaged.
   * docs/savegames.md § The format and its version.
   */
  changed: [number, ThingState][];
  /**
   * The items waiting to come back in a deathmatch, oldest first, each with the tic it was taken
   * on — written only while there are any. docs/multiplayer-deathmatch.md § Item respawn.
   */
  itemRespawn?: [id: number, tic: number][];
  /**
   * Every monster's {@link PosedThing.lastlook}, one digit each in `posed` order. Not a field of
   * the monster block: nearly every monster's turns with its first look, so a block each would
   * carry the whole level. docs/savegames.md § The format and its version.
   */
  lastlook: string;
}

export interface CubeState {
  x: number;
  y: number;
  z: number;
  angleRad: number;
  /**
   * Index into {@link IconSnapshot.targets} — the live cube holds an object reference into that
   * array.
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

/**
 * A {@link Projectile} minus its animator, which restore rebuilds from {@link Projectile.sprite}.
 * Its {@link Projectile.sourceId} and homing `targetId` are target ids as the live record holds
 * them, a player slot as `targetOfSlot` (docs/multiplayer.md § Slot addressing).
 * docs/savegames.md § The format and its version.
 */
export type ProjectileSnapshot = Omit<Projectile, 'anim'>;

/**
 * A teleport-fog puff mid-animation: where it is and how far into its ~2 s it has got. The
 * animator, the sector light and `drawPrev*` are re-derived by the ordinary `spawn` on restore — a
 * fog never moves. docs/savegames.md § What is saved and what is deliberately not.
 */
export interface TeleportFogState extends Pos3 {
  elapsed: number;
}

/** One player slot's share of a {@link GameSnapshot}. */
export interface PlayerSlotSnapshot {
  player: PlayerSnapshot;
  inventory: InventorySnapshot;
  weapons: WeaponsSnapshot;
  /** Where the slot's camera orbit is heading — `PlayerSlot.snapshot`. */
  cameraYawDeg: number;
  /**
   * A corpse waiting to respawn, lying where {@link PlayerSlotSnapshot.player} says.
   * docs/multiplayer-coop.md § Respawn.
   */
  dead: boolean;
  /**
   * What killed the corpse ({@link PlayerSlotSnapshot.dead}), written only where something is
   * blamed: absent is an unattributed death, a living slot, a save from before the field. No tic
   * reads it — it is the death overlay's killer line. docs/death.md § Who killed the player.
   */
  deathCause?: DamageCause;
  /**
   * The corpse ({@link PlayerSlotSnapshot.dead}) gibbed, written only then: absent is the plain
   * death chain, a living slot, a save from before the gib. No tic reads it.
   * docs/death.md § Player death.
   */
  gibbed?: boolean;
  /**
   * The cheats switched on, written only while one is: an honest slot saves nothing, and absent
   * means neither cheat. docs/cheats.md § Saves and best times.
   */
  cheats?: CheatSnapshot;
  /**
   * `PlayerSlot.kills`, written only once there is one: absent is none — a single-player save, a
   * joiner's fresh slot, a save from before the count. docs/multiplayer-coop.md § Items and kills.
   */
  kills?: number;
  /**
   * `PlayerSlot.frags`, written only once one entry is: absent is a row of zeros — a coop save, a
   * save from before deathmatch. docs/multiplayer-deathmatch.md § Frags.
   */
  frags?: number[];
}

export interface GameSnapshot {
  levelTime: number;
  /**
   * Whether this level's run is disqualified from best times — a cheat, a `?pos=` start, a replay
   * taken over. Carried through so none of them can be laundered by saving and restoring.
   * docs/hud.md § Best times.
   */
  cheated: boolean;
  /**
   * Whether the level runs as a netgame: which things spawn depends on it, so it decides every
   * thing id in {@link GameSnapshot.things} and a restore runs under it. docs/multiplayer-coop.md.
   */
  netgame: boolean;
  /**
   * Whether the netgame is a deathmatch, written only when it is: part of thing identity like
   * {@link GameSnapshot.netgame}, and absent in every save from before it.
   * docs/multiplayer-deathmatch.md.
   */
  deathmatch?: true;
  /** Every player slot, by slot — how many there are is the snapshot's to say. */
  players: PlayerSlotSnapshot[];
  /** Only the sectors that differ from the freshly loaded map — see {@link snapshotSectors}. */
  sectors: SectorEntry[];
  specials: SpecialsSnapshot;
  sectorEffects: SectorEffectsSnapshot;
  /** {@link encodeRuns} of the fog-of-war `explored` bitmap. */
  fog: number[];
  /**
   * {@link encodeRuns} of the fog's `undrawn` bitmap — explored leaves seen only past a covering
   * midtexture, a draw state. Optional because it was added without a `SAVE_VERSION` bump: absent
   * means every explored leaf is drawn, exactly what a save from before it restored to.
   * docs/fogofwar.md § Covering midtextures.
   */
  fogUndrawn?: number[];
  /** `[sectorIndex, slot]` for every sector a noise reached — `World.snapshotSoundAlerted`. */
  soundAlerted: [sector: number, slot: number][];
  things: ThingsSnapshot;
  icon: IconSnapshot | null;
  projectiles: ProjectileSnapshot[];
  /**
   * The teleport fogs still playing — the one `SpriteFxLayer` transient long
   * enough (~2 s) to be caught mid-animation by a save. Optional because it
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

/** One voodoo doll's mutable state — `game/specials/voodoo.ts`. */
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
 * `JSON.stringify` replacer that rounds every number to 6 decimals — dt-accumulated doubles
 * otherwise serialize with 17-digit tails. Integers pass through exactly. A replacer rather than a
 * pass over the tree, so no second copy of the largest object the feature builds is allocated next
 * to the quota this exists to protect. docs/savegames.md § The format and its version.
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
 * Decodes {@link encodeRuns} output into a fresh array of `length` bytes; surplus runs past
 * `length` are dropped.
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
 * Every sector's savable fields in index order, taken off a map. `Game` takes one of these per
 * level load, straight out of `loadMap` and before anything has run — that is the baseline
 * {@link snapshotSectors} diffs against, and it is exactly the state a later restore's
 * {@link applySectors} writes into.
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
 * The sectors that no longer match `baseline`, as `[index, fields]` — most of a level is never
 * touched, so only those are stored (docs/savegames.md § Storage).
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
 * Applies saved sector entries to a freshly loaded {@link DoomMap} in place; a sector with no
 * entry is left as the WAD authored it, which is what the sparse format means. Must run *before*
 * any geometry or world construction so everything downstream bakes restored heights and lights —
 * docs/savegames.md § Apply order.
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
 * Rebuilds an {@link Inventory} from its snapshot, starting from {@link createInventory}'s
 * defaults so a field a malformed save lacks degrades to the new-game value rather than
 * `undefined` — the same fail-soft stance `besttimes.ts` takes on its own records.
 */
export function deserializeInventory(s: InventorySnapshot): Inventory {
  const inv = createInventory();
  if (Number.isFinite(s.health)) inv.health = s.health;
  if (Number.isFinite(s.armor)) inv.armor = s.armor;
  if (s.armorType === 0 || s.armorType === 1 || s.armorType === 2) {
    inv.armorType = s.armorType;
  }
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
  if (Array.isArray(s.weapons) && s.weapons.length > 0) {
    inv.weapons = new Set(s.weapons);
  }
  if (typeof s.currentWeapon === 'string') inv.currentWeapon = s.currentWeapon;
  for (const p of POWER_IDS) {
    const v = s.powers?.[p];
    if (Number.isFinite(v)) inv.powers[p] = decodeSeconds(v);
  }
  inv.backpack = s.backpack === true;
  return inv;
}
