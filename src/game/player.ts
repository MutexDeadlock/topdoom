/**
 * The player's body: camera-relative movement, running/straferunning, gravity and falling,
 * knockback, and the vanilla `PLAYER_*` constants. See docs/movement.md.
 */
import { bodyFloor, slideMove, type ThingBlocker, type World } from './world.ts';
import type { Input } from './input.ts';
import type { PlayerSnapshot } from './snapshot.ts';
// Type-only, so the specials <-> player edge stays compile-time and no runtime cycle forms.
import type { TeleportDest } from './specials.ts';
import { NO_FRICTION, type FrictionEffect } from './specials/defs.ts';
import type { Pos2, Pos3 } from '../types.ts';

/** Vanilla DOOM values, in map units. */
export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;
/** Vanilla `MT_PLAYER`'s own `mobjinfo.mass` — feeds `game.ts`'s use of `game/monsters/defs.ts: thrustSpeed` for the knockback `Player.applyKnockback` receives. */
export const PLAYER_MASS = 100;

/**
 * Height above the feet a weapon fires from, and the plane the mouse cursor
 * is projected onto for aiming (`game.ts`'s `camera.pointerToPlane`) — the two
 * have to match, or a tracer/projectile would visibly start from a different
 * height than where the crosshair appears to be. A monster's own equivalent is
 * `game/monsters/defs.ts`'s `MONSTER_FIRE_HEIGHT`.
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
export const EYE_HEIGHT = 41;
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

/** Below this, `momX`/`momY` snap to exactly 0 rather than crawling on forever — see `game/things.ts`'s identical constant, and `applyForce` for the one case exempt from it. `game/voodoo.ts` shares it, a doll's channel being a copy of this one. */
export const MOMENTUM_STOP_SPEED = 1;

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
   * Vanilla's `momx`/`momy` for everything that is **not** the player's own
   * held-key input, map units/sec: damage knockback (`P_DamageMobj`), and the
   * forces the world applies — conveyors, wind and current
   * (`applyForce`, docs/specials.md § Scrollers and conveyors).
   *
   * Kept entirely separate from `velX`/`velY` above rather than added into
   * them, since those track held-key input via an exponential approach to a
   * target velocity (`update`'s `k`), and folding an impulse into that model
   * would just have it absorbed or fought by whatever the player is currently
   * pressing within a frame or two. This instead integrates and decays
   * (`ORIG_FRICTION`) on its own, as a displacement genuinely additive to ordinary
   * movement — matching vanilla, where the momentum-driven and input-driven
   * parts of a player's motion are two separate contributions summed into the
   * same `momx`/`momy`, only split apart here because this engine's own input
   * model isn't itself momentum-based (see `update`'s doc on why forward/side
   * are targets, not thrusts).
   *
   * `PlayerSnapshot` still calls the pair `knockVelX`/`knockVelY`: that is the
   * saved wire format from before the channel widened, and renaming it would
   * orphan every existing save — docs/movement.md § External momentum.
   */
  private momX = 0;
  private momY = 0;
  /**
   * Whether a world force fed the channel this tic — see `applyForce`. Set by
   * it, cleared at the end of `update`.
   */
  private forced = false;
  /**
   * How fast the player was falling (map units/sec, positive) at the moment
   * this frame's fall ended, or 0 if it didn't end in one. Vanilla's
   * `P_ZMovement` grunts and dips the view for a landing harder than 8
   * units/tic; the grunt's own threshold is `HARD_LANDING_SPEED` above.
   * Reset at the top of every `update`, so it only ever describes this frame.
   */
  landingSpeed = 0;

  /**
   * Where the player was at the end of the previous tic, for the render layer to
   * interpolate from — `game.ts: posePlayer` and the camera's follow point both
   * read it. Written at the top of `update`, and re-synced by every teleport-like
   * jump (`moveTo`) so an instant relocation is not smeared into a glide across
   * the map. docs/frameloop.md § Interpolation.
   */
  prevX: number;
  prevY: number;
  prevZ: number;
  prevAngle: number;

  private world: World;

  constructor(world: World) {
    this.world = world;
    const start = world.playerStart();
    this.x = start.x;
    this.y = start.y;
    this.angle = start.angle;
    this.z = world.groundFloor(start.x, start.y, PLAYER_RADIUS);
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevAngle = this.angle;
  }

  /** Every field the simulation mutates, for a savegame — docs/savegames.md § What is saved and what is deliberately not. */
  snapshot(): PlayerSnapshot {
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      angle: this.angle,
      velX: this.velX,
      velY: this.velY,
      velZ: this.velZ,
      knockVelX: this.momX,
      knockVelY: this.momY,
    };
  }

  /** The restore twin of `snapshot`; a discontinuous move, so it ends on `syncInterpolation`. */
  restore(s: PlayerSnapshot): void {
    this.x = s.x;
    this.y = s.y;
    this.z = s.z;
    this.angle = s.angle;
    this.velX = s.velX;
    this.velY = s.velY;
    this.velZ = s.velZ;
    this.momX = s.knockVelX;
    this.momY = s.knockVelY;
    this.syncInterpolation();
  }

  /**
   * Collapses the interpolation window onto the current position, so the next
   * frame draws the player where they now are instead of gliding there from
   * where they were. Every discontinuous move has to call this.
   */
  syncInterpolation(): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevAngle = this.angle;
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
    this.momX = 0;
    this.momY = 0;
    this.z = this.world.groundFloor(pos.x, pos.y, PLAYER_RADIUS);
    this.syncInterpolation();
  }

  /**
   * Teleporter landing: drops the player at the destination facing
   * `dest.angle`, matching vanilla's own view-angle snap on arrival.
   *
   * **Boom's silent teleports arrive differently**, on two axes.
   * `TeleportDest.rotateBy` turns the player's momentum through the same angle
   * the facing turned, rather than `moveTo` clearing it — walking in comes out
   * walking. `TeleportDest.silent` preserves the height above ground for a body
   * that was mid-air: `EV_SilentTeleport`/`EV_SilentLineTeleport` both take
   * `z = thing->z - thing->floorz` and reapply it at the destination, where
   * loud `EV_Teleport` sets `thing->z = thing->floorz` outright. That offset is
   * measured *here* because the specials controller is never told the player's
   * height. Absent, the landing is vanilla's exactly.
   * See docs/specials.md § Silent and line-to-line teleporters.
   */
  teleportTo(dest: TeleportDest): void {
    // Read before `moveTo` overwrites them, reapplied after — the four velocity
    // fields plus the height above ground are the whole of what a silent
    // arrival carries across.
    const vx = this.velX;
    const vy = this.velY;
    const vz = this.velZ;
    const kx = this.momX;
    const ky = this.momY;
    const aboveFloor = this.z - this.world.groundFloor(this.x, this.y, PLAYER_RADIUS);
    this.moveTo(dest);
    if (dest.rotateBy !== undefined) {
      const cos = Math.cos(dest.rotateBy);
      const sin = Math.sin(dest.rotateBy);
      this.velX = vx * cos - vy * sin;
      this.velY = vx * sin + vy * cos;
      this.velZ = vz;
      this.momX = kx * cos - ky * sin;
      this.momY = kx * sin + ky * cos;
    }
    // Unclamped, as in Boom: the offset is reapplied as measured. A body
    // resting on the ground has one of 0, so this is a no-op for every landing
    // that isn't mid-air.
    if (dest.silent) this.z += aboveFloor;
    this.angle = dest.angle;
    // After the angle, not just inside `moveTo`: a teleport snaps the facing too.
    this.syncInterpolation();
  }

  /**
   * The arch-vile's knockback (`game/monsters/defs.ts`'s `AttackStats.blast`,
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
   * already pointed away from whatever dealt the hit) onto `momX`/`momY`
   * rather than setting them, so a quick follow-up hit stacks on top of a
   * knockback still playing out instead of replacing it, matching vanilla's own
   * `momx += ...`. `update` integrates and decays the result every frame.
   */
  applyKnockback(vx: number, vy: number): void {
    this.momX += vx;
    this.momY += vy;
  }

  /**
   * A world force — a conveyor's carry, wind, a current — pushed onto the same
   * momentum channel, in map units/sec, **once per tic**. Sustained against the
   * channel's own friction decay this settles at vanilla's own equilibrium
   * (`v* = a·f/(1−f)`), which is exact rather than approximate because the
   * simulation runs a fixed tic (docs/frameloop.md § What runs in a tic).
   *
   * Separate from `applyKnockback` only so the stop-speed snap can tell them
   * apart: a slow belt's equilibrium can sit below `MOMENTUM_STOP_SPEED`, and
   * snapping it to zero every tic would stall the belt outright. See `update`.
   */
  applyForce(vx: number, vy: number): void {
    this.momX += vx;
    this.momY += vy;
    this.forced = true;
  }

  /**
   * `applyKnockback`'s direction half: points `speed` away from (`fromX`,
   * `fromY`) and applies it. The caller supplies the magnitude, since that
   * comes from `monsters/defs.ts: thrustSpeed` against a per-victim `mass` this
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
   * is the DOOM-space bearing the camera currently looks along (from
   * `TopDownCamera.viewerAngleDeg`), so at the default yaw this reduces to the
   * old fixed-axis mapping exactly. docs/render.md § Camera orbit.
   *
   * `blockers` are the solid bodies the player walks around rather than
   * through, and unlike a monster's own movement this slides along them
   * (`slideMove`) — docs/movement.md § Collision.
   *
   * **Forward and sideways are separate, differently-sized thrusts that are
   * never renormalized**, which is the whole of vanilla's straferunning;
   * normalizing the input vector takes SR40 and SR50 away with it.
   * docs/movement.md § Movement speed and straferunning.
   *
   * `ground` is what the floor underfoot does to all of this — an icy or muddy
   * Boom sector (`specials/forces.ts: frictionUnder`). Omitted, or on any floor
   * with no friction line, it is the identity and every number below is exactly
   * what it was before friction existed. docs/movement.md § Friction.
   */
  update(
    dt: number,
    input: Input,
    aim: Pos2 | null,
    forwardDeg: number,
    blockers?: readonly ThingBlocker[],
    ground: Readonly<FrictionEffect> = NO_FRICTION,
  ): void {
    this.landingSpeed = 0;
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevAngle = this.angle;
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
    // The floor's own scale on the terminal speed: ice barely changes it, mud
    // cuts it hard. Applied to the target rather than the thrust, since the
    // target *is* this model's terminal speed.
    const targetX = (side * Math.cos(rightRad) + forward * Math.cos(forwardRad)) * ground.targetScale;
    const targetY = (side * Math.sin(rightRad) + forward * Math.sin(forwardRad)) * ground.targetScale;

    // Exponential approach gives DOOM-ish inertia without a full physics model.
    // Ice stretches the ramp out, mud shortens it — see `ground`.
    const k = 1 - Math.exp(-ACCELERATION * ground.accelScale * dt);
    this.velX += (targetX - this.velX) * k;
    this.velY += (targetY - this.velY) * k;

    if (Math.abs(this.velX) > 0.01 || Math.abs(this.velY) > 0.01) {
      const moved = slideMove(this.world, this, this.velX * dt, this.velY * dt, PLAYER_RADIUS, blockers);
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

    // The external momentum channel (`applyKnockback`, `applyForce`) is a fully
    // separate displacement from the input-driven movement above — see `momX`'s
    // own doc for why the two aren't combined — but still slides along walls
    // through the same `slideMove`, matching vanilla: the player always gets
    // `P_SlideMove`, whether the momentum came from a hit, a conveyor or the
    // player's own thrust. Decayed by the floor's own per-tic friction (`ORIG_FRICTION` where no 223 line applies)
    // (`Math.pow` rather than a continuous-rate conversion, for the same
    // "survives conversion out of tics intact" reason `game/things.ts`'s
    // identical decay does), unlike `velX`/`velY`'s own feel-tuned
    // `ACCELERATION` model.
    //
    // The stop-speed snap is skipped while a world force is feeding the channel
    // (`forced`): a slow belt settles at an equilibrium that can sit below
    // `MOMENTUM_STOP_SPEED`, and zeroing it every tic would stall the belt
    // rather than let it creep. A knockback, which nothing sustains, still ends
    // exactly as it always did.
    if (this.forced || Math.abs(this.momX) > MOMENTUM_STOP_SPEED || Math.abs(this.momY) > MOMENTUM_STOP_SPEED) {
      const moved = slideMove(this.world, this, this.momX * dt, this.momY * dt, PLAYER_RADIUS, blockers);
      if (dt > 0) {
        this.momX = (moved.x - this.x) / dt;
        this.momY = (moved.y - this.y) / dt;
      }
      this.x = moved.x;
      this.y = moved.y;
      const decay = Math.pow(ground.friction, dt * 35);
      this.momX *= decay;
      this.momY *= decay;
      if (!this.forced) {
        if (Math.abs(this.momX) < MOMENTUM_STOP_SPEED) this.momX = 0;
        if (Math.abs(this.momY) < MOMENTUM_STOP_SPEED) this.momY = 0;
      }
    } else {
      this.momX = 0;
      this.momY = 0;
    }
    // Consumed: the next tic's forces have to announce themselves again, or a
    // player who steps off a belt would keep its no-snap exemption forever.
    this.forced = false;

    // groundFloor (not the bare sector floor) keeps the resting height pinned to
    // a ledge's high side for as long as the player's box still spans it,
    // matching DOOM's thing->floorz — that's also what makes a gap narrower than
    // the player's diameter (2*PLAYER_RADIUS) crossable without falling in: the
    // box overlaps both edges at once the whole way across, so this never
    // reports the lower pit floor in between, the same "step over it" quirk
    // vanilla has.
    // A solid body the player is above is ground too (`bodyFloor`) — the
    // player's alone, and inert while infinite-tall actors is on. See
    // docs/movement.md § Vertical physics: stairs, falling, gap-crossing.
    const groundZ = Math.max(
      this.world.groundFloor(this.x, this.y, PLAYER_RADIUS),
      bodyFloor(this.x, this.y, PLAYER_RADIUS, this.z, blockers),
    );
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
      // (already enforced by positionBlocked above). Vanilla
      // snaps this instantly rather than animating it — climbing a real
      // staircase already looks smooth because each tread is a separate
      // sector crossed one frame at a time while walking.
      this.z = groundZ;
      this.velZ = 0;
    }

    if (aim) this.angle = Math.atan2(aim.y - this.y, aim.x - this.x);
  }
}
