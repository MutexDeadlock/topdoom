/**
 * The player's body: camera-relative movement, running/straferunning, gravity and falling,
 * knockback, and the vanilla `PLAYER_*` constants. See docs/movement.md.
 */
import { bodyFloor, type ThingBlocker, type World } from './world.ts';
import type { TicInput } from './input.ts';
import type { PlayerSnapshot } from './snapshot.ts';
// Type-only, so the specials <-> player edge stays compile-time and no runtime cycle forms.
import type { TeleportDest } from './specials.ts';
import { NO_FRICTION, type FrictionEffect } from './specials/defs.ts';
import type { Placement, Pos2, Pos3 } from '../types.ts';
import { vecLength } from '../util/geom.ts';
import { decayOverTics } from '../util/damping.ts';
import { readStorage, writeStorage } from '../util/storage.ts';
import { atan2, cos, exp, sin } from '../util/fdlibm.ts';

/** The player's own collision box, in map units — `MT_PLAYER`'s `mobjinfo` radius and height. */
export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;
/**
 * Vanilla `MT_PLAYER`'s own `mobjinfo.mass` — feeds `game.ts`'s use of
 * `game/monsters/defs.ts: thrustSpeed` for the knockback `Player.applyKnockback` receives.
 */
export const PLAYER_MASS = 100;

/**
 * Height above the feet a weapon fires from, and the plane the mouse cursor
 * is projected onto for aiming (`game.ts`'s `camera.pointerToPlane`) — the two
 * have to match, or a tracer/projectile would visibly start from a different
 * height than where the crosshair appears to be. The value is vanilla's `shootz`
 * (`p_map.c`) — docs/combat.md § shotPath. A monster's own equivalent is
 * `game/monsters/defs.ts`'s `monsterShootZ`, the same formula on its body height.
 */
export const AIM_HEIGHT_OFFSET = PLAYER_HEIGHT / 2 + 8;

/**
 * Height above the feet a *missile* leaves from, four units below the hitscan height above:
 * vanilla spawns one at `z = source->z + 4*8*FRACUNIT` in `P_SpawnPlayerMissile` (`p_mobj.c`)
 * where `P_LineAttack` traces from `shootz` (`p_map.c`). Only the start moves — the shot still
 * slopes toward the crosshair's own plane. A monster's missile leaves from the same height,
 * since `P_SpawnMissile` spawns at that same `+ 4*8`. docs/combat.md § Where a missile starts.
 */
export const MISSILE_HEIGHT_OFFSET = 32;

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

/**
 * How fast the player approaches its target velocity, as a lerp-per-second rate. **Tuned by feel**,
 * and the one number here that is not vanilla-derived — docs/movement.md § Movement speed and
 * straferunning.
 */
const ACCELERATION = 12;
/**
 * Vanilla's `VIEWHEIGHT`: where the player *views* from, and what `Player.eyeZ` hands the camera.
 */
export const EYE_HEIGHT = 41;
/**
 * Where a **sight trace** starts above the feet — `P_CheckSight`'s `sightzstart`
 * (`z + height - (height>>2)`). `world.ts`'s `hasLineOfSight` lifts every actor it is
 * handed by this one, player-sized or not (docs/world.md § hasLineOfSight), which is why
 * `monsters/iconofsin.ts` has to subtract it back off for a 32-tall eye.
 *
 * A unit off `EYE_HEIGHT` above and **not** interchangeable with it: this is a vanilla
 * citation, that is the view height. It lives here, not in `world.ts`, because a
 * module-level const derived from `PLAYER_HEIGHT` over there is read during the
 * `world.ts`/`player.ts` cycle's initialization — see `hasLineOfSight`'s declaration.
 */
export const SIGHT_EYE_HEIGHT = PLAYER_HEIGHT * 0.75;
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
 * Below this, `momX`/`momY` snap to exactly 0 rather than crawling on forever — see
 * `game/things.ts`'s identical constant, and `applyForce` for the one case exempt from it.
 * `game/voodoo.ts` shares it, a doll's channel being a copy of this one.
 */
export const MOMENTUM_STOP_SPEED = 1;

/**
 * `P_XYMovement`'s `MAXMOVE` (`p_local.h`, 30 units/tic) in units/sec: what `clampMomentum` holds
 * each axis of the momentum channel to before it moves anything — here, in `game/voodoo.ts` and in
 * `game/things.ts: applyKnockback`. docs/movement.md § Knockback.
 */
export const MAX_MOMENTUM_SPEED = 30 * 35;

/** One axis of a momentum vector held to ±`MAX_MOMENTUM_SPEED`. */
export function clampMomentum(v: number): number {
  return v > MAX_MOMENTUM_SPEED ? MAX_MOMENTUM_SPEED : v < -MAX_MOMENTUM_SPEED ? -MAX_MOMENTUM_SPEED : v;
}

const AUTORUN_STORAGE_KEY = 'autorun';

/**
 * Whether Shift *walks* (autorun on, the default) rather than *runs* (vanilla's own sense).
 * Shaped like every persisted setting — docs/menu.md § Persisted settings.
 */
let autorunEnabled = readStorage(AUTORUN_STORAGE_KEY, true);

export function getAutorun(): boolean {
  return autorunEnabled;
}

export function setAutorun(enabled: boolean): void {
  autorunEnabled = enabled;
  writeStorage(AUTORUN_STORAGE_KEY, enabled);
}

/** A replay's pin on the setting, without touching the stored one; `null` puts that back. */
export function overrideAutorun(enabled: boolean | null): void {
  autorunEnabled = enabled ?? readStorage(AUTORUN_STORAGE_KEY, true);
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
  /**
   * Vertical velocity, map units/sec. Otherwise only ever negative — there's no jump input, only
   * gravity once a step drops out from under the player — except `launchUpward`'s arch-vile
   * knockback, the one thing that ever sets it positive.
   */
  private velZ = 0;
  /**
   * Vanilla's `momx`/`momy` for everything that is **not** the player's own
   * held-key input, map units/sec: damage knockback (`P_DamageMobj`), and the
   * forces the world applies — conveyors, wind and current
   * (`applyForce`, docs/specials-forces.md § Scrollers and conveyors).
   *
   * Kept entirely separate from `velX`/`velY` above rather than added into them, and integrated
   * and decayed (`ORIG_FRICTION`) on its own as a displacement additive to ordinary movement —
   * docs/movement.md § External momentum has why the input model forces the split.
   *
   * `PlayerSnapshot` calls the pair `knockVelX`/`knockVelY`: that is the saved wire format the
   * channel was named by before it widened, and renaming it would orphan every existing save.
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
   * The ground the player is resting on or falling toward, as of this tic — what `update` already
   * asked `groundFloor` for. Kept because the render layer casts the blob shadow on it and
   * `checkPosition` is far too hot to ask a second time per drawn frame.
   * docs/render.md § The player's shadow.
   */
  groundZ = 0;

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

  /**
   * Where this tic's *unclipped* move would have put the player — vanilla's
   * `P_TryMove` destination, before a wall or a ledge rejected it. Written by
   * `update` and reset by `syncInterpolation`; `tryPickup` is the only reader,
   * and only for the tic it was written in. docs/items.md § Collecting things.
   *
   * A live object, rewritten in place, so that reader passes a `Pos2` per tic
   * without allocating one.
   */
  readonly attempted: Pos2 = { x: 0, y: 0 };

  /**
   * IDCLIP: vanilla's `MF_NOCLIP` on the player mobj. Walls and bodies stop being tested at all,
   * and the floor underfoot becomes the plain sector one — see `moveBy` and `update`'s ground.
   * Pushed here from `game.ts`'s `Cheats` every tic, since a `Player` is rebuilt per level.
   * docs/cheats.md § IDCLIP.
   */
  noclip = false;
  /**
   * Whether Shift walks rather than runs — the slot's `PlayerSettings.autorun`, pushed here every
   * tic like `noclip`, so every slot moves under its own.
   * docs/multiplayer.md § Player settings.
   */
  autorun = true;

  private world: World;

  /** `start` is where this body spawns: the map's own player start unless a coop start is given. */
  constructor(world: World, start: Placement = world.playerStart()) {
    this.world = world;
    this.x = start.x;
    this.y = start.y;
    this.angle = start.angle;
    this.z = world.groundFloor(start.x, start.y, PLAYER_RADIUS);
    this.groundZ = this.z;
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevAngle = this.angle;
    this.attempted.x = this.x;
    this.attempted.y = this.y;
  }

  /**
   * Every field the simulation mutates, for a savegame — docs/savegames.md § What is saved and what
   * is deliberately not.
   */
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
   * where they were, and clears `attempted` with it. Every discontinuous move
   * has to call this.
   */
  syncInterpolation(): void {
    // A discontinuous move lands the player on whatever is there, so this tic's ground is where
    // they now are until `update` next resolves it.
    this.groundZ = this.z;
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevAngle = this.angle;
    // A discontinuous move has no attempted move to still be reaching for.
    this.attempted.x = this.x;
    this.attempted.y = this.y;
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
   * **Boom's silent teleports arrive differently**, on two axes: `TeleportDest.rotateBy` turns the
   * player's momentum through the angle the facing turned, and `TeleportDest.silent` preserves the
   * height above ground for a body that was mid-air. That offset is measured *here* because the
   * specials controller is never told the player's height; absent, the landing is vanilla's
   * exactly. See docs/specials-teleporters.md § Silent and line-to-line teleporters.
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
      const turnCos = cos(dest.rotateBy);
      const turnSin = sin(dest.rotateBy);
      this.velX = vx * turnCos - vy * turnSin;
      this.velY = vx * turnSin + vy * turnCos;
      this.velZ = vz;
      this.momX = kx * turnCos - ky * turnSin;
      this.momY = kx * turnSin + ky * turnCos;
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
    const dist = vecLength(dx, dy);
    if (dist < 1) {
      // Degenerate same-position case (attacker and victim essentially
      // coincide, e.g. point-blank melee) — vanilla's own
      // R_PointToAngle2(0,0,0,0) falls back to angle 0 here rather than an
      // undefined direction; pushing along the victim's current facing reads
      // more sensibly than always due east. Same fallback as ThingLayer.damage.
      dx = cos(this.angle);
      dy = sin(this.angle);
    } else {
      dx /= dist;
      dy /= dist;
    }
    this.applyKnockback(dx * speed, dy * speed);
  }

  /**
   * Movement is camera-relative: W always moves the player away from the camera on screen,
   * whatever they are aiming at. `forwardDeg` is the DOOM-space bearing the camera looks along
   * (`TopDownCamera.viewerAngleDeg`, docs/camera.md § Camera orbit). `blockers` are the solid
   * bodies the player slides along rather than walks through (`slideMove`). Forward and sideways
   * are separate, differently-sized thrusts that are never renormalized, and `ground` is what an
   * icy or muddy Boom floor does to all of it — omitted, the identity.
   * docs/movement.md § Collision, § Movement speed and straferunning, § Friction.
   */
  update(
    dt: number,
    input: TicInput,
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
    const run = (this.autorun ? !shiftHeld : shiftHeld) ? 1 : 0;
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
    const targetX = (side * cos(rightRad) + forward * cos(forwardRad)) * ground.targetScale;
    const targetY = (side * sin(rightRad) + forward * sin(forwardRad)) * ground.targetScale;

    // Exponential approach gives DOOM-ish inertia without a full physics model.
    // Ice stretches the ramp out, mud shortens it — see `ground`.
    const k = 1 - exp(-ACCELERATION * ground.accelScale * dt);
    this.velX += (targetX - this.velX) * k;
    this.velY += (targetY - this.velY) * k;

    // One tic of both channels' *desired* move, captured before either
    // `slideMove` below clips it back to what a wall allowed — see `attempted`.
    this.attempted.x = this.x + (this.velX + this.momX) * dt;
    this.attempted.y = this.y + (this.velY + this.momY) * dt;

    if (Math.abs(this.velX) > 0.01 || Math.abs(this.velY) > 0.01) {
      const moved = this.moveBy(this.velX * dt, this.velY * dt, blockers);
      // Adopt whatever the slide actually managed as the new velocity, exactly
      // as vanilla's P_SlideMove writes its clipped vector back to momx/momy:
      // the component that ran along a wall carries over to the next frame and
      // the one that pushed into it is gone. Reading it back off the achieved
      // displacement is what keeps a slid-along-a-wall run at full speed —
      // docs/movement.md § slideMove.
      if (dt > 0) {
        this.velX = (moved.x - this.x) / dt;
        this.velY = (moved.y - this.y) / dt;
      }
      this.x = moved.x;
      this.y = moved.y;
    }

    // The external momentum channel (`applyKnockback`, `applyForce`) is a fully separate
    // displacement from the input-driven movement above — see `momX`'s own doc for why the two
    // aren't combined — but still slides along walls through the same `slideMove`, matching
    // vanilla: the player always gets `P_SlideMove`, whether the momentum came from a hit, a
    // conveyor or the player's own thrust. Decayed by the floor's own per-tic friction
    // (`ORIG_FRICTION` where no 223 line applies) (`decayOverTics` rather than a continuous-rate
    // conversion, for the same "survives conversion out of tics intact" reason `game/things.ts`'s
    // identical decay does), unlike `velX`/`velY`'s own feel-tuned `ACCELERATION` model.
    //
    // The stop-speed snap is skipped while a world force is feeding the channel
    // (`forced`): a slow belt settles at an equilibrium that can sit below
    // `MOMENTUM_STOP_SPEED`, and zeroing it every tic would stall the belt
    // rather than let it creep. A knockback, which nothing sustains, still ends
    // exactly as it always did.
    if (this.forced || Math.abs(this.momX) > MOMENTUM_STOP_SPEED || Math.abs(this.momY) > MOMENTUM_STOP_SPEED) {
      this.momX = clampMomentum(this.momX);
      this.momY = clampMomentum(this.momY);
      const moved = this.moveBy(this.momX * dt, this.momY * dt, blockers);
      if (dt > 0) {
        this.momX = (moved.x - this.x) / dt;
        this.momY = (moved.y - this.y) / dt;
      }
      this.x = moved.x;
      this.y = moved.y;
      const decay = decayOverTics(ground.friction, dt);
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
    // While noclipping it is the plain sector floor under the player's *centre* instead, matching
    // `P_CheckPosition`'s `MF_NOCLIP` early-out: it returns having set `tmfloorz` from the
    // subsector's own sector and before a single line or body was considered, so no ledge holds
    // the player up and no step limit applies. docs/cheats.md § IDCLIP.
    const groundZ = this.noclip
      ? this.world.floorAt(this.x, this.y)
      : Math.max(
          this.world.groundFloor(this.x, this.y, PLAYER_RADIUS, false, this.z),
          bodyFloor(this.x, this.y, PLAYER_RADIUS, this.z, blockers),
        );
    this.groundZ = groundZ;
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

    if (aim) this.angle = atan2(aim.y - this.y, aim.x - this.x);
  }

  /**
   * One displacement, clipped against walls and solid bodies — or taken raw while `noclip` is on,
   * where `P_TryMove`'s every check is skipped and the move always lands whole. The velocity each
   * caller reads back off the result is then simply what it asked for, which is exactly right: a
   * noclipped run into a wall keeps its speed.
   */
  private moveBy(dx: number, dy: number, blockers?: readonly ThingBlocker[]): Pos2 {
    if (this.noclip) return { x: this.x + dx, y: this.y + dy };
    return this.world.slideMove(this, dx, dy, PLAYER_RADIUS, blockers);
  }
}
