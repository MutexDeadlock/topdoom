/**
 * `TopDownCamera`: the tilted overhead camera — follow smoothing, aim lead, and the Q/E orbit.
 * See docs/render.md § Camera orbit and camera-relative movement, and § The camera is simulation
 * state.
 */
import * as THREE from 'three';
import type { Input } from '../game/input.ts';
import type { Pos2, Pos3 } from '../types.ts';
import { VIEW_DISTANCE } from '../constants.ts';

export interface TopDownCameraOptions {
  /** Tilt away from straight down, in degrees. Small values stay top-down. */
  tiltDeg?: number;
  /** Distance from the point being followed, in map units. */
  distance?: number;
  /** How far the view leads towards the aim point, 0..1. */
  aimLead?: number;
  /** Orbit around the target, in degrees. 0 keeps the camera due south. */
  yawDeg?: number;
}

/** How fast `yawDeg` catches up to a `stepYaw` target, as a lerp-per-second rate. */
const YAW_STEP_SMOOTH_RATE = 18;

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
 * **This camera's follow point and yaw are simulation state, not view state**,
 * and advance in `tick` on the tic clock; `applyToCamera` interpolates them into
 * the actual `THREE` camera for display. That split is forced rather than
 * stylistic: the pointer ray is cast through this camera, and the ray decides
 * both `Player.angle` and the basis WASD moves along — so a render-smoothed
 * pose would make aim and movement direction depend on framerate.
 * docs/render.md § The camera is simulation state.
 */
export class TopDownCamera {
  readonly camera: THREE.PerspectiveCamera;
  tiltDeg: number;
  distance: number;
  aimLead: number;

  private _yawDeg: number;
  /** Where `yawDeg` is animating towards — see `stepYaw`. Equal to `_yawDeg` outside of a Q/E snap. */
  private targetYawDeg: number;

  private target = new THREE.Vector3();
  private smoothed = new THREE.Vector3();
  /** Last tic's `smoothed`/`_yawDeg`, the interpolation source for `applyToCamera`. */
  private prevSmoothed = new THREE.Vector3();
  private prevYawDeg: number;
  private initialised = false;
  /** Seconds Q/E has been continuously held, for auto-repeat — see `applyYawInput`. */
  private qHoldTime = 0;
  private eHoldTime = 0;
  /** Scratch for `applyToCamera`'s interpolated follow point, so drawing allocates nothing. */
  private viewPoint = new THREE.Vector3();
  /** The interpolated yaw `applyToCamera` last drew at — see `viewAngleDeg`. */
  private viewYawDeg: number;

  constructor(aspect: number, options: TopDownCameraOptions = {}) {
    this.tiltDeg = options.tiltDeg ?? 60;
    this.distance = options.distance ?? 480;
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
   * See docs/render.md § Camera orbit.
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
   * @param pos  the followed point in DOOM coordinates (the player's feet)
   * @param aim  world-space point the player is aiming at, if any
   */
  tick(dt: number, pos: Pos3, aim: Pos2 | null): void {
    this.prevSmoothed.copy(this.smoothed);
    this.prevYawDeg = this._yawDeg;

    this.setTarget(pos);

    if (aim && this.aimLead > 0) {
      // Nudge the focus towards the cursor, capped so the player stays on screen.
      const dx = aim.x - pos.x;
      const dy = aim.y - pos.y;
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

    const tilt = THREE.MathUtils.degToRad(this.tiltDeg);
    const yaw = THREE.MathUtils.degToRad(yawDeg);
    // The offset sits yawDeg around the target from due south (yaw=0) so the
    // camera can orbit while staying tilted the same amount off vertical.
    const horiz = Math.sin(tilt) * this.distance;
    const offsetY = Math.cos(tilt) * this.distance;
    const offsetX = horiz * Math.sin(yaw);
    const offsetZ = horiz * Math.cos(yaw);

    this.camera.position.set(this.viewPoint.x + offsetX, this.viewPoint.y + offsetY, this.viewPoint.z + offsetZ);
    this.camera.lookAt(this.viewPoint);
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
