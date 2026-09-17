import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FALL_RANGE, shadowAlpha } from '../../src/render/playershadow.ts';
import { MAX_STEP_UP } from '../../src/game/world.ts';

/**
 * The disc's whole job while the player is off the ground is to say how far off it they are, so the
 * ramp has to be monotone and it has to bottom out at "barely there".
 * See docs/render.md § The player's shadow.
 */

describe('Rendering · the player shadow', () => {
  test('standing is the faintest the disc ever draws', () => {
    const grounded = shadowAlpha(0);
    assert.ok(grounded > 0, 'the shadow never disappears entirely');
    assert.ok(grounded < shadowAlpha(FALL_RANGE) / 2, 'standing has to stay ignorable beside a fall');
  });

  test('darkens monotonically with height', () => {
    const step = FALL_RANGE / 20;
    let previous = shadowAlpha(0);
    for (let height = step; height <= FALL_RANGE * 1.25; height += step) {
      const alpha = shadowAlpha(height);
      assert.ok(alpha >= previous, `${height} went lighter than ${height - step}`);
      previous = alpha;
    }
  });

  test('a step down barely registers, a real drop clearly does', () => {
    const step = shadowAlpha(MAX_STEP_UP) - shadowAlpha(0);
    const drop = shadowAlpha(FALL_RANGE) - shadowAlpha(0);
    assert.ok(step < drop / 4, `a ${MAX_STEP_UP}-unit step must not read like a fall`);
  });

  test('holds at full strength past the ramp instead of running away', () => {
    const full = shadowAlpha(FALL_RANGE);
    assert.equal(shadowAlpha(FALL_RANGE * 1000), full);
    assert.ok(full <= 1);
  });
});
