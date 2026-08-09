import { WEAPON_RANGE } from '../world.ts';
import type { SfxId } from '../../audio/sfx.ts';
import type { Pos3 } from '../../types.ts';
import { DOOM_TIC } from '../../constants.ts';

/**
 * The record shapes every monster system passes around, the vanilla tables they
 * are read out of (`MONSTER_STATS`, `INERT_SHOOTABLE`), and the pure helpers
 * derived from `info.c`/`p_enemy.c` literals. Data and pure functions only — the
 * simulation reading them is `monsters/ai.ts` and `monsters/attacks.ts`, the same
 * split as `things.ts`/`thingdefs.ts`. See docs/monsters.md.
 */

/**
 * The mutable chase/attack state `stepMonsterAI` (`monsters/ai.ts`) reads and
 * writes, kept alive across frames on the caller's object. `PosedThing`
 * (`game/things.ts`) structurally satisfies this, so it's passed in directly
 * rather than copied in and out. Only ever stepped once a monster is alerted;
 * waking is `tryWake`'s job. See docs/monsters.md.
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
  /**
   * Vanilla's `MF_INFLOAT`: set while a `flies` monster is changing height to
   * get past a step it can't cross, cleared the moment it moves again. Only
   * `settleVertical` reads it — it suppresses the hover-toward-target drift so
   * the two float rules can't fight each other. Inert for every grounded type.
   * docs/monsters.md § Floating monsters.
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
   * docs/monsterattacks.md § The revenant's homing missile.
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
   * single bullet. See docs/monsterattacks.md § Hitscan vs. projectile.
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
   * was a shipped bug. See docs/monsterattacks.md § Hitscan vs. projectile.
   */
  projectile?: {
    sprite: string;
    speed: number;
    /**
     * Mancubus only — `A_FatAttack1/2/3` each spawn *two* `MT_FATSHOT`s fanned
     * by `FATSPREAD`. One entry per burst shot, listing that shot's radian
     * offsets from straight-at-target. Omitted (implicitly `[0]`) everywhere
     * else. See docs/monsterattacks.md § Hitscan vs. projectile.
     */
    pairOffsetsRad?: number[][];
    /**
     * Cyberdemon only: its missile is a real `MT_ROCKET`, whose death state is
     * the one monster-projectile death state that calls `A_Explode`. Every
     * other monster fireball genuinely has no splash in vanilla either — this
     * isn't a simplification. docs/monsterattacks.md § Hitscan vs. projectile.
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
   * time passes — `monsters/vile.ts`. docs/monsters.md § The arch-vile.
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
  /** Chance a hit staggers this monster (`reactToDamage`) — `mobjinfo.painchance` over 256, lifted exactly. */
  painChance: number;
  /** Seconds a stagger lasts — the `painstate` chain's summed tics over 35, 4 (imp, demon, baron) to 12 (cacodemon, pain elemental). */
  painDuration: number;
  /**
   * Vanilla's `MF_FLOAT | MF_NOGRAVITY` — cacodemon, lost soul and pain
   * elemental only. Such a monster never falls, hovers toward its target's
   * mid-height, changes height instead of turning when a step blocks it
   * (`P_Move`'s `floatok` branch), and is exempt from `circleBlocked`'s
   * `avoidDropoff`. See docs/monsters.md § Floating monsters.
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
 * body. `game/projectiles.ts: bodyStruckBy` owns that distinction; docs/monsters.md §
 * Infighting has why it decides whole fights on a crowded map.
 */
export function sameSpecies(shooterType: number, victimType: number): boolean {
  if (shooterType === victimType) return true;
  const bruisers = new Set([3003, 69]); // BOSS baron of hell, BOS2 hell knight
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
 * The shared body height every shot test uses, in place of vanilla's own
 * per-species 56-110 (`mobjinfo.height`). Unlike the radius this stays an
 * approximation — the top-down camera makes height the axis a player can least
 * judge, and no reported problem traces to it. docs/combat.md § How a shot
 * deals damage.
 */
export const MONSTER_HIT_HEIGHT = 64;

/** Vanilla's own `FATSPREAD` (`ANG90/8`) — the mancubus's fireball-pair fan angle, see `AttackStats.projectile.pairOffsetsRad`. */
const FATSPREAD = Math.PI / 2 / 8;

/**
 * Vanilla's `A_VileAttack` launch, `momz = 1000*FRACUNIT/mass` (`× 35` for
 * per-tic → units/sec). Deliberately uses vanilla's *default* mass 100 for
 * every victim rather than `MonsterStats.mass`, unlike `thrustSpeed` above —
 * an accepted approximation for one attack on one monster type.
 *
 * Lives here rather than with the rest of the vile's code in `monsters/vile.ts`
 * because `MONSTER_STATS` below reads it, and that file already imports this
 * one.
 */
const VILE_KNOCKUP_SPEED = (1000 / 100) * 35;

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
 * from feel, and docs/monsterattacks.md § Hitscan vs. projectile for which
 * types get which attack.
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
    // flame appears (`monsters/vile.ts` adds the flame's own `flamst`); the
    // blast itself is `A_VileAttack`'s `barexp`, played from there.
    sounds: { see: 'vilsit', active: 'vilact', pain: 'vipain', death: 'vildth', windup: 'vilatk' },
    resurrects: true,
  }, // VILE arch-vile
};
