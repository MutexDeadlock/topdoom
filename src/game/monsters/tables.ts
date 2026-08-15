/**
 * The vanilla stat tables every monster is looked up in — `MONSTER_STATS`, the
 * two `INERT_SHOOTABLE` oddities, and nightmare's derived `FAST_MONSTER_STATS`
 * — keyed on `things/doomednums.ts` and shaped by `monsters/defs.ts`. Data
 * only, lifted from `info.c`/`p_enemy.c`, never tuned by feel; the simulation
 * reading it is `monsters/ai.ts` and `monsters/attacks.ts`. See
 * docs/monster-ai.md.
 */
import { WEAPON_RANGE } from '../world.ts';
import { ThingType } from '../things/doomednums.ts';
import { MELEE_RANGE, type MonsterStats } from './defs.ts';
import type { SfxId } from '../../audio/sfx.ts';
import { DOOM_TIC } from '../../constants.ts';

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
 * docs/monster-ai.md § Commander Keen.
 */
export const INERT_SHOOTABLE: Record<
  number,
  { radius: number; height: number; painSound: SfxId; deathSound: SfxId; unattenuated: boolean }
> = {
  [ThingType.commanderKeen]: { radius: 16, height: 72, painSound: 'keenpn', deathSound: 'keendt', unattenuated: false },
  [ThingType.bossBrain]: { radius: 16, height: 16, painSound: 'bospn', deathSound: 'bosdth', unattenuated: true },
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
 * vanilla. See docs/monster-ai.md § Timings and damage come from vanilla, not
 * from feel, and docs/monster-attacks.md § Hitscan vs. projectile for which
 * types get which attack.
 */
export const MONSTER_STATS: Record<number, MonsterStats> = {
  [ThingType.zombieman]: {
    speed: 70,
    chaseInterval: 0.114,
    radius: 20,
    height: 56,
    mass: 100,
    melee: null,
    // A_PosAttack: (rand%5+1)*3.
    ranged: { diceSides: 5, diceMult: 3, duration: 0.743 },
    painChance: 0.781,
    painDuration: 0.171,
    sounds: { see: 'posit1', active: 'posact', pain: 'popain', death: 'podth1', attack: 'pistol' },
  },
  [ThingType.shotgunGuy]: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    height: 56,
    mass: 100,
    melee: null,
    // A_SPosAttack: 3 separate P_LineAttacks per call, each (rand%5+1)*3 —
    // see AttackStats.pellets's doc.
    ranged: { diceSides: 5, diceMult: 3, pellets: 3, duration: 0.857 },
    painChance: 0.664,
    painDuration: 0.171,
    sounds: { see: 'posit2', active: 'posact', pain: 'popain', death: 'podth2', attack: 'shotgn' },
  },
  [ThingType.heavyWeaponDude]: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    height: 56,
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
  },
  [ThingType.wolfensteinSS]: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    height: 56,
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
  },
  [ThingType.imp]: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 20,
    height: 56,
    mass: 100,
    // A_TroopAttack melee: (rand%8+1)*3.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 3, duration: 0.629 },
    // A direct missile hit is vanilla's universal (rand%8+1)*mobjinfo.damage
    // (PIT_CheckThing/p_map.c) — TROOPSHOT's own damage field is 3.
    ranged: { diceSides: 8, diceMult: 3, duration: 0.629, projectile: { sprite: 'BAL1', speed: 350 } },
    painChance: 0.781,
    painDuration: 0.114,
    sounds: { see: 'bgsit1', active: 'bgact', pain: 'popain', death: 'bgdth1', melee: 'claw' },
  },
  [ThingType.demon]: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 30,
    height: 56,
    mass: 400,
    // A_SargAttack: (rand%10+1)*4.
    melee: { range: MELEE_RANGE, diceSides: 10, diceMult: 4, duration: 0.686 },
    ranged: null,
    painChance: 0.703,
    painDuration: 0.114,
    // `A_SargAttack` itself is silent — the bite's sound is the `attacksound`
    // `A_Chase` plays on entering meleestate. See `MonsterSounds.melee`.
    sounds: { see: 'sgtsit', active: 'dmact', pain: 'dmpain', death: 'sgtdth', melee: 'sgtatk' },
  },
  [ThingType.spectre]: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 30,
    height: 56,
    mass: 400,
    melee: { range: MELEE_RANGE, diceSides: 10, diceMult: 4, duration: 0.686 },
    ranged: null,
    painChance: 0.703,
    painDuration: 0.114,
    sounds: { see: 'sgtsit', active: 'dmact', pain: 'dmpain', death: 'sgtdth', melee: 'sgtatk' },
  }, // Same stats as the demon; only `MF_SHADOW` differs, and that is purely
  // how it draws — docs/sprites.md § The spectre's fuzz.
  [ThingType.lostSoul]: {
    speed: 46.7,
    chaseInterval: 0.171,
    radius: 16,
    height: 56,
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
  }, // Drifts slowly, then hurls itself (A_SkullAttack, SKULLSPEED = 20 units/tic)
  [ThingType.cacodemon]: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 31,
    height: 56,
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
  }, // One attack state that bites up close and spits a fireball otherwise (A_HeadAttack)
  [ThingType.baronOfHell]: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 24,
    height: 64,
    mass: 1000,
    // A_BruisAttack melee: (rand%8+1)*10.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 10, duration: 0.686 },
    // Universal missile-hit formula; BRUISERSHOT's own damage field is 8.
    ranged: { diceSides: 8, diceMult: 8, duration: 0.686, projectile: { sprite: 'BAL7', speed: 525 } },
    painChance: 0.195,
    painDuration: 0.114,
    sounds: { see: 'brssit', active: 'dmact', pain: 'dmpain', death: 'brsdth', melee: 'claw' },
  },
  [ThingType.hellKnight]: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 24,
    height: 64,
    mass: 1000,
    // Baron and hell knight share A_BruisAttack/MT_BRUISERSHOT exactly.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 10, duration: 0.686 },
    ranged: { diceSides: 8, diceMult: 8, duration: 0.686, projectile: { sprite: 'BAL7', speed: 525 } },
    painChance: 0.195,
    painDuration: 0.114,
    sounds: { see: 'kntsit', active: 'dmact', pain: 'dmpain', death: 'kntdth', melee: 'claw' },
  }, // Vanilla's hell knight throws the same BAL7 fireball as the baron
  [ThingType.painElemental]: {
    speed: 93.3,
    chaseInterval: 0.086,
    radius: 31,
    height: 56,
    mass: 400,
    melee: null,
    // A_PainAttack deals no damage of its own — diceSides/diceMult are unused
    // (fireAttack is never reached for a `spawn` attack, see
    // beginRangedAttack) and left at 0 rather than optional so this stays the
    // same required shape as every other AttackStats. The real bite comes
    // from whatever the spawned lost soul itself lands (AttackStats.charge on
    // `ThingType.lostSoul`, above).
    ranged: { diceSides: 0, diceMult: 0, duration: 0.429, spawn: { type: ThingType.lostSoul } },
    painChance: 0.5,
    painDuration: 0.343,
    // `A_PainAttack` is silent; the lost soul it spawns brings its own `sklatk`.
    sounds: { see: 'pesit', active: 'dmact', pain: 'pepain', death: 'pedth' },
    flies: true,
  }, // A_PainAttack/A_PainShootSkull, spawns a lost soul and launches it at the elemental's own target
  [ThingType.revenant]: {
    speed: 175,
    chaseInterval: 0.057,
    radius: 20,
    height: 56,
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
  },
  [ThingType.mancubus]: {
    speed: 70,
    chaseInterval: 0.114,
    radius: 48,
    height: 64,
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
  }, // A_FatAttack1/2/3, three volleys out of one 80-tic attack state, each firing a pair of fireballs
  [ThingType.arachnotron]: {
    speed: 116.7,
    chaseInterval: 0.103,
    radius: 64,
    height: 64,
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
  }, // A_SpidRefire, same never-let-up loop as the chaingunner
  [ThingType.spiderMastermind]: {
    speed: 105,
    chaseInterval: 0.114,
    radius: 128,
    height: 100,
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
  }, // Real hitscan chaingun in vanilla too
  [ThingType.cyberdemon]: {
    speed: 140,
    chaseInterval: 0.114,
    radius: 40,
    height: 110,
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
  }, // Three rockets per volley, the same MISL sprite the player's own launcher fires
  // VILE arch-vile: vanilla's own P_CheckMissileRange refuses to fire beyond 14*64=896 map units
  // for this type specifically (MT_VILE), tighter than the generic 200-unit falloff cap below.
  [ThingType.archVile]: {
    speed: 262.5,
    chaseInterval: 0.057,
    radius: 20,
    height: 56,
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
  },
};

/**
 * The three missiles vanilla's fast mode speeds up, keyed by the sprite that identifies them here:
 * `MT_TROOPSHOT` (`BAL1`, the imp's) and `MT_HEADSHOT` (`BAL2`, the cacodemon's) go from 10 to 20
 * units per tic, `MT_BRUISERSHOT` (`BAL7`, the baron's and the hell knight's) from 15 to 20 —
 * `G_InitNew`, `g_game.c`. ×35 for this engine's units per second. Every *other* missile in the
 * game (the revenant's, the mancubus's, the arachnotron's, the cyberdemon's rocket) is untouched.
 */
const FAST_MISSILE_SPEED: Record<string, number> = { BAL1: 20 * 35, BAL2: 20 * 35, BAL7: 20 * 35 };

/**
 * The types whose state tics fast mode halves: `for (i=S_SARG_RUN1; i<=S_SARG_PAIN2; i++)
 * states[i].tics >>= 1`. That range is the demon's run, attack and pain states — and the spectre
 * runs on the very same state chain (`info.c`'s `MT_SPECTRE`), so it is caught by the same loop.
 * Nothing else in the roster is: on nightmare a cyberdemon moves at exactly its usual pace, which
 * surprises people who expect "fast monsters" to mean all of them.
 */
const FAST_TIC_TYPES = new Set<number>([ThingType.demon, ThingType.spectre]);

/**
 * `MONSTER_STATS` as vanilla's fast mode leaves it — what `G_InitNew` produces by editing the
 * global `states`/`mobjinfo` tables in place when the skill is nightmare (or `-fast` is given,
 * which this engine has no switch for). Derived rather than typed out, so a stat corrected in the
 * table above can't fail to reach the fast one.
 *
 * Halving a state's tics doubles how often `A_Chase` runs, which in this engine's dt-scaled model
 * is a doubled `speed` and a halved `chaseInterval`; the attack and pain states in the same range
 * become half as long. See docs/monster-ai.md § Fast monsters.
 */
export const FAST_MONSTER_STATS: Record<number, MonsterStats> = Object.fromEntries(
  Object.entries(MONSTER_STATS).map(([key, stats]) => [key, fastVariant(Number(key), stats)]),
);

/** One type's entry as fast mode leaves it — the two edits `G_InitNew` makes, applied in turn. */
function fastVariant(type: number, stats: MonsterStats): MonsterStats {
  let fast = stats;
  if (FAST_TIC_TYPES.has(type)) {
    fast = {
      ...fast,
      speed: fast.speed * 2,
      chaseInterval: fast.chaseInterval / 2,
      painDuration: fast.painDuration / 2,
      melee: fast.melee && { ...fast.melee, duration: fast.melee.duration / 2 },
      ranged: fast.ranged && { ...fast.ranged, duration: fast.ranged.duration / 2 },
    };
  }
  const missile = fast.ranged?.projectile;
  const missileSpeed = missile && FAST_MISSILE_SPEED[missile.sprite];
  if (fast.ranged && missile && missileSpeed !== undefined) {
    fast = { ...fast, ranged: { ...fast.ranged, projectile: { ...missile, speed: missileSpeed } } };
  }
  return fast;
}

/** The stat table one skill plays on: nightmare's fast monsters, or the plain vanilla one — see `fastMonsters` in game/skill.ts. */
export function monsterStatsFor(fast: boolean): Record<number, MonsterStats> {
  return fast ? FAST_MONSTER_STATS : MONSTER_STATS;
}

/** The tallest body in the roster (the cyberdemon's 110), derived from the table so it can't drift — a cheap "nobody can be caught in a gap this big" early-out. */
export const TALLEST_BODY_HEIGHT = Math.max(...Object.values(MONSTER_STATS).map((s) => s.height));
