import { hasLineOfSight, type World } from './world.ts';
import type { Player } from './player.ts';
// Type-only, deliberately: a value import here would put `things.ts` — and so
// `monsters/ai.ts`, which it imports — in the runtime graph of everything that
// resolves damage, `monsters/attacks.ts` and `monsters/vile.ts` included. Its
// splash constants live in `thingdefs.ts` to keep that true.
// docs/monster-attacks.md § Resolving an attack.
import type { BarrelExplosion, ThingLayer } from './things.ts';
import { BARREL_SPLASH_DAMAGE, BARREL_SPLASH_RADIUS } from './thingdefs.ts';
import { ThingType } from './thingtypes.ts';
import type { Pos3 } from '../types.ts';

/**
 * What killed the player, carried alongside a hit so the death overlay can name
 * it. A doomednum is the thing that did it (a monster, or the barrel it went
 * off in); the three strings are the causes with no attacker behind them —
 * `'self'` is the player's own splash. See docs/death.md § Player death.
 */
export type DamageCause = number | 'self' | 'crush' | 'slime';

/**
 * The live level as the combat systems (`game/projectiles.ts` and the shot
 * resolution still in `game.ts`) see it: the state they need to read, plus the
 * two effects they raise that belong to somebody else.
 *
 * Every member is a **getter, not a captured value** — `world`, `things` and
 * the player are all replaced on a map load, and `Game` implements this as one
 * object literal that reads its own live fields. `things` is nullable for the
 * same reason it is on `Game` itself: a level is briefly loaded without one.
 */
export interface CombatContext {
  readonly world: World;
  readonly things: ThingLayer | null;
  readonly player: Player;
  /** True once the player's health has hit 0 — see docs/death.md § Player death. */
  readonly playerDead: boolean;
  /**
   * Armor-mitigated damage to the player, returning whether the hit actually
   * landed (`false` covers both a corpse hit and invulnerability). `fromX`/
   * `fromY` are where it physically came from, and drive knockback; `cause`
   * is who to name if this is the hit that kills.
   */
  damagePlayer(amount: number, fromX?: number, fromY?: number, cause?: DamageCause): boolean;
  /**
   * Fires a shoot-triggered line special, with whatever keys the player is
   * currently carrying. `byMonster` reproduces vanilla's own hardcoded
   * exception for a monster's stray shot — docs/combat.md § Shoot-triggered specials.
   */
  triggerShot(lineIndex: number | null, byMonster?: boolean): void;
}

/**
 * An explosion's blast — vanilla's `P_RadiusAttack`: every living monster
 * within `radius` with an unobstructed line to the impact point takes damage
 * falling off linearly to 0 at the edge. `hitsPlayer` gates self-splash
 * ("rocket jump"); `source`, when given, attributes the hit for
 * `ThingLayer.damage`'s retaliation rule. **2D distance only, no height
 * check**, as in vanilla. See docs/combat.md § Splash and the BFG.
 */
export function applyRadiusDamage(
  ctx: CombatContext,
  at: Pos3,
  radius: number,
  maxDamage: number,
  hitsPlayer: boolean,
  source?: { id: number; type: number },
  /**
   * Who the overlay names for a killing blast, when that is not `source`'s own
   * type: a barrel blames the barrel rather than whoever set it off, and a
   * shot of the player's has no `source` at all.
   */
  cause: DamageCause | undefined = source?.type,
): void {
  for (const m of ctx.things?.monstersNear(at, radius) ?? []) {
    // Vanilla's PIT_RadiusAttack: the spider mastermind and cyberdemon take
    // no concussion/splash damage at all, direct hits only.
    if (m.type === ThingType.spiderMastermind || m.type === ThingType.cyberdemon) continue;
    const dist = Math.hypot(m.x - at.x, m.y - at.y);
    if (dist >= radius || !hasLineOfSight(ctx.world, at, m)) continue;
    ctx.things?.damage(m.id, maxDamage * (1 - dist / radius), source, undefined, at.x, at.y);
  }

  if (!hitsPlayer) return;
  const pdist = Math.hypot(ctx.player.x - at.x, ctx.player.y - at.y);
  if (pdist < radius && hasLineOfSight(ctx.world, at, ctx.player)) {
    ctx.damagePlayer(maxDamage * (1 - pdist / radius), at.x, at.y, cause);
  }
}

/**
 * A barrel's `A_Explode` — vanilla's literal `P_RadiusAttack(thingy,
 * thingy->target, 128)`, the same shape as the rocket's splash with
 * `exp.source` standing in for `thingy->target`. Barrels are in
 * `monstersNear`, so a second one caught in the blast chains through the
 * ordinary damage path (docs/death.md § Exploding barrels).
 */
export function applyBarrelExplosion(ctx: CombatContext, exp: BarrelExplosion): void {
  // The barrel, not `exp.source`: retaliation follows whoever set it off,
  // but what killed the player is the barrel they were standing next to.
  applyRadiusDamage(ctx, exp, BARREL_SPLASH_RADIUS, BARREL_SPLASH_DAMAGE, true, exp.source, ThingType.barrel);
}
