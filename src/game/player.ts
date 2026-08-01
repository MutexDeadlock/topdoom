import { PLAYER_RADIUS, slideMove, type World } from './world.ts';
import type { Input } from './input.ts';

/** Map units per second. Vanilla DOOM runs at roughly 583. */
const WALK_SPEED = 260;
const RUN_SPEED = 500;
const ACCELERATION = 12; // per second, as a lerp factor
const EYE_HEIGHT = 41;

export class Player {
  x: number;
  y: number;
  /** Feet height. */
  z: number;
  /** Facing/aim direction in radians, 0 = east, counter-clockwise. */
  angle: number;

  velX = 0;
  velY = 0;

  private world: World;

  constructor(world: World) {
    this.world = world;
    const start = world.playerStart();
    this.x = start.x;
    this.y = start.y;
    this.angle = start.angle;
    this.z = world.groundFloor(start.x, start.y, PLAYER_RADIUS);
  }

  get eyeZ(): number {
    return this.z + EYE_HEIGHT;
  }

  /**
   * Drops the player at an arbitrary spot, resting on whatever floor is there
   * and standing still. Used by the `?pos=x,y` deep link (see main.ts) to reach
   * a specific place in a map without walking to it — the practical way to
   * check something like "what does fog of war reveal from in front of MAP01's
   * big window", which is otherwise several rooms and a locked door away.
   */
  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.velX = 0;
    this.velY = 0;
    this.z = this.world.groundFloor(x, y, PLAYER_RADIUS);
  }

  /**
   * Movement is camera-relative: W always moves the player away from the
   * camera on screen, independent of where the player is aiming. `forwardDeg`
   * is the DOOM-space bearing the camera currently looks along (derived from
   * TopDownCamera.viewerAngleDeg), so at the default yaw (camera due south,
   * forwardDeg=90/north) this reduces to the old fixed-axis mapping exactly.
   */
  update(dt: number, input: Input, aim: { x: number; y: number } | null, forwardDeg: number): void {
    let mx = 0;
    let my = 0;
    if (input.held('KeyW', 'ArrowUp')) my += 1;
    if (input.held('KeyS', 'ArrowDown')) my -= 1;
    if (input.held('KeyA', 'ArrowLeft')) mx -= 1;
    if (input.held('KeyD', 'ArrowRight')) mx += 1;

    const len = Math.hypot(mx, my);
    if (len > 0) {
      mx /= len;
      my /= len;
    }

    const forwardRad = (forwardDeg * Math.PI) / 180;
    const rightRad = forwardRad - Math.PI / 2;
    const worldX = mx * Math.cos(rightRad) + my * Math.cos(forwardRad);
    const worldY = mx * Math.sin(rightRad) + my * Math.sin(forwardRad);

    const speed = input.held('ShiftLeft', 'ShiftRight') ? RUN_SPEED : WALK_SPEED;
    const targetX = worldX * speed;
    const targetY = worldY * speed;

    // Exponential approach gives DOOM-ish inertia without a full physics model.
    const k = 1 - Math.exp(-ACCELERATION * dt);
    this.velX += (targetX - this.velX) * k;
    this.velY += (targetY - this.velY) * k;

    if (Math.abs(this.velX) > 0.01 || Math.abs(this.velY) > 0.01) {
      const moved = slideMove(this.world, this.x, this.y, this.velX * dt, this.velY * dt, PLAYER_RADIUS, this.z);
      // Kill the velocity component that was absorbed by a wall.
      if (moved.x === this.x) this.velX = 0;
      if (moved.y === this.y) this.velY = 0;
      this.x = moved.x;
      this.y = moved.y;
    }

    // Snap straight to the resting floor here — the camera already smooths
    // its own followed point (see TopDownCamera.update). groundFloor (not the
    // bare sector floor) keeps z pinned to a ledge's high side for as long as
    // the player's circle still straddles it, matching DOOM's thing->floorz;
    // otherwise the very next step-up check would compare the newly-low z
    // against the still-high opening and block every move near that edge.
    this.z = this.world.groundFloor(this.x, this.y, PLAYER_RADIUS);

    if (aim) this.angle = Math.atan2(aim.y - this.y, aim.x - this.x);
  }
}
