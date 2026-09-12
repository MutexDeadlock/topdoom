/**
 * Resolving a hit into damage: {@link CombatContext} (the live level every shot, projectile and
 * blast resolves against), damage application to player/monsters/barrels, and splash (radius)
 * damage. See docs/combat.md § How a shot deals damage and § Splash and the BFG.
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
import { slotOfTarget, type MonsterRef } from './things/defs.ts';
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
 * Everything about a hit on a player except how hard it lands — `DamageHit` for a slot. Every field
 * is optional; so is the record.
 */
export interface PlayerHit {
  /** Where it physically came from, which drives knockback; absent for damage floors and crushers. */
  from?: Pos2;
  /** Who to name if this is the hit that kills. */
  cause?: DamageCause;
}

/**
 * The live level as the combat systems (`game/projectiles.ts` and the shot
 * resolution still in `game.ts`) see it: the state they need to read, plus the
 * two effects they raise that belong to somebody else.
 *
 * Every member is a **getter, not a captured value** — {@link CombatContext.world},
 * {@link CombatContext.things} and the player are all replaced on a map load, and `Game` implements
 * this as one object literal that reads its own live level. {@link CombatContext.things} is
 * nullable for the tests, which stub a context with none.
 */
export interface CombatContext {
  readonly world: World;
  readonly things: ThingLayer | null;
  /** Every player slot by index — what a `targetOfSlot` id names. docs/multiplayer.md § Player slots. */
  readonly slots: readonly CombatSlot[];
  /**
   * Armor-mitigated damage to one player.
   *
   * @returns whether the hit actually landed (`false` covers both a corpse hit and invulnerability)
   */
  damageSlot(slot: number, amount: number, hit?: PlayerHit): boolean;
  /**
   * Fires a shoot-triggered line special, with whatever keys the shooting player is carrying.
   *
   * @param shooter  `null` is a monster's stray shot, which reproduces vanilla's own hardcoded
   *                 exception — docs/combat.md § Shoot-triggered specials
   */
  triggerShot(lineIndex: number | null, shooter: number | null): void;
  /**
   * The same, for a hitscan shot that has just resolved: fires every shoot line the trace
   * `from`→`to` crossed, and `blocker` last. `PTR_ShootTraverse` fires a line's special on the way
   * past, not only on the line it stops at; docs/combat.md § Shoot-triggered specials.
   *
   * @param blocker  whichever line stopped the trace, or null when a body did
   */
  triggerShotPath(from: Pos2, to: Pos2, blocker: number | null, shooter: number | null): void;
}

/**
 * What combat reads of a player slot: the body, and whether it still is one. `PlayerSlot`
 * (`game/playerslot.ts`) satisfies it; a test stubs the two fields.
 */
export interface CombatSlot {
  readonly player: Player;
  /** True once this player's health has hit 0 — see docs/death.md § Player death. */
  readonly dead: boolean;
}

/**
 * The player a monster's attack falls back on when what it aimed at is not a monster it can still
 * find: the named slot's for a `targetOfSlot` id, and player 1's otherwise — the monster it chose
 * can have died to an earlier attack of the same tic, and its shot has always gone at the player
 * then.
 */
export function fallbackPlayer(ctx: CombatContext, targetId: number): Player {
  return ctx.slots[targetId < 0 ? slotOfTarget(targetId) : 0].player;
}

/**
 * The monster `targetId` names.
 *
 * @returns null for a slot's ID, or a monster that can no longer be found
 */
export function targetMonster(ctx: CombatContext, targetId: number): MonsterRef | null {
  return targetId < 0 ? null : (ctx.things?.monsterById(targetId) ?? null);
}

/**
 * The body `targetId` names: the slot's player, dead or alive, or the monster while it can still be
 * found.
 */
export function targetBody(ctx: CombatContext, targetId: number): Player | MonsterRef | null {
  return targetId < 0 ? ctx.slots[slotOfTarget(targetId)].player : targetMonster(ctx, targetId);
}

/** The slot's player while alive, or null — what a homing shot chases and a BFG spray fires from. */
export function livingPlayer(slot: CombatSlot): Player | null {
  return slot.dead ? null : slot.player;
}

/** Whether any slot's player is still alive — `A_BossDeath`'s gate, the level clock's, the Icon's. */
export function anyPlayerAlive(slots: readonly CombatSlot[]): boolean {
  for (const slot of slots) if (!slot.dead) return true;
  return false;
}

/**
 * One blast, as everything that raises `P_RadiusAttack` describes it: the rocket, the BFG's
 * tracers, a barrel and the arch-vile all fill this same record.
 */
export interface RadiusBlast {
  radius: number;
  maxDamage: number;
  /** Gates self-splash ("rocket jump"). */
  hitsPlayer: boolean;
  /** When given, attributes the hit for {@link ThingLayer.damage}'s retaliation rule. */
  source?: { id: number; type: number };
  /** The player whose blast it is, where a player's — `DamageHit.slot`. */
  slot?: number;
  /**
   * Who the overlay names for a killing blast, when that is not {@link RadiusBlast.source}'s own
   * type: a barrel blames the barrel rather than whoever set it off, and a shot of the player's has
   * no {@link RadiusBlast.source} at all. Left out entirely to mean {@link RadiusBlast.source}'s
   * own type.
   */
  cause?: DamageCause;
}

/**
 * An explosion's blast — vanilla's `P_RadiusAttack`: every living body whose **edge** lies within
 * {@link RadiusBlast.radius} of the impact point, with an unobstructed line to it, takes damage
 * falling off linearly to 0 there. Range is {@link blastDistanceToBox} (Chebyshev, minus that
 * body's own radius), not a centre-to-centre distance — which is what makes a wide monster both
 * catchable from further out and hurt harder at any range. **2D distance only, no height check**,
 * as in vanilla.
 * Vanilla carries one number where this takes two — docs/combat.md § Splash and the BFG.
 */
export function applyRadiusDamage(ctx: CombatContext, at: Pos3, blast: RadiusBlast): void {
  const { radius, maxDamage, hitsPlayer, source, slot } = blast;
  const cause = 'cause' in blast ? blast.cause : source?.type;
  for (const m of ctx.things?.monstersNear(at, radius) ?? []) {
    // Vanilla's PIT_RadiusAttack: the spider mastermind and cyberdemon take
    // no concussion/splash damage at all, direct hits only.
    if (m.type === ThingType.spiderMastermind || m.type === ThingType.cyberdemon) continue;
    const dist = blastDistanceToBox(at.x, at.y, m.x, m.y, m.radius);
    if (dist >= radius || !ctx.world.hasLineOfSight(at, m)) continue;
    ctx.things?.damage(m.id, maxDamage * (1 - dist / radius), { source, slot, from: at });
  }

  if (!hitsPlayer) return;
  for (let slot = 0; slot < ctx.slots.length; slot++) {
    const { player, dead } = ctx.slots[slot];
    if (dead) continue;
    const pdist = blastDistanceToBox(at.x, at.y, player.x, player.y, PLAYER_RADIUS);
    if (pdist < radius && ctx.world.hasLineOfSight(at, player)) {
      ctx.damageSlot(slot, maxDamage * (1 - pdist / radius), { from: at, cause });
    }
  }
}

/**
 * A barrel's `A_Explode` — vanilla's literal `P_RadiusAttack(thingy, thingy->target, 128)`, the
 * same shape as the rocket's splash with `exp.source` and `exp.slot` standing in for
 * `thingy->target`. Barrels are in {@link ThingLayer.monstersNear}, so a second one caught in the
 * blast chains through the ordinary damage path (docs/death.md § Exploding barrels).
 */
export function applyBarrelExplosion(ctx: CombatContext, exp: BarrelExplosion): void {
  // The barrel, not `exp.source`: retaliation follows whoever set it off,
  // but what killed the player is the barrel they were standing next to.
  applyRadiusDamage(ctx, exp, {
    radius: BARREL_SPLASH_RADIUS,
    maxDamage: BARREL_SPLASH_DAMAGE,
    hitsPlayer: true,
    source: exp.source,
    slot: exp.slot,
    cause: ThingType.barrel,
  });
}
