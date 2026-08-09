import * as THREE from 'three';
import type { Input } from '../game/input.ts';
import type { Pos2, Pos3 } from '../types.ts';

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
  private initialised = false;
  /** Seconds Q/E has been continuously held, for auto-repeat — see `applyYawInput`. */
  private qHoldTime = 0;
  private eHoldTime = 0;

  constructor(aspect: number, options: TopDownCameraOptions = {}) {
    this.tiltDeg = options.tiltDeg ?? 60;
    this.distance = options.distance ?? 480;
    this.aimLead = options.aimLead ?? 0.18;
    this._yawDeg = options.yawDeg ?? 0;
    this.targetYawDeg = this._yawDeg;

    this.camera = new THREE.PerspectiveCamera(55, aspect, 8, 12000);
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
   */
  get viewerAngleDeg(): number {
    return this._yawDeg - 90;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param pos  the followed point in DOOM coordinates (the player's feet)
   * @param aim  world-space point the player is aiming at, if any
   */
  update(dt: number, pos: Pos3, aim: Pos2 | null): void {
    this.target.set(pos.x, pos.z, -pos.y);

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
      this.initialised = true;
    } else {
      this.smoothed.lerp(this.target, 1 - Math.exp(-10 * dt));
    }

    this._yawDeg += (this.targetYawDeg - this._yawDeg) * (1 - Math.exp(-YAW_STEP_SMOOTH_RATE * dt));

    const tilt = THREE.MathUtils.degToRad(this.tiltDeg);
    const yaw = THREE.MathUtils.degToRad(this._yawDeg);
    // The offset sits yawDeg around the target from due south (yaw=0) so the
    // camera can orbit while staying tilted the same amount off vertical.
    const horiz = Math.sin(tilt) * this.distance;
    const offsetY = Math.cos(tilt) * this.distance;
    const offsetX = horiz * Math.sin(yaw);
    const offsetZ = horiz * Math.cos(yaw);

    this.camera.position.set(this.smoothed.x + offsetX, this.smoothed.y + offsetY, this.smoothed.z + offsetZ);
    this.camera.lookAt(this.smoothed);
  }

  /** Where the pointer ray meets the horizontal plane at height `planeY`. */
  pointerToPlane(ndcX: number, ndcY: number, planeY: number): Pos2 | null {
    const ray = this.raycasterFor(ndcX, ndcY);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  /**
   * A THREE.Raycaster through the pointer's NDC position, for callers that
   * need to test against real meshes (auto-aim's click-on-a-monster check,
   * game/things.ts's `ThingLayer.pickMonster`) rather than the flat plane
   * `pointerToPlane` intersects.
   */
  raycasterFor(ndcX: number, ndcY: number): THREE.Raycaster {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    return ray;
  }
}
