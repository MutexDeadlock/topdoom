/**
 * The auto camera: measures how open the space around the player is with a fan
 * of sight rays each tic and glides the camera's zoom/tilt between a narrow and
 * a wide framing accordingly — the zoom from the whole fan, the tilt from the
 * part of it the camera is looking into — then pulls the zoom in when a wall it
 * cannot see over stands across the sightline, and moves it along its own ray,
 * out where that clears and in otherwise, on the rare spot where the framing
 * would bury the camera's eye in the ground. Also owns
 * the "Camera mode" menu setting that switches it off.
 * See docs/camera.md § Auto camera, § Framing past an occluder and § The buried-eye rescue.
 */
import { DOOM_TIC } from '../constants.ts';
import { MAX_CAMERA_DISTANCE, MAX_TILT_DEG, MIN_RESCUE_DISTANCE, type TopDownCamera } from '../render/camera.ts';
import { ownTransfers, twoSidedBands, type DrawnBands, type SectorTransfers } from '../render/mapmesh.ts';
import type { Pos3 } from '../types.ts';
import { dampen } from '../util/damping.ts';
import { segmentCrossT } from '../util/geom.ts';
import { NO_SIDE } from '../wad/map.ts';
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

/** How fast the smoothed openness follows a measurement, 1/seconds — tuned by feel (the ~1 s "breathing" dial). */
const OPENNESS_SMOOTH_RATE = 1.5;
/** Snap epsilon for the openness damper — tuned by feel (imperceptible). */
const OPENNESS_SNAP_EPS = 1e-3;

/**
 * How near the framing will come for an occluder it cannot get in front of —
 * **tuned by feel**, and deliberately nearer than `AUTO_NARROW_DISTANCE`. It is
 * a *floor*, not the answer: the camera backs off only as far as the occluder
 * demands, and stops here when even that is not far enough, because a wall
 * standing right beside the player can never be got in front of and being read
 * through a dither is what is left.
 * docs/camera.md § Framing past an occluder.
 */
export const AUTO_OCCLUDED_DISTANCE = 250;

/**
 * How far above the drawn ground the camera's eye has to stay to count as
 * clear, in map units — tuned by feel. Not zero: an eye scraping the surface
 * sees a plane edge-on through an 8-unit near plane, which reads no better than
 * being under it.
 */
const CLEARANCE_MARGIN = 32;

/**
 * How far short of an occluder the framing stops on the sightline, in map units
 * — **tuned by feel**. Its own dial rather than `CLEARANCE_MARGIN`, which the
 * two happen to share a value with: that one is a *vertical* clearance above
 * drawn ground, this one a *horizontal* stand-off along the ray, and retuning
 * either has no business moving the other.
 */
const OCCLUDER_STANDOFF = 32;

/**
 * How far the camera's eye has to clear an occluder's top before the framing
 * stops counting it, in map units — **tuned by feel**. Not zero, and not the
 * margin above: a wall whose top the eye only just clears is seen along its
 * face at a grazing angle and covers most of the way to the player, which is
 * the one shape the fade's fixed-size hole cannot dissolve enough of. Well over
 * it and the wall is seen from above, covers little, and the fade has it.
 * docs/camera.md § Framing past an occluder.
 */
const OCCLUDER_HEADROOM = 64;

/**
 * How far apart the rescue tries candidate distances while backing off, in map
 * units — tuned by feel. Finer buys nothing: the framing damper glides through
 * whatever this lands on rather than cutting to it.
 */
const CLEARANCE_STEP = 24;

/**
 * How fast the clearance clamp closes in and eases back out, 1/seconds — both
 * tuned by feel, and deliberately asymmetric. Closing has to beat the player
 * walking into the spot; opening is the same unhurried ~1 s as the openness
 * dials, so a candidate grazing a step edge for a tic or two barely shows.
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
 * fog of war wants — is deliberately not it. docs/camera.md § Auto camera.
 */
function blocksProbe(i: number): boolean {
  if (!rayWorld.openingInto(i, rayOpening)) return true;
  return rayOpening.bottom >= rayEyeZ || rayOpening.top <= rayEyeZ;
}

/**
 * How open a place is, in the two senses the framing needs — both 0 (shut in)
 * to 1 (wide open), and each mapped through its own window.
 * docs/camera.md § Auto camera.
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
 * docs/camera.md § Auto camera.
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

/** How far the occlusion ray climbs over its length — its one extra piece of state. */
let rayRise = 0;
/** The height an occluder has to reach for the camera not to be looking over it — see `standsOver`. */
let rayTopLimit = 0;
/**
 * The level's render transfers, and one scratch record for the bands they
 * resolve — module scratch alongside the ray, for the same reason: the trace is
 * not reentrant and a visitor per line would allocate.
 */
let rayTransfers!: SectorTransfers;
const rayBands: DrawnBands = { lowerBot: 0, lowerTop: 0, upperBot: 0, upperTop: 0, skyPair: false };

/**
 * Whether this line has geometry *drawn across* height `h`, **facing the
 * camera**, and **standing up to the eye** — which together decide whether it
 * can hide the player, a different question from whether it blocks anything in
 * the world.
 *
 * Facing is the half that is easy to miss. Wall materials are
 * `THREE.FrontSide` (`render/textures.ts`), and `addWall` hangs each quad on
 * one sidedef, so a wall is drawn for the side it belongs to and simply is not
 * there from behind: the room's own wall between the player and a camera
 * hanging outside it hides nothing, because what faces the camera is its
 * missing back. Which quads exist and how tall they stand is *not* decided
 * here: `mapmesh.ts`'s `twoSidedBands` is the one owner of that rule, so a
 * Boom 242 moving a drawn floor or ceiling moves what the camera counts too.
 * Ceilings are never emitted, so nothing above the top of a wall can hide
 * anything. Live sector heights, so a door or lift needs no special case.
 * Height is the other half, and `standsOver` owns it.
 * docs/camera.md § Framing past an occluder.
 */
function hidesFromCamera(i: number, h: number, cameraSide: number): boolean {
  const map = rayWorld.map;
  const line = map.linedefs[i];
  if (!line) return false;
  const facing = cameraSide === 0 ? line.right : line.left;
  if (facing === NO_SIDE) return false; // nothing drawn on the side the camera is on
  const nearIndex = map.sidedefs[facing]?.sector;
  const near = map.sectors[nearIndex];
  if (!near) return false;
  const otherSide = cameraSide === 0 ? line.left : line.right;
  const farIndex = otherSide !== NO_SIDE ? map.sidedefs[otherSide]?.sector : undefined;
  const far = farIndex !== undefined ? map.sectors[farIndex] : undefined;
  // One-sided: the whole wall, from the drawn floor `processLine` stands it on
  // (a 242 fake floor moves it) up to the ceiling.
  if (!far || farIndex === undefined) return standsOver(rayTransfers.drawnFloor(nearIndex), near.ceilHeight, h);

  twoSidedBands(rayTransfers, near, nearIndex, far, farIndex, rayBands);
  if (standsOver(rayBands.lowerBot, rayBands.lowerTop, h)) return true;
  if (rayBands.skyPair) return false;
  return standsOver(rayBands.upperBot, rayBands.upperTop, h);
}

/**
 * Whether a band drawn from `bottom` to `top` is one the camera has to be got
 * in front of: it has to cross the sightline at `h` **and** reach up to within
 * `OCCLUDER_HEADROOM` of the eye, so a wall the camera hangs well over is not
 * one — the fade dissolves that one comfortably, and the framing is worth more
 * than the dissolve. docs/camera.md § Framing past an occluder.
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
 * The unit direction from the player's eye toward the camera's for a framing,
 * written into module scratch so a tic allocates nothing. Every probe here
 * places an eye at `playerEye + d * dir`, so all three read the orbit from
 * this one place.
 *
 * The DOOM-space mirror of `render/camera.ts`'s `applyToCamera`, which is where
 * the camera actually ends up: the two have to agree, or the probes answer for
 * a pose the camera never takes.
 */
let eyeDirX = 0;
let eyeDirY = 0;
let eyeDirZ = 0;
function eyeDirection(tiltDeg: number, yawDeg: number): void {
  const tilt = (tiltDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const horiz = Math.sin(tilt);
  eyeDirX = horiz * Math.sin(yaw);
  eyeDirY = -horiz * Math.cos(yaw);
  eyeDirZ = Math.cos(tilt);
}

/**
 * How far out the nearest thing drawn *facing the camera* and standing up to
 * its eye is on the sightline, in map units — `Infinity` when nothing does
 * within `distance`, which is the ordinary case.
 *
 * One ray answers it for every framing at once, and the answer is a distance
 * rather than a verdict for the same reason: the eye at distance `d` is
 * `playerEye + d * u` for the direction this framing gives, so the sightline to
 * a camera at `d` is exactly the first `d` of this one ray — which makes
 * "blocked at `d`" the same statement as "`d` is past what this returns", and
 * the camera need only come inside it rather than all the way in.
 * docs/camera.md § Framing past an occluder.
 */
export function nearestObstruction(
  world: World,
  from: Pos3,
  tiltDeg: number,
  yawDeg: number,
  distance: number,
  transfers?: SectorTransfers,
): number {
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
 * Whether a camera eye here would sit inside drawn ground rather than above it.
 *
 * Ceilings are never emitted (`render/mapmesh.ts`'s `renderCeilings`), so a
 * camera hanging over a room's ceiling sees straight in and a wall between it
 * and the player is the occlusion fade's job, not this one's — being *under a
 * floor* is the one case no fade can undo, because what buries the eye is the
 * ground it is looking through from below. Live sector heights, so a lift
 * rising into the camera reads on the next tic.
 *
 * Known gap: a void solid drawn as a cap (`render/solids.ts`) has no sector to
 * read a floor from, so an eye inside a pillar is not caught.
 * docs/camera.md § The buried-eye rescue.
 */
function eyeBuried(world: World, x: number, y: number, h: number): boolean {
  const sector = world.sectorAt(x, y);
  return sector !== undefined && h < sector.floorHeight + CLEARANCE_MARGIN;
}

/**
 * The furthest the camera may hang back along `tiltDeg`/`yawDeg` without its
 * eye ending up buried — `wanted` itself whenever that framing is already fine,
 * which is nearly always.
 *
 * Only one ray of candidates has to be tried: the eye at distance `d` is
 * `playerEye + d * u` for the direction this framing gives, so backing off is a
 * walk down that one ray and the first clear step is the answer.
 * docs/camera.md § The buried-eye rescue.
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
 * How coarsely the buried-eye rescue searches tilts, in degrees — tuned by
 * feel, and the twin of `CLEARANCE_STEP` for the other dial. Finer buys
 * nothing: the tilt damper glides through whatever this lands on.
 */
const RESCUE_TILT_STEP = 5;

/**
 * How much further off vertical the framing leans once the zoom has been pulled
 * all the way in to `AUTO_OCCLUDED_DISTANCE`, in degrees — **tuned by feel**. A
 * camera 250 units out at the openness mapping's own tilt looks nearly down the
 * player's back: it shows the ground around them and almost nothing they are
 * walking into. Leaning it over trades some of that ground for reach in front,
 * which is the half a shut-in place actually needs.
 * docs/camera.md § Auto camera.
 */
export const NEAR_TILT_LEAN = 10;

/**
 * How far the framing leans off the mapped tilt at `distance` — nothing at
 * `AUTO_NARROW_DISTANCE` and above, the whole `NEAR_TILT_LEAN` once the zoom is
 * at the occluded floor or nearer. A pure function of the distance, so it adds
 * no state and cannot hunt. docs/camera.md § Auto camera.
 */
export function nearTiltLean(distance: number): number {
  const span = AUTO_NARROW_DISTANCE - AUTO_OCCLUDED_DISTANCE;
  const t = (AUTO_NARROW_DISTANCE - distance) / span;
  return NEAR_TILT_LEAN * Math.min(1, Math.max(0, t));
}

/** Whether a camera eye at framing `d` along `tiltDeg`/`yawDeg` would sit inside drawn ground. */
function framingBuried(world: World, from: Pos3, tiltDeg: number, yawDeg: number, d: number): boolean {
  eyeDirection(tiltDeg, yawDeg);
  return eyeBuried(world, from.x + eyeDirX * d, from.y + eyeDirY * d, from.z + EYE_HEIGHT + eyeDirZ * d);
}

/** A framing the rescue settled on — written into a caller's object, so a tic allocates nothing. */
export interface RescueFraming {
  distance: number;
  tiltDeg: number;
}

/** The k-th offset of the alternating walk 0, −step, +step, −2·step, … — `|offset|` never decreases. */
function walkOffset(k: number, step: number): number {
  const ring = (k + 1) >> 1;
  return k % 2 === 0 ? ring * step : -ring * step;
}

/**
 * The framing **nearest the one the openness dials asked for** whose eye is not
 * buried, searched over *both* dials at once — distance from
 * `MIN_RESCUE_DISTANCE` to `limit`, tilt across the camera's whole envelope.
 * `wanted`/`mappedTilt` themselves whenever they are already clear, which is
 * nearly always.
 *
 * Searching beats moving in one hand-picked direction because which direction
 * even exists is geometry, not taste. Coming *nearer* clears a plateau the
 * camera would otherwise hang over; backing *off* clears the rim of a shaft the
 * player is standing at the bottom of, since the eye rises along its own ray;
 * and changing the tilt trades one against the other, a steeper look needing
 * more distance to reach the same height. Both were tried alone here first and
 * each fixed one map while breaking another.
 *
 * **The tilt half only ever leans further off vertical**, never back toward
 * top-down. Turning overhead is the cheap way to lift a buried eye — it beats
 * any distance change, and an unrestricted search takes it on up to 1.2% of
 * poses and by as much as 45° — but it buys that height by spending exactly
 * what a shut-in framing is already short of: sight of what the player is
 * walking into. It also pulls against `nearTiltLean`, which leans the other way
 * for the same reason. So the rescue leans over or holds, and when neither that
 * nor the distance clears, pulling in is the fallback rather than a plan view.
 *
 * **Nearness weighs a degree against a unit by each dial's own span** — 370
 * units of distance (`AUTO_NARROW_DISTANCE`..`AUTO_WIDE_DISTANCE`) against 20°
 * of tilt (`AUTO_NARROW_TILT`..`AUTO_WIDE_TILT`) — so one full swing of the
 * zoom costs the same as one full swing of the tilt. Those are the ranges the
 * `spread` and `ahead` dials themselves sweep, which is what makes the trade
 * a statement about the framing rather than a tuned number.
 *
 * The walk visits candidates in ascending cost on each axis, so the first hit
 * prunes nearly everything after it and a clear framing costs one lookup.
 * docs/camera.md § The buried-eye rescue.
 */
export function rescueFraming(
  world: World,
  from: Pos3,
  mappedTilt: number,
  yawDeg: number,
  wanted: number,
  limit: number,
  out: RescueFraming,
): void {
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
 * How far the occluder clamp has to pull the zoom in before `autoCameraReadout`
 * prints it, in map units — **tuned by feel**, and a readout threshold only:
 * nothing about the framing reads it. `occl` bites a little on an ordinary
 * doorway several times a room, and a line that prints constantly says nothing.
 */
const OCCL_READOUT_SLACK = 100;

/**
 * The auto camera's own DEVMODE line, the one consumer of the readout getters
 * below: the two openness dials, then only a clamp that is genuinely reshaping
 * the zoom they ask for — `Game.debugLines`' `cam` line already says where they
 * landed. `occl` bites a little on an ordinary doorway several times a room, so
 * it only prints past a threshold worth noticing; `raised`, `tilt` and `buried`
 * are the buried-eye rescue's own moves and print whenever it makes one at all.
 * See docs/camera.md § Auto camera.
 */
export function autoCameraReadout(auto: AutoCamera): string {
  const open = auto.openFraming;
  const framed = Math.min(open, auto.occluded);
  const occluded = auto.occluded < open - OCCL_READOUT_SLACK ? ` occl ${auto.occluded.toFixed(0)}u` : '';
  // A unit of slack, so a damper still gliding the last fraction of a unit
  // into place does not flicker the readout on and off.
  const raised = auto.occluded > open + 1 ? ` raised ${auto.occluded.toFixed(0)}u` : '';
  const buried = auto.clearance < framed - 1 ? ` buried ${auto.clearance.toFixed(0)}u` : '';
  const shift = Math.abs(auto.tiltShift) >= 1 ? ` tilt ${auto.tiltShift > 0 ? '+' : ''}${auto.tiltShift.toFixed(0)}°` : '';
  return `auto spread ${auto.spread.toFixed(2)} ahead ${auto.ahead.toFixed(2)}${occluded}${raised}${shift}${buried}`;
}

/**
 * Drives `TopDownCamera.targetDistance`/`targetTiltDeg` from the openness
 * around the player. Runs on the **tic clock only** — the camera's framing is
 * simulation state (the aim ray is cast through it), so it must never advance
 * on the render clock. Constructed per level, like `FogOfWar`.
 */
export class AutoCamera {
  private world: World;
  /**
   * The level's render transfers, so the occlusion trace counts the bands the
   * mesh actually drew (`twoSidedBands`). Omitted means every sector draws
   * itself — the same default the mesh builder takes.
   */
  private transfers: SectorTransfers;
  private smoothedSpread = 0;
  private smoothedAhead = 0;
  private smoothedClearance = MAX_CAMERA_DISTANCE;
  /** The zoom the occluder leaves — or the buried-eye rescue asks for — in map units. Damped, so a doorjamb in passing cannot pop it. */
  private smoothedFraming = MAX_CAMERA_DISTANCE;
  /** How far the buried-eye rescue is shifting the tilt off the mapped one, in degrees — damped like the clearance. */
  private smoothedTiltShift = 0;
  /** The rescue's answer, reused so a tic allocates nothing. */
  private rescue: RescueFraming = { distance: 0, tiltDeg: 0 };
  private initialised = false;

  constructor(world: World, transfers?: SectorTransfers) {
    this.world = world;
    this.transfers = transfers ?? ownTransfers(world.map);
  }

  /** The smoothed opennesses currently driving the framing — the DEVMODE readout. */
  get spread(): number {
    return this.smoothedSpread;
  }

  get ahead(): number {
    return this.smoothedAhead;
  }

  /**
   * The zoom the openness alone asks for, in map units — the baseline the
   * DEVMODE readout decides against, so a clamp shows only when it is really
   * taking something off.
   */
  get openFraming(): number {
    return this.mapDistance();
  }

  /** The framing after the occluder cap and the outward rescue, in map units — the DEVMODE readout. */
  get occluded(): number {
    return this.smoothedFraming;
  }

  /** How far the buried-eye rescue is currently shifting the tilt, in degrees — the DEVMODE readout. */
  get tiltShift(): number {
    return this.smoothedTiltShift;
  }

  /** The smoothed clearance currently capping the zoom, in map units — the DEVMODE readout. */
  get clearance(): number {
    return this.smoothedClearance;
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
   * One tic: measure, smooth, and retarget the camera's framing, then cap the
   * zoom at what the occluder and the buried-eye rescue leave. A no-op in manual mode, so
   * callers need not know the mode — the gate lives with the setting's owner, as
   * every other settings-tab preference does.
   *
   * `viewerAngleDeg` is the bearing *to* the camera, so the view looks along
   * its opposite — reading the camera's orbit rather than the player's facing
   * is what keeps the mouse from twitching the framing.
   */
  tick(from: Pos3, camera: TopDownCamera): void {
    if (getCameraMode() !== 'auto') return;
    const openness = measureOpenness(this.world, from, camera.viewerAngleDeg + 180);
    this.smoothedSpread = this.damp(this.smoothedSpread, openness.spread, OPENNESS_SMOOTH_RATE, OPENNESS_SNAP_EPS);
    this.smoothedAhead = this.damp(this.smoothedAhead, openness.ahead, OPENNESS_SMOOTH_RATE, OPENNESS_SNAP_EPS);

    // Everything below is a pure function of the place, the yaw and the two
    // smoothed opennesses — never of the tilt or distance the camera is
    // currently gliding through. That is what keeps it from hunting: the
    // rescue steers the tilt, so a rule that read the live tilt back would
    // close a loop around a step function. docs/camera.md § Auto camera.
    const open = this.mapDistance();
    const mappedTilt = this.mapTilt();
    // Just inside whatever stands in the way, and no nearer than the floor —
    // a wall half a level off costs the framing almost nothing, one at the
    // player's shoulder costs it everything.
    const inside =
      nearestObstruction(this.world, from, mappedTilt, camera.yawDeg, open, this.transfers) - OCCLUDER_STANDOFF;
    const wanted = Math.max(AUTO_OCCLUDED_DISTANCE, Math.min(open, inside));
    // A framing pulled in to the floor leans further over, so the view reaches
    // in front of the player rather than straight down at them. The cap above
    // is deliberately *not* re-measured through the lean: it decides how near
    // the camera comes, the lean rides on the answer, and re-tracing through it
    // would let a few degrees of lean quietly widen the framing the cap chose.
    const baseTilt = Math.min(MAX_TILT_DEG, mappedTilt + nearTiltLean(wanted));

    // When the framing's eye would end up under a floor, the rescue searches
    // both dials for the nearest framing that clears — nearer, further out, or
    // at a different tilt, whichever the geometry actually offers. Never past
    // an occluder the framing just came inside of, and never past the widest
    // framing the openness mapping itself would pick.
    const limit = Math.min(AUTO_WIDE_DISTANCE, inside);
    rescueFraming(this.world, from, baseTilt, camera.yawDeg, wanted, limit, this.rescue);
    const corrected = this.rescue.distance;
    const wantedShift = this.rescue.tiltDeg - mappedTilt;
    // The lean breathes with the openness dials it rides on; only a real
    // burial, where the eye is inside the ground *now*, snaps.
    // Whether the search moved the *distance* off what the dials asked for.
    // Deliberately narrower than `rescuing` below, which counts a tilt-only
    // rescue too: that one picks the lean's rate, these three the framing's.
    const displaced = corrected !== wanted;
    const rescuing = displaced || this.rescue.tiltDeg !== baseTilt;
    const shiftRate = rescuing ? CLEARANCE_IN_RATE : OPENNESS_SMOOTH_RATE;
    this.smoothedTiltShift = this.damp(this.smoothedTiltShift, wantedShift, shiftRate, CLEARANCE_SNAP_EPS);
    // Escaping a burial is urgent (the eye is inside the ground *now*), the
    // rest breathes at the openness dials' own rate: stepping on and off a
    // sightline is abrupt, and the framing has to glide through it, not step.
    const framingRate = displaced ? CLEARANCE_IN_RATE : OPENNESS_SMOOTH_RATE;
    this.smoothedFraming = this.damp(this.smoothedFraming, corrected, framingRate, CLEARANCE_SNAP_EPS);
    const framed = this.smoothedFraming;

    // The plain inward clamp, for the tics the search is not steering: while it
    // owns a burial its own answer stands, so the two never fight over one.
    const allowed = displaced ? corrected : measureClearance(this.world, from, baseTilt, camera.yawDeg, framed);
    const rate = allowed < this.smoothedClearance || displaced ? CLEARANCE_IN_RATE : CLEARANCE_OUT_RATE;
    this.smoothedClearance = this.damp(this.smoothedClearance, allowed, rate, CLEARANCE_SNAP_EPS);

    this.initialised = true;
    camera.autoDistance = Math.min(framed, this.smoothedClearance);
    camera.targetTiltDeg = mappedTilt + this.smoothedTiltShift;
  }

  /**
   * One smoothed dial, seeded rather than damped on the first tic: a level
   * loaded in manual mode and switched to auto mid-level was never seeded, and
   * every dial here has to jump to its measurement instead of gliding up from
   * zero. Every damper in `tick` goes through this, so none can be added
   * without the guard.
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
