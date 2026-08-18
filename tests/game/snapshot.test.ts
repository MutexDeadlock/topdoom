import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeRuns,
  decodeSeconds,
  deserializeInventory,
  encodeRuns,
  encodeSeconds,
  roundFloat,
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
  test('the forever sentinel survives the serializer, and leaves real seconds alone', () => {
    // Through `JSON`, not around it. `JSON.stringify(Infinity)` yields `null`,
    // so a pair that encoded nothing at all would still satisfy
    // `decodeSeconds(encodeSeconds(Infinity)) === Infinity` on its own — the
    // sentinel only earns its place once the value has been through a string.
    const stored = (seconds: number): number =>
      decodeSeconds(JSON.parse(JSON.stringify(encodeSeconds(seconds))));
    assert.equal(stored(Infinity), Infinity);
    assert.equal(stored(0), 0);
    assert.equal(stored(42.5), 42.5);
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
    inv.keys.add('blueCard').add('yellowSkull');
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
    // A pre-slot save's color expands to both of its slots; unknown colors are dropped.
    assert.deepEqual([...back.keys].sort(), ['blueCard', 'blueSkull'], 'unknown key colors are dropped');
    assert.deepEqual(back.ammo, fresh.ammo);
    assert.equal(back.currentWeapon, fresh.currentWeapon);
  });

  test('a save with exact key slots restores them exactly', () => {
    const back = deserializeInventory(
      JSON.parse('{"keys": ["red"], "keySlots": ["redSkull", "bogus"]}'),
    );
    assert.deepEqual([...back.keys], ['redSkull'], 'keySlots wins over the derived colors');
  });

  test('roundFloat trims float tails to 6 decimals throughout the serialized tree', () => {
    const input = {
      angle: 0.4666666666666667,
      nested: { third: 1 / 3, sentinel: -1 },
      list: [16.099999999999998, 7, 'MAP05', true, null],
    };
    assert.deepEqual(JSON.parse(JSON.stringify(input, roundFloat)), {
      angle: 0.466667,
      nested: { third: 0.333333, sentinel: -1 },
      list: [16.1, 7, 'MAP05', true, null],
    });
    assert.equal(input.angle, 0.4666666666666667, 'the state itself is left untouched');
  });

  test('roundFloat leaves integers bit-exact, however large', () => {
    // The RNG cursors, sector heights and the -1 sentinel must pass through
    // unchanged — only fractional tails may move.
    for (const n of [0, -1, 255, -32768, 123456789]) {
      assert.equal(JSON.stringify(n, roundFloat), String(n));
    }
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
