import type { Sector } from '../wad/map.ts';
import { circleBlocked, hasLineOfSight, WEAPON_RANGE, type ThingBlocker, type World } from './world.ts';
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
  /**
   * >0 while this monster is still playing out the attack it already started,
   * during which it holds position — vanilla's attack states run for a fixed
   * number of tics and never call `A_Chase`, so a monster genuinely stops
   * walking to shoot or swing. No chase call runs while it is nonzero.
   */
  attackPause: number;
  /** Shots left in the attack currently being played out, and the countdown to the next one (`AttackStats.shots`). */
  burstLeft: number;
  burstTimer: number;
  /**
   * >0 while a charging monster (`AttackStats.charge` — the lost soul's
   * `A_SkullAttack`) is in flight; it travels along `chargeAngle` at the
   * charge speed, ignoring both its normal walk speed and `attackPause`,
   * until it reaches the player or slams into geometry.
   */
  chargeTimer: number;
  chargeAngle: number;
  /** >0 while staggered by a recent hit; movement and attacks pause until it drops to 0 (see `reactToDamage`). */
  painTimer: number;

  // --- Vanilla's A_Chase bookkeeping (see `runChaseCall`). Every counter here
  // is measured in *chase calls*, not seconds, exactly as vanilla measures it;
  // `chaseTimer` is the only thing that converts between the two. ---

  /**
   * Which of vanilla's eight movement directions this monster is walking,
   * `DI_NODIR` (8) when it has nowhere to go. Monsters move on this 8-way
   * grid rather than straight at the target, which is what produces DOOM's
   * characteristic zig-zag approach.
   */
  movedir: number;
  /** Chase calls left before `newChaseDir` re-routes — vanilla's `movecount`, reseeded to `P_Random() & 15`. */
  movecount: number;
  /** Accumulates real time toward the next chase call (`MonsterStats.chaseInterval`). */
  chaseTimer: number;
  /** Set when a frame's move was refused; the next chase call re-routes, the way vanilla reacts to `P_Move` returning false. */
  moveBlocked: boolean;
  /**
   * Chase calls of target commitment left — vanilla's `threshold`, seeded to
   * `BASETHRESHOLD` when something hurts this monster. While it's nonzero the
   * monster won't be pulled onto a different attacker, which is what keeps an
   * infight from thrashing between targets every time a stray shot lands.
   */
  threshold: number;
  /** Vanilla's `MF_JUSTHIT` — "the target just hit the enemy, so fight back": the next missile check fires regardless of the range roll. */
  justHit: boolean;
  /** Vanilla's `MF_JUSTATTACKED` — "do not attack twice in a row": the next chase call re-routes instead of attacking. */
  justAttacked: boolean;
  /** Chase calls left of vanilla's `reactiontime`; blocks ranged attacks only. */
  reactionTicks: number;
  /** True while inside an `AttackStats.refire` loop, which re-enters the attack the instant its state sequence ends. */
  refiring: boolean;
}

export interface AttackStats {
  /**
   * Map units, **melee only** — vanilla's ~64-unit `MELEERANGE` plus a little
   * slack for this engine's coarser per-frame distance sampling (see
   * `MELEE_RANGE`).
   *
   * A ranged attack has no range field at all, because vanilla gives it none:
   * `P_CheckMissileRange` never rejects a shot for being too far (only the
   * arch-vile's `maxOffsetDist` and the revenant's `minOffsetDist` below are
   * real distance gates), and a hitscan attack reaches `WEAPON_RANGE`
   * (`MISSILERANGE`) while a projectile simply flies until it hits something.
   * What actually makes distant monsters rarely shoot is the probability
   * falloff in `checkMissileRange`, not a cutoff — an earlier version's
   * hand-picked 1000-2400 unit caps were a stand-in for that falloff, and
   * with the falloff modelled properly they only made monsters stop firing at
   * a distance vanilla is still perfectly willing to shoot from.
   */
  range?: number;
  diceSides: number;
  diceMult: number;
  /**
   * Seconds this attack's own state sequence runs for, lifted straight off
   * vanilla's `info.c` state table (the summed tics of the melee/missile
   * state chain, divided by 35) rather than tuned by feel. Unlike this
   * file's `speed`-adjacent values, an attack's length converts cleanly:
   * it's a fixed tic count that never depends on frame rate. The monster
   * holds position for exactly this long (`MonsterBody.attackPause`), which
   * is what makes a mancubus plant itself for its volley and a zombieman
   * stop walking to raise its pistol, instead of firing while still sliding
   * toward the player.
   */
  duration: number;
  /**
   * How many separate shots this one attack fires, and how far apart —
   * vanilla's multi-shot attack states (the cyberdemon's three rockets, the
   * mancubus's three volleys, the chaingunner/spider's paired bullets),
   * where every shot comes out of a single `missilestate` entry rather than
   * a fresh `A_Chase` decision. Defaults to a single shot at the moment the
   * attack starts.
   */
  shots?: number;
  shotInterval?: number;
  /**
   * Vanilla's `A_CPosRefire`/`A_SpidRefire` loop (the chaingunner, spider
   * mastermind and arachnotron): the attack state jumps straight back to
   * itself and only breaks out when the target is no longer visible, never
   * re-rolling `P_CheckMissileRange`. So these three hose continuously — and
   * stand still doing it — for as long as they can see the player, instead
   * of paying the movecount/probability wait every other monster does.
   */
  refire?: boolean;
  /**
   * The lost soul's `A_SkullAttack`: instead of throwing anything, the
   * monster launches *itself* at the player at `speed` map units/sec
   * (vanilla's `SKULLSPEED`, 20 units/tic) and deals this attack's damage on
   * contact, stopping when it connects or slams into geometry. Its ordinary
   * `MonsterStats.speed` is the slow drift it uses the rest of the time.
   * `maxDist` has no vanilla counterpart — vanilla's skull keeps its momentum
   * until something stops it — it's just a bound so a charge launched across
   * an unbounded stretch of open floor eventually gives up.
   */
  charge?: { speed: number; maxDist: number };
  /**
   * Non-null for a ranged attack that actually throws a flying projectile
   * sprite (vanilla's fireball/rocket monsters), rather than resolving as an
   * instant hitscan bolt — see `MONSTER_STATS`'s doc for which monsters get
   * one and why the rest don't. `sprite` is confirmed against the real
   * `DOOM2.WAD` lump names (each has its own 2-frame omnidirectional-or-
   * directional flight pulse — dumped from the actual IWAD — and, per the
   * real `linuxdoom-1.10` `info.c` mobjinfo/state tables, its own 3-5-frame
   * explosion, except the mancubus's `MANF`, which explodes using the
   * rocket's own `MISL` frames instead of dedicated art of its own — a real
   * vanilla oddity, not a simplification here). `speed` (map units/sec) is
   * tuned by feel the same as everything else in this file.
   */
  projectile?: { sprite: string; speed: number };
  /**
   * Vanilla's own `P_CheckMissileRange` distance falloff (confirmed against
   * the real `linuxdoom-1.10` source), converted from a per-check miss
   * *chance* into a deterministic cooldown *multiplier* — see
   * `stepMonsterAI`'s doc for why. `rangeFalloffScale` (default 1) shrinks
   * distance before capping; vanilla halves it (0.5) for exactly three
   * types — cyberdemon, spider mastermind, revenant — making them
   * noticeably more willing to fire from far away than everything else.
   * `rangeFalloffCap` (default 200 map units) is vanilla's own clamp, except
   * the cyberdemon's own extra-tight 160.
   */
  rangeFalloffScale?: number;
  rangeFalloffCap?: number;
  /**
   * Vanilla's revenant-only rule (`MT_UNDEAD` in `P_CheckMissileRange`):
   * refuses to fire its missile within this distance at all, preferring to
   * close to melee range instead rather than lobbing one from just out of
   * fist's reach. Compared against the **offset** distance (after
   * `P_CheckMissileRange`'s own -64/-192 subtraction), which is where vanilla
   * applies it, not against the raw separation.
   */
  minOffsetDist?: number;
  /**
   * Vanilla's arch-vile-only rule (`MT_VILE` in `P_CheckMissileRange`): won't
   * fire beyond `14*64` map units. The one genuine long-range cutoff in the
   * game — everything else relies purely on the probability falloff. Also
   * measured on the offset distance.
   */
  maxOffsetDist?: number;
}

export interface MonsterStats {
  /**
   * Map units/sec while chasing, **derived from vanilla, not tuned by feel**
   * — unlike `player.ts`'s `GRAVITY` or `weapons.ts`'s fire rates, this one
   * does convert cleanly. Vanilla moves a monster exactly `mobjinfo.speed`
   * units per `A_Chase` call, and `A_Chase` fires once per state of the
   * monster's own `seestate` walk loop, so units/sec is just
   * `speed × (A_Chase states in the loop) × 35 / (tics in the loop)` — no
   * fixed-point or per-tic accumulation to lose in translation. (The
   * per-loop state count matters: the arachnotron and spider mastermind
   * spend 2-3 of their 12 walk states on footstep-sound actions that don't
   * move them at all, and the cyberdemon 2 of 8.) An earlier version tuned
   * these by feel at roughly 2-3× vanilla, which flattened the difference
   * between a shambling zombieman and a charging demon and let almost
   * everything keep pace with a running player — in vanilla nothing except
   * a charging lost soul can, since the fastest monster alive (the arch-vile
   * at 262 units/sec) is still barely half the player's own run speed.
   */
  speed: number;
  /**
   * Seconds between `A_Chase` calls for this monster — the walk loop's tics
   * divided by the number of `A_Chase` states in it, over 35. Vanilla's
   * whole AI clock is quantized to this: it's how often a monster gets to
   * reconsider attacking, how fast `reactiontime` drains, and the unit
   * `runChaseCall` fires on. Derived alongside
   * `speed` above from the same state loop.
   */
  chaseInterval: number;
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
   * Probability a hit staggers this monster into a brief pause
   * (`reactToDamage`) instead of continuing whatever it was doing —
   * vanilla's own `mobjinfo.painchance` over 256, lifted exactly rather than
   * approximated, the same as `MONSTER_HEALTH` already is. It's a plain
   * constant in the same table health comes from, so there was never
   * anything to convert; an earlier eyeballed set had the imp and demon
   * shrugging off roughly half the hits that stagger them in vanilla.
   */
  painChance: number;
  /**
   * Seconds a stagger lasts — the summed tics of this monster's `painstate`
   * chain over 35, from the same state table `AttackStats.duration` comes
   * from. Ranges from 4 tics (the imp, demon and baron barely flinch) to 12
   * (the cacodemon and pain elemental recoil visibly), which an earlier
   * single shared constant flattened away.
   */
  painDuration: number;
  /**
   * Vanilla's `MF_FLOAT` — exempts this monster from the dropoff check
   * `stepMonsterAI` otherwise applies (`World.circleBlocked`'s
   * `avoidDropoff`), matching vanilla's own `P_TryMove` exemption for
   * floating monsters. Set only for the cacodemon, lost soul and pain
   * elemental — vanilla's actual hoverers/fliers. This engine doesn't model
   * real flight/hover height for them at all (they walk the floor like
   * everything else), but they should still be willing to cross a ledge a
   * grounded monster wouldn't dare step off, matching the one part of their
   * vanilla flight behavior that's cheap to keep even without modeling the
   * rest of it.
   */
  flies?: boolean;
}

export interface MonsterAttack {
  kind: 'melee' | 'ranged';
  damage: number;
  /** The heading it was fired along (`A_FaceTarget`'s angle) — what a hitscan bolt traces down, so it can hit whatever is actually in the way. */
  angleRad: number;
  /**
   * Set only for a `'ranged'` attack fired by a monster whose `AttackStats.ranged.projectile`
   * is configured — the caller (`game.ts`) spawns a flying projectile sprite
   * angled at `angleRad` instead of an instant hitscan tracer. Absent means
   * the ordinary hitscan-style bolt this engine already used for every
   * ranged monster before real projectiles existed.
   */
  projectile?: { sprite: string; speed: number; angleRad: number };
}

/** Vanilla's own MELEERANGE, plus a little slack for this engine's coarser per-frame (rather than per-tic) distance sampling. */
export const MELEE_RANGE = 72;

/**
 * Vanilla's `mobjinfo.reactiontime`, which is 8 for every monster in the
 * game — a freshly-woken monster starts moving toward its target at once,
 * but `A_Chase` decrements this counter 8 times before `P_CheckMissileRange`
 * will let it shoot. Counted in chase calls, exactly as vanilla counts it, so
 * a zombieman's beat of hesitation (8 × 0.114s) really is twice a demon's
 * (8 × 0.057s). Melee is deliberately *not* gated by it: vanilla reads
 * `reactiontime` nowhere except `P_CheckMissileRange`, so a demon woken at
 * arm's length bites on the spot.
 */
const REACTION_CHASES = 8;

/**
 * Vanilla's `BASETHRESHOLD` — how many chase calls a monster stays committed
 * to whoever last hurt it before another attacker can pull it away. Without
 * it an infight in a crowded room degenerates into everyone re-targeting on
 * every stray hit and nobody ever landing a second blow.
 */
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
 * Ranged attacks are either an instant hitscan-style bolt (a tracer, drawn
 * by `game.ts`) — for the monsters that really do fire vanilla hitscan
 * bullets (the human gunners, and the spider mastermind's chaingun) — or a
 * real flying projectile sprite (`AttackStats.ranged.projectile`, also
 * `game.ts`) for the ones that genuinely throw a fireball/rocket in vanilla.
 * Two are deliberately left as the hitscan-tracer stand-in despite not
 * matching vanilla exactly: the pain elemental (whose real "attack" is
 * spawning a lost soul, not firing anything — there's no lost-soul-spawning
 * mechanic here to model instead) and the arch-vile (whose real fire attack
 * is a stationary tracking flame summoned *at* the target, not a projectile
 * that flies from the vile to it — a proper implementation needs a whole
 * different mechanism than "spawn sprite, fly toward target"). The lost
 * soul's is a third kind again (`AttackStats.charge`): vanilla's
 * `A_SkullAttack` throws the monster itself rather than anything it carries.
 * Revenant missiles also don't home in on the player the way vanilla's
 * `A_Tracer` makes them — they fly straight, the same simplification as
 * everything else in this file that isn't worth a dedicated behavior for.
 *
 * **Timing is lifted from vanilla; damage is not.** `speed`,
 * `chaseInterval`, `painChance`, `painDuration` and every `duration`/`shots`/
 * `shotInterval` here are read straight out of `info.c`'s `mobjinfo`/state
 * tables, because all of them are plain constants that survive the trip to a
 * dt-scaled model intact (see `MonsterStats.speed` for the arithmetic).
 * Damage rolls stay tuned for game balance/feel, the same reasoning
 * weapons.ts's fire rates and spread already use — which means a monster's
 * *rhythm* matches vanilla while its bite is deliberately softer. The one
 * damage-adjacent gap left is splash: a monster's own projectile carries
 * none, so a cyberdemon's rocket doesn't blast whatever it lands next to the
 * way the player's does — an honestly-noted gap, like crushers not blocking
 * movers on contact (see CLAUDE.md), not an oversight.
 */
export const MONSTER_STATS: Record<number, MonsterStats> = {
  3004: {
    speed: 70,
    chaseInterval: 0.114,
    radius: 20,
    melee: null,
    ranged: { diceSides: 3, diceMult: 3, duration: 0.743 },
    painChance: 0.781,
    painDuration: 0.171,
  }, // POSS zombieman
  9: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    melee: null,
    ranged: { diceSides: 3, diceMult: 5, duration: 0.857 },
    painChance: 0.664,
    painDuration: 0.171,
  }, // SPOS shotgun guy
  65: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    melee: null,
    ranged: { diceSides: 2, diceMult: 3, duration: 0.257, shots: 2, shotInterval: 0.114, refire: true },
    painChance: 0.664,
    painDuration: 0.171,
  }, // CPOS chaingunner — A_CPosRefire hoses without pause while it can see you
  84: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    melee: null,
    ranged: { diceSides: 2, diceMult: 3, duration: 1.0 },
    painChance: 0.664,
    painDuration: 0.171,
  }, // SSWV Wolfenstein SS
  3001: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    melee: { range: MELEE_RANGE, diceSides: 6, diceMult: 3, duration: 0.629 },
    ranged: { diceSides: 6, diceMult: 3, duration: 0.629, projectile: { sprite: 'BAL1', speed: 500 } },
    painChance: 0.781,
    painDuration: 0.114,
  }, // TROO imp
  3002: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 30,
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 4, duration: 0.686 },
    ranged: null,
    painChance: 0.703,
    painDuration: 0.114,
  }, // SARG demon
  58: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 30,
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 4, duration: 0.686 },
    ranged: null,
    painChance: 0.703,
    painDuration: 0.114,
  }, // SARG spectre (same as demon; no invisibility rendering)
  3006: {
    speed: 46.7,
    chaseInterval: 0.171,
    radius: 16,
    melee: null,
    ranged: {
      diceSides: 4,
      diceMult: 3,
      duration: 0.629,
      rangeFalloffScale: 0.5,
      charge: { speed: 700, maxDist: WEAPON_RANGE },
    },
    painChance: 1,
    painDuration: 0.171,
    flies: true,
  }, // SKUL lost soul — drifts slowly, then hurls itself (A_SkullAttack, SKULLSPEED = 20 units/tic)
  3005: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 31,
    melee: { range: MELEE_RANGE, diceSides: 6, diceMult: 6, duration: 0.429 },
    ranged: { diceSides: 6, diceMult: 5, duration: 0.429, projectile: { sprite: 'BAL2', speed: 500 } },
    painChance: 0.5,
    painDuration: 0.343,
    flies: true,
  }, // HEAD cacodemon — one attack state that bites up close and spits a fireball otherwise (A_HeadAttack)
  3003: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 24,
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 8, duration: 0.686 },
    ranged: { diceSides: 8, diceMult: 6, duration: 0.686, projectile: { sprite: 'BAL7', speed: 550 } },
    painChance: 0.195,
    painDuration: 0.114,
  }, // BOSS baron of hell
  69: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 24,
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 6, duration: 0.686 },
    ranged: { diceSides: 8, diceMult: 5, duration: 0.686, projectile: { sprite: 'BAL7', speed: 550 } },
    painChance: 0.195,
    painDuration: 0.114,
  }, // BOS2 hell knight — vanilla's hell knight throws the same BAL7 fireball as the baron
  71: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 31,
    melee: null,
    ranged: { diceSides: 4, diceMult: 3, duration: 0.429 },
    painChance: 0.5,
    painDuration: 0.343,
    flies: true,
  }, // PAIN pain elemental (stands in for its unmodeled soul-spawn attack)
  66: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 20,
    melee: { range: MELEE_RANGE, diceSides: 6, diceMult: 4, duration: 0.514 },
    ranged: {
      diceSides: 6,
      diceMult: 5,
      duration: 0.857,
      projectile: { sprite: 'FATB', speed: 750 },
      rangeFalloffScale: 0.5,
      minOffsetDist: 196,
    },
    painChance: 0.391,
    painDuration: 0.286,
  }, // SKEL revenant
  67: {
    speed: 70,
    chaseInterval: 0.114,
    radius: 48,
    melee: null,
    ranged: {
      diceSides: 8,
      diceMult: 6,
      duration: 2.286,
      shots: 3,
      shotInterval: 0.571,
      projectile: { sprite: 'MANF', speed: 450 },
    },
    painChance: 0.313,
    painDuration: 0.171,
  }, // FATT mancubus — A_FatAttack1/2/3, three volleys out of one 80-tic attack state
  68: {
    speed: 116.7,
    chaseInterval: 0.103,
    radius: 64,
    melee: null,
    ranged: { diceSides: 3, diceMult: 3, duration: 0.257, refire: true, projectile: { sprite: 'APLS', speed: 900 } },
    painChance: 0.5,
    painDuration: 0.171,
  }, // BSPI arachnotron — A_SpidRefire, same never-let-up loop as the chaingunner
  7: {
    speed: 105,
    chaseInterval: 0.114,
    radius: 128,
    melee: null,
    ranged: { diceSides: 3, diceMult: 4, duration: 0.257, shots: 2, shotInterval: 0.114, refire: true, rangeFalloffScale: 0.5 },
    painChance: 0.156,
    painDuration: 0.171,
  }, // SPID spider mastermind (real hitscan chaingun in vanilla too)
  16: {
    speed: 140,
    chaseInterval: 0.114,
    radius: 40,
    melee: null,
    ranged: {
      diceSides: 8,
      diceMult: 20,
      duration: 1.886,
      shots: 3,
      shotInterval: 0.343,
      projectile: { sprite: 'MISL', speed: 1100 },
      rangeFalloffScale: 0.5,
      rangeFalloffCap: 160,
    },
    painChance: 0.078,
    painDuration: 0.286,
  }, // CYBR cyberdemon — three rockets per volley, the same MISL sprite the player's own launcher fires
  // VILE arch-vile: vanilla's own P_CheckMissileRange refuses to fire beyond 14*64=896 map units
  // for this type specifically (MT_VILE), tighter than the generic 200-unit falloff cap below.
  64: {
    speed: 262.5,
    chaseInterval: 0.057,
    radius: 20,
    melee: null,
    ranged: { maxOffsetDist: 896, diceSides: 8, diceMult: 8, duration: 2.686 },
    painChance: 0.039,
    painDuration: 0.286,
  }, // VILE arch-vile
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
  z: number;
  facingDeg: number;
  ambush: boolean;
  alerted: boolean;
  reactionTicks: number;
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
 * On success, mutates `body.alerted` and seeds `reactionTicks` with
 * `REACTION_CHASES` (see that constant's doc) — the same "mutate the body, report what happened" shape as
 * `stepMonsterAI`. Returns whether it woke, in case the caller wants to react
 * to that moment itself.
 */
export function tryWake(
  body: WakeCheckBody,
  world: World,
  sector: Sector | undefined,
  playerX: number,
  playerY: number,
  playerZ: number,
): boolean {
  const heardIt = !!sector && world.isSoundAlerted(sector);
  const seesDespiteDeaf = body.ambush && heardIt && hasLineOfSight(world, body.x, body.y, body.z, playerX, playerY, playerZ);
  const heardAndAware = !body.ambush && heardIt;
  const spottedNormally =
    canSpotPlayer(body.facingDeg, body.x, body.y, playerX, playerY) &&
    hasLineOfSight(world, body.x, body.y, body.z, playerX, playerY, playerZ);
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
 * Vanilla's target-switch rule out of `P_DamageMobj`: whoever hurts a monster
 * normally becomes its new target, which is the entire mechanism behind
 * infighting — nothing about it is specific to the player, so a stray imp
 * fireball that clips a baron turns the baron on the imp exactly as it does
 * in DOOM.
 *
 * Two carve-outs, both vanilla's:
 * - **A monster already committed to a target ignores new attackers** until
 *   its `threshold` runs out, so a brawl doesn't degenerate into everyone
 *   spinning to face the last stray hit and nobody landing a second blow.
 *   An arch-vile is exempt and re-targets immediately regardless.
 * - **Nothing ever retaliates against an arch-vile.** Vanilla does this so
 *   its resurrect/flame behavior can't start a fight with the monsters it's
 *   meant to be helping.
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
 * Whether a monster-fired *projectile* should pass harmlessly through
 * `victimType` — vanilla's `PIT_CheckThing` "don't hit same species as
 * originator" rule, which is why a room full of imps can't wipe itself out
 * with crossfire. Barons and hell knights count as the same species in both
 * directions, vanilla's one hardcoded cross-type pairing. Note it applies to
 * projectiles only: hitscan attacks (`P_LineAttack`) have no species check at
 * all, so zombiemen really do gun each other down in vanilla, and do here.
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
 * Vanilla's `P_CheckMissileRange`, run once per chase call — not converted
 * into a cooldown, but the real per-attempt roll, now that `runChaseCall`
 * ticks at vanilla's own cadence and so can afford to sample it the same
 * number of times vanilla does.
 *
 * The shape that matters: the roll `P_Random() < dist` *suppresses* the shot,
 * so the fire chance is `(256 - dist) / 256` and shrinks as the target gets
 * further away — a monster across a room fails this many times in a row
 * before it ever gets one off, which is what makes distant monsters
 * occasional rather than constant. `rangeFalloffScale`/`Cap` are vanilla's
 * per-type halving and clamp (halved for exactly the types it special-cases —
 * cyberdemon, spider mastermind, revenant, lost soul — making them
 * noticeably more willing to fire from far away; the cyberdemon alone gets an
 * extra-tight 160 cap on top).
 *
 * `MF_JUSTHIT` short-circuits the whole thing: a monster that just took a hit
 * fires back immediately regardless of distance.
 */
function checkMissileRange(body: MonsterBody, stats: MonsterStats, dist: number, canSee: boolean): boolean {
  const ranged = stats.ranged;
  if (!ranged || !canSee) return false;
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
 * Whether this monster could take a full chase step in `dir` from where it
 * stands — vanilla's `P_TryWalk`, minus the part where it also performs the
 * move (movement here is interpolated per frame instead, see
 * `stepMonsterAI`). Committing to a direction reseeds `movecount` to
 * `P_Random() & 15` exactly as `P_TryWalk` does, which is what paces both
 * re-routing and the missile gate.
 */
function tryWalk(body: MonsterBody, stats: MonsterStats, world: World, dir: number, blockers?: readonly ThingBlocker[]): boolean {
  const step = stats.speed * stats.chaseInterval;
  const nx = body.x + DIR_X[dir] * step;
  const ny = body.y + DIR_Y[dir] * step;
  if (circleBlocked(world, nx, ny, stats.radius, body.z, true, !stats.flies, blockers)) return false;
  body.movedir = dir;
  body.movecount = Math.floor(Math.random() * 16);
  return true;
}

/**
 * Vanilla's `P_NewChaseDir`, reproduced step for step: try the diagonal that
 * closes both axes at once, then the two cardinals (in an order that's
 * randomized ~22% of the time, and always leads with the *longer* axis
 * otherwise), then the previous heading, then a full scan of all eight
 * directions from a randomly chosen end, and only as a last resort the
 * about-face it has been avoiding all along.
 *
 * The refusal to turn around unless nothing else works is what stops a
 * blocked monster oscillating in place, and the random scan direction is what
 * makes two monsters wedged in the same doorway eventually resolve it. This
 * replaces an earlier "if it hasn't moved in half a second, blend in a random
 * lateral angle" heuristic, which produced a visibly different gait — a
 * drifting curve into the wall rather than DOOM's flat commit-and-re-route.
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
 * One frame of a charging monster's flight (`AttackStats.charge` — vanilla's
 * `A_SkullAttack`, the lost soul hurling itself). It travels straight along
 * the heading it launched on, at the charge speed rather than its ordinary
 * drift, and stops the moment it either reaches the player — dealing the
 * attack's damage on contact, the way vanilla resolves an `MF_SKULLFLY`
 * collision in `PIT_CheckThing` — or slams into geometry, which vanilla
 * likewise treats as the end of the charge (`P_XYMovement` zeroes the
 * momentum and drops the monster back to its spawn state).
 *
 * Deliberately **not** `slideMove`, unlike every other movement in this
 * file: a charge that rounded corners would track the player instead of
 * committing to one heading, and being able to sidestep a committed lost
 * soul is the entire reason the attack is fair.
 */
function stepCharge(body: MonsterBody, stats: MonsterStats, dt: number, world: World, distToPlayer: number): MonsterAttack | null {
  const charge = stats.ranged?.charge;
  if (!charge || !stats.ranged) {
    body.chargeTimer = 0;
    return null;
  }
  body.chargeTimer = Math.max(0, body.chargeTimer - dt);
  if (distToPlayer <= MELEE_RANGE) {
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

/** Rolls one instance of `attack`'s damage, tagged with the projectile (if any) the caller should spawn. */
function fireAttack(kind: 'melee' | 'ranged', attack: AttackStats, angleRad: number): MonsterAttack {
  return {
    kind,
    damage: rollDamage(attack.diceSides, attack.diceMult),
    angleRad,
    projectile: attack.projectile ? { ...attack.projectile, angleRad } : undefined,
  };
}

/**
 * Advances one already-alerted monster by `dt`: re-routes and closes on
 * `target`, fires whichever attack (melee preferred, since a melee-capable
 * monster always tries to close all the way in) is in range and off cooldown,
 * and returns that attack for the caller to actually apply/render — the same
 * "return what happened, let the caller realize it" split as
 * `WeaponSystem.update`'s `Shot[]`. `target` is usually the player, but a
 * monster that has been hurt by another monster chases *it* instead
 * (`game/things.ts` resolves which), and nothing in here needs to know the
 * difference.
 *
 * **Decisions run on vanilla's clock, movement runs on the frame's.**
 * `A_Chase` is a discrete thing that happens once per state of the walk loop
 * (`MonsterStats.chaseInterval`), and every counter it touches — `movecount`,
 * `reactiontime`, `threshold` — is measured in those calls, so `runChaseCall`
 * below fires on that cadence and nothing else. What *doesn't* happen on that
 * cadence is the actual walking: vanilla jumps a monster a full `speed` units
 * per call, which at 35fps reads as continuous but at this engine's frame
 * rate would visibly stutter, so the position is interpolated per frame along
 * whatever `movedir` the last chase call settled on. Same distance covered,
 * same 8-way pathing, no stutter.
 *
 * A monster keeps closing distance until it is genuinely adjacent to its
 * target, matching vanilla, which has no "keep your distance" instinct at
 * all: a ranged monster like the zombieman or cyberdemon walks right up to
 * you if nothing stops it, firing along the way. What stops it is no longer a
 * `MELEE_RANGE` stand-in but the real thing — `blockers` makes bodies
 * physically collide, so a monster stops because it has run into you.
 *
 * **Walking and attacking are mutually exclusive.** An attack is a state
 * sequence of its own, and `A_Chase` — the only thing that ever calls
 * `P_Move` — doesn't run again until that sequence ends. So a monster plants
 * itself for `AttackStats.duration`, and a `refire` monster keeps planting
 * itself for as long as it can see you.
 */
export function stepMonsterAI(
  body: MonsterBody,
  stats: MonsterStats,
  dt: number,
  world: World,
  target: { x: number; y: number; z: number },
  blockers?: readonly ThingBlocker[],
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
  const canSee = hasLineOfSight(world, body.x, body.y, body.z, target.x, target.y, target.z);

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
      attack = fireAttack('ranged', ranged, body.angle);
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
    if (ranged && canSee) {
      attack = beginRangedAttack(body, ranged, dx, dy);
    } else {
      body.refiring = false;
    }
  }

  if (!attack) {
    body.chaseTimer += dt;
    if (body.chaseTimer >= stats.chaseInterval) {
      body.chaseTimer -= stats.chaseInterval;
      attack = runChaseCall(body, stats, world, target, dist, dx, dy, canSee, blockers);
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
    if (circleBlocked(world, nx, ny, stats.radius, body.z, true, !stats.flies, blockers)) {
      body.moveBlocked = true;
    } else {
      body.x = nx;
      body.y = ny;
      body.angle = Math.atan2(DIR_Y[body.movedir], DIR_X[body.movedir]);
    }
  }

  settleVertical(body, world, stats.radius, dt);
  return attack;
}

/** Starts a ranged attack: holds the monster still for its state sequence and queues its shots (or launches a charge). */
function beginRangedAttack(body: MonsterBody, ranged: AttackStats, dx: number, dy: number): MonsterAttack | null {
  body.angle = Math.atan2(dy, dx); // A_FaceTarget
  body.attackPause = ranged.duration;
  body.refiring = !!ranged.refire;
  if (ranged.charge) {
    body.chargeTimer = ranged.charge.maxDist / ranged.charge.speed;
    body.chargeAngle = body.angle;
    return null;
  }
  body.burstLeft = ranged.shots ?? 1;
  body.burstTimer = 0;
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
  target: { x: number; y: number; z: number },
  dist: number,
  dx: number,
  dy: number,
  canSee: boolean,
  blockers?: readonly ThingBlocker[],
): MonsterAttack | null {
  if (body.reactionTicks > 0) body.reactionTicks--;
  if (body.threshold > 0) body.threshold--;

  // "Do not attack twice in a row" — the call after an attack always re-routes.
  if (body.justAttacked) {
    body.justAttacked = false;
    newChaseDir(body, stats, world, target.x, target.y, blockers);
    return null;
  }

  if (stats.melee && canSee && dist <= (stats.melee.range ?? MELEE_RANGE)) {
    body.angle = Math.atan2(dy, dx); // A_FaceTarget
    body.attackPause = stats.melee.duration;
    // Melee has no P_CheckMissileRange equivalent: A_Chase swings whenever the
    // target is in reach, so the swing's own length is the entire wait.
    return fireAttack('melee', stats.melee, body.angle);
  }

  if (stats.ranged && body.movecount === 0 && checkMissileRange(body, stats, dist, canSee)) {
    body.justAttacked = true;
    return beginRangedAttack(body, stats.ranged, dx, dy);
  }

  if (--body.movecount < 0 || body.moveBlocked || body.movedir === DI_NODIR) {
    newChaseDir(body, stats, world, target.x, target.y, blockers);
  }
  body.moveBlocked = false;
  return null;
}
