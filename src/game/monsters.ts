import type { Sector } from '../wad/map.ts';
import { hasLineOfSight, slideMove, type World } from './world.ts';
import { GRAVITY } from './player.ts';
import { rollDamage } from './weapons.ts';

/**
 * The mutable chase/attack state `stepMonsterAI` reads and writes, kept alive
 * across frames on the caller's own object. `game/things.ts`'s
 * `PosedThing` structurally satisfies this — it carries these fields plus a
 * pile of rendering-only ones (`actor`, `light`, `dead`, ...) this function
 * never touches, so it's passed in directly rather than copied in and out.
 *
 * This function is only ever called once a monster is alerted — waking up is
 * `tryWake`'s job below, called from `game/things.ts`'s `ThingLayer.update`
 * throttled to roughly vanilla's own "look" cadence rather than every frame;
 * see that file's `LOOK_INTERVAL`.
 */
export interface MonsterBody {
  x: number;
  y: number;
  /** Feet height. */
  z: number;
  velZ: number;
  /** Facing/movement direction, radians — same convention as `Player.angle`. */
  angle: number;
  attackCooldown: number;
  /** >0 while staggered by a recent hit; movement and attacks pause until it drops to 0 (see `reactToDamage`). */
  painTimer: number;
  /**
   * Seconds since the last stuck-detection sample. There's no pathfinding
   * here (same as vanilla, which routinely gets monsters wedged on complex
   * geometry too) — this is the fallback that keeps a blocked monster from
   * standing frozen against a wall forever: every `STUCK_CHECK_INTERVAL` it
   * compares the current position against `stuckX`/`stuckY` (the position at
   * the *previous* sample), and if it barely moved, picks a random lateral
   * `jitterAngle` to blend into the chase direction for a bit.
   */
  stuckTimer: number;
  stuckX: number;
  stuckY: number;
  jitterAngle: number;
  jitterTimer: number;
}

export interface AttackStats {
  /**
   * Map units. Melee is vanilla's ~64-unit MELEERANGE plus a little slack for
   * this engine's coarser per-frame distance sampling (see `MELEE_RANGE`);
   * ranged ranges are tuned by feel, the same simplification `speed` below
   * and player.ts's `GRAVITY`/weapons.ts's fire rates already make for values
   * that don't survive a clean conversion from vanilla's tic-based tables.
   */
  range: number;
  diceSides: number;
  diceMult: number;
  /** Seconds between attacks. */
  cooldown: number;
}

export interface MonsterStats {
  /**
   * Map units/sec while chasing. Tuned by feel and scaled roughly to
   * vanilla's *relative* fast/slow monster feel (the demon and arch-vile are
   * fast, the mancubus is slow) rather than converted from vanilla's
   * tic-based `mobjinfo` speed field, which doesn't translate to a dt-scaled
   * model any more cleanly than player.ts's `GRAVITY` does.
   */
  speed: number;
  /**
   * Movement/collision circle radius. A single approximate value per type
   * rather than vanilla's real (and for some monsters very different,
   * 16-128 unit) per-species radius — the same simplification
   * `game/things.ts`'s `MONSTER_HIT_RADIUS` already makes for being shot.
   */
  radius: number;
  melee: AttackStats | null;
  ranged: AttackStats | null;
  /**
   * 0..1 probability a hit staggers this monster into a brief pause
   * (`reactToDamage`) instead of continuing whatever it was doing. Low for
   * the big bosses — they shrug off hits, matching vanilla's own very low
   * painchance for things like the cyberdemon — high for the human grunts.
   */
  painChance: number;
}

export interface MonsterAttack {
  kind: 'melee' | 'ranged';
  damage: number;
}

/** Vanilla's own MELEERANGE, plus a little slack for this engine's coarser per-frame (rather than per-tic) distance sampling. */
export const MELEE_RANGE = 72;

/** How long a hit's stagger (`reactToDamage`) pauses a monster for. */
export const PAIN_STAGGER = 0.35;

/**
 * Seconds a freshly-woken monster waits before its *first* attack —
 * vanilla's own `reactiontime`: a monster starts moving toward the player
 * the instant it spots them, but the attack itself is held off a beat.
 * Without this, a monster with a long sightline (or a big ranged attack
 * range — see `MONSTER_STATS`) fires the exact frame it happens to gain
 * line of sight, which reads as attacking before it could plausibly have
 * noticed the player at all. `tryWake` seeds `attackCooldown` with this the
 * moment a monster's wake check succeeds, reusing the same field the attack
 * loop already checks rather than adding a second timer. A flat delay rather
 * than vanilla's varied per-monster tic value, the same "tuned by feel"
 * simplification as `MonsterStats.speed`.
 */
export const REACTION_TIME = 0.5;

const STUCK_CHECK_INTERVAL = 0.5;
const STUCK_MOVE_EPSILON = 6;
const JITTER_DURATION = 0.6;

/**
 * A monster more than this far above/below the player can't actually engage
 * it (attack or count as "close enough" to stop closing) even with a clear
 * line of sight — the same overhead/underneath gate `ThingLayer.tryPickup`
 * already applies for picking an item up through a window onto a floor
 * above/below. Movement itself isn't gated by this; a monster still chases
 * toward the player's 2D position, since `slideMove`'s own collision (not
 * this) is what actually keeps it from walking off a ledge it shouldn't.
 */
const MONSTER_ENGAGE_HEIGHT = 128;

/**
 * Height above a monster's feet a ranged attack's tracer is drawn from — the
 * monster's own equivalent of main.ts's `AIM_HEIGHT_OFFSET`.
 */
export const MONSTER_FIRE_HEIGHT = 40;

/**
 * Per-doomednum combat stats, covering every `MONSTER_TYPES` entry except
 * Commander Keen (72) and the boss brain (88) — neither attacks or moves in
 * vanilla either (Keen's "death" is a pain cascade with no real combat
 * state, the boss brain is a stationary cube-spawner with no player-facing
 * attack this engine models), so both stay exactly as decorative/passive as
 * they were before monster AI existed.
 *
 * Ranged attacks are modeled as an instant hitscan-style bolt (a tracer,
 * main.ts) rather than vanilla's own flying fireball/rocket projectile per
 * monster type (imp BAL1, cacodemon BAL2, baron/knight BAL7, revenant's
 * homing missile, mancubus/arachnotron's paired shots, cyberdemon rockets,
 * spider mastermind's chaingun, arch-vile's fire column) — a distinct flight
 * sprite, speed and (for the revenant) homing behavior per monster type is a
 * lot of extra bookkeeping for a difference that mostly reads the same to
 * the player as this engine's own hitscan tracers already do. Damage values
 * here are tuned for game balance/feel rather than lifted from vanilla's own
 * per-monster damage rolls, the same reasoning weapons.ts's fire rates and
 * spread already use. There's also no monster-vs-monster infighting and
 * monsters don't physically block the player (or each other) on contact —
 * both real vanilla behaviors, both left out of this milestone's scope, the
 * same kind of honestly-noted gap as crushers not blocking movers on contact
 * (see CLAUDE.md).
 */
export const MONSTER_STATS: Record<number, MonsterStats> = {
  3004: { speed: 220, radius: 20, melee: null, ranged: { range: 1400, diceSides: 3, diceMult: 3, cooldown: 0.9 }, painChance: 0.7 }, // POSS zombieman
  9: { speed: 220, radius: 20, melee: null, ranged: { range: 1400, diceSides: 3, diceMult: 5, cooldown: 1.3 }, painChance: 0.6 }, // SPOS shotgun guy
  65: { speed: 220, radius: 20, melee: null, ranged: { range: 1400, diceSides: 2, diceMult: 3, cooldown: 0.25 }, painChance: 0.5 }, // CPOS chaingunner
  84: { speed: 240, radius: 20, melee: null, ranged: { range: 1400, diceSides: 2, diceMult: 3, cooldown: 0.3 }, painChance: 0.6 }, // SSWV Wolfenstein SS
  3001: {
    speed: 240,
    radius: 20,
    melee: { range: MELEE_RANGE, diceSides: 6, diceMult: 3, cooldown: 0.8 },
    ranged: { range: 1000, diceSides: 6, diceMult: 3, cooldown: 1.4 },
    painChance: 0.5,
  }, // TROO imp
  3002: { speed: 320, radius: 30, melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 4, cooldown: 0.7 }, ranged: null, painChance: 0.4 }, // SARG demon
  58: { speed: 320, radius: 30, melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 4, cooldown: 0.7 }, ranged: null, painChance: 0.4 }, // SARG spectre (same as demon; no invisibility rendering)
  3006: { speed: 260, radius: 16, melee: { range: MELEE_RANGE, diceSides: 4, diceMult: 3, cooldown: 0.6 }, ranged: null, painChance: 0.5 }, // SKUL lost soul
  3005: {
    speed: 220,
    radius: 31,
    melee: { range: MELEE_RANGE, diceSides: 6, diceMult: 6, cooldown: 0.9 },
    ranged: { range: 1200, diceSides: 6, diceMult: 5, cooldown: 1.3 },
    painChance: 0.3,
  }, // HEAD cacodemon
  3003: {
    speed: 240,
    radius: 24,
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 8, cooldown: 0.9 },
    ranged: { range: 1300, diceSides: 8, diceMult: 6, cooldown: 1.6 },
    painChance: 0.2,
  }, // BOSS baron of hell
  69: {
    speed: 260,
    radius: 24,
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 6, cooldown: 0.8 },
    ranged: { range: 1300, diceSides: 8, diceMult: 5, cooldown: 1.5 },
    painChance: 0.25,
  }, // BOS2 hell knight
  71: { speed: 220, radius: 31, melee: null, ranged: { range: 1200, diceSides: 4, diceMult: 3, cooldown: 1.6 }, painChance: 0.3 }, // PAIN pain elemental (stands in for its unmodeled soul-spawn attack)
  66: {
    speed: 280,
    radius: 20,
    melee: { range: MELEE_RANGE, diceSides: 6, diceMult: 4, cooldown: 0.8 },
    ranged: { range: 1600, diceSides: 6, diceMult: 5, cooldown: 1.6 },
    painChance: 0.3,
  }, // SKEL revenant
  67: { speed: 180, radius: 48, melee: null, ranged: { range: 1300, diceSides: 8, diceMult: 6, cooldown: 1.8 }, painChance: 0.2 }, // FATT mancubus
  68: { speed: 260, radius: 64, melee: null, ranged: { range: 1600, diceSides: 3, diceMult: 3, cooldown: 0.3 }, painChance: 0.2 }, // BSPI arachnotron
  7: { speed: 280, radius: 128, melee: null, ranged: { range: 2200, diceSides: 3, diceMult: 4, cooldown: 0.2 }, painChance: 0.1 }, // SPID spider mastermind
  16: { speed: 320, radius: 40, melee: null, ranged: { range: 2400, diceSides: 8, diceMult: 20, cooldown: 1.1 }, painChance: 0.05 }, // CYBR cyberdemon
  64: { speed: 350, radius: 20, melee: null, ranged: { range: 1600, diceSides: 8, diceMult: 8, cooldown: 2.0 }, painChance: 0.15 }, // VILE arch-vile
};

/**
 * Vanilla's own field-of-view gate on `P_LookForPlayers`: a monster only
 * notices the player within roughly its forward 180°, unless the player is
 * close enough to sense regardless (vanilla's `MELEERANGE` exception) — a
 * monster facing away doesn't magically notice someone behind it just
 * because the line between them happens to be clear. `tryWake` only calls
 * this for the initial wake-up check; once alerted, a monster tracks/attacks
 * the player regardless of which way it's currently facing, matching
 * vanilla's own `A_Chase`, which never re-applies the FOV gate to an
 * already-hunting monster.
 */
export function canSpotPlayer(facingDeg: number, monsterX: number, monsterY: number, playerX: number, playerY: number): boolean {
  const dist = Math.hypot(playerX - monsterX, playerY - monsterY);
  if (dist <= MELEE_RANGE) return true;
  const toPlayerDeg = (Math.atan2(playerY - monsterY, playerX - monsterX) * 180) / Math.PI;
  const diff = Math.abs((((toPlayerDeg - facingDeg + 180) % 360) + 360) % 360 - 180);
  return diff <= 90;
}

/** The subset of `PosedThing` (`game/things.ts`) `tryWake` needs — position, facing, its ambush flag, and the two fields it mutates on success. */
export interface WakeCheckBody {
  x: number;
  y: number;
  facingDeg: number;
  ambush: boolean;
  alerted: boolean;
  attackCooldown: number;
}

/**
 * Vanilla's own idle `A_Look`: called from `game/things.ts`'s `ThingLayer.update`
 * once per unalerted monster, throttled there to that file's `LOOK_INTERVAL`
 * rather than every frame (matching vanilla's own idle checks, which run
 * every 10 tics, not continuously). A sound-alerted sector (`World.noiseAlert`,
 * fired on player gunshots) wakes a monster with no sight check at all — unless
 * it's "ambush"/deaf (`game/skill.ts: isAmbush`), which still needs to actually
 * see the source, just without the usual forward-FOV restriction. Either way, a
 * monster that isn't woken by sound still falls through to the ordinary
 * FOV+sight check (`canSpotPlayer` + `hasLineOfSight`) every monster gets,
 * sound-alerted sector or not.
 *
 * On success, mutates `body.alerted` and seeds `attackCooldown` with
 * `REACTION_TIME` (see that constant's doc for why skipping this made a
 * monster with a long sightline attack the instant it came into view, with no
 * perceptible reaction) — the same "mutate the body, report what happened"
 * shape as `stepMonsterAI`. Returns whether it woke, in case the caller wants
 * to react to that moment itself.
 */
export function tryWake(body: WakeCheckBody, world: World, sector: Sector | undefined, playerX: number, playerY: number): boolean {
  const heardIt = !!sector && world.isSoundAlerted(sector);
  const seesDespiteDeaf = body.ambush && heardIt && hasLineOfSight(world, body.x, body.y, playerX, playerY);
  const heardAndAware = !body.ambush && heardIt;
  const spottedNormally =
    canSpotPlayer(body.facingDeg, body.x, body.y, playerX, playerY) && hasLineOfSight(world, body.x, body.y, playerX, playerY);
  if (!seesDespiteDeaf && !heardAndAware && !spottedNormally) return false;
  body.alerted = true;
  body.attackCooldown = REACTION_TIME;
  return true;
}

/**
 * Alerts a monster and, by `stats.painChance`, staggers it — called from
 * `ThingLayer.damage` for any hit that doesn't kill outright. Unconditional
 * on prior line of sight, matching vanilla's own `P_DamageMobj`: a hit always
 * sets the target, sight or no.
 */
export function reactToDamage(body: MonsterBody, stats: MonsterStats): void {
  if (Math.random() < stats.painChance) body.painTimer = Math.max(body.painTimer, PAIN_STAGGER);
}

/** Settles vertical position/velocity the same way `Player.update` does: snap while grounded, integrate gravity while airborne. */
function settleVertical(body: MonsterBody, world: World, radius: number, dt: number): void {
  const groundZ = world.groundFloor(body.x, body.y, radius);
  if (body.z > groundZ) {
    body.velZ -= GRAVITY * dt;
    body.z = Math.max(groundZ, body.z + body.velZ * dt);
    if (body.z === groundZ) body.velZ = 0;
  } else {
    body.z = groundZ;
    body.velZ = 0;
  }
}

/**
 * Advances one already-alerted monster by `dt`: faces and closes on the
 * player, fires whichever attack (melee preferred, since a melee-capable
 * monster always tries to close all the way in) is in range and off
 * cooldown, and returns that attack for the caller to actually apply/render
 * — the same "return what happened, let the caller realize it" split as
 * `WeaponSystem.update`'s `Shot[]`.
 *
 * A monster keeps closing distance until it's genuinely adjacent to the
 * player (within `MELEE_RANGE`, used here as a stand-in "personal space"
 * distance regardless of whether this monster actually has a melee attack)
 * — matching vanilla, which has no "keep your distance" instinct at all: a
 * ranged monster like the zombieman or cyberdemon still walks right up to
 * the player if nothing stops it, firing along the way whenever its own
 * attack is off cooldown and in range, rather than planting itself the
 * instant the player enters its (often much longer) attack range. Without
 * this, a monster with a long ranged attack froze solid the moment it got
 * any sightline, which read as static and robotic rather than hunting.
 * `hasLineOfSight` still gates firing, so a monster blocked by a corner
 * keeps approaching instead of shooting through a wall it can't see past.
 * Once alerted a monster beelines toward the player's real position even
 * without sight of it (no separate "last known position" memory) — a
 * deliberate simplification, not vanilla's own `chasedir` wandering.
 */
export function stepMonsterAI(
  body: MonsterBody,
  stats: MonsterStats,
  dt: number,
  world: World,
  playerX: number,
  playerY: number,
  playerZ: number,
): MonsterAttack | null {
  if (body.painTimer > 0) {
    body.painTimer = Math.max(0, body.painTimer - dt);
    settleVertical(body, world, stats.radius, dt);
    return null;
  }

  body.attackCooldown = Math.max(0, body.attackCooldown - dt);
  const dx = playerX - body.x;
  const dy = playerY - body.y;
  const dist = Math.hypot(dx, dy);
  body.angle = Math.atan2(dy, dx);
  const canSee = hasLineOfSight(world, body.x, body.y, playerX, playerY) && Math.abs(playerZ - body.z) <= MONSTER_ENGAGE_HEIGHT;

  let attack: MonsterAttack | null = null;
  if (canSee && body.attackCooldown <= 0) {
    if (stats.melee && dist <= stats.melee.range) {
      attack = { kind: 'melee', damage: rollDamage(stats.melee.diceSides, stats.melee.diceMult) };
      body.attackCooldown = stats.melee.cooldown;
    } else if (stats.ranged && dist <= stats.ranged.range) {
      attack = { kind: 'ranged', damage: rollDamage(stats.ranged.diceSides, stats.ranged.diceMult) };
      body.attackCooldown = stats.ranged.cooldown;
    }
  }

  if (dist > MELEE_RANGE || !canSee) {
    body.stuckTimer += dt;
    let moveAngle = body.angle;
    if (body.jitterTimer > 0) {
      body.jitterTimer -= dt;
      moveAngle += body.jitterAngle;
    }
    if (body.stuckTimer >= STUCK_CHECK_INTERVAL) {
      if (Math.hypot(body.x - body.stuckX, body.y - body.stuckY) < STUCK_MOVE_EPSILON) {
        body.jitterAngle = (Math.random() - 0.5) * Math.PI;
        body.jitterTimer = JITTER_DURATION;
      }
      body.stuckTimer = 0;
      body.stuckX = body.x;
      body.stuckY = body.y;
    }
    const step = stats.speed * dt;
    const moved = slideMove(world, body.x, body.y, Math.cos(moveAngle) * step, Math.sin(moveAngle) * step, stats.radius, body.z);
    body.x = moved.x;
    body.y = moved.y;
  }

  settleVertical(body, world, stats.radius, dt);
  return attack;
}
