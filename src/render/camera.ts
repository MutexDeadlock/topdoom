/**
 * `TopDownCamera`: the tilted overhead camera — follow smoothing, aim lead, and the Q/E orbit.
 * See docs/camera.md § Camera orbit and camera-relative movement, and § The camera is simulation
 * state.
 */
import * as THREE from 'three';
import type { Input } from '../game/input.ts';
import type { Pos2, Pos3 } from '../types.ts';
import { VIEW_DISTANCE } from '../constants.ts';
import { dampen } from '../util/damping.ts';

export interface TopDownCameraOptions {
  /** Tilt away from straight down, in degrees. Small values stay top-down. */
  tiltDeg?: number;
  /** Distance from the point being followed, in map units. */
  distance?: number;
  /** How far the view leads towards the cursor, 0..1. */
  aimLead?: number;
  /** Orbit around the target, in degrees. 0 keeps the camera due south. */
  yawDeg?: number;
}

/** How fast `yawDeg` catches up to a `stepYaw` target, as a lerp-per-second rate. */
const YAW_STEP_SMOOTH_RATE = 18;

/**
 * How fast `distance`/`tiltDeg` catch up to their targets, as a lerp-per-second
 * rate — tuned by feel. Deliberately fast: the slow "breathing" of the auto
 * camera lives in its own openness smoothing (game/autocamera.ts), so this only
 * has to make target changes read as motion rather than steps.
 */
const FRAMING_SMOOTH_RATE = 10;
/** Snap epsilons for the framing dampers, in map units / degrees — tuned by feel (imperceptible). */
const DISTANCE_SNAP_EPS = 0.01;
const TILT_SNAP_EPS = 0.001;

/**
 * The hard zoom/tilt envelope — all four tuned by feel. Enforced here, by both
 * framing setters, rather than by each writer: the manual keys and the auto
 * camera would otherwise each have to remember it. docs/camera.md § Auto camera.
 */
export const MIN_CAMERA_DISTANCE = 200;
export const MAX_CAMERA_DISTANCE = 2400;
export const MIN_TILT_DEG = 10;
export const MAX_TILT_DEG = 70;

/**
 * The floor the auto camera's own route clamps to instead — tuned by feel. Its
 * buried-eye rescue has to duck under any distance a player would dial by hand,
 * because geometry, not taste, is what asks for it.
 * docs/camera.md § The buried-eye rescue.
 */
export const MIN_RESCUE_DISTANCE = 64;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Degrees Q/E snap the camera per press. */
const KEY_YAW_STEP = 45;
/** Seconds between auto-repeated Q/E steps while the key stays held, after the initial tap. */
const KEY_YAW_REPEAT_INTERVAL = 0.26;

/**
 * A camera hanging above the player, tilted slightly off vertical so walls
 * show a bit of their height and the level reads as a space rather than a plan.
 * `yawDeg` lets it orbit around the followed point (Q/E, see `applyYawInput`)
 * so geometry facing away from the default south view stays reachable.
 *
 * **This camera's follow point, yaw and framing (distance/tilt) are simulation
 * state, not view state**,
 * and advance in `tick` on the tic clock; `applyToCamera` interpolates them into
 * the actual `THREE` camera for display. That split is forced rather than
 * stylistic: the pointer ray is cast through this camera, and the ray decides
 * both `Player.angle` and the basis WASD moves along — so a render-smoothed
 * pose would make aim and movement direction depend on framerate.
 * docs/camera.md § The camera is simulation state.
 */
export class TopDownCamera {
  readonly camera: THREE.PerspectiveCamera;
  aimLead: number;

  private _tiltDeg: number;
  private _distance: number;
  /**
   * Where `distance`/`tiltDeg` are animating towards — the framing twin of
   * `stepYaw`'s target. Written every tic by the auto camera, or by the manual
   * framing keys; a plain `distance`/`tiltDeg` assignment jumps instead.
   */
  private _targetDistance: number;
  private _targetTiltDeg: number;

  private _yawDeg: number;
  /** Where `yawDeg` is animating towards — see `stepYaw`. Equal to `_yawDeg` outside of a Q/E snap. */
  private targetYawDeg: number;

  private target = new THREE.Vector3();
  private smoothed = new THREE.Vector3();
  /** Last tic's `smoothed`/`_yawDeg`/`_distance`/`_tiltDeg`, the interpolation source for `applyToCamera`. */
  private prevSmoothed = new THREE.Vector3();
  private prevYawDeg: number;
  private prevDistance: number;
  private prevTiltDeg: number;
  private initialised = false;
  /** Seconds Q/E has been continuously held, for auto-repeat — see `applyYawInput`. */
  private qHoldTime = 0;
  private eHoldTime = 0;
  /** Scratch for `applyToCamera`'s interpolated follow point, so drawing allocates nothing. */
  private viewPoint = new THREE.Vector3();
  /**
   * The view volume at the pose `applyToCamera` last set, rewritten in place every frame — what
   * `DynamicLights` culls its offers against, so an emitter the camera cannot see costs nothing.
   * See docs/lights.md § What reaches the shader.
   */
  readonly viewFrustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  /** The interpolated yaw `applyToCamera` last drew at — see `viewAngleDeg`. */
  private viewYawDeg: number;

  constructor(aspect: number, options: TopDownCameraOptions = {}) {
    this._tiltDeg = clamp(options.tiltDeg ?? 60, MIN_TILT_DEG, MAX_TILT_DEG);
    this._distance = clamp(options.distance ?? 480, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
    this._targetTiltDeg = this._tiltDeg;
    this._targetDistance = this._distance;
    this.prevTiltDeg = this._tiltDeg;
    this.prevDistance = this._distance;
    this.aimLead = options.aimLead ?? 0.18;
    this._yawDeg = options.yawDeg ?? 0;
    this.targetYawDeg = this._yawDeg;
    this.prevYawDeg = this._yawDeg;
    this.viewYawDeg = this._yawDeg;

    // The far plane is `VIEW_DISTANCE` rather than a number of its own: the distance fog is what
    // ends the view, and a far plane below it would clip geometry the fog hasn't hidden yet.
    // docs/render.md § View distance.
    this.camera = new THREE.PerspectiveCamera(55, aspect, 8, VIEW_DISTANCE);
    this.camera.up.set(0, 1, 0);
  }

  /**
   * Orbit angle in degrees, 0 = due south. Assigning it — which only the
   * instant reorient on spawn/teleport does — jumps immediately; `stepYaw` is
   * the only way to animate towards a new value.
   */
  get yawDeg(): number {
    return this._yawDeg;
  }

  set yawDeg(value: number) {
    this._yawDeg = value;
    this.targetYawDeg = value;
    // An instant reorient must not leave a stale previous yaw for the next
    // frame to interpolate out of, or the spawn/teleport snap animates instead.
    this.prevYawDeg = value;
    this.viewYawDeg = value;
  }

  /**
   * Queues a relative yaw change (the Q/E 45° snap) to animate smoothly
   * towards over the next few frames, rather than jumping instantly the way
   * a plain `yawDeg` assignment does.
   */
  stepYaw(deltaDeg: number): void {
    this.targetYawDeg += deltaDeg;
  }

  /** Camera distance from the follow point, in map units. Read-only: `targetDistance` glides, `snapFraming` jumps. */
  get distance(): number {
    return this._distance;
  }

  /** Tilt away from straight down, in degrees. Read-only: `targetTiltDeg` glides, `snapFraming` jumps. */
  get tiltDeg(): number {
    return this._tiltDeg;
  }

  /** Where `distance` is animating towards, clamped to the envelope. */
  get targetDistance(): number {
    return this._targetDistance;
  }

  set targetDistance(value: number) {
    this._targetDistance = clamp(value, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
  }

  /**
   * The auto camera's glide route into the same target — identical to
   * `targetDistance` but floored at `MIN_RESCUE_DISTANCE`, so its buried-eye
   * rescue can pull nearer than the manual keys' envelope allows. Write-only on
   * purpose: `targetDistance` is the one place to read the target from.
   * docs/camera.md § The buried-eye rescue.
   */
  set autoDistance(value: number) {
    this._targetDistance = clamp(value, MIN_RESCUE_DISTANCE, MAX_CAMERA_DISTANCE);
  }

  /** Where `tiltDeg` is animating towards, clamped to the same envelope. */
  get targetTiltDeg(): number {
    return this._targetTiltDeg;
  }

  set targetTiltDeg(value: number) {
    this._targetTiltDeg = clamp(value, MIN_TILT_DEG, MAX_TILT_DEG);
  }

  /**
   * Poses the framing with nothing left to glide — the framing twin of
   * `snapTo`, and the only route that writes value, target and `prev` at once
   * (a mid-glide `prev` would otherwise make `applyToCamera` interpolate out of
   * a stale pose). `AutoCamera.seed` uses it so a level never opens mid-zoom.
   *
   * Being the auto camera's route, it takes `autoDistance`'s lower floor rather
   * than the manual keys' — a level that opens where the framing would bury the
   * eye must seed at the rescued distance, not be clamped straight back off it.
   */
  snapFraming(distance: number, tiltDeg: number): void {
    this.autoDistance = distance;
    this.targetTiltDeg = tiltDeg;
    this._distance = this._targetDistance;
    this._tiltDeg = this._targetTiltDeg;
    this.prevDistance = this._distance;
    this.prevTiltDeg = this._tiltDeg;
  }

  /**
   * Puts the follow point at `pos` with nothing left to catch up on — the
   * position twin of the `yawDeg` setter, and the camera's own
   * `Player.syncInterpolation`. This camera outlives the level (it belongs to
   * the `Viewport`), so without it a level load or a save restore leaves the
   * smoother holding the *previous* level's point and the new level opens with
   * the camera flying to the player. Collapses the interpolation window too,
   * and poses the `THREE` camera immediately, since a frame can be drawn
   * before the next `tick` (the pause loop's `stillFrame`, `captureThumbnail`).
   * Set `yawDeg` first if both are being snapped. docs/frameloop.md §
   * Interpolation.
   */
  snapTo(pos: Pos3): void {
    this.setTarget(pos);
    this.smoothed.copy(this.target);
    this.prevSmoothed.copy(this.target);
    this.initialised = true;
    this.applyToCamera(1);
  }

  /** The followed point in three.js space — DOOM's `(x, y, z)` is three's `(x, z, -y)`. */
  private setTarget(pos: Pos3): void {
    this.target.set(pos.x, pos.z, -pos.y);
  }

  /**
   * This frame's orbit input: the Q/E 45° snaps and their auto-repeat.
   * See docs/camera.md § Camera orbit.
   */
  applyYawInput(input: Input, dt: number): void {
    // stepYaw (not a plain assignment) is what makes this animate smoothly instead of
    // snapping. Holding the key auto-repeats the same step every KEY_YAW_REPEAT_INTERVAL,
    // roughly how long one step's smoothing takes to settle, so a hold reads as continuous
    // rotation made of chained 45° steps rather than a single tap.
    this.qHoldTime = input.held('KeyQ') ? this.qHoldTime + dt : 0;
    this.eHoldTime = input.held('KeyE') ? this.eHoldTime + dt : 0;
    if (input.pressed('KeyQ') || this.qHoldTime >= KEY_YAW_REPEAT_INTERVAL) {
      this.stepYaw(KEY_YAW_STEP);
      this.qHoldTime = 0;
    }
    if (input.pressed('KeyE') || this.eHoldTime >= KEY_YAW_REPEAT_INTERVAL) {
      this.stepYaw(-KEY_YAW_STEP);
      this.eHoldTime = 0;
    }
  }

  /**
   * DOOM-space angle (0 = east, 90 = north, CCW) from the followed point to
   * the camera. At yaw=0 this is -90 (due south), matching the sprite system's
   * default viewer angle; see render/sprites.ts's VIEWER_ANGLE_DEG.
   *
   * The **tic-exact** angle: this is the one the simulation reads, since it is
   * the basis WASD movement is rotated into. Billboards want `viewAngleDeg`.
   */
  get viewerAngleDeg(): number {
    return this._yawDeg - 90;
  }

  /**
   * The DOOM-space height the camera is currently pointed at — the eye height
   * it was last given, after follow smoothing, at the pose `applyToCamera` last
   * struck.
   *
   * The aim plane is derived from this rather than from the player's own live
   * `z` (`game.ts`). The two agree once the smoother has caught up, but during
   * a fall they do not, and a plane that moves while the camera lags swings the
   * cursor's world point — and with it the player's facing — for the third of a
   * second it takes to settle. docs/camera.md § Aim lead.
   */
  get followHeight(): number {
    return this.initialised ? this.viewPoint.y : this.smoothed.y;
  }

  /**
   * The followed point in DOOM map space — `followHeight`'s two horizontal companions, and the
   * same interpolated pose. What `DynamicLights` culls against, being the middle of what is on
   * screen (docs/lights.md § What reaches the shader). three's `(x, y, z)` is DOOM's `(x, -z, y)`.
   */
  get followX(): number {
    return this.initialised ? this.viewPoint.x : this.smoothed.x;
  }

  get followY(): number {
    return -(this.initialised ? this.viewPoint.z : this.smoothed.z);
  }

  /**
   * `viewerAngleDeg` at the interpolated pose the camera is actually drawn at,
   * for billboard orientation. Using the tic-exact angle instead would leave
   * every sprite a fraction of a yaw snap out of line with the walls behind it.
   */
  get viewAngleDeg(): number {
    return this.viewYawDeg - 90;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * One tic of camera *simulation*: advances the smoothed follow point and the
   * orbit yaw. Draws nothing — `applyToCamera` is what moves the `THREE` camera.
   *
   * @param pos     the followed point in DOOM coordinates (the player's feet)
   * @param cursor  where the pointer meets the aim plane, if anywhere — deliberately *not* whatever
   *                auto-aim locked onto, or the view would twitch every time the cursor crossed a
   *                monster (docs/camera.md § Aim lead)
   */
  tick(dt: number, pos: Pos3, cursor: Pos2 | null): void {
    this.prevSmoothed.copy(this.smoothed);
    this.prevYawDeg = this._yawDeg;
    this.prevDistance = this._distance;
    this.prevTiltDeg = this._tiltDeg;
    this._distance = dampen(this._distance, this.targetDistance, FRAMING_SMOOTH_RATE, dt, DISTANCE_SNAP_EPS);
    this._tiltDeg = dampen(this._tiltDeg, this.targetTiltDeg, FRAMING_SMOOTH_RATE, dt, TILT_SNAP_EPS);

    this.setTarget(pos);

    if (cursor && this.aimLead > 0) {
      // Nudge the focus towards the cursor, capped so the player stays on screen.
      const dx = cursor.x - pos.x;
      const dy = cursor.y - pos.y;
      const dist = Math.hypot(dx, dy);
      const maxLead = 220;
      const scale = dist > 0 ? (Math.min(dist * this.aimLead, maxLead) / dist) : 0;
      this.target.x += dx * scale;
      this.target.z += -dy * scale;
    }

    if (!this.initialised) {
      this.smoothed.copy(this.target);
      this.prevSmoothed.copy(this.target);
      this.initialised = true;
    } else {
      this.smoothed.lerp(this.target, 1 - Math.exp(-10 * dt));
    }

    this._yawDeg += (this.targetYawDeg - this._yawDeg) * (1 - Math.exp(-YAW_STEP_SMOOTH_RATE * dt));
  }

  /**
   * Places the `THREE` camera `alpha` of the way from the previous tic's pose to
   * the current one — `alpha` 1 is the tic-exact pose, which is what the tic
   * itself uses before casting the aim ray. Pure view work: it writes nothing
   * the simulation reads back. docs/frameloop.md § Interpolation.
   */
  applyToCamera(alpha: number): void {
    this.viewPoint.copy(this.prevSmoothed).lerp(this.smoothed, alpha);
    // Both yaws are plain accumulating degrees rather than a wrapped angle
    // (`stepYaw` adds ±45 without normalising), so a straight lerp is right and
    // there is no shortest-arc case to handle.
    const yawDeg = this.prevYawDeg + (this._yawDeg - this.prevYawDeg) * alpha;
    this.viewYawDeg = yawDeg;

    const distance = this.prevDistance + (this._distance - this.prevDistance) * alpha;
    const tilt = THREE.MathUtils.degToRad(this.prevTiltDeg + (this._tiltDeg - this.prevTiltDeg) * alpha);
    const yaw = THREE.MathUtils.degToRad(yawDeg);
    // The offset sits yawDeg around the target from due south (yaw=0) so the
    // camera can orbit while staying tilted the same amount off vertical.
    const horiz = Math.sin(tilt) * distance;
    const offsetY = Math.cos(tilt) * distance;
    const offsetX = horiz * Math.sin(yaw);
    const offsetZ = horiz * Math.cos(yaw);

    this.camera.position.set(this.viewPoint.x + offsetX, this.viewPoint.y + offsetY, this.viewPoint.z + offsetZ);
    this.camera.lookAt(this.viewPoint);
    // three refreshes these inside `render`, which is after the dynamic lights have closed their
    // frame — so the volume they cull against is derived here, at the pose just set, rather than
    // one frame late. docs/lights.md § What reaches the shader.
    // `updateMatrixWorld` refreshes `matrixWorldInverse` with it (three's `Camera` overrides it to
    // do exactly that), so the inverse needs no second pass of its own.
    this.camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.viewFrustum.setFromProjectionMatrix(this.projScreen);
  }

  /** Where the pointer ray meets the horizontal plane at height `planeY`. */
  pointerToPlane(ndcX: number, ndcY: number, planeY: number): Pos2 | null {
    const ray = this.rayFor(ndcX, ndcY);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const hit = new THREE.Vector3();
    if (!ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  /**
   * A world-space ray through the pointer's NDC position: auto-aim tests it
   * against monster billboards (game/things.ts's `ThingLayer.pickMonster`),
   * `pointerToPlane` against the flat aim plane.
   *
   * Cast through the `THREE` camera at whatever pose it currently holds, so a
   * caller in the tic has to put that at alpha 1 first — docs/frameloop.md §
   * Posing for the aim ray.
   */
  rayFor(ndcX: number, ndcY: number): THREE.Ray {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    return raycaster.ray;
  }
}
