import { slideMove, type ThingBlocker, type World } from './world.ts';
import type { Input } from './input.ts';
import type { Placement, Pos2, Pos3 } from '../types.ts';

/** Vanilla DOOM values, in map units. */
export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;
/** Vanilla `MT_PLAYER`'s own `mobjinfo.mass` — feeds `game.ts`'s use of `game/monsters.ts: thrustSpeed` for the knockback `Player.applyKnockback` receives. */
export const PLAYER_MASS = 100;

/**
 * Height above the feet a weapon fires from, and the plane the mouse cursor
 * is projected onto for aiming (`game.ts`'s `camera.pointerToPlane`) — the two
 * have to match, or a tracer/projectile would visibly start from a different
 * height than where the crosshair appears to be. A monster's own equivalent is
 * `game/monsters.ts`'s `MONSTER_FIRE_HEIGHT`.
 */
export const AIM_HEIGHT_OFFSET = 32;

/**
 * Vanilla's own ticcmd move tables (`g_game.c`'s `forwardmove`/`sidemove`),
 * indexed `[walk, run]`, and its `MAXPLMOVE` clamp. Everything below is
 * expressed in these units and scaled once by `MOVE_UNIT_SPEED`, rather than
 * as a pair of hand-picked map-units/sec constants, because the *ratios*
 * between them are what makes DOOM's movement feel like DOOM — see `update`.
 */
const FORWARD_MOVE = [25, 50] as const;
const SIDE_MOVE = [24, 40] as const;
const MAX_PL_MOVE = 50;

/**
 * Map units/sec per vanilla move unit. Vanilla's own works out to 11.67
 * (`forwardmove` 50 against its terminal running speed of ~583 units/sec);
 * this engine deliberately runs a little slower, so full-speed forward
 * running is 500 and everything else follows from the tables above:
 * 250 walking forward, 400 running sideways, 240 walking sideways.
 */
const MOVE_UNIT_SPEED = 10;

const ACCELERATION = 12; // per second, as a lerp factor
const EYE_HEIGHT = 41;
/**
 * Map units per second^2. Tuned by feel rather than lifted from vanilla's fixed-point
 * tic-based gravity (1 unit/tic^2 at 35 tics/s), which doesn't translate to a dt-scaled
 * model directly — this drops the player roughly a body height in about a third of a
 * second, which reads as a fall rather than a teleport without feeling floaty.
 */
export const GRAVITY = 1600;

/**
 * How fast a fall has to end to knock the wind out of the player (`landingSpeed`
 * above it plays `oof`). Vanilla's `P_ZMovement` grunts below `momz < -8`
 * units/tic, which under *its* gravity of 1 unit/tic² is reached by a drop of 32
 * units — so the threshold is derived from that drop height under this engine's
 * own (feel-tuned, stronger) `GRAVITY` rather than copying the speed. Matching
 * the speed instead would make shallower ledges grunt than vanilla's do, and 24
 * units — DOOM's most common step height — sits right at that boundary.
 */
export const HARD_LANDING_SPEED = Math.sqrt(2 * GRAVITY * 32);

/**
 * Vanilla's own per-tic XY friction, `FRICTION = 0xE800/0x10000` — see
 * `game/things.ts`'s identical constant (that file can't import this one
 * without a circular dependency, since `game/monsters.ts` already imports
 * `GRAVITY` from here) for the full doc on why `applyKnockback` raises it to
 * the `dt*35` power rather than converting it to a continuous rate.
 */
const FRICTION = 0.90625;
/** Below this, `knockVelX`/`knockVelY` snap to exactly 0 rather than crawling on forever — see `game/things.ts`'s identical constant. */
const KNOCKBACK_STOP_SPEED = 1;

const AUTORUN_STORAGE_KEY = 'topdoom.autorun';

/**
 * Whether Shift *walks* (autorun on, the default) rather than *runs* (vanilla's
 * own sense). Module-level rather than a `Player` field since it's a session
 * preference set from the menu's Settings tab and must apply immediately even
 * when a `Player` is mid-level, and `Player` itself is recreated every map
 * load (`game.ts: loadMapByIndex`) so an instance field would go stale between
 * toggling it and the next level. Persisted like `AudioEngine`'s volume.
 */
let autorunEnabled = globalThis.localStorage?.getItem(AUTORUN_STORAGE_KEY) !== 'false';

export function getAutorun(): boolean {
  return autorunEnabled;
}

export function setAutorun(enabled: boolean): void {
  autorunEnabled = enabled;
  globalThis.localStorage?.setItem(AUTORUN_STORAGE_KEY, String(enabled));
}

export class Player implements Pos3 {
  x: number;
  y: number;
  /** Feet height. */
  z: number;
  /** Facing/aim direction in radians, 0 = east, counter-clockwise. */
  angle: number;

  velX = 0;
  velY = 0;
  /** Vertical velocity, map units/sec. Otherwise only ever negative — there's no jump input, only gravity once a step drops out from under the player — except `launchUpward`'s arch-vile knockback, the one thing that ever sets it positive. */
  private velZ = 0;
  /**
   * Vanilla's `P_DamageMobj` horizontal knockback (`momx`/`momy`), map
   * units/sec — kept entirely separate from `velX`/`velY` above rather than
   * added into them, since those track the player's own held-key input via
   * an exponential approach to a target velocity (`update`'s `k`), and
   * folding a knockback impulse into that model would just have it absorbed
   * or fought by whatever the player is currently pressing within a frame or
   * two. This instead integrates and decays (`FRICTION`) on its own, as a
   * displacement genuinely additive to ordinary movement — matching vanilla,
   * where the momentum-driven and input-driven parts of a player's motion
   * are two separate contributions summed into the same `momx`/`momy`, only
   * split apart here because this engine's own input model isn't itself
   * momentum-based (see `update`'s doc on why forward/side are targets, not
   * thrusts).
   */
  private knockVelX = 0;
  private knockVelY = 0;
  /**
   * How fast the player was falling (map units/sec, positive) at the moment
   * this frame's fall ended, or 0 if it didn't end in one. Vanilla's
   * `P_ZMovement` grunts and dips the view for a landing harder than 8
   * units/tic; the grunt's own threshold is `HARD_LANDING_SPEED` above.
   * Reset at the top of every `update`, so it only ever describes this frame.
   */
  landingSpeed = 0;

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
  moveTo(pos: Pos2): void {
    this.x = pos.x;
    this.y = pos.y;
    this.velX = 0;
    this.velY = 0;
    this.velZ = 0;
    this.knockVelX = 0;
    this.knockVelY = 0;
    this.z = this.world.groundFloor(pos.x, pos.y, PLAYER_RADIUS);
  }

  /** Teleporter landing: drops the player at the destination facing `dest.angle`, matching vanilla's own view-angle snap on arrival. */
  teleportTo(dest: Placement): void {
    this.moveTo(dest);
    this.angle = dest.angle;
  }

  /**
   * The arch-vile's knockback (`game/monsters.ts`'s `AttackStats.blast`,
   * vanilla's `A_VileAttack` momz launch) — the one way `velZ` ever goes
   * positive. A bare velocity set wouldn't be enough: `update`'s airborne
   * branch only integrates gravity while `z > groundFloor`, and immediately
   * after this call `z` still sits exactly on the floor, so the very next
   * frame would fall into the ground-snap branch and zero the launch right
   * back out before it ever moved anything. The `+1` nudge is what makes
   * `update` see the player as already airborne.
   */
  launchUpward(speed: number): void {
    this.velZ = speed;
    this.z += 1;
  }

  /**
   * Vanilla's `P_DamageMobj` horizontal knockback: adds an impulse (`vx, vy`,
   * already pointed away from whatever dealt the hit) onto
   * `knockVelX`/`knockVelY` rather than setting them, so a quick follow-up hit
   * stacks on top of a knockback still playing out instead of replacing it,
   * matching vanilla's own `momx += ...`. `update` integrates and decays the
   * result every frame.
   */
  applyKnockback(vx: number, vy: number): void {
    this.knockVelX += vx;
    this.knockVelY += vy;
  }

  /**
   * `applyKnockback`'s direction half: points `speed` away from (`fromX`,
   * `fromY`) and applies it. The caller supplies the magnitude, since that
   * comes from `monsters.ts: thrustSpeed` against a per-victim `mass` this
   * class has no business knowing — `ThingLayer.damage` is the monster/barrel
   * twin of this, doing the identical arithmetic for its own bodies. See
   * docs/movement.md § Knockback.
   */
  applyDamageThrust(speed: number, fromX: number, fromY: number): void {
    let dx = this.x - fromX;
    let dy = this.y - fromY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) {
      // Degenerate same-position case (attacker and victim essentially
      // coincide, e.g. point-blank melee) — vanilla's own
      // R_PointToAngle2(0,0,0,0) falls back to angle 0 here rather than an
      // undefined direction; pushing along the victim's current facing reads
      // more sensibly than always due east. Same fallback as ThingLayer.damage.
      dx = Math.cos(this.angle);
      dy = Math.sin(this.angle);
    } else {
      dx /= dist;
      dy /= dist;
    }
    this.applyKnockback(dx * speed, dy * speed);
  }

  /**
   * Movement is camera-relative: W always moves the player away from the
   * camera on screen, independent of where the player is aiming. `forwardDeg`
   * is the DOOM-space bearing the camera currently looks along (derived from
   * TopDownCamera.viewerAngleDeg), so at the default yaw (camera due south,
   * forwardDeg=90/north) this reduces to the old fixed-axis mapping exactly.
   *
   * `blockers` are the solid bodies (living monsters) the player has to walk
   * around rather than through — vanilla's monsters are all `MF_SOLID`, so
   * they stop a mover exactly the way a wall does. Unlike a monster's own
   * movement, this still slides along them (`slideMove`), because the player
   * is the one thing in DOOM that gets `P_SlideMove`; bumping a demon in a
   * corridor should scrape past it, not stop dead.
   *
   * **Forward and sideways are separate, differently-sized thrusts that are
   * never renormalized**, which is the whole of vanilla's straferunning.
   * `G_BuildTiccmd` accumulates `forwardmove` and `sidemove` independently,
   * clamps each to `MAXPLMOVE` on its own, and `P_PlayerThink` then thrusts
   * along both — so running forward *and* sideways at once genuinely moves
   * faster than either alone, by the diagonal of the two. Normalizing the
   * input vector (which this used to do) makes every direction equally fast
   * and takes both SR40 and SR50 away with it.
   *
   * - **SR40**: `W`+`D` while running is `forwardmove` 50 and `sidemove` 40,
   *   i.e. `hypot(500, 400)` = 640 units/sec — 1.28x plain running, exactly
   *   vanilla's own 746.9/583.3 ratio.
   * - **SR50** is vanilla's own `MAXPLMOVE` clamp artifact — reachable there
   *   only by binding a second strafe key and holding both on the same side
   *   so `sidemove` sums past 50 before the clamp — and this engine has no
   *   such second binding, so it's a latent rather than a reachable behavior
   *   here: `MAX_PL_MOVE`'s clamp is still exactly vanilla's own, there's
   *   just nothing that can currently push `side` past `sideMove` to exercise it.
   */
  update(
    dt: number,
    input: Input,
    aim: Pos2 | null,
    forwardDeg: number,
    blockers?: readonly ThingBlocker[],
  ): void {
    this.landingSpeed = 0;
    const shiftHeld = input.held('ShiftLeft', 'ShiftRight');
    const run = (getAutorun() ? !shiftHeld : shiftHeld) ? 1 : 0;
    const forwardMove = FORWARD_MOVE[run];
    const sideMove = SIDE_MOVE[run];

    let forward = 0;
    let side = 0;
    if (input.held('KeyW', 'ArrowUp')) forward += forwardMove;
    if (input.held('KeyS', 'ArrowDown')) forward -= forwardMove;
    if (input.held('KeyA', 'ArrowLeft')) side -= sideMove;
    if (input.held('KeyD', 'ArrowRight')) side += sideMove;

    // Per-axis clamping, not a magnitude clamp — see the doc above.
    forward = Math.max(-MAX_PL_MOVE, Math.min(MAX_PL_MOVE, forward)) * MOVE_UNIT_SPEED;
    side = Math.max(-MAX_PL_MOVE, Math.min(MAX_PL_MOVE, side)) * MOVE_UNIT_SPEED;

    const forwardRad = (forwardDeg * Math.PI) / 180;
    const rightRad = forwardRad - Math.PI / 2;
    const targetX = side * Math.cos(rightRad) + forward * Math.cos(forwardRad);
    const targetY = side * Math.sin(rightRad) + forward * Math.sin(forwardRad);

    // Exponential approach gives DOOM-ish inertia without a full physics model.
    const k = 1 - Math.exp(-ACCELERATION * dt);
    this.velX += (targetX - this.velX) * k;
    this.velY += (targetY - this.velY) * k;

    if (Math.abs(this.velX) > 0.01 || Math.abs(this.velY) > 0.01) {
      const moved = slideMove(this.world, this, this.velX * dt, this.velY * dt, PLAYER_RADIUS, false, false, blockers);
      // Adopt whatever the slide actually managed as the new velocity, exactly
      // as vanilla's P_SlideMove writes its clipped vector back to momx/momy:
      // the component that ran along a wall carries over to the next frame and
      // the one that pushed into it is gone. Reading it back off the achieved
      // displacement is what keeps a slid-along-a-wall run at full speed — the
      // old "zero whichever axis didn't move" rule couldn't express a diagonal
      // wall's slide at all, since neither axis is that wall's tangent.
      if (dt > 0) {
        this.velX = (moved.x - this.x) / dt;
        this.velY = (moved.y - this.y) / dt;
      }
      this.x = moved.x;
      this.y = moved.y;
    }

    // A knockback impulse (`applyKnockback`) is a fully separate displacement
    // from the input-driven movement above — see `knockVelX`'s own doc for
    // why the two aren't combined — but still slides along walls through the
    // same `slideMove`, matching vanilla: the player always gets
    // `P_SlideMove`, whether the momentum came from a hit or from the
    // player's own thrust. Decayed by vanilla's real per-tic `FRICTION`
    // (`Math.pow` rather than a continuous-rate conversion, for the same
    // "survives conversion out of tics intact" reason `game/things.ts`'s
    // identical decay does), unlike `velX`/`velY`'s own feel-tuned
    // `ACCELERATION` model.
    if (Math.abs(this.knockVelX) > KNOCKBACK_STOP_SPEED || Math.abs(this.knockVelY) > KNOCKBACK_STOP_SPEED) {
      const moved = slideMove(this.world, this, this.knockVelX * dt, this.knockVelY * dt, PLAYER_RADIUS, false, false, blockers);
      if (dt > 0) {
        this.knockVelX = (moved.x - this.x) / dt;
        this.knockVelY = (moved.y - this.y) / dt;
      }
      this.x = moved.x;
      this.y = moved.y;
      const decay = Math.pow(FRICTION, dt * 35);
      this.knockVelX *= decay;
      this.knockVelY *= decay;
      if (Math.abs(this.knockVelX) < KNOCKBACK_STOP_SPEED) this.knockVelX = 0;
      if (Math.abs(this.knockVelY) < KNOCKBACK_STOP_SPEED) this.knockVelY = 0;
    } else {
      this.knockVelX = 0;
      this.knockVelY = 0;
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
      if (this.z === groundZ) {
        this.landingSpeed = -this.velZ;
        this.velZ = 0;
      }
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
