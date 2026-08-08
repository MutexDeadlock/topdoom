import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rollDamage, triangularDraw, triangularSpread } from '../../src/game/weapons.ts';
import { scriptedRandom, seededRandom } from '../fixtures/rng.ts';

/**
 * Vanilla's two random shapes, which every damage roll and every aim fuzz in
 * the game bottoms out in: `((P_Random() % sides) + 1) * mult` and
 * `P_Random() - P_Random()`. See docs/combat.md § Fire rates.
 */

describe('Game rules · damage dice', () => {
  test("rollDamage is vanilla's ((rand % sides) + 1) * multiplier", (t) => {
    t.mock.method(Math, 'random', scriptedRandom([0, 0.5, 0.999999]));
    // The shotgun's own dice: 3 x (1..5).
    assert.equal(rollDamage(5, 3), 3, 'lowest roll is the multiplier, never 0');
    assert.equal(rollDamage(5, 3), 9);
    assert.equal(rollDamage(5, 3), 15, 'highest roll is sides * multiplier');
  });

  test('rollDamage treats 0 sides as always 0', (t) => {
    t.mock.method(Math, 'random', scriptedRandom([0, 0.5, 0.999999]));
    // Monsters with no melee (or no ranged) attack carry 0 sides rather than a
    // null entry, so this branch is on the live fire path.
    assert.equal(rollDamage(0, 3), 0);
    assert.equal(rollDamage(0, 3), 0);
    assert.equal(rollDamage(0, 100), 0);
  });

  test('rollDamage never leaves [multiplier, sides * multiplier]', (t) => {
    t.mock.method(Math, 'random', seededRandom(0xd00d));
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) seen.add(rollDamage(5, 3));
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [3, 6, 9, 12, 15],
      'every multiple of the multiplier, and nothing outside the range',
    );

    // The imp/player fist shape, 1-10 unmultiplied.
    const fist = new Set<number>();
    for (let i = 0; i < 20_000; i++) fist.add(rollDamage(10, 1));
    assert.equal(fist.size, 10);
    assert.equal(Math.min(...fist), 1);
    assert.equal(Math.max(...fist), 10);
  });
});

describe('Game rules · triangular spread', () => {
  test('triangularDraw is P_Random() - P_Random(), centred on zero', (t) => {
    t.mock.method(Math, 'random', scriptedRandom([0, 0.5]));
    assert.equal(triangularDraw(10), -5, 'first draw minus second');

    t.mock.restoreAll();
    t.mock.method(Math, 'random', scriptedRandom([0.5, 0]));
    assert.equal(triangularDraw(10), 5, 'and the other way round');

    // The distribution is symmetric about 0, which is what makes it a *spread*
    // rather than a bias — an off-centre draw would pull every shotgun blast to
    // one side.
    t.mock.restoreAll();
    t.mock.method(Math, 'random', seededRandom(1));
    let sum = 0;
    let max = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) {
      const d = triangularDraw(10);
      sum += d;
      max = Math.max(max, Math.abs(d));
    }
    // Loose enough not to be a sampling-noise tripwire, tight enough that any
    // real bias (a missing subtraction, one draw reused) is orders of magnitude out.
    assert.ok(Math.abs(sum / n) < 0.1, `mean ${sum / n} should sit on zero`);
    assert.ok(max <= 10, 'and never exceed the full width');
    assert.ok(max > 9, 'while still reaching near it');
  });

  test('triangularSpread is the same draw, in radians', (t) => {
    t.mock.method(Math, 'random', scriptedRandom([0, 0.5]));
    // The shotgun's 5.6 degrees of horizontal spread.
    assert.equal(triangularSpread(5.6), (-2.8 * Math.PI) / 180);

    t.mock.restoreAll();
    t.mock.method(Math, 'random', scriptedRandom([0, 0]));
    assert.equal(triangularSpread(5.6), 0, 'no spread when both draws agree');
  });
});
