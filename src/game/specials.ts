import * as THREE from 'three';
import { NO_SIDE, type DoomMap, type LineDef } from '../wad/map.ts';
import {
  bossDeathTriggersFor,
  computeLightSectors,
  computeMovableSectors,
  findStairChain,
  findSwitchEntries,
  isFrontSide,
  neighborSectorIndices,
  resolveTargets,
  type BossDeathTrigger,
  type SwitchEntry,
} from './specials/mapscan.ts';
import { MoverGeometry } from './specials/movergeometry.ts';
import {
  LINE_SPECIALS,
  SECTOR_LIGHT_SPECIALS,
  SECTOR_DOOR_SPECIALS,
  DOOR_SPEED,
  DOOR_SPEED_FAST,
  DOOR_WAIT,
  DOOR_OPEN_GAP,
  DOOR_CLOSE_WAIT_SECONDS,
  DOOR_RAISE_WAIT_SECONDS,
  EIGHT_UNIT_GAP,
  CRUSH_DAMAGE_INTERVAL,
  SWITCH_FLASH_SECONDS,
  TELEPORT_DEST,
  FLOOR_SPEED,
  type DoorEffect,
  type LiftEffect,
  type FloorEffect,
  type CrusherEffect,
  type StairsEffect,
  type CeilingEffect,
  type CeilingTarget,
  type LightChangeEffect,
  type MoveTarget,
  type LightPattern,
  type SectorDoorTimer,
} from '../wad/specials.ts';
import {
  World,
  lowestNeighborFloor,
  highestNeighborFloor,
  nextHigherFloor,
  nextLowerFloor,
  lowestNeighborCeiling,
  highestNeighborCeiling,
  darkestNeighborLight,
} from './world.ts';
import { PLAYER_RADIUS } from './player.ts';
import { spawnAngleDeg } from './skill.ts';
import type { Input } from './input.ts';
import type { FogOfWar } from './fogofwar.ts';
import type { KeyColor } from './inventory.ts';
import { NO_TEXTURE, type BuiltMap, type MapMeshOptions } from '../render/mapmesh.ts';
import type { SubSectorPoly } from '../render/bsp.ts';
import type { Placement, Pos2 } from '../types.ts';
import type { MaterialBank } from '../render/textures.ts';
import type { FadeTarget } from '../render/occlusion.ts';
import { segmentIntersect } from '../util/geom.ts';
import { sectorOrigin, SILENT, type SfxId, type SoundEmitter } from '../audio/sfx.ts';
import { DOOM_TIC } from '../constants.ts';

/** How far ahead of the player a `use` press reaches, in map units. */
const USE_RANGE = 64;

/**
 * Vanilla's own moving-floor/ceiling grind (`sfx_stnmov`) is retriggered on a
 * global `leveltime & 7` clock, not per mover — so every plane in motion
 * anywhere on the map emits in the *same* tic, which is why a room full of
 * rising stairs sounds like one machine rather than a dozen. `moveSoundDue`
 * below reproduces that shared clock.
 */
const MOVE_SOUND_INTERVAL = 8 * DOOM_TIC;

/**
 * A door's sounds, by whether it's one of the "blazing" (4x speed) types —
 * vanilla picks `bdopn`/`bdcls` over `doropn`/`dorcls` per special number
 * (`p_doors.c`), which maps exactly onto `DOOR_SPEED_FAST` here since those are
 * the same specials.
 */
const DOOR_SOUNDS: Record<'normal' | 'fast', { open: SfxId; close: SfxId }> = {
  normal: { open: 'doropn', close: 'dorcls' },
  fast: { open: 'bdopn', close: 'bdcls' },
};

/**
 * `holdClosed` is the mirror of `hold`: waiting at the *bottom* before
 * automatically moving again, rather than at the top. Two cases reach it —
 * a `closeThenOpen` door (16/76) after it finishes closing, and a
 * sector-type-14 door's initial 5-minute wait before its first move at all
 * (`spawnSectorDoorTimer`) — both transition to `raising` once
 * `holdRemaining` elapses, same shape as `hold`'s own transition to
 * `lowering`.
 */
type DoorState = 'raising' | 'hold' | 'holdClosed' | 'lowering' | 'open' | 'closed';
interface DoorMover {
  kind: 'door';
  sectorIndex: number;
  effect: DoorEffect;
  openHeight: number;
  closeHeight: number;
  state: DoorState;
  holdRemaining: number;
}

type LiftState = 'lowering' | 'hold' | 'raising' | 'rest';
interface LiftMover {
  kind: 'lift';
  sectorIndex: number;
  effect: LiftEffect;
  restHeight: number;
  downHeight: number;
  state: LiftState;
  holdRemaining: number;
}

interface FloorMover {
  kind: 'floor';
  sectorIndex: number;
  speed: number;
  target: number;
  state: 'moving' | 'done';
  crush: boolean;
  /**
   * Texture/special applied only once this mover reaches `target`, never at
   * trigger time — vanilla's `lowerAndChange` and the donut's ring riser
   * (`donutRaise`), both of which apply `floor->texture`/`newspecial` in
   * `T_MoveFloor`'s `pastdest` branch rather than up front the way this
   * table's ordinary `FloorEffect.changeTexture` family does. `tickFloor`
   * applies it in the same tick the mover's `state` flips to `'done'`.
   */
  arrivalTexture?: { floorTex: string; special: number };
}

/**
 * A one-way ceiling mover — see `CeilingEffect`'s doc. No hold, no reversal
 * state, no periodic crush *damage*: vanilla has no case that needs any of
 * those for this mover (real vanilla never sets `crush=true` for it — even
 * 44/72's "Ceiling Crush" name is misleading, see `EV_DoCeiling`'s source).
 * It still stalls rather than lowering through someone in its way, though —
 * `tickCeiling`'s `blocksCeilingLower` check, vanilla's own crush==false
 * un-crush rule applying unconditionally here since this mover is always
 * crush==false.
 */
interface CeilingMover {
  kind: 'ceiling';
  sectorIndex: number;
  speed: number;
  target: number;
  state: 'moving' | 'done';
}

type CrusherState = 'lowering' | 'raising' | 'stopped';
interface CrusherMover {
  kind: 'crusher';
  sectorIndex: number;
  speed: number;
  /** The sector's own ceiling height when the crusher was spawned — not neighbor-derived, unlike a door. */
  topHeight: number;
  bottomHeight: number;
  state: CrusherState;
  /** Vanilla's `silentCrushAndRaise` (special 141) — see `CrusherEffect.silent`. */
  silent: boolean;
}

type Mover = DoorMover | LiftMover | FloorMover | CrusherMover | CeilingMover;

interface LightState {
  pattern: LightPattern;
  baseLight: number;
  darkLight: number;
  timer: number;
  bright: boolean;
  phase: number;
}

/** Blink/flicker periods in seconds, matching vanilla's STROBEBRIGHT/FASTDARK/SLOWDARK tic counts. */
const BLINK_BRIGHT_TIME = 5 * DOOM_TIC;
const BLINK_05_DARK = 15 * DOOM_TIC;
const BLINK_1_DARK = 35 * DOOM_TIC;
const GLOW_HALF_CYCLE = 1.3;

function makeLightState(pattern: LightPattern, baseLight: number, darkLight: number): LightState {
  return { pattern, baseLight, darkLight, timer: 0, bright: true, phase: 1 };
}

function tickLight(s: LightState, dt: number): number {
  switch (s.pattern) {
    case 'blinkRandom':
    case 'flicker': {
      s.timer -= dt;
      if (s.timer <= 0) {
        s.bright = !s.bright;
        s.timer = s.bright ? BLINK_BRIGHT_TIME : 0.05 + Math.random() * (s.pattern === 'flicker' ? 0.15 : 0.6);
      }
      return s.bright ? s.baseLight : s.darkLight;
    }
    case 'blink05':
    case 'syncBlink05': {
      s.timer -= dt;
      if (s.timer <= 0) {
        s.bright = !s.bright;
        s.timer = s.bright ? BLINK_BRIGHT_TIME : BLINK_05_DARK;
      }
      return s.bright ? s.baseLight : s.darkLight;
    }
    case 'blink1':
    case 'syncBlink1': {
      s.timer -= dt;
      if (s.timer <= 0) {
        s.bright = !s.bright;
        s.timer = s.bright ? BLINK_BRIGHT_TIME : BLINK_1_DARK;
      }
      return s.bright ? s.baseLight : s.darkLight;
    }
    case 'glow': {
      const dir = s.bright ? 1 : -1;
      s.phase += (dir * dt) / GLOW_HALF_CYCLE;
      if (s.phase >= 1) {
        s.phase = 1;
        s.bright = false;
      } else if (s.phase <= 0) {
        s.phase = 0;
        s.bright = true;
      }
      return s.darkLight + (s.baseLight - s.darkLight) * s.phase;
    }
  }
}

function resolveFloorTarget(map: DoomMap, sectorIndex: number, target: MoveTarget): number {
  switch (target) {
    case 'lowestNeighborFloor':
      return lowestNeighborFloor(map, sectorIndex);
    case 'highestNeighborFloor':
      return highestNeighborFloor(map, sectorIndex);
    case 'nextHigherFloor':
      return nextHigherFloor(map, sectorIndex);
    case 'nextLowerFloor':
      return nextLowerFloor(map, sectorIndex);
    case 'lowestNeighborCeiling':
      // Vanilla's raiseFloor clamps to the sector's own ceiling too — a floor
      // can never be sent above the ceiling it sits under, which matters
      // whenever that ceiling happens to be lower than every neighbor's.
      return Math.min(lowestNeighborCeiling(map, sectorIndex), map.sectors[sectorIndex].ceilHeight);
    case 'highestNeighborCeiling':
      return highestNeighborCeiling(map, sectorIndex);
    case 'lowestNeighborCeilingMinus8':
      return (
        Math.min(lowestNeighborCeiling(map, sectorIndex), map.sectors[sectorIndex].ceilHeight) - EIGHT_UNIT_GAP
      );
    case 'highestNeighborFloorPlus8':
      return highestNeighborFloor(map, sectorIndex) + EIGHT_UNIT_GAP;
    case 'plus24':
      return map.sectors[sectorIndex].floorHeight + 24;
    case 'plus32':
      return map.sectors[sectorIndex].floorHeight + 32;
    case 'plus512':
      return map.sectors[sectorIndex].floorHeight + 512;
  }
}

function resolveCeilingTarget(map: DoomMap, sectorIndex: number, target: CeilingTarget): number {
  switch (target) {
    case 'highestNeighborCeiling':
      return highestNeighborCeiling(map, sectorIndex);
    case 'floorPlus8':
      return map.sectors[sectorIndex].floorHeight + EIGHT_UNIT_GAP;
  }
}

/**
 * Drives every linedef/sector special in a loaded map: doors, lifts, generic
 * floor movers, crushers, teleporters, stair builders, blinking/flickering
 * lights, and level exits. Sector heights (`Sector.floorHeight`/`ceilHeight`/`light`) are
 * mutated directly on the `DoomMap` — `World` never caches them, so
 * collision, sight-blocking and the player's resting height all pick the
 * change up on their very next query, with no changes needed there. This
 * controller only owns the two things that don't already "just work":
 * rebuilding the small per-sector geometry a mover's height change
 * invalidates, and re-triggering.
 *
 * Crushers are pure ceiling geometry — down to floor+gap, back to their start
 * height, forever. They (and the `raiseFloorCrush` floor family — 55/56/65/94
 * — but *not* the turbo-16 stairs; see `StairsEffect`'s doc) also deal
 * periodic damage to whoever's caught in their sector via `onCrush`, a
 * callback into `game.ts` — this controller mutates map geometry but has no
 * idea where the player or any monster is standing, the same reason
 * `onExit`/`onTeleport` are callbacks rather than direct calls. A genuine
 * crusher (`CrusherMover`, and any `FloorMover`/`CeilingMover` with
 * `crush: true` — currently only the `raiseFloorCrush` family) never stops
 * or reverses early, matching vanilla's own `crush==true` branch of
 * `T_MovePlane` exactly: it just keeps hurting whoever's in its way every
 * `CRUSH_DAMAGE_INTERVAL` until they leave or die, which is the part of the
 * vanilla behavior that actually matters for how a crusher reads as a hazard.
 *
 * Stair builders (`triggerStairs`/`findStairChain`) reuse the plain
 * `FloorMover` machinery per step — a stair step is just a floor rising to a
 * fixed height — with the chain of sectors to raise discovered once at load
 * time (`computeMovableSectors`) by walking the same texture-matched
 * adjacency the trigger itself uses at runtime. Stairs never set `crush`
 * (`StairsEffect`'s doc), so a rising step is one of the ordinary movers the
 * next paragraph blocks on contact, same as any other non-crushing riser.
 *
 * Every *non*-crushing mover reverses or stalls rather than clipping through
 * the player or a monster standing in its way — vanilla's own
 * `T_MovePlane`/`PIT_ChangeSector` "un-crush" rule for `crush==false`, via
 * two callbacks into `game.ts` (this controller mutates map geometry but has
 * no idea who's standing in it, the same reason `onCrush` is a callback too):
 * `blocksCeilingLower` for a closing door or a lowering `CeilingMover`
 * (real vanilla never sets `crush=true` for this mover — see the
 * `lowerAndCrush`/44/72 note in `CeilingMover`'s own doc — so every one of
 * them genuinely should stop), and `blocksFloorRise` for a rising
 * `LiftMover` or a `crush: false` `FloorMover`. A door reverses direction
 * outright (it already has a `raising` state to fall back into); a
 * `CeilingMover`/`FloorMover`/`LiftMover` has no such state, so it simply
 * skips that tick's step and retries the next one, which reads as the mover
 * stalling in place until whoever's in the way clears out — functionally the
 * same "don't crush through them" result vanilla's own per-tic retry
 * produces. Approximated as 2D sector membership plus a flat headroom check
 * against `PLAYER_HEIGHT`/`MONSTER_HIT_HEIGHT`, the same coarseness
 * `applyCrushDamage` already accepts — and, unlike vanilla, applied uniformly
 * to every door regardless of speed, since this engine has no separate
 * "blazeClose never reverses" door type to hook the one real vanilla
 * exception on. The opposite direction of each of these movers (opening,
 * raising a ceiling, lowering a non-lift floor) is deliberately left
 * unchecked, matching vanilla's own asymmetry — `T_MovePlane`'s ceiling-up
 * and floor-down branches essentially never trap a "standing on the floor"
 * thing, since `P_ThingHeightClip` rides it along with the floor
 * automatically; only the direction that closes the gap on someone can ever
 * actually block them.
 */
/** A teleport landing spot: where to put the thing, and which way it should face on arrival (radians — see `Placement`). */
export type TeleportDest = Placement;

/**
 * A keyed line the player just used without the key it wants — what `game.ts` needs to say so
 * (see `consumeLockedLine`). `kind` is vanilla's own split between "open this door" (`PD_*K`, the
 * manual door specials 26-28/32-34, where the line *is* the door) and "activate this object"
 * (`PD_*O`, the remote switches 99/133-137) — the two messages `EV_VerticalDoor` and
 * `EV_DoLockedDoor` print. docs/items.md § Locked doors and use triggers.
 */
export interface LockedLine {
  key: KeyColor;
  kind: 'door' | 'switch';
}

/**
 * The only line specials a non-player thing may activate by walking over
 * them — vanilla's own short allow-list in `P_CrossSpecialLine`'s
 * `if (!thing->player)` branch. Everything else in the game (exit lines,
 * stair builders, most doors and floors) simply does nothing under a
 * monster's feet, which is why a level's monsters can't wander around
 * rearranging its geometry.
 */
/** How far around a monster to look for walk-trigger lines — the largest monster radius (the spider mastermind's 128) plus slack. */
const MONSTER_CROSS_RADIUS = 136;

const MONSTER_CROSSABLE = new Set([
  4, // raise door
  10, // plat down-wait-up-stay
  39, // teleport
  88, // plat down-wait-up-stay, retriggerable
  97, // teleport, retriggerable
  125, // teleport, monsters only
  126, // teleport, monsters only, retriggerable
]);

export class SpecialsController {
  private map: DoomMap;
  private world: World;
  private bank: MaterialBank;
  /** Everything this controller's height and light changes mean for what is actually drawn — see specials/movergeometry.ts. */
  private geometry: MoverGeometry;
  private onExit: (secret: boolean) => void;
  private onTeleport: (dest: Placement) => void;
  private onCrush: (sectorIndex: number) => void;
  private blocksCeilingLower: (sectorIndex: number, ceilingHeight: number) => boolean;
  private blocksFloorRise: (sectorIndex: number, floorHeight: number) => boolean;
  private sfx: SoundEmitter;
  /** `A_BossDeath`'s per-map table, resolved once from `map.name` — see `notifyBossDeath`. */
  private bossDeathTriggers: BossDeathTrigger[];
  /**
   * Vanilla's `sector->soundorg` — where a sector's own sounds come from,
   * computed lazily per sector and cached (`soundOrigin`).
   */
  private sectorOrigins = new Map<number, Pos2>();
  /** Counts down to the next `stnmov` grind, and whether one is due this frame — see `MOVE_SOUND_INTERVAL`. */
  private moveSoundTimer = MOVE_SOUND_INTERVAL;
  private moveSoundDue = false;
  /** Counts down to the next crush-damage pulse, and whether one is due this frame — see `tickCrush`. */
  private crushDamageTimer = CRUSH_DAMAGE_INTERVAL;
  private crushDamageDue = false;

  private movers = new Map<number, Mover>();
  private usedOnce = new Set<number>();

  private switchTextures = new Map<number, SwitchEntry[]>();
  private switchFlashes = new Map<number, number>();

  private lightStates = new Map<number, LightState>();

  private prevX: number;
  private prevY: number;
  /**
   * Set by `trigger` for the one frame a teleport fires, and consumed at the
   * end of `update` to seed `prevX`/`prevY` from the destination instead of
   * the pre-teleport position `update` was called with. Without this, the
   * next frame's walk-trigger scan would test a segment from the old spot all
   * the way to the teleport pad — an arbitrarily long jump that could cross
   * (and wrongly re-trigger) unrelated lines along the way.
   */
  private lastTeleport: Pos2 | null = null;
  /**
   * Set by `trigger` when the player uses a keyed line without its key, and read (and cleared) by
   * `consumeLockedLine` — this controller knows which key a line wants, but nothing about the HUD
   * that has to say so, the same reason `onExit`/`onTeleport` are callbacks.
   */
  private lockedLine: LockedLine | null = null;

  constructor(
    map: DoomMap,
    world: World,
    bank: MaterialBank,
    scene: THREE.Scene | THREE.Group,
    fog: FogOfWar,
    polys: SubSectorPoly[],
    built: BuiltMap,
    meshOptions: MapMeshOptions,
    onExit: (secret: boolean) => void,
    onTeleport: (dest: Placement) => void,
    onCrush: (sectorIndex: number) => void,
    blocksCeilingLower: (sectorIndex: number, ceilingHeight: number) => boolean,
    blocksFloorRise: (sectorIndex: number, floorHeight: number) => boolean,
    playerX: number,
    playerY: number,
    sfx: SoundEmitter = SILENT,
  ) {
    this.map = map;
    this.world = world;
    this.bank = bank;
    this.onExit = onExit;
    this.onTeleport = onTeleport;
    this.onCrush = onCrush;
    this.blocksCeilingLower = blocksCeilingLower;
    this.blocksFloorRise = blocksFloorRise;
    this.sfx = sfx;
    this.bossDeathTriggers = bossDeathTriggersFor(map.name);
    this.prevX = playerX;
    this.prevY = playerY;

    for (const [i, line] of map.linedefs.entries()) {
      if (!LINE_SPECIALS[line.special]) continue;
      const entries = findSwitchEntries(map, line);
      if (entries.length > 0) this.switchTextures.set(i, entries);
    }

    this.geometry = new MoverGeometry(map, world, bank, scene, fog, polys, built, meshOptions, computeMovableSectors(map));

    for (let i = 0; i < map.sectors.length; i++) {
      const timer = SECTOR_DOOR_SPECIALS[map.sectors[i].special];
      if (timer) this.spawnSectorDoorTimer(i, timer);
    }

    const lightSectors = computeLightSectors(map);
    for (const sectorIndex of lightSectors) {
      const sector = map.sectors[sectorIndex];
      const pattern = SECTOR_LIGHT_SPECIALS[sector.special];
      this.lightStates.set(sectorIndex, makeLightState(pattern, sector.light, darkestNeighborLight(map, sectorIndex)));
    }
  }

  dispose(): void {
    this.geometry.dispose();
  }

  /** The mover meshes' own per-frame occlusion/fog fade — see `MoverGeometry.updateFading`. Called from `game.ts` after the camera has settled, not from `update`. */
  updateFading(dt: number, camX: number, camY: number, camZ: number, targets: FadeTarget[]): void {
    this.geometry.updateFading(dt, camX, camY, camZ, targets);
  }

  /**
   * Sector-type door timers (10/14, `SECTOR_DOOR_SPECIALS`) spawn their
   * `DoorMover` directly, bypassing `triggerDoor` entirely — there's no
   * linedef, no tag, nothing to trigger, just a mover that starts waiting
   * the moment the map loads. `closeIn30` reuses the ordinary `hold` state
   * (already exactly "wait, then lower, then stop") seeded straight into it
   * rather than via a `raising` phase, since the sector is assumed already
   * open in the map data; `raiseIn5Min` reuses `holdClosed` the same way,
   * assumed already closed. Both use a plain `openClose` `DoorEffect` since
   * neither vanilla type is `openOnly`/`closeThenOpen` once it actually
   * starts moving (see `SECTOR_DOOR_SPECIALS`'s own doc).
   */
  private spawnSectorDoorTimer(sectorIndex: number, timer: SectorDoorTimer): void {
    const sector = this.map.sectors[sectorIndex];
    const effect: DoorEffect = { kind: 'door', speed: DOOR_SPEED, waitSeconds: DOOR_WAIT, mode: 'openClose' };
    if (timer === 'closeIn30') {
      this.movers.set(sectorIndex, {
        kind: 'door',
        sectorIndex,
        effect,
        openHeight: sector.ceilHeight,
        closeHeight: sector.floorHeight,
        state: 'hold',
        holdRemaining: DOOR_CLOSE_WAIT_SECONDS,
      });
    } else {
      this.movers.set(sectorIndex, {
        kind: 'door',
        sectorIndex,
        effect,
        openHeight: lowestNeighborCeiling(this.map, sectorIndex) - DOOR_OPEN_GAP,
        closeHeight: sector.floorHeight,
        state: 'holdClosed',
        holdRemaining: DOOR_RAISE_WAIT_SECONDS,
      });
    }
  }

  /**
   * Routing this field read through a method (rather than reading
   * `this.lastTeleport` directly at the end of `update`) works around a type
   * narrowing quirk in this project's pinned tsc: reading the field inline
   * after the several method calls in `update` — any of which may reach
   * `trigger` and reassign it — left it typed as `null` regardless, when it
   * can genuinely be non-null there.
   */
  private consumeLastTeleport(): Pos2 | null {
    return this.lastTeleport;
  }

  /**
   * The keyed line the player was refused this frame, if any — one read per attempt, so holding
   * `use` against a locked door re-announces it on every press and not in between. Call after
   * `update`, which is where every keyed line is reached from (all of them are `use` triggers).
   */
  consumeLockedLine(): LockedLine | null {
    const locked = this.lockedLine;
    this.lockedLine = null;
    return locked;
  }

  update(
    dt: number,
    playerX: number,
    playerY: number,
    playerAngle: number,
    input: Input,
    ownedKeys: ReadonlySet<KeyColor>,
  ): void {
    const dirty = new Set<number>();
    // One shared clock for every mover's grind — see MOVE_SOUND_INTERVAL.
    this.moveSoundTimer -= dt;
    this.moveSoundDue = this.moveSoundTimer <= 0;
    if (this.moveSoundDue) this.moveSoundTimer += MOVE_SOUND_INTERVAL;
    // Same reasoning, one shared clock for every crusher's damage pulse — see tickCrush.
    this.crushDamageTimer -= dt;
    this.crushDamageDue = this.crushDamageTimer <= 0;
    if (this.crushDamageDue) this.crushDamageTimer += CRUSH_DAMAGE_INTERVAL;
    this.tickMovers(dt, dirty);
    this.lastTeleport = null;
    this.handleUseTrigger(playerX, playerY, playerAngle, input, ownedKeys);
    this.handleWalkTriggers(playerX, playerY, ownedKeys);
    this.geometry.rebuildAround(dirty);
    this.updateSwitchFlashes(dt);
    this.updateLights(dt);
    // See `lastTeleport`'s doc: a teleport this frame reseeds prevX/prevY from
    // the destination, not the (now stale, pre-teleport) playerX/playerY.
    const teleport = this.consumeLastTeleport();
    this.prevX = teleport ? teleport.x : playerX;
    this.prevY = teleport ? teleport.y : playerY;
  }

  // ---- Movers ----------------------------------------------------------

  /**
   * Where a sector's own sounds come from — vanilla's `sector->soundorg`, the
   * centre of the bounding box of the sector's linedefs (`P_GroupLines`), not a
   * polygon centroid. A door heard from the wrong end of a long corridor sector
   * is the difference this makes, so it's worth being the same point vanilla
   * uses. Cached: a lift emits one of these every 8 tics for as long as it runs.
   */
  private soundOrigin(sectorIndex: number): Pos2 {
    const cached = this.sectorOrigins.get(sectorIndex);
    if (cached) return cached;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const line of this.map.linedefs) {
      const front = line.right !== NO_SIDE ? this.map.sidedefs[line.right]?.sector : undefined;
      const back = line.left !== NO_SIDE ? this.map.sidedefs[line.left]?.sector : undefined;
      if (front !== sectorIndex && back !== sectorIndex) continue;
      for (const v of [this.map.vertexes[line.v1], this.map.vertexes[line.v2]]) {
        if (!v) continue;
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }
    }
    // A sector with no lines at all (malformed map) would leave the box empty;
    // the origin then sits at 0,0, which is as good as anything for a sector
    // that can't be entered.
    const origin: Pos2 =
      minX === Infinity ? { x: 0, y: 0 } : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    this.sectorOrigins.set(sectorIndex, origin);
    return origin;
  }

  /** One sector-sound shorthand: vanilla's `S_StartSound(&sector->soundorg, id)`. */
  private playSector(sectorIndex: number, id: SfxId): void {
    this.sfx.play(id, this.soundOrigin(sectorIndex), sectorOrigin(sectorIndex));
  }

  /**
   * Where a switch's click comes from: the linedef's own midpoint, i.e. the
   * wall panel the player is standing at. A deliberate divergence —
   * `P_ChangeSwitchTexture` passes `buttonlist->soundorg`, which is
   * `buttonlist[0]`'s and is only filled in by `P_StartButton` *after* the
   * sound plays, so vanilla emits the click from whatever stale button slot 0
   * last held. Reproducing that bug would put the click on the far side of the
   * map at random.
   */
  private switchOrigin(lineIndex: number): Pos2 {
    const line = this.map.linedefs[lineIndex];
    const a = this.map.vertexes[line.v1];
    const b = this.map.vertexes[line.v2];
    if (!a || !b) return { x: 0, y: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private tickMovers(dt: number, dirty: Set<number>): void {
    for (const mover of this.movers.values()) {
      if (mover.kind === 'door') this.tickDoor(mover, dt, dirty);
      else if (mover.kind === 'lift') this.tickLift(mover, dt, dirty);
      else if (mover.kind === 'floor') this.tickFloor(mover, dt, dirty);
      else if (mover.kind === 'ceiling') this.tickCeiling(mover, dt, dirty);
      else this.tickCrusher(mover, dt, dirty);
    }
  }

  private tickDoor(mover: DoorMover, dt: number, dirty: Set<number>): void {
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.ceilHeight;
    if (mover.state === 'raising') {
      sector.ceilHeight = Math.min(mover.openHeight, sector.ceilHeight + mover.effect.speed * dt);
      if (sector.ceilHeight >= mover.openHeight) {
        sector.ceilHeight = mover.openHeight;
        // A closeThenOpen door stays open for good once it reopens, same as
        // openOnly — vanilla removes its thinker outright at this point
        // (`case close30ThenOpen: case blazeOpen: case open:` share one
        // branch in T_VerticalDoor's UP-pastdest handler).
        mover.state = mover.effect.mode === 'openOnly' || mover.effect.mode === 'closeThenOpen' ? 'open' : 'hold';
        mover.holdRemaining = mover.effect.waitSeconds;
      }
    } else if (mover.state === 'hold') {
      mover.holdRemaining -= dt;
      if (mover.holdRemaining <= 0) {
        mover.state = 'lowering';
        // T_VerticalDoor's own topcountdown branch: the close is announced when
        // the wait runs out, not when the door was opened.
        this.playSector(mover.sectorIndex, this.doorSounds(mover.effect).close);
      }
    } else if (mover.state === 'holdClosed') {
      mover.holdRemaining -= dt;
      if (mover.holdRemaining <= 0) {
        mover.state = 'raising';
        this.playSector(mover.sectorIndex, this.doorSounds(mover.effect).open);
      }
    } else if (mover.state === 'lowering') {
      const next = Math.max(mover.closeHeight, sector.ceilHeight - mover.effect.speed * dt);
      if (this.blocksCeilingLower(mover.sectorIndex, next)) {
        // Vanilla's T_MovePlane/PIT_ChangeSector: closing further would leave
        // whoever's standing under it with no headroom, so the door bounces
        // back open instead of sliding shut through them — this tick's move
        // is skipped outright, not merely reverted after applying it.
        mover.state = 'raising';
        // The bump is audible, which is what tells you the door found you
        // underneath — and it is the *slow* door's `doropn` even for a blazing
        // one, since T_VerticalDoor's `res == crushed` branch names the sound
        // literally rather than switching on the door type.
        this.playSector(mover.sectorIndex, 'doropn');
      } else {
        sector.ceilHeight = next;
        if (sector.ceilHeight <= mover.closeHeight) {
          sector.ceilHeight = mover.closeHeight;
          if (mover.effect.mode === 'closeThenOpen') {
            mover.state = 'holdClosed';
            mover.holdRemaining = DOOR_CLOSE_WAIT_SECONDS;
          } else {
            mover.state = 'closed';
            // A blazing door clacks a *second* `bdcls` as it lands — vanilla
            // plays one when the close starts (above) and one here, in
            // T_VerticalDoor's own `pastdest` branch, which is where the fast
            // door's double thud comes from. A normal door is silent on
            // arrival.
            if (mover.effect.speed >= DOOR_SPEED_FAST) this.playSector(mover.sectorIndex, 'bdcls');
          }
        }
      }
    }
    if (sector.ceilHeight !== before) dirty.add(mover.sectorIndex);
  }

  private tickLift(mover: LiftMover, dt: number, dirty: Set<number>): void {
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.floorHeight;
    if (mover.state === 'lowering') {
      sector.floorHeight = Math.max(mover.downHeight, sector.floorHeight - mover.effect.speed * dt);
      if (sector.floorHeight <= mover.downHeight) {
        sector.floorHeight = mover.downHeight;
        mover.state = 'hold';
        mover.holdRemaining = mover.effect.waitSeconds;
        // T_PlatRaise: `pstop` at either end of the travel, `pstart` whenever it
        // sets off again — a lift is silent while it moves, unlike a floor.
        this.playSector(mover.sectorIndex, 'pstop');
      }
    } else if (mover.state === 'hold') {
      mover.holdRemaining -= dt;
      if (mover.holdRemaining <= 0) {
        mover.state = 'raising';
        this.playSector(mover.sectorIndex, 'pstart');
      }
    } else if (mover.state === 'raising') {
      const next = Math.min(mover.restHeight, sector.floorHeight + mover.effect.speed * dt);
      if (this.blocksFloorRise(mover.sectorIndex, next)) {
        // T_PlatRaise's own `res == crushed && !plat->crush` branch: unlike a
        // plain rising FloorMover/CeilingMover, which just stalls in place
        // (T_MoveFloor/T_MoveCeiling have no such branch), a lift immediately
        // reverses back down instead of waiting for the obstruction to clear —
        // confirmed against p_plats.c. A lift is never a crusher (LiftMover
        // has no crush flag at all), so this fires unconditionally.
        mover.state = 'lowering';
        this.playSector(mover.sectorIndex, 'pstart');
        return;
      }
      sector.floorHeight = next;
      if (sector.floorHeight >= mover.restHeight) {
        sector.floorHeight = mover.restHeight;
        mover.state = 'rest';
        this.playSector(mover.sectorIndex, 'pstop');
      }
    }
    if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
  }

  private tickFloor(mover: FloorMover, dt: number, dirty: Set<number>): void {
    if (mover.state === 'done') return;
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.floorHeight;
    const dir = mover.target > sector.floorHeight ? 1 : -1;
    const next = sector.floorHeight + dir * mover.speed * dt;
    if (dir > 0 && !mover.crush && this.blocksFloorRise(mover.sectorIndex, next)) {
      // Same un-crush rule as the lift above — but only while `crush` is
      // false. Vanilla's own floor-up code only reverts for crush==false;
      // the raiseFloorCrush family (mover.crush===true — 55/56/65/94) is
      // vanilla's real exception and keeps grinding through instead, dealing
      // periodic damage via tickCrush below exactly as it already did.
      return;
    }
    sector.floorHeight = next;
    // T_MoveFloor grinds on the shared 8-tic clock the whole time it moves, and
    // clacks `pstop` once on arrival.
    if (this.moveSoundDue) this.playSector(mover.sectorIndex, 'stnmov');
    if ((dir > 0 && sector.floorHeight >= mover.target) || (dir < 0 && sector.floorHeight <= mover.target)) {
      sector.floorHeight = mover.target;
      mover.state = 'done';
      this.playSector(mover.sectorIndex, 'pstop');
      if (mover.arrivalTexture) {
        sector.floorTex = mover.arrivalTexture.floorTex;
        sector.special = mover.arrivalTexture.special;
      }
    }
    if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
    if (mover.crush) this.tickCrush(mover.sectorIndex);
  }

  /**
   * One-way ceiling move — see `CeilingMover`'s doc for why there's no
   * hold/reversal state, unlike a door. A *lowering* move still respects
   * vanilla's crush=false un-crush rule (`blocksCeilingLower`, the same
   * callback a closing door uses) — real vanilla never sets `crush=true` for
   * this mover (see the class doc's `lowerAndCrush` note), so every
   * `CeilingMover` genuinely should stop rather than grind through. Raising
   * never blocks, matching vanilla's own ceiling-up code, which never
   * reverts on contact either.
   */
  private tickCeiling(mover: CeilingMover, dt: number, dirty: Set<number>): void {
    if (mover.state === 'done') return;
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.ceilHeight;
    const dir = mover.target > sector.ceilHeight ? 1 : -1;
    const next = sector.ceilHeight + dir * mover.speed * dt;
    if (dir < 0 && this.blocksCeilingLower(mover.sectorIndex, next)) return;
    sector.ceilHeight = next;
    // T_MoveCeiling grinds on the same shared clock, in both directions. It has
    // no arrival sound: only vanilla's *silent* crusher gets a `pstop` at an end
    // (see tickCrusher), which is exactly the type that stays quiet in between.
    if (this.moveSoundDue) this.playSector(mover.sectorIndex, 'stnmov');
    if ((dir > 0 && sector.ceilHeight >= mover.target) || (dir < 0 && sector.ceilHeight <= mover.target)) {
      sector.ceilHeight = mover.target;
      mover.state = 'done';
    }
    if (sector.ceilHeight !== before) dirty.add(mover.sectorIndex);
  }

  /** No hold/rest state, unlike doors and lifts — a crusher reverses at each end and repeats forever. */
  private tickCrusher(mover: CrusherMover, dt: number, dirty: Set<number>): void {
    if (mover.state === 'stopped') return;
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.ceilHeight;
    // T_MoveCeiling hardcodes crush=false for the UP call regardless of the
    // mover's own crush flag (confirmed against p_ceilng.c) — only a
    // lowering crusher ever deals damage, so this tick's direction (before
    // any end-of-travel flip below) decides whether tickCrush fires.
    const wasLowering = mover.state === 'lowering';
    if (mover.state === 'lowering') {
      sector.ceilHeight = Math.max(mover.bottomHeight, sector.ceilHeight - mover.speed * dt);
      if (sector.ceilHeight <= mover.bottomHeight) {
        sector.ceilHeight = mover.bottomHeight;
        mover.state = 'raising';
        // The silent crusher's one sound, at each end of its travel — the exact
        // inverse of every other crusher, which grinds throughout and is quiet
        // at the turns (see CrusherEffect.silent).
        if (mover.silent) this.playSector(mover.sectorIndex, 'pstop');
      }
    } else {
      sector.ceilHeight = Math.min(mover.topHeight, sector.ceilHeight + mover.speed * dt);
      if (sector.ceilHeight >= mover.topHeight) {
        sector.ceilHeight = mover.topHeight;
        mover.state = 'lowering';
        if (mover.silent) this.playSector(mover.sectorIndex, 'pstop');
      }
    }
    if (!mover.silent && this.moveSoundDue) this.playSector(mover.sectorIndex, 'stnmov');
    if (sector.ceilHeight !== before) dirty.add(mover.sectorIndex);
    if (wasLowering) this.tickCrush(mover.sectorIndex);
  }

  /**
   * Fires `onCrush` for `sectorIndex` on the shared `crushDamageDue` clock —
   * vanilla's `leveltime&3` is one clock for the whole level, not a per-mover
   * countdown, so every crushing mover anywhere pulses on the same tic
   * (exactly `moveSoundDue`'s reasoning, applied to damage instead of sound).
   * A per-mover countdown reset on each fire drifts out of phase with that
   * global tic and can rack up an extra hit a real vanilla/GZDoom crusher
   * wouldn't have — this replaced that approach for exactly that reason.
   */
  private tickCrush(sectorIndex: number): void {
    if (this.crushDamageDue) this.onCrush(sectorIndex);
  }

  /**
   * Vanilla's `sec->specialdata`: this sector already has a mover thinker running on it, so a fresh
   * trigger of *any* kind must do nothing at all. `EV_DoFloor`, `EV_DoPlat`, `EV_DoCeiling`,
   * `EV_DoDonut` and `EV_BuildStairs` all `continue` past such a sector.
   *
   * A mover that has finished is **not** active — vanilla removes its thinker and clears
   * `specialdata` the moment it stops, freeing the sector to be triggered again. This engine keeps
   * the finished record in `movers` instead (a lift re-triggers off its own `restHeight`), so the
   * state has to be read rather than mere presence.
   *
   * The two re-triggers vanilla does honor are handled by their own callers *before* asking this: a
   * door reverses (`EV_VerticalDoor`) and a stopped crusher restarts (`P_ActivateInStasis`).
   *
   * See docs/specials.md § One mover per sector — DOOM2 MAP30's central pillar is the repro.
   */
  private sectorActive(sectorIndex: number): boolean {
    const mover = this.movers.get(sectorIndex);
    if (!mover) return false;
    switch (mover.kind) {
      case 'floor':
      case 'ceiling':
        return mover.state === 'moving';
      case 'lift':
        return mover.state !== 'rest';
      case 'crusher':
        return mover.state !== 'stopped';
      case 'door':
        return mover.state !== 'open' && mover.state !== 'closed';
    }
  }

  /** Which pair of door sounds this door uses — see `DOOR_SOUNDS`. */
  private doorSounds(effect: DoorEffect): { open: SfxId; close: SfxId } {
    return DOOR_SOUNDS[effect.speed >= DOOR_SPEED_FAST ? 'fast' : 'normal'];
  }

  private triggerDoor(sectorIndex: number, effect: DoorEffect): void {
    const existing = this.movers.get(sectorIndex);
    const sounds = this.doorSounds(effect);
    if (!existing || existing.kind !== 'door') {
      if (this.sectorActive(sectorIndex)) return;
      const sector = this.map.sectors[sectorIndex];
      const closeThenOpen = effect.mode === 'closeThenOpen';
      // A closeThenOpen door is authored already open, and reopens to
      // wherever it already sits — vanilla's own `door->topheight =
      // sec->ceilingheight;` (p_doors.c), unlike every other DoorMode here,
      // which always computes a fresh neighbor-ceiling target.
      const openHeight = closeThenOpen ? sector.ceilHeight : lowestNeighborCeiling(this.map, sectorIndex) - DOOR_OPEN_GAP;
      const closeHeight = sector.floorHeight;
      this.movers.set(sectorIndex, {
        kind: 'door',
        sectorIndex,
        effect,
        openHeight,
        closeHeight,
        state: closeThenOpen ? 'lowering' : 'raising',
        holdRemaining: 0,
      });
      // EV_DoDoor's own per-direction sound. Vanilla suppresses the *opening*
      // one for a door already at its target height (`if (door->topheight !=
      // sec->ceilingheight)`); that case can't reach here, since a door with
      // nothing to open is one this engine gives no mover at all.
      this.playSector(sectorIndex, closeThenOpen ? sounds.close : sounds.open);
      return;
    }
    const mover = existing;
    if (effect.mode === 'closeOnly' || effect.mode === 'closeThenOpen') {
      mover.state = 'lowering';
      this.playSector(sectorIndex, sounds.close);
      return;
    }
    if (effect.mode === 'openOnly') {
      if (mover.state === 'closed' || mover.state === 'lowering') {
        mover.state = 'raising';
        this.playSector(sectorIndex, sounds.open);
      }
      return;
    }
    // Retriggering an open door only resets its wait — no sound, matching
    // vanilla, which just writes `door->topcountdown` and never reaches
    // EV_DoDoor's sound switch for an already-running thinker.
    if (mover.state === 'closed' || mover.state === 'open') {
      mover.state = 'raising';
      this.playSector(sectorIndex, sounds.open);
    } else if (mover.state === 'hold') {
      mover.holdRemaining = effect.waitSeconds;
    } else if (mover.state === 'lowering') {
      mover.state = 'raising';
      this.playSector(sectorIndex, sounds.open);
    }
  }

  private triggerLift(sectorIndex: number, effect: LiftEffect): void {
    const existing = this.movers.get(sectorIndex);
    if (!existing || existing.kind !== 'lift') {
      if (this.sectorActive(sectorIndex)) return;
      const restHeight = this.map.sectors[sectorIndex].floorHeight;
      const downHeight = lowestNeighborFloor(this.map, sectorIndex);
      this.movers.set(sectorIndex, {
        kind: 'lift',
        sectorIndex,
        effect,
        restHeight,
        downHeight,
        state: 'lowering',
        holdRemaining: 0,
      });
      this.playSector(sectorIndex, 'pstart'); // EV_DoPlat's own downWaitUpStay sound
      return;
    }
    if (existing.state === 'rest') {
      existing.state = 'lowering';
      this.playSector(sectorIndex, 'pstart');
    }
  }

  private triggerFloor(sectorIndex: number, effect: FloorEffect, line?: LineDef): void {
    if (this.sectorActive(sectorIndex)) return;
    // `line` is only actually needed for `changeTexture` — the only caller without a real
    // linedef (`triggerTag`, for a boss-death `lowerFloorToLowest`) never sets that flag.
    if (effect.changeTexture && line) this.applyFloorChange(sectorIndex, line);
    const target = resolveFloorTarget(this.map, sectorIndex, effect.target);
    this.movers.set(sectorIndex, {
      kind: 'floor',
      sectorIndex,
      speed: effect.speed,
      target,
      state: 'moving',
      crush: effect.crush,
    });
  }

  /**
   * Vanilla's "AndChange" model-sector copy: the texture comes from the
   * *triggering linedef's own front sector*, not the sector actually moving
   * or its neighbors — confirmed against `EV_DoPlat`'s `raiseToNearestAndChange`
   * case (`sec->floorpic = sides[line->sidenum[0]].sector->floorpic`), which
   * is how mappers control what a raised floor turns into regardless of what
   * it's rising toward. Rebuilt immediately (not left for the next dirty-mover
   * pass) so the texture swap and the start of the rise read as one action,
   * same as `flashSwitch` rebuilding right after it mutates a switch texture.
   */
  private applyFloorChange(sectorIndex: number, line: LineDef): void {
    const modelSectorIndex = line.right !== NO_SIDE ? this.map.sidedefs[line.right]?.sector : undefined;
    if (modelSectorIndex === undefined) return;
    const sector = this.map.sectors[sectorIndex];
    sector.floorTex = this.map.sectors[modelSectorIndex].floorTex;
    // "NO MORE DAMAGE, IF APPLICABLE" — vanilla's own comment. A light-blink
    // special already runs off its own independent thinker in this engine
    // (see `lightStates`), so clearing this doesn't stop that, matching
    // vanilla's own decoupling between a sector's `special` field and an
    // already-spawned light thinker.
    sector.special = 0;
    this.geometry.rebuild(sectorIndex);
  }

  /** A sector already crushing (in either direction) ignores a re-trigger, matching vanilla's `sec->specialdata` guard. */
  private triggerCrusher(sectorIndex: number, effect: CrusherEffect): void {
    const existing = this.movers.get(sectorIndex);
    if (existing && existing.kind === 'crusher') {
      if (existing.state === 'stopped') existing.state = 'lowering';
      return;
    }
    if (this.sectorActive(sectorIndex)) return;
    const sector = this.map.sectors[sectorIndex];
    this.movers.set(sectorIndex, {
      kind: 'crusher',
      sectorIndex,
      speed: effect.speed,
      topHeight: sector.ceilHeight,
      bottomHeight: sector.floorHeight + EIGHT_UNIT_GAP,
      state: 'lowering',
      silent: effect.silent,
    });
  }

  private triggerCrusherStop(sectorIndex: number): void {
    const existing = this.movers.get(sectorIndex);
    if (existing && existing.kind === 'crusher') existing.state = 'stopped';
  }

  /** Vanilla's own `sec->specialdata` guard: a sector already driven by *any* mover ignores this — unlike doors/lifts/floors above, there's no interactive re-trigger behavior worth having for a one-way move. */
  private triggerCeiling(sectorIndex: number, effect: CeilingEffect): void {
    if (this.sectorActive(sectorIndex)) return;
    const target = resolveCeilingTarget(this.map, sectorIndex, effect.target);
    this.movers.set(sectorIndex, { kind: 'ceiling', sectorIndex, speed: effect.speed, target, state: 'moving' });
  }

  /**
   * Vanilla's `raiseToTexture` (`EV_DoFloor`'s own case, not reachable
   * through `resolveFloorTarget`): scans every two-sided line bordering the
   * sector and, for *both* of that line's sidedefs (not just the far one —
   * confirmed against `p_floor.c`), checks its lower texture's pixel height,
   * keeping the smallest found. No candidates at all: vanilla's own
   * `minsize` sentinel (`MAXINT`) is replicated as `Infinity`, meaning the
   * floor just rises forever rather than being clamped to something safer —
   * this only happens on a malformed map (no bordering line has a bottom
   * texture at all), which no real map actually does.
   */
  private triggerRaiseToTexture(sectorIndex: number): void {
    if (this.sectorActive(sectorIndex)) return;
    let minHeight = Infinity;
    for (const line of this.map.linedefs) {
      const front = line.right !== NO_SIDE ? this.map.sidedefs[line.right]?.sector : undefined;
      const back = line.left !== NO_SIDE ? this.map.sidedefs[line.left]?.sector : undefined;
      if (front === undefined || back === undefined) continue;
      if (front !== sectorIndex && back !== sectorIndex) continue;
      for (const side of [this.map.sidedefs[line.right], this.map.sidedefs[line.left]]) {
        if (!side || side.lower === NO_TEXTURE || side.lower === '') continue;
        const h = this.bank.textureHeight(side.lower);
        if (h !== null && h < minHeight) minHeight = h;
      }
    }
    const sector = this.map.sectors[sectorIndex];
    const target = sector.floorHeight + minHeight;
    this.movers.set(sectorIndex, {
      kind: 'floor',
      sectorIndex,
      speed: FLOOR_SPEED,
      target,
      state: 'moving',
      crush: false,
    });
  }

  /**
   * Vanilla's `lowerAndChange` — see `LowerAndChangeEffect`'s doc for the
   * model-sector search and why the texture/special only apply on arrival
   * (`arrivalTexture`, applied by `tickFloor`).
   */
  private triggerLowerAndChange(sectorIndex: number): void {
    if (this.sectorActive(sectorIndex)) return;
    const target = lowestNeighborFloor(this.map, sectorIndex);
    let arrivalTexture: { floorTex: string; special: number } | undefined;
    for (const neighborIndex of neighborSectorIndices(this.map, sectorIndex)) {
      const neighbor = this.map.sectors[neighborIndex];
      if (neighbor.floorHeight === target) {
        arrivalTexture = { floorTex: neighbor.floorTex, special: neighbor.special };
        break;
      }
    }
    this.movers.set(sectorIndex, {
      kind: 'floor',
      sectorIndex,
      speed: FLOOR_SPEED,
      target,
      state: 'moving',
      crush: false,
      arrivalTexture,
    });
  }

  /**
   * Vanilla's `EV_DoDonut` — see `DonutEffect`'s doc for the ring/outer
   * search and the deliberate divergence from vanilla's own buggy two-sided
   * check. Only the hole (`holeIndex`) gets vanilla's busy-sector guard,
   * matching the real source, which never checks the ring before
   * overwriting its mover.
   */
  private triggerDonut(holeIndex: number): void {
    if (this.sectorActive(holeIndex)) return;
    const ringIndex = neighborSectorIndices(this.map, holeIndex)[0];
    if (ringIndex === undefined) return;
    let outerIndex: number | undefined;
    for (const candidate of neighborSectorIndices(this.map, ringIndex)) {
      if (candidate === holeIndex) continue;
      outerIndex = candidate;
      break;
    }
    if (outerIndex === undefined) return;
    const outer = this.map.sectors[outerIndex];
    this.movers.set(ringIndex, {
      kind: 'floor',
      sectorIndex: ringIndex,
      speed: FLOOR_SPEED / 2,
      target: outer.floorHeight,
      state: 'moving',
      crush: false,
      arrivalTexture: { floorTex: outer.floorTex, special: 0 },
    });
    this.movers.set(holeIndex, {
      kind: 'floor',
      sectorIndex: holeIndex,
      speed: FLOOR_SPEED / 2,
      target: outer.floorHeight,
      state: 'moving',
      crush: false,
    });
  }

  /**
   * Instant light-level changes/strobe-starts — see `LightChangeMode`'s doc
   * for each mode's vanilla source. Unlike a blink pattern assigned at map
   * load (`lightStates`, seeded in the constructor), these can target *any*
   * sector on demand, which is exactly what `recolorSector` already handles
   * generically — the only new piece here is computing the new level itself.
   */
  private triggerLightChange(sectorIndex: number, effect: LightChangeEffect): void {
    const sector = this.map.sectors[sectorIndex];
    switch (effect.mode) {
      case 'setLevel':
        sector.light = effect.level ?? sector.light;
        this.geometry.recolorSector(sectorIndex);
        break;
      case 'brightestNeighbor': {
        let bright = 0;
        for (const n of neighborSectorIndices(this.map, sectorIndex)) bright = Math.max(bright, this.map.sectors[n].light);
        sector.light = bright;
        this.geometry.recolorSector(sectorIndex);
        break;
      }
      case 'darkestNeighbor': {
        let min = sector.light;
        for (const n of neighborSectorIndices(this.map, sectorIndex)) {
          if (this.map.sectors[n].light < min) min = this.map.sectors[n].light;
        }
        sector.light = min;
        this.geometry.recolorSector(sectorIndex);
        break;
      }
      case 'startStrobe':
        if (this.movers.has(sectorIndex)) return; // vanilla's sec->specialdata guard
        this.lightStates.set(sectorIndex, makeLightState('blink1', sector.light, darkestNeighborLight(this.map, sectorIndex)));
        break;
    }
  }

  /**
   * All steps in the chain start rising together (not staggered) — each just
   * has farther to travel, which is what produces the classic step-by-step
   * reveal as they settle at different times. Reuses the plain `FloorMover`
   * machinery per step rather than a dedicated mover kind, since a single
   * step is exactly a floor rising to a fixed target height.
   */
  private triggerStairs(startSectorIndex: number, effect: StairsEffect): void {
    if (this.sectorActive(startSectorIndex)) return; // vanilla's sec->specialdata guard
    for (const step of findStairChain(this.map, startSectorIndex, effect.stepHeight)) {
      if (this.sectorActive(step.sectorIndex)) continue; // EV_BuildStairs' own per-step `tsec->specialdata` skip
      this.movers.set(step.sectorIndex, {
        kind: 'floor',
        sectorIndex: step.sectorIndex,
        speed: effect.speed,
        target: step.targetHeight,
        state: 'moving',
        // Despite the wiki naming 100/127 "...and Crush", real vanilla
        // stairs never set a crush flag — see StairsEffect's doc.
        crush: false,
      });
    }
  }

  /** First `TELEPORT_DEST` (doomednum 14) thing sitting in one of the tag-matched sectors — vanilla's own search is just as arbitrary when more than one exists. */
  private findTeleportDestination(sectorIndices: number[]): Placement | null {
    if (sectorIndices.length === 0) return null;
    const targets = new Set(sectorIndices);
    for (const t of this.map.things) {
      if (t.type !== TELEPORT_DEST) continue;
      // Vanilla's `EV_Teleport` copies the destination mobj's own angle, and that mobj came out of
      // `P_SpawnMapThing` — so the arrival facing is the snapped one, not the raw THING field.
      if (targets.has(this.world.sectorIndexAt(t.x, t.y)))
        return { x: t.x, y: t.y, angle: (spawnAngleDeg(t.angle) * Math.PI) / 180 };
    }
    return null;
  }

  // ---- Triggers ----------------------------------------------------------

  /**
   * `fromBackSide` is vanilla's `P_CrossSpecialLine` `side` argument — the side
   * the thing was on *before* the move (`P_TryMove` passes `oldside`). Only the
   * teleport branch reads it, matching vanilla, where `side` reaches nothing but
   * `EV_Teleport`. See docs/specials.md § Teleporters.
   */
  private trigger(
    lineIndex: number,
    ownedKeys: ReadonlySet<KeyColor>,
    byMonster = false,
    fromBackSide = false,
  ): TeleportDest | null {
    const line = this.map.linedefs[lineIndex];
    const def = LINE_SPECIALS[line.special];
    if (!def) return null;
    if (!def.repeatable && this.usedOnce.has(lineIndex)) return null;
    // A missing key leaves the door untouched and this attempt un-flagged, so
    // the player can walk off, find the key, and try the same line again —
    // matching vanilla, which just prints "you need the X key" and does
    // nothing else.
    if (def.effect.kind === 'door' && def.effect.requiredKey && !ownedKeys.has(def.effect.requiredKey)) {
      // Vanilla's own feedback: a "you need the X key" message plus `oof` at full volume
      // (`S_StartSound(NULL, sfx_oof)`). A manual door is the door itself, anything else keyed is
      // a remote switch — see `LockedLine`. Both are player-only; a monster never uses a line.
      if (!byMonster) this.lockedLine = { key: def.effect.requiredKey, kind: def.manual ? 'door' : 'switch' };
      this.sfx.play('oof');
      return null;
    }

    this.flashSwitch(lineIndex);

    if (def.effect.kind === 'exit') {
      this.usedOnce.add(lineIndex);
      this.onExit(def.effect.secret);
      return null;
    }

    if (def.effect.kind === 'teleport') {
      // 125/126 are Doom II's monster-only teleport pair: vanilla lists them
      // only in `P_CrossSpecialLine`'s non-player branch, so a player walking
      // one does nothing at all. 39/97 work for either.
      if (def.effect.monsterOnly && !byMonster) return null;
      // A back-side crossing is `EV_Teleport`'s "so you can get out of
      // teleporter" case: no teleport, but the line is still consumed, since
      // vanilla's `case 39` clears `line->special` regardless of the result.
      // Same for a tag that matches no landing thing. docs/specials.md § Teleporters.
      const dest = fromBackSide ? null : this.findTeleportDestination(resolveTargets(this.map, line, def));
      if (!def.repeatable) this.usedOnce.add(lineIndex);
      if (!dest) return null;
      // A monster's teleport is the caller's to perform, and must *not* touch
      // `lastTeleport` — that exists solely to reseed the player's own
      // walk-trigger tracking (see its doc); where a monster jumped to says
      // nothing about where the player just walked.
      if (byMonster) return dest;
      this.lastTeleport = dest;
      this.onTeleport(dest);
      return null;
    }

    if (def.effect.kind === 'stairs') {
      for (const startSector of resolveTargets(this.map, line, def)) this.triggerStairs(startSector, def.effect);
      if (!def.repeatable) this.usedOnce.add(lineIndex);
      return null;
    }

    const targets = resolveTargets(this.map, line, def);
    if (targets.length === 0) return null;

    for (const sectorIndex of targets) {
      switch (def.effect.kind) {
        case 'door':
          this.triggerDoor(sectorIndex, def.effect);
          break;
        case 'lift':
          this.triggerLift(sectorIndex, def.effect);
          break;
        case 'floor':
          this.triggerFloor(sectorIndex, def.effect, line);
          break;
        case 'crusher':
          this.triggerCrusher(sectorIndex, def.effect);
          break;
        case 'crusherStop':
          this.triggerCrusherStop(sectorIndex);
          break;
        case 'ceiling':
          this.triggerCeiling(sectorIndex, def.effect);
          break;
        case 'raiseToTexture':
          this.triggerRaiseToTexture(sectorIndex);
          break;
        case 'lowerAndChange':
          this.triggerLowerAndChange(sectorIndex);
          break;
        case 'donut':
          // The tag match already resolved to the "hole" sector; the ring
          // and outer sectors are discovered dynamically inside — see
          // triggerDonut's doc.
          this.triggerDonut(sectorIndex);
          break;
        case 'lightChange':
          this.triggerLightChange(sectorIndex, def.effect);
          break;
        default:
          break;
      }
    }
    if (!def.repeatable) this.usedOnce.add(lineIndex);
    return null;
  }

  /**
   * A monster walking from `prev` to `pos` crosses whatever walk
   * triggers lie between — vanilla's `P_CrossSpecialLine` runs for any thing,
   * not just the player, but gates non-players to a very short allow-list
   * (`MONSTER_CROSSABLE`): teleports, one door type and two lift types.
   * Returns the landing spot if the crossing teleported it, so the caller can
   * move the monster and puff the fog; everything else (a door opening, a lift
   * dropping) happens as a side effect, exactly as it does under the player.
   *
   * This is what makes a mapper's monster closet work: the classic setup is a
   * pack of monsters behind a 125/126 line that only they can walk, teleporting
   * them into the arena the moment they start chasing.
   */
  crossMonster(prev: Pos2, pos: Pos2, ownedKeys: ReadonlySet<KeyColor>): TeleportDest | null {
    if (prev.x === pos.x && prev.y === pos.y) return null;
    for (const i of this.world.linesNear(pos.x, pos.y, MONSTER_CROSS_RADIUS)) {
      const line = this.map.linedefs[i];
      const def = LINE_SPECIALS[line.special];
      if (!def || def.trigger !== 'walk' || !MONSTER_CROSSABLE.has(line.special)) continue;
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      if (!segmentIntersect(prev.x, prev.y, pos.x, pos.y, a.x, a.y, b.x, b.y)) continue;
      const dest = this.trigger(i, ownedKeys, true, !isFrontSide(a.x, a.y, b.x, b.y, prev.x, prev.y));
      if (dest) return dest;
    }
    return null;
  }

  /**
   * Vanilla's `A_BossDeath` — see docs/death.md § Boss death. `game.ts` calls this once per
   * monster death that leaves none of its type alive on the level (`ThingLayer`'s own doomednum
   * check), already gated on the player being alive, matching vanilla's own check.
   */
  notifyBossDeath(type: number): void {
    for (const t of this.bossDeathTriggers) {
      if (t.type !== type) continue;
      if (t.action.kind === 'exit') this.onExit(false);
      else this.triggerTag(t.action.tag, t.action.kind);
    }
  }

  /** The tag-matched half of `notifyBossDeath` — no triggering linedef exists, so this scans sector tags directly rather than going through `resolveTargets`/`trigger`. */
  private triggerTag(tag: number, kind: 'lowerFloorToLowest' | 'raiseToTexture' | 'blazeOpen' | 'open'): void {
    for (let i = 0; i < this.map.sectors.length; i++) {
      if (this.map.sectors[i].tag !== tag) continue;
      switch (kind) {
        case 'lowerFloorToLowest':
          this.triggerFloor(i, {
            kind: 'floor',
            speed: FLOOR_SPEED,
            target: 'lowestNeighborFloor',
            changeTexture: false,
            crush: false,
          });
          break;
        case 'raiseToTexture':
          this.triggerRaiseToTexture(i);
          break;
        case 'blazeOpen':
          this.triggerDoor(i, { kind: 'door', speed: DOOR_SPEED_FAST, waitSeconds: DOOR_WAIT, mode: 'openOnly' });
          break;
        case 'open':
          // A_KeenDie's `EV_DoDoor(&junk, open)` — ordinary VDOORSPEED, opens and stays.
          this.triggerDoor(i, { kind: 'door', speed: DOOR_SPEED, waitSeconds: DOOR_WAIT, mode: 'openOnly' });
          break;
      }
    }
  }

  /**
   * Fires a `shoot` special (24, 46, 47) when a hitscan pellet or projectile
   * is stopped by exactly this line — vanilla's `P_ShootSpecialLine`. Unlike
   * the walk/use triggers, which scan nearby lines themselves (`linesNear`),
   * the caller already knows which line stopped the shot: `shotPath`
   * (`game/world.ts`) returns it directly, so this is a plain lookup rather
   * than another geometric search. `byMonster` reproduces vanilla's own
   * per-number gate (`SpecialDef.monsterCanTrigger` — true only for 46): a
   * monster's shot that happens to stop against a 24 or 47 line does nothing,
   * same as vanilla.
   */
  triggerShot(lineIndex: number | null, ownedKeys: ReadonlySet<KeyColor>, byMonster = false): void {
    if (lineIndex === null) return;
    const line = this.map.linedefs[lineIndex];
    const def = LINE_SPECIALS[line.special];
    if (!def || def.trigger !== 'shoot') return;
    if (byMonster && !def.monsterCanTrigger) return;
    this.trigger(lineIndex, ownedKeys, byMonster);
  }

  private handleUseTrigger(
    playerX: number,
    playerY: number,
    playerAngle: number,
    input: Input,
    ownedKeys: ReadonlySet<KeyColor>,
  ): void {
    if (!input.pressed('Space') && !input.rightMousePressed('use')) return;
    const tx = playerX + Math.cos(playerAngle) * USE_RANGE;
    const ty = playerY + Math.sin(playerAngle) * USE_RANGE;

    let bestT = Infinity;
    let bestLine = -1;
    for (const i of this.world.linesNear(playerX, playerY, USE_RANGE + 8)) {
      const line = this.map.linedefs[i];
      const def = LINE_SPECIALS[line.special];
      if (!def || def.trigger !== 'use') continue;
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      if (!isFrontSide(a.x, a.y, b.x, b.y, playerX, playerY)) continue;
      const hit = segmentIntersect(playerX, playerY, tx, ty, a.x, a.y, b.x, b.y);
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        bestLine = i;
      }
    }
    if (bestLine >= 0) this.trigger(bestLine, ownedKeys);
  }

  private handleWalkTriggers(playerX: number, playerY: number, ownedKeys: ReadonlySet<KeyColor>): void {
    if (playerX === this.prevX && playerY === this.prevY) return;
    for (const i of this.world.linesNear(playerX, playerY, PLAYER_RADIUS + 8)) {
      const line = this.map.linedefs[i];
      const def = LINE_SPECIALS[line.special];
      if (!def || def.trigger !== 'walk') continue;
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      if (!segmentIntersect(this.prevX, this.prevY, playerX, playerY, a.x, a.y, b.x, b.y)) continue;
      // `oldside`: the side the player was on before this frame's move — see `trigger`.
      this.trigger(i, ownedKeys, false, !isFrontSide(a.x, a.y, b.x, b.y, this.prevX, this.prevY));
    }
  }

  // ---- Switch textures -------------------------------------------------

  private flashSwitch(lineIndex: number): void {
    const entries = this.switchTextures.get(lineIndex);
    if (!entries || entries.length === 0) return;
    // `P_ChangeSwitchTexture` plays this from inside its switchlist match, so a
    // line whose textures aren't a switch pair is silent — the same condition
    // the early return above already encodes. It is always `swtchn`: vanilla's
    // `swtchx` for the exit switch is unreachable, since `line->special` is
    // zeroed for a one-shot switch *before* the `special == 11` test that would
    // pick it (p_switch.c). Faithful, including the dead sound.
    this.sfx.play('swtchn', this.switchOrigin(lineIndex), sectorOrigin(entries[0].sectorIndex));
    const dirty = new Set<number>();
    for (const e of entries) {
      this.map.sidedefs[e.sideIndex][e.slot] = e.onTexture;
      dirty.add(e.sectorIndex);
    }
    for (const sectorIndex of dirty) this.geometry.rebuild(sectorIndex);
    this.switchFlashes.set(lineIndex, SWITCH_FLASH_SECONDS);
  }

  private updateSwitchFlashes(dt: number): void {
    if (this.switchFlashes.size === 0) return;
    const dirty = new Set<number>();
    for (const [lineIndex, remaining] of this.switchFlashes) {
      const next = remaining - dt;
      if (next > 0) {
        this.switchFlashes.set(lineIndex, next);
        continue;
      }
      this.switchFlashes.delete(lineIndex);
      for (const e of this.switchTextures.get(lineIndex) ?? []) {
        this.map.sidedefs[e.sideIndex][e.slot] = e.offTexture;
        dirty.add(e.sectorIndex);
      }
    }
    for (const sectorIndex of dirty) this.geometry.rebuild(sectorIndex);
  }

  // ---- Lights --------------------------------------------------------

  private updateLights(dt: number): void {
    for (const [sectorIndex, state] of this.lightStates) {
      const value = Math.round(tickLight(state, dt));
      const sector = this.map.sectors[sectorIndex];
      if (sector.light === value) continue;
      sector.light = value;
      this.geometry.recolorSector(sectorIndex);
    }
  }

}
