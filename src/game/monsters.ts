import type { Sector } from '../wad/map.ts';
import { circleBlocked, hasLineOfSight, shotPath, WEAPON_RANGE, type ThingBlocker, type World } from './world.ts';
import { AIM_HEIGHT_OFFSET, GRAVITY, PLAYER_RADIUS } from './player.ts';
import { rollDamage, triangularSpread } from './weapons.ts';
import { applyRadiusDamage, type CombatContext } from './combat.ts';
import type { EffectLayer } from './effects.ts';
// Type-only on purpose: `projectiles.ts` and `things.ts` both import *this*
// file for values, so a value import either way round would be a runtime cycle.
// docs/monsters.md § Resolving an attack.
import type { ProjectileLayer } from './projectiles.ts';
import { IMPACT_FRAME_SECONDS, MONSTER_TRACER_COLOR, VILE_FIRE_FRAMES, VILE_FIRE_OFFSET } from './effectdefs.ts';
import type { AudioEngine } from '../audio/audio.ts';
import { monsterOrigin, SILENT, type SfxId, type SoundEmitter } from '../audio/sfx.ts';
import type { Pos2, Pos3 } from '../types.ts';
import { DOOM_TIC } from '../constants.ts';

/**
 * The mutable chase/attack state `stepMonsterAI` reads and writes, kept alive
 * across frames on the caller's object. `PosedThing` (`game/things.ts`)
 * structurally satisfies this, so it's passed in directly rather than copied
 * in and out. Only ever stepped once a monster is alerted; waking is
 * `tryWake`'s job. See docs/monsters.md.
 */
export interface MonsterBody extends Pos3 {
  /**
   * Stable per-monster handle (`PosedThing.id`), read here only to key its
   * sounds' origin (`audio/sfx.ts: monsterOrigin`) so one monster's own sounds
   * cut each other off the way vanilla's per-mobj channel rule has them do.
   */
  id: number;
  velZ: number;
  /** Facing/movement direction, radians — same convention as `Player.angle`. */
  angle: number;
  /** >0 while playing out an attack, during which the monster holds position and no chase call runs — docs/monsters.md § Attacking. */
  attackPause: number;
  /** Shots left in the attack currently being played out, and the countdown to the next one (`AttackStats.shots`). */
  burstLeft: number;
  burstTimer: number;
  /** >0 while a lost soul's `A_SkullAttack` charge is in flight, travelling `chargeAngle` at charge speed until it connects or hits geometry. */
  chargeTimer: number;
  chargeAngle: number;
  /** >0 while staggered by a recent hit; movement and attacks pause until it drops to 0 (see `reactToDamage`). */
  painTimer: number;

  // --- Vanilla's A_Chase bookkeeping (see `runChaseCall`). Every counter here
  // is measured in *chase calls*, not seconds, exactly as vanilla measures it;
  // `chaseTimer` is the only thing that converts between the two. ---

  /** Which of vanilla's eight movement directions it walks, `DI_NODIR` (8) when it has nowhere to go — the 8-way grid behind DOOM's zig-zag approach. */
  movedir: number;
  /** Chase calls left before `newChaseDir` re-routes — vanilla's `movecount`, reseeded to `P_Random() & 15`. */
  movecount: number;
  /** Accumulates real time toward the next chase call (`MonsterStats.chaseInterval`). */
  chaseTimer: number;
  /** Set when a frame's move was refused; the next chase call re-routes, the way vanilla reacts to `P_Move` returning false. */
  moveBlocked: boolean;
  /** Chase calls of target commitment left — vanilla's `threshold`, seeded to `BASETHRESHOLD` on being hurt. Keeps an infight from thrashing between targets. */
  threshold: number;
  /** Vanilla's `MF_JUSTHIT` — "the target just hit the enemy, so fight back": the next missile check fires regardless of the range roll. */
  justHit: boolean;
  /** Vanilla's `MF_JUSTATTACKED` — "do not attack twice in a row": the next chase call re-routes instead of attacking. */
  justAttacked: boolean;
  /** Chase calls left of vanilla's `reactiontime`; blocks ranged attacks only. */
  reactionTicks: number;
  /** True while inside an `AttackStats.refire` loop, which re-enters the attack the instant its state sequence ends. */
  refiring: boolean;
  /**
   * A persistent coin flip standing in for which side of `A_Tracer`'s
   * `gametic & 3` gate this revenant sits on — vanilla's revenant is a guided
   * or an unguided shooter, not a per-shot roll. Unused unless
   * `AttackStats.projectile.homing` is set; reseeded on spawn and rerolled on
   * wake/pain, the events that reshuffle vanilla's parity. See
   * docs/monsters.md § The revenant's homing missile.
   */
  homingBias: boolean;
  /**
   * Seconds of *walking* since this monster's last footstep sound, and which
   * of `MonsterSounds.walk`'s sounds comes next. Both inert for every type
   * without footsteps (all but the three heavy ones) — see that field's doc.
   */
  walkSoundTimer: number;
  walkSoundStep: number;
}

export interface AttackStats {
  /**
   * Map units, **melee only** — this monster's own `MELEERANGE`, which
   * `meleeThreshold` turns into the actual reach against a given target. Every
   * stock type uses the vanilla 64. A ranged attack deliberately has no range
   * field: vanilla gives it none, and giving it one was a real bug. See
   * docs/monsters.md § Melee reach.
   */
  range?: number;
  diceSides: number;
  diceMult: number;
  /**
   * Hitscan only — bullets per attack (`A_SPosAttack`'s 3 `P_LineAttack`s).
   * Each is traced as its own bolt, with its own spread angle and its own
   * damage roll, so a burst can land partially. Absent means the ordinary
   * single bullet. See docs/monsters.md § Hitscan vs. projectile.
   */
  pellets?: number;
  /** Seconds the attack's state sequence runs — its summed `info.c` tics over 35. The monster holds position exactly this long (docs/monsters.md § Attacking). */
  duration: number;
  /** Shots fired from this one `missilestate` and how far apart, rather than a fresh `A_Chase` decision per shot. Defaults to a single shot at attack start. */
  shots?: number;
  shotInterval?: number;
  /**
   * Seconds before the first shot fires. Every other monster starts at 0 (an
   * accepted simplification — their windup has no mechanical consequence);
   * the arch-vile's 66 tics is real, because it re-checks sight at that exact
   * moment and that is why cover saves you. docs/monsters.md § The arch-vile.
   */
  startDelaySeconds?: number;
  /** Vanilla's `A_CPosRefire`/`A_SpidRefire` loop: the attack state re-enters itself until the target stops being visible, never re-rolling `P_CheckMissileRange`. */
  refire?: boolean;
  /**
   * The lost soul's `A_SkullAttack` — it launches *itself* at `SKULLSPEED`
   * and damages on contact. `maxDist` has no vanilla counterpart (vanilla's
   * skull keeps its momentum); it just bounds a charge across open floor.
   * See docs/monsters.md § The lost soul: a charge, not a projectile.
   */
  charge?: { speed: number; maxDist: number };
  /**
   * The pain elemental's `A_PainAttack`/`A_PainShootSkull`: spawns a lost soul
   * in front of itself and launches it at the elemental's own target.
   * `game/things.ts` owns the spawning since it holds the `PosedThing` list;
   * `stepMonsterAI` only reports that one should happen, the same split as
   * every other attack kind. docs/monsters.md § The pain elemental.
   */
  spawn?: { type: number };
  /**
   * Non-null for a ranged attack that throws a flying projectile sprite rather
   * than resolving as an instant hitscan bolt. `sprite` is confirmed against
   * `DOOM2.WAD`'s lump names; `speed` is that missile's own `mobjinfo.speed`
   * (fracunits per tic, so `× 35`), **not** a tuned value — eyeballing them
   * was a shipped bug. See docs/monsters.md § Hitscan vs. projectile.
   */
  projectile?: {
    sprite: string;
    speed: number;
    /**
     * Mancubus only — `A_FatAttack1/2/3` each spawn *two* `MT_FATSHOT`s fanned
     * by `FATSPREAD`. One entry per burst shot, listing that shot's radian
     * offsets from straight-at-target. Omitted (implicitly `[0]`) everywhere
     * else. See docs/monsters.md § Hitscan vs. projectile.
     */
    pairOffsetsRad?: number[][];
    /**
     * Cyberdemon only: its missile is a real `MT_ROCKET`, whose death state is
     * the one monster-projectile death state that calls `A_Explode`. Every
     * other monster fireball genuinely has no splash in vanilla either — this
     * isn't a simplification. docs/monsters.md § Hitscan vs. projectile.
     */
    splash?: { radius: number; damage: number };
    /**
     * Revenant only: `MT_TRACER`, the one monster projectile with a homing
     * flight state. Marks the *type* as homing-capable; whether a given shot
     * homes is `MonsterBody.homingBias`. `game/projectiles.ts`'s `advanceHoming`
     * implements the turn.
     */
    homing?: boolean;
  };
  /**
   * `P_CheckMissileRange`'s distance falloff. `rangeFalloffScale` (default 1)
   * shrinks distance before capping — vanilla halves it for the types it
   * special-cases; `rangeFalloffCap` (default 200) is its clamp, except the
   * cyberdemon's tighter 160. docs/monsters.md § Attacking.
   */
  rangeFalloffScale?: number;
  rangeFalloffCap?: number;
  /** Revenant-only (`MT_UNDEAD`): won't fire inside this distance, preferring to close to melee. Measured on the **offset** distance, as vanilla does. */
  minOffsetDist?: number;
  /** Arch-vile-only (`MT_VILE`): won't fire beyond `14*64`. The one genuine long-range cutoff in the game; also measured on the offset distance. */
  maxOffsetDist?: number;
  /**
   * Arch-vile only (`A_VileAttack`), replacing the hitscan-tracer stand-in:
   * guaranteed direct damage (`diceSides:1, diceMult:20` encodes vanilla's
   * unrolled literal) plus an upward launch, then a radius blast centred near
   * the victim rather than the vile. Applied only if the sight check at fire
   * time passes. docs/monsters.md § The arch-vile.
   */
  blast?: { knockUpSpeed: number; splashRadius: number; splashDamage: number };
}

/**
 * One monster type's sounds. The first four are its `mobjinfo` fields verbatim;
 * the rest are the sounds vanilla's own action functions play, mapped onto the
 * moments *this* engine has for them (its attacks are single events, not state
 * chains). Every field is optional because vanilla leaves plenty of them at
 * `sfx_None`. See docs/audio.md § Monsters.
 */
export interface MonsterSounds {
  /** `mobjinfo.seesound`, played by `A_Look` on waking. The two randomized families resolve through `randomVariant` at play time. */
  see?: SfxId;
  /** `mobjinfo.activesound` — the idle grunt `A_Chase` plays on a 3-in-256 roll per chase call. */
  active?: SfxId;
  /** `mobjinfo.painsound` (`A_Pain`), played only by a hit that actually staggers. */
  pain?: SfxId;
  /** `mobjinfo.deathsound` (`A_Scream`); a gibbed death plays `slop` instead, matching `A_XScream`. */
  death?: SfxId;
  /**
   * The one sound this engine's single melee moment plays. Vanilla splits that
   * moment in two — `A_Chase` plays `mobjinfo.attacksound` on *entering*
   * `meleestate` (the demon's `sgtatk`), the melee action itself plays its own
   * on connecting (`A_TroopAttack`/`A_BruisAttack`'s `claw`, `A_SkelFist`'s
   * `skepch`) — and no type but the revenant actually has both, so this is
   * whichever one that type owns, the connecting one where it owns two.
   */
  melee?: SfxId;
  /**
   * A hitscan attack's own shot sound: `A_PosAttack`'s `pistol`,
   * `A_SPosAttack`/`A_CPosAttack`'s `shotgn`. Doubles as the lost soul's
   * `A_SkullAttack` charge launch (`mobjinfo.attacksound`, `sklatk`), the same
   * "the attack fires now" moment. A projectile-thrower has none: the missile's
   * own launch sound covers it (`game.ts`'s `PROJECTILE_SOUNDS`), exactly as in
   * vanilla.
   */
  attack?: SfxId;
  /** Played when a ranged attack's windup *begins* — `A_FatRaise`'s `manatk`, `A_VileStart`'s `vilatk`. */
  windup?: SfxId;
  /**
   * Footsteps, and how far apart. Only the three heavy monsters have any
   * (`A_Hoof`/`A_Metal`/`A_BabyMetal` sit on individual walk states), and they
   * matter more here than in vanilla: a wide top-down view still can't show
   * what is stomping toward you from the next room. Vanilla's cyberdemon
   * alternates `hoof` and `metal` at an uneven 18/6-tic spacing within its
   * 24-tic run loop; `sounds` cycling on one even interval is the accepted
   * simplification, since this engine interpolates the walk instead of stepping
   * a state chain.
   */
  walk?: { sounds: readonly SfxId[]; interval: number };
}

export interface MonsterStats {
  /**
   * Map units/sec while chasing, **derived from vanilla, not tuned by feel**:
   * `speed × (A_Chase states in the walk loop) × 35 / (tics in the loop)`,
   * with no per-tic accumulation to lose in translation. See docs/monsters.md
   * § Timings and damage come from vanilla, not from feel.
   */
  speed: number;
  /**
   * Seconds between `A_Chase` calls — the walk loop's tics over its `A_Chase`
   * state count, over 35. **Vanilla's whole AI clock is quantized to this**:
   * how often attacking is reconsidered, how fast `reactiontime` drains, and
   * the unit `runChaseCall` fires on.
   */
  chaseInterval: number;
  /** Movement/collision circle radius — one approximate value per type rather than vanilla's real 16-128 unit per-species range, as `MONSTER_HIT_RADIUS` already is. */
  radius: number;
  /**
   * Vanilla's `mobjinfo.mass`, the genuine per-type figure (not an
   * approximation like `radius`). Feeds `thrustSpeed`, `P_DamageMobj`'s
   * horizontal knockback, so a cyberdemon barely budges from a hit that
   * staggers a zombieman. The arch-vile's separate *vertical* launch
   * (`VILE_KNOCKUP_SPEED`) still uses a flat 100. docs/movement.md § Knockback.
   */
  mass: number;
  melee: AttackStats | null;
  ranged: AttackStats | null;
  /** This type's vanilla sounds — see `MonsterSounds`. */
  sounds: MonsterSounds;
  /** Chance a hit staggers this monster (`reactToDamage`) — `mobjinfo.painchance` over 256, lifted exactly. */
  painChance: number;
  /** Seconds a stagger lasts — the `painstate` chain's summed tics over 35, 4 (imp, demon, baron) to 12 (cacodemon, pain elemental). */
  painDuration: number;
  /**
   * Vanilla's `MF_FLOAT` — exempts this monster from `circleBlocked`'s
   * `avoidDropoff`, matching `P_TryMove`. Cacodemon, lost soul and pain
   * elemental only. Real hover height isn't modelled (they walk the floor),
   * but they should still cross a ledge a grounded monster wouldn't.
   */
  flies?: boolean;
  /** Vanilla's `A_VileChase` corpse search, arch-vile only — tried before anything else on a chase call, falling through to the ordinary decision only if no corpse is raisable. */
  resurrects?: boolean;
}

export interface MonsterAttack {
  /**
   * `'vileWindup'` is purely cosmetic: fired when a `blast` attack *starts*,
   * so `game.ts` can show the warning flame the player reacts to. Its
   * `damage`/`angleRad` are unused.
   *
   * `'spawn'` is the pain elemental's `A_PainAttack`, also fired at attack
   * start and carrying no damage of its own — `angleRad` is the elemental's
   * facing, all `spawnLostSoul` needs to place the new monster.
   */
  kind: 'melee' | 'ranged' | 'resurrect' | 'vileWindup' | 'spawn';
  damage: number;
  /**
   * The individual rolls making up `damage` — one per bullet
   * (`AttackStats.pellets`). A hitscan attack traces each separately, since
   * each flies its own spread angle and hits or misses on its own; every other
   * kind reads the `damage` sum and ignores these. Empty for the attacks that
   * roll nothing at all (`spawn`, `vileWindup`, `resurrect`).
   */
  bullets: number[];
  /** The heading it was fired along (`A_FaceTarget`'s angle) — what a hitscan bolt traces down, so it can hit whatever is actually in the way. */
  angleRad: number;
  /** One flying projectile sprite per entry instead of an instant hitscan tracer. Almost always one entry; only the mancubus fires two at once (`pairOffsetsRad`). */
  projectiles?: {
    sprite: string;
    speed: number;
    angleRad: number;
    /** Carried straight from `AttackStats.projectile.splash`/`homing` — see those fields' docs. */
    splash?: { radius: number; damage: number };
    homing?: boolean;
  }[];
  /** Set only for the arch-vile's real `A_VileAttack` — see `AttackStats.blast`'s doc. `game.ts` applies direct damage plus knockback, then a radius blast, instead of the generic hitscan-tracer path every other non-projectile ranged monster uses. */
  blast?: { knockUpSpeed: number; splashRadius: number; splashDamage: number };
  /** Set only for a `'resurrect'` attack (`AttackStats.resurrects`): the raised corpse's `PosedThing` id — see `ThingLayer.update`, which applies the actual revival since `stepMonsterAI` has no access to the thing list itself. */
  resurrectId?: number;
}

/**
 * A fired `MonsterAttack`, plus who fired it and at what — what
 * `ThingLayer.update` hands back for the caller to realize (a tracer, a
 * projectile, `damage` on whatever it actually reached). Lives here rather than
 * with `ThingLayer`: everything it adds to `MonsterAttack` is a plain id or
 * coordinate, so it carries no dependency on the thing storage at all.
 */
export interface MonsterAttackEvent extends MonsterAttack, Pos3 {
  /** The firing monster's own id and doomednum, so a shot that lands on another monster can be attributed (and species-checked) correctly. */
  sourceId: number;
  sourceType: number;
  /** What it was aimed at: `null` for the player, otherwise another monster's id. */
  targetId: number | null;
}

/** One corpse `ThingLayer`'s `findRaisableCorpse` found eligible for the arch-vile to raise — just enough for `runChaseCall` to face it and report which one. */
export interface RaiseCandidate {
  id: number;
  x: number;
  y: number;
}

/** Vanilla's `MELEERANGE` (`p_local.h`: `64*FRACUNIT`). Not the melee threshold itself — see `meleeThreshold`. */
export const MELEE_RANGE = 64;

/**
 * `P_CheckMeleeRange`'s own bias. Vanilla tests
 * `dist >= MELEERANGE - 20*FRACUNIT + pl->info->radius` — it shortens
 * `MELEERANGE` by 20 and adds the **target's** radius back, so a swing reaches
 * further at a wide monster than at the player. GZDoom stores the shortened
 * value directly (`AActor::meleerange`, default 44) and compares
 * `dist >= meleerange + pl->radius`; identical threshold either way.
 */
const MELEE_RANGE_BIAS = 20;

/**
 * The 2D distance inside which a melee swing connects — 60 against the player
 * (radius 16), more against a wider victim in an infight. **Exclusive**:
 * vanilla returns false on `>=`. Distance itself is a real `hypot` rather than
 * `P_AproxDistance`'s octagonal approximation, which exists only to dodge a
 * fixed-point square root (the same call docs/audio.md § The mixer model makes).
 */
export function meleeThreshold(meleeRange: number, targetRadius: number): number {
  return meleeRange - MELEE_RANGE_BIAS + targetRadius;
}

/**
 * How close a charging lost soul has to get to land its `A_SkullAttack` hit.
 * **This engine's own, not vanilla**, which has no range test here at all: the
 * skull is `MF_SKULLFLY` and damages whatever its moving bounding box overlaps
 * in `PIT_CheckThing`, i.e. a true `radius + target radius` (32 against the
 * player) resolved by the movement code. This engine has no swept collision for
 * the charge, so a box that tight is tunnelled straight through at charge speed;
 * the value is the pre-formula `MELEE_RANGE` this test used to share, kept
 * unchanged so tightening the melee threshold didn't silently retune the lost
 * soul too. See docs/monsters.md § The lost soul.
 */
const SKULL_CONTACT_RANGE = 72;

/**
 * Whether attacker and target overlap vertically enough for a melee swing to
 * connect: refused once the target's feet clear the attacker's head, or the
 * target's head sits below the attacker's feet.
 *
 * **Deliberately not vanilla.** `P_CheckMeleeRange` (`p_enemy.c`) tests 2D
 * `P_AproxDistance` and `P_CheckSight` and nothing else, so a vanilla pinky
 * standing in a pit really can bite someone on the lip above it. This
 * reproduces ZDoom's guard instead — `p_enemy.cpp`'s `MF5_NOVERTICALMELEERANGE`
 * block, commented there "Don't melee things too far above or below actor" —
 * which is what GZDoom players see. See docs/monsters.md § Melee reach.
 */
export function meleeReachesVertically(
  attackerZ: number,
  attackerHeight: number,
  targetZ: number,
  targetHeight: number,
): boolean {
  if (targetZ > attackerZ + attackerHeight) return false;
  if (targetZ + targetHeight < attackerZ) return false;
  return true;
}

/** Vanilla's own `FATSPREAD` (`ANG90/8`) — the mancubus's fireball-pair fan angle, see `AttackStats.projectile.pairOffsetsRad`. */
const FATSPREAD = Math.PI / 2 / 8;

/**
 * Vanilla's `A_VileAttack` launch, `momz = 1000*FRACUNIT/mass` (`× 35` for
 * per-tic → units/sec). Deliberately uses vanilla's *default* mass 100 for
 * every victim rather than `MonsterStats.mass`, unlike `thrustSpeed` below —
 * an accepted approximation for one attack on one monster type.
 */
const VILE_KNOCKUP_SPEED = (1000 / 100) * 35;

/**
 * Vanilla's `P_DamageMobj` horizontal knockback: `damage*(FRACUNIT>>3)*100/mass`
 * per tic, `× 35` for units/sec. Callers pass the victim's real mass and apply
 * the result as an impulse away from the source. A hit with no inflictor
 * position (a damage floor, a crusher) never thrusts, matching vanilla's null
 * inflictor. See docs/movement.md § Knockback.
 */
export function thrustSpeed(damage: number, mass: number): number {
  return (damage / 8) * (100 / mass) * 35;
}

/** Vanilla's S_VILE_HEAL1-3: the arch-vile holds still for 30 tics while the corpse it just found rises. */
const VILE_HEAL_DURATION = 30 * DOOM_TIC;

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

/**
 * Vanilla's eight movement directions in `dirtype_t` order (E, NE, N, NW, W,
 * SW, S, SE), plus `DI_NODIR` for "nowhere to go". Monsters only ever walk
 * along these, never straight at the target — the reason a DOOM monster
 * approaches in visible zig-zags instead of gliding at you on a perfect
 * bearing.
 */
export const DI_NODIR = 8;
/** `opposite[]`: the about-face of each direction, which `newChaseDir` avoids picking. */
const OPPOSITE = [4, 5, 6, 7, 0, 1, 2, 3, DI_NODIR];
/** `diags[]`, indexed `((dy < 0) << 1) | (dx > 0)` → NW, NE, SW, SE. */
const DIAGS = [3, 1, 5, 7];
/**
 * `xspeed[]`/`yspeed[]`. The diagonals are `47000/65536 ≈ 0.717`, not `1`, so
 * a diagonal step comes out ~1.4% longer than a cardinal one rather than the
 * 41% a naive unit-per-axis table would give — DOOM monsters are very nearly
 * isotropic, and this is why.
 */
const DIR_X = [1, 0.71716, 0, -0.71716, -1, -0.71716, 0, 0.71716];
const DIR_Y = [0, 0.71716, 1, 0.71716, 0, -0.71716, -1, -0.71716];

/** `P_NewChaseDir`'s own deadband: an axis closer than this counts as already lined up. */
const CHASE_AXIS_EPSILON = 10;

/**
 * Height above a monster's feet a ranged attack's tracer is drawn from — the
 * monster's own equivalent of `game/player.ts`'s `AIM_HEIGHT_OFFSET`.
 */
export const MONSTER_FIRE_HEIGHT = 40;

/**
 * Single approximate hitbox every shot's ray is tested against
 * (`ThingLayer.raycastMonster`, and `spawnPlayerShot`'s locked-on test) — one
 * shared box, not `MonsterStats.radius`'s per-type value, so a spread pellet
 * misses the clicked monster at exactly the width any other bullet would.
 */
export const MONSTER_HIT_RADIUS = 24;
export const MONSTER_HIT_HEIGHT = 64;

/**
 * The two `MONSTER_TYPES` members with no entry in `MONSTER_STATS` below.
 * `MT_KEEN` and `MT_BOSSBRAIN` are `MF_SOLID|MF_SHOOTABLE` with no seestate,
 * meleestate or missilestate at all, so neither wakes, moves or attacks in
 * vanilla either. What a monster normally reads off `MonsterStats` that still
 * applies to something which only stands there and dies lives here instead: its
 * real `mobjinfo.radius`, and the two sounds `A_Pain`/`A_Scream` play.
 *
 * `unattenuated` is the brain's `A_BrainPain`/`A_BrainScream` calling
 * `S_StartSound(NULL, …)` — the Icon of Sin is heard flinching and dying from
 * anywhere on the map, the same rule `things.ts`'s `BOSS_TYPES` applies to the
 * cyberdemon and spider mastermind. Keen's own are ordinary positional calls.
 *
 * `ThingLayer.damage` is the only consumer. No pain *chance* here: neither type
 * has one worth rolling (256 and 255 of 256), so the flinch is unconditional.
 * docs/monsters.md § Commander Keen.
 */
export const INERT_SHOOTABLE: Record<
  number,
  { radius: number; painSound: SfxId; deathSound: SfxId; unattenuated: boolean }
> = {
  72: { radius: 16, painSound: 'keenpn', deathSound: 'keendt', unattenuated: false }, // KEEN
  88: { radius: 16, painSound: 'bospn', deathSound: 'bosdth', unattenuated: true }, // BBRN
};

/**
 * Per-doomednum combat stats, covering every `MONSTER_TYPES` entry except the
 * two in `INERT_SHOOTABLE` above.
 *
 * **Both timing and damage are lifted from vanilla, not tuned by feel.**
 * `speed`, `chaseInterval`, `painChance`, `painDuration` and every
 * `duration`/`shots`/`shotInterval` come from `info.c`'s `mobjinfo`/state
 * tables; `diceSides`/`diceMult` are each attack's own literal roll from
 * `p_enemy.c`, or `PIT_CheckThing`'s universal missile formula. Splash is
 * correctly non-uniform — only the cyberdemon's `MT_ROCKET` explodes in
 * vanilla. See docs/monsters.md § Timings and damage come from vanilla, not
 * from feel, and § Hitscan vs. projectile for which types get which attack.
 */
export const MONSTER_STATS: Record<number, MonsterStats> = {
  3004: {
    speed: 70,
    chaseInterval: 0.114,
    radius: 20,
    mass: 100,
    melee: null,
    // A_PosAttack: (rand%5+1)*3.
    ranged: { diceSides: 5, diceMult: 3, duration: 0.743 },
    painChance: 0.781,
    painDuration: 0.171,
    sounds: { see: 'posit1', active: 'posact', pain: 'popain', death: 'podth1', attack: 'pistol' },
  }, // POSS zombieman
  9: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    mass: 100,
    melee: null,
    // A_SPosAttack: 3 separate P_LineAttacks per call, each (rand%5+1)*3 —
    // see AttackStats.pellets's doc.
    ranged: { diceSides: 5, diceMult: 3, pellets: 3, duration: 0.857 },
    painChance: 0.664,
    painDuration: 0.171,
    sounds: { see: 'posit2', active: 'posact', pain: 'popain', death: 'podth2', attack: 'shotgn' },
  }, // SPOS shotgun guy
  65: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    mass: 100,
    melee: null,
    // A_CPosAttack: (rand%5+1)*3, once per shots:2 entry — A_CPosRefire
    // hoses without pause while it can see you.
    ranged: { diceSides: 5, diceMult: 3, duration: 0.257, shots: 2, shotInterval: 0.114, refire: true },
    painChance: 0.664,
    painDuration: 0.171,
    // `attack` really is the shotgun's: `A_CPosAttack` plays `sfx_shotgn`, not
    // the pistol shot its single-bullet roll would suggest — a vanilla oddity
    // (p_enemy.c), and the chaingunner's own `mobjinfo.attacksound` is 0.
    sounds: { see: 'posit2', active: 'posact', pain: 'popain', death: 'podth2', attack: 'shotgn' },
  }, // CPOS chaingunner
  84: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    mass: 100,
    melee: null,
    // SSWV fires the same A_CPosAttack as the chaingunner, twice (S_SSWV_ATK3/
    // ATK5, confirmed against info.c) with an A_CPosRefire loop of its own —
    // shotInterval is the two states between those calls (S_SSWV_ATK4's own
    // 6 tics + ATK3's own 4) over 35.
    ranged: { diceSides: 5, diceMult: 3, duration: 1.0, shots: 2, shotInterval: 10 * DOOM_TIC, refire: true },
    painChance: 0.664,
    painDuration: 0.171,
    sounds: { see: 'sssit', active: 'posact', pain: 'popain', death: 'ssdth', attack: 'shotgn' },
  }, // SSWV Wolfenstein SS
  3001: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    mass: 100,
    // A_TroopAttack melee: (rand%8+1)*3.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 3, duration: 0.629 },
    // A direct missile hit is vanilla's universal (rand%8+1)*mobjinfo.damage
    // (PIT_CheckThing/p_map.c) — TROOPSHOT's own damage field is 3.
    ranged: { diceSides: 8, diceMult: 3, duration: 0.629, projectile: { sprite: 'BAL1', speed: 350 } },
    painChance: 0.781,
    painDuration: 0.114,
    sounds: { see: 'bgsit1', active: 'bgact', pain: 'popain', death: 'bgdth1', melee: 'claw' },
  }, // TROO imp
  3002: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 30,
    mass: 400,
    // A_SargAttack: (rand%10+1)*4.
    melee: { range: MELEE_RANGE, diceSides: 10, diceMult: 4, duration: 0.686 },
    ranged: null,
    painChance: 0.703,
    painDuration: 0.114,
    // `A_SargAttack` itself is silent — the bite's sound is the `attacksound`
    // `A_Chase` plays on entering meleestate. See `MonsterSounds.melee`.
    sounds: { see: 'sgtsit', active: 'dmact', pain: 'dmpain', death: 'sgtdth', melee: 'sgtatk' },
  }, // SARG demon
  58: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 30,
    mass: 400,
    melee: { range: MELEE_RANGE, diceSides: 10, diceMult: 4, duration: 0.686 },
    ranged: null,
    painChance: 0.703,
    painDuration: 0.114,
    sounds: { see: 'sgtsit', active: 'dmact', pain: 'dmpain', death: 'sgtdth', melee: 'sgtatk' },
  }, // SARG spectre (same as demon; no invisibility rendering)
  3006: {
    speed: 46.7,
    chaseInterval: 0.171,
    radius: 16,
    mass: 50,
    melee: null,
    ranged: {
      // MF_SKULLFLY contact damage is the same universal missile-hit
      // formula as a thrown projectile (PIT_CheckThing's other branch):
      // (rand%8+1)*mobjinfo.damage, and MT_SKULL's own damage field is 3.
      diceSides: 8,
      diceMult: 3,
      duration: 0.629,
      rangeFalloffScale: 0.5,
      charge: { speed: 700, maxDist: WEAPON_RANGE },
    },
    painChance: 1,
    painDuration: 0.171,
    // No sight sound at all (`mobjinfo.seesound` is 0), and its death sound is
    // the *fireball* explosion `firxpl` rather than a scream. `attack` is
    // `A_SkullAttack`'s own `sklatk`, played as the charge launches.
    sounds: { active: 'dmact', pain: 'dmpain', death: 'firxpl', attack: 'sklatk' },
    flies: true,
  }, // SKUL lost soul — drifts slowly, then hurls itself (A_SkullAttack, SKULLSPEED = 20 units/tic)
  3005: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 31,
    mass: 400,
    // A_HeadAttack melee: (rand%6+1)*10.
    melee: { range: MELEE_RANGE, diceSides: 6, diceMult: 10, duration: 0.429 },
    // Universal missile-hit formula; HEADSHOT's own damage field is 5.
    ranged: { diceSides: 8, diceMult: 5, duration: 0.429, projectile: { sprite: 'BAL2', speed: 350 } },
    painChance: 0.5,
    painDuration: 0.343,
    // `A_HeadAttack`'s bite has no sound of its own and the cacodemon's
    // `attacksound` is 0, so its melee really is silent in vanilla too.
    sounds: { see: 'cacsit', active: 'dmact', pain: 'dmpain', death: 'cacdth' },
    flies: true,
  }, // HEAD cacodemon — one attack state that bites up close and spits a fireball otherwise (A_HeadAttack)
  3003: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 24,
    mass: 1000,
    // A_BruisAttack melee: (rand%8+1)*10.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 10, duration: 0.686 },
    // Universal missile-hit formula; BRUISERSHOT's own damage field is 8.
    ranged: { diceSides: 8, diceMult: 8, duration: 0.686, projectile: { sprite: 'BAL7', speed: 525 } },
    painChance: 0.195,
    painDuration: 0.114,
    sounds: { see: 'brssit', active: 'dmact', pain: 'dmpain', death: 'brsdth', melee: 'claw' },
  }, // BOSS baron of hell
  69: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 24,
    mass: 1000,
    // Baron and hell knight share A_BruisAttack/MT_BRUISERSHOT exactly.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 10, duration: 0.686 },
    ranged: { diceSides: 8, diceMult: 8, duration: 0.686, projectile: { sprite: 'BAL7', speed: 525 } },
    painChance: 0.195,
    painDuration: 0.114,
    sounds: { see: 'kntsit', active: 'dmact', pain: 'dmpain', death: 'kntdth', melee: 'claw' },
  }, // BOS2 hell knight — vanilla's hell knight throws the same BAL7 fireball as the baron
  71: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 31,
    mass: 400,
    melee: null,
    // A_PainAttack deals no damage of its own — diceSides/diceMult are unused
    // (fireAttack is never reached for a `spawn` attack, see
    // beginRangedAttack) and left at 0 rather than optional so this stays the
    // same required shape as every other AttackStats. The real bite comes
    // from whatever the spawned lost soul itself lands (AttackStats.charge on
    // doomednum 3006, above).
    ranged: { diceSides: 0, diceMult: 0, duration: 0.429, spawn: { type: 3006 } },
    painChance: 0.5,
    painDuration: 0.343,
    // `A_PainAttack` is silent; the lost soul it spawns brings its own `sklatk`.
    sounds: { see: 'pesit', active: 'dmact', pain: 'pepain', death: 'pedth' },
    flies: true,
  }, // PAIN pain elemental — A_PainAttack/A_PainShootSkull, spawns a lost soul and launches it at the elemental's own target
  66: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 20,
    mass: 500,
    // A_SkelFist: (rand%10+1)*6.
    melee: { range: MELEE_RANGE, diceSides: 10, diceMult: 6, duration: 0.514 },
    ranged: {
      // Universal missile-hit formula; TRACER's own damage field is 10.
      diceSides: 8,
      diceMult: 10,
      duration: 0.857,
      // A_Tracer — the one monster projectile with real homing; see
      // AttackStats.projectile.homing's doc.
      projectile: { sprite: 'FATB', speed: 350, homing: true },
      rangeFalloffScale: 0.5,
      minOffsetDist: 196,
    },
    painChance: 0.391,
    painDuration: 0.286,
    // The one type with two melee sounds in vanilla — `A_SkelWhoosh`'s `skeswg`
    // during the windup, then `A_SkelFist`'s `skepch` on connecting. This
    // engine's melee is one moment, so it takes the punch. Its pain sound is
    // the *human* `popain`, which is vanilla's own `mobjinfo`, not a slip.
    sounds: { see: 'skesit', active: 'skeact', pain: 'popain', death: 'skedth', melee: 'skepch' },
  }, // SKEL revenant
  67: {
    speed: 70,
    chaseInterval: 0.114,
    radius: 48,
    mass: 1000,
    melee: null,
    ranged: {
      // Universal missile-hit formula; FATSHOT's own damage field is 8.
      diceSides: 8,
      diceMult: 8,
      duration: 2.286,
      shots: 3,
      shotInterval: 0.571,
      projectile: {
        sprite: 'MANF',
        speed: 700,
        // A_FatAttack1/2/3: each volley's first MT_FATSHOT flies straight at
        // the target (P_SpawnMissile ignores the actor's own facing), the
        // second is deflected — asymmetrically for the first two volleys,
        // straddling evenly for the third. See the field's own doc.
        pairOffsetsRad: [
          [0, FATSPREAD],
          [0, -2 * FATSPREAD],
          [-FATSPREAD / 2, FATSPREAD / 2],
        ],
      },
    },
    painChance: 0.313,
    painDuration: 0.171,
    // `windup` is `A_FatRaise`'s own `manatk`, on the first frame of the
    // missilestate chain — the tell that a triple volley is coming. The
    // fireballs themselves are `firsht`, from the missile, not from here.
    sounds: { see: 'mansit', active: 'posact', pain: 'mnpain', death: 'mandth', windup: 'manatk' },
  }, // FATT mancubus — A_FatAttack1/2/3, three volleys out of one 80-tic attack state, each firing a pair of fireballs
  68: {
    speed: 116.7,
    chaseInterval: 0.103,
    radius: 64,
    mass: 600,
    melee: null,
    // Universal missile-hit formula; ARACHPLAZ's own damage field is 5.
    ranged: { diceSides: 8, diceMult: 5, duration: 0.257, refire: true, projectile: { sprite: 'APLS', speed: 875 } },
    painChance: 0.5,
    painDuration: 0.171,
    // `A_BabyMetal` sits on 2 of its 12 3-tic run states — every 18 tics.
    sounds: {
      see: 'bspsit',
      active: 'bspact',
      pain: 'dmpain',
      death: 'bspdth',
      walk: { sounds: ['bspwlk'], interval: 18 * DOOM_TIC },
    },
  }, // BSPI arachnotron — A_SpidRefire, same never-let-up loop as the chaingunner
  7: {
    speed: 105,
    chaseInterval: 0.114,
    radius: 128,
    mass: 1000,
    melee: null,
    // Fires A_SPosAttack (the shotgun guy's own 3-pellet, (rand%5+1)*3
    // hitscan) twice per shots:2 entry — confirmed against info.c's
    // S_SPID_ATK2/ATK3 — with A_SpidRefire's own looser refire roll.
    ranged: {
      diceSides: 5,
      diceMult: 3,
      pellets: 3,
      duration: 0.257,
      shots: 2,
      shotInterval: 0.114,
      refire: true,
      rangeFalloffScale: 0.5,
    },
    painChance: 0.156,
    painDuration: 0.171,
    // `A_Metal` sits on 3 of its 12 3-tic run states — every 12 tics.
    sounds: {
      see: 'spisit',
      active: 'dmact',
      pain: 'dmpain',
      death: 'spidth',
      attack: 'shotgn',
      walk: { sounds: ['metal'], interval: 12 * DOOM_TIC },
    },
  }, // SPID spider mastermind (real hitscan chaingun in vanilla too)
  16: {
    speed: 140,
    chaseInterval: 0.114,
    radius: 40,
    mass: 1000,
    melee: null,
    ranged: {
      // Universal missile-hit formula; ROCKET's own damage field is 20 —
      // already matched this engine's damage-dice values before this pass.
      diceSides: 8,
      diceMult: 20,
      duration: 1.886,
      shots: 3,
      shotInterval: 0.343,
      // A_CyberAttack spawns a real MT_ROCKET — the same type the player's
      // own launcher fires, and the one monster projectile whose death
      // state actually calls A_Explode; see AttackStats.projectile.splash's
      // doc. radius/damage are vanilla's own literal P_RadiusAttack(...,128).
      projectile: { sprite: 'MISL', speed: 700, splash: { radius: 128, damage: 128 } },
      rangeFalloffScale: 0.5,
      rangeFalloffCap: 160,
    },
    painChance: 0.078,
    painDuration: 0.286,
    // `A_Hoof` on run state 1 and `A_Metal` on run state 7 of an 8-state,
    // 3-tic loop — 24 tics for the pair, evened out to one every 12 (see
    // `MonsterSounds.walk`). Its sight and death roars are unattenuated in
    // vanilla, which `ThingLayer` applies by type (`BOSS_TYPES`).
    sounds: {
      see: 'cybsit',
      active: 'dmact',
      pain: 'dmpain',
      death: 'cybdth',
      walk: { sounds: ['hoof', 'metal'], interval: 12 * DOOM_TIC },
    },
  }, // CYBR cyberdemon — three rockets per volley, the same MISL sprite the player's own launcher fires
  // VILE arch-vile: vanilla's own P_CheckMissileRange refuses to fire beyond 14*64=896 map units
  // for this type specifically (MT_VILE), tighter than the generic 200-unit falloff cap below.
  64: {
    speed: 262.5,
    chaseInterval: 0.057,
    radius: 20,
    mass: 500,
    melee: null,
    ranged: {
      maxOffsetDist: 896,
      // Vanilla's A_VileAttack deals a flat, unrolled 20 — diceSides:1 makes
      // rollDamage always return exactly diceMult regardless of the roll.
      diceSides: 1,
      diceMult: 20,
      duration: 2.686,
      // A_VileAttack doesn't fire until 66 tics into the missilestate chain
      // (ATK1..ATK9's summed tics) — see AttackStats.startDelaySeconds's doc.
      startDelaySeconds: 66 * DOOM_TIC,
      blast: { knockUpSpeed: VILE_KNOCKUP_SPEED, splashRadius: 70, splashDamage: 70 },
    },
    painChance: 0.039,
    painDuration: 0.286,
    // `windup` is `A_VileStart`'s `vilatk`, at the same moment the warning
    // flame appears (`game.ts` adds the flame's own `flamst`); the blast
    // itself is `A_VileAttack`'s `barexp`, played from there.
    sounds: { see: 'vilsit', active: 'vilact', pain: 'vipain', death: 'vildth', windup: 'vilatk' },
    resurrects: true,
  }, // VILE arch-vile
};

/**
 * How long the arch-vile's windup flame tracks its target — read off the
 * vile's own `startDelaySeconds` rather than duplicated, so the flame can't
 * drift away from the moment the real shot lands or fizzles. Lives here, with
 * the table it is derived from, rather than in `effectdefs.ts` beside the other
 * `VILE_FIRE_*` values: that file is otherwise free of `MONSTER_STATS`, and
 * keeping it that way is what lets this file import it.
 */
export const VILE_WINDUP_TRACK_SECONDS = MONSTER_STATS[64].ranged?.startDelaySeconds ?? 0;

/**
 * `P_LookForPlayers`'s field-of-view gate: the forward ~180°, unless the
 * player is within `MELEERANGE`. Initial wake-up only — `A_Chase` never
 * re-applies it to an already-hunting monster. docs/monsters.md § Waking up.
 */
export function canSpotPlayer(facingDeg: number, monsterX: number, monsterY: number, playerX: number, playerY: number): boolean {
  const dist = Math.hypot(playerX - monsterX, playerY - monsterY);
  if (dist <= MELEE_RANGE) return true;
  const toPlayerDeg = (Math.atan2(playerY - monsterY, playerX - monsterX) * 180) / Math.PI;
  const diff = Math.abs((((toPlayerDeg - facingDeg + 180) % 360) + 360) % 360 - 180);
  return diff <= 90;
}

/** The subset of `PosedThing` (`game/things.ts`) `tryWake` needs — position, facing, its ambush flag, and the two fields it mutates on success. */
export interface WakeCheckBody extends Pos3 {
  facingDeg: number;
  ambush: boolean;
  alerted: boolean;
  reactionTicks: number;
}

/**
 * Vanilla's idle `A_Look`, called once per unalerted monster on
 * `ThingLayer.update`'s `LOOK_INTERVAL` throttle. Sound, ambush/deaf things
 * and the ordinary FOV+sight path are all handled here — docs/monsters.md §
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

/** The arch-vile's doomednum — vanilla singles `MT_VILE` out in both directions of the retarget rule below. */
const VILE_TYPE = 64;

/**
 * Vanilla's target-switch rule out of `P_DamageMobj` — the whole mechanism
 * behind infighting, with two carve-outs: a monster still inside its
 * `threshold` ignores new attackers (an arch-vile is exempt), and nothing
 * ever retaliates against an arch-vile. docs/monsters.md § Infighting.
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
 * Whether a monster-fired *projectile* deals no damage to `victimType` —
 * `PIT_CheckThing`'s "don't hit same species as originator". Barons and hell
 * knights are one species in both directions, vanilla's one hardcoded
 * cross-type pairing. Projectiles only: hitscan has no species check, so
 * zombiemen really do gun each other down.
 *
 * **This is not a pass-through** — the missile stops dead on a same-species
 * body. `game/projectiles.ts: monsterStruckBy` owns that distinction; docs/monsters.md §
 * Infighting has why it decides whole fights on a crowded map.
 */
export function sameSpecies(shooterType: number, victimType: number): boolean {
  if (shooterType === victimType) return true;
  const bruisers = new Set([3003, 69]); // BOSS baron of hell, BOS2 hell knight
  return bruisers.has(shooterType) && bruisers.has(victimType);
}

/** Settles vertical position/velocity the same way `Player.update` does: snap while grounded, integrate gravity while airborne. */
function settleVertical(body: MonsterBody, world: World, radius: number, dt: number): void {
  const groundZ = world.groundFloor(body.x, body.y, radius, true);
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
 * Vanilla's `P_CheckMissileRange`, run as the real per-attempt roll once per
 * chase call rather than converted into a cooldown — `runChaseCall` ticks at
 * vanilla's cadence, so it can afford to sample it as often as vanilla does.
 * The roll *suppresses* the shot, so fire chance is `(256 - dist) / 256`.
 * `MF_JUSTHIT` short-circuits all of it. docs/monsters.md § Attacking.
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
 */
function tryWalk(body: MonsterBody, stats: MonsterStats, world: World, dir: number, blockers?: readonly ThingBlocker[]): boolean {
  const step = stats.speed * stats.chaseInterval;
  const nx = body.x + DIR_X[dir] * step;
  const ny = body.y + DIR_Y[dir] * step;
  if (circleBlocked(world, nx, ny, stats.radius, body.z, true, !stats.flies, blockers, body)) return false;
  body.movedir = dir;
  body.movecount = Math.floor(Math.random() * 16);
  return true;
}

/**
 * Vanilla's `P_NewChaseDir`, reproduced step for step: the both-axes diagonal,
 * then the two cardinals, then the previous heading, then a full eight-way
 * scan from a randomly chosen end, and the about-face only as a last resort.
 * That last-resort ordering and the random scan direction are both
 * load-bearing — docs/monsters.md § Movement.
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
 * lost soul is what makes the attack fair. docs/monsters.md § The lost soul.
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
 * 8-way pathing, no stutter. See docs/monsters.md § Movement and § Attacking.
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
  resurrect?: (x: number, y: number, vileRadius: number) => RaiseCandidate | null,
  sfx: SoundEmitter = SILENT,
): MonsterAttack | null {
  if (body.painTimer > 0) {
    body.painTimer = Math.max(0, body.painTimer - dt);
    settleVertical(body, world, stats.radius, dt);
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
    settleVertical(body, world, stats.radius, dt);
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
        // arch-vile's blast plays `barexp` from `game.ts` instead.
        if (stats.sounds.attack) sfx.play(stats.sounds.attack, body, monsterOrigin(body.id));
      }
      body.burstLeft -= 1;
      body.burstTimer = ranged.shotInterval ?? 0;
    }
  }

  if (body.attackPause > 0) {
    settleVertical(body, world, stats.radius, dt);
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
    if (circleBlocked(world, nx, ny, stats.radius, body.z, true, !stats.flies, blockers, body)) {
      body.moveBlocked = true;
    } else {
      body.x = nx;
      body.y = ny;
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

  settleVertical(body, world, stats.radius, dt);
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
 * One `A_Chase` call, in vanilla's own order: age the counters, burn a call to
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
  resurrect: ((x: number, y: number, vileRadius: number) => RaiseCandidate | null) | undefined,
  sfx: SoundEmitter,
): MonsterAttack | null {
  // A_VileChase: try to raise a corpse instead of taking this chase call's
  // ordinary turn, matching vanilla exactly — a tic that finds one replaces
  // A_Chase outright, skipping the reactiontime/threshold aging and
  // melee/missile/walk decisions below entirely rather than merely
  // pre-empting them.
  if (stats.resurrects && resurrect && body.movedir !== DI_NODIR) {
    // One chase call's worth of travel ahead of the vile's own position —
    // vanilla's own viletryx/y (A_VileChase), scaled from vanilla's
    // per-tic speed to this engine's units-per-second one.
    const stepDist = stats.speed * stats.chaseInterval;
    const aheadX = body.x + DIR_X[body.movedir] * stepDist;
    const aheadY = body.y + DIR_Y[body.movedir] * stepDist;
    const found = resurrect(aheadX, aheadY, stats.radius);
    if (found) {
      body.angle = Math.atan2(found.y - body.y, found.x - body.x); // A_FaceTarget at the corpse
      body.attackPause = VILE_HEAL_DURATION;
      return { kind: 'resurrect', damage: 0, bullets: [], angleRad: body.angle, resurrectId: found.id };
    }
  }

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

// ---------------------------------------------------------------------------
// Attack resolution
//
// Everything above decides *that* a monster attacks and reports a
// `MonsterAttackEvent`; everything below works out what that attack actually
// does to the world. The two halves are kept apart by their dependencies: the
// AI above touches nothing but a `MonsterBody`, while `MonsterAttacks` needs
// the thing list, the effect and projectile layers, and the audio engine.
// docs/monsters.md § Resolving an attack.
// ---------------------------------------------------------------------------

/**
 * How far off-aim each monster bullet is thrown — `p_enemy.c`'s
 * `(P_Random()-P_Random())<<20` BAM, ±255/4096 of a full turn, triangular.
 * Why it is the difference between a survivable gunner and a lethal one:
 * docs/monsters.md § Hitscan vs. projectile.
 */
const MONSTER_BULLET_SPREAD_DEG = (255 / 4096) * 360;

/**
 * Slack added to the player's radius when testing a monster's hitscan bolt —
 * it makes a circle present the same average target as vanilla's 32-unit
 * *box*, and covers nothing else. docs/monsters.md § Hitscan vs. projectile.
 */
const MONSTER_BULLET_SLOP = 4;

/**
 * Vanilla's `A_FaceTarget`: aiming at an `MF_SHADOW` thing (here only ever the
 * player under partial invisibility) throws the facing off by
 * `(P_Random()-P_Random())<<21` BAM, ±255/2048 of a full turn. That is the
 * entire blur-sphere mechanic — it never touches sight or waking.
 */
const SHADOW_AIM_SPREAD_DEG = (255 / 2048) * 360;

/**
 * Realizes the attacks `ThingLayer.update` reported this frame: a melee swing
 * lands, a hitscan volley traces bolt by bolt, a projectile is launched, the
 * arch-vile's blast and warning flame are applied. Nothing here decides to
 * attack — that already happened in `stepMonsterAI`.
 *
 * The counterpart for shots that take time to arrive is `ProjectileLayer`
 * (game/projectiles.ts), which this hands the flying ones to. Both read the
 * live level through the same `CombatContext`.
 */
export class MonsterAttacks {
  private ctx: CombatContext;
  private effects: EffectLayer;
  private projectiles: ProjectileLayer;
  private audio: AudioEngine;
  private isPlayerShadowed: () => boolean;

  /**
   * `isPlayerShadowed` is a callback rather than an `Inventory` reference:
   * whether the player currently holds partial invisibility is inventory
   * state, and nothing else in this file has any reason to reach that far.
   */
  constructor(
    ctx: CombatContext,
    effects: EffectLayer,
    projectiles: ProjectileLayer,
    audio: AudioEngine,
    isPlayerShadowed: () => boolean,
  ) {
    this.ctx = ctx;
    this.effects = effects;
    this.projectiles = projectiles;
    this.audio = audio;
    this.isPlayerShadowed = isPlayerShadowed;
  }

  /** Applies every attack fired this frame, in the order they were reported. */
  resolve(attacks: readonly MonsterAttackEvent[]): void {
    for (const atk of attacks) {
      this.applyShadowAim(atk);
      // The arch-vile's windup warning — see `spawnWindupFire`. Purely
      // cosmetic (no damage, no trace), so it's handled before every other
      // kind below and separately from them.
      if (atk.kind === 'vileWindup') {
        this.spawnWindupFire(atk);
        continue;
      }
      // A monster with a real flying projectile (`MONSTER_STATS`, e.g. the
      // imp's fireball) launches one instead of resolving as an instant hit —
      // damage lands later, on arrival (`ProjectileLayer.update`), not here.
      if (atk.kind === 'ranged' && atk.projectiles) {
        this.projectiles.spawnMonsterShot(atk);
      } else if (atk.kind === 'ranged' && atk.blast) {
        this.resolveVileBlast(atk);
      } else if (atk.kind === 'ranged') {
        this.resolveHitscan(atk);
      } else {
        // Melee lands on whatever it swung at, no trace involved.
        this.applyDirectDamage(atk.targetId, atk.damage, atk.sourceId, atk.sourceType, atk.x, atk.y);
      }
    }
  }

  /**
   * `EffectLayer`'s `VileFlameResolver`: where the arch-vile's flame belongs
   * this frame, or null if it should stay put. Lives here rather than in the
   * effect layer because the answer depends on live monster/player state (and
   * on `A_Fire`'s sightline rule) that the batch has no reason to know.
   */
  vileFlameFor(vileId: number, targetId: number | null): Pos3 | null {
    const vile = this.ctx.things?.monsterById(vileId);
    const target = targetId === null ? this.ctx.player : this.ctx.things?.monsterById(targetId);
    if (!vile || !target || !hasLineOfSight(this.ctx.world, vile, target)) return null;
    return fireFrontOf(target);
  }

  /**
   * Applies a monster's damage to whatever it landed on — the player when
   * `targetId` is null, otherwise another monster, tagged with who did it so
   * `ThingLayer.damage` can run vanilla's retaliation rule and start an
   * infight. `fromX`/`fromY` are the attacking monster's own position, for the
   * knockback thrust both sides derive.
   */
  private applyDirectDamage(
    targetId: number | null,
    damage: number,
    sourceId: number,
    sourceType: number,
    fromX: number,
    fromY: number,
  ): void {
    if (targetId === null) this.ctx.damagePlayer(damage, fromX, fromY);
    else this.ctx.things?.damage(targetId, damage, { id: sourceId, type: sourceType }, undefined, fromX, fromY);
  }

  /**
   * Throws a monster's ranged shot off-aim while the player holds partial
   * invisibility — `A_FaceTarget`'s fuzz, applied once per fired shot so each
   * shot of a burst goes its own way. It fuzzes the *aim* the volley is built
   * on, which is why it lands here rather than per bullet: vanilla fuzzes
   * `actor->angle`, and `A_SPosAttack`'s pellets all spread off that one fuzzed
   * `bangle`. Player-aimed shots only (nothing else carries `MF_SHADOW`), and
   * ranged only: a melee swing lands on `P_CheckMeleeRange`, never on the
   * fuzzed angle. See docs/items.md § Powerups and the backpack.
   */
  private applyShadowAim(atk: MonsterAttackEvent): void {
    if (atk.kind !== 'ranged' || atk.targetId !== null || !this.isPlayerShadowed()) return;
    const off = triangularSpread(SHADOW_AIM_SPREAD_DEG);
    atk.angleRad += off;
    if (atk.projectiles) for (const proj of atk.projectiles) proj.angleRad += off;
  }

  /**
   * The arch-vile's `A_VileAttack` (`atk.blast`): not a traced bolt at all —
   * vanilla damages `actor->target` directly (guaranteed, nothing to miss
   * along), launches it upward, then blasts a radius. No tracer or projectile
   * sprite; the `FIRE` spawned here is `MT_FIRE`'s final burst, taking over
   * from `spawnWindupFire`'s. See docs/monsters.md § The arch-vile.
   */
  private resolveVileBlast(atk: MonsterAttackEvent): void {
    if (!atk.blast) return;
    const player = this.ctx.player;
    const victim = atk.targetId === null ? null : this.ctx.things?.monsterById(atk.targetId);
    const at = victim ? { x: victim.x, y: victim.y, z: victim.z } : { x: player.x, y: player.y, z: player.z };
    if (atk.targetId === null) {
      // A no-op hit (already dead, or invulnerable) reports false — see
      // `CombatContext.damagePlayer` — and skips the knockup along with it.
      if (this.ctx.damagePlayer(atk.damage, atk.x, atk.y)) player.launchUpward(atk.blast.knockUpSpeed);
    } else {
      this.ctx.things?.damage(
        atk.targetId,
        atk.damage,
        { id: atk.sourceId, type: atk.sourceType },
        atk.blast.knockUpSpeed,
        atk.x,
        atk.y,
      );
    }
    // A_VileAttack's own sound is the barrel/rocket explosion, played on the
    // vile rather than on the flame it just placed.
    this.audio.play('barexp', atk, monsterOrigin(atk.sourceId));
    const offset = vileBlastOffset(atk, at);
    const fireAt = { x: at.x + offset.x, y: at.y + offset.y, z: at.z };
    applyRadiusDamage(this.ctx, fireAt, atk.blast.splashRadius, atk.blast.splashDamage, true, {
      id: atk.sourceId,
      type: atk.sourceType,
    });
    this.effects.spawnImpact('FIRE', VILE_FIRE_FRAMES, IMPACT_FRAME_SECONDS, fireAt);
  }

  /**
   * The arch-vile's warning flame, spawned when its windup starts — vanilla's
   * `MT_FIRE`. Reuses `EffectLayer.spawn` but overrides the lifetime to the
   * windup's own length, so `resolveVileBlast`'s burst (or nothing, if the shot
   * fizzles) takes over with no explicit hand-off. Positioned up front, as
   * `A_VileTarget` calls `A_Fire` immediately after spawning. See
   * docs/monsters.md § The arch-vile.
   */
  private spawnWindupFire(atk: MonsterAttackEvent): void {
    const target = atk.targetId === null ? this.ctx.player : this.ctx.things?.monsterById(atk.targetId);
    if (!target) return;
    const front = fireFrontOf(target);
    // A_StartFire, on the flame itself (`vilatk` comes from the vile at the same
    // moment, via MonsterSounds.windup) — the two together are the warning.
    this.audio.play('flamst', front);
    const effect = this.effects.spawn('FIRE', VILE_FIRE_FRAMES, IMPACT_FRAME_SECONDS, front);
    if (!effect) return;
    effect.lifetime = VILE_WINDUP_TRACK_SECONDS;
    effect.followTargetId = atk.targetId;
    effect.vileSourceId = atk.sourceId;
    this.effects.addImpact(effect);
  }

  /**
   * Fires every bullet of a monster's hitscan attack: one traced bolt per
   * `MonsterAttack.bullets` entry, each thrown off by its own
   * `MONSTER_BULLET_SPREAD_DEG` draw and carrying its own damage roll, so a
   * shotgun guy's three pellets land independently. All of them share the one
   * aim slope, matching `A_SPosAttack` computing `slope` once before its loop.
   */
  private resolveHitscan(atk: MonsterAttackEvent): void {
    // Sloped from the monster's fire height to the target's, the way
    // P_AimLineAttack works out a slope before P_LineAttack traces it — what
    // lets a zombieman on a ledge shoot down at you.
    const player = this.ctx.player;
    const victim = atk.targetId === null ? null : this.ctx.things?.monsterById(atk.targetId);
    const aim = victim
      ? { x: victim.x, y: victim.y, z: victim.z + MONSTER_FIRE_HEIGHT }
      : { x: player.x, y: player.y, z: player.z + AIM_HEIGHT_OFFSET };
    for (const damage of atk.bullets)
      this.resolveBullet(atk, atk.angleRad + triangularSpread(MONSTER_BULLET_SPREAD_DEG), damage, aim);
  }

  /**
   * One bullet of that volley: it damages the first thing it reaches — nearest
   * of a wall, another monster in the line of fire, or the player wins.
   * `P_LineAttack` has no notion of an intended target and no species check,
   * which is why one zombieman firing past another starts a fight. The tracer
   * is drawn to where the bolt stopped, not to the target.
   */
  private resolveBullet(atk: MonsterAttackEvent, angleRad: number, damage: number, aim: Pos3): void {
    const { world, things, player } = this.ctx;
    // `WEAPON_RANGE` rather than the distance to `aim`: a bullet the spread
    // threw wide keeps flying, and can still find a wall or another monster
    // behind whoever it was fired at. `P_LineAttack(..., MISSILERANGE, ...)`.
    const path = shotPath(world, atk, angleRad, aim, WEAPON_RANGE, false);

    // The trace damages the first body it reaches, whatever it was aimed at.
    const blocker = things?.raycastMonster(atk, angleRad, path.dist, {
      ignoreId: atk.sourceId,
      includeHidden: true,
    });
    const dirX = Math.cos(angleRad);
    const dirY = Math.sin(angleRad);
    const relX = player.x - atk.x;
    const relY = player.y - atk.y;
    const playerAlong = relX * dirX + relY * dirY;
    const perpX = relX - dirX * playerAlong;
    const perpY = relY - dirY * playerAlong;
    const playerInPath =
      !this.ctx.playerDead &&
      playerAlong >= 0 &&
      playerAlong <= path.dist &&
      Math.hypot(perpX, perpY) <= PLAYER_RADIUS + MONSTER_BULLET_SLOP;

    let endX = atk.x + dirX * path.dist;
    let endY = atk.y + dirY * path.dist;
    let endZ = path.z;
    if (blocker && (!playerInPath || blocker.dist <= playerAlong)) {
      things?.damage(blocker.id, damage, { id: atk.sourceId, type: atk.sourceType }, undefined, atk.x, atk.y);
      endX = blocker.x;
      endY = blocker.y;
      endZ = blocker.z + MONSTER_FIRE_HEIGHT;
      const hitAt = { x: endX, y: endY, z: endZ };
      if (things?.bleeds(blocker.id)) this.effects.spawnBlood(hitAt, damage);
      else this.effects.spawnPuff(hitAt);
    } else if (playerInPath) {
      this.ctx.damagePlayer(damage, atk.x, atk.y);
      endX = player.x;
      endY = player.y;
      endZ = player.z + AIM_HEIGHT_OFFSET;
      // The player carries no MF_NOBLOOD either, so a bolt that reaches them
      // splashes exactly as one landing on a monster does — and unlike the
      // pain flash this isn't gated on the damage actually landing, matching
      // `PTR_ShootTraverse` spawning blood before it calls `P_DamageMobj`.
      this.effects.spawnBlood({ x: endX, y: endY, z: endZ }, damage);
    } else {
      // Nothing living stopped it — whatever's left is a wall, the only thing
      // `shotPath` itself could have blocked it on. `triggerShot`'s `byMonster`
      // gate reproduces vanilla's own hardcoded exception: this can only
      // actually do anything for a 46 line, never 24/47.
      this.ctx.triggerShot(path.lineIndex, true);
      this.effects.spawnWallPuff(path, angleRad);
    }
    this.effects.addTracer(atk, { x: endX, y: endY, z: endZ }, MONSTER_TRACER_COLOR);
  }
}

/**
 * Vanilla's `A_Fire`: 24 units in front of wherever the target is *currently
 * facing*, not toward the vile — contrast `vileBlastOffset`, which is
 * `A_VileAttack`'s genuinely different final reposition.
 */
function fireFrontOf(target: Pos3 & { angle: number }): Pos3 {
  return {
    x: target.x + Math.cos(target.angle) * VILE_FIRE_OFFSET,
    y: target.y + Math.sin(target.angle) * VILE_FIRE_OFFSET,
    z: target.z,
  };
}

/**
 * `resolveVileBlast`'s one-time final reposition — `A_VileAttack` moves the
 * fire 24 units from the target back toward the shooter, a genuinely different
 * formula from the windup's target-facing one, not an inconsistency here. The
 * offset also keeps the flame from spawning at the target's exact x/y/z, where
 * two anchored billboards hide each other.
 */
function vileBlastOffset(atk: MonsterAttackEvent, targetPos: Pos2): Pos2 {
  const towardVile = Math.atan2(atk.y - targetPos.y, atk.x - targetPos.x);
  return { x: Math.cos(towardVile) * VILE_FIRE_OFFSET, y: Math.sin(towardVile) * VILE_FIRE_OFFSET };
}
