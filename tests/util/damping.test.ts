import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dampen, decayOverTics } from '../../src/util/damping.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * The smoothing behind both the wall-occlusion fade and the fog reveal fade.
 * The snap is the part with teeth: a pure exponential lerp never arrives, and
 * the residue shows up as permanent speckle under dithered discard.
 */
describe('Smoothing · damped approach', () => {
  test('dampen snaps exactly onto the target inside snapEps', () => {
    const snapped = dampen(0.999, 1, 3, 1 / 60, 0.004);
    assert.equal(snapped, 1, 'exactly the target, with no asymptotic residue left');
    assert.ok(Object.is(snapped, 1));

    // Just outside the epsilon it must still be approaching, not arrived.
    const approaching = dampen(0, 1, 3, 1 / 60, 0.004);
    assert.ok(approaching > 0 && approaching < 1);
  });

  test('dampen does not move when dt is zero', () => {
    assert.equal(dampen(0.25, 1, 3, 0, 0.004), 0.25);
  });

  test('dampen is framerate-independent', () => {
    const one = dampen(0, 1, 3, 0.1, 0);
    let many = 0;
    for (let i = 0; i < 10; i++) many = dampen(many, 1, 3, 0.01, 0);
    assert.ok(Math.abs(one - many) < 1e-12, `${one} vs ${many}`);
  });

  test('dampen approaches from above as well as below', () => {
    const falling = dampen(1, 0, 3, 1 / 60, 0);
    assert.ok(falling < 1 && falling > 0);
    assert.equal(dampen(0.001, 0, 3, 1 / 60, 0.004), 0);
  });
});

/**
 * The friction the player's momentum channel, a knockback and a voodoo doll all
 * shed speed with. docs/movement.md § Knockback.
 */
describe('Smoothing · per-tic decay', () => {
  test('one tic returns the factor itself, bit for bit', () => {
    // The simulation only ever steps by DOOM_TIC, so this is the only case it
    // takes: no `Math.pow` on the movement path, and nothing for an engine's
    // last-bit rounding to differ over.
    assert.ok(Object.is(decayOverTics(0.90625, DOOM_TIC), 0.90625));
    assert.ok(Object.is(decayOverTics(0.973, DOOM_TIC), 0.973));
  });

  test('another step length still decays over the tics it covers', () => {
    assert.equal(decayOverTics(0.90625, 2 * DOOM_TIC), 0.90625 ** 2);
    assert.ok(Math.abs(decayOverTics(0.90625, DOOM_TIC / 2) - Math.sqrt(0.90625)) < 1e-12);
    assert.equal(decayOverTics(0.90625, 0), 1);
  });
});
