import * as THREE from 'three';
import { NO_SIDE, type DoomMap, type LineDef } from '../wad/map.ts';
import {
  LINE_SPECIALS,
  SECTOR_LIGHT_SPECIALS,
  DOOR_OPEN_GAP,
  SWITCH_FLASH_SECONDS,
  switchPairTexture,
  type SpecialDef,
  type DoorEffect,
  type LiftEffect,
  type FloorEffect,
  type MoveTarget,
  type LightPattern,
} from '../wad/specials.ts';
import {
  PLAYER_RADIUS,
  World,
  lowestNeighborFloor,
  highestNeighborFloor,
  nextHigherFloor,
  nextLowerFloor,
  lowestNeighborCeiling,
  highestNeighborCeiling,
  darkestNeighborLight,
} from './world.ts';
import type { Input } from './input.ts';
import type { FogOfWar } from './fogofwar.ts';
import type { KeyColor } from './inventory.ts';
import {
  buildMoverMesh,
  lightToColor,
  type BuiltMap,
  type MapMeshOptions,
  type MoverMesh,
} from '../render/mapmesh.ts';
import type { SubSectorPoly } from '../render/bsp.ts';
import type { MaterialBank } from '../render/textures.ts';
import { FlatFader, WallFader } from '../render/occlusion.ts';
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
  for (const line of map.linedefs) {
    const def = LINE_SPECIALS[line.special];
    if (!def) continue;
    if (def.effect.kind !== 'exit') {
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

type DoorState = 'raising' | 'hold' | 'lowering' | 'open' | 'closed';
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
}

type Mover = DoorMover | LiftMover | FloorMover;

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
      return lowestNeighborCeiling(map, sectorIndex);
    case 'highestNeighborCeiling':
      return highestNeighborCeiling(map, sectorIndex);
  }
}

/**
 * One movable sector's geometry plus the two faders that own its vertex
 * alpha, exactly as `main.ts` runs them over the static batches. Mover walls
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
 * floor movers, blinking/flickering lights, and level exits. Sector heights
 * (`Sector.floorHeight`/`ceilHeight`/`light`) are mutated directly on the
 * `DoomMap` — `World` never caches them, so collision, sight-blocking and the
 * player's resting height all pick the change up on their very next query,
 * with no changes needed there. This controller only owns the two things
 * that don't already "just work": rebuilding the small per-sector geometry a
 * mover's height change invalidates, and re-triggering.
 *
 * Not modeled: crushers/damage floors (no player health system yet) and door
 * "un-crush" safety (a closing door won't reverse if something is standing
 * under it).
 */
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

    const lightSectors = computeLightSectors(map);
    for (const sectorIndex of lightSectors) {
      const sector = map.sectors[sectorIndex];
      const pattern = SECTOR_LIGHT_SPECIALS[sector.special];
      this.lightStates.set(sectorIndex, makeLightState(pattern, sector.light, darkestNeighborLight(map, sectorIndex)));
    }
    if (lightSectors.size > 0) {
      for (const o of built.occluders) {
        if (!lightSectors.has(o.sector)) continue;
        const arr = this.sectorOccluders.get(o.sector) ?? [];
        arr.push(o);
        this.sectorOccluders.set(o.sector, arr);
      }
      for (const f of built.flatSurfaces) {
        if (!lightSectors.has(f.sector)) continue;
        const arr = this.sectorFlats.get(f.sector) ?? [];
        arr.push(f);
        this.sectorFlats.set(f.sector, arr);
      }
    }
  }

  dispose(): void {
    for (const g of this.moverMeshes.values()) {
      this.scene.remove(g.mesh.group);
      disposeGroup(g.mesh.group);
    }
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
    this.handleUseTrigger(playerX, playerY, playerAngle, input, ownedKeys);
    this.handleWalkTriggers(playerX, playerY, ownedKeys);
    this.rebuildAround(dirty);
    this.updateSwitchFlashes(dt);
    this.updateLights(dt);
    this.prevX = playerX;
    this.prevY = playerY;
  }

  /**
   * Per-frame vertex-alpha pass over the mover geometry, mirroring what
   * `main.ts` runs over the static batches: camera-player sightline occlusion
   * combined with fog-of-war reveal. Separate from `update` because it needs
   * the camera position, which is only settled after the player has moved.
   */
  updateFading(
    dt: number,
    camX: number,
    camY: number,
    camZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
  ): void {
    for (const g of this.moverMeshes.values()) {
      g.walls.update(dt, camX, camY, camZ, targetX, targetY, targetZ);
      g.flats.update(dt, camX, camY, camZ, targetX, targetY, targetZ);
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
      else this.tickFloor(mover, dt, dirty);
    }
  }

  private tickDoor(mover: DoorMover, dt: number, dirty: Set<number>): void {
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.ceilHeight;
    if (mover.state === 'raising') {
      sector.ceilHeight = Math.min(mover.openHeight, sector.ceilHeight + mover.effect.speed * dt);
      if (sector.ceilHeight >= mover.openHeight) {
        sector.ceilHeight = mover.openHeight;
        mover.state = mover.effect.mode === 'openOnly' ? 'open' : 'hold';
        mover.holdRemaining = mover.effect.waitSeconds;
      }
    } else if (mover.state === 'hold') {
      mover.holdRemaining -= dt;
      if (mover.holdRemaining <= 0) mover.state = 'lowering';
    } else if (mover.state === 'lowering') {
      sector.ceilHeight = Math.max(mover.closeHeight, sector.ceilHeight - mover.effect.speed * dt);
      if (sector.ceilHeight <= mover.closeHeight) {
        sector.ceilHeight = mover.closeHeight;
        mover.state = 'closed';
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
    }
    if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
  }

  private triggerDoor(sectorIndex: number, effect: DoorEffect): void {
    const existing = this.movers.get(sectorIndex);
    if (!existing || existing.kind !== 'door') {
      const openHeight = lowestNeighborCeiling(this.map, sectorIndex) - DOOR_OPEN_GAP;
      const closeHeight = this.map.sectors[sectorIndex].floorHeight;
      this.movers.set(sectorIndex, {
        kind: 'door',
        sectorIndex,
        effect,
        openHeight,
        closeHeight,
        state: 'raising',
        holdRemaining: 0,
      });
      return;
    }
    const mover = existing;
    if (effect.mode === 'closeOnly') {
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

  private triggerFloor(sectorIndex: number, effect: FloorEffect): void {
    const existing = this.movers.get(sectorIndex);
    if (existing && existing.kind === 'floor' && existing.state === 'moving') return;
    const target = resolveFloorTarget(this.map, sectorIndex, effect.target);
    this.movers.set(sectorIndex, { kind: 'floor', sectorIndex, speed: effect.speed, target, state: 'moving' });
  }

  // ---- Triggers ----------------------------------------------------------

  private trigger(lineIndex: number, ownedKeys: ReadonlySet<KeyColor>): void {
    const line = this.map.linedefs[lineIndex];
    const def = LINE_SPECIALS[line.special];
    if (!def) return;
    if (!def.repeatable && this.usedOnce.has(lineIndex)) return;
    // A missing key leaves the door untouched and this attempt un-flagged, so
    // the player can walk off, find the key, and try the same line again —
    // matching vanilla, which just prints "you need the X key" and does
    // nothing else.
    if (def.effect.kind === 'door' && def.effect.requiredKey && !ownedKeys.has(def.effect.requiredKey)) return;

    this.flashSwitch(lineIndex);

    if (def.effect.kind === 'exit') {
      this.usedOnce.add(lineIndex);
      this.onExit(def.effect.secret);
      return;
    }

    const targets = resolveTargets(this.map, line, def);
    if (targets.length === 0) return;

    for (const sectorIndex of targets) {
      if (def.effect.kind === 'door') this.triggerDoor(sectorIndex, def.effect);
      else if (def.effect.kind === 'lift') this.triggerLift(sectorIndex, def.effect);
      else this.triggerFloor(sectorIndex, def.effect);
    }
    if (!def.repeatable) this.usedOnce.add(lineIndex);
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
