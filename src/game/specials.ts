/**
 * `SpecialsController`: drives every linedef/sector special in a loaded map — doors, lifts, floor
 * movers, crushers, stair builders, teleporters, lights and exits. See docs/specials.md.
 */
import * as THREE from 'three';
import { LF, NO_SIDE, type DoomMap, type LineDef, type Sector } from '../wad/map.ts';
import type { SwitchPairLookup } from '../wad/switches.ts';
import {
  bossDeathTriggersFor,
  computeLightSectors,
  findStairChain,
  findSwitchEntries,
  isFrontSide,
  neighborSectorIndices,
  resolveTargets,
  type BossDeathTrigger,
  type SwitchEntry,
} from './specials/mapscan.ts';
import { MoverGeometry } from './specials/movergeometry.ts';
import { lookupSpecial } from './specials/tables.ts';
import { decodeSectorType } from './specials/sectortypes.ts';
import {
  DOOR_SPEED,
  DOOR_SPEED_FAST,
  DOOR_WAIT,
  DOOR_OPEN_GAP,
  DOOR_CLOSE_WAIT_SECONDS,
  DOOR_RAISE_WAIT_SECONDS,
  EIGHT_UNIT_GAP,
  CRUSH_DAMAGE_INTERVAL,
  CRUSH_SLOWDOWN,
  SWITCH_FLASH_SECONDS,
  FLOOR_SPEED,
  type Activator,
  type Effect,
  type LockRule,
  type ChangeOnlyEffect,
  type DoorEffect,
  type ElevatorEffect,
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
  switchPairTexture,
  type SpecialDef,
  type SurfaceChange,
  type TeleportEffect,
} from './specials/defs.ts';
import {
  World,
  lowestNeighborFloor,
  highestNeighborFloor,
  nextHigherFloor,
  nextLowerFloor,
  lowestNeighborCeiling,
  highestNeighborCeiling,
  nextHigherCeiling,
  nextLowerCeiling,
  darkestNeighborLight,
  sectorLines,
  sectorsByTag,
  linesByTag,
} from './world.ts';
import { PLAYER_RADIUS } from './player.ts';
import type { SpecialsSnapshot } from './snapshot.ts';
import { pRandom } from '../util/random.ts';
import { spawnAngleDeg } from './skill.ts';
import { ThingType } from './things/doomednums.ts';
import type { CrossingBody } from './things/defs.ts';
import type { Input } from './input.ts';
import type { FogOfWar } from './fogofwar.ts';
import { satisfiesLock, type KeySlot } from './inventory.ts';
import { NO_TEXTURE, type BuiltMap, type MapMeshOptions } from '../render/mapmesh.ts';
import type { SubSectorPoly } from '../render/bsp.ts';
import type { Placement, Pos2 } from '../types.ts';
import type { MaterialBank } from '../render/textures.ts';
import type { FadeTarget } from '../render/occlusion.ts';
import { segmentIntersect } from '../util/geom.ts';
import { sectorOrigin, SILENT, type SfxId, type SoundEmitter } from '../audio/sfx.ts';
import { DOOM_TIC } from '../constants.ts';

export {
  // Re-exported so `./specials.ts` stays the specials layer's one public entry
  // point, the same arrangement `things.ts` makes for `things/`. Both of these
  // are driven by `game.ts` rather than by `SpecialsController`, so this is a
  // plain pass-through and nothing more: the tidier shape is for the controller
  // to own the two outright, which is a bigger change than moving the files was.
  SectorEffects,
  type SectorEffectResult,
} from './specials/sectoreffects.ts';
export { applyCrushDamage, blocksCeilingLower, blocksFloorRise } from './specials/moverblocking.ts';

/** How far ahead of the player a `use` press reaches, in map units. */
const USE_RANGE = 64;

/**
 * How far off an exit linedef a line-to-line teleport places a body that
 * landed on the wrong side of it. Vanilla's `EV_SilentLineTeleport` nudges by
 * up to `FUDGEFACTOR` = 10 *fixed-point* units — 10/65536 of a map unit — to
 * settle a rounding error its own `FixedMul` interpolation created. That is a
 * fixed-point artifact rather than a gameplay rule, so this is the float
 * equivalent: one step along the exit line's normal, small against any body
 * radius and large enough that the side test can't flip back.
 */
const LINE_TELEPORT_NUDGE = 0.01;

/** The `TeleportSource` for a caller with no silent teleport in play — see `trigger`'s `at`. */
const NO_SOURCE: TeleportSource = { x: 0, y: 0, angle: 0 };

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

/**
 * `'stasis'` is vanilla `in_stasis` (`EV_StopPlat` froze it; `stasisFrom`
 * remembers the direction, vanilla's `oldstatus`). `'hold'` serves both ends
 * of a perpetual lift's travel — on expiry the direction is re-derived from
 * which end it sits at (`T_PlatRaise`'s own `floorheight == low` test).
 */
type LiftState = 'lowering' | 'hold' | 'raising' | 'rest' | 'stasis';
interface LiftMover {
  kind: 'lift';
  sectorIndex: number;
  effect: LiftEffect;
  restHeight: number;
  downHeight: number;
  state: LiftState;
  holdRemaining: number;
  /**
   * Vanilla `perpetualRaise`: never removed, waits at *both* ends. Optional —
   * absent on movers from older saves, where plain downWaitUpStay is right.
   */
  perpetual?: boolean;
  /** The direction a stop line froze this lift out of — see `LiftState`. */
  stasisFrom?: Exclude<LiftState, 'stasis'>;
  /**
   * Boom's `toggleUpDn` (211/212): each stroke completes in the tic it starts
   * and parks in `'stasis'`, so the next activation reverses it. In vanilla
   * the instantness is *emergent* — `T_MovePlane` is told to move down toward
   * a destination that is above the floor, so its very first step clamps to
   * the target and reports `pastdest`. This engine's movers auto-direction
   * toward their target instead, so nothing would clamp; the flag says so
   * explicitly. Optional, so an older save reads as an ordinary lift.
   */
  instant?: boolean;
  /**
   * `plat->crush`. Only a toggle plat sets it (`p_plats.c`), and it means the
   * grind-through rule rather than the reverse-on-obstruction one every other
   * lift follows — docs/specials.md § Toggle plats.
   */
  crush?: boolean;
}

interface FloorMover {
  kind: 'floor';
  sectorIndex: number;
  speed: number;
  target: number;
  state: 'moving' | 'done';
  crush: boolean;
  /**
   * `floor->direction`, copied from the effect that started this mover and
   * fixed for its life — what `tickFloor` steps along instead of re-deriving a
   * direction from `target` each tick. It only shows when `target` sits on the
   * *far* side of it, which `T_MovePlane` then takes in one step rather than
   * travelling the wrong way at mover speed. Absent on a mover from a save
   * written before this field existed, where re-deriving is the old behavior.
   * docs/specials.md § Inverted floor moves.
   */
  direction?: 'up' | 'down';
  /**
   * Texture/special applied only once this mover reaches `target`, never at
   * trigger time — vanilla's `lowerAndChange` and the donut's ring riser
   * (`donutRaise`), both of which apply `floor->texture`/`newspecial` in
   * `T_MoveFloor`'s `pastdest` branch rather than up front the way this
   * table's ordinary `FloorEffect.changeTexture` family does. `tickFloor`
   * applies it in the same tick the mover's `state` flips to `'done'`.
   * `special` absent (Boom's texture-only change, `FChgTxt`) leaves the
   * sector's special untouched — old saves always carry a number here, which
   * restores the old always-write behavior exactly.
   */
  arrivalTexture?: { floorTex: string; special?: number };
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
  /** Boom generalized ceilings only — grind through a body, full speed, periodic damage (see `CeilingEffect.crush`). Absent = vanilla's stall. */
  crush?: boolean;
  /** Boom's arrival-time change, ceiling flavor (`SurfaceChange`) — applied like `FloorMover.arrivalTexture`. */
  arrivalTexture?: { ceilTex: string; special?: number };
}

/**
 * Boom's elevator (`p_floor.c: T_MoveElevator`): floor and ceiling in
 * lockstep, gap preserved. One target pair fixed at trigger time, one-way,
 * done on arrival — the direction falls out of `floorTarget` vs. the live
 * floor each tick, like `FloorMover`.
 */
interface ElevatorMover {
  kind: 'elevator';
  sectorIndex: number;
  speed: number;
  floorTarget: number;
  ceilTarget: number;
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
  /**
   * Which way it was travelling when a 57/74 stop line froze it, so a restart
   * resumes that direction — vanilla's `olddirection`, saved by
   * `EV_CeilingCrushStop` and put back by `P_ActivateInStasisCeiling`. Optional
   * because a mover saved before this field existed has none; `'lowering'` is
   * the compatible default there, matching the old unconditional behavior.
   * docs/specials.md § Crushers.
   */
  stoppedFrom?: 'lowering' | 'raising';
  /** Vanilla's `silentCrushAndRaise` (special 141) — see `CrusherEffect.silent`. */
  silent: boolean;
  /** Boom's fully silent generalized crusher — see `CrusherEffect.noEndClack`. */
  noEndClack?: boolean;
  /** See `CrusherEffect.slowsWhenCrushing`. Absent on a mover from a save written before it existed, where the slowing majority (25/49/73/141) is the safer default. */
  slowsWhenCrushing?: boolean;
  /**
   * Currently grinding through a body at an eighth speed — `T_MoveCeiling`'s
   * mutated `ceiling->speed`, cleared again when the descent reaches the
   * bottom. Live state, so it rides along in a savegame like `state` does.
   */
  slowed?: boolean;
}

/**
 * Exported for the savegame snapshot alone (`game/snapshot.ts`): every member
 * is plain JSON-safe data (verified down to the `effect` tables' scalar
 * fields), so a saved mover is a structural copy of the live one —
 * docs/savegames.md § What is saved and what is deliberately not.
 */
export type Mover = DoorMover | LiftMover | FloorMover | CrusherMover | CeilingMover | ElevatorMover;

/**
 * Which of Boom's two per-sector "busy" slots a mover kind occupies —
 * `sec->floordata` vs `sec->ceilingdata`, the split `P_SectorActive` reads.
 * The elevator claims *both* in vanilla; it lives in the floor map here and
 * `ceilingActive` looks for it there, since one object in two maps would
 * `structuredClone` into two on save and then tick twice.
 * docs/specials.md § One mover per sector.
 */
function moverClass(kind: Mover['kind']): 'floor' | 'ceiling' {
  switch (kind) {
    case 'floor':
    case 'lift':
    case 'elevator':
      return 'floor';
    case 'door':
    case 'ceiling':
    case 'crusher':
      return 'ceiling';
  }
}

export interface LightState {
  pattern: LightPattern;
  baseLight: number;
  darkLight: number;
  timer: number;
  bright: boolean;
  phase: number;
  /**
   * The current light value for `flicker` alone, which is the one pattern that
   * isn't a two-level toggle `bright` can express — see `tickLight`.
   */
  level: number;
}

/** Blink/flicker periods in seconds, matching vanilla's STROBEBRIGHT/FASTDARK/SLOWDARK tic counts. */
const BLINK_BRIGHT_TIME = 5 * DOOM_TIC;
const BLINK_05_DARK = 15 * DOOM_TIC;
const BLINK_1_DARK = 35 * DOOM_TIC;
const GLOW_HALF_CYCLE = 1.3;
/**
 * `T_LightFlash`'s `mintime`/`maxtime`, used as **bit masks** and not as
 * durations: `&7` is 0-7 tics dark, but `&64` is 0 *or* 64 and nothing between,
 * so a broken light's lit period is either 1 tic or 65. That split is the whole
 * character of the pattern. docs/specials.md § Lights.
 */
const FLASH_DARK_MASK = 7;
const FLASH_BRIGHT_MASK = 64;
/** `T_FireFlicker`: a new level every 4 tics, in steps of 16 below the sector's own light. */
const FLICKER_INTERVAL = 4 * DOOM_TIC;
const FLICKER_STEP = 16;

function makeLightState(pattern: LightPattern, baseLight: number, darkLight: number): LightState {
  // `P_SpawnLightFlash` seeds its counter with the same `(P_Random()&64)+1` the
  // tick uses, so a map's broken lights start out of phase with each other.
  const timer = pattern === 'blinkRandom' ? ((pRandom() & FLASH_BRIGHT_MASK) + 1) * DOOM_TIC : pattern === 'flicker' ? FLICKER_INTERVAL : 0;
  return { pattern, baseLight, darkLight, timer, bright: true, phase: 1, level: baseLight };
}

function tickLight(s: LightState, dt: number): number {
  switch (s.pattern) {
    case 'blinkRandom': {
      // `T_LightFlash` — see FLASH_DARK_MASK for why the two branches are so lopsided.
      s.timer -= dt;
      if (s.timer <= 0) {
        s.bright = !s.bright;
        const mask = s.bright ? FLASH_BRIGHT_MASK : FLASH_DARK_MASK;
        s.timer = ((pRandom() & mask) + 1) * DOOM_TIC;
      }
      return s.bright ? s.baseLight : s.darkLight;
    }
    case 'flicker': {
      // `T_FireFlicker`, which is four brightness steps rather than a toggle.
      // The floor is the darkest neighbour + 16, and the `< min` test reads the
      // *current* level while the assignment uses the sector's own — vanilla's
      // own asymmetry, and what makes the pattern sit at its floor as often as
      // it does. docs/specials.md § Lights.
      s.timer -= dt;
      if (s.timer <= 0) {
        s.timer = FLICKER_INTERVAL;
        const amount = (pRandom() & 3) * FLICKER_STEP;
        const min = s.darkLight + FLICKER_STEP;
        s.level = s.level - amount < min ? min : s.baseLight - amount;
      }
      return s.level;
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

/**
 * The new special's sector `special` after a Boom change: untouched for a
 * texture-only change (`FChgTxt`), cleared for `FChgZero`, the model's own for
 * `FChgTyp` — `p_genlin.c`'s three `*ChgT` cases.
 */
function changedSpecial(change: SurfaceChange, model: Sector): number | undefined {
  if (change.type === 'texOnly') return undefined;
  return change.type === 'texZeroType' ? 0 : model.special;
}

/**
 * `shortestTexture` resolves the two `FbyST` targets alone, and is a thunk
 * because the scan behind it needs the material bank (controller state) while
 * every other target is a pure function of the map — and because the scan
 * walks every linedef, so it must not run for the targets that don't want it.
 */
function resolveFloorTarget(
  map: DoomMap,
  sectorIndex: number,
  target: MoveTarget,
  shortestTexture: () => number,
): number {
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
    case 'minus24':
      return map.sectors[sectorIndex].floorHeight - 24;
    case 'minus32':
      return map.sectors[sectorIndex].floorHeight - 32;
    case 'ownCeiling':
      // Boom's FtoC: flush with the sector's own ceiling, no vanilla 8-unit gap.
      return map.sectors[sectorIndex].ceilHeight;
    case 'shortestLowerTexture':
      return map.sectors[sectorIndex].floorHeight + shortestTexture();
    case 'shortestLowerTextureDown':
      return map.sectors[sectorIndex].floorHeight - shortestTexture();
  }
}

/** Same `shortestTexture` convention as `resolveFloorTarget`, for the `CbyST` pair. */
function resolveCeilingTarget(
  map: DoomMap,
  sectorIndex: number,
  target: CeilingTarget,
  shortestTexture: () => number,
): number {
  switch (target) {
    case 'highestNeighborCeiling':
      return highestNeighborCeiling(map, sectorIndex);
    case 'floorPlus8':
      return map.sectors[sectorIndex].floorHeight + EIGHT_UNIT_GAP;
    case 'lowestNeighborCeiling':
      return lowestNeighborCeiling(map, sectorIndex);
    case 'nextHigherCeiling':
      return nextHigherCeiling(map, sectorIndex);
    case 'nextLowerCeiling':
      return nextLowerCeiling(map, sectorIndex);
    case 'highestNeighborFloor':
      return highestNeighborFloor(map, sectorIndex);
    case 'ownFloor':
      // Boom's CtoF: flush with the floor, unlike vanilla's floorPlus8.
      return map.sectors[sectorIndex].floorHeight;
    case 'plus24':
      return map.sectors[sectorIndex].ceilHeight + 24;
    case 'plus32':
      return map.sectors[sectorIndex].ceilHeight + 32;
    case 'minus24':
      return map.sectors[sectorIndex].ceilHeight - 24;
    case 'minus32':
      return map.sectors[sectorIndex].ceilHeight - 32;
    case 'shortestUpperTexture':
      return map.sectors[sectorIndex].ceilHeight + shortestTexture();
    case 'shortestUpperTextureDown':
      return map.sectors[sectorIndex].ceilHeight - shortestTexture();
  }
}

/**
 * A teleport landing spot: where to put the thing and which way it faces on
 * arrival (`angle`, radians — see `Placement`), plus what the Boom silent
 * family needs on top. The three optional fields are absent for a vanilla
 * teleport, which is exactly its old behavior.
 * See docs/specials.md § Silent and line-to-line teleporters.
 */
export interface TeleportDest extends Placement {
  /**
   * No fog puffs and no `telept` — the whole point of Boom's silent numbers.
   * It also means "preserve the body's height above the floor" (`p_telept.c`'s
   * `z = thing->z - thing->floorz`, which loud `EV_Teleport` discards); the
   * height itself is the caller's to measure, since this controller is never
   * told it.
   */
  silent?: boolean;
  /**
   * How far the arrival turned the body, in radians. `angle` above already has
   * it applied; this is here so the caller can turn the body's *momentum*
   * through the same angle, which is what makes a silent teleport read as
   * walking through a doorway. Absent means vanilla's landing, which sets an
   * absolute facing and zeroes momentum outright.
   */
  rotateBy?: number;
}

/**
 * Where the body was when it crossed the line, which only Boom's silent
 * teleports need: they rotate the body relative to its current facing, where a
 * vanilla teleport overwrites it. The position is the crossing point a
 * line-to-line exit interpolates from.
 */
interface TeleportSource extends Pos2 {
  /** Current facing, radians. */
  angle: number;
}

/**
 * A locked line the player just used without what it wants — what `game.ts` needs to say so
 * (see `consumeLockedLine`). `kind` is vanilla's own split between "open this door" (`PD_*K`, the
 * manual door specials 26-28/32-34, where the line *is* the door) and "activate this object"
 * (`PD_*O`, the remote switches 99/133-137) — the two messages `EV_VerticalDoor` and
 * `EV_DoLockedDoor` print. Boom's generalized locks carry their own wording per `LockRule`
 * (`P_CanUnlockGenDoor`'s `PD_*` picks). docs/items.md § Locked doors and use triggers.
 */
export interface LockedLine {
  lock: LockRule;
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

/**
 * The `use` specials whose switch flip is *not* gated on the effect having done
 * anything: `P_UseSpecialLine` calls `P_ChangeSwitchTexture` outside the
 * `if (EV_…)` for exactly the two exits and the two light switches, and for
 * nothing else. Every other switch — and only a switch; walk and shoot triggers
 * are unconditional throughout — flips, and spends a one-shot line, solely when
 * its EV_ call returned true. docs/specials.md § A switch only flips when it acts.
 */
const SWITCH_ALWAYS_FLIPS = new Set([
  11, // exit level
  51, // secret exit
  138, // light turn on
  139, // light turn off
]);

export class SpecialsController {
  private map: DoomMap;
  private world: World;
  private bank: MaterialBank;
  /** Everything this controller's height and light changes mean for what is actually drawn — see specials/movergeometry.ts. */
  private geometry: MoverGeometry;
  private onExit: (secret: boolean) => void;
  private onTeleport: (dest: TeleportDest) => void;
  private onCrush: (sectorIndex: number, dealDamage: boolean) => boolean;
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

  /**
   * The two independent mover slots per sector, Boom's `sec->floordata` /
   * `sec->ceilingdata` — see `moverClass` for which kind lands where, and
   * docs/specials.md § One mover per sector for why they are separate.
   */
  private floorMovers = new Map<number, Mover>();
  private ceilingMovers = new Map<number, Mover>();
  private usedOnce = new Set<number>();
  /**
   * Lines currently flipped from their authored special by `SpecialDef.retriggerXor`
   * (Boom's generalized stairs alternating direction). The map's own linedefs are
   * never mutated — `lineSpecial` applies the XOR on read — so the authored number
   * stays the truth for anything classifying lines, and a restore is a plain
   * assignment. docs/specials.md § Generalized linedefs.
   */
  private retriggerFlips = new Set<number>();

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
    onTeleport: (dest: TeleportDest) => void,
    onCrush: (sectorIndex: number, dealDamage: boolean) => boolean,
    blocksCeilingLower: (sectorIndex: number, ceilingHeight: number) => boolean,
    blocksFloorRise: (sectorIndex: number, floorHeight: number) => boolean,
    playerX: number,
    playerY: number,
    /**
     * Which sectors get mover-owned geometry — **the same set the caller gave
     * `buildMapMesh`**, so the mesh and this controller can't disagree about
     * who owns a sector. Required, rather than defaulting to its own
     * `computeMovableSectors`, for exactly that reason. A savegame restore
     * unions the scan with every saved mover's sector: a mid-motion mover whose
     * authored sector special was consumed (`FloorMover.arrivalTexture`) would
     * otherwise land back in the static batch. docs/savegames.md § Apply order.
     */
    movableSectors: Set<number>,
    sfx: SoundEmitter = SILENT,
    /**
     * How a switch texture resolves to its opposite state — **the same lookup
     * the caller gave `computeMovableSectors`**, for the same "must not
     * disagree" reason `movableSectors` is passed in. Defaults to the
     * `SW1`/`SW2` name convention; a WAD set with a `SWITCHES` lump supplies
     * its own (docs/wad.md § ANIMATED and SWITCHES).
     */
    switchPairs: SwitchPairLookup = switchPairTexture,
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
      if (!lookupSpecial(line.special)) continue;
      const entries = findSwitchEntries(map, line, switchPairs);
      if (entries.length > 0) this.switchTextures.set(i, entries);
    }

    this.geometry = new MoverGeometry(map, world, bank, scene, fog, polys, built, meshOptions, movableSectors);

    for (let i = 0; i < map.sectors.length; i++) {
      const timer = decodeSectorType(map.sectors[i].special).doorTimer;
      if (timer) this.spawnSectorDoorTimer(i, timer);
    }

    const lightSectors = computeLightSectors(map);
    for (const sectorIndex of lightSectors) {
      const sector = map.sectors[sectorIndex];
      const pattern = decodeSectorType(sector.special).lightPattern!;
      this.lightStates.set(sectorIndex, makeLightState(pattern, sector.light, darkestNeighborLight(map, sectorIndex)));
    }
  }

  dispose(): void {
    this.geometry.dispose();
  }

  /**
   * The controller's mutable state for a savegame, deep-copied since the live
   * movers keep mutating. The one-frame flags (`lastTeleport`, `lockedLine`)
   * and the due-this-frame booleans are deliberately dropped —
   * docs/savegames.md § What is saved and what is deliberately not.
   */
  snapshot(): SpecialsSnapshot {
    return structuredClone({
      movers: [...this.floorMovers.entries()],
      ceilingMovers: [...this.ceilingMovers.entries()],
      usedOnce: [...this.usedOnce],
      switchFlashes: [...this.switchFlashes.entries()],
      lightStates: [...this.lightStates.entries()],
      moveSoundTimer: this.moveSoundTimer,
      crushDamageTimer: this.crushDamageTimer,
      prevX: this.prevX,
      prevY: this.prevY,
      stairFlips: [...this.retriggerFlips],
    });
  }

  /**
   * Overwrites the constructor's own seeding (sector door timers, light
   * states) with the saved state. Sector heights/lights were already applied
   * to the map before any geometry was built, so the only visual fix-up needed
   * here is the switch on-textures: `findSwitchEntries` reads the *authored*
   * sidedef as the off state, so a flashed switch has to be flipped after that
   * scan, not baked into the map up front. docs/savegames.md § Apply order.
   */
  restore(s: SpecialsSnapshot): void {
    // Sorted by kind rather than trusted by field: a save written before the
    // floor/ceiling split put *every* mover in `movers`, so re-deriving the
    // class here restores an old save into the right slots with no migration
    // step and no `SAVE_VERSION` bump. Post-split saves already carry the two
    // apart, and the same sort is then a no-op.
    this.floorMovers = new Map();
    this.ceilingMovers = new Map();
    for (const [sectorIndex, mover] of structuredClone([...s.movers, ...(s.ceilingMovers ?? [])])) {
      this.setMover(sectorIndex, mover);
    }
    this.usedOnce = new Set(s.usedOnce);
    this.retriggerFlips = new Set(s.stairFlips ?? []);
    this.switchFlashes = new Map(s.switchFlashes);
    this.lightStates = new Map(structuredClone(s.lightStates));
    this.moveSoundTimer = s.moveSoundTimer;
    this.crushDamageTimer = s.crushDamageTimer;
    this.prevX = s.prevX;
    this.prevY = s.prevY;
    const dirty = new Set<number>();
    // Two sources, since a switch shows its on-texture for two different
    // reasons: a repeatable one mid-BUTTONTIME (`switchFlashes`), and a
    // one-shot one that is flipped for good and has no timer at all
    // (`usedOnce` — see `flashSwitch`). A `usedOnce` line with no switch art,
    // which is most of them, resolves to no entries and costs nothing.
    for (const lineIndex of [...this.switchFlashes.keys(), ...this.usedOnce]) {
      for (const e of this.switchTextures.get(lineIndex) ?? []) {
        this.map.sidedefs[e.sideIndex][e.slot] = e.onTexture;
        dirty.add(e.sectorIndex);
      }
    }
    for (const sectorIndex of dirty) this.geometry.rebuild(sectorIndex);
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
      this.setMover(sectorIndex, {
        kind: 'door',
        sectorIndex,
        effect,
        openHeight: sector.ceilHeight,
        closeHeight: sector.floorHeight,
        state: 'hold',
        holdRemaining: DOOR_CLOSE_WAIT_SECONDS,
      });
    } else {
      this.setMover(sectorIndex, {
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
    ownedKeys: ReadonlySet<KeySlot>,
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
    this.handleWalkTriggers(playerX, playerY, playerAngle, ownedKeys);
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

  /**
   * An exhaustive `switch` rather than an if/else chain with a fallthrough:
   * a new `Mover` kind must be a compile error here, the way it already is in
   * `moverActive`, not something that silently ticks as a crusher.
   */
  private tickMovers(dt: number, dirty: Set<number>): void {
    for (const mover of this.floorMovers.values()) this.tickMover(mover, dt, dirty);
    for (const mover of this.ceilingMovers.values()) this.tickMover(mover, dt, dirty);
  }

  private tickMover(mover: Mover, dt: number, dirty: Set<number>): void {
    switch (mover.kind) {
      case 'door':
        this.tickDoor(mover, dt, dirty);
        break;
      case 'lift':
        this.tickLift(mover, dt, dirty);
        break;
      case 'floor':
        this.tickFloor(mover, dt, dirty);
        break;
      case 'ceiling':
        this.tickCeiling(mover, dt, dirty);
        break;
      case 'elevator':
        this.tickElevator(mover, dt, dirty);
        break;
      case 'crusher':
        this.tickCrusher(mover, dt, dirty);
        break;
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
            mover.holdRemaining = mover.effect.closeWaitSeconds ?? DOOR_CLOSE_WAIT_SECONDS;
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
    if (mover.state === 'stasis') return;
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.floorHeight;
    if (mover.state === 'lowering') {
      sector.floorHeight = mover.instant
        ? mover.downHeight
        : Math.max(mover.downHeight, sector.floorHeight - mover.effect.speed * dt);
      // A toggle plat crushes rather than reverses, and its move is over in
      // this tic — so the damage has to land here, not on a later stroke.
      if (mover.crush) this.tickCrush(mover.sectorIndex);
      if (sector.floorHeight <= mover.downHeight) {
        sector.floorHeight = mover.downHeight;
        // `toggleUpDn` parks in stasis at each end rather than waiting: the
        // next activation reverses it (`P_ActivateInStasis`), and it is silent.
        if (mover.instant) {
          mover.stasisFrom = 'lowering';
          mover.state = 'stasis';
          if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
          return;
        }
        mover.state = 'hold';
        mover.holdRemaining = mover.effect.waitSeconds;
        // T_PlatRaise: `pstop` at either end of the travel, `pstart` whenever it
        // sets off again — a lift is silent while it moves, unlike a floor.
        this.playSector(mover.sectorIndex, 'pstop');
      }
    } else if (mover.state === 'hold') {
      mover.holdRemaining -= dt;
      if (mover.holdRemaining <= 0) {
        // T_PlatRaise's wait expiry re-derives the direction from which end
        // the lift sits at — which is what makes a perpetual lift's top hold
        // send it back down, and is a plain "raise" for everything else.
        mover.state = sector.floorHeight === mover.downHeight ? 'raising' : 'lowering';
        this.playSector(mover.sectorIndex, 'pstart');
      }
    } else if (mover.state === 'raising') {
      const next = mover.instant
        ? mover.restHeight
        : Math.min(mover.restHeight, sector.floorHeight + mover.effect.speed * dt);
      if (mover.crush) {
        this.tickCrush(mover.sectorIndex);
      } else if (this.blocksFloorRise(mover.sectorIndex, next)) {
        // T_PlatRaise's own `res == crushed && !plat->crush` branch: unlike a
        // plain rising FloorMover/CeilingMover, which just stalls in place
        // (T_MoveFloor/T_MoveCeiling have no such branch), a lift immediately
        // reverses back down instead of waiting for the obstruction to clear —
        // confirmed against p_plats.c. Only a toggle plat sets `crush`, and it
        // grinds through instead, which is why this is the `else`.
        mover.state = 'lowering';
        this.playSector(mover.sectorIndex, 'pstart');
        return;
      }
      sector.floorHeight = next;
      if (sector.floorHeight >= mover.restHeight) {
        sector.floorHeight = mover.restHeight;
        if (mover.instant) {
          mover.stasisFrom = 'raising';
          mover.state = 'stasis';
          if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
          return;
        }
        // A perpetual lift waits at the top and goes again; everything else is
        // done (vanilla removes the plat here).
        if (mover.perpetual) {
          mover.state = 'hold';
          mover.holdRemaining = mover.effect.waitSeconds;
        } else {
          mover.state = 'rest';
        }
        this.playSector(mover.sectorIndex, 'pstop');
      }
    }
    if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
  }

  private tickFloor(mover: FloorMover, dt: number, dirty: Set<number>): void {
    if (mover.state === 'done') return;
    const sector = this.map.sectors[mover.sectorIndex];
    const before = sector.floorHeight;
    const dir = mover.direction ? (mover.direction === 'up' ? 1 : -1) : mover.target > sector.floorHeight ? 1 : -1;
    if (dir > 0 ? mover.target < sector.floorHeight : mover.target > sector.floorHeight) {
      // `T_MovePlane`'s clamp branch: a target on the far side of the fixed
      // direction is reached in the step it starts and put straight back if a
      // body no longer fits — the `pastdest` revert has no `crush` exception,
      // unlike the per-step one below. docs/specials.md § Inverted floor moves.
      if (!this.blocksFloorRise(mover.sectorIndex, mover.target)) sector.floorHeight = mover.target;
      this.finishFloor(mover);
      if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
      return;
    }
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
    if (dir > 0 ? sector.floorHeight >= mover.target : sector.floorHeight <= mover.target) {
      sector.floorHeight = mover.target;
      this.finishFloor(mover);
    }
    if (sector.floorHeight !== before) dirty.add(mover.sectorIndex);
    if (mover.crush) this.tickCrush(mover.sectorIndex);
  }

  /** `T_MoveFloor`'s `pastdest` branch: park the mover, clack, apply any arrival change. */
  private finishFloor(mover: FloorMover): void {
    mover.state = 'done';
    this.playSector(mover.sectorIndex, 'pstop');
    if (mover.arrivalTexture) this.applyArrivalChange(mover.sectorIndex, mover.arrivalTexture);
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
    // A crushing generalized ceiling grinds through at full speed —
    // `T_MoveCeiling`'s `crushed` branch pointedly leaves `genCeiling` out of
    // the crusher types' slow-down, and `T_MovePlane` with crush=true never
    // refuses the move. Damage is rationed below like every crusher.
    if (dir < 0 && !mover.crush && this.blocksCeilingLower(mover.sectorIndex, next)) return;
    sector.ceilHeight = next;
    // T_MoveCeiling grinds on the same shared clock, in both directions. It has
    // no arrival sound: only vanilla's *silent* crusher gets a `pstop` at an end
    // (see tickCrusher), which is exactly the type that stays quiet in between.
    if (this.moveSoundDue) this.playSector(mover.sectorIndex, 'stnmov');
    if ((dir > 0 && sector.ceilHeight >= mover.target) || (dir < 0 && sector.ceilHeight <= mover.target)) {
      sector.ceilHeight = mover.target;
      mover.state = 'done';
      if (mover.arrivalTexture) this.applyArrivalChange(mover.sectorIndex, mover.arrivalTexture);
    }
    if (sector.ceilHeight !== before) dirty.add(mover.sectorIndex);
    if (mover.crush && dir < 0) this.tickCrush(mover.sectorIndex);
  }

  /**
   * `T_MoveElevator`: both planes step together, the leading plane checked
   * against the blocking predicate first — ceiling leads going down, floor
   * leads going up — and a blocked leader stalls the pair (an elevator never
   * crushes). Grinds `stnmov` on the shared clock, `pstop` on arrival.
   */
  private tickElevator(mover: ElevatorMover, dt: number, dirty: Set<number>): void {
    if (mover.state === 'done') return;
    const sector = this.map.sectors[mover.sectorIndex];
    const step = mover.speed * dt;
    const dir = mover.floorTarget > sector.floorHeight ? 1 : -1;
    if (dir < 0) {
      const nextCeil = Math.max(mover.ceilTarget, sector.ceilHeight - step);
      if (this.blocksCeilingLower(mover.sectorIndex, nextCeil)) return;
      sector.ceilHeight = nextCeil;
      sector.floorHeight = Math.max(mover.floorTarget, sector.floorHeight - step);
    } else {
      const nextFloor = Math.min(mover.floorTarget, sector.floorHeight + step);
      if (this.blocksFloorRise(mover.sectorIndex, nextFloor)) return;
      sector.floorHeight = nextFloor;
      sector.ceilHeight = Math.min(mover.ceilTarget, sector.ceilHeight + step);
    }
    if (this.moveSoundDue) this.playSector(mover.sectorIndex, 'stnmov');
    if (sector.floorHeight === mover.floorTarget && sector.ceilHeight === mover.ceilTarget) {
      mover.state = 'done';
      this.playSector(mover.sectorIndex, 'pstop');
    }
    dirty.add(mover.sectorIndex);
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
    // `T_MoveCeiling` drops a crushing descent to `CEILSPEED / 8` for as long as
    // it is actually grinding through a body — see `CrusherEffect.slowsWhenCrushing`.
    const speed = mover.slowed ? mover.speed / CRUSH_SLOWDOWN : mover.speed;
    if (mover.state === 'lowering') {
      sector.ceilHeight = Math.max(mover.bottomHeight, sector.ceilHeight - speed * dt);
      if (sector.ceilHeight <= mover.bottomHeight) {
        sector.ceilHeight = mover.bottomHeight;
        mover.state = 'raising';
        // Vanilla's `ceiling->speed = CEILSPEED` on reaching the bottom: the
        // slowdown lasts only the stroke that earned it, so the way back up —
        // which never crushes anyway — is always full speed.
        mover.slowed = false;
        // The silent crusher's one sound, at each end of its travel — the exact
        // inverse of every other crusher, which grinds throughout and is quiet
        // at the turns (see CrusherEffect.silent).
        if (mover.silent && !mover.noEndClack) this.playSector(mover.sectorIndex, 'pstop');
      }
    } else {
      sector.ceilHeight = Math.min(mover.topHeight, sector.ceilHeight + speed * dt);
      if (sector.ceilHeight >= mover.topHeight) {
        sector.ceilHeight = mover.topHeight;
        mover.state = 'lowering';
        if (mover.silent && !mover.noEndClack) this.playSector(mover.sectorIndex, 'pstop');
      }
    }
    if (!mover.silent && this.moveSoundDue) this.playSector(mover.sectorIndex, 'stnmov');
    if (sector.ceilHeight !== before) dirty.add(mover.sectorIndex);
    // `T_MovePlane`'s `crushed` result is per-tic and independent of the damage
    // clock, so this asks every tic and only the damage inside is rationed.
    if (wasLowering) {
      const caught = this.tickCrush(mover.sectorIndex);
      // `crushed` is the *else* of `pastdest` in `T_MoveCeiling` — the two
      // results are mutually exclusive — so the tic that lands on the bottom
      // restores full speed and must not re-slow on the way out of the stroke.
      // (The damage above still lands: `P_ChangeSector` runs either way.)
      const reachedBottom = mover.state === 'raising';
      if (caught && !reachedBottom && mover.slowsWhenCrushing !== false) mover.slowed = true;
    }
  }

  /**
   * Asks `onCrush` whether anything in `sectorIndex` is caught under the
   * mover, dealing `CRUSH_DAMAGE` at the same time only on the shared
   * `crushDamageDue` clock. Two rates in one call because vanilla has two:
   * `P_ChangeSector`'s `nofit` is recomputed every tic (it is what
   * `T_MovePlane` returns as `crushed`, and so what drives the crusher
   * slowdown), while `PIT_ChangeSector` rations the damage inside it on
   * `leveltime&3`.
   *
   * That damage clock is one clock for the whole level, not a per-mover
   * countdown (`moveSoundDue`'s reasoning, applied to damage) — a per-mover
   * countdown drifts off vanilla's global `leveltime&3` and racks up extra hits.
   */
  private tickCrush(sectorIndex: number): boolean {
    return this.onCrush(sectorIndex, this.crushDamageDue);
  }

  /** The slot a class's movers live in — see `moverClass`. */
  private moverMap(cls: 'floor' | 'ceiling'): Map<number, Mover> {
    return cls === 'floor' ? this.floorMovers : this.ceilingMovers;
  }

  /** Registers a mover in whichever slot its kind claims, so no caller has to know the mapping. */
  private setMover(sectorIndex: number, mover: Mover): void {
    this.moverMap(moverClass(mover.kind)).set(sectorIndex, mover);
  }

  /**
   * `P_SectorActive(floor_special, sec)`: this sector already has a *floor*
   * thinker running, so `EV_DoFloor`, `EV_DoPlat`, `EV_DoDonut` and
   * `EV_BuildStairs` must `continue` past it. A closing door overhead does
   * not block them — that is `ceilingActive`'s slot, and keeping the two
   * apart is the whole point of Boom's split.
   *
   * A mover that has finished is **not** active — vanilla removes its thinker and clears
   * `specialdata` the moment it stops, freeing the sector to be triggered again. This engine keeps
   * the finished record instead (a lift re-triggers off its own `restHeight`), so the
   * state has to be read rather than mere presence.
   *
   * The two re-triggers vanilla does honor are handled by their own callers *before* asking this: a
   * door reverses (`EV_VerticalDoor`) and a stopped crusher restarts (`P_ActivateInStasis`).
   *
   * See docs/specials.md § One mover per sector — DOOM2 MAP30's central pillar is the repro.
   */
  private floorActive(sectorIndex: number): boolean {
    return this.moverActive(this.floorMovers.get(sectorIndex));
  }

  /**
   * `P_SectorActive(ceiling_special, sec)` — the door/ceiling/crusher slot.
   * A running elevator counts, since vanilla's `EV_DoElevator` claims
   * `ceilingdata` as well as `floordata` (`p_floor.c`).
   */
  private ceilingActive(sectorIndex: number): boolean {
    const floor = this.floorMovers.get(sectorIndex);
    if (floor?.kind === 'elevator' && this.moverActive(floor)) return true;
    return this.moverActive(this.ceilingMovers.get(sectorIndex));
  }

  private moverActive(mover: Mover | undefined): boolean {
    if (!mover) return false;
    switch (mover.kind) {
      case 'floor':
      case 'ceiling':
      case 'elevator':
        return mover.state === 'moving';
      case 'lift':
        // In-stasis counts as active: vanilla's stop line never cleared the
        // sector's specialdata, only froze the thinker.
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

  private triggerDoor(sectorIndex: number, effect: DoorEffect): boolean {
    const existing = this.ceilingMovers.get(sectorIndex);
    const sounds = this.doorSounds(effect);
    if (!existing || existing.kind !== 'door') {
      if (this.ceilingActive(sectorIndex)) return false;
      const sector = this.map.sectors[sectorIndex];
      const closeThenOpen = effect.mode === 'closeThenOpen';
      // A closeThenOpen door is authored already open, and reopens to
      // wherever it already sits — vanilla's own `door->topheight =
      // sec->ceilingheight;` (p_doors.c), unlike every other DoorMode here,
      // which always computes a fresh neighbor-ceiling target.
      const openHeight = closeThenOpen ? sector.ceilHeight : lowestNeighborCeiling(this.map, sectorIndex) - DOOR_OPEN_GAP;
      const closeHeight = sector.floorHeight;
      this.setMover(sectorIndex, {
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
      return true;
    }
    // A door this engine still has a record of is one vanilla either left a
    // thinker on (mid-motion: `EV_DoDoor` `continue`s, rtn 0) or had already
    // finished and removed (`'open'`/`'closed'`: a fresh thinker, rtn 1) —
    // exactly `ceilingActive`. The re-trigger behavior below is unchanged.
    const mover = existing;
    const fresh = !this.ceilingActive(sectorIndex);
    if (effect.mode === 'closeOnly' || effect.mode === 'closeThenOpen') {
      mover.state = 'lowering';
      this.playSector(sectorIndex, sounds.close);
      return fresh;
    }
    if (effect.mode === 'openOnly') {
      if (mover.state === 'closed' || mover.state === 'lowering') {
        mover.state = 'raising';
        this.playSector(sectorIndex, sounds.open);
      }
      return fresh;
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
    return fresh;
  }

  private triggerLift(sectorIndex: number, effect: LiftEffect): boolean {
    const target = effect.target ?? 'lowestNeighborFloor';
    const existing = this.floorMovers.get(sectorIndex);
    if (!existing || existing.kind !== 'lift') {
      if (this.floorActive(sectorIndex)) return false;
      const sector = this.map.sectors[sectorIndex];
      const floor = sector.floorHeight;
      if (target === 'perpetual') {
        // EV_DoPlat's perpetualRaise: bounce between the lowest and highest
        // neighbor floor (each clamped to include the sector's own), starting
        // in a random direction — `plat->status = P_Random(pr_plats)&1`, where
        // 0 is up in vanilla's plat_e.
        this.setMover(sectorIndex, {
          kind: 'lift',
          sectorIndex,
          effect,
          restHeight: Math.max(highestNeighborFloor(this.map, sectorIndex), floor),
          downHeight: Math.min(lowestNeighborFloor(this.map, sectorIndex), floor),
          state: (pRandom() & 1) === 0 ? 'raising' : 'lowering',
          holdRemaining: 0,
          perpetual: true,
        });
        this.playSector(sectorIndex, 'pstart');
        return true;
      }
      if (target === 'toggle') {
        // `EV_DoPlat`'s toggleUpDn: `low = ceilingheight`, `high =
        // floorheight`, moving *down*. Both bounds are on the wrong side of
        // that direction, which is exactly what makes vanilla's `T_MovePlane`
        // clamp on its first step — see `LiftMover.instant`. No sound at all;
        // `EV_DoPlat` starts none for this type.
        this.setMover(sectorIndex, {
          kind: 'lift',
          sectorIndex,
          effect,
          restHeight: floor,
          downHeight: sector.ceilHeight,
          state: 'lowering',
          holdRemaining: 0,
          instant: true,
          crush: true,
        });
        return true;
      }
      const low =
        target === 'nextLowerFloor'
          ? nextLowerFloor(this.map, sectorIndex)
          : target === 'lowestNeighborCeiling'
            ? lowestNeighborCeiling(this.map, sectorIndex)
            : lowestNeighborFloor(this.map, sectorIndex);
      this.setMover(sectorIndex, {
        kind: 'lift',
        sectorIndex,
        effect,
        restHeight: floor,
        // Every EV_DoPlat/EV_DoGenLift down-target carries the same clamp:
        // `if (plat->low > sec->floorheight) plat->low = sec->floorheight` —
        // a "down" stroke never starts by jumping up.
        downHeight: Math.min(low, floor),
        state: 'lowering',
        holdRemaining: 0,
      });
      this.playSector(sectorIndex, 'pstart'); // EV_DoPlat's own downWaitUpStay sound
      return true;
    }
    // P_ActivateInStasis: only the perpetual and toggle triggers wake a
    // stopped lift — `EV_DoPlat` calls it for those two types alone.
    if (existing.state === 'stasis') {
      if (target === 'toggle') {
        // The toggle *reverses* out of stasis rather than resuming:
        // `plat->status = plat->oldstatus==up ? down : up`. And unlike every
        // other wake, this one reports a hit — `EV_DoPlat` sets `rtn = 1`
        // unconditionally for toggleUpDn — so an SR 211 always flips its
        // switch. docs/specials.md § Toggle plats.
        existing.state = existing.stasisFrom === 'raising' ? 'lowering' : 'raising';
        existing.stasisFrom = undefined;
        return true;
      }
      // For the perpetual family vanilla's rtn stays 0: stasis never cleared
      // the sector's specialdata, so the spawn loop skips the sector (same
      // shape as the crusher's in-stasis restart).
      // docs/specials.md § Perpetual lifts and the stop line.
      if (target === 'perpetual') {
        existing.state = existing.stasisFrom ?? 'lowering';
        existing.stasisFrom = undefined;
      }
      return false;
    }
    // A resting lift is one vanilla had already removed (`P_RemoveActivePlat`),
    // so re-triggering it is a fresh thinker; one still running is `EV_DoPlat`'s
    // own `continue`.
    if (existing.state !== 'rest') return false;
    existing.state = 'lowering';
    this.playSector(sectorIndex, 'pstart');
    return true;
  }

  /**
   * Vanilla `EV_StopPlat` (54/89): freezes a tagged running lift where it
   * stands, remembering its direction for `P_ActivateInStasis`. Vanilla's own
   * return is an unconditional 1, but per-sector "did it stop one" serves the
   * same walk-only callers.
   */
  private triggerLiftStop(sectorIndex: number): boolean {
    const existing = this.floorMovers.get(sectorIndex);
    if (!existing || existing.kind !== 'lift' || existing.state === 'stasis' || existing.state === 'rest') return false;
    existing.stasisFrom = existing.state;
    existing.state = 'stasis';
    return true;
  }

  private triggerFloor(sectorIndex: number, effect: FloorEffect, line?: LineDef): boolean {
    if (this.floorActive(sectorIndex)) return false;
    // `line` is only actually needed for `changeTexture` — the only caller without a real
    // linedef (`triggerTag`, for a boss-death `lowerFloorToLowest`) never sets that flag.
    if (effect.changeTexture && line) this.applyFloorChange(sectorIndex, line);
    const target = resolveFloorTarget(this.map, sectorIndex, effect.target, () =>
      this.shortestTextureAround(sectorIndex, 'lower'),
    );
    this.setMover(sectorIndex, {
      kind: 'floor',
      sectorIndex,
      speed: effect.speed,
      target,
      state: 'moving',
      crush: effect.crush,
      direction: effect.direction,
      arrivalTexture: effect.change ? this.resolveFloorChange(sectorIndex, effect, target, line) : undefined,
    });
    return true;
  }

  /**
   * Writes a resolved change onto its sector and repaints it: the surface
   * flat, the special when the change carries one (`texOnly` leaves it), and
   * the mesh rebuild without which the swap wouldn't be drawn. The one place
   * a `SurfaceChange` lands, whether it came from a mover arriving or from
   * `EV_DoChange`'s instant copy.
   */
  private applyArrivalChange(
    sectorIndex: number,
    change: { floorTex?: string; ceilTex?: string; special?: number },
  ): void {
    const sector = this.map.sectors[sectorIndex];
    if (change.floorTex !== undefined) sector.floorTex = change.floorTex;
    if (change.ceilTex !== undefined) sector.ceilTex = change.ceilTex;
    if (change.special !== undefined) sector.special = change.special;
    this.geometry.rebuild(sectorIndex);
  }

  /**
   * A linedef's front sector — vanilla's `line->frontsector`, the model every
   * "trigger model" change and `elevateCurrent` measures against.
   */
  private frontSector(line?: LineDef): Sector | undefined {
    if (!line || line.right === NO_SIDE) return undefined;
    const index = this.map.sidedefs[line.right]?.sector;
    return index === undefined ? undefined : this.map.sectors[index];
  }

  /**
   * The model sector a Boom change copies from (`p_genlin.c`,
   * `p_floor.c: EV_DoChange`): the triggering line's front sector, or — for
   * the numeric model — the first neighbor whose `plane` height already
   * equals `target` (`P_FindModelFloorSector`/`P_FindModelCeilingSector`).
   * `undefined` means no model, which applies nothing at all.
   */
  private modelSector(
    sectorIndex: number,
    model: 'trigger' | 'numeric',
    plane: 'floor' | 'ceiling',
    target: number,
    line?: LineDef,
  ): Sector | undefined {
    if (model === 'trigger') return this.frontSector(line);
    for (const n of neighborSectorIndices(this.map, sectorIndex)) {
      const s = this.map.sectors[n];
      if ((plane === 'ceiling' ? s.ceilHeight : s.floorHeight) === target) return s;
    }
    return undefined;
  }

  /**
   * Boom's generalized change (`SurfaceChange`), floor flavor: resolves the
   * model sector now and hands `tickFloor` what to apply on arrival. The
   * numeric model matches neighbors on *ceiling* height when the destination
   * itself is ceiling-derived — `EV_DoGenFloor`'s own
   * `P_FindModelCeilingSector` split.
   */
  private resolveFloorChange(
    sectorIndex: number,
    effect: FloorEffect,
    target: number,
    line?: LineDef,
  ): FloorMover['arrivalTexture'] {
    const change = effect.change!;
    const byCeiling = effect.target === 'lowestNeighborCeiling' || effect.target === 'ownCeiling';
    const model = this.modelSector(sectorIndex, change.model, byCeiling ? 'ceiling' : 'floor', target, line);
    if (!model) return undefined;
    return { floorTex: model.floorTex, special: changedSpecial(change, model) };
  }

  /**
   * Boom's `P_FindShortestTextureAround`/`P_FindShortestUpperAround`, and the
   * scan vanilla's own `raiseToTexture` runs (`triggerRaiseToTexture`): the
   * smallest lower/upper texture pixel height on *either* sidedef of any
   * two-sided line bordering the sector. `Infinity` when nothing qualifies —
   * vanilla's own `MAXINT` sentinel, a malformed-map case.
   */
  private shortestTextureAround(sectorIndex: number, slot: 'lower' | 'upper'): number {
    let minHeight = Infinity;
    for (const lineIndex of sectorLines(this.map, sectorIndex)) {
      const line = this.map.linedefs[lineIndex];
      const front = line.right !== NO_SIDE ? this.map.sidedefs[line.right]?.sector : undefined;
      const back = line.left !== NO_SIDE ? this.map.sidedefs[line.left]?.sector : undefined;
      if (front === undefined || back === undefined) continue;
      for (const side of [this.map.sidedefs[line.right], this.map.sidedefs[line.left]]) {
        const name = side?.[slot];
        if (!side || name === NO_TEXTURE || name === '') continue;
        const h = this.bank.textureHeight(name);
        if (h !== null && h < minHeight) minHeight = h;
      }
    }
    return minHeight;
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

  /**
   * A sector already crushing (in either direction) ignores a re-trigger, matching vanilla's
   * `sec->specialdata` guard; one frozen by a stop line resumes the direction it was travelling.
   *
   * Returns `EV_DoCeiling`'s own `rtn`, which the switch gating in `trigger` reads: 1 only for a
   * sector that got a *new* thinker. Restarting an in-stasis crusher deliberately reports `false` —
   * vanilla runs `P_ActivateInStasisCeiling` before the loop, and the loop then `continue`s past
   * that sector because stasis never cleared its `specialdata`, so `rtn` stays 0 and the switch
   * neither flips nor is spent. docs/specials.md § Crushers.
   */
  private triggerCrusher(sectorIndex: number, effect: CrusherEffect): boolean {
    const existing = this.ceilingMovers.get(sectorIndex);
    if (existing && existing.kind === 'crusher') {
      if (existing.state === 'stopped') {
        existing.state = existing.stoppedFrom ?? 'lowering';
        existing.stoppedFrom = undefined;
      }
      return false;
    }
    if (this.ceilingActive(sectorIndex)) return false;
    const sector = this.map.sectors[sectorIndex];
    this.setMover(sectorIndex, {
      kind: 'crusher',
      sectorIndex,
      speed: effect.speed,
      topHeight: sector.ceilHeight,
      bottomHeight: sector.floorHeight + EIGHT_UNIT_GAP,
      state: 'lowering',
      silent: effect.silent,
      slowsWhenCrushing: effect.slowsWhenCrushing,
      noEndClack: effect.noEndClack,
    });
    return true;
  }

  /** `EV_CeilingCrushStop`: freezes a running crusher where it stands, remembering its direction. Already-stopped is not a hit — vanilla's own `direction != 0` guard, and so its `rtn`. */
  private triggerCrusherStop(sectorIndex: number): boolean {
    const existing = this.ceilingMovers.get(sectorIndex);
    if (!existing || existing.kind !== 'crusher' || existing.state === 'stopped') return false;
    existing.stoppedFrom = existing.state;
    existing.state = 'stopped';
    return true;
  }

  /** Vanilla's own `sec->specialdata` guard: a sector already driven by *any* mover ignores this — unlike doors/lifts/floors above, there's no interactive re-trigger behavior worth having for a one-way move. */
  private triggerCeiling(sectorIndex: number, effect: CeilingEffect, line?: LineDef): boolean {
    if (this.ceilingActive(sectorIndex)) return false;
    const target = resolveCeilingTarget(this.map, sectorIndex, effect.target, () =>
      this.shortestTextureAround(sectorIndex, 'upper'),
    );
    this.setMover(sectorIndex, {
      kind: 'ceiling',
      sectorIndex,
      speed: effect.speed,
      target,
      state: 'moving',
      crush: effect.crush,
      arrivalTexture: effect.change ? this.resolveCeilingChange(sectorIndex, effect, target, line) : undefined,
    });
    return true;
  }

  /** The ceiling flavor of `resolveFloorChange` — `EV_DoGenCeiling` matches neighbors on *floor* height when the destination is floor-derived. */
  private resolveCeilingChange(
    sectorIndex: number,
    effect: CeilingEffect,
    target: number,
    line?: LineDef,
  ): CeilingMover['arrivalTexture'] {
    const change = effect.change!;
    const byFloor = effect.target === 'highestNeighborFloor' || effect.target === 'ownFloor';
    const model = this.modelSector(sectorIndex, change.model, byFloor ? 'floor' : 'ceiling', target, line);
    if (!model) return undefined;
    return { ceilTex: model.ceilTex, special: changedSpecial(change, model) };
  }

  /**
   * Boom's `EV_DoChange`: instant floor-flat + special copy from the model,
   * no mover. Numeric model = first neighbor at the sector's own floor
   * height; no model applies nothing, but the sector still counts as hit
   * (vanilla's `rtn = 1` runs before the model search), so switches flip.
   */
  private triggerChangeOnly(sectorIndex: number, effect: ChangeOnlyEffect, line?: LineDef): boolean {
    const sector = this.map.sectors[sectorIndex];
    const model = this.modelSector(sectorIndex, effect.model, 'floor', sector.floorHeight, line);
    if (model) this.applyArrivalChange(sectorIndex, { floorTex: model.floorTex, special: model.special });
    return true;
  }

  /**
   * `EV_DoElevator`: the target pair is fixed at trigger time — the next
   * floor up/down, or the activating line's front-sector floor
   * (`elevateCurrent`) — and the ceiling target preserves the sector's gap.
   */
  private triggerElevator(sectorIndex: number, effect: ElevatorEffect, line?: LineDef): boolean {
    // Both slots, matching `EV_DoElevator`'s own
    // `if (sec->floordata || sec->ceilingdata) continue;` — it is the one
    // trigger that claims a sector's floor *and* ceiling (see `moverClass`).
    if (this.floorActive(sectorIndex) || this.ceilingActive(sectorIndex)) return false;
    const sector = this.map.sectors[sectorIndex];
    let floorTarget: number;
    if (effect.target === 'nextHigherFloor') {
      floorTarget = nextHigherFloor(this.map, sectorIndex);
    } else if (effect.target === 'nextLowerFloor') {
      floorTarget = nextLowerFloor(this.map, sectorIndex);
    } else {
      const front = this.frontSector(line);
      if (!front) return false;
      floorTarget = front.floorHeight;
    }
    if (floorTarget === sector.floorHeight) return false;
    this.setMover(sectorIndex, {
      kind: 'elevator',
      sectorIndex,
      speed: effect.speed,
      floorTarget,
      ceilTarget: floorTarget + (sector.ceilHeight - sector.floorHeight),
      state: 'moving',
    });
    return true;
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
  private triggerRaiseToTexture(sectorIndex: number): boolean {
    if (this.floorActive(sectorIndex)) return false;
    const sector = this.map.sectors[sectorIndex];
    const target = sector.floorHeight + this.shortestTextureAround(sectorIndex, 'lower');
    this.setMover(sectorIndex, {
      kind: 'floor',
      sectorIndex,
      speed: FLOOR_SPEED,
      target,
      state: 'moving',
      crush: false,
      direction: 'up',
    });
    return true;
  }

  /**
   * Vanilla's `lowerAndChange` — see `LowerAndChangeEffect`'s doc for the
   * model-sector search and why the texture/special only apply on arrival
   * (`arrivalTexture`, applied by `tickFloor`).
   */
  private triggerLowerAndChange(sectorIndex: number): boolean {
    if (this.floorActive(sectorIndex)) return false;
    const target = lowestNeighborFloor(this.map, sectorIndex);
    let arrivalTexture: { floorTex: string; special: number } | undefined;
    for (const neighborIndex of neighborSectorIndices(this.map, sectorIndex)) {
      const neighbor = this.map.sectors[neighborIndex];
      if (neighbor.floorHeight === target) {
        arrivalTexture = { floorTex: neighbor.floorTex, special: neighbor.special };
        break;
      }
    }
    this.setMover(sectorIndex, {
      kind: 'floor',
      sectorIndex,
      speed: FLOOR_SPEED,
      target,
      state: 'moving',
      crush: false,
      direction: 'down',
      arrivalTexture,
    });
    return true;
  }

  /**
   * Vanilla's `EV_DoDonut` — see `DonutEffect`'s doc for the ring/outer
   * search and the deliberate divergence from vanilla's own buggy two-sided
   * check. Only the hole (`holeIndex`) gets vanilla's busy-sector guard,
   * matching the real source, which never checks the ring before
   * overwriting its mover.
   */
  private triggerDonut(holeIndex: number): boolean {
    if (this.floorActive(holeIndex)) return false;
    const ringIndex = neighborSectorIndices(this.map, holeIndex)[0];
    if (ringIndex === undefined) return false;
    let outerIndex: number | undefined;
    for (const candidate of neighborSectorIndices(this.map, ringIndex)) {
      if (candidate === holeIndex) continue;
      outerIndex = candidate;
      break;
    }
    if (outerIndex === undefined) return false;
    const outer = this.map.sectors[outerIndex];
    this.setMover(ringIndex, {
      kind: 'floor',
      sectorIndex: ringIndex,
      speed: FLOOR_SPEED / 2,
      target: outer.floorHeight,
      state: 'moving',
      crush: false,
      // `donutRaise` is direction +1 and the hole's `lowerFloor` -1 below,
      // both aimed at the same outer floor.
      direction: 'up',
      arrivalTexture: { floorTex: outer.floorTex, special: 0 },
    });
    this.setMover(holeIndex, {
      kind: 'floor',
      sectorIndex: holeIndex,
      speed: FLOOR_SPEED / 2,
      target: outer.floorHeight,
      state: 'moving',
      crush: false,
      direction: 'down',
    });
    return true;
  }

  /**
   * Instant light-level changes/strobe-starts — see `LightChangeMode`'s doc
   * for each mode's vanilla source. Unlike a blink pattern assigned at map
   * load (`lightStates`, seeded in the constructor), these can target *any*
   * sector on demand, which is exactly what `recolorSector` already handles
   * generically — the only new piece here is computing the new level itself.
   */
  private triggerLightChange(sectorIndex: number, effect: LightChangeEffect): boolean {
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
        // `EV_StartLightStrobing` guards on `P_SectorActive(lighting_special)`
        // — the light thinker's own slot, which is this map. Only vanilla's
        // demo-compat mode folds movers into that test, so a sector with a
        // door running is free to start strobing.
        if (this.lightStates.has(sectorIndex)) return false;
        this.lightStates.set(sectorIndex, makeLightState('blink1', sector.light, darkestNeighborLight(this.map, sectorIndex)));
        break;
    }
    return true;
  }

  /**
   * All steps in the chain start rising together (not staggered) — each just
   * has farther to travel, which is what produces the classic step-by-step
   * reveal as they settle at different times. Reuses the plain `FloorMover`
   * machinery per step rather than a dedicated mover kind, since a single
   * step is exactly a floor rising to a fixed target height.
   */
  private triggerStairs(startSectorIndex: number, effect: StairsEffect): boolean {
    if (this.floorActive(startSectorIndex)) return false; // vanilla's sec->specialdata guard
    for (const step of findStairChain(this.map, startSectorIndex, effect.stepHeight, effect.direction, effect.ignoreTexture)) {
      if (this.floorActive(step.sectorIndex)) continue; // EV_BuildStairs' own per-step `tsec->specialdata` skip
      this.setMover(step.sectorIndex, {
        kind: 'floor',
        sectorIndex: step.sectorIndex,
        speed: effect.speed,
        target: step.targetHeight,
        state: 'moving',
        // `EV_BuildStairs` is direction +1 throughout; Boom's generalized
        // stairs build downward on their own bit. A step already past its
        // accumulated target (Boom's `Igno` chains across arbitrary heights)
        // is the same clamp every other inverted move gets.
        direction: effect.direction ?? 'up',
        // Despite the wiki naming 100/127 "...and Crush", real vanilla
        // stairs never set a crush flag — see StairsEffect's doc.
        crush: false,
      });
    }
    return true;
  }

  /** First teleport-landing marker (`MT_TELEPORTMAN`) sitting in one of the tag-matched sectors — vanilla's own search is just as arbitrary when more than one exists. */
  private findTeleportDestination(sectorIndices: readonly number[]): Placement | null {
    if (sectorIndices.length === 0) return null;
    const targets = new Set(sectorIndices);
    for (const t of this.map.things) {
      if (t.type !== ThingType.teleportDest) continue;
      // Vanilla's `EV_Teleport` copies the destination mobj's own angle, and that mobj came out of
      // `P_SpawnMapThing` — so the arrival facing is the snapped one, not the raw THING field.
      if (targets.has(this.world.sectorIndexAt(t.x, t.y)))
        return { x: t.x, y: t.y, angle: (spawnAngleDeg(t.angle) * Math.PI) / 180 };
    }
    return null;
  }

  /**
   * Where a crossing of `line` puts the body — vanilla's loud landing, or one
   * of Boom's two silent kinds. See docs/specials.md § Silent and line-to-line
   * teleporters.
   */
  private teleportArrival(
    lineIndex: number,
    def: SpecialDef,
    effect: TeleportEffect,
    at: TeleportSource,
    activator: Activator,
  ): TeleportDest | null {
    if (effect.destination === 'line') return this.lineArrival(lineIndex, effect, at, activator);
    const dest = this.findTeleportDestination(resolveTargets(this.map, this.map.linedefs[lineIndex], def));
    if (!dest) return null;
    // `EV_Teleport`: aim the body at the marker, drop it to the floor and let
    // the caller zero its momentum.
    if (!effect.silent) return dest;
    // `EV_SilentTeleport`: rotate rather than aim. The rotation is the crossed
    // line's angle minus the marker's, plus a right angle — vanilla's comment
    // says why: "walking perpendicularly across [the] teleporter linedef
    // causes [the] thing to exit in the direction indicated by the exit thing".
    const rotateBy = this.lineAngle(lineIndex) - dest.angle + Math.PI / 2;
    return { x: dest.x, y: dest.y, angle: at.angle + rotateBy, silent: true, rotateBy };
  }

  /**
   * A linedef's own heading, `R_PointToAngle2(0, 0, line->dx, line->dy)` —
   * off `World`'s precomputed `ld->dx`/`ld->dy` rather than re-derived from
   * the vertexes, like every other line-geometry read in this file.
   */
  private lineAngle(lineIndex: number): number {
    return Math.atan2(this.world.lineDY[lineIndex], this.world.lineDX[lineIndex]);
  }

  /**
   * `EV_SilentLineTeleport`: the body keeps its position *along* the crossed
   * line and is re-laid onto the first tag-matched two-sided linedef that
   * isn't this one, turned by the angle between them. `reversed` (262-265)
   * flips both the position along the exit and the turn, so the pair reads as
   * one continuous doorway rather than a mirror.
   *
   * Two details are load-bearing and come straight from the source: the
   * landing floor is the **higher** of the exit line's two sectors
   * (`sides[l->sidenum[stepdown]]`), and the body must end up on a specific
   * *side* of the exit line — `reverse || (player && stepdown)` — or it
   * oscillates back through the teleporter it just came out of.
   */
  private lineArrival(
    lineIndex: number,
    effect: TeleportEffect,
    at: TeleportSource,
    activator: Activator,
  ): TeleportDest | null {
    const line = this.map.linedefs[lineIndex];
    const from = { a: this.map.vertexes[line.v1], b: this.map.vertexes[line.v2] };
    if (!from.a || !from.b) return null;
    const dx = this.world.lineDX[lineIndex];
    const dy = this.world.lineDY[lineIndex];
    for (const i of linesByTag(this.map, line.tag)) {
      const exit = this.map.linedefs[i];
      if (exit === line || exit.left === NO_SIDE || exit.right === NO_SIDE) continue;
      const a = this.map.vertexes[exit.v1];
      const b = this.map.vertexes[exit.v2];
      const front = this.map.sectors[this.map.sidedefs[exit.right]?.sector];
      const back = this.map.sectors[this.map.sidedefs[exit.left]?.sector];
      if (!a || !b || !front || !back) continue;
      const exitDx = this.world.lineDX[i];
      const exitDy = this.world.lineDY[i];

      // Where along the entry line the body crossed, taken on the dominant
      // axis so a near-axis-aligned line doesn't divide by ~0.
      let pos = Math.abs(dx) > Math.abs(dy) ? (at.x - from.a.x) / dx : (at.y - from.a.y) / dy;
      if (!Number.isFinite(pos)) continue;
      if (effect.reversed) pos = 1 - pos;
      const rotateBy = (effect.reversed ? 0 : Math.PI) + Math.atan2(exitDy, exitDx) - Math.atan2(dy, dx);

      // Interpolated back from v2, matching `l->v2 - FixedMul(pos, l->dx)`.
      let px = b.x - pos * exitDx;
      let py = b.y - pos * exitDy;

      const stepdown = front.floorHeight < back.floorHeight;
      const wantFront = !(effect.reversed || (activator === 'player' && stepdown));
      // Vanilla nudges by up to 10 fixed-point units (10/65536 of a map unit)
      // to settle which side of the exit line the rounding landed on. That is
      // a fixed-point artifact, not a rule; the float equivalent is a single
      // step along the line's normal, which is what the loop was converging on.
      if (isFrontSide(a.x, a.y, b.x, b.y, px, py) !== wantFront) {
        const len = Math.hypot(exitDx, exitDy) || 1;
        const nudge = wantFront ? LINE_TELEPORT_NUDGE : -LINE_TELEPORT_NUDGE;
        px += (exitDy / len) * nudge;
        py += (-exitDx / len) * nudge;
      }

      // Vanilla measures the landing floor as "the higher of the two floor
      // heights at the exit linedef" (`sides[l->sidenum[stepdown]]`). That is
      // what `World.groundFloor` already returns for a body straddling a line,
      // and the exit point sits a fraction of a unit off it against a 16-unit
      // player radius — so the caller's own resting-height query lands on the
      // same number, and preserving a height above it needs nothing from here.
      return { x: px, y: py, angle: at.angle + rotateBy, silent: true, rotateBy };
    }
    return null;
  }

  // ---- Triggers ----------------------------------------------------------

  /**
   * A line's *effective* special: the authored number, XORed with its
   * `retriggerXor` while the line sits flipped (`retriggerFlips`). Every
   * trigger path resolves through here rather than reading `line.special`
   * directly, which is what lets Boom's retrigger alternation work without
   * ever mutating the map — see `retriggerFlips`.
   */
  private lineSpecial(lineIndex: number): number {
    const special = this.map.linedefs[lineIndex].special;
    if (!this.retriggerFlips.has(lineIndex)) return special;
    return special ^ (lookupSpecial(special)?.retriggerXor ?? 0);
  }

  /**
   * `fromBackSide` is vanilla's `P_CrossSpecialLine` `side` argument — the side
   * the thing was on *before* the move (`P_TryMove` passes `oldside`). Only the
   * teleport branch reads it, matching vanilla, where `side` reaches nothing but
   * `EV_Teleport`. See docs/specials.md § Teleporters.
   *
   * `at` is where the activator is standing and which way it faces — only the
   * silent teleports read it (`TeleportSource`), so every other caller can
   * leave it at the default.
   */
  private trigger(
    lineIndex: number,
    ownedKeys: ReadonlySet<KeySlot>,
    activator: Activator = 'player',
    fromBackSide = false,
    at: TeleportSource = NO_SOURCE,
  ): TeleportDest | null {
    const line = this.map.linedefs[lineIndex];
    const def = lookupSpecial(this.lineSpecial(lineIndex));
    if (!def) return null;
    if (!def.repeatable && this.usedOnce.has(lineIndex)) return null;
    // A line that acts by tag and has none does nothing — see `SpecialDef.requiresTag`.
    if (def.requiresTag && line.tag === 0) return null;
    // A missing key leaves the door untouched and this attempt un-flagged, so
    // the player can walk off, find the key, and try the same line again —
    // matching vanilla, which just prints "you need the X key" and does
    // nothing else.
    if (def.lock && !satisfiesLock(ownedKeys, def.lock)) {
      // Vanilla's own feedback: a "you need the X key" message plus `oof` at full volume
      // (`S_StartSound(NULL, sfx_oof)`). A manual door is the door itself, anything else keyed is
      // a remote switch — see `LockedLine`. Both are player-only; a monster never uses a line.
      if (activator === 'player') this.lockedLine = { lock: def.lock, kind: def.manual ? 'door' : 'switch' };
      this.sfx.play('oof');
      return null;
    }

    // `P_ChangeSwitchTexture` both flips the art and, for a one-shot line,
    // spends it, so the two always move together. `P_UseSpecialLine` calls it
    // *inside* `if (EV_…)` for every switch but the exits and light switches
    // (`SWITCH_ALWAYS_FLIPS`) and the manual doors, which never route through an
    // EV_ return at all; walk and shoot triggers are unconditional in
    // `P_CrossSpecialLine`/`P_ShootSpecialLine`. Deferred to the end of the
    // method when gated. docs/specials.md § A switch only flips when it acts.
    const gated = def.trigger === 'use' && !def.manual && !SWITCH_ALWAYS_FLIPS.has(line.special);
    if (!gated) this.flashSwitch(lineIndex, def.repeatable);

    if (def.effect.kind === 'exit') {
      this.usedOnce.add(lineIndex);
      this.onExit(def.effect.secret);
      return null;
    }

    if (def.effect.kind === 'teleport') {
      const effect = def.effect;
      // 125/126 and Boom's 264-269 are the monster-only numbers: vanilla lists
      // them only in `P_CrossSpecialLine`'s non-player branch, so a player
      // walking one does nothing at all. 39/97 work for either.
      if (effect.monsterOnly && activator !== 'monster') return null;
      // A back-side crossing is `EV_Teleport`'s "so you can get out of
      // teleporter" case, shared by every variant here. docs/specials.md § Teleporters.
      const dest = fromBackSide ? null : this.teleportArrival(lineIndex, def, effect, at, activator);
      // Vanilla's `case 39` clears `line->special` regardless of the result
      // (`|| demo_compatibility`), so a blocked crossing still spends the
      // line; Boom's own numbers clear it only on success — see
      // `TeleportEffect.spendOnlyOnSuccess`.
      if (!def.repeatable && (dest || !effect.spendOnlyOnSuccess)) this.usedOnce.add(lineIndex);
      if (!dest) return null;
      // A switch teleport (174/195, and Boom's silent 209/210) flips here
      // rather than at the end of the method: this branch returns early, and
      // `P_UseSpecialLine` flips inside `if (EV_…)`, i.e. only on success.
      if (gated) this.flashSwitch(lineIndex, def.repeatable);
      // A monster's or voodoo doll's teleport is the caller's to perform, and
      // must *not* touch `lastTeleport` — that exists solely to reseed the
      // player's own walk-trigger tracking (see its doc); where another body
      // jumped to says nothing about where the player just walked.
      if (activator !== 'player') return dest;
      this.lastTeleport = dest;
      this.onTeleport(dest);
      return null;
    }

    const targets = resolveTargets(this.map, line, def);
    if (targets.length === 0) return null;

    // Vanilla's `rtn`: true once any target sector actually took the effect.
    let applied = false;
    for (const sectorIndex of targets) applied = this.applyEffect(sectorIndex, def.effect, line) || applied;
    // Boom's three ceiling-then-floor pairs — see `SpecialDef.secondEffect`.
    // The second pass is its own loop over the same targets, matching the
    // real dispatch: `EV_DoCeiling` runs over every tagged sector before
    // `EV_DoFloor` is attempted on any of them.
    const second = def.secondEffect;
    if (second && !(second.onlyIfPrimaryFailed && applied)) {
      for (const sectorIndex of targets) applied = this.applyEffect(sectorIndex, second.effect, line) || applied;
    }
    // Boom's retrigger alternation (generalized stairs' build direction): the
    // line's *effective* special flips on every activation that did something.
    // See `SpecialDef.retriggerXor` and `lineSpecial`.
    if (applied && def.retriggerXor !== undefined) {
      if (!this.retriggerFlips.delete(lineIndex)) this.retriggerFlips.add(lineIndex);
    }
    // See `gated` above: a switch that did nothing is left untouched and unspent.
    if (gated && !applied) return null;
    if (gated) this.flashSwitch(lineIndex, def.repeatable);
    if (!def.repeatable) this.usedOnce.add(lineIndex);
    return null;
  }

  /** One effect against one tag-matched sector, returning that sector's share of vanilla's `rtn`. */
  private applyEffect(sectorIndex: number, effect: Effect, line?: LineDef): boolean {
    switch (effect.kind) {
      case 'door':
        return this.triggerDoor(sectorIndex, effect);
      case 'lift':
        return this.triggerLift(sectorIndex, effect);
      case 'liftStop':
        return this.triggerLiftStop(sectorIndex);
      case 'floor':
        return this.triggerFloor(sectorIndex, effect, line);
      case 'crusher':
        return this.triggerCrusher(sectorIndex, effect);
      case 'crusherStop':
        return this.triggerCrusherStop(sectorIndex);
      case 'ceiling':
        return this.triggerCeiling(sectorIndex, effect, line);
      case 'elevator':
        return this.triggerElevator(sectorIndex, effect, line);
      case 'changeOnly':
        return this.triggerChangeOnly(sectorIndex, effect, line);
      case 'raiseToTexture':
        return this.triggerRaiseToTexture(sectorIndex);
      case 'lowerAndChange':
        return this.triggerLowerAndChange(sectorIndex);
      case 'stairs':
        return this.triggerStairs(sectorIndex, effect);
      case 'donut':
        // The tag match already resolved to the "hole" sector; the ring and
        // outer sectors are discovered dynamically inside — see triggerDonut.
        return this.triggerDonut(sectorIndex);
      case 'lightChange':
        return this.triggerLightChange(sectorIndex, effect);
      // Spelled out rather than left to a `default`, for the reason
      // `tickMovers` gives: a new `Effect` kind must be a compile error here,
      // not something that silently does nothing at every tagged sector. Both
      // return out of `trigger` before the per-sector loop ever runs.
      case 'exit':
      case 'teleport':
        return false;
    }
  }

  /**
   * A monster walking from `prev` to `pos` crosses whatever walk
   * triggers lie between — vanilla's `P_CrossSpecialLine` runs for any thing,
   * not just the player, but gates non-players to a short allow-list carried
   * per number as `SpecialDef.monsterActivate`: teleports (vanilla's and
   * Boom's silent family alike), one door type and two lift types.
   * Returns the landing spot if the crossing teleported it, so the caller can
   * move the monster and puff the fog; everything else (a door opening, a lift
   * dropping) happens as a side effect, exactly as it does under the player.
   *
   * This is what makes a mapper's monster closet work: the classic setup is a
   * pack of monsters behind a 125/126 line that only they can walk, teleporting
   * them into the arena the moment they start chasing.
   */
  crossMonster(prev: Pos2, pos: CrossingBody, ownedKeys: ReadonlySet<KeySlot>): TeleportDest | null {
    // The facing matters: Boom's silent numbers rotate a body rather than
    // aiming it.
    return this.crossLines(prev.x, prev.y, pos.x, pos.y, 'monster', ownedKeys, pos.angle);
  }

  /**
   * `crossMonster`'s voodoo-doll twin: whatever walk lines the doll was carried
   * across this tic fire as though the player had walked them — same keys, same
   * lines — but the landing spot of a teleport comes back for the caller to
   * move the *doll*, not the player. See docs/specials.md § Voodoo dolls.
   */
  crossVoodoo(prev: Pos2, pos: Placement, ownedKeys: ReadonlySet<KeySlot>): TeleportDest | null {
    return this.crossLines(prev.x, prev.y, pos.x, pos.y, 'voodoo', ownedKeys, pos.angle);
  }

  /**
   * The one walk-trigger scan every activator goes through: whatever walk
   * lines lie between `(prevX, prevY)` and `(x, y)` fire, gated per activator
   * (`SpecialDef.monsterActivate` for monsters). Returns the landing spot if a
   * crossing teleported the activator — a monster's or voodoo doll's move is
   * the caller's to apply — or null.
   *
   * `facing` is the activator's heading in radians, the one thing a silent
   * teleport needs from it that this scan can't derive; the *position* it
   * reads is the crossing point below, never where the move ended.
   */
  private crossLines(
    prevX: number,
    prevY: number,
    x: number,
    y: number,
    activator: Activator,
    ownedKeys: ReadonlySet<KeySlot>,
    facing = 0,
  ): TeleportDest | null {
    if (prevX === x && prevY === y) return null;
    const radius = activator === 'monster' ? MONSTER_CROSS_RADIUS : PLAYER_RADIUS + 8;
    for (const i of this.world.linesNear(x, y, radius)) {
      const line = this.map.linedefs[i];
      const def = lookupSpecial(this.lineSpecial(i));
      if (!def || def.trigger !== 'walk') continue;
      if (activator === 'monster' && !def.monsterActivate) continue;
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      const hit = segmentIntersect(prevX, prevY, x, y, a.x, a.y, b.x, b.y);
      if (!hit) continue;
      // A line-to-line teleport interpolates the body's position *along the
      // crossed line*, so it wants the crossing point rather than wherever the
      // move happened to end (`EV_SilentLineTeleport` runs from `thing->x/y`
      // inside `P_CrossSpecialLine`, i.e. mid-crossing).
      const source: TeleportSource = { x: prevX + (x - prevX) * hit.t, y: prevY + (y - prevY) * hit.t, angle: facing };
      // `oldside`: the side the activator was on before this move — see `trigger`.
      const dest = this.trigger(i, ownedKeys, activator, !isFrontSide(a.x, a.y, b.x, b.y, prevX, prevY), source);
      if (dest) return dest;
    }
    return null;
  }

  /**
   * Vanilla's `A_BossDeath` — see docs/death.md § Boss death. `game.ts` calls this once per
   * monster death that leaves none of its type alive on the level (`ThingLayer`'s own doomednum
   * check).
   *
   * `playerAlive` is `A_BossDeath`'s "make sure there is a player alive for victory" loop, applied
   * per row rather than to the whole call: only rows that came from that function carry
   * `needsLivingPlayer` (see `bossDeathTriggersFor`).
   */
  notifyBossDeath(type: number, playerAlive: boolean): void {
    for (const t of this.bossDeathTriggers) {
      if (t.type !== type || (t.needsLivingPlayer && !playerAlive)) continue;
      if (t.action.kind === 'exit') this.onExit(false);
      else this.triggerTag(t.action.tag, t.action.kind);
    }
  }

  /** The tag-matched half of `notifyBossDeath` — no triggering linedef exists, so this scans sector tags directly rather than going through `resolveTargets`/`trigger`. */
  private triggerTag(tag: number, kind: 'lowerFloorToLowest' | 'raiseToTexture' | 'blazeOpen' | 'open'): void {
    for (const i of sectorsByTag(this.map, tag)) {
      switch (kind) {
        case 'lowerFloorToLowest':
          this.triggerFloor(i, {
            kind: 'floor',
            speed: FLOOR_SPEED,
            target: 'lowestNeighborFloor',
            direction: 'down',
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
  triggerShot(lineIndex: number | null, ownedKeys: ReadonlySet<KeySlot>, byMonster = false): void {
    if (lineIndex === null) return;
    const def = lookupSpecial(this.lineSpecial(lineIndex));
    if (!def || def.trigger !== 'shoot') return;
    if (byMonster && !def.monsterCanTrigger) return;
    this.trigger(lineIndex, ownedKeys, byMonster ? 'monster' : 'player');
  }

  private handleUseTrigger(
    playerX: number,
    playerY: number,
    playerAngle: number,
    input: Input,
    ownedKeys: ReadonlySet<KeySlot>,
  ): void {
    if (!input.pressed('Space') && !input.rightMousePressed('use')) return;
    const tx = playerX + Math.cos(playerAngle) * USE_RANGE;
    const ty = playerY + Math.sin(playerAngle) * USE_RANGE;

    const hits: { t: number; line: number }[] = [];
    for (const i of this.world.linesNear(playerX, playerY, USE_RANGE + 8)) {
      const line = this.map.linedefs[i];
      const def = lookupSpecial(this.lineSpecial(i));
      if (!def || def.trigger !== 'use') continue;
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      if (!isFrontSide(a.x, a.y, b.x, b.y, playerX, playerY)) continue;
      const hit = segmentIntersect(playerX, playerY, tx, ty, a.x, a.y, b.x, b.y);
      if (hit) hits.push({ t: hit.t, line: i });
    }
    // Boom's PASSUSE (`p_map.c: PTR_UseTraverse`): the use trace keeps going
    // past a triggered line only while that line carries the flag, so several
    // stacked specials can fire from one press. The vanilla behavior — nearest
    // use line wins, everything behind it is shadowed — is the flagless case.
    // Known divergence, unchanged here: vanilla's trace also stops at solid
    // non-special lines, which this scan has never modeled.
    hits.sort((p, q) => p.t - q.t);
    for (const h of hits) {
      // The player's own stance, for a silent switch teleport (209/210).
      this.trigger(h.line, ownedKeys, 'player', false, { x: playerX, y: playerY, angle: playerAngle });
      if (!(this.map.linedefs[h.line].flags & LF.PASSUSE)) break;
    }
  }

  private handleWalkTriggers(
    playerX: number,
    playerY: number,
    playerAngle: number,
    ownedKeys: ReadonlySet<KeySlot>,
  ): void {
    this.crossLines(this.prevX, this.prevY, playerX, playerY, 'player', ownedKeys, playerAngle);
  }

  // ---- Switch textures -------------------------------------------------

  private flashSwitch(lineIndex: number, useAgain: boolean): void {
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
    // `P_ChangeSwitchTexture` only starts a `P_StartButton` timer when
    // `useAgain` is set — that is, for a *repeatable* switch, which reverts
    // after BUTTONTIME so it can visibly be pressed again. A one-shot switch is
    // given no button at all and stays showing its on-texture for the rest of
    // the level. docs/specials.md § A switch only flips when it acts.
    if (useAgain) this.switchFlashes.set(lineIndex, SWITCH_FLASH_SECONDS);
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
