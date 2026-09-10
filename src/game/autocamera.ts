/**
 * The auto camera: measures how open the space around the player is each tic and glides the
 * camera's zoom and tilt between a narrow and a wide framing, pulling in for an occluder it cannot
 * see over and for a framing that would bury its eye. Also owns the "Camera mode" menu setting.
 * See docs/camera.md § Auto camera, § Framing past an occluder and § The buried-eye rescue.
 */
import { DOOM_TIC } from '../constants.ts';
import { MAX_CAMERA_DISTANCE, MAX_TILT_DEG, MIN_RESCUE_DISTANCE, type TopDownCamera } from '../render/camera.ts';
import { newDrawnBands, ownTransfers, twoSidedBands, type SectorTransfers } from '../render/mapmesh.ts';
import type { Pos3 } from '../types.ts';
import { dampen } from '../util/damping.ts';
import { segmentCrossT } from '../util/geom.ts';
import { readStorage, writeStorage } from '../util/storage.ts';
import { NO_SIDE } from '../wad/map.ts';
import { EYE_HEIGHT } from './player.ts';
import type { Opening, World } from './world.ts';
import { cos, sin } from '../util/fdlibm.ts';

/** Which camera mode is active — a menu setting, see docs/menu.md § Persisted settings. */
export type CameraMode = 'auto' | 'manual';

/** The auto camera's dampers, as `snapshot()` hands them over — docs/replays.md § Camera state. */
export interface AutoCameraSnapshot {
  spread: number;
  ahead: number;
  clearance: number;
  framing: number;
  tiltShift: number;
  initialised: boolean;
}

const CAMERA_MODE_STORAGE_KEY = 'cameraMode';
export const CAMERA_MODES: readonly CameraMode[] = ['auto', 'manual'];

/** The camera mode, shaped like every persisted setting — docs/menu.md § Persisted settings. */
let cameraMode: CameraMode = readStoredCameraMode();

export function getCameraMode(): CameraMode {
  return cameraMode;
}

export function setCameraMode(mode: CameraMode): void {
  cameraMode = mode;
  writeStorage(CAMERA_MODE_STORAGE_KEY, mode);
}

/** A replay's pin on the mode, without touching the stored one; `null` puts that back. */
export function overrideCameraMode(mode: CameraMode | null): void {
  cameraMode = mode ?? readStoredCameraMode();
}

// The framing endpoints the two smoothed opennesses lerp between — all tuned by feel; the
// distance pair rides `spread`, the tilt pair `ahead`. docs/camera.md § Auto camera.
export const AUTO_NARROW_DISTANCE = 350;
const AUTO_NARROW_TILT = 50;
const AUTO_WIDE_DISTANCE = 720;
const AUTO_WIDE_TILT = 70;

/** The probe fan: ray count and per-ray reach in map units — tuned by feel. */
const OPENNESS_RAY_COUNT = 24;
const OPENNESS_RANGE = 1280;

/**
 * Clear distances that count as fully shut-in / fully open — tuned by feel.
 * The two aggregates need their own windows because they are different
 * statistics. docs/camera.md § Auto camera.
 */
const SPREAD_NEAR = 60;
const SPREAD_FAR = 600;
const AHEAD_NEAR = 90;
const AHEAD_FAR = 1200;

/**
 * How fast the smoothed openness follows a measurement, 1/seconds — tuned by feel (the ~1 s
 * "breathing" dial).
 */
const OPENNESS_SMOOTH_RATE = 1.5;
/** Snap epsilon for the openness damper — tuned by feel (imperceptible). */
const OPENNESS_SNAP_EPS = 1e-3;

/**
 * How near the framing will come for an occluder it cannot get in front of — tuned by feel, and
 * nearer than `AUTO_NARROW_DISTANCE`. A *floor*, not the answer: the camera backs off only as far
 * as the occluder demands. docs/camera.md § Framing past an occluder.
 */
export const AUTO_OCCLUDED_DISTANCE = 250;

/**
 * How far above drawn ground the camera's eye has to stay to count as clear, in map units — tuned
 * by feel, and deliberately not zero. docs/camera.md § The buried-eye rescue.
 */
const CLEARANCE_MARGIN = 32;

/**
 * How far short of an occluder the framing stops on the sightline, in map units — tuned by feel.
 * Its own dial rather than `CLEARANCE_MARGIN`, whose equal value is a coincidence: that one is a
 * vertical clearance above ground, this a horizontal stand-off along the ray.
 */
const OCCLUDER_STANDOFF = 32;

/**
 * How far the camera's eye has to clear an occluder's top before the framing stops counting it, in
 * map units — tuned by feel. docs/camera.md § Framing past an occluder.
 */
const OCCLUDER_HEADROOM = 64;

/**
 * How far apart the rescue tries candidate distances while backing off, in map units — tuned by
 * feel. docs/camera.md § The buried-eye rescue.
 */
const CLEARANCE_STEP = 24;

/**
 * How fast the clearance clamp closes in and eases back out, 1/seconds — both tuned by feel, and
 * deliberately asymmetric. docs/camera.md § The buried-eye rescue.
 */
const CLEARANCE_IN_RATE = 8;
const CLEARANCE_OUT_RATE = 1.5;
/** Snap epsilon for the clearance damper, in map units — tuned by feel (imperceptible). */
const CLEARANCE_SNAP_EPS = 0.01;

/**
 * The fan's unit vectors, fixed in **world space** (every 15°) — a Q/E orbit
 * rotates the `ahead` weights, never the rays. docs/camera.md § Auto camera.
 */
const RAY_DIRS: readonly { dx: number; dy: number }[] = Array.from({ length: OPENNESS_RAY_COUNT }, (_, i) => {
  const angle = (i / OPENNESS_RAY_COUNT) * Math.PI * 2;
  return { dx: cos(angle), dy: sin(angle) };
});

/** Per-ray clear distances, reused across measurements so a tic allocates nothing. */
const clearances = new Float64Array(OPENNESS_RAY_COUNT);

/**
 * The ray currently being traced, and one bound visitor over it rather than a closure per ray —
 * `fogofwar.ts`'s `testBlocker` does the same. Module scratch because the trace is not reentrant.
 */
let rayWorld!: World;
let rayX = 0;
let rayY = 0;
let rayToX = 0;
let rayToY = 0;
let rayEyeZ = 0;
let rayNearestT = 1;
const rayOpening: Opening = { top: 0, bottom: 0 };

/**
 * How open a place is, in the two senses the framing needs — both 0 (shut in)
 * to 1 (wide open), and each mapped through its own window.
 * docs/camera.md § Auto camera.
 */
export interface Openness {
  /** The median ray: how boxed in the player is, whichever way they look. Drives the zoom. */
  spread: number;
  /**
   * Weighted toward the bearing the camera looks along: how far the view reaches. Drives the tilt.
   */
  ahead: number;
}

/**
 * How open the space around `from` is, looking along `viewDeg` (DOOM-space degrees). Each fan ray
 * runs from the player's eye to the nearest line that `blocksProbe`, off live sector heights.
 * docs/camera.md § Auto camera.
 */
export function measureOpenness(world: World, from: Pos3, viewDeg: number): Openness {
  rayWorld = world;
  rayX = from.x;
  rayY = from.y;
  rayEyeZ = from.z + EYE_HEIGHT;
  const viewRad = (viewDeg * Math.PI) / 180;
  const vx = cos(viewRad);
  const vy = sin(viewRad);
  let weighted = 0;
  let weight = 0;

  for (let r = 0; r < OPENNESS_RAY_COUNT; r++) {
    const dir = RAY_DIRS[r];
    rayToX = rayX + dir.dx * OPENNESS_RANGE;
    rayToY = rayY + dir.dy * OPENNESS_RANGE;
    rayNearestT = 1;
    world.forEachLineAlongSegment(rayX, rayY, rayToX, rayToY, traceRay);
    const clear = rayNearestT * OPENNESS_RANGE;
    clearances[r] = clear;

    // `max(0, cos)` off the view bearing, so rays behind the camera fall out
    // smoothly rather than at a cone edge.
    const w = dir.dx * vx + dir.dy * vy;
    if (w > 0) {
      weighted += w * clear;
      weight += w;
    }
  }

  // Normalised by the weight actually used, not a constant: a cosine lobe's
  // sum over a fixed fan ripples as the lobe rotates between rays.
  const ahead = toOpenness(weight > 0 ? weighted / weight : 0, AHEAD_NEAR, AHEAD_FAR);

  // Even ray count, so the median is the midpoint of the two middle rays.
  clearances.sort();
  const half = OPENNESS_RAY_COUNT / 2;
  const median = (clearances[half - 1] + clearances[half]) / 2;

  return { spread: toOpenness(median, SPREAD_NEAR, SPREAD_FAR), ahead };
}

/** How far the occlusion ray climbs over its length — its one extra piece of state. */
let rayRise = 0;
/**
 * The height an occluder has to reach for the camera not to be looking over it — see `standsOver`.
 */
let rayTopLimit = 0;
/**
 * The level's render transfers, and one scratch record for the bands they
 * resolve — module scratch alongside the ray, for the same reason: the trace is
 * not reentrant and a visitor per line would allocate.
 */
let rayTransfers!: SectorTransfers;
const rayBands = newDrawnBands();

/**
 * The unit direction from the player's eye toward the camera's, written by `eyeDirection` — every
 * probe here places an eye at `playerEye + d * dir`. Module scratch so a tic allocates nothing.
 */
let eyeDirX = 0;
let eyeDirY = 0;
let eyeDirZ = 0;
/** Where the eye is looking, and how far along that direction the ray may reach. */
export interface EyeLook {
  tiltDeg: number;
  yawDeg: number;
  distance: number;
}

/**
 * How far out the nearest thing drawn facing the camera and standing up to its eye is on the
 * sightline, in map units — `Infinity` when nothing does within `distance`, the ordinary case. One
 * ray answers for every framing at once; why it returns a distance rather than a verdict is
 * docs/camera.md § Framing past an occluder.
 */
export function nearestObstruction(
  world: World,
  from: Pos3,
  look: EyeLook,
  transfers?: SectorTransfers,
): number {
  const { tiltDeg, yawDeg, distance } = look;
  eyeDirection(tiltDeg, yawDeg);
  rayWorld = world;
  // Omitted means every sector draws itself, the same default `buildMapMesh`
  // takes — so a caller with no map-wide scan (tests, tools) is not a special
  // case. `AutoCamera` always has the level's own, and so allocates none.
  rayTransfers = transfers ?? ownTransfers(world.map);
  rayX = from.x;
  rayY = from.y;
  rayEyeZ = from.z + EYE_HEIGHT;
  rayRise = eyeDirZ * distance;
  rayTopLimit = rayEyeZ + rayRise - OCCLUDER_HEADROOM;
  rayToX = rayX + eyeDirX * distance;
  rayToY = rayY + eyeDirY * distance;
  rayNearestT = 1;
  world.forEachLineAlongSegment(rayX, rayY, rayToX, rayToY, traceObstruction);
  return rayNearestT < 1 ? rayNearestT * distance : Infinity;
}

/**
 * The furthest the camera may hang back along `tiltDeg`/`yawDeg` without burying its eye — `wanted`
 * itself whenever that framing is already fine, which is nearly always. One ray of candidates
 * covers every distance: docs/camera.md § The buried-eye rescue.
 */
export function measureClearance(
  world: World,
  from: Pos3,
  tiltDeg: number,
  yawDeg: number,
  wanted: number,
): number {
  eyeDirection(tiltDeg, yawDeg);
  const stepX = eyeDirX;
  const stepY = eyeDirY;
  const stepZ = eyeDirZ;
  const eyeZ = from.z + EYE_HEIGHT;
  for (let d = wanted; d > MIN_RESCUE_DISTANCE; d -= CLEARANCE_STEP) {
    if (!eyeBuried(world, from.x + stepX * d, from.y + stepY * d, eyeZ + stepZ * d)) return d;
  }
  return MIN_RESCUE_DISTANCE;
}

/**
 * How coarsely the buried-eye rescue searches tilts, in degrees — tuned by feel, the twin of
 * `CLEARANCE_STEP` for the other dial.
 */
const RESCUE_TILT_STEP = 5;

/**
 * How much further off vertical the framing leans once the zoom is pulled all the way in to
 * `AUTO_OCCLUDED_DISTANCE`, in degrees — tuned by feel. docs/camera.md § Auto camera.
 */
export const NEAR_TILT_LEAN = 10;

/**
 * How far the framing leans off the mapped tilt at `distance` — nothing at `AUTO_NARROW_DISTANCE`
 * and above, the whole `NEAR_TILT_LEAN` at the occluded floor or nearer. A pure function of the
 * distance, so it cannot hunt. docs/camera.md § Auto camera.
 */
export function nearTiltLean(distance: number): number {
  const span = AUTO_NARROW_DISTANCE - AUTO_OCCLUDED_DISTANCE;
  const t = (AUTO_NARROW_DISTANCE - distance) / span;
  return NEAR_TILT_LEAN * Math.min(1, Math.max(0, t));
}

/** The framing the openness dials asked for, and how far out the search may look for a clear one. */
export interface RescueRequest {
  /** The tilt the dials mapped to, in degrees off vertical. */
  mappedTilt: number;
  /** The camera's yaw, which decides which way "behind the player" is. */
  yawDeg: number;
  /** The distance the dials asked for. */
  wanted: number;
  /** The furthest out the search may pull, `MIN_RESCUE_DISTANCE` being the nearest. */
  limit: number;
}

/** A framing the rescue settled on — written into a caller's object, so a tic allocates nothing. */
export interface RescueFraming {
  distance: number;
  tiltDeg: number;
}

/**
 * The framing **nearest the one the openness dials asked for** whose eye is not buried, searched
 * over *both* dials at once — distance from `MIN_RESCUE_DISTANCE` to `limit`, tilt across the
 * camera's whole envelope. Returns `wanted`/`mappedTilt` untouched whenever they are already clear,
 * which is nearly always; `measureClearance` is the fallback when nothing in the envelope clears.
 * The tilt half only ever leans further off vertical, never back toward top-down.
 *
 * Why a search rather than one chosen direction, why the tilt is one-way, and how a degree is
 * weighed against a unit: docs/camera.md § The buried-eye rescue.
 */
export function rescueFraming(world: World, from: Pos3, ask: RescueRequest, out: RescueFraming): void {
  const { mappedTilt, yawDeg, wanted, limit } = ask;
  out.distance = wanted;
  out.tiltDeg = mappedTilt;
  if (!framingBuried(world, from, mappedTilt, yawDeg, wanted)) return;

  const tiltSpan = AUTO_WIDE_TILT - AUTO_NARROW_TILT;
  const distanceSpan = AUTO_WIDE_DISTANCE - AUTO_NARROW_DISTANCE;
  const tiltReach = MAX_TILT_DEG - mappedTilt;
  // The exact reach of the walk on each side: out to `limit`, in to the floor.
  const distanceReach = Math.max(limit - wanted, wanted - MIN_RESCUE_DISTANCE);
  let best = Infinity;
  let found = false;

  for (let dt = 0; dt <= tiltReach; dt += RESCUE_TILT_STEP) {
    const tiltCost = dt / tiltSpan;
    // Every later tilt is at least this far off, so nothing beyond can win.
    if (tiltCost >= best) break;
    const tilt = mappedTilt + dt;

    for (let di = 0; ; di++) {
      const dd = walkOffset(di, CLEARANCE_STEP);
      if (Math.abs(dd) > distanceReach) break;
      const cost = tiltCost + Math.abs(dd) / distanceSpan;
      if (cost >= best) break;
      const d = wanted + dd;
      if (d < MIN_RESCUE_DISTANCE || d > limit) continue;
      if (framingBuried(world, from, tilt, yawDeg, d)) continue;
      best = cost;
      found = true;
      out.distance = d;
      out.tiltDeg = tilt;
    }
  }

  // Nothing in the envelope clears: pulling in at the mapped tilt is what is
  // left, and gets the eye out of the ground even if it costs the framing.
  if (!found) out.distance = measureClearance(world, from, mappedTilt, yawDeg, wanted);
}

/**
 * How far the occluder clamp has to pull the zoom in before `AutoCamera.readout` prints it, in map
 * units — tuned by feel, and a readout threshold only: nothing about the framing reads it.
 */
const OCCL_READOUT_SLACK = 100;

/**
 * Drives `TopDownCamera.targetDistance`/`targetTiltDeg` from the openness
 * around the player. Runs on the **tic clock only** — the camera's framing is
 * simulation state (the aim ray is cast through it), so it must never advance
 * on the render clock. Constructed per level, like `FogOfWar`.
 */
export class AutoCamera {
  private world: World;
  /**
   * The level's render transfers, so the occlusion trace counts the bands the mesh actually drew.
   * Omitted means every sector draws itself, the same default the mesh builder takes.
   */
  private transfers: SectorTransfers;
  private smoothedSpread = 0;
  private smoothedAhead = 0;
  private smoothedClearance = MAX_CAMERA_DISTANCE;
  /**
   * The zoom the occluder leaves — or the buried-eye rescue asks for — in map units. Damped, so a
   * doorjamb in passing cannot pop it.
   */
  private smoothedFraming = MAX_CAMERA_DISTANCE;
  /**
   * How far the buried-eye rescue is shifting the tilt off the mapped one, in degrees — damped like
   * the clearance.
   */
  private smoothedTiltShift = 0;
  /** The rescue's answer, reused so a tic allocates nothing. */
  private rescue: RescueFraming = { distance: 0, tiltDeg: 0 };
  private initialised = false;

  constructor(world: World, transfers?: SectorTransfers) {
    this.world = world;
    this.transfers = transfers ?? ownTransfers(world.map);
  }

  /**
   * The five dampers and whether they have been seeded, for the one thing that has to carry them
   * across a level rebuild: `startRecording`, whose reload would otherwise re-seed the framing and
   * hop it under the player. docs/replays.md § Recording.
   */
  snapshot(): AutoCameraSnapshot {
    return {
      spread: this.smoothedSpread,
      ahead: this.smoothedAhead,
      clearance: this.smoothedClearance,
      framing: this.smoothedFraming,
      tiltShift: this.smoothedTiltShift,
      initialised: this.initialised,
    };
  }

  restore(state: AutoCameraSnapshot): void {
    this.smoothedSpread = state.spread;
    this.smoothedAhead = state.ahead;
    this.smoothedClearance = state.clearance;
    this.smoothedFraming = state.framing;
    this.smoothedTiltShift = state.tiltShift;
    this.initialised = state.initialised;
  }

  /**
   * The framing after the occluder cap and the outward rescue, in map units — the DEVMODE readout.
   */
  get occluded(): number {
    return this.smoothedFraming;
  }

  /**
   * How far the buried-eye rescue is currently shifting the tilt, in degrees — the DEVMODE readout.
   */
  get tiltShift(): number {
    return this.smoothedTiltShift;
  }

  /**
   * This camera's own DEVMODE line: the two openness dials, then only a clamp genuinely reshaping
   * the zoom they ask for — `Game.debugLines`' `cam` line already says where they landed.
   * docs/camera.md § Auto camera.
   */
  readout(): string {
    const open = this.mapDistance();
    const framed = Math.min(open, this.smoothedFraming);
    const occluded =
      this.smoothedFraming < open - OCCL_READOUT_SLACK ? ` occl ${this.smoothedFraming.toFixed(0)}u` : '';
    // A unit of slack, so a damper still gliding the last fraction of a unit
    // into place does not flicker the readout on and off.
    const raised = this.smoothedFraming > open + 1 ? ` raised ${this.smoothedFraming.toFixed(0)}u` : '';
    const buried = this.smoothedClearance < framed - 1 ? ` buried ${this.smoothedClearance.toFixed(0)}u` : '';
    const shift =
      Math.abs(this.smoothedTiltShift) >= 1
        ? ` tilt ${this.smoothedTiltShift > 0 ? '+' : ''}${this.smoothedTiltShift.toFixed(0)}°`
        : '';
    return `auto spread ${this.smoothedSpread.toFixed(2)} ahead ${this.smoothedAhead.toFixed(2)}${occluded}${raised}${shift}${buried}`;
  }

  /**
   * One unsmoothed measurement that *jumps* the camera to its mapped framing, so a level never
   * opens mid-zoom. Called on level load, after the spawn yaw is set and before the follow point's
   * `snapTo` — docs/camera.md § Auto camera.
   */
  seed(from: Pos3, camera: TopDownCamera): void {
    if (getCameraMode() !== 'auto') return;
    this.initialised = false;
    this.tick(from, camera);
    camera.snapFraming(camera.targetDistance, camera.targetTiltDeg);
  }

  /**
   * One tic: measure, smooth and retarget the framing, then cap the zoom at what the occluder and
   * the buried-eye rescue leave. A no-op in manual mode, so callers need not know the mode.
   *
   * `viewerAngleDeg` is the bearing *to* the camera, so the view looks along its opposite — reading
   * the orbit rather than the player's facing is what keeps the mouse from twitching the framing.
   */
  tick(from: Pos3, camera: TopDownCamera): void {
    if (getCameraMode() !== 'auto') return;
    const openness = measureOpenness(this.world, from, camera.viewerAngleDeg + 180);
    this.smoothedSpread = this.damp(this.smoothedSpread, openness.spread, OPENNESS_SMOOTH_RATE, OPENNESS_SNAP_EPS);
    this.smoothedAhead = this.damp(this.smoothedAhead, openness.ahead, OPENNESS_SMOOTH_RATE, OPENNESS_SNAP_EPS);

    // Everything below is a pure function of the place, the yaw and the two smoothed opennesses —
    // never of the pose the camera is gliding through, which is what keeps it from hunting.
    // docs/camera.md § The buried-eye rescue.
    const open = this.mapDistance();
    const mappedTilt = this.mapTilt();
    const look = { tiltDeg: mappedTilt, yawDeg: camera.yawDeg, distance: open };
    // Just inside whatever stands in the way, and no nearer than the floor.
    const inside = nearestObstruction(this.world, from, look, this.transfers) - OCCLUDER_STANDOFF;
    const wanted = Math.max(AUTO_OCCLUDED_DISTANCE, Math.min(open, inside));
    // The cap above is deliberately *not* re-measured through the lean: it decides how near the
    // camera comes and the lean rides on the answer, or a few degrees of lean would quietly widen
    // the framing the cap chose.
    const baseTilt = Math.min(MAX_TILT_DEG, mappedTilt + nearTiltLean(wanted));

    // The rescue may not go past an occluder the framing just came inside of, nor past the widest
    // framing the openness mapping would pick on its own.
    const limit = Math.min(AUTO_WIDE_DISTANCE, inside);
    const ask = { mappedTilt: baseTilt, yawDeg: camera.yawDeg, wanted, limit };
    rescueFraming(this.world, from, ask, this.rescue);
    const corrected = this.rescue.distance;
    const wantedShift = this.rescue.tiltDeg - mappedTilt;
    // `displaced` is deliberately narrower than `rescuing`, which counts a tilt-only rescue too:
    // that one picks the lean's rate, `displaced` the framing's.
    const displaced = corrected !== wanted;
    const rescuing = displaced || this.rescue.tiltDeg !== baseTilt;
    const shiftRate = rescuing ? CLEARANCE_IN_RATE : OPENNESS_SMOOTH_RATE;
    this.smoothedTiltShift = this.damp(this.smoothedTiltShift, wantedShift, shiftRate, CLEARANCE_SNAP_EPS);
    // Escaping a burial is urgent — the eye is inside the ground *now* — while the rest breathes
    // at the openness dials' rate.
    const framingRate = displaced ? CLEARANCE_IN_RATE : OPENNESS_SMOOTH_RATE;
    this.smoothedFraming = this.damp(this.smoothedFraming, corrected, framingRate, CLEARANCE_SNAP_EPS);
    const framed = this.smoothedFraming;

    // The plain inward clamp, for the tics the search is not steering: while it owns a burial its
    // answer stands, so the two never fight over one.
    const allowed = displaced ? corrected : measureClearance(this.world, from, baseTilt, camera.yawDeg, framed);
    const rate = allowed < this.smoothedClearance || displaced ? CLEARANCE_IN_RATE : CLEARANCE_OUT_RATE;
    this.smoothedClearance = this.damp(this.smoothedClearance, allowed, rate, CLEARANCE_SNAP_EPS);

    this.initialised = true;
    camera.autoDistance = Math.min(framed, this.smoothedClearance);
    camera.targetTiltDeg = mappedTilt + this.smoothedTiltShift;
  }

  /**
   * One smoothed dial, seeded rather than damped on the first tic — a level switched to auto
   * mid-level was never seeded, and every dial has to jump to its measurement rather than glide up
   * from zero. Every damper in `tick` goes through here, so none can skip the guard.
   */
  private damp(current: number, target: number, rate: number, eps: number): number {
    return this.initialised ? dampen(current, target, rate, DOOM_TIC, eps) : target;
  }

  // Both endpoint pairs sit inside the camera's own envelope, which clamps.
  private mapDistance(): number {
    return AUTO_NARROW_DISTANCE + (AUTO_WIDE_DISTANCE - AUTO_NARROW_DISTANCE) * this.smoothedSpread;
  }

  private mapTilt(): number {
    return AUTO_NARROW_TILT + (AUTO_WIDE_TILT - AUTO_NARROW_TILT) * this.smoothedAhead;
  }
}

function readStoredCameraMode(): CameraMode {
  const stored = readStorage(CAMERA_MODE_STORAGE_KEY, 'auto');
  return CAMERA_MODES.find((m) => m === stored) ?? 'auto';
}

function traceRay(i: number): void {
  const ends = rayWorld.lineOverlapEnds;
  const e = i * 4;
  const t = segmentCrossT(rayX, rayY, rayToX, rayToY, ends[e], ends[e + 1], ends[e + 2], ends[e + 3]);
  if (t < 0 || t >= rayNearestT) return;
  if (!blocksProbe(i)) return;
  rayNearestT = t;
}

/**
 * Whether this line ends the ray: its opening has to straddle the eye, so a ledge the player cannot
 * see over bounds the measurement. Deliberately not `World.blocksSight`, which is height-blind.
 * docs/camera.md § Auto camera.
 */
function blocksProbe(i: number): boolean {
  if (!rayWorld.openingInto(i, rayOpening)) return true;
  return rayOpening.bottom >= rayEyeZ || rayOpening.top <= rayEyeZ;
}

/** Maps a clear distance onto 0..1 through its aggregate's shut-in/wide-open window. */
function toOpenness(distance: number, near: number, far: number): number {
  return Math.min(1, Math.max(0, (distance - near) / (far - near)));
}

/**
 * Whether this line has geometry *drawn across* height `h`, **facing the camera**, and standing up
 * to the eye — together, whether it can hide the player, which is not whether it blocks anything in
 * the world. Which quads exist and how tall they stand is `mapmesh.ts`'s `twoSidedBands` to decide,
 * never this; height is `standsOver`'s half. All three tests, and why facing is the one easily left
 * out: docs/camera.md § Framing past an occluder.
 */
function hidesFromCamera(i: number, h: number, cameraSide: number): boolean {
  const map = rayWorld.map;
  const line = map.linedefs[i];
  if (!line) return false;
  const facing = cameraSide === 0 ? line.right : line.left;
  if (facing === NO_SIDE) return false; // nothing drawn on the side the camera is on
  const side = map.sidedefs[facing];
  const nearIndex = side?.sector;
  const near = map.sectors[nearIndex];
  if (!side || !near) return false;
  const otherSide = cameraSide === 0 ? line.left : line.right;
  const farIndex = otherSide !== NO_SIDE ? map.sidedefs[otherSide]?.sector : undefined;
  const far = farIndex !== undefined ? map.sectors[farIndex] : undefined;
  // One-sided: the whole wall, from the drawn floor `processLine` stands it on
  // (a 242 fake floor moves it) up to the ceiling.
  if (!far || farIndex === undefined) return standsOver(rayTransfers.drawnFloor(nearIndex), near.ceilHeight, h);

  twoSidedBands(map, rayTransfers, nearIndex, farIndex, side.upper, rayBands);
  if (standsOver(rayBands.lowerBot, rayBands.lowerTop, h)) return true;
  // Two sky ceilings and a ceiling trim both draw no upper, so neither hides anything.
  if (rayBands.skyPair || rayBands.upperTrimmed) return false;
  return standsOver(rayBands.upperBot, rayBands.upperTop, h);
}

/**
 * Whether a band drawn from `bottom` to `top` is one the camera has to be got in front of: it has
 * to cross the sightline at `h` *and* reach to within `OCCLUDER_HEADROOM` of the eye.
 * docs/camera.md § Framing past an occluder.
 */
function standsOver(bottom: number, top: number, h: number): boolean {
  return h > bottom && h < top && top > rayTopLimit;
}

/** The occlusion ray's visitor, `traceRay`'s twin: same traversal, a different question. */
function traceObstruction(i: number): void {
  const ends = rayWorld.lineOverlapEnds;
  const e = i * 4;
  const t = segmentCrossT(rayX, rayY, rayToX, rayToY, ends[e], ends[e + 1], ends[e + 2], ends[e + 3]);
  if (t < 0 || t >= rayNearestT) return;
  if (!hidesFromCamera(i, rayEyeZ + rayRise * t, rayWorld.pointOnLineSide(rayToX, rayToY, i))) return;
  rayNearestT = t;
}

/**
 * The DOOM-space mirror of `render/camera.ts`'s `applyToCamera`, and it must stay one: where the
 * two part company the probes answer for a pose the camera never takes.
 */
function eyeDirection(tiltDeg: number, yawDeg: number): void {
  const tilt = (tiltDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const horiz = sin(tilt);
  eyeDirX = horiz * sin(yaw);
  eyeDirY = -horiz * cos(yaw);
  eyeDirZ = cos(tilt);
}

/**
 * Whether a camera eye here would sit inside drawn ground rather than above it — floor heights
 * alone, read live. Why only floors, and the known gap on void solids: docs/camera.md § The
 * buried-eye rescue.
 */
function eyeBuried(world: World, x: number, y: number, h: number): boolean {
  const sector = world.sectorAt(x, y);
  return sector !== undefined && h < sector.floorHeight + CLEARANCE_MARGIN;
}

/** Whether a camera eye at framing `d` along `tiltDeg`/`yawDeg` would sit inside drawn ground. */
function framingBuried(world: World, from: Pos3, tiltDeg: number, yawDeg: number, d: number): boolean {
  eyeDirection(tiltDeg, yawDeg);
  return eyeBuried(world, from.x + eyeDirX * d, from.y + eyeDirY * d, from.z + EYE_HEIGHT + eyeDirZ * d);
}

/**
 * The k-th offset of the alternating walk 0, −step, +step, −2·step, … — `|offset|` never decreases.
 */
function walkOffset(k: number, step: number): number {
  const ring = (k + 1) >> 1;
  return k % 2 === 0 ? ring * step : -ring * step;
}
