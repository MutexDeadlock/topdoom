import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeRuns,
  decodeSeconds,
  deserializeInventory,
  encodeRuns,
  encodeSeconds,
  serializeInventory,
} from '../../src/game/snapshot.ts';
import { createInventory } from '../../src/game/inventory.ts';
import { clearRandom, getRandomCursors, pRandom, mRandom, setRandomCursors } from '../../src/util/random.ts';

/**
 * The savegame payload's encoding corners: everything JSON quietly mangles has
 * an explicit encoding here, and these tests pin both the round-trip and the
 * mangling it exists to avoid. See docs/savegames.md § The format and its version.
 */
describe('Savegames · state encoding', () => {
  test('JSON drops Infinity — the reason the sentinel exists', () => {
    // Not our code: the platform behavior the -1 sentinel guards against.
    assert.equal(JSON.parse(JSON.stringify({ v: Infinity })).v, null);
  });

  test('the forever sentinel round-trips and leaves real seconds alone', () => {
    assert.equal(decodeSeconds(encodeSeconds(Infinity)), Infinity);
    assert.equal(decodeSeconds(encodeSeconds(0)), 0);
    assert.equal(decodeSeconds(encodeSeconds(42.5)), 42.5);
  });

  test('run-length encoding round-trips typical fog bitmaps', () => {
    const cases = [
      new Uint8Array(0),
      new Uint8Array([0, 0, 0]),
      new Uint8Array([1, 1, 1]),
      new Uint8Array([0, 1, 0, 1, 1, 0, 0, 0, 1]),
      new Uint8Array([1]),
      new Uint8Array([0]),
    ];
    for (const data of cases) {
      const runs = encodeRuns(data);
      assert.deepEqual([...decodeRuns(runs, data.length)], [...data], `bitmap [${data}]`);
    }
  });

  test('a bitmap starting explored encodes with an explicit empty zero-run', () => {
    assert.deepEqual(encodeRuns(new Uint8Array([1, 1])), [0, 2]);
  });

  test('decoding clamps runs that overrun the declared length', () => {
    assert.deepEqual([...decodeRuns([1, 500], 3)], [0, 1, 1]);
  });

  test('the inventory round-trips through JSON, Sets and Infinity included', () => {
    const inv = createInventory();
    inv.health = 61;
    inv.armor = 148;
    inv.armorType = 2;
    inv.ammo.shells = 23;
    inv.keys.add('blue').add('yellow');
    inv.weapons.add('shotgun').add('bfg');
    inv.currentWeapon = 'shotgun';
    inv.powers.berserk = Infinity;
    inv.powers.invisibility = 12.25;
    inv.backpack = true;

    const back = deserializeInventory(JSON.parse(JSON.stringify(serializeInventory(inv))));
    assert.deepEqual(back, inv);
  });

  test('a snapshot missing fields degrades to new-game defaults, not undefined', () => {
    const fresh = createInventory();
    const back = deserializeInventory(JSON.parse('{"health": "broken", "keys": ["blue", "purple"]}'));
    assert.equal(back.health, fresh.health);
    assert.deepEqual([...back.keys], ['blue'], 'unknown key colors are dropped');
    assert.deepEqual(back.ammo, fresh.ammo);
    assert.equal(back.currentWeapon, fresh.currentWeapon);
  });

  test('the random cursors save and restore exactly', () => {
    clearRandom();
    for (let i = 0; i < 7; i++) pRandom();
    for (let i = 0; i < 3; i++) mRandom();
    const cursors = getRandomCursors();
    const next = pRandom();

    clearRandom();
    setRandomCursors(cursors);
    assert.equal(pRandom(), next, 'the play cursor resumes on the same table entry');
    assert.deepEqual(getRandomCursors(), { p: cursors.p + 1, m: cursors.m });
    clearRandom();
  });
});
