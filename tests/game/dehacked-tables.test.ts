import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMMO_ORDER,
  MF_FLAGS,
  MISC_SINKS,
  MISSILE_SINKS,
  MOBJ_INFO,
  SFX_ORDER,
  WEAPON_ORDER,
  classifyDehackedField,
  classifyDehackedFrame,
  classifyDehackedRecord,
  classifyDehackedString,
} from '../../src/game/dehacked/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { SFX_NAMES } from '../../src/audio/sfx.ts';
import { WEAPONS } from '../../src/game/weapons.ts';
import { PROJECTILE_RADIUS } from '../../src/game/spritefx/tables.ts';

/**
 * The bridges from DEH's array indices to this engine's keys. Like the other table tests these
 * prove the transcription is **complete** and internally consistent — only `info.c`, `sounds.h`
 * and `d_deh.c` settle whether an individual entry is correct.
 * See docs/dehacked.md § Thing records.
 */
describe('Vanilla tables · the DEHACKED index bridges', () => {
  test('mobjinfo[] is all 137 of it, in mobjtype_t order', () => {
    // `NUMMOBJTYPES` in `info.h`. DEH indexes it 1-based, so `Thing 137` is the last valid one.
    assert.equal(MOBJ_INFO.length, 137);
    assert.equal(MOBJ_INFO[0].type, 'MT_PLAYER');
    assert.equal(MOBJ_INFO[136].type, 'MT_MISC86');
    assert.equal(new Set(MOBJ_INFO.map((r) => r.type)).size, 137);
  });

  test('every placeable mobjtype names a doomednum this engine already knows', () => {
    // The cross-check the `// MT_*` comments in `things/doomednums.ts` could not make on their
    // own: a doomednum here that `ThingType` doesn't carry would be a table nothing can key.
    const known = new Set<number>(Object.values(ThingType));
    const placeable = MOBJ_INFO.filter((r) => r.doomednum !== -1);
    assert.equal(placeable.length, 118);
    for (const row of placeable) {
      assert.ok(known.has(row.doomednum), `${row.type} doomednum ${row.doomednum} is not a ThingType`);
    }
  });

  test('no two mobjtypes claim the same doomednum', () => {
    const seen = new Map<number, string>();
    for (const row of MOBJ_INFO) {
      if (row.doomednum === -1) continue;
      assert.equal(seen.get(row.doomednum), undefined, `${row.type} collides with ${seen.get(row.doomednum)}`);
      seen.set(row.doomednum, row.type);
    }
  });

  test('every missile sink names a sprite the projectile tables actually key', () => {
    for (const [type, sink] of Object.entries(MISSILE_SINKS)) {
      assert.ok(
        MOBJ_INFO.some((r) => r.type === type),
        `${type} is not a mobjtype`,
      );
      assert.ok(sink.sprite in PROJECTILE_RADIUS, `${type} names sprite ${sink.sprite}, which nothing keys`);
      for (const weapon of sink.weapons ?? []) assert.ok(weapon in WEAPONS, `${weapon} is not a weapon`);
    }
    // Every sink is a missile in `info.c`, and no two share a sprite.
    for (const type of Object.keys(MISSILE_SINKS)) {
      assert.equal(MOBJ_INFO.find((r) => r.type === type)?.missile, true, `${type} is not MF_MISSILE`);
    }
    const sprites = Object.values(MISSILE_SINKS).map((s) => s.sprite);
    assert.equal(new Set(sprites).size, sprites.length);
  });

  test('no two mobjflags share a bit, so a numeric mask reads back unambiguously', () => {
    // `MF_TRANSLUCENT` was transcribed onto `MF_FRIEND`'s bit once. Since `unhonoredFlags` reads a
    // mask back through these bits, a collision would report both names for one flag.
    // Bits 28-31 of MBF's `p_mobj.h`: TOUCHY, BOUNCES, FRIEND, TRANSLUCENT.
    const bits = Object.values(MF_FLAGS).map((f) => f.bit);
    assert.equal(new Set(bits).size, bits.length);
    assert.equal(MF_FLAGS.TRANSLUCENT.bit, 0x80000000);
    assert.equal(MF_FLAGS.FRIEND.bit, 0x40000000);
  });

  test('every Misc name that classifies applied names a sink, and vice versa', () => {
    // The pair that used to be maintained separately: `BFG Cells/Shot` claimed `applied` with no
    // sink row, so it was assigned onto `LIMITS` under its raw spelling and read by nothing.
    for (const name of Object.keys(MISC_SINKS)) {
      assert.equal(classifyDehackedField('misc', name), 'applied', `${name} has a sink but does not apply`);
    }
    assert.equal(classifyDehackedField('misc', 'BFG Cells/Shot'), 'applied');
    assert.deepEqual(MISC_SINKS['bfg cells/shot'], { weapon: 'bfg', field: 'ammoPerShot' });
  });

  test('the weapon and ammo orders are permutations of what this engine has', () => {
    // `p_pspr.h`'s `weapontype_t` — note this is not `WEAPON_SLOTS` or `WEAPON_CYCLE` order.
    assert.equal(WEAPON_ORDER.length, 9);
    assert.deepEqual([...WEAPON_ORDER].sort(), Object.keys(WEAPONS).sort());
    // `doomdef.h`'s `ammotype_t`: slot 2 is cells and slot 3 is rockets.
    assert.deepEqual(AMMO_ORDER, ['bullets', 'shells', 'cells', 'rockets']);
  });

  test('the sfx order is S_sfx[] with sfx_None at slot 0', () => {
    // `SFX_ORDER` is derived from `SFX`, which means `SFX`'s declaration order *is* `sfxenum_t`
    // order — the assumption that derivation rests on. These pins are what catches a reorder.
    assert.equal(SFX_ORDER.length, 109); // NUMSFX
    assert.equal(SFX_ORDER[0], null);
    assert.equal(SFX_ORDER[1], 'pistol'); // sfx_pistol
    assert.equal(SFX_ORDER[2], 'shotgn');
    assert.equal(SFX_ORDER[108], 'radio'); // the last of them
    assert.equal(new Set(SFX_ORDER.slice(1)).size, SFX_NAMES.length);
  });

  test('every mobjflag is a distinct single bit, bar the one that is a field', () => {
    const bits = new Map<number, string>();
    for (const [name, row] of Object.entries(MF_FLAGS)) {
      // `TRANSLATION` is `0xc000000`, a two-bit player-colour field rather than a flag.
      if (name === 'TRANSLATION') continue;
      assert.equal(row.bit & (row.bit - 1), 0, `${name} is not a single bit`);
      const clash = bits.get(row.bit);
      // Boom reuses 0x40000000 for both TRANSLUCENT and FRIEND across its own revisions.
      if (clash) assert.ok(['TRANSLUCENT', 'FRIEND'].includes(name), `${name} collides with ${clash}`);
      bits.set(row.bit, name);
    }
  });
});

/** The classifiers the coverage report speaks through. docs/dehacked.md § The coverage report. */
describe('DEHACKED · classification', () => {
  test('the record kinds split into what applies, what has no home, and what is out of scope', () => {
    assert.equal(classifyDehackedRecord('Thing').support, 'applied');
    assert.equal(classifyDehackedRecord('[PARS]').support, 'applied');
    assert.equal(classifyDehackedRecord('[STRINGS]').support, 'applied');
    assert.equal(classifyDehackedRecord('Frame').support, 'applied');
    assert.equal(classifyDehackedRecord('[SPRITES]').support, 'applied');
    // Both action-pointer spellings are read; how far one gets is per action, not per record.
    assert.equal(classifyDehackedRecord('Pointer').support, 'applied');
    assert.equal(classifyDehackedRecord('[CODEPTR]').support, 'applied');
    // The numeric records move a pointer into the exe's string table.
    assert.equal(classifyDehackedRecord('Sound').support, 'noTarget');
    assert.equal(classifyDehackedRecord('Sprite').support, 'noTarget');
    // The negative case: something the format has no such record for at all.
    assert.equal(classifyDehackedRecord('Wobble').support, 'unknown');
  });

  test('a Frame record classifies by the state it names', () => {
    assert.equal(classifyDehackedFrame(185), 'applied'); // S_POSS_ATK2, a world state
    assert.equal(classifyDehackedFrame(0), 'applied'); // S_NULL is a state like any other
    // A fire-chain state is the weapon's rate and applies; every other psprite state — a flash, or
    // the bob/raise/lower a first-person view would draw — has nothing here to land on.
    assert.equal(classifyDehackedFrame(13), 'applied'); // S_PISTOL1, the fire chain's first state
    assert.equal(classifyDehackedFrame(16), 'applied'); // S_PISTOL4, its closing A_ReFire
    assert.equal(classifyDehackedFrame(47), 'noTarget'); // S_DSGUNFLASH1
    assert.equal(classifyDehackedFrame(1), 'noTarget'); // S_LIGHTDONE
    assert.equal(classifyDehackedFrame(2), 'noTarget'); // S_PUNCH, the fist's bob
    assert.equal(classifyDehackedFrame(12), 'noTarget'); // S_PISTOLUP, the raise chain
    // MBF's own appended states are world data here: `S_OLDBFG1` draws `SPR_BFGG` but sits in no
    // `weaponinfo[]` chain, which is why patches use that range as scratch space.
    assert.equal(classifyDehackedFrame(967), 'applied'); // S_TNT1
    assert.equal(classifyDehackedFrame(999), 'applied'); // S_OLDBFG1
    assert.equal(classifyDehackedFrame(1075), 'applied'); // S_MUSHROOM, the last MBF row
    // Past the table — unless the patch's own records grew it that far.
    assert.equal(classifyDehackedFrame(1076), 'unknown');
    assert.equal(classifyDehackedFrame(1733), 'unknown');
    assert.equal(classifyDehackedFrame(1733, 4304), 'applied');
    assert.equal(classifyDehackedFrame(-1), 'unknown');
    // The fields inside one.
    assert.equal(classifyDehackedField('frame', 'Sprite subnumber'), 'applied');
    assert.equal(classifyDehackedField('frame', 'Duration'), 'applied');
    assert.equal(classifyDehackedField('frame', 'Next frame'), 'applied');
    assert.equal(classifyDehackedField('frame', 'Unknown 1'), 'applied'); // MBF's `misc1`
    assert.equal(classifyDehackedField('frame', 'Unknown 2'), 'applied');
    assert.equal(classifyDehackedField('frame', 'Wobble'), 'unknown');
  });

  test('a Thing field classifies against its target, not by name alone', () => {
    const imp = MOBJ_INFO[11]; // MT_TROOP
    const puff = MOBJ_INFO.find((r) => r.type === 'MT_PUFF')!;
    const fireball = MOBJ_INFO.find((r) => r.type === 'MT_TROOPSHOT')!;
    assert.equal(classifyDehackedField('thing', 'Speed', imp), 'applied');
    // Sprite-keyed, so it has a sink even with no doomednum of its own.
    assert.equal(classifyDehackedField('thing', 'Speed', fireball), 'applied');
    // No doomednum and no sprite sink: nothing here keys it.
    assert.equal(classifyDehackedField('thing', 'Speed', puff), 'noTarget');
    // The frame pointers apply on anything with a table row — and a puff has none to repoint.
    assert.equal(classifyDehackedField('thing', 'Death frame', imp), 'applied');
    assert.equal(classifyDehackedField('thing', 'Death frame', puff), 'noTarget');
    assert.equal(classifyDehackedField('thing', 'Reaction time', imp), 'unsupported');
    assert.equal(classifyDehackedField('thing', 'Wobbliness', imp), 'unknown');
  });

  test('a Weapon record reaches every field vanilla stores, which is six', () => {
    // `d_deh.c`'s `deh_weapon[]` is an ammo type and five state pointers — no damage, no rate,
    // because a weapon's rate *is* the durations of the chain `Shooting frame` points at.
    assert.equal(classifyDehackedField('weapon', 'Ammo type'), 'applied');
    assert.equal(classifyDehackedField('weapon', 'Shooting frame'), 'applied');
    assert.equal(classifyDehackedField('weapon', 'Deselect frame'), 'applied');
    assert.equal(classifyDehackedField('weapon', 'Firing frame'), 'applied');
    assert.equal(classifyDehackedField('weapon', 'Damage'), 'unknown');
  });

  test('string mnemonics classify by prefix, longest first', () => {
    assert.equal(classifyDehackedString('HUSTR_1'), 'applied');
    assert.equal(classifyDehackedString('HUSTR_E1M1'), 'applied');
    assert.equal(classifyDehackedString('PHUSTR_5'), 'applied');
    // `HUSTR_PLRRED` must not be swept up by the `HUSTR_` title rule.
    assert.equal(classifyDehackedString('HUSTR_PLRRED'), 'noTarget');
    assert.equal(classifyDehackedString('GOTARMOR'), 'noTarget');
    assert.equal(classifyDehackedString('E1TEXT'), 'noTarget');
    // A mnemonic with a sink is a whole key and applies; the rest of its family falls to the
    // prefix row, which is what marks it recognised-and-homeless so nothing reports it.
    assert.equal(classifyDehackedString('OB_IMP'), 'applied');
    assert.equal(classifyDehackedString('OB_MPFIST'), 'noTarget');
    assert.equal(classifyDehackedString('PD_BLUEK'), 'applied');
    assert.equal(classifyDehackedString('PD_GREENK'), 'noTarget');
    // The one shortfall still worth reporting: not recognised at all.
    assert.equal(classifyDehackedString('WOBBLE'), 'unknown');
  });
});
