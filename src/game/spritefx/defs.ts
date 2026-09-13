/**
 * The record shapes behind everything drawn that isn't a map `Thing` — a
 * one-shot effect animation and a projectile in flight — plus the two pure
 * vanilla helpers a missile's flight is resolved with. The sprite, sound and
 * timing data these are looked up against is `spritefx/tables.ts`; the
 * simulation reading both is `spritefx.ts` and `projectiles.ts`. See
 * docs/combat.md § Effects and their batching.
 */
import type { SpriteAnimator } from '../../render/sprites.ts';
import type { Pos3 } from '../../types.ts';
import { segmentEntersBox } from '../../util/geom.ts';
import { atan2, cos, sin } from '../../util/fdlibm.ts';

/**
 * Map units a second, for the one effect kind that carries momentum — the crusher's blood spray,
 * integrated by `SpriteFxLayer.updateImpacts`. Boxed rather than flat `velX`/`velY`/`velZ` fields
 * so its presence is the "is this one flying" flag. See docs/specials-crushers.md § Crushers.
 */
export interface EffectMotion {
  velX: number;
  velY: number;
  velZ: number;
}

/**
 * A transient, one-shot sprite animation: plays through `frames` once at a
 * fixed spot and then removes itself. Used for the teleport-fog puff, a
 * projectile's impact explosion, the smoke trail and the vile's flame —
 * none of which is a real map `Thing`, so none goes through `ThingLayer`.
 */
export interface OneShotEffect extends Pos3 {
  /**
   * A bare {@link SpriteAnimator} drawn through `SpriteFxLayer`'s own batch, no `THREE.Object3D`
   * of its own — same arrangement as `PosedThing`.
   */
  anim: SpriteAnimator;
  light: number;
  /**
   * The subsector this effect sits in, resolved once at spawn (and re-derived
   * only for the one effect that moves, the vile's flame). `drawList` gates
   * drawing on it, so an effect in a room the player has never seen stays
   * hidden — docs/fogofwar.md § How reveal reaches the geometry.
   */
  subsector: number;
  elapsed: number;
  lifetime: number;
  /**
   * Set only for the arch-vile's windup flame (vanilla's `MT_FIRE`/`A_Fire`):
   * position is re-derived every frame from this target's live position and
   * facing rather than staying fixed. `null` means the player; absent (the
   * common case) skips this. See docs/monster-archvile.md.
   */
  followTargetId?: number;
  /**
   * The arch-vile that spawned this flame — sight from it is re-checked before repositioning
   * (`A_Fire`'s `P_CheckSight` gate). Always set alongside {@link OneShotEffect.followTargetId}.
   */
  vileSourceId?: number;
  /**
   * Set only for an effect thrown with momentum of its own — the crusher's blood spray
   * (`spawnCrushBlood`). Cleared where it lands, which is what ends the per-tic arithmetic; every
   * other effect here is fixed where it spawned and leaves this undefined.
   * See docs/specials-crushers.md § Crushers.
   */
  motion?: EffectMotion;
  /**
   * Position at the end of the previous tic, for the render layer to interpolate
   * from. Every effect carries it although only the arch-vile's following flame
   * ever moves — a stationary explosion's `prev` simply equals its current
   * position, which costs one branch-free lerp rather than a special case.
   * docs/frameloop.md § Interpolation.
   */
  drawPrevX: number;
  drawPrevY: number;
  drawPrevZ: number;
}

export interface Projectile {
  /**
   * Drawn through `SpriteFxLayer`'s own batch, same as {@link OneShotEffect.anim} — see that
   * field's doc.
   */
  anim: SpriteAnimator;
  originX: number;
  originY: number;
  /**
   * Fire height at launch (the player's) — see spawnPlayerShot's doc for why this is never the
   * target's own height.
   */
  startZ: number;
  /**
   * The flight's height {@link Projectile.maxDist} along it — with {@link Projectile.startZ}, the
   * slope the launch fixed.
   */
  endZ: number;
  angleRad: number;
  speed: number;
  /**
   * How far the flight may run (map units): `World.mapSpan` at launch, cut to where a wall stopped
   * it once one has. docs/combat.md § Where an impact sits.
   */
  maxDist: number;
  traveled: number;
  /**
   * SpriteBank name (PROJECTILE_FRAMES's key), so the impact explosion can look it up in
   * IMPACT_EFFECTS.
   */
  sprite: string;
  /**
   * This missile's own `mobjinfo.radius`, from `PROJECTILE_RADIUS` — half of the contact distance
   * to any body it passes.
   */
  radius: number;
  /** Direct-hit damage, applied to whatever body this strikes in flight. */
  damage: number;
  /**
   * Splash to apply at the impact point regardless of what was targeted, or null for a
   * non-explosive projectile — see weapons.ts's WeaponDef.splash.
   */
  splash: { radius: number; damage: number; hitsPlayer: boolean } | null;
  /**
   * The BFG's real A_BFGSpray secondary attack, straight from weapons.ts's WeaponDef.spray — null
   * for every projectile but the player's own BFG ball (monsters never fire one).
   */
  spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number } | null;
  /**
   * The monster that fired this, or the shooting player's slot as `targetOfSlot` encodes one
   * (`< 0`). Only a *player*'s own missiles are told apart by this — every
   * projectile, whoever fired it, re-tests what it has run into every frame
   * against live positions rather than resolving hit-or-miss up front. See
   * docs/monster-attacks.md § Monster projectiles in flight.
   */
  sourceId: number;
  /**
   * The firing monster's doomednum, for `sameSpecies` — vanilla's "don't hit same species as
   * originator" rule on projectiles.
   */
  sourceType: number;
  /**
   * The wall that stopped this flight, or null while none has — so a shoot-triggered special fires
   * on *arrival*, and only if the flight really got to that wall: a missile stopped by a body or by
   * the floor never reached it. A hitscan pellet triggers immediately in `spawnPlayerShot` instead.
   * See docs/combat.md § Shoot-triggered specials.
   */
  lineIndex: number | null;
  /**
   * Present only for the revenant's missile (`MT_TRACER`/`A_Tracer`), whose path isn't the fixed
   * origin+angle+distance line every other projectile flies, so it carries its own live
   * position/heading. `targetId` is what it chases, as `PosedThing.targetId` encodes one. A
   * {@link Projectile.homing} object existing at all means this shot won its `homingBias` roll.
   * See docs/monster-attacks.md § The revenant's homing missile.
   */
  homing?: { targetId: number; x: number; y: number; z: number; headingRad: number; smokeTimer: number };
  /**
   * Where this missile is now and where it was one tic ago, written by `ProjectileLayer.update` so
   * `draw` can interpolate between them. Held as plain coordinates rather than recomputed from
   * {@link Projectile.traveled}, because a homing missile has no scalar to recompute from — it
   * carries its own position. A missile is the fastest thing on screen, so this is the
   * interpolation that matters most. docs/frameloop.md § Interpolation.
   */
  drawX: number;
  drawY: number;
  drawZ: number;
  drawPrevX: number;
  drawPrevY: number;
  drawPrevZ: number;
  /** The heading its sprite is posed at, which for a homing missile turns in flight. */
  drawAngleRad: number;
  /** Sector light at its current position, re-read every tic — see `update`. */
  drawLight: number;
}

/**
 * Every missile in `info.c` is 8 units tall, so one constant covers the lower
 * half of `PIT_CheckThing`'s over/under test: a shot passes *underneath* when
 * `missile.z + height < target.z` and *overhead* when `missile.z > target.z +
 * target.height`. That band is deliberately asymmetric about the target's feet
 * — see docs/monster-attacks.md § Monster projectiles in flight.
 */
const PROJECTILE_HEIGHT = 8;

/**
 * Turns `from` toward `to` by at most `maxDelta`, the short way around — the continuous equivalent
 * of `A_Tracer`'s own clamped per-call turn (see `REVENANT_TRACER_TURN_RATE_RAD`).
 *
 * @param from  radians
 * @param to    radians
 */
export function turnToward(from: number, to: number, maxDelta: number): number {
  const diff = atan2(sin(to - from), cos(to - from));
  return from + Math.max(-maxDelta, Math.min(maxDelta, diff));
}

/**
 * Vanilla's `PIT_CheckThing` for a missile, as one frame's worth of flight: where along the step
 * `from`→`to` the projectile **first touches** `body`, or null if it passed it. Both halves are the
 * real vanilla test rather than a tolerance — laterally the axis-aligned
 * `thing->radius + tmthing->radius` box ({@link segmentEntersBox}, swept along the step),
 * vertically the asymmetric overhead/underneath pair, evaluated at the moment of contact.
 * See docs/monster-attacks.md § Monster projectiles in flight.
 *
 * @param bodyHeight  the target's own `mobjinfo.height` (`MonsterRef.height`) or `PLAYER_HEIGHT`,
 *                    per-species like the radius
 */
export function stepTouchesBody(
  from: Pos3,
  to: Pos3,
  body: Pos3,
  bodyRadius: number,
  bodyHeight: number,
  missileRadius: number,
): number | null {
  const t = segmentEntersBox(from.x, from.y, to.x, to.y, body.x, body.y, bodyRadius + missileRadius);
  if (t === null) return null;
  const z = from.z + (to.z - from.z) * t;
  if (z + PROJECTILE_HEIGHT < body.z || z > body.z + bodyHeight) return null;
  return t;
}
