/**
 * Vanilla's and MBF's action pointers as data: which `A_*` name a patch may write, what the frame
 * walker does with each when it meets one in a chain, and how far a repoint of one gets here.
 * Pure, and read-side like `states.ts` — its one import is a type — so both `frames.ts` (which
 * reads the roles) and the parser (which reads the verdicts) can take it without a cycle. See
 * docs/dehacked.md § Action pointers.
 */
import type { DehSupport, StatePointer } from './defs.ts';

/**
 * What the frame walker does with an action when it meets one in a chain — the whole of how an
 * action reaches this engine, since nothing steps `states[]` at runtime (docs/dehacked.md
 * § Frames). `'none'` is not "does nothing in DOOM": it is "nothing the walker derives reads it".
 */
export type ActionRole = 'chase' | 'firing' | 'weaponFire' | 'refire' | 'sound' | 'drop' | 'none';

/**
 * One of the eight chains a `mobjinfo` row points at — `defs.ts`'s `StatePointer` under the name
 * this file's rules read in, and one union so a chain added later is added once. A few actions only
 * reach a sink from certain chains — `A_PlaySound` is a chain's sound, `A_Spawn` in a death chain
 * is what this engine has a drop table for — so a repoint onto a state outside them lands nowhere,
 * and the report says which chains it would have needed. `frames.ts: chainKindsOf` answers it for a
 * state.
 */
export type ChainKind = StatePointer;

/**
 * Why a repoint of a `'none'` action doesn't land, in the terms the report speaks. Grouped rather
 * than written per action so the table below stays a list of names: the reason is the same for
 * every member of a group, and `MISS_DETAIL` says it once.
 */
type ActionMiss = 'psprite' | 'perType' | 'branch' | 'chainClock' | 'explode' | 'lineEffect' | 'beta';

/** One sentence for the report, naming where the behavior lives here instead. */
const MISS_DETAIL: Record<ActionMiss, string> = {
  psprite: 'animates the first-person weapon, which this engine does not draw',
  perType: 'is a per-type property here (a sound, a flag, a boss trigger), not something a state carries',
  branch: 'branches the chain; the walker reads a chain as one linear run and nothing steps states at runtime',
  chainClock: 'fires at a point in a chain, and nothing steps states here to reach that point',
  explode: 'would explode a thing on death; the barrel is the only type this engine explodes, off its own chain',
  lineEffect: 'triggers a tagged linedef effect from a state, which nothing here dispatches',
  beta: 'runs MBF\'s beta content, which no patch can name and nothing here has',
};

/**
 * `d_deh.c`'s `deh_bexptrs[]`, in its own order, grouped by the role the walker gives each. Every
 * name a patch can write is here: vanilla's, plus MBF's own ten (`A_Detonate` through
 * `A_LineEffect`), which are the whole of what MBF added to the format.
 */
const BY_ROLE: Record<Exclude<ActionRole, 'none'>, readonly string[]> = {
  // `p_pspr.c`'s nine that spend the ammo and put the shot out — how many a fire chain carries is
  // how many shots one pass makes (docs/weapons.md § Fire rates).
  weaponFire: [
    'A_Punch', 'A_FirePistol', 'A_FireShotgun', 'A_FireShotgun2', 'A_FireCGun', 'A_FireMissile',
    'A_Saw', 'A_FirePlasma', 'A_FireBFG',
  ],
  // `p_enemy.c`'s actions that deal the damage or launch the missile, as opposed to the
  // `A_FaceTarget`/`A_VileStart`/`A_FatRaise` wind-up states around them.
  firing: [
    'A_PosAttack', 'A_SPosAttack', 'A_VileAttack', 'A_SkelFist', 'A_SkelMissile', 'A_FatAttack1',
    'A_FatAttack2', 'A_FatAttack3', 'A_CPosAttack', 'A_TroopAttack', 'A_SargAttack', 'A_HeadAttack',
    'A_BruisAttack', 'A_SkullAttack', 'A_BspiAttack', 'A_CyberAttack', 'A_PainAttack', 'A_Scratch',
  ],
  // `A_Chase` itself and the three footstep wrappers that play a sound and then call it, plus
  // `A_VileChase`, which is `A_Chase` with a corpse search in front.
  chase: ['A_Chase', 'A_VileChase', 'A_Metal', 'A_BabyMetal', 'A_Hoof'],
  // A loop through one of these repeats without a fresh chase call, which is what `spanOf` measures
  // an attack over.
  refire: ['A_CPosRefire', 'A_SpidRefire'],
  // MBF's `A_PlaySound`, whose `misc1` sound becomes the sound of whichever chain it sits in.
  sound: ['A_PlaySound'],
  // MBF's `A_Spawn` in a death chain: what a monster leaves behind, which is `MONSTER_DROPS`.
  drop: ['A_Spawn'],
};

/** The rest of `deh_bexptrs[]`: names the walker reads nothing from, by why a repoint misses. */
const BY_MISS: Record<ActionMiss, readonly string[]> = {
  psprite: [
    'A_Light0', 'A_WeaponReady', 'A_Lower', 'A_Raise', 'A_ReFire', 'A_Light1', 'A_Light2',
    'A_CheckReload', 'A_OpenShotgun2', 'A_LoadShotgun2', 'A_CloseShotgun2', 'A_GunFlash',
    'A_BFGsound',
  ],
  perType: [
    'A_BFGSpray', 'A_Pain', 'A_PlayerScream', 'A_Fall', 'A_XScream', 'A_Look', 'A_FaceTarget',
    'A_Scream', 'A_VileStart', 'A_VileTarget', 'A_StartFire', 'A_Fire', 'A_FireCrackle', 'A_Tracer',
    'A_SkelWhoosh', 'A_FatRaise', 'A_BossDeath', 'A_PainDie', 'A_KeenDie', 'A_BrainPain',
    'A_BrainScream', 'A_BrainDie', 'A_BrainAwake', 'A_BrainSpit', 'A_SpawnSound', 'A_SpawnFly',
    'A_BrainExplode', 'A_Turn', 'A_Face',
  ],
  branch: ['A_RandomJump'],
  // `A_Explode` still moves the barrel's blast delay where it sits in *that* chain, which the
  // walker reads by position (`deriveFrameTables`); no other type explodes here, so a repoint onto
  // one lands nowhere. MBF's two variants have no sink at all.
  explode: ['A_Explode', 'A_Detonate', 'A_Mushroom'],
  chainClock: ['A_Die'],
  lineEffect: ['A_LineEffect'],
  // The three MBF functions **outside** `deh_bexptrs[]`: the beta BFG's fire, the beta lost soul's
  // charge and the halt that ends its death. No patch can name one, and they are here only because
  // the states MBF appended carry them — a repoint of one of those rows reads its pristine action
  // from this table and a report needs a name for it. docs/dehacked.md § Extended states.
  beta: ['A_FireOldBFG', 'A_BetaSkullAttack', 'A_Stop'],
};

/**
 * One action pointer: what the walker reads it as, and why a repoint of it misses where it does.
 */
export interface ActionRow {
  /** `d_deh.c`'s own spelling, which is what a report prints. */
  name: string;
  role: ActionRole;
  /** Absent exactly where `role` is not `'none'` — a role *is* a sink. */
  miss?: ActionMiss;
  /** The chains this action reaches a sink from; absent where every chain reads it the same. */
  chains?: readonly ChainKind[];
  /** Set for the `UNNAMEABLE` actions: no `[CODEPTR]` mnemonic resolves to one. */
  unnameable?: true;
}

/**
 * The two actions whose sink depends on which chain they land in. `A_PlaySound` becomes that
 * chain's own sound, and there is no sink for a walk loop's or a spawn loop's; `A_Spawn` in a death
 * chain is what `MONSTER_DROPS` already models, and anywhere else it would need a state clock.
 */
const CHAIN_SCOPED: Record<string, readonly ChainKind[]> = {
  A_PlaySound: ['melee', 'missile', 'pain', 'death', 'xdeath'],
  A_Spawn: ['death', 'xdeath'],
};

/**
 * The actions `deh_bexptrs[]` does not list, so no `[CODEPTR]` mnemonic resolves to one. MBF's
 * three beta functions, which reach here only as a state's pristine action — a separate fact from
 * why the walker reads nothing from them, which is what `BY_MISS` answers.
 */
const UNNAMEABLE: ReadonlySet<string> = new Set(['A_FireOldBFG', 'A_BetaSkullAttack', 'A_Stop']);

/**
 * Every `deh_bexptrs[]` name, keyed lowercase, plus MBF's three beta functions that are not in that
 * array but do occupy states — `lookupAction` is what holds the difference. `A_NULL` is the list's
 * own terminator: an action cleared.
 */
export const ACTIONS: ReadonlyMap<string, ActionRow> = new Map([
  ...Object.entries(BY_ROLE).flatMap(([role, names]) =>
    names.map((name): [string, ActionRow] => [
      name.toLowerCase(),
      { name, role: role as ActionRole, ...(CHAIN_SCOPED[name] ? { chains: CHAIN_SCOPED[name] } : {}) },
    ]),
  ),
  ...Object.entries(BY_MISS).flatMap(([miss, names]) =>
    names.map((name): [string, ActionRow] => [
      name.toLowerCase(),
      { name, role: 'none', miss: miss as ActionMiss, ...(UNNAMEABLE.has(name) ? { unnameable: true } : {}) },
    ]),
  ),
  ['a_null', { name: 'A_NULL', role: 'none' } as ActionRow],
]);

/**
 * The action `NULL` is written as, in the states table and in an edit — `deh_bexptrs[]`'s `A_NULL`.
 */
export const NO_ACTION = '';

/**
 * The canonical name a `[CODEPTR]` mnemonic names, or undefined for one no engine has.
 * `deh_procBexCodePointers` prefixes `A_` before looking a mnemonic up, so both spellings are
 * legal.
 */
export function lookupAction(mnemonic: string): string | undefined {
  const key = mnemonic.trim().toLowerCase();
  const row = ACTIONS.get(key) ?? ACTIONS.get(`a_${key}`);
  if (!row || row.unnameable) return undefined;
  return row.name === 'A_NULL' ? NO_ACTION : row.name;
}

/** What the walker derives from this action, `'none'` for one it reads nothing from. */
export function actionRole(action: string): ActionRole {
  return ACTIONS.get(action.toLowerCase())?.role ?? 'none';
}

/**
 * How far one repoint gets: `from` is the state's pristine action, `to` what the patch asks for.
 *
 * **The edit is classified, not the action.** An edit either side of which the walker reads lands,
 * because the derived tables change — that covers clearing an `A_Chase` as well as adding one. A
 * repoint between two actions it reads nothing from cannot, and reports under the target's own
 * reason. `null` is a patch restating the action a state already has, which is not a shortfall at
 * all: several real patches write whole `[CODEPTR]` blocks that way.
 */
export function classifyDehackedPointer(
  from: string,
  to: string,
  chains: readonly ChainKind[] = [],
): { support: DehSupport; detail: string } | null {
  if (from === to) return null;
  const source = ACTIONS.get(from.toLowerCase() || 'a_null');
  const target = ACTIONS.get(to.toLowerCase() || 'a_null');
  if (reaches(source, chains) || reaches(target, chains)) return { support: 'applied', detail: '' };
  if (!target) return { support: 'unknown', detail: `\`${to}\` is not an action pointer` };
  // Clearing an action says nothing about `A_NULL` and everything about what was removed, so the
  // row is reported under the action that *went* — which is also the one with a reason to give.
  const row = target.name === 'A_NULL' ? source : target;
  const name = row?.name ?? target.name;
  const miss = row?.miss;
  if (!miss) {
    // A role the state's chains don't reach: the action is known and has a sink, just not one from
    // here. Naming the chains is the part a patch author can act on.
    const needs = row?.chains?.join('/');
    return needs === undefined
      ? { support: 'noTarget', detail: `\`${name}\` has no sink here` }
      : { support: 'noTarget', detail: `\`${name}\` reaches a sink only from a ${needs} chain` };
  }
  return {
    support: miss === 'branch' || miss === 'lineEffect' ? 'unsupported' : 'noTarget',
    detail: `\`${name}\` ${MISS_DETAIL[miss]}`,
  };
}

/** Whether this action reaches a sink on a state belonging to these chains. */
function reaches(row: ActionRow | undefined, chains: readonly ChainKind[]): boolean {
  if (!row || row.role === 'none') return false;
  return row.chains === undefined || row.chains.some((kind) => chains.includes(kind));
}
