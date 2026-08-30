/**
 * Resolving a hit into damage: `CombatContext` (the live level every shot, projectile and blast
 * resolves against), damage application to player/monsters/barrels, and splash (radius) damage.
 * See docs/combat.md § How a shot deals damage and § Splash and the BFG.
 */
import { type World } from './world.ts';
import { PLAYER_RADIUS, type Player } from './player.ts';
// Type-only, deliberately: a value import here would put `things.ts` — and so
// `monsters/ai.ts`, which it imports — in the runtime graph of everything that
// resolves damage, `monsters/attacks.ts` and `monsters/vile.ts` included. Its
// splash constants live in `things/tables.ts` to keep that true.
// docs/monster-attacks.md § Resolving an attack.
import type { BarrelExplosion, ThingLayer } from './things.ts';
import { BARREL_SPLASH_DAMAGE, BARREL_SPLASH_RADIUS } from './things/tables.ts';
import { ThingType } from './things/doomednums.ts';
import type { Pos2, Pos3 } from '../types.ts';
import { blastDistanceToBox } from '../util/geom.ts';

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
  /**
   * The same, for a hitscan shot that has just resolved: fires every shoot line
   * the trace `from`→`to` crossed, and `blocker` — whichever line stopped it, or
   * null when a body did — last. `PTR_ShootTraverse` fires a line's special on
   * the way past, not only on the line it stops at; docs/combat.md
   * § Shoot-triggered specials.
   */
  triggerShotPath(from: Pos2, to: Pos2, blocker: number | null, byMonster?: boolean): void;
}

/**
 * One blast, as everything that raises `P_RadiusAttack` describes it: the rocket, the BFG's
 * tracers, a barrel and the arch-vile all fill this same record.
 */
export interface RadiusBlast {
  radius: number;
  maxDamage: number;
  hitsPlayer: boolean;
  source?: { id: number; type: number };
  /**
   * Who the overlay names for a killing blast, when that is not `source`'s own type: a barrel
   * blames the barrel rather than whoever set it off, and a shot of the player's has no `source`
   * at all. Left out entirely to mean `source`'s own type.
   */
  cause?: DamageCause;
}

/**
 * An explosion's blast — vanilla's `P_RadiusAttack`: every living body whose
 * **edge** lies within `radius` of the impact point, with an unobstructed line
 * to it, takes damage falling off linearly to 0 there. Range is
 * `blastDistanceToBox` (Chebyshev, minus that body's own radius), not a
 * centre-to-centre distance — which is what makes a wide monster both catchable
 * from further out and hurt harder at any range. `hitsPlayer` gates self-splash
 * ("rocket jump"); `source`, when given, attributes the hit for
 * `ThingLayer.damage`'s retaliation rule. **2D distance only, no height
 * check**, as in vanilla.
 * Vanilla carries one number where this takes two — docs/combat.md § Splash and the BFG.
 */
export function applyRadiusDamage(ctx: CombatContext, at: Pos3, blast: RadiusBlast): void {
  const { radius, maxDamage, hitsPlayer, source } = blast;
  const cause = 'cause' in blast ? blast.cause : source?.type;
  for (const m of ctx.things?.monstersNear(at, radius) ?? []) {
    // Vanilla's PIT_RadiusAttack: the spider mastermind and cyberdemon take
    // no concussion/splash damage at all, direct hits only.
    if (m.type === ThingType.spiderMastermind || m.type === ThingType.cyberdemon) continue;
    const dist = blastDistanceToBox(at.x, at.y, m.x, m.y, m.radius);
    if (dist >= radius || !ctx.world.hasLineOfSight(at, m)) continue;
    ctx.things?.damage(m.id, maxDamage * (1 - dist / radius), { source, from: at });
  }

  if (!hitsPlayer) return;
  const pdist = blastDistanceToBox(at.x, at.y, ctx.player.x, ctx.player.y, PLAYER_RADIUS);
  if (pdist < radius && ctx.world.hasLineOfSight(at, ctx.player)) {
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
  applyRadiusDamage(ctx, exp, {
    radius: BARREL_SPLASH_RADIUS,
    maxDamage: BARREL_SPLASH_DAMAGE,
    hitsPlayer: true,
    source: exp.source,
    cause: ThingType.barrel,
  });
}
