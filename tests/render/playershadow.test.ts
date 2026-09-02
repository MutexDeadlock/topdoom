import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowAlpha } from '../../src/render/playershadow.ts';

/**
 * The disc's whole job while the player is off the ground is to say how far off it they are, so the
 * ramp has to be monotone and it has to bottom out at "barely there".
 * See docs/render.md § The player's shadow.
 */

describe('Rendering · the player shadow', () => {
  test('standing is the faintest the disc ever draws', () => {
    const grounded = shadowAlpha(0);
    assert.ok(grounded > 0, 'the shadow never disappears entirely');
    assert.ok(grounded < 0.25, 'standing has to stay ignorable');
  });

  test('darkens monotonically with height', () => {
    let previous = shadowAlpha(0);
    for (let height = 8; height <= 200; height += 8) {
      const alpha = shadowAlpha(height);
      assert.ok(alpha >= previous, `${height} went lighter than ${height - 8}`);
      previous = alpha;
    }
  });

  test('a step down barely registers, a real drop clearly does', () => {
    const step = shadowAlpha(24) - shadowAlpha(0);
    const drop = shadowAlpha(160) - shadowAlpha(0);
    assert.ok(step < drop / 4, 'a 24-unit step must not read like a fall');
  });

  test('holds at full strength past the ramp instead of running away', () => {
    const full = shadowAlpha(160);
    assert.equal(shadowAlpha(100000), full);
    assert.ok(full <= 1);
  });
});
