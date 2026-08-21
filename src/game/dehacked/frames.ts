/**
 * Walks vanilla's frame table — `dehacked/states.ts` as written, or a copy a patch has edited — and
 * derives the letter-list, pose and duration tables this engine animates from. **Pure**: it reads
 * `states.ts` and `MOBJ_INFO` and touches no game table, which is what lets `things/tables.ts`,
 * `monsters/tables.ts` and `spritefx/tables.ts` build themselves from it at import while
 * `dehacked/apply.ts` re-runs it against a patched copy. See docs/dehacked.md § Frames.
 */
import { DOOM_TIC } from '../../constants.ts';
import type { AttackPose } from '../things/defs.ts';
import { ThingType } from '../things/doomednums.ts';
import type { DehFrameEdit, DehThingEdit, DehWeaponEdit } from './defs.ts';
import {
  fireChainStates, frameLetter, MOBJ_STATES, SPRITE_NAMES, STATES, WEAPON_STATES,
  type MobjStates, type StateRow, type WeaponStates,
} from './states.ts';
import { MISSILE_SINKS, MOBJ_INFO } from './tables.ts';

/**
 * The filler rate a one-frame entry carries. A single held frame never advances, so its duration is
 * arbitrary; this matches `things/tables.ts`'s `MONSTER_DEATH_FRAME_SECONDS` so a derived entry is
 * byte-identical to the hand-written one it replaced, and a test pins the two equal. The flat
 * per-frame rates are the residual § Frames says the walker does not derive.
 */
const HELD_FRAME_SECONDS = 6 * DOOM_TIC;

/** A `StateRow` a patch can write into. */
type MutableStateRow = [sprite: number, frame: number, tics: number, action: string, next: number, name: string];

/** The frame table and state pointers as one patch leaves them. */
export interface PatchedStates {
  states: readonly StateRow[];
  mobjStates: readonly MobjStates[];
  weaponStates: readonly WeaponStates[];
}

/**
 * `p_enemy.c`'s actions that step the monster — `A_Chase` itself and the three footstep wrappers
 * (`A_Hoof`, `A_Metal`, `A_BabyMetal`) that play a sound and then call it, plus `A_VileChase`,
 * which is `A_Chase` with a corpse search in front. The walk loop's chase count is how many of its
 * states carry one of these.
 */
const CHASE_ACTIONS = new Set(['A_Chase', 'A_VileChase', 'A_Hoof', 'A_Metal', 'A_BabyMetal']);

/**
 * `p_enemy.c`'s actions that actually deal the damage or launch the missile — as opposed to the
 * `A_FaceTarget`/`A_VileStart`/`A_FatRaise` wind-up states around them. Where the first of these
 * sits in a chain is the attack's `startDelaySeconds`, and it is what puts the firing frame under
 * the shot (docs/monster-ai.md § The windup).
 */
const FIRING_ACTIONS = new Set([
  'A_PosAttack', 'A_SPosAttack', 'A_CPosAttack', 'A_TroopAttack', 'A_SargAttack', 'A_HeadAttack',
  'A_BruisAttack', 'A_SkullAttack', 'A_PainAttack', 'A_SkelFist', 'A_SkelMissile', 'A_FatAttack1',
  'A_FatAttack2', 'A_FatAttack3', 'A_BspiAttack', 'A_CyberAttack', 'A_VileAttack',
]);

/**
 * `p_pspr.c`'s actions that fire the weapon — the nine that spend the ammo and put the shot, bullet
 * or swing out. `A_GunFlash`, `A_BFGsound`, `A_CheckReload` and the super shotgun's reload actions
 * sit in the same chains and are not among them: they cost their states' tics without firing
 * anything. How many of these a fire chain carries is how many shots one pass through it makes —
 * docs/weapons.md § Fire rates.
 */
const WEAPON_FIRE_ACTIONS = new Set([
  'A_Punch', 'A_Saw', 'A_FirePistol', 'A_FireShotgun', 'A_FireShotgun2', 'A_FireCGun',
  'A_FireMissile', 'A_FirePlasma', 'A_FireBFG',
]);

/** One walk of `states[]` from an entry point — see `walkChain`. */
interface Chain {
  /** The states visited, in order, `start` first. Empty when `start` is `S_NULL`. */
  indices: number[];
  /** Position in `indices` the chain loops back to, or -1 when it doesn't loop. */
  cycleAt: number;
  /** Ended on a `tics: -1` state, which holds forever. */
  holds: boolean;
  /** Ended by stepping to `S_NULL` — the thing is removed. */
  exitsToNull: boolean;
}

/**
 * Follows `next` from `start` until the chain loops, steps to `S_NULL`, reaches a state that holds
 * forever, or re-enters a state in `stop` — the walk loop, for a pain or attack chain, which is how
 * those chains end in `info.c`. Bounded by the visited set.
 */
export function walkChain(states: readonly StateRow[], start: number, stop?: ReadonlySet<number>): Chain {
  const indices: number[] = [];
  const at = new Map<number, number>();
  let cur = start;
  let holds = false;
  while (cur !== 0 && states[cur] !== undefined) {
    const seen = at.get(cur);
    if (seen !== undefined) return { indices, cycleAt: seen, holds, exitsToNull: false };
    if (stop?.has(cur)) return { indices, cycleAt: -1, holds, exitsToNull: false };
    at.set(cur, indices.length);
    indices.push(cur);
    const row = states[cur];
    if (row[2] === -1) {
      holds = true;
      break;
    }
    cur = row[4];
  }
  return { indices, cycleAt: -1, holds, exitsToNull: !holds && indices.length > 0 };
}

/** The states the chain keeps cycling through once it loops — or all of it, when it doesn't. */
function cycleOf(chain: Chain): number[] {
  return chain.cycleAt >= 0 ? chain.indices.slice(chain.cycleAt) : chain.indices;
}

/** The frame letters of a run of states, in order. */
function lettersOf(states: readonly StateRow[], indices: readonly number[]): string[] {
  return indices.map((i) => frameLetter(states[i][1]));
}

/**
 * The distinct letters of a run, each kept where it first appears. Vanilla holds a pose by
 * repeating its frame across states; against this engine's flat per-frame rate that repeat is a
 * no-op, which is the rule the hand-curated pose tables were written to.
 */
function distinctLetters(states: readonly StateRow[], indices: readonly number[]): string[] {
  return [...new Set(lettersOf(states, indices))];
}

/** Summed tics of a run, a holding state's -1 counting as nothing. */
function ticsOf(states: readonly StateRow[], indices: readonly number[]): number {
  let sum = 0;
  for (const i of indices) sum += Math.max(0, states[i][2]);
  return sum;
}

/** The sprite name the first state of a run draws, or undefined for an empty run. */
function spriteOf(states: readonly StateRow[], indices: readonly number[]): string | undefined {
  return indices.length ? SPRITE_NAMES[states[indices[0]][0]] : undefined;
}

/** The walk loop's timing: seconds per chase call and the per-call factor `MonsterStats.speed` carries. */
interface ChaseTiming {
  interval: number;
  /** `chaseCount × 35 / loopTics` — what `mobjinfo.speed` is multiplied by to give units per second. */
  factor: number;
}

/** What the walker derives for one monster type. */
export interface MonsterFrames {
  sprite: string | undefined;
  walk: string[];
  idle: string[] | null;
  death: string[] | null;
  xdeath: string[] | null;
  deathSprite: { death?: string; xdeath?: string } | null;
  vanishes: boolean;
  pain: string[] | null;
  painDuration: number;
  meleePose: AttackPose | null;
  rangedPose: AttackPose | null;
  meleeDuration: number | null;
  rangedDuration: number | null;
  /** Seconds into the ranged chain the damaging action sits, or null where the chain has none. */
  rangedDelay: number | null;
  /** How many damaging actions the ranged chain carries, and the seconds between consecutive ones. */
  rangedShots: number;
  rangedInterval: number | null;
  raise: string[] | null;
  chase: ChaseTiming | null;
}

/** What the walker derives for one weapon, off its `atkstate` chain. */
export interface WeaponFrames {
  /** Seconds between two shots with the trigger held — `WeaponDef.cooldown`. */
  cooldown: number;
  /** How many firing actions one pass through the chain carries: 2 for the chainsaw and chaingun, 1 for the rest. */
  shots: number;
}

/**
 * One weapon's fire rate, walked from its `atkstate`.
 *
 * The chain is summed **up to, and not including, its `A_ReFire` state**: `A_ReFire` runs on entry
 * and re-enters `atkstate` immediately while the trigger is down, so its own tics are only ever
 * spent on release. Where a chain fires more than once per pass — `S_SAW1`/`S_SAW2` and
 * `S_CHAIN1`/`S_CHAIN2` both carry a firing action — the rate is the pass divided by the number of
 * firing actions, because `WeaponDef` holds one interval and not a per-shot schedule. Vanilla
 * spaces both of those evenly (4 tics each), so the division is exact there and a mean only for a
 * patch that makes them uneven. docs/weapons.md § Fire rates.
 */
function deriveWeapon(states: readonly StateRow[], w: WeaponStates): WeaponFrames {
  // `fireChainStates` carries the closing `A_ReFire` state, whose tics are only ever spent on
  // release — the whole point of the rule — so it comes back out here.
  const span = fireChainStates(states, w.atk).filter((i) => states[i][3] !== 'A_ReFire');
  const shots = Math.max(1, span.filter((i) => WEAPON_FIRE_ACTIONS.has(states[i][3])).length);
  // A chain of nothing but zero-tic states would fire every frame; vanilla cannot reach that state
  // (`P_SetPsprite` would spin), so one tic is this engine's floor rather than a vanilla rule.
  const tics = Math.max(1, ticsOf(states, span) / shots);
  return { cooldown: tics * DOOM_TIC, shots };
}

/** What the walker derives for one missile, keyed by its pristine flight sprite. */
export interface MissileFrames {
  flightSprite: string | undefined;
  flight: string[] | null;
  impact: { sprite: string; frames: string[] } | null;
}

/** Everything the walker derives, in the shapes the engine's tables hold — one record per table. */
export interface FrameTables {
  monsters: Record<number, MonsterFrames>;
  /** Fire rates, keyed by `weapontype_t` index — `dehacked/tables.ts`'s `WEAPON_ORDER` names them. */
  weapons: Record<number, WeaponFrames>;
  /** Decoration sprites and idle animations, keyed by doomednum. */
  sprites: Record<number, string>;
  anims: Record<number, { frames: string[]; frameSeconds: number } | null>;
  missiles: Record<string, MissileFrames>;
  barrel: {
    idleFrames: string[];
    idleFrameSeconds: number;
    deathSprite: string | undefined;
    deathFrames: string[];
    explodeDelaySeconds: number | null;
  } | null;
}

/** `STATES` and `MOBJ_STATES` with a patch's edits written in. Neither original is touched. */
export function patchStates(
  frameEdits: readonly DehFrameEdit[],
  thingEdits: readonly DehThingEdit[],
  weaponEdits: readonly DehWeaponEdit[] = [],
): PatchedStates {
  const states: MutableStateRow[] = STATES.map((row) => [...row]);
  for (const edit of frameEdits) {
    const row = states[edit.index];
    if (!row) continue;
    if (edit.spriteNum !== undefined) row[0] = edit.spriteNum;
    if (edit.subNumber !== undefined) row[1] = edit.subNumber;
    if (edit.duration !== undefined) row[2] = edit.duration;
    if (edit.nextFrame !== undefined) row[4] = edit.nextFrame;
  }
  const mobjStates = MOBJ_STATES.map((row) => ({ ...row }));
  for (const edit of thingEdits) {
    const row = mobjStates[edit.index - 1];
    if (row && edit.states) Object.assign(row, edit.states);
  }
  const weaponStates = WEAPON_STATES.map((row) => ({ ...row }));
  for (const edit of weaponEdits) {
    const row = weaponStates[edit.index];
    if (row && edit.states) Object.assign(row, edit.states);
  }
  return { states, mobjStates, weaponStates };
}

/**
 * A chain's duration in seconds — its summed tics over 35. A chain that loops back through an
 * `A_*Refire` (the chaingunner's, the two spiders') counts only that loop: it is what one pass of
 * the attack lasts, and the `A_FaceTarget` lead-in before it is the windup this engine's
 * `startDelaySeconds` treats as zero for everyone but the arch-vile. Any other loop is the whole
 * attack held — the lost soul cycles `S_SKULL_ATK3`/`ATK4` for as long as its charge flies.
 */
function durationOf(states: readonly StateRow[], chain: Chain): number {
  return ticsOf(states, spanOf(states, chain)) / 35;
}

/**
 * The states one attack actually occupies: an `A_*Refire` loop repeats on its own without a fresh
 * chase call, so the loop alone is what `AttackStats.duration` covers and what the pose spans —
 * which is also what drops the chaingunner's and the two spiders' `A_FaceTarget` lead-in, the one
 * state of theirs drawn on a walk-cycle letter. Any other chain is measured whole.
 */
function spanOf(states: readonly StateRow[], chain: Chain): number[] {
  const loop = cycleOf(chain);
  const refires = chain.cycleAt >= 0 && loop.some((i) => states[i][3].endsWith('Refire'));
  return refires ? loop : chain.indices;
}

/** A run's tics averaged to one flat per-frame rate, ties rounding down — how the hand-written tables flattened the uneven ones (6/8 → 7, 6/7 → 6, 10/15/8/6 → 10). */
function flatTics(states: readonly StateRow[], indices: readonly number[]): number {
  return Math.ceil(ticsOf(states, indices) / indices.length - 0.5);
}

/**
 * One attack chain's pose: the states of the span `durationOf` measures, letters **undeduped** and
 * each with its own tic count, with zero-tic states dropped because they never draw.
 */
function poseOf(states: readonly StateRow[], chain: Chain): AttackPose | null {
  const span = spanOf(states, chain).filter((i) => states[i][2] > 0);
  if (span.length === 0) return null;
  return { frames: lettersOf(states, span), tics: span.map((i) => states[i][2]) };
}

/** Where every damaging action sits in a chain's span, in tics from its start. */
function firingOffsets(states: readonly StateRow[], chain: Chain): number[] {
  const offsets: number[] = [];
  let tics = 0;
  for (const i of spanOf(states, chain)) {
    if (FIRING_ACTIONS.has(states[i][3])) offsets.push(tics);
    tics += Math.max(0, states[i][2]);
  }
  return offsets;
}

/**
 * Seconds into the same span before the first damaging action — the attack's windup. Null where
 * there is none to model: a chain that fires on its first state (the refire loops) or that carries
 * no damaging action at all.
 */
function firingDelayOf(offsets: readonly number[]): number | null {
  const first = offsets[0];
  return first === undefined || first === 0 ? null : first / 35;
}

/**
 * Seconds between consecutive shots of one chain — the gap between the *firing actions*, not
 * between a firing state and the next state. The cyberdemon is why that distinction is written
 * down: `A_CyberAttack` is on every second state of its chain, so its rockets are 24 tics apart
 * where the state it fires from is only 12 long. Null for a chain that fires once.
 */
function firingIntervalOf(offsets: readonly number[]): number | null {
  return offsets.length > 1 ? (offsets[1] - offsets[0]) / 35 : null;
}

/** One monster type's tables off its eight state pointers. */
function deriveMonster(states: readonly StateRow[], ms: MobjStates): MonsterFrames {
  const spawn = walkChain(states, ms.spawn);
  const see = walkChain(states, ms.see);
  // Where a pain, attack or raise chain ends: back in the walk loop, or — for a type with no
  // `seestate` (Keen, the brain) — back on its held stand frame.
  const walkSet = new Set([...see.indices, ...spawn.indices]);
  const sprite = spriteOf(states, spawn.indices);

  const walk = distinctLetters(states, see.indices);
  const idle = spawn.holds && spawn.indices.length === 1 ? lettersOf(states, spawn.indices) : null;

  const death = walkChain(states, ms.death);
  const xdeath = walkChain(states, ms.xdeath);
  const deathLetters = distinctLetters(states, death.indices);
  const xdeathLetters = distinctLetters(states, xdeath.indices);
  const deathSprite: { death?: string; xdeath?: string } = {};
  const deathSpriteName = spriteOf(states, death.indices);
  const xdeathSpriteName = spriteOf(states, xdeath.indices);
  if (deathSpriteName !== undefined && deathSpriteName !== sprite) deathSprite.death = deathSpriteName;
  if (xdeathSpriteName !== undefined && xdeathSpriteName !== sprite) deathSprite.xdeath = xdeathSpriteName;

  const pain = walkChain(states, ms.pain, walkSet);
  const melee = walkChain(states, ms.melee, walkSet);
  const missile = walkChain(states, ms.missile, walkSet);
  const raise = walkChain(states, ms.raise, walkSet);
  const missileShots = firingOffsets(states, missile);

  const loop = cycleOf(see);
  const loopTics = ticsOf(states, loop);
  const chaseCount = loop.filter((i) => CHASE_ACTIONS.has(states[i][3])).length;
  const chase = loopTics > 0 && chaseCount > 0 ? { interval: loopTics / chaseCount / 35, factor: (chaseCount * 35) / loopTics } : null;

  const orNull = (letters: string[]): string[] | null => (letters.length ? letters : null);
  return {
    sprite,
    walk,
    idle,
    death: orNull(deathLetters),
    xdeath: orNull(xdeathLetters),
    deathSprite: Object.keys(deathSprite).length ? deathSprite : null,
    // The lost soul and pain elemental: a final death state that steps to `S_NULL` removes the corpse.
    vanishes: death.exitsToNull,
    pain: orNull(distinctLetters(states, pain.indices)),
    painDuration: durationOf(states, pain),
    meleePose: poseOf(states, melee),
    rangedPose: poseOf(states, missile),
    meleeDuration: melee.indices.length ? durationOf(states, melee) : null,
    rangedDuration: missile.indices.length ? durationOf(states, missile) : null,
    rangedDelay: firingDelayOf(missileShots),
    rangedShots: missileShots.length,
    rangedInterval: firingIntervalOf(missileShots),
    raise: orNull(distinctLetters(states, raise.indices)),
    chase,
  };
}

/**
 * A decoration's idle animation off its spawn chain: the loop's letters as written (the evil eye's
 * `A,B,C,B` wobble is a real repeat), at one flat rate (`flatTics`). A single held frame that isn't
 * `A` is a one-letter entry (the dead-monster props spawn mid-death-chain); a held `A` needs no
 * entry.
 */
function deriveAnim(states: readonly StateRow[], spawn: Chain): { frames: string[]; frameSeconds: number } | null {
  if (spawn.indices.length === 0) return null;
  if (spawn.holds && spawn.indices.length === 1) {
    const [letter] = lettersOf(states, spawn.indices);
    return letter === 'A' ? null : { frames: [letter], frameSeconds: HELD_FRAME_SECONDS };
  }
  const loop = cycleOf(spawn);
  const frames = lettersOf(states, loop);
  if (frames.length === 1 && frames[0] === 'A') return null;
  return { frames, frameSeconds: flatTics(states, loop) * DOOM_TIC };
}

/** One missile's flight and impact art off its spawn and death chains. */
function deriveMissile(states: readonly StateRow[], ms: MobjStates): MissileFrames {
  const spawn = walkChain(states, ms.spawn);
  const death = walkChain(states, ms.death);
  const flight = lettersOf(states, cycleOf(spawn));
  const impactSprite = spriteOf(states, death.indices);
  return {
    flightSprite: spriteOf(states, spawn.indices),
    // A single flight frame needs no entry — `MISL` is deliberately absent from `PROJECTILE_FRAMES`.
    flight: flight.length > 1 ? flight : null,
    impact: impactSprite !== undefined ? { sprite: impactSprite, frames: distinctLetters(states, death.indices) } : null,
  };
}

/**
 * The `mobjinfo` rows this engine draws no sprite for, so the walker skips them: vanilla's teleport
 * destination, the Icon of Sin's spawn spot and its spawn shooter. Every other placeable row has a
 * `THING_SPRITES` entry, which is what makes the walker's output that table rather than a subset of
 * it. `tests/game/dehacked-frames.test.ts` pins the count.
 */
const NOT_DRAWN = new Set([14, 87, 89]);

/**
 * Which `MOBJ_INFO` rows are monsters here — a row with both a pain and a death chain, which in
 * `info.c` is exactly the twenty types `MONSTER_STATS` and `INERT_SHOOTABLE` cover between them.
 *
 * Read off **pristine** `MOBJ_STATES`, never the patched copy: a row's kind decides which tables it
 * derives into, so a patch that clears a monster's `painstate` must still derive as a monster
 * rather than silently becoming a decoration.
 */
function isMonsterRow(i: number): boolean {
  return MOBJ_STATES[i].pain !== 0 && MOBJ_STATES[i].death !== 0;
}

/** Every table the walker can derive, off one frame table and one set of state pointers. */
export function deriveFrameTables({ states, mobjStates, weaponStates }: PatchedStates): FrameTables {
  const tables: FrameTables = { monsters: {}, weapons: {}, sprites: {}, anims: {}, missiles: {}, barrel: null };
  for (let i = 0; i < weaponStates.length; i++) tables.weapons[i] = deriveWeapon(states, weaponStates[i]);
  for (let i = 0; i < MOBJ_INFO.length; i++) {
    const row = MOBJ_INFO[i];
    const ms = mobjStates[i];
    const sink = MISSILE_SINKS[row.type];
    if (sink) tables.missiles[sink.sprite] = deriveMissile(states, ms);
    const dn = row.doomednum;
    if (dn === -1 || NOT_DRAWN.has(dn)) continue;
    if (isMonsterRow(i)) {
      tables.monsters[dn] = deriveMonster(states, ms);
      continue;
    }
    const spawn = walkChain(states, ms.spawn);
    const sprite = spriteOf(states, spawn.indices);
    if (sprite !== undefined) tables.sprites[dn] = sprite;
    if (dn === ThingType.barrel) {
      const death = walkChain(states, ms.death);
      const loop = cycleOf(spawn);
      // `A_Explode`'s position in the chain is the blast's delay after death.
      const explodeAt = death.indices.findIndex((s) => states[s][3] === 'A_Explode');
      tables.barrel = {
        idleFrames: lettersOf(states, loop),
        idleFrameSeconds: loop.length ? flatTics(states, loop) * DOOM_TIC : HELD_FRAME_SECONDS,
        deathSprite: spriteOf(states, death.indices),
        deathFrames: distinctLetters(states, death.indices),
        explodeDelaySeconds: explodeAt >= 0 ? ticsOf(states, death.indices.slice(0, explodeAt)) * DOOM_TIC : null,
      };
      continue;
    }
    tables.anims[dn] = deriveAnim(states, spawn);
  }
  return tables;
}

let pristine: FrameTables | null = null;

/** The walker's reading of vanilla's own tables, derived once — what a patched reading is diffed against. */
export function pristineFrameTables(): FrameTables {
  return (pristine ??= deriveFrameTables({ states: STATES, mobjStates: MOBJ_STATES, weaponStates: WEAPON_STATES }));
}
