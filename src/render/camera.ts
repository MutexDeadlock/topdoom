import * as THREE from 'three';

export interface TopDownCameraOptions {
  /** Tilt away from straight down, in degrees. Small values stay top-down. */
  tiltDeg?: number;
  /** Distance from the point being followed, in map units. */
  distance?: number;
  /** How far the view leads towards the aim point, 0..1. */
  aimLead?: number;
}

/**
 * A camera hanging above the player, tilted slightly off vertical so walls
 * show a bit of their height and the level reads as a space rather than a plan.
 */
export class TopDownCamera {
  readonly camera: THREE.PerspectiveCamera;
  tiltDeg: number;
  distance: number;
  aimLead: number;

  private target = new THREE.Vector3();
  private smoothed = new THREE.Vector3();
  private initialised = false;

  constructor(aspect: number, options: TopDownCameraOptions = {}) {
    this.tiltDeg = options.tiltDeg ?? 60;
    this.distance = options.distance ?? 620;
    this.aimLead = options.aimLead ?? 0.18;

    this.camera = new THREE.PerspectiveCamera(55, aspect, 8, 12000);
    this.camera.up.set(0, 1, 0);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param px,py  player position in DOOM coordinates
   * @param pz     player eye height
   * @param aim    world-space point the player is aiming at, if any
   */
  update(dt: number, px: number, py: number, pz: number, aim: { x: number; y: number } | null): void {
    this.target.set(px, pz, -py);

    if (aim && this.aimLead > 0) {
      // Nudge the focus towards the cursor, capped so the player stays on screen.
      const dx = aim.x - px;
      const dy = aim.y - py;
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

    const tilt = THREE.MathUtils.degToRad(this.tiltDeg);
    // The offset sits south of the target so the camera looks slightly northward.
    const offsetY = Math.cos(tilt) * this.distance;
    const offsetZ = Math.sin(tilt) * this.distance;

    this.camera.position.set(this.smoothed.x, this.smoothed.y + offsetY, this.smoothed.z + offsetZ);
    this.camera.lookAt(this.smoothed);
  }

  /** Where the pointer ray meets the horizontal plane at height `planeY`. */
  pointerToPlane(ndcX: number, ndcY: number, planeY: number): { x: number; y: number } | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, y: -hit.z };
  }
}
