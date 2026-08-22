import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  actionRole,
  classifyDehackedPointer,
  lookupAction,
} from '../../src/game/dehacked/actions.ts';
import { chainKindsOf } from '../../src/game/dehacked/frames.ts';
import { ATTACK_ACTION_SOURCES } from '../../src/game/dehacked/tables.ts';
import { STATES } from '../../src/game/dehacked/states.ts';

/**
 * `d_deh.c`'s `deh_bexptrs[]` in its own order, transcribed by hand from MBF's source — the
 * independent second reading `ACTIONS` is checked against, the way `tests/fixtures/frametables.ts`
 * anchors the frame walker. Every name a patch can write is here and nowhere else is authoritative.
 */
const DEH_BEXPTRS = [
  'A_Light0', 'A_WeaponReady', 'A_Lower', 'A_Raise', 'A_Punch', 'A_ReFire',
  'A_FirePistol', 'A_Light1', 'A_FireShotgun', 'A_Light2', 'A_FireShotgun2', 'A_CheckReload',
  'A_OpenShotgun2', 'A_LoadShotgun2', 'A_CloseShotgun2', 'A_FireCGun', 'A_GunFlash', 'A_FireMissile',
  'A_Saw', 'A_FirePlasma', 'A_BFGsound', 'A_FireBFG', 'A_BFGSpray', 'A_Explode',
  'A_Pain', 'A_PlayerScream', 'A_Fall', 'A_XScream', 'A_Look', 'A_Chase',
  'A_FaceTarget', 'A_PosAttack', 'A_Scream', 'A_SPosAttack', 'A_VileChase', 'A_VileStart',
  'A_VileTarget', 'A_VileAttack', 'A_StartFire', 'A_Fire', 'A_FireCrackle', 'A_Tracer',
  'A_SkelWhoosh', 'A_SkelFist', 'A_SkelMissile', 'A_FatRaise', 'A_FatAttack1', 'A_FatAttack2',
  'A_FatAttack3', 'A_BossDeath', 'A_CPosAttack', 'A_CPosRefire', 'A_TroopAttack', 'A_SargAttack',
  'A_HeadAttack', 'A_BruisAttack', 'A_SkullAttack', 'A_Metal', 'A_SpidRefire', 'A_BabyMetal',
  'A_BspiAttack', 'A_Hoof', 'A_CyberAttack', 'A_PainAttack', 'A_PainDie', 'A_KeenDie',
  'A_BrainPain', 'A_BrainScream', 'A_BrainDie', 'A_BrainAwake', 'A_BrainSpit', 'A_SpawnSound',
  'A_SpawnFly', 'A_BrainExplode',
  // MBF's own ten, the whole of what it added to the format (killough 7/98–10/98).
  'A_Detonate', 'A_Mushroom', 'A_Die', 'A_Spawn', 'A_Turn', 'A_Face',
  'A_Scratch', 'A_PlaySound', 'A_RandomJump', 'A_LineEffect',
];

/** The action table a repoint is read and classified through. docs/dehacked.md § Action pointers. */
describe('DEHACKED · action pointers', () => {
  test('the table is exactly deh_bexptrs[], plus the A_NULL that terminates it', () => {
    for (const name of DEH_BEXPTRS) {
      assert.equal(ACTIONS.get(name.toLowerCase())?.name, name, `${name} is missing`);
    }
    assert.equal(ACTIONS.size, DEH_BEXPTRS.length + 1);
    assert.equal(ACTIONS.get('a_null')?.name, 'A_NULL');
  });

  test('a row is either a sink or a reason it is not, never both and never neither', () => {
    for (const row of ACTIONS.values()) {
      if (row.name === 'A_NULL') continue;
      assert.equal(row.role === 'none', row.miss !== undefined, `${row.name} says both or neither`);
    }
  });

  test('every action vanilla actually uses in states[] is one the table knows', () => {
    for (const [, , , action] of STATES) {
      if (action !== '') assert.ok(ACTIONS.has(action.toLowerCase()), `states[] uses ${action}`);
    }
  });

  test('a mnemonic reads with or without its A_ prefix, and A_NULL is the cleared action', () => {
    assert.equal(lookupAction('A_Chase'), 'A_Chase');
    assert.equal(lookupAction('chase'), 'A_Chase');
    assert.equal(lookupAction('A_NULL'), '');
    assert.equal(lookupAction('A_Wobble'), undefined);
  });

  test('the five roles are what the walker reads, and nothing else claims one', () => {
    assert.equal(actionRole('A_Chase'), 'chase');
    assert.equal(actionRole('A_CPosAttack'), 'firing');
    assert.equal(actionRole('A_FireBFG'), 'weaponFire');
    assert.equal(actionRole('A_SpidRefire'), 'refire');
    assert.equal(actionRole('A_PlaySound'), 'sound');
    assert.equal(actionRole('A_Spawn'), 'drop');
    // A wind-up, a death cry and MBF's own branching jump are read by nothing.
    assert.equal(actionRole('A_FaceTarget'), 'none');
    assert.equal(actionRole('A_Scream'), 'none');
    assert.equal(actionRole('A_RandomJump'), 'none');
  });

  test('an edit is classified, not an action: a restatement says nothing at all', () => {
    assert.equal(classifyDehackedPointer('A_Chase', 'A_Chase'), null);
    // Either side carrying a role is a change to a derived table.
    assert.equal(classifyDehackedPointer('A_Chase', 'A_Scream')?.support, 'applied');
    assert.equal(classifyDehackedPointer('', 'A_Chase')?.support, 'applied');
    assert.equal(classifyDehackedPointer('A_Scream', 'A_Pain')?.support, 'noTarget');
    assert.equal(classifyDehackedPointer('A_Scream', 'A_RandomJump')?.support, 'unsupported');
    assert.equal(classifyDehackedPointer('A_Scream', 'A_LineEffect')?.support, 'unsupported');
    assert.equal(classifyDehackedPointer('A_Scream', 'A_Wobble')?.support, 'unknown');
  });

  test('a chain-scoped action lands only from the chains that have a sink for it', () => {
    // 492 is S_SARG_DIE3, a death chain: `A_Spawn` there is what `MONSTER_DROPS` models.
    assert.deepEqual(chainKindsOf(492), ['death']);
    assert.equal(classifyDehackedPointer('', 'A_Spawn', chainKindsOf(492))?.support, 'applied');
    // 486 is S_SARG_ATK2, a melee chain — no drop table reaches it, and the row says which would.
    const missed = classifyDehackedPointer('', 'A_Spawn', chainKindsOf(486))!;
    assert.equal(missed.support, 'noTarget');
    assert.match(missed.detail, /death\/xdeath chain/);
  });

  test('every firing action names the type whose attack a repoint of it copies', () => {
    // `ATTACK_ACTION_SOURCES` is what `attackFor` reads a repointed chain's roll and projectile
    // through, and a firing action missing from it falls through silently — leaving the chain
    // firing whatever it fired before. The two lists are one list, so they are checked as one.
    const firing = [...ACTIONS.values()].filter((row) => row.role === 'firing').map((row) => row.name);
    // `A_Scratch` is MBF's own and belongs to no type: it deals its `misc1` flat, built from the
    // state rather than borrowed (docs/dehacked.md § What MBF's ten reach).
    assert.deepEqual(
      firing.filter((name) => name !== 'A_Scratch').sort(),
      Object.keys(ATTACK_ACTION_SOURCES).sort(),
    );
  });

  test('a state in two chains at once belongs to both', () => {
    // The imp swings and throws from one chain: `S_TROO_ATK3` is its melee *and* its missile state.
    assert.deepEqual(chainKindsOf(454).slice().sort(), ['melee', 'missile']);
  });
});
