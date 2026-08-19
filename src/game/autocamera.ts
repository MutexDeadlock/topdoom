/**
 * The auto camera: measures how open the space around the player is with a fan
 * of sight rays each tic and glides the camera's zoom/tilt between a narrow and
 * a wide framing accordingly — the zoom from the whole fan, the tilt from the
 * part of it the camera is looking into. Also owns the "Camera mode" menu
 * setting that switches it off. See docs/render.md § Auto camera.
 */
import { DOOM_TIC } from '../constants.ts';
import type { TopDownCamera } from '../render/camera.ts';
import type { Pos3 } from '../types.ts';
import { dampen } from '../util/damping.ts';
import { segmentCrossT } from '../util/geom.ts';
import { EYE_HEIGHT } from './player.ts';
import type { Opening, World } from './world.ts';

/** Which camera mode is active — a menu setting, see docs/menu.md § Persisted settings. */
export type CameraMode = 'auto' | 'manual';

const CAMERA_MODE_STORAGE_KEY = 'topdoom.cameraMode';
const CAMERA_MODES: readonly CameraMode[] = ['auto', 'manual'];

/**
 * The camera mode. Module-level for the same reason `input.ts`'s
 * `rightMouseAction` is: a preference set from the menu's Settings tab that
 * must apply immediately mid-level, while the `AutoCamera` reading it is
 * recreated every map load.
 */
let cameraMode: CameraMode = readStoredCameraMode();

function readStoredCameraMode(): CameraMode {
  const stored = globalThis.localStorage?.getItem(CAMERA_MODE_STORAGE_KEY);
  return CAMERA_MODES.find((m) => m === stored) ?? 'auto';
}

export function getCameraMode(): CameraMode {
  return cameraMode;
}

export function setCameraMode(mode: CameraMode): void {
  cameraMode = mode;
  globalThis.localStorage?.setItem(CAMERA_MODE_STORAGE_KEY, mode);
}

// The framing endpoints the two smoothed opennesses lerp between — all tuned
// by feel; the distance pair rides `spread`, the tilt pair `ahead`. The
// 480u/60° constructor defaults in render/camera.ts are manual mode's framing
// and deliberately don't lie at any one shared openness.
const AUTO_NARROW_DISTANCE = 350;
const AUTO_WIDE_DISTANCE = 720;
const AUTO_NARROW_TILT = 50;
const AUTO_WIDE_TILT = 70;

/** The probe fan: ray count and per-ray reach in map units — tuned by feel. */
const OPENNESS_RAY_COUNT = 24;
const OPENNESS_RANGE = 1280;

/**
 * Clear distances that count as fully shut-in / fully open — tuned by feel.
 * The two aggregates need their own windows because they are different
 * statistics. docs/render.md § Auto camera.
 */
const SPREAD_NEAR = 64;
const SPREAD_FAR = 400;
const AHEAD_NEAR = 128;
const AHEAD_FAR = 640;

/** How fast the smoothed openness follows a measurement, 1/seconds — tuned by feel (the ~1 s "breathing" dial). */
const OPENNESS_SMOOTH_RATE = 1.5;
/** Snap epsilon for the openness damper — tuned by feel (imperceptible). */
const OPENNESS_SNAP_EPS = 1e-3;

/**
 * The fan's unit vectors, fixed in **world space** (every 15°) — a Q/E orbit
 * rotates the `ahead` weights, never the rays. docs/render.md § Auto camera.
 */
const RAY_DIRS: readonly { dx: number; dy: number }[] = Array.from({ length: OPENNESS_RAY_COUNT }, (_, i) => {
  const angle = (i / OPENNESS_RAY_COUNT) * Math.PI * 2;
  return { dx: Math.cos(angle), dy: Math.sin(angle) };
});

/** Per-ray clear distances, reused across measurements so a tic allocates nothing. */
const clearances = new Float64Array(OPENNESS_RAY_COUNT);

/**
 * The ray currently being traced, and one bound visitor over it rather than a
 * closure per ray — `fogofwar.ts`'s `testBlocker` does the same for the same
 * reason. `measureOpenness` is not reentrant, which is what lets this be module
 * scratch.
 */
let rayWorld!: World;
let rayX = 0;
let rayY = 0;
let rayToX = 0;
let rayToY = 0;
let rayEyeZ = 0;
let rayNearestT = 1;
const rayOpening: Opening = { top: 0, bottom: 0 };

function traceRay(i: number): void {
  const ends = rayWorld.lineOverlapEnds;
  const e = i * 4;
  const t = segmentCrossT(rayX, rayY, rayToX, rayToY, ends[e], ends[e + 1], ends[e + 2], ends[e + 3]);
  if (t < 0 || t >= rayNearestT) return;
  if (!blocksProbe(i)) return;
  rayNearestT = t;
}

/**
 * Whether this line ends the ray: its opening has to straddle the eye, so a
 * ledge the player cannot see over bounds the measurement even though the
 * space above it is wide open. `World.blocksSight` — the height-blind test the
 * fog of war wants — is deliberately not it. docs/render.md § Auto camera.
 */
function blocksProbe(i: number): boolean {
  if (!rayWorld.openingInto(i, rayOpening)) return true;
  return rayOpening.bottom >= rayEyeZ || rayOpening.top <= rayEyeZ;
}

/**
 * How open a place is, in the two senses the framing needs — both 0 (shut in)
 * to 1 (wide open), and each mapped through its own window.
 * docs/render.md § Auto camera.
 */
export interface Openness {
  /** The median ray: how boxed in the player is, whichever way they look. Drives the zoom. */
  spread: number;
  /** Weighted toward the bearing the camera looks along: how far the view reaches. Drives the tilt. */
  ahead: number;
}

/** Maps a clear distance onto 0..1 through its aggregate's shut-in/wide-open window. */
function toOpenness(distance: number, near: number, far: number): number {
  return Math.min(1, Math.max(0, (distance - near) / (far - near)));
}

/**
 * How open the space around `from` is, looking along `viewDeg` (DOOM-space
 * degrees, the bearing the camera looks into). Each fan ray is traced from the
 * player's eye to the nearest line that `blocksProbe` — live sector heights,
 * so a door opening widens the measurement on the next tic.
 * docs/render.md § Auto camera.
 */
export function measureOpenness(world: World, from: Pos3, viewDeg: number): Openness {
  rayWorld = world;
  rayX = from.x;
  rayY = from.y;
  rayEyeZ = from.z + EYE_HEIGHT;
  const viewRad = (viewDeg * Math.PI) / 180;
  const vx = Math.cos(viewRad);
  const vy = Math.sin(viewRad);
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

/**
 * Drives `TopDownCamera.targetDistance`/`targetTiltDeg` from the openness
 * around the player. Runs on the **tic clock only** — the camera's framing is
 * simulation state (the aim ray is cast through it), so it must never advance
 * on the render clock. Constructed per level, like `FogOfWar`.
 */
export class AutoCamera {
  private world: World;
  private smoothedSpread = 0;
  private smoothedAhead = 0;
  private initialised = false;

  constructor(world: World) {
    this.world = world;
  }

  /** The smoothed opennesses currently driving the framing — the DEVMODE readout. */
  get spread(): number {
    return this.smoothedSpread;
  }

  get ahead(): number {
    return this.smoothedAhead;
  }

  /**
   * One unsmoothed measurement that *jumps* the camera straight to its mapped
   * framing — called on level load, after the spawn yaw is set (so `ahead`
   * already looks the way the level opens) and before the follow point's
   * `snapTo`, so a level never opens mid-zoom. `initialised = false` is what
   * makes the `tick` below measure unsmoothed; the jump is `snapFraming`.
   */
  seed(from: Pos3, camera: TopDownCamera): void {
    if (getCameraMode() !== 'auto') return;
    this.initialised = false;
    this.tick(from, camera);
    camera.snapFraming(camera.targetDistance, camera.targetTiltDeg);
  }

  /**
   * One tic: measure, smooth, and retarget the camera's framing. A no-op in
   * manual mode, so callers need not know the mode — the gate lives with the
   * setting's owner, as every other settings-tab preference does.
   *
   * `viewerAngleDeg` is the bearing *to* the camera, so the view looks along
   * its opposite — reading the camera's orbit rather than the player's facing
   * is what keeps the mouse from twitching the framing.
   */
  tick(from: Pos3, camera: TopDownCamera): void {
    if (getCameraMode() !== 'auto') return;
    const openness = measureOpenness(this.world, from, camera.viewerAngleDeg + 180);
    // Unsmoothed until there is something to smooth from: a level loaded in
    // manual mode and switched to auto mid-level was never seeded.
    this.smoothedSpread = this.initialised
      ? dampen(this.smoothedSpread, openness.spread, OPENNESS_SMOOTH_RATE, DOOM_TIC, OPENNESS_SNAP_EPS)
      : openness.spread;
    this.smoothedAhead = this.initialised
      ? dampen(this.smoothedAhead, openness.ahead, OPENNESS_SMOOTH_RATE, DOOM_TIC, OPENNESS_SNAP_EPS)
      : openness.ahead;
    this.initialised = true;
    camera.targetDistance = this.mapDistance();
    camera.targetTiltDeg = this.mapTilt();
  }

  // Both endpoint pairs sit inside the camera's own envelope, which clamps.
  private mapDistance(): number {
    return AUTO_NARROW_DISTANCE + (AUTO_WIDE_DISTANCE - AUTO_NARROW_DISTANCE) * this.smoothedSpread;
  }

  private mapTilt(): number {
    return AUTO_NARROW_TILT + (AUTO_WIDE_TILT - AUTO_NARROW_TILT) * this.smoothedAhead;
  }
}
