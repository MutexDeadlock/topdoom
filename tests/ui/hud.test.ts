import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, percentOf } from '../../src/ui/hud.ts';

/**
 * The two pure helpers the HUD strip and the intermission popup share, so the bar and the popup
 * can't disagree about the same numbers. `Hud` itself needs the DOM and isn't covered here.
 * See docs/items.md § Level stats and § Intermission.
 */
describe('HUD · level stat formatting', () => {
  test('percentages truncate, like wi_stuff.c integer division', () => {
    assert.equal(percentOf(87, 100), 87);
    assert.equal(percentOf(99, 100), 99);
    assert.equal(percentOf(2, 3), 66, 'not 67 — vanilla truncates');
    assert.equal(percentOf(0, 40), 0);
  });

  test('a level with nothing to find reads 100%, not 0%', () => {
    // Vanilla would divide by zero here; no map it shipped has a zero total. "Nothing to find, so
    // you found it all" is also what the HUD strip's own `found >= total` completion cue says.
    assert.equal(percentOf(0, 0), 100);
  });

  test('an over-100% count is reported as it stands', () => {
    // A resurrected monster killed twice counts twice, exactly as in vanilla's P_KillMobj.
    assert.equal(percentOf(11, 10), 110);
  });

  test('the clock is hh:mm:ss, floored and never negative', () => {
    assert.equal(formatClock(0), '00:00:00');
    assert.equal(formatClock(59.9), '00:00:59');
    assert.equal(formatClock(252), '00:04:12');
    assert.equal(formatClock(3661), '01:01:01');
    assert.equal(formatClock(-5), '00:00:00');
  });
});
