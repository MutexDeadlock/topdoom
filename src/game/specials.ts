import * as THREE from 'three';
import { NO_SIDE, type DoomMap, type LineDef } from '../wad/map.ts';
import {
  LINE_SPECIALS,
  SECTOR_LIGHT_SPECIALS,
  SECTOR_DOOR_SPECIALS,
  DOOR_SPEED,
  DOOR_WAIT,
  DOOR_OPEN_GAP,
  DOOR_CLOSE_WAIT_SECONDS,
  DOOR_RAISE_WAIT_SECONDS,
  EIGHT_UNIT_GAP,
  CRUSH_DAMAGE_INTERVAL,
  SWITCH_FLASH_SECONDS,
  TELEPORT_DEST,
  FLOOR_SPEED,
  switchPairTexture,
  type SpecialDef,
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
import type { Input } from './input.ts';
import type { FogOfWar } from './fogofwar.ts';
import type { KeyColor } from './inventory.ts';
import {
  buildMoverMesh,
  lightToColor,
  NO_TEXTURE,
  type BuiltMap,
  type MapMeshOptions,
  type MoverMesh,
} from '../render/mapmesh.ts';
import type { SubSectorPoly } from '../render/bsp.ts';
import type { MaterialBank } from '../render/textures.ts';
import { FlatFader, type FadeTarget, WallFader } from '../render/occlusion.ts';
import { segmentIntersect } from '../util/geom.ts';

/** How far ahead of the player a `use` press reaches, in map units. */
const USE_RANGE = 64;

/** Which sectors a special's linedef affects: the line's own back sector for manual doors, tag matches otherwise. */
function resolveTargets(map: DoomMap, line: LineDef, def: SpecialDef): number[] {
  if (def.manual) {
    const backSector = line.left !== NO_SIDE ? map.sidedefs[line.left]?.sector : undefined;
    return backSector !== undefined ? [backSector] : [];
  }
  if (line.tag === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < map.sectors.length; i++) {
    if (map.sectors[i].tag === line.tag) out.push(i);
  }
  return out;
}

/**
 * Every two-sided line's *other-side* sector index, in the order that line
 * appears in `map.linedefs` — which, since every stock WAD's `sector->lines[]`
 * is built by walking linedefs in that same ascending order (vanilla's own
 * `P_GroupLines`), is exactly the order vanilla itself would enumerate a given
 * sector's own bordering lines in. Used wherever a special's own vanilla
 * source walks `sec->lines[i]` and reacts to whichever neighbor comes first —
 * `lowerAndChange`'s model-sector search and the donut's ring/outer search.
 */
function neighborSectorIndices(map: DoomMap, sectorIndex: number): number[] {
  const out: number[] = [];
  for (const line of map.linedefs) {
    if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
    const front = map.sidedefs[line.right]?.sector;
    const back = map.sidedefs[line.left]?.sector;
    if (front === sectorIndex && back !== undefined) out.push(back);
    else if (back === sectorIndex && front !== undefined) out.push(front);
  }
  return out;
}

/**
 * Vanilla `P_PointOnLineSide`: true when (x, y) sits on the line's front
 * (right-sidedef) side. `P_UseSpecialLine` (confirmed against
 * `linuxdoom-1.10/p_switch.c`) rejects *every* use-triggered special except
 * an unused one (124, a "sliding door" case that never appears as a `use`
 * special in `LINE_SPECIALS`) when activated from the back side — so a
 * manual door or switch mounted on a wall is only usable from the side a
 * mapper actually intended, not through the wall from behind it.
 */
function isFrontSide(ax: number, ay: number, bx: number, by: number, x: number, y: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  return (y - ay) * dx < dy * (x - ax);
}

interface StairStep {
  sectorIndex: number;
  targetHeight: number;
}

/**
 * Vanilla `EV_BuildStairs`/`T_BuildStairs`: starting at `startSectorIndex`,
 * follow a chain of two-sided lines where the current sector is the line's
 * *front* side and the back sector's floor texture matches the start
 * sector's, each one `stepHeight` higher than the last. This is directional
 * and single-path, exactly like vanilla's own search — it takes the first
 * matching line it finds each round and never branches — so a mapper's stair
 * group only works if its connector lines all face the same way, same
 * requirement vanilla itself has. Purely a function of static map data
 * (adjacency + floor textures), so it's safe to run once at load time
 * (`computeMovableSectors`) and again at trigger time without the two ever
 * disagreeing.
 */
function findStairChain(map: DoomMap, startSectorIndex: number, stepHeight: number): StairStep[] {
  const texture = map.sectors[startSectorIndex]?.floorTex;
  if (texture === undefined) return [];
  const steps: StairStep[] = [];
  const visited = new Set<number>([startSectorIndex]);
  let sectorIndex = startSectorIndex;
  let height = map.sectors[startSectorIndex].floorHeight;
  for (;;) {
    height += stepHeight;
    steps.push({ sectorIndex, targetHeight: height });
    let next = -1;
    for (const line of map.linedefs) {
      if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
      if (map.sidedefs[line.right]?.sector !== sectorIndex) continue;
      const backSector = map.sidedefs[line.left]?.sector;
      if (backSector === undefined || visited.has(backSector)) continue;
      if (map.sectors[backSector]?.floorTex !== texture) continue;
      next = backSector;
      break;
    }
    if (next === -1) break;
    visited.add(next);
    sectorIndex = next;
  }
  return steps;
}

/** One sidedef texture slot that's a switch graphic (SW1/SW2 name), with both states resolved. */
interface SwitchEntry {
  sideIndex: number;
  slot: 'upper' | 'lower' | 'middle';
  sectorIndex: number;
  onTexture: string;
  offTexture: string;
}

/**
 * Switch-textured slots on either side of `line` — regardless of trigger
 * kind (walkover switches with real SW art exist too, if rarely). The
 * texture found at scan time is treated as "off"; its SW1/SW2 pair is "on".
 */
function findSwitchEntries(map: DoomMap, line: LineDef): SwitchEntry[] {
  const out: SwitchEntry[] = [];
  for (const sideIndex of [line.right, line.left]) {
    if (sideIndex === NO_SIDE) continue;
    const side = map.sidedefs[sideIndex];
    if (!side) continue;
    for (const slot of ['upper', 'lower', 'middle'] as const) {
      const offTexture = side[slot];
      const onTexture = switchPairTexture(offTexture);
      if (onTexture) out.push({ sideIndex, slot, sectorIndex: side.sector, onTexture, offTexture });
    }
  }
  return out;
}

/** Sectors whose height a mover will drive, or whose wall carries a switch texture — must stay out of the static batch (see mapmesh.ts). */
export function computeMovableSectors(map: DoomMap): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < map.sectors.length; i++) {
    // Sector-type door timers (10/14) never wait for a linedef trigger, so
    // there's no `def`/tag-resolution step to hook into here — the sector
    // itself is the mover from the moment the map loads.
    if (SECTOR_DOOR_SPECIALS[map.sectors[i].special] !== undefined) out.add(i);
  }
  for (const line of map.linedefs) {
    const def = LINE_SPECIALS[line.special];
    if (!def) continue;
    if (def.effect.kind === 'stairs') {
      // The tag match only names the chain's start; the rest is discovered by
      // walking the same texture-matched adjacency the trigger will use.
      for (const startSector of resolveTargets(map, line, def)) {
        for (const step of findStairChain(map, startSector, def.effect.stepHeight)) out.add(step.sectorIndex);
      }
    } else if (def.effect.kind === 'donut') {
      // Same reasoning as stairs above: the tag only names the "hole", and
      // its ring neighbor is discovered dynamically (see triggerDonut) so it
      // has to be walked here too, not just resolved from the tag.
      for (const startSector of resolveTargets(map, line, def)) {
        out.add(startSector);
        const ringIndex = neighborSectorIndices(map, startSector)[0];
        if (ringIndex !== undefined) out.add(ringIndex);
      }
    } else if (
      def.effect.kind !== 'exit' &&
      def.effect.kind !== 'teleport' &&
      def.effect.kind !== 'lightChange'
    ) {
      // Exit doesn't move geometry; teleport's tag match is a destination
      // lookup, not a mover — the target sector's own height never changes.
      // A pure light change never moves geometry either, and deliberately
      // stays out of the movable set: `recolorSector` only ever rewrites
      // static-batch geometry (see its doc), so pulling a lightChange-only
      // sector's geometry into a mover-mesh would just make it unreachable
      // from there instead.
      for (const sectorIndex of resolveTargets(map, line, def)) out.add(sectorIndex);
    }
    for (const e of findSwitchEntries(map, line)) out.add(e.sectorIndex);
  }
  return out;
}

/** Sectors animating their light level — no geometry impact, just a recolor. */
export function computeLightSectors(map: DoomMap): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < map.sectors.length; i++) {
    if (SECTOR_LIGHT_SPECIALS[map.sectors[i].special] !== undefined) out.add(i);
  }
  return out;
}

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
  /** Counts down to the next `onCrush` call while `crush` is set and `state === 'moving'`; see `CrusherMover.crushTimer`. */
  crushTimer: number;
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

/** A one-way ceiling mover — see `CeilingEffect`'s doc. No hold, no reversal, no crush handling: vanilla has no case that needs any of those for this mover. */
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
  /** Counts down to the next `onCrush` call; reset to `CRUSH_DAMAGE_INTERVAL` each time it fires, matching vanilla's every-4-tics cadence. */
  crushTimer: number;
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
const BLINK_BRIGHT_TIME = 5 / 35;
const BLINK_05_DARK = 15 / 35;
const BLINK_1_DARK = 35 / 35;
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
 * One movable sector's geometry plus the two faders that own its vertex
 * alpha, exactly as `game.ts` runs them over the static batches. Mover walls
 * need the camera-player sightline fade for the same reason static ones do —
 * a lift's front wall or a door frame sits between camera and player just as
 * readily as any other wall — and rebuilding the mesh drops the faders'
 * smoothing state with it, which only ever happens while the mover is in
 * motion.
 */
interface MoverGeometry {
  mesh: MoverMesh;
  walls: WallFader;
  flats: FlatFader;
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
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
 * `onExit`/`onTeleport` are callbacks rather than direct calls. Unlike
 * vanilla, nothing here actually *blocks* the mover on contact (no
 * thing/geometry collision check for movers exists), so a crusher never
 * stops or reverses early — it just keeps hurting whoever's in its way every
 * `CRUSH_DAMAGE_INTERVAL` until they leave or die, which is the part of the
 * vanilla behavior that actually matters for how a crusher reads as a hazard.
 *
 * Stair builders (`triggerStairs`/`findStairChain`) reuse the plain
 * `FloorMover` machinery per step — a stair step is just a floor rising to a
 * fixed height — with the chain of sectors to raise discovered once at load
 * time (`computeMovableSectors`) by walking the same texture-matched
 * adjacency the trigger itself uses at runtime.
 *
 * Not modeled: damage-floor sector specials (a sustained per-tic hazard like
 * nukage/lava — a different mechanism from a mover's periodic crush damage),
 * and door "un-crush" safety (a closing door won't reverse if something is
 * standing under it — doors have no `crush` flag at all here).
 */
/** A teleport landing spot: where to put the thing, and which way it should face on arrival. */
export interface TeleportDest {
  x: number;
  y: number;
  angle: number;
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
  private scene: THREE.Scene | THREE.Group;
  private fog: FogOfWar;
  private polys: SubSectorPoly[];
  private built: BuiltMap;
  private meshOptions: MapMeshOptions;
  private onExit: (secret: boolean) => void;
  private onTeleport: (x: number, y: number, angle: number) => void;
  private onCrush: (sectorIndex: number) => void;

  private movableSectors: Set<number>;
  /** Movable sectors sharing a linedef with a given movable sector — see `rebuildAround`. */
  private movableNeighbors = new Map<number, Set<number>>();
  private movers = new Map<number, Mover>();
  private moverMeshes = new Map<number, MoverGeometry>();
  private usedOnce = new Set<number>();

  private switchTextures = new Map<number, SwitchEntry[]>();
  private switchFlashes = new Map<number, number>();

  private lightStates = new Map<number, LightState>();
  private sectorOccluders = new Map<number, BuiltMap['occluders']>();
  private sectorFlats = new Map<number, BuiltMap['flatSurfaces']>();

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
  private lastTeleport: { x: number; y: number } | null = null;

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
    onTeleport: (x: number, y: number, angle: number) => void,
    onCrush: (sectorIndex: number) => void,
    playerX: number,
    playerY: number,
  ) {
    this.map = map;
    this.world = world;
    this.bank = bank;
    this.scene = scene;
    this.fog = fog;
    this.polys = polys;
    this.built = built;
    this.onExit = onExit;
    this.onTeleport = onTeleport;
    this.onCrush = onCrush;
    this.prevX = playerX;
    this.prevY = playerY;

    for (const [i, line] of map.linedefs.entries()) {
      if (!LINE_SPECIALS[line.special]) continue;
      const entries = findSwitchEntries(map, line);
      if (entries.length > 0) this.switchTextures.set(i, entries);
    }

    this.movableSectors = computeMovableSectors(map);
    // buildMoverMesh needs the full set to decide which side of a shared line
    // is its own — see its doc; the caller only passes render preferences.
    this.meshOptions = { ...meshOptions, movableSectors: this.movableSectors };
    this.indexMovableNeighbors();
    for (const sectorIndex of this.movableSectors) this.createMoverMesh(sectorIndex);

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
    this.indexLightGeometry();
  }

  dispose(): void {
    for (const g of this.moverMeshes.values()) {
      this.scene.remove(g.mesh.group);
      disposeGroup(g.mesh.group);
    }
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
   * `sectorOccluders`/`sectorFlats` point at every sector's own occluder/flat
   * objects, pulled out of `built.occluders`/`built.flatSurfaces` once at
   * construction time so `recolorSector` never has to re-scan the whole map.
   * Originally scoped to just the load-time blink-pattern sectors
   * (`lightStates`), but the `lightChange` line specials
   * (`triggerLightChange`) can recolor *any* tag-matched sector on demand,
   * not just ones with an ongoing pattern, so this indexes every sector
   * unconditionally now — a one-time, load-only cost. Static-batch-only, same
   * as `recolorSector` itself: a sector that's also a mover (in
   * `movableSectors`) has its geometry in its own `moverMeshes` entry
   * instead, out of reach here — an existing limitation the blink-pattern
   * feature already had, not a new one.
   */
  private indexLightGeometry(): void {
    this.sectorOccluders.clear();
    this.sectorFlats.clear();
    for (const o of this.built.occluders) {
      const arr = this.sectorOccluders.get(o.sector) ?? [];
      arr.push(o);
      this.sectorOccluders.set(o.sector, arr);
    }
    for (const f of this.built.flatSurfaces) {
      const arr = this.sectorFlats.get(f.sector) ?? [];
      arr.push(f);
      this.sectorFlats.set(f.sector, arr);
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
  private consumeLastTeleport(): { x: number; y: number } | null {
    return this.lastTeleport;
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
    this.tickMovers(dt, dirty);
    this.lastTeleport = null;
    this.handleUseTrigger(playerX, playerY, playerAngle, input, ownedKeys);
    this.handleWalkTriggers(playerX, playerY, ownedKeys);
    this.rebuildAround(dirty);
    this.updateSwitchFlashes(dt);
    this.updateLights(dt);
    // See `lastTeleport`'s doc: a teleport this frame reseeds prevX/prevY from
    // the destination, not the (now stale, pre-teleport) playerX/playerY.
    const teleport = this.consumeLastTeleport();
    this.prevX = teleport ? teleport.x : playerX;
    this.prevY = teleport ? teleport.y : playerY;
  }

  /**
   * Per-frame vertex-alpha pass over the mover geometry, mirroring what
   * `game.ts` runs over the static batches: camera sightline occlusion
   * (player plus every awake monster — see `WallFader.update`'s doc) combined
   * with fog-of-war reveal. Separate from `update` because it needs the
   * camera position, which is only settled after the player has moved.
   */
  updateFading(dt: number, camX: number, camY: number, camZ: number, targets: FadeTarget[]): void {
    for (const g of this.moverMeshes.values()) {
      g.walls.update(dt, camX, camY, camZ, targets, (line) => this.world.openingOf(line));
      g.flats.update(dt, camX, camY, camZ, targets);
      // Mover quads aren't in the static occluder list FogOfWar indexed at
      // load, so their subsector is probed from the quad itself.
      g.walls.commit((i) => {
        const q = g.mesh.wallQuads[i];
        return this.fog.wallAlphaAt(q.ax, q.ay, q.bx, q.by);
      });
      g.flats.commit((subsector) => this.fog.alphaOf(subsector));
    }
  }

  private createMoverMesh(sectorIndex: number): void {
    const mesh = buildMoverMesh(this.map, this.polys, sectorIndex, this.bank, this.meshOptions);
    this.scene.add(mesh.group);
    this.moverMeshes.set(sectorIndex, {
      mesh,
      walls: new WallFader(mesh.wallQuads, mesh.meshes),
      flats: new FlatFader(mesh.flatFans, mesh.meshes),
    });
  }

  private rebuildMoverMesh(sectorIndex: number): void {
    const old = this.moverMeshes.get(sectorIndex);
    if (old) {
      this.scene.remove(old.mesh.group);
      disposeGroup(old.mesh.group);
    }
    this.createMoverMesh(sectorIndex);
  }

  /**
   * Rebuilds the meshes invalidated by a set of sectors having changed height.
   * That is never just those sectors: a two-sided line's *other* side is drawn
   * from both sectors' heights, so a movable neighbour's own quads on a shared
   * line go stale too (a switch mounted on the wall of the lift it operates is
   * the common case — the switch's own sector owns that quad, but its height
   * comes from the lift). Static neighbours need no entry here: their side of
   * such a line is built into this mover's mesh, not the static batch.
   */
  private rebuildAround(dirty: Set<number>): void {
    if (dirty.size === 0) return;
    const rebuild = new Set(dirty);
    for (const sectorIndex of dirty) {
      for (const n of this.movableNeighbors.get(sectorIndex) ?? []) rebuild.add(n);
    }
    for (const sectorIndex of rebuild) this.rebuildMoverMesh(sectorIndex);
  }

  private indexMovableNeighbors(): void {
    for (const line of this.map.linedefs) {
      if (line.right === NO_SIDE || line.left === NO_SIDE) continue;
      const a = this.map.sidedefs[line.right]?.sector;
      const b = this.map.sidedefs[line.left]?.sector;
      if (a === undefined || b === undefined || a === b) continue;
      if (!this.movableSectors.has(a) || !this.movableSectors.has(b)) continue;
      this.link(a, b);
      this.link(b, a);
    }
  }

  private link(from: number, to: number): void {
    const set = this.movableNeighbors.get(from) ?? new Set<number>();
    set.add(to);
    this.movableNeighbors.set(from, set);
  }

  // ---- Movers ----------------------------------------------------------

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
      if (mover.holdRemaining <= 0) mover.state = 'lowering';
    } else if (mover.state === 'holdClosed') {
      mover.holdRemaining -= dt;
      if (mover.holdRemaining <= 0) mover.state = 'raising';
    } else if (mover.state === 'lowering') {
      sector.ceilHeight = Math.max(mover.closeHeight, sector.ceilHeight - mover.effect.speed * dt);
      if (sector.ceilHeight <= mover.closeHeight) {
        sector.ceilHeight = mover.closeHeight;
        if (mover.effect.mode === 'closeThenOpen') {
          mover.state = 'holdClosed';
          mover.holdRemaining = DOOR_CLOSE_WAIT_SECONDS;
        } else {
          mover.state = 'closed';
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
      }
    } else if (mover.state === 'hold') {
      mover.holdRemaining -= dt;
      if (mover.holdRemaining <= 0) mover.state = 'raising';
    } else if (mover.state === 'raising') {
      sector.floorHeight = Math.min(mover.restHeight, sector.floorHeight + mover.effect.speed * dt);
      if (sector.floorHeight >= mover.restHeight) {
        sector.floorHeight = mover.restHeight;
        mover.state = 'rest';
      }
    }
    if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
  }

  private tickFloor(mover: FloorMover, dt: number, dirty: Set<number>): void {
    if (mover.state === 'done') return;
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.floorHeight;
    const dir = mover.target > sector.floorHeight ? 1 : -1;
    sector.floorHeight += dir * mover.speed * dt;
    if ((dir > 0 && sector.floorHeight >= mover.target) || (dir < 0 && sector.floorHeight <= mover.target)) {
      sector.floorHeight = mover.target;
      mover.state = 'done';
      if (mover.arrivalTexture) {
        sector.floorTex = mover.arrivalTexture.floorTex;
        sector.special = mover.arrivalTexture.special;
      }
    }
    if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
    if (mover.crush) this.tickCrush(mover.sectorIndex, mover, dt);
  }

  /** One-way ceiling move — see `CeilingMover`'s doc for why there's no hold/reversal/crush handling at all. */
  private tickCeiling(mover: CeilingMover, dt: number, dirty: Set<number>): void {
    if (mover.state === 'done') return;
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.ceilHeight;
    const dir = mover.target > sector.ceilHeight ? 1 : -1;
    sector.ceilHeight += dir * mover.speed * dt;
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
    if (mover.state === 'lowering') {
      sector.ceilHeight = Math.max(mover.bottomHeight, sector.ceilHeight - mover.speed * dt);
      if (sector.ceilHeight <= mover.bottomHeight) {
        sector.ceilHeight = mover.bottomHeight;
        mover.state = 'raising';
      }
    } else {
      sector.ceilHeight = Math.min(mover.topHeight, sector.ceilHeight + mover.speed * dt);
      if (sector.ceilHeight >= mover.topHeight) {
        sector.ceilHeight = mover.topHeight;
        mover.state = 'lowering';
      }
    }
    if (sector.ceilHeight !== before) dirty.add(mover.sectorIndex);
    this.tickCrush(mover.sectorIndex, mover, dt);
  }

  /** Fires `onCrush` for `sectorIndex` every `CRUSH_DAMAGE_INTERVAL`, matching vanilla's every-4-tics crush-damage cadence. */
  private tickCrush(sectorIndex: number, timer: { crushTimer: number }, dt: number): void {
    timer.crushTimer -= dt;
    if (timer.crushTimer > 0) return;
    this.onCrush(sectorIndex);
    timer.crushTimer += CRUSH_DAMAGE_INTERVAL;
  }

  private triggerDoor(sectorIndex: number, effect: DoorEffect): void {
    const existing = this.movers.get(sectorIndex);
    if (!existing || existing.kind !== 'door') {
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
      return;
    }
    const mover = existing;
    if (effect.mode === 'closeOnly' || effect.mode === 'closeThenOpen') {
      mover.state = 'lowering';
      return;
    }
    if (effect.mode === 'openOnly') {
      if (mover.state === 'closed' || mover.state === 'lowering') mover.state = 'raising';
      return;
    }
    if (mover.state === 'closed' || mover.state === 'open') mover.state = 'raising';
    else if (mover.state === 'hold') mover.holdRemaining = effect.waitSeconds;
    else if (mover.state === 'lowering') mover.state = 'raising';
  }

  private triggerLift(sectorIndex: number, effect: LiftEffect): void {
    const existing = this.movers.get(sectorIndex);
    if (!existing || existing.kind !== 'lift') {
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
      return;
    }
    if (existing.state === 'rest') existing.state = 'lowering';
  }

  private triggerFloor(sectorIndex: number, effect: FloorEffect, line: LineDef): void {
    const existing = this.movers.get(sectorIndex);
    if (existing && existing.kind === 'floor' && existing.state === 'moving') return;
    if (effect.changeTexture) this.applyFloorChange(sectorIndex, line);
    const target = resolveFloorTarget(this.map, sectorIndex, effect.target);
    this.movers.set(sectorIndex, {
      kind: 'floor',
      sectorIndex,
      speed: effect.speed,
      target,
      state: 'moving',
      crush: effect.crush,
      crushTimer: CRUSH_DAMAGE_INTERVAL,
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
    this.rebuildMoverMesh(sectorIndex);
  }

  /** A sector already crushing (in either direction) ignores a re-trigger, matching vanilla's `sec->specialdata` guard. */
  private triggerCrusher(sectorIndex: number, effect: CrusherEffect): void {
    const existing = this.movers.get(sectorIndex);
    if (existing && existing.kind === 'crusher') {
      if (existing.state === 'stopped') existing.state = 'lowering';
      return;
    }
    const sector = this.map.sectors[sectorIndex];
    this.movers.set(sectorIndex, {
      kind: 'crusher',
      sectorIndex,
      speed: effect.speed,
      topHeight: sector.ceilHeight,
      bottomHeight: sector.floorHeight + EIGHT_UNIT_GAP,
      state: 'lowering',
      crushTimer: CRUSH_DAMAGE_INTERVAL,
    });
  }

  private triggerCrusherStop(sectorIndex: number): void {
    const existing = this.movers.get(sectorIndex);
    if (existing && existing.kind === 'crusher') existing.state = 'stopped';
  }

  /** Vanilla's own `sec->specialdata` guard: a sector already driven by *any* mover ignores this — unlike doors/lifts/floors above, there's no interactive re-trigger behavior worth having for a one-way move. */
  private triggerCeiling(sectorIndex: number, effect: CeilingEffect): void {
    if (this.movers.has(sectorIndex)) return;
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
    const existing = this.movers.get(sectorIndex);
    if (existing && existing.kind === 'floor' && existing.state === 'moving') return;
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
      crushTimer: CRUSH_DAMAGE_INTERVAL,
    });
  }

  /**
   * Vanilla's `lowerAndChange` — see `LowerAndChangeEffect`'s doc for the
   * model-sector search and why the texture/special only apply on arrival
   * (`arrivalTexture`, applied by `tickFloor`).
   */
  private triggerLowerAndChange(sectorIndex: number): void {
    const existing = this.movers.get(sectorIndex);
    if (existing && existing.kind === 'floor' && existing.state === 'moving') return;
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
      crushTimer: CRUSH_DAMAGE_INTERVAL,
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
    if (this.movers.has(holeIndex)) return;
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
      crushTimer: CRUSH_DAMAGE_INTERVAL,
      arrivalTexture: { floorTex: outer.floorTex, special: 0 },
    });
    this.movers.set(holeIndex, {
      kind: 'floor',
      sectorIndex: holeIndex,
      speed: FLOOR_SPEED / 2,
      target: outer.floorHeight,
      state: 'moving',
      crush: false,
      crushTimer: CRUSH_DAMAGE_INTERVAL,
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
        this.recolorSector(sectorIndex);
        break;
      case 'brightestNeighbor': {
        let bright = 0;
        for (const n of neighborSectorIndices(this.map, sectorIndex)) bright = Math.max(bright, this.map.sectors[n].light);
        sector.light = bright;
        this.recolorSector(sectorIndex);
        break;
      }
      case 'darkestNeighbor': {
        let min = sector.light;
        for (const n of neighborSectorIndices(this.map, sectorIndex)) {
          if (this.map.sectors[n].light < min) min = this.map.sectors[n].light;
        }
        sector.light = min;
        this.recolorSector(sectorIndex);
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
    if (this.movers.has(startSectorIndex)) return; // vanilla's sec->specialdata guard
    for (const step of findStairChain(this.map, startSectorIndex, effect.stepHeight)) {
      if (this.movers.has(step.sectorIndex)) continue;
      this.movers.set(step.sectorIndex, {
        kind: 'floor',
        sectorIndex: step.sectorIndex,
        speed: effect.speed,
        target: step.targetHeight,
        state: 'moving',
        // Despite the wiki naming 100/127 "...and Crush", real vanilla
        // stairs never set a crush flag — see StairsEffect's doc.
        crush: false,
        crushTimer: CRUSH_DAMAGE_INTERVAL,
      });
    }
  }

  /** First `TELEPORT_DEST` (doomednum 14) thing sitting in one of the tag-matched sectors — vanilla's own search is just as arbitrary when more than one exists. */
  private findTeleportDestination(sectorIndices: number[]): { x: number; y: number; angle: number } | null {
    if (sectorIndices.length === 0) return null;
    const targets = new Set(sectorIndices);
    for (const t of this.map.things) {
      if (t.type !== TELEPORT_DEST) continue;
      if (targets.has(this.world.sectorIndexAt(t.x, t.y))) return { x: t.x, y: t.y, angle: (t.angle * Math.PI) / 180 };
    }
    return null;
  }

  // ---- Triggers ----------------------------------------------------------

  private trigger(lineIndex: number, ownedKeys: ReadonlySet<KeyColor>, byMonster = false): TeleportDest | null {
    const line = this.map.linedefs[lineIndex];
    const def = LINE_SPECIALS[line.special];
    if (!def) return null;
    if (!def.repeatable && this.usedOnce.has(lineIndex)) return null;
    // A missing key leaves the door untouched and this attempt un-flagged, so
    // the player can walk off, find the key, and try the same line again —
    // matching vanilla, which just prints "you need the X key" and does
    // nothing else.
    if (def.effect.kind === 'door' && def.effect.requiredKey && !ownedKeys.has(def.effect.requiredKey)) return null;

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
      const dest = this.findTeleportDestination(resolveTargets(this.map, line, def));
      if (!dest) return null; // no matching landing thing — vanilla leaves the special un-consumed too
      if (!def.repeatable) this.usedOnce.add(lineIndex);
      // A monster's teleport is the caller's to perform, and must *not* touch
      // `lastTeleport` — that exists solely to reseed the player's own
      // walk-trigger tracking (see its doc); where a monster jumped to says
      // nothing about where the player just walked.
      if (byMonster) return dest;
      this.lastTeleport = dest;
      this.onTeleport(dest.x, dest.y, dest.angle);
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
   * A monster walking from (prevX, prevY) to (x, y) crosses whatever walk
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
  crossMonster(prevX: number, prevY: number, x: number, y: number, ownedKeys: ReadonlySet<KeyColor>): TeleportDest | null {
    if (prevX === x && prevY === y) return null;
    for (const i of this.world.linesNear(x, y, MONSTER_CROSS_RADIUS)) {
      const line = this.map.linedefs[i];
      const def = LINE_SPECIALS[line.special];
      if (!def || def.trigger !== 'walk' || !MONSTER_CROSSABLE.has(line.special)) continue;
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      if (!segmentIntersect(prevX, prevY, x, y, a.x, a.y, b.x, b.y)) continue;
      const dest = this.trigger(i, ownedKeys, true);
      if (dest) return dest;
    }
    return null;
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
    if (!input.pressed('Space')) return;
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
      if (segmentIntersect(this.prevX, this.prevY, playerX, playerY, a.x, a.y, b.x, b.y)) this.trigger(i, ownedKeys);
    }
  }

  // ---- Switch textures -------------------------------------------------

  private flashSwitch(lineIndex: number): void {
    const entries = this.switchTextures.get(lineIndex);
    if (!entries || entries.length === 0) return;
    const dirty = new Set<number>();
    for (const e of entries) {
      this.map.sidedefs[e.sideIndex][e.slot] = e.onTexture;
      dirty.add(e.sectorIndex);
    }
    for (const sectorIndex of dirty) this.rebuildMoverMesh(sectorIndex);
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
    for (const sectorIndex of dirty) this.rebuildMoverMesh(sectorIndex);
  }

  // ---- Lights --------------------------------------------------------

  private updateLights(dt: number): void {
    for (const [sectorIndex, state] of this.lightStates) {
      const value = Math.round(tickLight(state, dt));
      const sector = this.map.sectors[sectorIndex];
      if (sector.light === value) continue;
      sector.light = value;
      this.recolorSector(sectorIndex);
    }
  }

  private recolorSector(sectorIndex: number): void {
    const sector = this.map.sectors[sectorIndex];
    const dirty = new Set<string>();

    for (const o of this.sectorOccluders.get(sectorIndex) ?? []) {
      const dx = o.bx - o.ax;
      const dy = o.by - o.ay;
      const contrast = dy === 0 ? 16 : dx === 0 ? -16 : 0;
      const c = lightToColor(sector.light, contrast);
      const attr = this.built.wallMeshes.get(o.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      for (let v = 0; v < o.vertexCount; v++) attr.setXYZ(o.vertexStart + v, c, c, c);
      dirty.add(o.key);
    }
    for (const f of this.sectorFlats.get(sectorIndex) ?? []) {
      const c = lightToColor(sector.light);
      const attr = this.built.flatMeshes.get(f.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      for (let v = 0; v < f.vertexCount; v++) attr.setXYZ(f.vertexStart + v, c, c, c);
      dirty.add(f.key);
    }

    for (const key of dirty) {
      const attr = (this.built.wallMeshes.get(key) ?? this.built.flatMeshes.get(key))?.geometry.getAttribute('color') as
        | THREE.BufferAttribute
        | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }

}
