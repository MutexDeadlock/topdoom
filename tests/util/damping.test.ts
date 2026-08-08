import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dampen } from '../../src/util/damping.ts';

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
