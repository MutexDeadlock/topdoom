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
import { MELEE_RANGE, type AttackStats, type MonsterStats } from './defs.ts';
import type { SfxId } from '../../audio/sfx.ts';
import { DOOM_TIC } from '../../constants.ts';
import { pristineFrameTables } from '../dehacked/frames.ts';
import { MOBJ_INFO } from '../dehacked/tables.ts';

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
 * One attack as written out here. `duration` — and the volley's `shots`/`shotInterval` and the
 * windup's `startDelaySeconds` — are walked out of the chain's own states by the fill below, so a
 * row carries them only where `FRAME_OVERRIDES` says the shipped reading wins.
 */
type AttackSeed = Omit<AttackStats, 'duration'> & Partial<Pick<AttackStats, 'duration'>>;

/**
 * A stat row as written out here: every field no state chain can carry. `speed`, `chaseInterval`,
 * `painDuration` and each attack's timings cannot be written here at all — the fill loop below
 * writes them from vanilla's own chains, which is what turns these seeds into complete
 * `MonsterStats`.
 */
type MonsterSeed = Omit<MonsterStats, 'speed' | 'chaseInterval' | 'painDuration' | 'melee' | 'ranged'> & {
  melee: AttackSeed | null;
  ranged: AttackSeed | null;
};

/**
 * Per-doomednum combat stats, covering every `MONSTER_TYPES` entry except the two in
 * `INERT_SHOOTABLE` above, and completed by the fill loop below (§ the fill loop,
 * docs/dehacked.md § Frames).
 *
 * **Both timing and damage are lifted from vanilla, not tuned by feel.** `painChance`, `radius`,
 * `height`, `mass` and the sounds are `mobjinfo` fields; `diceSides`/`diceMult` are each attack's
 * own literal roll from `p_enemy.c`, or `PIT_CheckThing`'s universal missile formula. Splash is
 * correctly non-uniform — only the cyberdemon's `MT_ROCKET` explodes in vanilla. See
 * docs/monster-ai.md § Timings and damage come from vanilla, not from feel, and
 * docs/monster-attacks.md § Hitscan vs. projectile for which types get which attack.
 */
const MONSTER_SEED: Record<number, MonsterSeed> = {
  [ThingType.zombieman]: {
    radius: 20,
    height: 56,
    mass: 100,
    melee: null,
    // A_PosAttack: (rand%5+1)*3.
    ranged: { diceSides: 5, diceMult: 3},
    painChance: 0.781,
    sounds: { see: 'posit1', active: 'posact', pain: 'popain', death: 'podth1', attack: 'pistol' },
  },
  [ThingType.shotgunGuy]: {
    radius: 20,
    height: 56,
    mass: 100,
    melee: null,
    // A_SPosAttack: 3 separate P_LineAttacks per call, each (rand%5+1)*3 —
    // see AttackStats.pellets's doc.
    ranged: { diceSides: 5, diceMult: 3, pellets: 3},
    painChance: 0.664,
    sounds: { see: 'posit2', active: 'posact', pain: 'popain', death: 'podth2', attack: 'shotgn' },
  },
  [ThingType.heavyWeaponDude]: {
    radius: 20,
    height: 56,
    mass: 100,
    melee: null,
    // A_CPosAttack: (rand%5+1)*3, once per shots:2 entry — A_CPosRefire
    // hoses without pause while it can see you.
    ranged: { diceSides: 5, diceMult: 3, refire: true },
    painChance: 0.664,
    // `attack` really is the shotgun's: `A_CPosAttack` plays `sfx_shotgn`, not
    // the pistol shot its single-bullet roll would suggest — a vanilla oddity
    // (p_enemy.c), and the chaingunner's own `mobjinfo.attacksound` is 0.
    sounds: { see: 'posit2', active: 'posact', pain: 'popain', death: 'podth2', attack: 'shotgn' },
  },
  [ThingType.wolfensteinSS]: {
    radius: 20,
    height: 56,
    mass: 100,
    melee: null,
    // SSWV fires the same A_CPosAttack as the chaingunner, twice (S_SSWV_ATK3/
    // ATK5, confirmed against info.c) with an A_CPosRefire loop of its own —
    // shotInterval is the two states between those calls (S_SSWV_ATK4's own
    // 6 tics + ATK3's own 4) over 35.
    ranged: {
      diceSides: 5,
      diceMult: 3,
      duration: 1.0,
      startDelaySeconds: 20 * DOOM_TIC,
      shots: 2,
      shotInterval: 10 * DOOM_TIC,
      refire: true,
    },
    painChance: 0.664,
    sounds: { see: 'sssit', active: 'posact', pain: 'popain', death: 'ssdth', attack: 'shotgn' },
  },
  [ThingType.imp]: {
    radius: 20,
    height: 56,
    mass: 100,
    // A_TroopAttack melee: (rand%8+1)*3, or its fireball at anything that got
    // out of reach during the windup.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 3, missileOnMiss: true },
    // A direct missile hit is vanilla's universal (rand%8+1)*mobjinfo.damage
    // (PIT_CheckThing/p_map.c) — TROOPSHOT's own damage field is 3.
    ranged: {
      diceSides: 8,
      diceMult: 3,
      projectile: { sprite: 'BAL1', speed: 350 },
    },
    painChance: 0.781,
    sounds: { see: 'bgsit1', active: 'bgact', pain: 'popain', death: 'bgdth1', melee: 'claw' },
  },
  [ThingType.demon]: {
    radius: 30,
    height: 56,
    mass: 400,
    // A_SargAttack: (rand%10+1)*4.
    melee: { range: MELEE_RANGE, diceSides: 10, diceMult: 4},
    ranged: null,
    painChance: 0.703,
    // `A_SargAttack` itself is silent — the growl is the `attacksound` `A_Chase`
    // plays on *entering* meleestate, so it leads the bite rather than landing
    // with it, and a bite that misses still growls. See `MonsterSounds.melee`.
    sounds: { see: 'sgtsit', active: 'dmact', pain: 'dmpain', death: 'sgtdth', meleeWindup: 'sgtatk' },
  },
  [ThingType.spectre]: {
    radius: 30,
    height: 56,
    mass: 400,
    melee: { range: MELEE_RANGE, diceSides: 10, diceMult: 4},
    ranged: null,
    painChance: 0.703,
    sounds: { see: 'sgtsit', active: 'dmact', pain: 'dmpain', death: 'sgtdth', meleeWindup: 'sgtatk' },
  }, // Same stats as the demon; only `MF_SHADOW` differs, and that is purely
  // how it draws — docs/sprites.md § The spectre's fuzz.
  [ThingType.lostSoul]: {
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
      rangeFalloffScale: 0.5,
      // No `startDelaySeconds`: `A_SkullAttack` launches the charge from `beginRangedAttack`
      // directly, never through the burst timer that reads it. Vanilla's own 10-tic wind-up is
      // the pose's first frame and nothing else. docs/monster-ai.md § The windup.
      charge: { speed: 700, maxDist: WEAPON_RANGE },
    },
    painChance: 1,
    // No sight sound at all (`mobjinfo.seesound` is 0), and its death sound is
    // the *fireball* explosion `firxpl` rather than a scream. `attack` is
    // `A_SkullAttack`'s own `sklatk`, played as the charge launches.
    sounds: { active: 'dmact', pain: 'dmpain', death: 'firxpl', attack: 'sklatk' },
    flies: true,
  }, // Drifts slowly, then hurls itself (A_SkullAttack, SKULLSPEED = 20 units/tic)
  [ThingType.cacodemon]: {
    radius: 31,
    height: 56,
    mass: 400,
    // A_HeadAttack melee: (rand%6+1)*10, or its fireball at anything out of
    // reach by the time it bites. `duration` and `startDelaySeconds` are the
    // missile chain's own (15 and 10 tics): `meleestate` is `S_NULL`, so there
    // is no melee chain for the walker below to read them off — FRAME_OVERRIDES.
    melee: { range: MELEE_RANGE, diceSides: 6, diceMult: 10, missileOnMiss: true, duration: 0.429, startDelaySeconds: 10 * DOOM_TIC },
    // Universal missile-hit formula; HEADSHOT's own damage field is 5.
    ranged: {
      diceSides: 8,
      diceMult: 5,
      projectile: { sprite: 'BAL2', speed: 350 },
    },
    painChance: 0.5,
    // `A_HeadAttack`'s bite has no sound of its own and the cacodemon's
    // `attacksound` is 0, so its melee really is silent in vanilla too.
    sounds: { see: 'cacsit', active: 'dmact', pain: 'dmpain', death: 'cacdth' },
    flies: true,
  }, // One attack state that bites up close and spits a fireball otherwise (A_HeadAttack)
  [ThingType.baronOfHell]: {
    radius: 24,
    height: 64,
    mass: 1000,
    // A_BruisAttack melee: (rand%8+1)*10, or its fireball at anything out of reach.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 10, missileOnMiss: true },
    // Universal missile-hit formula; BRUISERSHOT's own damage field is 8.
    ranged: {
      diceSides: 8,
      diceMult: 8,
      projectile: { sprite: 'BAL7', speed: 525 },
    },
    painChance: 0.195,
    sounds: { see: 'brssit', active: 'dmact', pain: 'dmpain', death: 'brsdth', melee: 'claw' },
  },
  [ThingType.hellKnight]: {
    radius: 24,
    height: 64,
    mass: 1000,
    // Baron and hell knight share A_BruisAttack/MT_BRUISERSHOT exactly.
    melee: { range: MELEE_RANGE, diceSides: 8, diceMult: 10, missileOnMiss: true },
    ranged: {
      diceSides: 8,
      diceMult: 8,
      projectile: { sprite: 'BAL7', speed: 525 },
    },
    painChance: 0.195,
    sounds: { see: 'kntsit', active: 'dmact', pain: 'dmpain', death: 'kntdth', melee: 'claw' },
  }, // Vanilla's hell knight throws the same BAL7 fireball as the baron
  [ThingType.painElemental]: {
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
    // No `startDelaySeconds` for the same reason as the lost soul's: a `spawn` attack returns
    // straight out of `beginRangedAttack`. Vanilla's `A_PainAttack` sits on the chain's last state.
    ranged: { diceSides: 0, diceMult: 0, spawn: { type: ThingType.lostSoul } },
    painChance: 0.5,
    // `A_PainAttack` is silent; the lost soul it spawns brings its own `sklatk`.
    sounds: { see: 'pesit', active: 'dmact', pain: 'pepain', death: 'pedth' },
    flies: true,
  }, // A_PainAttack/A_PainShootSkull, spawns a lost soul and launches it at the elemental's own target
  [ThingType.revenant]: {
    radius: 20,
    height: 56,
    mass: 500,
    // A_SkelFist: (rand%10+1)*6.
    melee: { range: MELEE_RANGE, diceSides: 10, diceMult: 6},
    ranged: {
      // Universal missile-hit formula; TRACER's own damage field is 10.
      diceSides: 8,
      diceMult: 10,
      // A_Tracer — the one monster projectile with real homing; see
      // AttackStats.projectile.homing's doc.
      projectile: { sprite: 'FATB', speed: 350, homing: true },
      rangeFalloffScale: 0.5,
      minOffsetDist: 196,
    },
    painChance: 0.391,
    // The one type with two melee sounds in vanilla, and it keeps both:
    // `A_SkelWhoosh`'s `skeswg` as the fist swings, `A_SkelFist`'s `skepch`
    // 12 tics later if it connects. Its pain sound is the *human* `popain`,
    // which is vanilla's own `mobjinfo`, not a slip.
    sounds: { see: 'skesit', active: 'skeact', pain: 'popain', death: 'skedth', melee: 'skepch', meleeWindup: 'skeswg' },
  },
  [ThingType.mancubus]: {
    radius: 48,
    height: 64,
    mass: 1000,
    melee: null,
    ranged: {
      // Universal missile-hit formula; FATSHOT's own damage field is 8.
      diceSides: 8,
      diceMult: 8,
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
    // `windup` is `A_FatRaise`'s own `manatk`, on the first frame of the
    // missilestate chain — the tell that a triple volley is coming. The
    // fireballs themselves are `firsht`, from the missile, not from here.
    sounds: { see: 'mansit', active: 'posact', pain: 'mnpain', death: 'mandth', windup: 'manatk' },
  }, // A_FatAttack1/2/3, three volleys out of one 80-tic attack state, each firing a pair of fireballs
  [ThingType.arachnotron]: {
    radius: 64,
    height: 64,
    mass: 600,
    melee: null,
    // Universal missile-hit formula; ARACHPLAZ's own damage field is 5.
    ranged: { diceSides: 8, diceMult: 5, refire: true, projectile: { sprite: 'APLS', speed: 875 } },
    painChance: 0.5,
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
      refire: true,
      rangeFalloffScale: 0.5,
    },
    painChance: 0.156,
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
    radius: 40,
    height: 110,
    mass: 1000,
    melee: null,
    ranged: {
      // Universal missile-hit formula; ROCKET's own damage field is 20.
      diceSides: 8,
      diceMult: 20,
      // 24 tics, not 12: `A_CyberAttack` sits on `S_CYBER_ATK2`/`ATK4`/`ATK6`, each 12 tics, with
      // a 12-tic `A_FaceTarget` state between every pair — so the interval is the gap between the
      // firing calls, two states apart, and not one state's own length.
      // A_CyberAttack spawns a real MT_ROCKET — the same type the player's
      // own launcher fires, and the one monster projectile whose death
      // state actually calls A_Explode; see AttackStats.projectile.splash's
      // doc. radius/damage are vanilla's own literal P_RadiusAttack(...,128).
      projectile: { sprite: 'MISL', speed: 700, splash: { radius: 128, damage: 128 } },
      rangeFalloffScale: 0.5,
      rangeFalloffCap: 160,
    },
    painChance: 0.078,
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
      // A_VileAttack doesn't fire until 66 tics into the missilestate chain
      // (ATK1..ATK9's summed tics) — see AttackStats.startDelaySeconds's doc.
      blast: { knockUpSpeed: VILE_KNOCKUP_SPEED, splashRadius: 70, splashDamage: 70 },
    },
    painChance: 0.039,
    // `windup` is `A_VileStart`'s `vilatk`, at the same moment the warning
    // flame appears (`monsters/vile.ts` adds the flame's own `flamst`); the
    // blast itself is `A_VileAttack`'s `barexp`, played from there.
    sounds: { see: 'vilsit', active: 'vilact', pain: 'vipain', death: 'vildth', windup: 'vilatk' },
    resurrects: true,
  },
};

/**
 * The seeds above, completed by the fill loop below. The cast is what the loop discharges: every
 * row gains its `speed`, `chaseInterval`, `painDuration` and attack timings before anything reads
 * this table, and `tests/game/dehacked-frames.test.ts` checks the finished values against the
 * hand transcription in `tests/fixtures/frametables.ts`.
 */
export const MONSTER_STATS = MONSTER_SEED as Record<number, MonsterStats>;

/**
 * The frame-derived fields the walker reads differently from the hand transcription, kept at their
 * shipped values on purpose. This is the whole list — a new row is a decision, never a shrug — and
 * `tests/game/dehacked-frames.test.ts` fails if one of them stops differing.
 *
 * There is deliberately no `chase` row: the walk loop is the walker's alone, footstep states
 * included — docs/monster-ai.md § Timings and damage come from vanilla, not from feel.
 *
 * - **`ranged` on the SS.** Its two `A_FaceTarget` states sit ahead of the `A_CPosRefire` loop, and
 *   the walker measures the loop alone. `MONSTER_ATTACK_POSE`'s matching override is in
 *   `things/tables.ts`; duration, pose and windup all follow the same span, so they move together.
 * - **`windup` on the lost soul and pain elemental.** A charge and a spawn both return straight out
 *   of `beginRangedAttack`, so the burst timer `startDelaySeconds` is read through never runs.
 *   Writing one would be a trap, not a no-op.
 * - **`melee` on the cacodemon.** Its `meleestate` is `S_NULL` — `A_HeadAttack` bites from inside
 *   the missile chain — so there is no chain for the walker to measure the bite's length or its
 *   windup from; both are written out as the missile chain's own.
 */
const FRAME_OVERRIDES: Record<number, { melee?: true; ranged?: true; windup?: true }> = {
  [ThingType.wolfensteinSS]: { ranged: true, windup: true },
  [ThingType.lostSoul]: { windup: true },
  [ThingType.painElemental]: { windup: true },
  [ThingType.cacodemon]: { melee: true },
};

/**
 * Writes the frame-derived fields of every stat block from the walker's reading of vanilla's own
 * `states[]` (docs/dehacked.md § Frames): both attack durations, the pain length, the volley's
 * shape and the walk loop's chase clock and speed. The rest of each row — health, radius, mass,
 * sounds, the damage rolls — is `mobjinfo`/`p_enemy.c` data that no state chain carries, and stays
 * written out above.
 *
 * Runs before `deriveFastStats` and `TALLEST_BODY_HEIGHT` below, which read the finished table, and
 * before `dehacked/apply.ts` snapshots it for `resetDehacked`.
 */
for (const [key, m] of Object.entries(pristineFrameTables().monsters)) {
  const dn = Number(key);
  const stats = MONSTER_STATS[dn];
  if (!stats) continue;
  const keep = FRAME_OVERRIDES[dn] ?? {};
  stats.painDuration = m.painDuration;
  if (stats.melee && m.meleeDuration !== null && !keep.melee) stats.melee.duration = m.meleeDuration;
  if (stats.melee && m.meleeDelay !== null && !keep.melee) stats.melee.startDelaySeconds = m.meleeDelay;
  if (stats.ranged && !keep.ranged) {
    if (m.rangedDuration !== null) stats.ranged.duration = m.rangedDuration;
    // A single-shot chain leaves both unset and reads as vanilla's default of one shot.
    if (m.rangedShots > 1) stats.ranged.shots = m.rangedShots;
    if (m.rangedInterval !== null) stats.ranged.shotInterval = m.rangedInterval;
  }
  if (stats.ranged && m.rangedDelay !== null && !keep.windup) stats.ranged.startDelaySeconds = m.rangedDelay;
  if (m.chase) {
    stats.chaseInterval = m.chase.interval;
    // `mobjinfo.speed` is map units per `A_Chase`; the loop factor turns it into units per second.
    stats.speed = Math.round(MOBJ_INFO.find((row) => row.doomednum === dn)!.speed * m.chase.factor * 10) / 10;
  }
}

/** An `AttackStats` whose `projectile` is known present — what `forEachProjectileAttack` hands back. */
type ProjectileAttack = AttackStats & { projectile: NonNullable<AttackStats['projectile']> };

/**
 * Every `AttackStats` in the table that fires the named flight sprite. In vanilla one `mobjinfo`
 * *is* the imp's fireball wherever it comes from, so a patch that edits `MT_TROOPSHOT` has to move
 * every stat block naming `BAL1` together — `dehacked/apply.ts` rewrites their stats through this
 * and `dehacked/frames.ts` rekeys them when the sprite itself is patched.
 * docs/dehacked.md § Thing records.
 */
export function forEachProjectileAttack(sprite: string, visit: (attack: ProjectileAttack) => void): void {
  for (const stats of Object.values(MONSTER_STATS)) {
    // The per-shot attacks of a mixed volley are stat blocks like any other and name their own
    // missiles, so a patched flight sprite has to reach them too (`AttackStats.shotAttacks`).
    for (const attack of [stats.melee, stats.ranged, ...(stats.ranged?.shotAttacks ?? [])]) {
      if (attack?.projectile?.sprite === sprite) visit(attack as ProjectileAttack);
    }
  }
}

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
export let FAST_MONSTER_STATS: Record<number, MonsterStats> = deriveFastStats();

function deriveFastStats(): Record<number, MonsterStats> {
  return Object.fromEntries(
    Object.entries(MONSTER_STATS).map(([key, stats]) => [key, fastVariant(Number(key), stats)]),
  );
}

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
  // Same edit again for a mixed volley's per-shot missiles: fast mode speeds a `BAL7` up whichever
  // shot of whichever chain threw it.
  if (fast.ranged?.shotAttacks?.some((shot) => shot.projectile && FAST_MISSILE_SPEED[shot.projectile.sprite] !== undefined)) {
    fast = {
      ...fast,
      ranged: {
        ...fast.ranged,
        shotAttacks: fast.ranged.shotAttacks.map((shot) => {
          const speed = shot.projectile && FAST_MISSILE_SPEED[shot.projectile.sprite];
          return shot.projectile && speed !== undefined ? { ...shot, projectile: { ...shot.projectile, speed } } : shot;
        }),
      },
    };
  }
  return fast;
}

/** The stat table one skill plays on: nightmare's fast monsters, or the plain vanilla one — see `fastMonsters` in game/skill.ts. */
export function monsterStatsFor(fast: boolean): Record<number, MonsterStats> {
  return fast ? FAST_MONSTER_STATS : MONSTER_STATS;
}

/** The tallest body in the roster (the cyberdemon's 110), derived from the table so it can't drift — a cheap "nobody can be caught in a gap this big" early-out. */
export let TALLEST_BODY_HEIGHT = Math.max(...Object.values(MONSTER_STATS).map((s) => s.height));

/**
 * Re-derives everything above that is computed from `MONSTER_STATS`, after something has written
 * into it. The one caller is the DEHACKED applier (docs/dehacked.md § Applying: reset, then
 * patch) — a patch edits `MONSTER_STATS` in place, and both values here were otherwise frozen at
 * import, so a patched imp would stay fast-mode-vanilla and a patched cyberdemon would leave the
 * gap early-out short.
 *
 * These are `let` for that reason alone. Nothing else assigns them, and `monsterStatsFor` is
 * still the single accessor every reader goes through.
 */
export function rebuildDerivedMonsterStats(): void {
  FAST_MONSTER_STATS = deriveFastStats();
  TALLEST_BODY_HEIGHT = Math.max(...Object.values(MONSTER_STATS).map((s) => s.height));
}
