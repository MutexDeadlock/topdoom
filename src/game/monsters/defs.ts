/**
 * The record shapes every monster system passes around, the constants tied to
 * those shapes, and the pure helpers derived from `info.c`/`p_enemy.c`
 * literals. The tables read *through* these shapes are `monsters/tables.ts`;
 * the simulation reading both is `monsters/ai.ts` and `monsters/attacks.ts` —
 * the same `defs`/`tables` split the thing layer makes (docs/conventions.md §
 * The role names). Data and pure functions only. See docs/monster-ai.md.
 */
import { ThingType } from '../things/doomednums.ts';
import type { SfxId } from '../../audio/sfx.ts';
import type { Pos3 } from '../../types.ts';

/**
 * The mutable chase/attack state `stepMonsterAI` (`monsters/ai.ts`) reads and
 * writes, kept alive across frames on the caller's object. `PosedThing`
 * (`game/things.ts`) structurally satisfies this, so it's passed in directly
 * rather than copied in and out. Only ever stepped once a monster is alerted;
 * waking is `tryWake`'s job. See docs/monster-ai.md.
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
  /** >0 while playing out an attack, during which the monster holds position and no chase call runs — docs/monster-ai.md § Attacking. */
  attackPause: number;
  /** Shots left in the attack currently being played out, and the countdown to the next one (`AttackStats.shots`). */
  burstLeft: number;
  burstTimer: number;
  /**
   * Set while the pending `burstLeft` is a **melee swing** rather than a ranged
   * volley: the two share one timer, since a monster is only ever inside one
   * attack, but they land through different code and pose off different
   * chains. docs/monster-ai.md § The windup.
   */
  swinging: boolean;
  /** >0 while a lost soul's `A_SkullAttack` charge is in flight, travelling `chargeAngle` at charge speed until it connects or hits geometry. */
  chargeTimer: number;
  chargeAngle: number;
  /** >0 while staggered by a recent hit; movement and attacks pause until it drops to 0 (see `reactToDamage`). */
  painTimer: number;
  /**
   * Vanilla's `MF_INFLOAT`: set while a `flies` monster is changing height to
   * get past a step it can't cross, cleared the moment it moves again. Only
   * `settleVertical` reads it — it suppresses the hover-toward-target drift so
   * the two float rules can't fight each other. Inert for every grounded type.
   * docs/monster-ai.md § Floating monsters.
   */
  inFloat: boolean;

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
   * docs/monster-attacks.md § The revenant's homing missile.
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
   * docs/monster-ai.md § Melee reach.
   */
  range?: number;
  /**
   * Melee only — what a target that stepped out of reach during the windup
   * costs. Vanilla's melee actions split on exactly this: `A_TroopAttack`,
   * `A_HeadAttack` and `A_BruisAttack` fall through to `P_SpawnMissile` and
   * throw the type's own `ranged` missile after it, while `A_SargAttack` and
   * `A_SkelFist` simply miss. docs/monster-ai.md § The windup.
   */
  missileOnMiss?: true;
  diceSides: number;
  diceMult: number;
  /**
   * Hitscan only — bullets per attack (`A_SPosAttack`'s 3 `P_LineAttack`s).
   * Each is traced as its own bolt, with its own spread angle and its own
   * damage roll, so a burst can land partially. Absent means the ordinary
   * single bullet. See docs/monster-attacks.md § Hitscan vs. projectile.
   */
  pellets?: number;
  /** Seconds the attack's state sequence runs — its summed `info.c` tics over 35. The monster holds position exactly this long (docs/monster-ai.md § Attacking). */
  duration: number;
  /** Shots fired from this one `missilestate` and how far apart, rather than a fresh `A_Chase` decision per shot. Defaults to a single shot at attack start. */
  shots?: number;
  shotInterval?: number;
  /**
   * One entry per shot, where the volley's shots are not all the same attack — each is read for
   * its roll and its projectile in place of the chain's own, the shot's spacing and the pose
   * staying the chain's. Absent in vanilla, whose every multi-shot chain repeats one action (the
   * mancubus's three `A_FatAttack*` are one attack fanned by `pairOffsetsRad`); a DEHACKED patch
   * can mix them, and NoSp2.wad's cybruiser does — rocket, then the baron's green ball.
   * docs/monster-attacks.md § A volley of unlike shots.
   *
   * This is the one field that makes `AttackStats` hold its own type, so **anything walking the
   * stat table has to walk these too** — `fastVariant` and the projectile sweep in `tables.ts`
   * both do, and a new traversal that forgets them silently misses a patched volley's shots.
   * One level only: an entry's own `shotAttacks` is stripped when it is built (dehacked/apply.ts).
   */
  shotAttacks?: readonly AttackStats[];
  /**
   * Seconds into the attack before it first lands — the `A_FaceTarget` states
   * vanilla's chain opens with, ahead of the one carrying the damaging action.
   * Read for **both kinds**: a shot leaves this far into the volley, a claw
   * connects this far into the swing, and each re-checks its own gate at that
   * moment rather than at the one the attack was chosen on — which is why
   * cover saves you from an arch-vile and why backing off spoils a bite.
   * docs/monster-ai.md § The windup, docs/monster-archvile.md.
   */
  startDelaySeconds?: number;
  /** Vanilla's `A_CPosRefire`/`A_SpidRefire` loop: the attack state re-enters itself until the target stops being visible, never re-rolling `P_CheckMissileRange`. */
  refire?: boolean;
  /**
   * The lost soul's `A_SkullAttack` — it launches *itself* at `SKULLSPEED`
   * and damages on contact. `maxDist` has no vanilla counterpart (vanilla's
   * skull keeps its momentum); it just bounds a charge across open floor.
   * See docs/monster-ai.md § The lost soul: a charge, not a projectile.
   */
  charge?: { speed: number; maxDist: number };
  /**
   * The pain elemental's `A_PainAttack`/`A_PainShootSkull`: spawns a lost soul
   * in front of itself and launches it at the elemental's own target.
   * `game/things.ts` owns the spawning since it holds the `PosedThing` list;
   * `stepMonsterAI` only reports that one should happen, the same split as
   * every other attack kind. docs/monster-ai.md § The pain elemental.
   */
  spawn?: { type: number };
  /**
   * Non-null for a ranged attack that throws a flying projectile sprite rather
   * than resolving as an instant hitscan bolt. `sprite` is confirmed against
   * `DOOM2.WAD`'s lump names; `speed` is that missile's own `mobjinfo.speed`
   * (fracunits per tic, so `× 35`), **not** a tuned value — eyeballing them
   * was a shipped bug. See docs/monster-attacks.md § Hitscan vs. projectile.
   */
  projectile?: {
    sprite: string;
    speed: number;
    /**
     * Mancubus only — `A_FatAttack1/2/3` each spawn *two* `MT_FATSHOT`s fanned
     * by `FATSPREAD`. One entry per burst shot, listing that shot's radian
     * offsets from straight-at-target. Omitted (implicitly `[0]`) everywhere
     * else. See docs/monster-attacks.md § Hitscan vs. projectile.
     */
    pairOffsetsRad?: number[][];
    /**
     * Cyberdemon only: its missile is a real `MT_ROCKET`, whose death state is
     * the one monster-projectile death state that calls `A_Explode`. Every
     * other monster fireball genuinely has no splash in vanilla either — this
     * isn't a simplification. docs/monster-attacks.md § Hitscan vs. projectile.
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
   * cyberdemon's tighter 160. docs/monster-ai.md § Attacking.
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
   * time passes — `monsters/vile.ts`. docs/monster-archvile.md.
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
   * The sound the melee action plays **on connecting** — `A_TroopAttack`'s and
   * `A_BruisAttack`'s `claw`, `A_SkelFist`'s `skepch`. Inside vanilla's own
   * `P_CheckMeleeRange` branch, so a swing that misses is silent.
   */
  melee?: SfxId;
  /**
   * The sound the swing *starts* on, a `startDelaySeconds` windup ahead of the
   * one above: `mobjinfo.attacksound`, which `A_Chase` plays on entering
   * `meleestate` (the demon's `sgtatk`), and `A_SkelWhoosh`'s `skeswg` on the
   * revenant's first swing state, which occupies the same moment. Plays
   * whether or not the swing goes on to land.
   */
  meleeWindup?: SfxId;
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
   * with no per-tic accumulation to lose in translation. See docs/monster-ai.md
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
  /**
   * Vanilla's own `mobjinfo.radius`, every entry exact — the real 16-128 unit
   * per-species spread, not an approximation. It sizes movement collision *and*
   * every shot-vs-body test: `PosedThing.blockRadius` carries it onto
   * `MonsterRef.radius`, which `raycastMonster` and a projectile's swept
   * contact test both read (docs/combat.md § How a shot deals damage).
   */
  radius: number;
  /**
   * Vanilla's `mobjinfo.mass`, the genuine per-type figure. Feeds
   * `thrustSpeed`, `P_DamageMobj`'s
   * horizontal knockback, so a cyberdemon barely budges from a hit that
   * staggers a zombieman. The arch-vile's separate *vertical* launch
   * (`VILE_KNOCKUP_SPEED`) still uses a flat 100. docs/movement.md § Knockback.
   */
  mass: number;
  melee: AttackStats | null;
  ranged: AttackStats | null;
  /** This type's vanilla sounds — see `MonsterSounds`. */
  sounds: MonsterSounds;
  /**
   * `mobjinfo.height` — this body's real vertical extent, 56 to 110 across the
   * roster. Every fit/reach test that knows *which* body it is asking about
   * uses this rather than one shared figure: a cyberdemon is nearly twice an
   * imp, which decides whether a crusher catches it and whether it fits through
   * a low opening. See `BODY_HEIGHT_FALLBACK`.
   */
  height: number;
  /** Chance a hit staggers this monster (`reactToDamage`) — `mobjinfo.painchance` over 256, lifted exactly. */
  painChance: number;
  /** Seconds a stagger lasts — the `painstate` chain's summed tics over 35, 4 (imp, demon, baron) to 12 (cacodemon, pain elemental). */
  painDuration: number;
  /**
   * Vanilla's `MF_FLOAT | MF_NOGRAVITY` — cacodemon, lost soul and pain
   * elemental only. Such a monster never falls, hovers toward its target's
   * mid-height, changes height instead of turning when a step blocks it
   * (`P_Move`'s `floatok` branch), and is exempt from the dropoff rule.
   * See docs/monster-ai.md § Floating monsters.
   */
  flies?: boolean;
  /** Vanilla's `A_VileChase` corpse search, arch-vile only — tried before anything else on a chase call, falling through to the ordinary decision only if no corpse is raisable. See `monsters/vile.ts: tryRaiseCorpse`. */
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
  /** Set only for the arch-vile's real `A_VileAttack` — see `AttackStats.blast`'s doc. `monsters/vile.ts` applies direct damage plus knockback, then a radius blast, instead of the generic hitscan-tracer path every other non-projectile ranged monster uses. */
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
  /** The firing body's own `PosedThing.blockRadius`, carried rather than re-looked-up — how far clear of it a hitscan tracer starts (docs/combat.md § Effects and their batching). */
  sourceRadius: number;
  /** What it was aimed at: `null` for the player, otherwise another monster's id. */
  targetId: number | null;
}

/** One corpse `ThingLayer`'s `findRaisableCorpse` found eligible for the arch-vile to raise — just enough for `tryRaiseCorpse` to face it and report which one. */
export interface RaiseCandidate {
  id: number;
  x: number;
  y: number;
}

/** The subset of `PosedThing` (`game/things.ts`) `tryWake` needs — position, facing, its ambush flag, and the two fields it mutates on success. */
export interface WakeCheckBody extends Pos3 {
  facingDeg: number;
  ambush: boolean;
  alerted: boolean;
  reactionTicks: number;
  /** The thing's cached subsector, handed straight to `hasLineOfSight`'s REJECT test — see docs/world.md § REJECT. */
  subsector: number;
}

/** Vanilla's `MELEERANGE` (`p_local.h`: `64*FRACUNIT`). Not the melee threshold itself — see `meleeThreshold`. */
export const MELEE_RANGE = 64;

/**
 * `P_CheckMeleeRange`'s own bias: vanilla tests
 * `dist >= MELEERANGE - 20*FRACUNIT + pl->info->radius`, shortening
 * `MELEERANGE` by 20 and adding the **target's** radius back.
 * docs/monster-ai.md § Melee reach.
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
 * Whether attacker and target overlap vertically enough for a melee swing to
 * connect: refused once the target's feet clear the attacker's head, or the
 * target's head sits below the attacker's feet.
 *
 * **Deliberately not vanilla** — this follows ZDoom's
 * `MF5_NOVERTICALMELEERANGE` (`p_enemy.cpp`) rather than vanilla's
 * no-vertical-check melee. docs/monster-ai.md § Melee reach.
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

/**
 * Whether a monster-fired *projectile* deals no damage to `victimType` —
 * `PIT_CheckThing`'s "don't hit same species as originator". Barons and hell
 * knights are one species in both directions, vanilla's one hardcoded
 * cross-type pairing. Projectiles only: hitscan has no species check, so
 * zombiemen really do gun each other down.
 *
 * **This is not a pass-through** — the missile stops dead on a same-species
 * body. `game/projectiles.ts: bodyStruckBy` owns that distinction; docs/monster-ai.md §
 * Infighting has why it decides whole fights on a crowded map.
 */
export function sameSpecies(shooterType: number, victimType: number): boolean {
  if (shooterType === victimType) return true;
  const bruisers: Set<number> = new Set([ThingType.baronOfHell, ThingType.hellKnight]);
  return bruisers.has(shooterType) && bruisers.has(victimType);
}

/**
 * Vanilla's eight movement directions in `dirtype_t` order (E, NE, N, NW, W,
 * SW, S, SE), plus `DI_NODIR` for "nowhere to go". Monsters only ever walk
 * along these, never straight at the target — the reason a DOOM monster
 * approaches in visible zig-zags instead of gliding at you on a perfect
 * bearing.
 */
export const DI_NODIR = 8;
/**
 * `xspeed[]`/`yspeed[]`. The diagonals are `47000/65536 ≈ 0.717`, not `1`, so
 * a diagonal step comes out ~1.4% longer than a cardinal one rather than the
 * 41% a naive unit-per-axis table would give — DOOM monsters are very nearly
 * isotropic, and this is why. Shared by `monsters/ai.ts`'s walk and
 * `monsters/vile.ts`'s `A_VileChase` lookahead.
 */
export const DIR_X = [1, 0.71716, 0, -0.71716, -1, -0.71716, 0, 0.71716];
export const DIR_Y = [0, 0.71716, 1, 0.71716, 0, -0.71716, -1, -0.71716];

/**
 * Height above a monster's feet a ranged attack's tracer is drawn from — the
 * monster's own equivalent of `game/player.ts`'s `AIM_HEIGHT_OFFSET`.
 */
export const MONSTER_FIRE_HEIGHT = 40;

/**
 * The width `spawnPlayerShot`'s **locked-on** test uses, and the fallback
 * `blockRadius` for a shootable type with no `MonsterStats`/`INERT_SHOOTABLE`
 * entry. One shared box on purpose *here*: it keeps the lock from behaving like
 * homing, so a spread pellet misses the clicked monster at exactly the width any
 * other bullet would — and it costs nothing on a wide monster, since a pellet
 * that fails it falls through to `raycastMonster`, which tests that body at its
 * real `MonsterStats.radius`. Everything a shot can actually collide with is
 * per-species; only this one gate isn't.
 */
export const MONSTER_HIT_RADIUS = 24;
/**
 * The vertical half of that same deliberately-shared auto-aim lock box, and
 * shared for the identical reason — the lock must not behave like homing. Left
 * at the 64 the engine used everywhere before bodies got their real
 * `mobjinfo.height`, since retuning auto-aim is a separate question from
 * getting the physical heights right.
 */
export const MONSTER_LOCK_HEIGHT = 64;
/**
 * `PosedThing.bodyHeight` for a shootable type carrying no `mobjinfo.height` of
 * its own — the same last-resort role `MONSTER_HIT_RADIUS` plays for the width,
 * and reached by nothing in the stock roster, every member of which has a real
 * height in `MONSTER_STATS`/`INERT_SHOOTABLE`/`BARREL_HEIGHT`.
 *
 * Deliberately a last resort rather than a shared figure: heights gate movement
 * as well as shots, so one number for every body has a crusher catching bodies
 * it shouldn't and missing ones it should. docs/combat.md § How a shot deals damage.
 */
export const BODY_HEIGHT_FALLBACK = 56;
