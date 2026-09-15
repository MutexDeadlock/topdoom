/**
 * Resolving a hit into damage: {@link CombatContext} (the live level every shot, projectile and
 * blast resolves against), damage application to player/monsters/barrels, and splash (radius)
 * damage. See docs/combat.md § How a shot deals damage and § Splash and the BFG.
 */
import { type World } from './world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS, type Player } from './player.ts';
// Type-only, deliberately: a value import here would put `things.ts` — and so
// `monsters/ai.ts`, which it imports — in the runtime graph of everything that
// resolves damage, `monsters/attacks.ts` and `monsters/vile.ts` included. Its
// splash constants live in `things/tables.ts` to keep that true.
// docs/monster-attacks.md § Resolving an attack.
import type { BarrelExplosion, ThingLayer } from './things.ts';
import { BARREL_SPLASH_DAMAGE, BARREL_SPLASH_RADIUS } from './things/tables.ts';
import { ThingType } from './things/doomednums.ts';
import { AIM_SLOPE_LIMIT, slotOfTarget, targetOfSlot, type MonsterRef } from './things/defs.ts';
import type { Pos2, Pos3 } from '../types.ts';
import { blastDistanceToBox, traceHitsBox } from '../util/geom.ts';
import { cos, sin } from '../util/fdlibm.ts';

/**
 * What killed the player, carried alongside a hit so the death overlay can name
 * it. A doomednum is the thing that did it (a monster, or the barrel it went
 * off in); the three strings are the causes with no attacker behind them —
 * `'self'` is the player's own splash. See docs/death.md § Player death.
 */
export type DamageCause = number | (typeof DAMAGE_CAUSE_NAMES)[number];

/** `v` where it is a {@link DamageCause}, else undefined — how a file's is read. */
export function asDamageCause(v: unknown): DamageCause | undefined {
  return typeof v === 'number' ? v : DAMAGE_CAUSE_NAMES.find((cause) => cause === v);
}

/**
 * Everything about a hit on a player except how hard it lands — `DamageHit` for a slot. Every field
 * is optional; so is the record.
 */
export interface PlayerHit {
  /** Where it physically came from, which drives knockback; absent for damage floors and crushers. */
  from?: Pos2;
  /** Who to name if this is the hit that kills. */
  cause?: DamageCause;
  /**
   * The player whose hit it was, where a player's — the frag a killing one is, in a deathmatch
   * (docs/multiplayer-deathmatch.md § Frags). A hit on themselves names their own slot.
   */
  slot?: number;
  /**
   * The monster whose hit it was, where a monster's — its own, or a barrel's it set off: vanilla's
   * non-player `source`, which a killing hit credits nobody for. Absent beside an absent
   * {@link PlayerHit.slot} is `!source` — a crusher, a damage floor, a barrel nobody set off.
   * docs/multiplayer-deathmatch.md § Frags.
   */
  source?: { id: number; type: number };
}

/**
 * The live level as the combat systems (`game/projectiles.ts` and
 * `game/monsters/attacks.ts`) see it: the state they need to read, plus the
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
  /**
   * Every player slot by index — what a {@link targetOfSlot} id names.
   * docs/multiplayer.md § Player slots.
   */
  readonly slots: readonly CombatSlot[];
  /**
   * Whether a player's shots and missiles hit the other players: a deathmatch, or coop with
   * friendly fire on. docs/multiplayer-deathmatch.md § Player versus player.
   */
  readonly pvp: boolean;
  /** Armor-mitigated damage to one player, and its knockback; a corpse takes neither. */
  damageSlot(slot: number, amount: number, hit?: PlayerHit): void;
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
 * find: the named slot's for a {@link targetOfSlot} id, and player 1's otherwise — the monster it
 * chose can have died to an earlier attack of the same tic, and its shot has always gone at the
 * player then.
 */
export function fallbackPlayer(ctx: CombatContext, targetId: number): Player {
  return ctx.slots[targetId < 0 ? slotOfTarget(targetId) : 0].player;
}

/**
 * The monster `targetId` names, dead or alive — an attack already under way plays out against a
 * corpse (docs/monster-ai.md § Losing the target).
 *
 * @returns null for a slot's ID, or a stale one
 */
export function targetMonster(ctx: CombatContext, targetId: number): MonsterRef | null {
  return targetId < 0 ? null : (ctx.things?.bodyById(targetId) ?? null);
}

/**
 * The body `targetId` names, dead or alive: the slot's player, or {@link targetMonster}'s monster.
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
 * The nearest body along a player's shot: {@link ThingLayer.raycastMonster}, and — where a player
 * can be shot ({@link CombatContext.pvp}) — {@link raycastPlayers}, a monster winning a tie. The
 * one place a player's trace asks for both. docs/multiplayer-deathmatch.md § Player versus player.
 *
 * @param shooter  the firing slot, which its own shot never hits
 * @param slope  the slope a locked shot flies at; absent, `P_AimLineAttack`'s cone
 */
export function raycastBody(
  ctx: CombatContext,
  origin: Pos3,
  angleRad: number,
  maxDist: number,
  shooter: number,
  slope?: number,
): (MonsterRef & { dist: number }) | null {
  const monster = ctx.things?.raycastMonster(origin, angleRad, maxDist, { slope }) ?? null;
  if (!ctx.pvp) return monster;
  const player = raycastPlayers(ctx, origin, angleRad, maxDist, shooter, slope);
  return player && (!monster || player.dist < monster.dist) ? player : monster;
}

/**
 * The nearest living player along a shot — `PTR_ShootTraverse` over the players' bodies, which are
 * not in the thing layer: {@link ThingLayer.raycastMonster}'s box and vertical test over
 * {@link PLAYER_RADIUS}/{@link PLAYER_HEIGHT}, each body as {@link playerRef}. A player's shot
 * under {@link CombatContext.pvp} and every monster bolt (`monsters/attacks.ts`) trace through it.
 * docs/multiplayer-deathmatch.md § Player versus player, docs/combat.md § The vertical test.
 *
 * @param shooter  the firing slot, which its own shot never hits; -1 for a monster's bolt
 * @param slope    the slope a fixed shot flies at; absent, `P_AimLineAttack`'s cone
 */
export function raycastPlayers(
  ctx: CombatContext,
  origin: Pos3,
  angleRad: number,
  maxDist: number,
  shooter: number,
  slope?: number,
): (MonsterRef & { dist: number }) | null {
  const dx = cos(angleRad);
  const dy = sin(angleRad);
  const topSlope = slope ?? AIM_SLOPE_LIMIT;
  const bottomSlope = slope ?? -AIM_SLOPE_LIMIT;
  let nearest: (MonsterRef & { dist: number }) | null = null;
  for (let slot = 0; slot < ctx.slots.length; slot++) {
    const { player, dead } = ctx.slots[slot];
    if (slot === shooter || dead) continue;
    const t = traceHitsBox(origin.x, origin.y, dx, dy, player.x, player.y, PLAYER_RADIUS);
    if (t === null || t > maxDist || (nearest && t >= nearest.dist)) continue;
    const dist = Math.max(t, 1e-6);
    if ((player.z + PLAYER_HEIGHT - origin.z) / dist < bottomSlope) continue;
    if ((player.z - origin.z) / dist > topSlope) continue;
    nearest = playerRef(slot, player, origin.x + dx * t, origin.y + dy * t, t);
  }
  return nearest;
}

/**
 * Slot `slot`'s player as a {@link MonsterRef} a shot or an aim pick resolves the way it resolves
 * a monster: {@link targetOfSlot}'s id, the player's own box, and `MT_PLAYER`'s doomednum, -1
 * (`info.c`), for the type.
 *
 * @param x  where the ray met the body, as `y` is
 * @param dist  how far along the ray that was
 */
export function playerRef(slot: number, player: Player, x: number, y: number, dist: number): MonsterRef & { dist: number } {
  return {
    id: targetOfSlot(slot),
    x,
    y,
    z: player.z,
    dist,
    type: PLAYER_BODY_TYPE,
    height: PLAYER_HEIGHT,
    angle: player.angle,
    radius: PLAYER_RADIUS,
  };
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
 * falling off linearly to 0 there. Range is {@link blastDistanceToBox}, not a centre-to-centre
 * distance; **2D distance only, no height check**, as in vanilla.
 * docs/combat.md § Splash and the BFG.
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
    ctx.things?.damage(m.id, splashDamage(maxDamage, radius, dist), { source, slot, from: at });
  }

  if (!hitsPlayer) return;
  for (let victim = 0; victim < ctx.slots.length; victim++) {
    const { player, dead } = ctx.slots[victim];
    if (dead) continue;
    const pdist = blastDistanceToBox(at.x, at.y, player.x, player.y, PLAYER_RADIUS);
    if (pdist < radius && ctx.world.hasLineOfSight(at, player)) {
      // A player's own shot names its shooter to everyone else it reaches, and stays their own
      // to themselves; a barrel keeps blaming the barrel, the credit riding on `slot` or `source`.
      const named = slot !== undefined && slot !== victim && cause === 'self' ? targetOfSlot(slot) : cause;
      ctx.damageSlot(victim, splashDamage(maxDamage, radius, pdist), { from: at, cause: named, slot, source });
    }
  }
}

/**
 * What a blast deals one body, in whole points: vanilla's `bombdamage - dist` wherever `radius`
 * equals `maxDamage`, truncated as C's division is. docs/combat.md § Splash and the BFG.
 *
 * @param maxDamage  what a body at range 0 takes
 * @param radius     the range in map units over which the damage falls off to 0
 * @param dist       whole map units from the blast to the body's edge ({@link blastDistanceToBox}),
 *                   below `radius`: a body at or beyond it is skipped before this is asked
 * @returns the damage, 0 or more
 */
export function splashDamage(maxDamage: number, radius: number, dist: number): number {
  return Math.trunc((maxDamage * (radius - dist)) / radius);
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

/** {@link DamageCause}'s strings: the causes with no attacker behind them. */
const DAMAGE_CAUSE_NAMES = ['self', 'crush', 'slime'] as const;

/** `MT_PLAYER`'s `doomednum` (`info.c`): what a player stands as where a body's type is asked. */
const PLAYER_BODY_TYPE = -1;
