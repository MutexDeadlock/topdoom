import type { Sector } from '../../wad/map.ts';
import { circleBlocked, hasLineOfSight, type ThingBlocker, type World } from '../world.ts';
import { GRAVITY } from '../player.ts';
import { rollDamage } from '../weapons.ts';
import {
  DIR_X,
  DIR_Y,
  DI_NODIR,
  MELEE_RANGE,
  MONSTER_HIT_HEIGHT,
  meleeReachesVertically,
  meleeThreshold,
  type AttackStats,
  type MonsterAttack,
  type MonsterBody,
  type MonsterStats,
  type WakeCheckBody,
} from './defs.ts';
import { tryRaiseCorpse, VILE_TYPE, type Resurrector } from './vile.ts';
import { monsterOrigin, SILENT, type SoundEmitter } from '../../audio/sfx.ts';
import type { Pos3 } from '../../types.ts';
import { DOOM_TIC } from '../../constants.ts';

/**
 * The per-frame monster simulation: waking, target commitment, vanilla's
 * `A_Chase` pathing, and the decision to attack. Everything here mutates a
 * `MonsterBody` and *reports* what happened; realizing an attack against the
 * world is `monsters/attacks.ts`. See docs/monster-ai.md.
 */

/**
 * How close a charging lost soul has to get to land its `A_SkullAttack` hit.
 * **This engine's own, not vanilla**, which has no range test here at all: the
 * skull is `MF_SKULLFLY` and damages whatever its moving bounding box overlaps
 * in `PIT_CheckThing`, i.e. a true `radius + target radius` (32 against the
 * player) resolved by the movement code. This engine has no swept collision for
 * the charge, so a box that tight is tunnelled straight through at charge speed;
 * the value is the pre-formula `MELEE_RANGE` this test used to share, kept
 * unchanged so tightening the melee threshold didn't silently retune the lost
 * soul too. See docs/monster-ai.md § The lost soul.
 */
const SKULL_CONTACT_RANGE = 72;

/**
 * Vanilla's `mobjinfo.reactiontime`, 8 for every monster. Counted in chase
 * calls as vanilla counts it, so a zombieman's hesitation really is twice a
 * demon's. **Melee is deliberately not gated by it** — vanilla reads it
 * nowhere but `P_CheckMissileRange`, so a demon woken at arm's length bites
 * on the spot.
 */
const REACTION_CHASES = 8;

/** Vanilla's `BASETHRESHOLD` — chase calls a monster stays committed to whoever last hurt it. Without it a crowded infight thrashes and nobody lands a second blow. */
const BASE_THRESHOLD = 100;

/** `opposite[]`: the about-face of each direction, which `newChaseDir` avoids picking. */
const OPPOSITE = [4, 5, 6, 7, 0, 1, 2, 3, DI_NODIR];
/** `diags[]`, indexed `((dy < 0) << 1) | (dx > 0)` → NW, NE, SW, SE. */
const DIAGS = [3, 1, 5, 7];

/** `P_NewChaseDir`'s own deadband: an axis closer than this counts as already lined up. */
const CHASE_AXIS_EPSILON = 10;

/**
 * `P_LookForPlayers`'s field-of-view gate: the forward ~180°, unless the
 * player is within `MELEERANGE`. Initial wake-up only — `A_Chase` never
 * re-applies it to an already-hunting monster. docs/monster-ai.md § Waking up.
 */
export function canSpotPlayer(facingDeg: number, monsterX: number, monsterY: number, playerX: number, playerY: number): boolean {
  const dist = Math.hypot(playerX - monsterX, playerY - monsterY);
  if (dist <= MELEE_RANGE) return true;
  const toPlayerDeg = (Math.atan2(playerY - monsterY, playerX - monsterX) * 180) / Math.PI;
  const diff = Math.abs((((toPlayerDeg - facingDeg + 180) % 360) + 360) % 360 - 180);
  return diff <= 90;
}

/**
 * Vanilla's idle `A_Look`, called once per unalerted monster on
 * `ThingLayer.update`'s `LOOK_INTERVAL` throttle. Sound, ambush/deaf things
 * and the ordinary FOV+sight path are all handled here — docs/monster-ai.md §
 * Waking up.
 *
 * On success mutates `body.alerted` and seeds `reactionTicks`, the same
 * "mutate the body, report what happened" shape as `stepMonsterAI`.
 */
export function tryWake(body: WakeCheckBody, world: World, sector: Sector | undefined, player: Pos3): boolean {
  const heardIt = !!sector && world.isSoundAlerted(sector);
  const seesDespiteDeaf = body.ambush && heardIt && hasLineOfSight(world, body, player);
  const heardAndAware = !body.ambush && heardIt;
  const spottedNormally =
    canSpotPlayer(body.facingDeg, body.x, body.y, player.x, player.y) && hasLineOfSight(world, body, player);
  if (!seesDespiteDeaf && !heardAndAware && !spottedNormally) return false;
  body.alerted = true;
  body.reactionTicks = REACTION_CHASES;
  return true;
}

/**
 * Alerts a monster and, by `stats.painChance`, staggers it — called from
 * `ThingLayer.damage` for any hit that doesn't kill outright. Unconditional
 * on prior line of sight, matching vanilla's own `P_DamageMobj`: a hit always
 * sets the target, sight or no.
 */
export function reactToDamage(body: MonsterBody, stats: MonsterStats): void {
  body.reactionTicks = 0; // vanilla's "we're awake now" — a hurt monster may fire at once
  // MF_SKULLFLY: a monster mid-charge doesn't flinch, so a lost soul can't be
  // stunned out of its dive.
  if (body.chargeTimer > 0) return;
  if (Math.random() >= stats.painChance) return;
  body.justHit = true; // MF_JUSTHIT — "the target just hit the enemy, so fight back!"
  body.painTimer = Math.max(body.painTimer, stats.painDuration);
  // Vanilla's pain state replaces whatever the monster was doing, so an
  // attack caught mid-sequence is aborted outright rather than resumed after
  // the flinch — including any shots of a volley it hadn't fired yet.
  body.attackPause = 0;
  body.burstLeft = 0;
  body.refiring = false;
}

/**
 * Vanilla's target-switch rule out of `P_DamageMobj` — the whole mechanism
 * behind infighting, with two carve-outs: a monster still inside its
 * `threshold` ignores new attackers (an arch-vile is exempt), and nothing
 * ever retaliates against an arch-vile. docs/monster-ai.md § Infighting.
 *
 * On a true result the caller reseeds `threshold`; that's `commitTarget`.
 */
export function shouldRetarget(body: MonsterBody, victimType: number, sourceType: number): boolean {
  if (sourceType === VILE_TYPE) return false;
  if (body.threshold > 0 && victimType !== VILE_TYPE) return false;
  return true;
}

/** Commits a monster to a freshly-acquired target for `BASE_THRESHOLD` chase calls (vanilla's own `threshold`). */
export function commitTarget(body: MonsterBody): void {
  body.threshold = BASE_THRESHOLD;
}

/**
 * Vanilla's `FLOATSPEED`, 4 map units per call. `P_ZMovement`'s hover runs once
 * per tic, so as a rate that is `FLOAT_SPEED / DOOM_TIC` units/sec;
 * `P_Move`'s blocked-step adjustment runs once per *chase call* instead, so
 * `floatOverStep` scales it by `chaseInterval` rather than by the tic.
 */
const FLOAT_SPEED = 4;

/**
 * Settles vertical position/velocity. A grounded monster does what
 * `Player.update` does — snap while grounded, integrate gravity while airborne.
 * A `flies` monster instead never falls (`MF_NOGRAVITY`) and drifts toward its
 * target's mid-height while close enough (`P_ZMovement`'s `MF_FLOAT` block),
 * clamped between the floor it is over and the ceiling above it. See
 * docs/monster-ai.md § Floating monsters.
 */
function settleVertical(body: MonsterBody, stats: MonsterStats, world: World, dt: number, target: Pos3): void {
  const groundZ = world.groundFloor(body.x, body.y, stats.radius, true);
  if (!stats.flies) {
    if (body.z > groundZ) {
      body.velZ -= GRAVITY * dt;
      body.z = Math.max(groundZ, body.z + body.velZ * dt);
      if (body.z === groundZ) body.velZ = 0;
    } else {
      body.z = groundZ;
      body.velZ = 0;
    }
    return;
  }

  // No gravity term: whatever velZ a flier carries (only an arch-vile's
  // launch ever gives it one) rides until the floor or ceiling stops it.
  body.z += body.velZ * dt;
  // `!(MF_SKULLFLY) && !(MF_INFLOAT)`: a lost soul mid-charge and a monster
  // already adjusting height around a step both skip the hover.
  if (body.chargeTimer <= 0 && !body.inFloat) {
    const delta = target.z + MONSTER_HIT_HEIGHT / 2 - body.z;
    // Vanilla's `dist < |delta|*3` gate — the drift only engages once the
    // monster is close enough that the height difference matters.
    if (Math.hypot(target.x - body.x, target.y - body.y) < Math.abs(delta) * 3) {
      const step = (FLOAT_SPEED / DOOM_TIC) * dt;
      body.z += Math.max(-step, Math.min(step, delta));
    }
  }
  const ceilZ = world.groundCeiling(body.x, body.y, stats.radius, true) - MONSTER_HIT_HEIGHT;
  const clamped = Math.min(Math.max(body.z, groundZ), Math.max(groundZ, ceilZ));
  if (clamped !== body.z) body.velZ = 0;
  body.z = clamped;
}

/**
 * How a `flies` monster's attempted step came out — vanilla's `P_TryMove`
 * result for an `MF_FLOAT` body, which has three outcomes rather than two:
 * `'adjust'` is `P_TryMove` failing with `floatok` set, i.e. only the
 * monster's *height* is wrong, which `P_Move` answers by floating instead of
 * turning. Every grounded monster only ever gets `'clear'` or `'blocked'`.
 */
type StepResult = 'clear' | 'adjust' | 'blocked';

function testStep(
  body: MonsterBody,
  stats: MonsterStats,
  world: World,
  x: number,
  y: number,
  blockers?: readonly ThingBlocker[],
): StepResult {
  if (!circleBlocked(world, x, y, stats.radius, body.z, true, !stats.flies, blockers, body)) {
    if (!stats.flies) return 'clear';
    // `tmceilingz - thing->z < thing->height`, vanilla's "mobj must lower
    // itself to fit" — only reachable for a body that can be well above its
    // own floor, which is why the shared `blocksMovement` doesn't carry it.
    return world.groundCeiling(x, y, stats.radius, true) - body.z >= MONSTER_HIT_HEIGHT ? 'clear' : 'adjust';
  }
  if (!stats.flies) return 'blocked';
  // `floatok`: the destination is one this monster fits in at *some* height,
  // so only the step stopped it. Re-testing at an unreachable feet height is
  // what makes `blocksMovement`'s step-up rule vacuous while leaving the wall,
  // body and opening-height checks — exactly the tests vanilla runs before it
  // sets `floatok`.
  return circleBlocked(world, x, y, stats.radius, Infinity, true, false, blockers, body) ? 'blocked' : 'adjust';
}

/**
 * `P_Move`'s float branch: a blocked flier moves `FLOATSPEED` toward the floor
 * of the square it wanted, and the move counts as taken. Clamping to that floor
 * is this engine's own — vanilla steps a flat 4 units per call and can overshoot
 * by up to that much, which at frame rate would read as a hover jitter.
 */
function floatOverStep(body: MonsterBody, stats: MonsterStats, world: World, x: number, y: number, dt: number): void {
  const floor = world.groundFloor(x, y, stats.radius, true);
  const step = (FLOAT_SPEED / stats.chaseInterval) * dt;
  body.z = body.z < floor ? Math.min(floor, body.z + step) : Math.max(floor, body.z - step);
  body.inFloat = true;
}

/**
 * Vanilla's `P_CheckMissileRange`, run as the real per-attempt roll once per
 * chase call rather than converted into a cooldown — `runChaseCall` ticks at
 * vanilla's cadence, so it can afford to sample it as often as vanilla does.
 * The roll *suppresses* the shot, so fire chance is `(256 - dist) / 256`.
 * `MF_JUSTHIT` short-circuits all of it. docs/monster-ai.md § Attacking.
 */
function checkMissileRange(body: MonsterBody, stats: MonsterStats, dist: number, canSee: () => boolean): boolean {
  const ranged = stats.ranged;
  if (!ranged || !canSee()) return false;
  if (body.justHit) {
    body.justHit = false;
    return true;
  }
  if (body.reactionTicks > 0) return false;
  // Vanilla's own offset: melee-capable monsters get -64, ranged-only a
  // further -128 ("no melee attack, so fire more" — its own comment).
  let d = dist - (stats.melee ? 64 : 192);
  if (ranged.maxOffsetDist !== undefined && d > ranged.maxOffsetDist) return false;
  if (ranged.minOffsetDist !== undefined && d < ranged.minOffsetDist) return false;
  d *= ranged.rangeFalloffScale ?? 1;
  d = Math.min(ranged.rangeFalloffCap ?? 200, Math.max(0, d));
  return Math.random() * 256 >= d;
}

/**
 * Whether this monster could take a full chase step in `dir` — vanilla's
 * `P_TryWalk` minus the part that performs the move (movement is interpolated
 * per frame here). Committing reseeds `movecount` to `P_Random() & 15` as
 * `P_TryWalk` does, which paces both re-routing and the missile gate.
 *
 * A step a flier can only take after changing height still counts as walkable,
 * because vanilla's `P_TryWalk` calls `P_Move`, which reports the float as a
 * successful move — that is what keeps a cacodemon committed to a ledge
 * instead of re-routing away from it.
 */
function tryWalk(body: MonsterBody, stats: MonsterStats, world: World, dir: number, blockers?: readonly ThingBlocker[]): boolean {
  const step = stats.speed * stats.chaseInterval;
  const nx = body.x + DIR_X[dir] * step;
  const ny = body.y + DIR_Y[dir] * step;
  if (testStep(body, stats, world, nx, ny, blockers) === 'blocked') return false;
  body.movedir = dir;
  body.movecount = Math.floor(Math.random() * 16);
  return true;
}

/**
 * True when the monster is standing *inside* something right now but the full
 * chase step `tryWalk` committed to still lands clear — so the sub-step this
 * frame wants is on its way out, not into anything new.
 *
 * Exists because maps routinely place monsters flush against walls, which
 * vanilla never notices since `P_Move` tests only the destination:
 * docs/monster-ai.md § Movement. Only ever reached from the already-blocked
 * branch below, so a walking monster pays nothing for it.
 */
function escapingOverlap(body: MonsterBody, stats: MonsterStats, world: World, blockers?: readonly ThingBlocker[]): boolean {
  const blockedAt = (x: number, y: number): boolean => testStep(body, stats, world, x, y, blockers) === 'blocked';
  if (!blockedAt(body.x, body.y)) return false;
  const step = stats.speed * stats.chaseInterval;
  return !blockedAt(body.x + DIR_X[body.movedir] * step, body.y + DIR_Y[body.movedir] * step);
}

/**
 * Vanilla's `P_NewChaseDir`, reproduced step for step: the both-axes diagonal,
 * then the two cardinals, then the previous heading, then a full eight-way
 * scan from a randomly chosen end, and the about-face only as a last resort.
 * That last-resort ordering and the random scan direction are both
 * load-bearing — docs/monster-ai.md § Movement.
 */
function newChaseDir(
  body: MonsterBody,
  stats: MonsterStats,
  world: World,
  targetX: number,
  targetY: number,
  blockers?: readonly ThingBlocker[],
): void {
  const olddir = body.movedir;
  const turnaround = OPPOSITE[olddir];
  const deltax = targetX - body.x;
  const deltay = targetY - body.y;

  let d1 = deltax > CHASE_AXIS_EPSILON ? 0 : deltax < -CHASE_AXIS_EPSILON ? 4 : DI_NODIR;
  let d2 = deltay < -CHASE_AXIS_EPSILON ? 6 : deltay > CHASE_AXIS_EPSILON ? 2 : DI_NODIR;

  // Try the direct diagonal route first.
  if (d1 !== DI_NODIR && d2 !== DI_NODIR) {
    const diag = DIAGS[((deltay < 0 ? 1 : 0) << 1) | (deltax > 0 ? 1 : 0)];
    if (diag !== turnaround && tryWalk(body, stats, world, diag, blockers)) return;
  }

  if (Math.random() * 256 > 200 || Math.abs(deltay) > Math.abs(deltax)) {
    const t = d1;
    d1 = d2;
    d2 = t;
  }
  if (d1 === turnaround) d1 = DI_NODIR;
  if (d2 === turnaround) d2 = DI_NODIR;

  if (d1 !== DI_NODIR && tryWalk(body, stats, world, d1, blockers)) return;
  if (d2 !== DI_NODIR && tryWalk(body, stats, world, d2, blockers)) return;

  // No direct path — keep going the way we were, if that still works.
  if (olddir !== DI_NODIR && tryWalk(body, stats, world, olddir, blockers)) return;

  if (Math.random() < 0.5) {
    for (let dir = 0; dir <= 7; dir++) {
      if (dir !== turnaround && tryWalk(body, stats, world, dir, blockers)) return;
    }
  } else {
    for (let dir = 7; dir >= 0; dir--) {
      if (dir !== turnaround && tryWalk(body, stats, world, dir, blockers)) return;
    }
  }

  if (turnaround !== DI_NODIR && tryWalk(body, stats, world, turnaround, blockers)) return;
  body.movedir = DI_NODIR; // genuinely walled in
}

/**
 * One frame of a charging monster's flight — `A_SkullAttack`. Travels straight
 * along its launch heading and stops on reaching the player (contact damage,
 * `MF_SKULLFLY` in `PIT_CheckThing`) or on hitting geometry.
 *
 * Deliberately **not** `slideMove`, unlike every other movement here: a charge
 * that rounded corners would track the player, and sidestepping a committed
 * lost soul is what makes the attack fair. docs/monster-ai.md § The lost soul.
 */
function stepCharge(body: MonsterBody, stats: MonsterStats, dt: number, world: World, distToPlayer: number): MonsterAttack | null {
  const charge = stats.ranged?.charge;
  if (!charge || !stats.ranged) {
    body.chargeTimer = 0;
    return null;
  }
  body.chargeTimer = Math.max(0, body.chargeTimer - dt);
  if (distToPlayer <= SKULL_CONTACT_RANGE) {
    body.chargeTimer = 0;
    // Contact damage, so 'melee' — the caller draws no tracer and spawns no
    // projectile for it, which is right: the monster itself was the missile.
    return fireAttack('melee', stats.ranged, body.chargeAngle);
  }
  const step = charge.speed * dt;
  const nx = body.x + Math.cos(body.chargeAngle) * step;
  const ny = body.y + Math.sin(body.chargeAngle) * step;
  if (circleBlocked(world, nx, ny, stats.radius, body.z, true)) {
    body.chargeTimer = 0;
    return null;
  }
  body.x = nx;
  body.y = ny;
  return null;
}

/**
 * Rolls one instance of `attack`'s damage, tagged with the projectile(s) the
 * caller should spawn. `offsetsRad` is one radian offset per projectile
 * (omitted = the single straight shot everything but the mancubus fires);
 * `attack.pellets` rolls that many bullets, kept separate in `bullets` as well
 * as summed into `damage`; `homingBias` decides whether this particular shot
 * homes. See those fields' docs.
 */
function fireAttack(
  kind: 'melee' | 'ranged',
  attack: AttackStats,
  angleRad: number,
  offsetsRad?: number[],
  homingBias = false,
): MonsterAttack {
  const projectile = attack.projectile;
  const bullets: number[] = [];
  let damage = 0;
  for (let i = 0, n = attack.pellets ?? 1; i < n; i++) {
    const roll = rollDamage(attack.diceSides, attack.diceMult);
    bullets.push(roll);
    damage += roll;
  }
  return {
    kind,
    damage,
    bullets,
    angleRad,
    projectiles: projectile
      ? (offsetsRad ?? [0]).map((off) => ({
          sprite: projectile.sprite,
          speed: projectile.speed,
          angleRad: angleRad + off,
          splash: projectile.splash,
          homing: projectile.homing ? homingBias : undefined,
        }))
      : undefined,
    blast: attack.blast,
  };
}

/**
 * Advances one already-alerted monster by `dt`: re-routes and closes on
 * `target`, fires whichever attack is in range and off cooldown, and returns
 * it for the caller to apply/render — the same "return what happened, let the
 * caller realize it" split as `WeaponSystem.update`'s `Shot[]`. `target` is
 * usually the player, but a monster hurt by another chases *it* instead, and
 * nothing here needs to know the difference.
 *
 * **Decisions run on vanilla's clock, movement runs on the frame's.** Every
 * counter `A_Chase` touches is measured in chase calls, so `runChaseCall`
 * fires on `chaseInterval` and nothing else; position is interpolated per
 * frame along the `movedir` the last chase call settled on, since vanilla's
 * full-`speed` jump per call would visibly stutter here. Same distance, same
 * 8-way pathing, no stutter. See docs/monster-ai.md § Movement and § Attacking.
 */
export function stepMonsterAI(
  body: MonsterBody,
  stats: MonsterStats,
  dt: number,
  world: World,
  target: Pos3,
  /**
   * The target's own `info->radius` and body height, which only the melee gate
   * reads (`meleeThreshold`, `meleeReachesVertically`). Two scalars rather than
   * one object deliberately: this runs per monster per frame, and CLAUDE.md's
   * position-type rule keeps hot paths allocation-free.
   */
  targetRadius: number,
  targetHeight: number,
  blockers?: readonly ThingBlocker[],
  resurrect?: Resurrector,
  sfx: SoundEmitter = SILENT,
): MonsterAttack | null {
  if (body.painTimer > 0) {
    body.painTimer = Math.max(0, body.painTimer - dt);
    settleVertical(body, stats, world, dt, target);
    return null;
  }

  body.attackPause = Math.max(0, body.attackPause - dt);
  const dx = target.x - body.x;
  const dy = target.y - body.y;
  const dist = Math.hypot(dx, dy);
  /**
   * Sight, resolved **on demand and at most once per call** — only the refire
   * loop and `runChaseCall` consume it, and both run far less often than this
   * function does, so evaluating it eagerly meant a sightline trace per
   * monster per frame whose answer was usually discarded. Vanilla has the same
   * structure: `P_CheckSight` is called from inside `A_Chase`, not per tic per
   * thinker. Measured as the engine's largest single cost on a crowded map.
   */
  let sightCached: boolean | null = null;
  const canSee = (): boolean => {
    if (sightCached === null) sightCached = hasLineOfSight(world, body, target);
    return sightCached;
  };

  if (body.chargeTimer > 0) {
    const hit = stepCharge(body, stats, dt, world, dist);
    settleVertical(body, stats, world, dt, target);
    return hit;
  }

  let attack: MonsterAttack | null = null;
  const ranged = stats.ranged;

  // Shots of an attack already under way, spaced out inside its own state
  // sequence rather than each costing a fresh chase call.
  if (ranged && body.burstLeft > 0) {
    body.angle = Math.atan2(dy, dx); // A_FaceTarget, re-run between volley shots
    body.burstTimer -= dt;
    if (body.burstTimer <= 0) {
      const shotIndex = (ranged.shots ?? 1) - body.burstLeft;
      // The arch-vile's blast re-checks sight at the exact moment it would
      // fire (vanilla's own A_VileAttack) — losing sight during the windup
      // makes the whole attack fizzle instead of firing blind. No other
      // ranged monster does this: their shots fire the instant
      // P_CheckMissileRange already confirmed sight, so re-checking here
      // would be redundant.
      if (!ranged.blast || canSee()) {
        attack = fireAttack('ranged', ranged, body.angle, ranged.projectile?.pairOffsetsRad?.[shotIndex], body.homingBias);
        // A hitscan attack's own shot sound. A projectile-thrower has none —
        // its missile brings one (see `MonsterSounds.attack`) — and the
        // arch-vile's blast plays `barexp` from `monsters/vile.ts` instead.
        if (stats.sounds.attack) sfx.play(stats.sounds.attack, body, monsterOrigin(body.id));
      }
      body.burstLeft -= 1;
      body.burstTimer = ranged.shotInterval ?? 0;
    }
  }

  if (body.attackPause > 0) {
    settleVertical(body, stats, world, dt, target);
    return attack;
  }

  // The refire loop (A_CPosRefire/A_SpidRefire) jumps straight back into the
  // attack without ever returning to A_Chase, so it bypasses the chase-call
  // cadence and every gate on it. It breaks only on losing sight.
  if (!attack && body.refiring) {
    if (ranged && canSee()) {
      attack = beginRangedAttack(body, stats, dx, dy, sfx);
    } else {
      body.refiring = false;
    }
  }

  if (!attack) {
    body.chaseTimer += dt;
    if (body.chaseTimer >= stats.chaseInterval) {
      body.chaseTimer -= stats.chaseInterval;
      attack = runChaseCall(body, stats, world, target, targetRadius, targetHeight, dist, dx, dy, canSee, blockers, resurrect, sfx);
    }
  }

  if (body.attackPause <= 0 && body.movedir !== DI_NODIR) {
    // Interpolated walk along the direction the last chase call committed to.
    // Not `slideMove`: vanilla's P_Move is all-or-nothing for monsters (only
    // the player gets P_SlideMove), and re-routing rather than sliding along
    // a wall is exactly what makes DOOM monsters zig-zag.
    const step = stats.speed * dt;
    const nx = body.x + DIR_X[body.movedir] * step;
    const ny = body.y + DIR_Y[body.movedir] * step;
    const result = testStep(body, stats, world, nx, ny, blockers);
    if (result === 'adjust') {
      // A flier changing height around a step it can't cross yet. Vanilla's
      // P_Move reports this as a move *taken*, so no `moveBlocked` and no
      // re-route: it stays pointed at the ledge until it has risen enough.
      floatOverStep(body, stats, world, nx, ny, dt);
    } else if (result === 'blocked' && !escapingOverlap(body, stats, world, blockers)) {
      body.moveBlocked = true;
    } else {
      body.x = nx;
      body.y = ny;
      body.inFloat = false;
      body.angle = Math.atan2(DIR_Y[body.movedir], DIR_X[body.movedir]);
      // Footsteps are paced by *walking*, not by wall-clock time: a monster
      // held still by an attack or stuck against a wall stops stomping, the way
      // vanilla's own walk-state chain stops advancing. Only the three heavy
      // types have any (`MonsterSounds.walk`).
      const walk = stats.sounds.walk;
      if (walk) {
        body.walkSoundTimer += dt;
        if (body.walkSoundTimer >= walk.interval) {
          body.walkSoundTimer -= walk.interval;
          sfx.play(walk.sounds[body.walkSoundStep % walk.sounds.length], body, monsterOrigin(body.id));
          body.walkSoundStep++;
        }
      }
    }
  }

  settleVertical(body, stats, world, dt, target);
  return attack;
}

/**
 * Starts a ranged attack: holds the monster still for its state sequence and
 * queues its shots (or launches a charge, or reports a spawn). Returns null
 * except for the pain elemental's `spawn` attacks, which report a `'spawn'`
 * event immediately (vanilla's `A_PainAttack` calls `A_PainShootSkull`
 * directly, with no burst/shot sequence of its own to wait on), and the
 * arch-vile's `blast` attacks, which report a `'vileWindup'` event the
 * instant the windup begins — see `MonsterAttack.kind`'s doc.
 */
function beginRangedAttack(
  body: MonsterBody,
  stats: MonsterStats,
  dx: number,
  dy: number,
  sfx: SoundEmitter,
): MonsterAttack | null {
  const ranged = stats.ranged;
  if (!ranged) return null;
  body.angle = Math.atan2(dy, dx); // A_FaceTarget
  body.attackPause = ranged.duration;
  body.refiring = !!ranged.refire;
  // The windup's own sound, on the missilestate chain's first frame — the
  // mancubus's `manatk` and the arch-vile's `vilatk`.
  if (stats.sounds.windup) sfx.play(stats.sounds.windup, body, monsterOrigin(body.id));
  if (ranged.charge) {
    // `A_SkullAttack` plays the lost soul's `sklatk` as it launches itself,
    // not on contact — the charge is the attack firing.
    if (stats.sounds.attack) sfx.play(stats.sounds.attack, body, monsterOrigin(body.id));
    body.chargeTimer = ranged.charge.maxDist / ranged.charge.speed;
    body.chargeAngle = body.angle;
    return null;
  }
  if (ranged.spawn) return { kind: 'spawn', damage: 0, bullets: [], angleRad: body.angle };
  body.burstLeft = ranged.shots ?? 1;
  body.burstTimer = ranged.startDelaySeconds ?? 0;
  if (ranged.blast) return { kind: 'vileWindup', damage: 0, bullets: [], angleRad: body.angle };
  return null;
}

/**
 * One `A_Chase` call, in vanilla's own order: raise a corpse if this is an
 * arch-vile that found one, else age the counters, burn a call to
 * `MF_JUSTATTACKED`, try melee, try a missile (only while `movecount` has run
 * out), and otherwise walk — re-routing when `movecount` expires or the last
 * frame's move was refused.
 */
function runChaseCall(
  body: MonsterBody,
  stats: MonsterStats,
  world: World,
  target: Pos3,
  targetRadius: number,
  targetHeight: number,
  dist: number,
  dx: number,
  dy: number,
  canSee: () => boolean,
  blockers: readonly ThingBlocker[] | undefined,
  resurrect: Resurrector | undefined,
  sfx: SoundEmitter,
): MonsterAttack | null {
  // A_VileChase replaces this whole call when it finds a corpse — see
  // `monsters/vile.ts: tryRaiseCorpse`, which is a no-op for every other type.
  const raised = tryRaiseCorpse(body, stats, resurrect);
  if (raised) return raised;

  if (body.reactionTicks > 0) body.reactionTicks--;
  if (body.threshold > 0) body.threshold--;

  // "Do not attack twice in a row" — the call after an attack always re-routes.
  if (body.justAttacked) {
    body.justAttacked = false;
    newChaseDir(body, stats, world, target.x, target.y, blockers);
    return null;
  }

  if (
    stats.melee &&
    dist < meleeThreshold(stats.melee.range ?? MELEE_RANGE, targetRadius) &&
    meleeReachesVertically(body.z, MONSTER_HIT_HEIGHT, target.z, targetHeight) &&
    canSee()
  ) {
    body.angle = Math.atan2(dy, dx); // A_FaceTarget
    body.attackPause = stats.melee.duration;
    if (stats.sounds.melee) sfx.play(stats.sounds.melee, body, monsterOrigin(body.id));
    // Melee has no P_CheckMissileRange equivalent: A_Chase swings whenever the
    // target is in reach, so the swing's own length is the entire wait.
    return fireAttack('melee', stats.melee, body.angle);
  }

  if (stats.ranged && body.movecount === 0 && checkMissileRange(body, stats, dist, canSee)) {
    body.justAttacked = true;
    return beginRangedAttack(body, stats, dx, dy, sfx);
  }

  if (--body.movecount < 0 || body.moveBlocked || body.movedir === DI_NODIR) {
    newChaseDir(body, stats, world, target.x, target.y, blockers);
  }
  body.moveBlocked = false;
  // Vanilla's own tail of A_Chase: the idle grunt, on a 3-in-256 roll per chase
  // call — which is why a monster hunting you mutters every few seconds rather
  // than on a timer.
  if (stats.sounds.active && Math.random() * 256 < 3) sfx.play(stats.sounds.active, body, monsterOrigin(body.id));
  return null;
}
