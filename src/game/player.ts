import { slideMove, type World } from './world.ts';
import type { Input } from './input.ts';

/** Vanilla DOOM values, in map units. */
export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;

/** Map units per second. Vanilla DOOM runs at roughly 583. */
const WALK_SPEED = 260;
const RUN_SPEED = 500;
const ACCELERATION = 12; // per second, as a lerp factor
const EYE_HEIGHT = 41;
/**
 * Map units per second^2. Tuned by feel rather than lifted from vanilla's fixed-point
 * tic-based gravity (1 unit/tic^2 at 35 tics/s), which doesn't translate to a dt-scaled
 * model directly — this drops the player roughly a body height in about a third of a
 * second, which reads as a fall rather than a teleport without feeling floaty.
 */
export const GRAVITY = 1600;

export class Player {
  x: number;
  y: number;
  /** Feet height. */
  z: number;
  /** Facing/aim direction in radians, 0 = east, counter-clockwise. */
  angle: number;

  velX = 0;
  velY = 0;
  /** Vertical velocity, map units/sec. Only ever goes negative — there's no jump input, only gravity once a step drops out from under the player. */
  private velZ = 0;

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
    this.velZ = 0;
    this.z = this.world.groundFloor(x, y, PLAYER_RADIUS);
  }

  /** Teleporter landing: drops the player at the destination facing `angle`, matching vanilla's own view-angle snap on arrival. */
  teleportTo(x: number, y: number, angle: number): void {
    this.moveTo(x, y);
    this.angle = angle;
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

    // groundFloor (not the bare sector floor) keeps the resting height pinned to
    // a ledge's high side for as long as the player's circle still straddles it,
    // matching DOOM's thing->floorz — that's also what makes a gap narrower than
    // the player's diameter (2*PLAYER_RADIUS) crossable without falling in: the
    // circle overlaps both edges at once the whole way across, so this never
    // reports the lower pit floor in between, the same "step over it" quirk
    // vanilla has.
    const groundZ = this.world.groundFloor(this.x, this.y, PLAYER_RADIUS);
    if (this.z > groundZ) {
      // Airborne: the ground dropped out from under the player (walked off a
      // ledge, or a straddled gap turned out too wide to glide over). Fall
      // under gravity instead of snapping straight down, and clamp to the
      // floor once reached rather than overshooting through it.
      this.velZ -= GRAVITY * dt;
      this.z = Math.max(groundZ, this.z + this.velZ * dt);
      if (this.z === groundZ) this.velZ = 0;
    } else {
      // On the ground, or stepping up onto a higher tread within MAX_STEP_UP
      // (already enforced by circleBlocked/blocksMovement above). Vanilla
      // snaps this instantly rather than animating it — climbing a real
      // staircase already looks smooth because each tread is a separate
      // sector crossed one frame at a time while walking.
      this.z = groundZ;
      this.velZ = 0;
    }

    if (aim) this.angle = Math.atan2(aim.y - this.y, aim.x - this.x);
  }
}
