import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rollDamage, triangularDraw, triangularSpread } from '../../src/game/weapons.ts';
import { clearRandom, pRandom, RNDTABLE } from '../../src/util/random.ts';

/**
 * Vanilla's two random shapes, which every damage roll and every aim fuzz in
 * the game bottoms out in: `((P_Random() % sides) + 1) * mult` and
 * `P_Random() - P_Random()`. Both now draw off the real table, so the expected
 * values here are exact rather than bounds. See docs/random.md § The triangular draw.
 */

describe('Game rules · damage dice', () => {
  test("rollDamage is vanilla's ((P_Random() % sides) + 1) * multiplier", () => {
    clearRandom();
    // The shotgun's own dice: 3 x (1..5), against the table's first three draws
    // (8, 109, 220 — entries 1..3, since vanilla pre-increments).
    assert.equal(rollDamage(5, 3), ((8 % 5) + 1) * 3);
    assert.equal(rollDamage(5, 3), ((109 % 5) + 1) * 3);
    assert.equal(rollDamage(5, 3), ((220 % 5) + 1) * 3);
  });

  test('rollDamage treats 0 sides as always 0, without drawing', () => {
    clearRandom();
    // Monsters with no melee (or no ranged) attack carry 0 sides rather than a
    // null entry, so this branch is on the live fire path. It must also not
    // consume a draw: an unarmed monster ticking would otherwise shift every
    // other roll in the level.
    assert.equal(rollDamage(0, 3), 0);
    assert.equal(rollDamage(0, 100), 0);
    assert.equal(rollDamage(5, 3), ((8 % 5) + 1) * 3, 'the cursor never moved');
  });

  test('rollDamage never leaves [multiplier, sides * multiplier]', () => {
    // One full cycle of the table is now every value the roll can ever take —
    // a closed set, not a sample.
    clearRandom();
    const seen = new Set<number>();
    for (let i = 0; i < RNDTABLE.length; i++) seen.add(rollDamage(5, 3));
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [3, 6, 9, 12, 15],
      'every multiple of the multiplier, and nothing outside the range',
    );

    // The imp/player fist shape, 1-10 unmultiplied.
    clearRandom();
    const fist = new Set<number>();
    for (let i = 0; i < RNDTABLE.length; i++) fist.add(rollDamage(10, 1));
    assert.equal(fist.size, 10);
    assert.equal(Math.min(...fist), 1);
    assert.equal(Math.max(...fist), 10);
  });
});

describe('Game rules · triangular spread', () => {
  test('triangularDraw is P_Random() - P_Random(), centred on zero', () => {
    clearRandom();
    // Two *consecutive* table entries subtracted — 8 and 109 — scaled so that
    // `width` is the value at vanilla's ±255 extreme.
    assert.equal(triangularDraw(255), 8 - 109, 'first draw minus second');
    assert.equal(triangularDraw(255), 220 - 222, 'and on to the next pair');

    // The distribution is symmetric about 0, which is what makes it a *spread*
    // rather than a bias — an off-centre draw would pull every shotgun blast to
    // one side. Taken over every starting position of the cursor the sum
    // telescopes to exactly zero, so this is an identity and not a sample.
    //
    // Note it has to be measured that way round: draws taken in *lockstep
    // pairs* from a clear sit on alternating table parities forever, which does
    // carry a small nonzero mean. docs/random.md § The triangular draw.
    let sum = 0;
    let max = 0;
    for (let offset = 0; offset < RNDTABLE.length; offset++) {
      clearRandom();
      for (let i = 0; i < offset; i++) pRandom();
      const d = triangularDraw(10);
      sum += d;
      max = Math.max(max, Math.abs(d));
    }
    assert.ok(Math.abs(sum) < 1e-9, `sum over all cursor positions was ${sum}, should be zero`);
    assert.ok(max <= 10, 'and never exceed the full width');
    assert.ok(max > 9, 'while still reaching near it');
  });

  test('triangularSpread is the same draw, in radians', () => {
    clearRandom();
    // The shotgun's 5.6 degrees of horizontal spread.
    assert.equal(triangularSpread(5.6), (((8 - 109) / 255) * 5.6 * Math.PI) / 180);
  });

  test('never lands on exactly zero, because the table has no adjacent ties', () => {
    // A property of `rndtable` itself: no entry equals the next one, wrap
    // included. So vanilla's `P_Random()-P_Random()` cannot come out 0 and every
    // pellet is thrown at least slightly off-aim — a real-uniform generator
    // would occasionally fire dead centre. docs/random.md § The triangular draw.
    clearRandom();
    for (let i = 0; i < RNDTABLE.length; i++) {
      assert.notEqual(triangularDraw(255), 0, `pair starting at cursor ${i * 2}`);
    }
  });
});
