/**
 * Chase/attack decisions: `tryWake` and `stepMonsterAI`, pure functions over a `MonsterBody`, a
 * `World` and a `SoundEmitter` that mutate the body and return *what happened* for the caller to
 * realize — the headlessly-testable half of the split whose other side, realizing an attack
 * against the world, is `monsters/attacks.ts`. See docs/monster-ai.md.
 */
import type { Sector } from '../../wad/map.ts';
import {
  ANY_HEIGHT,
  makeCollider,
  MAX_STEP_UP,
  type Collider,
  type PositionCheck,
  type ThingBlocker,
  type World,
} from '../world.ts';
import { GRAVITY } from '../player.ts';
import { pRandom, rollDamage } from '../../util/random.ts';
import {
  DIR_X,
  DIR_Y,
  DI_NODIR,
  MELEE_RANGE,
  meleeReachesVertically,
  meleeThreshold,
  type AttackStats,
  type MonsterAttack,
  type MonsterBody,
  type MonsterStats,
  type WakeCheckBody,
} from './defs.ts';
import { tryRaiseCorpse, type Resurrector } from './vile.ts';
import { ThingType } from '../things/doomednums.ts';
import { monsterOrigin, SILENT, type SoundEmitter } from '../../audio/sfx.ts';
import type { Pos3 } from '../../types.ts';
import { DOOM_TIC } from '../../constants.ts';

/** Everything one `stepMonsterAI` call is given about the step it is being asked to take. */
export interface MonsterStep {
  dt: number;
  /**
   * Usually the player; a monster hurt by another chases *it* instead, and nothing here knows the
   * difference. docs/monster-ai.md § Infighting.
   */
  target: Pos3;
  /** The target's own `info->radius` and body height, read only by the melee gate. */
  targetRadius: number;
  targetHeight: number;
  blockers?: readonly ThingBlocker[];
  resurrect?: Resurrector;
  sfx?: SoundEmitter;
}

/**
 * One call's working set: the step plus the three handles and the four values every helper below
 * derives from them. Built once by `stepMonsterAI` and threaded through, so no helper restates
 * what the call already knows.
 */
interface Chase extends MonsterStep {
  body: MonsterBody;
  stats: MonsterStats;
  world: World;
  sfx: SoundEmitter;
  dist: number;
  dx: number;
  dy: number;
  /**
   * Line of sight to the target, resolved by `canSee` on demand and at most once per call: only
   * the refire loop and `runChaseCall` consume it, and both run far less often than
   * `stepMonsterAI` does. Resolving it eagerly measured as the engine's largest single cost on a
   * crowded map. docs/monster-ai.md § Spatial indexing.
   */
  sight: boolean | null;
  /**
   * Where `standingAt`'s memo was taken, or null if it holds nothing yet. The buffer it fills is
   * module-level (`standingCheck`) so it costs no allocation, but *whether it is valid* is a
   * property of this one call — a fresh context is stale by construction, which is what a tic of
   * movers under an unmoved body requires.
   */
  standingX: number | null;
  standingY: number;
  /**
   * This monster as a collision query, built once because `newChaseDir` probes up to eight
   * destinations for it. The feet height is the one field a probe varies, so each sets it first —
   * see `testStep`.
   */
  collider: Collider;
}

/**
 * How close a charging lost soul has to get to land its `A_SkullAttack` hit. **This engine's own,
 * not vanilla**, which needs no range test because `PIT_CheckThing` resolves the contact — there
 * is no swept collision here, so a box that tight is tunnelled through at charge speed. Its own
 * number rather than the melee threshold, so retuning melee doesn't retune the lost soul.
 * docs/monster-ai.md § The lost soul.
 */
const SKULL_CONTACT_RANGE = 72;

/**
 * `mobjinfo.reactiontime`, 8 for every monster, counted in chase calls as vanilla counts it — so a
 * zombieman's hesitation really is twice a demon's. **Melee is deliberately not gated by it**:
 * vanilla reads it nowhere but `P_CheckMissileRange`. docs/monster-ai.md § Waking up.
 */
const REACTION_CHASES = 8;

/**
 * `BASETHRESHOLD` — chase calls a monster stays committed to whoever last hurt it. Without it a
 * crowded infight thrashes and nobody lands a second blow. docs/monster-ai.md § Infighting.
 */
const BASE_THRESHOLD = 100;

/** `opposite[]`: the about-face of each direction, which `newChaseDir` avoids picking. */
const OPPOSITE = [4, 5, 6, 7, 0, 1, 2, 3, DI_NODIR];
/** `diags[]`, indexed `((dy < 0) << 1) | (dx > 0)` → NW, NE, SW, SE. */
const DIAGS = [3, 1, 5, 7];

/** `P_NewChaseDir`'s own deadband: an axis closer than this counts as already lined up. */
const CHASE_AXIS_EPSILON = 10;

/**
 * `FLOATSPEED`, 4 map units per call. `P_ZMovement`'s hover runs once per tic, so as a rate that
 * is `FLOAT_SPEED / DOOM_TIC`; `P_Move`'s blocked-step adjustment runs once per *chase call*
 * instead, so `floatOverStep` scales it by `chaseInterval`. docs/monster-ai.md § Floating monsters.
 */
const FLOAT_SPEED = 4;

/**
 * How an attempted step came out. A `flies` body has three outcomes rather than two: `'adjust'` is
 * `P_TryMove` failing with `floatok` set — only the *height* is wrong, which `P_Move` answers by
 * floating instead of turning. A grounded monster only ever gets `'clear'` or `'blocked'`.
 */
type StepResult = 'clear' | 'adjust' | 'blocked';

/**
 * The buffer `standingAt` fills — vanilla keeps these heights on the actor
 * (`thing->floorz`/`thing->dropoffz`) and this recomputes them. Shared rather than allocated per
 * call, like `ThingGrid`'s own pooled result; what makes a fill *valid* rides the call instead
 * (`Chase.standingX`).
 */
const standingCheck: PositionCheck = { blocked: false, floorZ: 0, ceilingZ: 0, dropoffZ: 0, centreFloorZ: 0 };

/**
 * The collider `standingAt` and `stepCharge` probe with: geometry only, so unlike `Chase.collider`
 * it carries no blockers and no `from`. Kept and refilled per probe rather than rebuilt, like
 * `world.ts`'s own `standingCollider` — both run per monster per tic. See `makeCollider`.
 */
const probeCollider = makeCollider({ radius: 0, z: 0, height: 0, forMonster: true });

/**
 * `P_LookForPlayers`'s field-of-view gate: the forward ~180°, unless the player is within
 * `MELEERANGE`. Initial wake-up only — `A_Chase` never re-applies it to an already-hunting
 * monster. docs/monster-ai.md § Waking up.
 */
export function canSpotPlayer(facingDeg: number, monsterX: number, monsterY: number, playerX: number, playerY: number): boolean {
  const dist = Math.hypot(playerX - monsterX, playerY - monsterY);
  if (dist <= MELEE_RANGE) return true;
  const toPlayerDeg = (Math.atan2(playerY - monsterY, playerX - monsterX) * 180) / Math.PI;
  const diff = Math.abs((((toPlayerDeg - facingDeg + 180) % 360) + 360) % 360 - 180);
  return diff <= 90;
}

/**
 * The idle `A_Look`, called once per unalerted monster on `ThingLayer.update`'s `LOOK_INTERVAL`
 * throttle: sound, ambush/deaf things and the ordinary FOV+sight path all land here. On success
 * mutates `body.alerted` and seeds `reactionTicks`, the same "mutate the body, report what
 * happened" shape as `stepMonsterAI`. docs/monster-ai.md § Waking up.
 */
export function tryWake(
  body: WakeCheckBody,
  world: World,
  sector: Sector | undefined,
  player: Pos3,
  playerSubsector: number,
): boolean {
  const heardIt = !!sector && world.isSoundAlerted(sector);
  const seesDespiteDeaf =
    body.ambush && heardIt && world.hasLineOfSight(body, player, body.subsector, playerSubsector);
  const heardAndAware = !body.ambush && heardIt;
  const spottedNormally =
    canSpotPlayer(body.facingDeg, body.x, body.y, player.x, player.y) &&
    world.hasLineOfSight(body, player, body.subsector, playerSubsector);
  if (!seesDespiteDeaf && !heardAndAware && !spottedNormally) return false;
  body.alerted = true;
  body.reactionTicks = REACTION_CHASES;
  return true;
}

/**
 * Alerts a monster and, by `stats.painChance`, staggers it — called for any hit that doesn't kill
 * outright. Unconditional on prior line of sight, matching `P_DamageMobj`: a hit always sets the
 * target, sight or no.
 */
export function reactToDamage(body: MonsterBody, stats: MonsterStats): void {
  body.reactionTicks = 0; // vanilla's "we're awake now" — a hurt monster may fire at once
  // `MF_SKULLFLY`: a monster mid-charge doesn't flinch, so a lost soul can't be stunned out of
  // its dive.
  if (body.chargeTimer > 0) return;
  // `P_Random() < painchance`, and `painChance` is that byte over 256.
  if (pRandom() >= stats.painChance * 256) return;
  body.justHit = true; // MF_JUSTHIT — "the target just hit the enemy, so fight back!"
  body.painTimer = Math.max(body.painTimer, stats.painDuration);
  // The pain state replaces whatever the monster was doing, so an attack caught mid-sequence is
  // aborted outright rather than resumed after the flinch — a volley's unfired shots included.
  body.attackPause = 0;
  body.burstLeft = 0;
  body.swinging = false;
  body.refiring = false;
}

/**
 * `P_DamageMobj`'s target-switch rule — the whole mechanism behind infighting, with two carve-outs:
 * a monster still inside its `threshold` ignores new attackers (an arch-vile is exempt), and
 * nothing ever retaliates against an arch-vile. On a true result the caller reseeds `threshold`;
 * that is `commitTarget`. docs/monster-ai.md § Infighting.
 */
export function shouldRetarget(body: MonsterBody, victimType: number, sourceType: number): boolean {
  if (sourceType === ThingType.archVile) return false;
  if (body.threshold > 0 && victimType !== ThingType.archVile) return false;
  return true;
}

/** Commits a monster to a freshly-acquired target for `BASE_THRESHOLD` chase calls. */
export function commitTarget(body: MonsterBody): void {
  body.threshold = BASE_THRESHOLD;
}

/**
 * Advances one already-alerted monster by `step.dt`: re-routes and closes on the target, fires
 * whichever attack is in range and off cooldown, and returns it for the caller to realize — the
 * same split as `WeaponSystem.fire`'s `Shot[]`.
 *
 * **Decisions run on vanilla's clock, movement runs on the tic's.** `runChaseCall` fires on
 * `chaseInterval` and nothing else; position is interpolated per frame along the `movedir` the
 * last chase call settled on. docs/monster-ai.md § Movement and § Attacking.
 */
export function stepMonsterAI(
  body: MonsterBody,
  stats: MonsterStats,
  world: World,
  step: MonsterStep,
): MonsterAttack | null {
  const dx = step.target.x - body.x;
  const dy = step.target.y - body.y;
  // Every field named rather than spread from `step`, so `Chase` keeps one hidden class whatever
  // optional fields a caller chose to pass.
  const c: Chase = {
    body,
    stats,
    world,
    dt: step.dt,
    target: step.target,
    targetRadius: step.targetRadius,
    targetHeight: step.targetHeight,
    blockers: step.blockers,
    resurrect: step.resurrect,
    sfx: step.sfx ?? SILENT,
    dx,
    dy,
    dist: Math.hypot(dx, dy),
    sight: null,
    standingX: null,
    standingY: 0,
    collider: makeCollider({
      radius: stats.radius,
      z: body.z,
      height: stats.height,
      forMonster: true,
      blockers: step.blockers,
      from: body,
    }),
  };
  const { dt, sfx } = c;

  if (body.painTimer > 0) {
    body.painTimer = Math.max(0, body.painTimer - dt);
    settleVertical(c);
    return null;
  }

  body.attackPause = Math.max(0, body.attackPause - dt);

  if (body.chargeTimer > 0) {
    const hit = stepCharge(c);
    settleVertical(c);
    return hit;
  }

  let attack: MonsterAttack | null = null;
  const ranged = stats.ranged;

  // The swing already decided on, landing partway into its own state chain rather than on the
  // chase call that chose it. docs/monster-ai.md § The windup.
  if (body.swinging && body.burstLeft > 0) {
    body.angle = Math.atan2(dy, dx); // A_FaceTarget, re-run through the windup
    body.burstTimer -= dt;
    if (body.burstTimer <= 0) {
      body.burstLeft = 0;
      body.swinging = false;
      attack = strikeMelee(c);
    }
  }

  // Shots of an attack already under way, spaced out inside its own state sequence rather than
  // each costing a fresh chase call.
  if (ranged && !body.swinging && body.burstLeft > 0) {
    body.angle = Math.atan2(dy, dx); // A_FaceTarget, re-run between volley shots
    body.burstTimer -= dt;
    if (body.burstTimer <= 0) {
      const shotIndex = (ranged.shots ?? 1) - body.burstLeft;
      // The arch-vile's blast re-checks sight at the moment it would fire (`A_VileAttack`), so
      // losing sight during the windup fizzles the attack instead of firing blind. No other
      // ranged monster needs it — `P_CheckMissileRange` already confirmed sight for those.
      // docs/monster-archvile.md § The windup flame.
      if (!ranged.blast || canSee(c)) {
        // Which attack *this* shot is: a volley whose firing actions differ carries one entry
        // per shot (`AttackStats.shotAttacks`), and only its roll and projectile come from there.
        const shot = ranged.shotAttacks?.[shotIndex] ?? ranged;
        attack = fireAttack('ranged', shot, body.angle, ranged.projectile?.pairOffsetsRad?.[shotIndex], body.homingBias);
        // A hitscan attack's own shot sound. A projectile-thrower has none (its missile brings
        // one — see `MonsterSounds.attack`) and the arch-vile's blast plays `barexp` from
        // `monsters/vile.ts` instead.
        if (stats.sounds.attack) sfx.play(stats.sounds.attack, body, monsterOrigin(body.id));
      }
      body.burstLeft -= 1;
      body.burstTimer = ranged.shotInterval ?? 0;
    }
  }

  if (body.attackPause > 0) {
    settleVertical(c);
    return attack;
  }

  // The refire loop (`A_CPosRefire`/`A_SpidRefire`) jumps straight back into the attack without
  // returning to `A_Chase`, bypassing the chase-call cadence and every gate on it. It breaks only
  // on losing sight. docs/monster-ai.md § Attacking.
  if (!attack && body.refiring) {
    if (ranged && canSee(c)) {
      attack = beginRangedAttack(c);
    } else {
      body.refiring = false;
    }
  }

  if (!attack) {
    body.chaseTimer += dt;
    if (body.chaseTimer >= stats.chaseInterval) {
      body.chaseTimer -= stats.chaseInterval;
      attack = runChaseCall(c);
    }
  }

  if (body.attackPause <= 0 && body.movedir !== DI_NODIR) {
    // Interpolated walk along the direction the last chase call committed to. Not `slideMove`:
    // `P_Move` is all-or-nothing for monsters, and re-routing rather than sliding along a wall is
    // what makes DOOM monsters zig-zag. docs/monster-ai.md § Movement.
    const stepDist = stats.speed * dt;
    let nx = body.x + DIR_X[body.movedir] * stepDist;
    let ny = body.y + DIR_Y[body.movedir] * stepDist;
    let result = testStep(c, nx, ny);
    // A refused sub-step falls back on the whole chase step it subdivides, the only position
    // `P_Move` ever judges. Sub-stepping is this engine's own and is *stricter*, not weaker.
    // docs/monster-ai.md § Movement.
    if (result === 'blocked') {
      const full = stats.speed * stats.chaseInterval;
      const fx = body.x + DIR_X[body.movedir] * full;
      const fy = body.y + DIR_Y[body.movedir] * full;
      const fullResult = testStep(c, fx, fy);
      if (fullResult !== 'blocked') {
        nx = fx;
        ny = fy;
        result = fullResult;
      }
    }
    if (result === 'adjust') {
      // A flier changing height around a step it can't cross yet. `P_Move` reports this as a
      // move *taken*, so no `moveBlocked` and no re-route: it stays pointed at the ledge until it
      // has risen enough.
      floatOverStep(c, nx, ny);
    } else if (result === 'blocked') {
      body.moveBlocked = true;
    } else {
      body.x = nx;
      body.y = ny;
      body.inFloat = false;
      body.angle = Math.atan2(DIR_Y[body.movedir], DIR_X[body.movedir]);
      // Footsteps are paced by *walking*, not by wall-clock time: a monster held still by an
      // attack or stuck against a wall stops stomping, the way vanilla's walk-state chain stops
      // advancing. Only the three heavy types have any (`MonsterSounds.walk`).
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

  settleVertical(c);
  return attack;
}

/**
 * One `A_Chase` call, in vanilla's own order: raise a corpse if this is an arch-vile that found
 * one, else age the counters, burn a call to `MF_JUSTATTACKED`, try melee, try a missile (only
 * while `movecount` has run out), and otherwise walk — re-routing when `movecount` expires or the
 * last frame's move was refused. docs/monster-ai.md § Movement.
 */
function runChaseCall(c: Chase): MonsterAttack | null {
  const { body, stats, dx, dy, sfx } = c;
  // `A_VileChase` replaces this whole call when it finds a corpse — see `monsters/vile.ts`'s
  // `tryRaiseCorpse`, a no-op for every other type.
  const raised = tryRaiseCorpse(body, stats, c.resurrect);
  if (raised) return raised;

  if (body.reactionTicks > 0) body.reactionTicks--;
  if (body.threshold > 0) body.threshold--;

  // "Do not attack twice in a row" — the call after an attack always re-routes.
  if (body.justAttacked) {
    body.justAttacked = false;
    newChaseDir(c);
    return null;
  }

  if (stats.melee && inMeleeReach(c)) {
    body.angle = Math.atan2(dy, dx); // A_FaceTarget
    body.attackPause = stats.melee.duration;
    // Melee has no `P_CheckMissileRange` equivalent — `A_Chase` swings whenever the target is in
    // reach, so the swing's own length is the entire wait. It does have a windup: the claw lands
    // `startDelaySeconds` in, where `strikeMelee` re-tests the reach.
    // docs/monster-ai.md § The windup.
    body.burstLeft = 1;
    body.burstTimer = stats.melee.startDelaySeconds ?? 0;
    body.swinging = true;
    if (stats.sounds.meleeWindup) sfx.play(stats.sounds.meleeWindup, body, monsterOrigin(body.id));
    return null;
  }

  if (stats.ranged && body.movecount === 0 && checkMissileRange(c)) {
    body.justAttacked = true;
    return beginRangedAttack(c);
  }

  if (--body.movecount < 0 || body.moveBlocked || body.movedir === DI_NODIR) {
    newChaseDir(c);
  }
  body.moveBlocked = false;
  // `A_Chase`'s own tail: the idle grunt, on a 3-in-256 roll per chase call — which is why a
  // monster hunting you mutters every few seconds rather than on a timer.
  if (stats.sounds.active && pRandom() < 3) sfx.play(stats.sounds.active, body, monsterOrigin(body.id));
  return null;
}

/**
 * Starts a ranged attack: holds the monster still for its state sequence and queues its shots, or
 * launches a charge, or reports a spawn. Returns null except for the two attacks that have nothing
 * to wait on — the elemental's `spawn` and the arch-vile's `vileWindup`. See `MonsterAttack.kind`.
 */
function beginRangedAttack(c: Chase): MonsterAttack | null {
  const { body, stats, dx, dy, sfx } = c;
  const ranged = stats.ranged;
  if (!ranged) return null;
  body.angle = Math.atan2(dy, dx); // A_FaceTarget
  body.attackPause = ranged.duration;
  body.refiring = !!ranged.refire;
  // The windup's own sound, on the missilestate chain's first frame — the mancubus's `manatk`
  // and the arch-vile's `vilatk`.
  if (stats.sounds.windup) sfx.play(stats.sounds.windup, body, monsterOrigin(body.id));
  if (ranged.charge) {
    // `A_SkullAttack` plays the lost soul's `sklatk` as it launches itself, not on contact — the
    // charge is the attack firing.
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
 * The moment a swing lands, `startDelaySeconds` into the attack: the reach is re-tested here and
 * not where the swing was chosen, so a target that backed out during the windup is missed. What a
 * miss costs is the type's own — `AttackStats.missileOnMiss`. docs/monster-ai.md § The windup.
 */
function strikeMelee(c: Chase): MonsterAttack | null {
  const { body, stats, sfx } = c;
  const melee = stats.melee;
  if (!melee) return null;
  if (inMeleeReach(c)) {
    // Inside `P_CheckMeleeRange`'s own branch, so a swing that misses stays silent — see
    // `MonsterSounds.melee`.
    if (stats.sounds.melee) sfx.play(stats.sounds.melee, body, monsterOrigin(body.id));
    return fireAttack('melee', melee, body.angle);
  }
  if (!melee.missileOnMiss || !stats.ranged) return null;
  return fireAttack('ranged', stats.ranged, body.angle, undefined, body.homingBias);
}

/**
 * `P_CheckMeleeRange` plus the vertical overlap this engine adds to it — the whole gate, tested
 * once when `A_Chase` decides to swing and again when the claw lands, since vanilla's melee
 * actions re-run it themselves. docs/monster-ai.md § Melee reach.
 */
function inMeleeReach(c: Chase): boolean {
  const { body, stats, target } = c;
  const melee = stats.melee;
  if (!melee) return false;
  return (
    c.dist < meleeThreshold(melee.range ?? MELEE_RANGE, c.targetRadius) &&
    meleeReachesVertically(body.z, stats.height, target.z, c.targetHeight) &&
    canSee(c)
  );
}

/**
 * Rolls one instance of `attack`'s damage, tagged with the projectile(s) the caller should spawn.
 * `offsetsRad` is one radian offset per projectile (omitted = the single straight shot everything
 * but the mancubus fires); `attack.pellets` rolls that many bullets, kept separate in `bullets` as
 * well as summed into `damage`. See those fields' docs.
 *
 * The one helper here that wants no `Chase` — it reads a bare `AttackStats`, which is what lets
 * `strikeMelee` roll a monster's melee and its miss-missile through the same call.
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
 * One frame of a charging monster's flight (`A_SkullAttack`): straight along its launch heading,
 * stopping on contact or on geometry. Deliberately **not** `slideMove`, unlike every other
 * movement here — a charge that rounded corners would track the player, and sidestepping a
 * committed lost soul is what makes the attack fair. docs/monster-ai.md § The lost soul.
 */
function stepCharge(c: Chase): MonsterAttack | null {
  const { body, stats, world, dt } = c;
  const charge = stats.ranged?.charge;
  if (!charge || !stats.ranged) {
    body.chargeTimer = 0;
    return null;
  }
  body.chargeTimer = Math.max(0, body.chargeTimer - dt);
  if (c.dist <= SKULL_CONTACT_RANGE) {
    body.chargeTimer = 0;
    // Contact damage, so 'melee': the caller draws no tracer and spawns no projectile, which is
    // right — the monster itself was the missile.
    return fireAttack('melee', stats.ranged, body.chargeAngle);
  }
  const step = charge.speed * dt;
  const nx = body.x + Math.cos(body.chargeAngle) * step;
  const ny = body.y + Math.sin(body.chargeAngle) * step;
  probeCollider.radius = stats.radius;
  probeCollider.z = body.z;
  probeCollider.height = stats.height;
  if (world.positionBlocked(nx, ny, probeCollider)) {
    body.chargeTimer = 0;
    return null;
  }
  body.x = nx;
  body.y = ny;
  return null;
}

/**
 * `P_NewChaseDir` reproduced step for step: the both-axes diagonal, then the two cardinals, then
 * the previous heading, then a full eight-way scan from a randomly chosen end, and the about-face
 * only as a last resort. That ordering and the random scan direction are both load-bearing —
 * docs/monster-ai.md § Movement.
 */
function newChaseDir(c: Chase): void {
  // The entry deltas, not a recompute: nothing between `stepMonsterAI`'s context build and here
  // moves the body — the charge branch that does returns first, and the walk runs afterwards.
  const { body, dx: deltax, dy: deltay } = c;
  const olddir = body.movedir;
  const turnaround = OPPOSITE[olddir];

  let d1 = deltax > CHASE_AXIS_EPSILON ? 0 : deltax < -CHASE_AXIS_EPSILON ? 4 : DI_NODIR;
  let d2 = deltay < -CHASE_AXIS_EPSILON ? 6 : deltay > CHASE_AXIS_EPSILON ? 2 : DI_NODIR;

  // Try the direct diagonal route first.
  if (d1 !== DI_NODIR && d2 !== DI_NODIR) {
    const diag = DIAGS[((deltay < 0 ? 1 : 0) << 1) | (deltax > 0 ? 1 : 0)];
    if (diag !== turnaround && tryWalk(c, diag)) return;
  }

  if (pRandom() > 200 || Math.abs(deltay) > Math.abs(deltax)) {
    const t = d1;
    d1 = d2;
    d2 = t;
  }
  if (d1 === turnaround) d1 = DI_NODIR;
  if (d2 === turnaround) d2 = DI_NODIR;

  if (d1 !== DI_NODIR && tryWalk(c, d1)) return;
  if (d2 !== DI_NODIR && tryWalk(c, d2)) return;

  // No direct path — keep going the way we were, if that still works.
  if (olddir !== DI_NODIR && tryWalk(c, olddir)) return;

  if ((pRandom() & 1) !== 0) {
    for (let dir = 0; dir <= 7; dir++) {
      if (dir !== turnaround && tryWalk(c, dir)) return;
    }
  } else {
    for (let dir = 7; dir >= 0; dir--) {
      if (dir !== turnaround && tryWalk(c, dir)) return;
    }
  }

  if (turnaround !== DI_NODIR && tryWalk(c, turnaround)) return;
  body.movedir = DI_NODIR; // genuinely walled in
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
function tryWalk(c: Chase, dir: number): boolean {
  const { body, stats } = c;
  const reach = stats.speed * stats.chaseInterval;
  const nx = body.x + DIR_X[dir] * reach;
  const ny = body.y + DIR_Y[dir] * reach;
  if (testStep(c, nx, ny) === 'blocked') return false;
  body.movedir = dir;
  body.movecount = pRandom() & 15;
  return true;
}

/**
 * `P_CheckMissileRange`, run as the real per-attempt roll once per chase call rather than
 * converted into a cooldown — `runChaseCall` ticks at vanilla's cadence, so it can sample it as
 * often as vanilla does. The roll *suppresses* the shot, so fire chance is `(256 - dist) / 256`;
 * `MF_JUSTHIT` short-circuits all of it. docs/monster-ai.md § Attacking.
 */
function checkMissileRange(c: Chase): boolean {
  const { body, stats } = c;
  const ranged = stats.ranged;
  if (!ranged || !canSee(c)) return false;
  if (body.justHit) {
    body.justHit = false;
    return true;
  }
  if (body.reactionTicks > 0) return false;
  // Vanilla's own offset: melee-capable monsters get -64, ranged-only a further -128 ("no melee
  // attack, so fire more" — its own comment).
  let d = c.dist - (stats.melee ? 64 : 192);
  if (ranged.maxOffsetDist !== undefined && d > ranged.maxOffsetDist) return false;
  if (ranged.minOffsetDist !== undefined && d < ranged.minOffsetDist) return false;
  d *= ranged.rangeFalloffScale ?? 1;
  d = Math.min(ranged.rangeFalloffCap ?? 200, Math.max(0, d));
  return pRandom() >= d;
}

function testStep(c: Chase, x: number, y: number): StepResult {
  const { body, stats, world } = c;
  // Both probes below share one collider; each sets the feet height it wants first.
  const probe = c.collider;
  probe.z = body.z;
  // `P_TryMove`'s "doesn't fit", which sits *before* it sets `floatok`, so a floater is refused
  // outright rather than adjusting its height. This is the destination's own headroom, which is
  // why `checkPosition`'s per-opening test cannot stand in for it: a monster walking around inside
  // one sector crosses nothing, and a closed crusher would leave it strolling about underneath.
  // One walk answers all three — headroom, blocking verdict, dropoff.
  // docs/monster-ai.md § Movement.
  const check = world.checkPosition(x, y, probe, false);
  if (check.ceilingZ - check.floorZ < stats.height) {
    return 'blocked';
  }
  // Cheap necessary condition for `dropoffRefuses`, off the walk already in hand, so the standing
  // walk stays off every step taken away from a ledge. docs/monster-ai.md § The dropoff rule.
  const mayDrop = !stats.flies && (body.z - check.floorZ > MAX_STEP_UP || body.z - check.dropoffZ > MAX_STEP_UP);
  const overDropoff = mayDrop && dropoffRefuses(c, check);
  if (!check.blocked && !overDropoff) {
    if (!stats.flies) return 'clear';
    // "Mobj must lower itself to fit", against the destination's *own* overhead rather than a
    // crossed opening: `checkPosition` carries the per-opening half of the same rule, but a
    // monster inside one sector crosses no line, and this one is per-species height besides.
    return check.ceilingZ - body.z >= stats.height ? 'clear' : 'adjust';
  }
  if (!stats.flies) return 'blocked';
  // `floatok`: the destination is one this monster fits in at *some* height, so only the step
  // stopped it. `ANY_HEIGHT` drops the two feet-relative gates and leaves the wall, body and
  // opening-height checks — the tests vanilla runs before it sets `floatok`. The one probe that
  // still costs a second walk, and only for a flier already refused.
  probe.z = ANY_HEIGHT;
  return world.checkPosition(x, y, probe, true).blocked ? 'blocked' : 'adjust';
}

/**
 * `P_Move`'s float branch: a blocked flier moves `FLOATSPEED` toward the floor of the square it
 * wanted, and the move counts as taken. Clamping to that floor is this engine's own — vanilla
 * steps a flat 4 units and can overshoot, which at frame rate reads as hover jitter.
 */
function floatOverStep(c: Chase, x: number, y: number): void {
  const { body, stats, world } = c;
  const floor = world.groundFloor(x, y, stats.radius, true);
  const step = (FLOAT_SPEED / stats.chaseInterval) * c.dt;
  body.z = body.z < floor ? Math.min(floor, body.z + step) : Math.max(floor, body.z - step);
  body.inFloat = true;
}

/**
 * Whether the dropoff rule refuses the step `dest` describes: no height the walk reports may sit
 * more than `MAX_STEP_UP` below the same height where the body stands. Relative rather than
 * vanilla's destination-only test, which freezes a monster already hanging over a ledge — MBF's
 * `monkeys` clipping for the two accumulated heights, and this engine's own for the centre floor.
 * docs/monster-ai.md § The dropoff rule.
 */
function dropoffRefuses(c: Chase, dest: PositionCheck): boolean {
  const standing = standingAt(c);
  return (
    standing.floorZ - dest.floorZ > MAX_STEP_UP ||
    standing.dropoffZ - dest.dropoffZ > MAX_STEP_UP ||
    // Both centre floors come off walks already in hand — see `PositionCheck.centreFloorZ`.
    standing.centreFloorZ - dest.centreFloorZ > MAX_STEP_UP
  );
}

/**
 * One `P_CheckPosition` at the body's own position. `z` is `ANY_HEIGHT` because no height it reads
 * depends on it.
 */
function standingAt(c: Chase): PositionCheck {
  const { body, stats } = c;
  // Keyed on the position too, so a committed move self-invalidates the memo within the call.
  if (c.standingX !== body.x || c.standingY !== body.y) {
    probeCollider.radius = stats.radius;
    probeCollider.z = ANY_HEIGHT;
    probeCollider.height = stats.height;
    c.world.checkPosition(body.x, body.y, probeCollider, false, standingCheck);
    c.standingX = body.x;
    c.standingY = body.y;
  }
  return standingCheck;
}

/** Resolves `Chase.sight` on first ask and returns it — see that field's doc. */
function canSee(c: Chase): boolean {
  if (c.sight === null) c.sight = c.world.hasLineOfSight(c.body, c.target);
  return c.sight;
}

/**
 * Settles vertical position and velocity. A grounded monster does what `Player.update` does — snap
 * while grounded, integrate gravity while airborne. A `flies` monster never falls (`MF_NOGRAVITY`)
 * and drifts toward its target's mid-height while close enough (`P_ZMovement`'s `MF_FLOAT` block),
 * clamped between the floor under it and the ceiling above. docs/monster-ai.md § Floating monsters.
 */
function settleVertical(c: Chase): void {
  const { body, stats, dt, target } = c;
  // One walk for both heights: the flier branch below wants the ceiling from the same position,
  // and it is the *same* walk the dropoff rule asks for, so both share `standingAt`'s memo.
  const at = standingAt(c);
  const groundZ = at.floorZ;
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

  // No gravity term: whatever `velZ` a flier carries — only an arch-vile's launch ever gives it
  // one — rides until the floor or ceiling stops it.
  body.z += body.velZ * dt;
  // `!(MF_SKULLFLY) && !(MF_INFLOAT)`: a lost soul mid-charge and a monster already adjusting
  // height around a step both skip the hover.
  if (body.chargeTimer <= 0 && !body.inFloat) {
    const delta = target.z + stats.height / 2 - body.z;
    // `dist < |delta|*3` — the drift only engages once the monster is close enough that the
    // height difference matters. Measured fresh, **not** `c.dist`: this runs after the walk
    // block, so the entry distance is stale by exactly the step just taken.
    if (Math.hypot(target.x - body.x, target.y - body.y) < Math.abs(delta) * 3) {
      const step = (FLOAT_SPEED / DOOM_TIC) * dt;
      body.z += Math.max(-step, Math.min(step, delta));
    }
  }
  // Floor clamp first, ceiling clamp *last*, `P_ZMovement`'s own order: where the two disagree —
  // a space shorter than this body — the ceiling wins and `z` ends below the floor, rather than
  // the body being pushed into geometry it cannot fit under.
  // docs/monster-ai.md § Floating monsters.
  const ceilZ = at.ceilingZ - stats.height;
  const clamped = Math.min(Math.max(body.z, groundZ), ceilZ);
  if (clamped !== body.z) body.velZ = 0;
  body.z = clamped;
}
