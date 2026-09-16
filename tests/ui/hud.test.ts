import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, percentOf } from '../../src/ui/hud/hud.ts';
import { killsLeftMessage, timeLeftMessage } from '../../src/ui/hud/message.ts';
import { rankByKills, type ScoreRow } from '../../src/ui/hud/scoreboard.ts';

/**
 * The two pure helpers the HUD strip and the intermission popup share, so the bar and the popup
 * can't disagree about the same numbers. `Hud` itself needs the DOM and isn't covered here.
 * See docs/hud.md § Level stats and § Intermission.
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

/**
 * The deathmatch limits' center message lines — docs/multiplayer-deathmatch.md § Limits.
 */
describe('HUD · limit announcements', () => {
  test('the countdown says second or seconds', () => {
    assert.equal(timeLeftMessage(10), '10 seconds left');
    assert.equal(timeLeftMessage(1), '1 second left');
  });

  test('the kill limit names the player in their colour, and the viewer as you', () => {
    const who = { text: 'guest', color: [215, 66, 66] as const };
    assert.deepEqual(killsLeftMessage(who, 3), [who, ' needs 3 more kills']);
    assert.deepEqual(killsLeftMessage(null, 1), ['You need 1 more kill']);
  });
});

/**
 * The deathmatch intermission's board — docs/hud.md § Scoreboard.
 */
describe('HUD · deathmatch ranking', () => {
  const row = (name: string, kills: number): ScoreRow => ({
    name,
    color: 'green',
    kills,
    pingMs: null,
    local: false,
    present: true,
  });

  test('most kills first, slot order among equals, the sole leader marked', () => {
    const ranked = rankByKills([row('a', 1), row('b', 5), row('c', -1), row('d', 1)]);
    assert.deepEqual(
      ranked.map((r) => r.name),
      ['b', 'a', 'd', 'c'],
    );
    assert.deepEqual(
      ranked.map((r) => r.winner === true),
      [true, false, false, false],
    );
  });

  test('a shared top marks nobody', () => {
    assert.ok(rankByKills([row('a', 3), row('b', 3), row('c', 0)]).every((r) => !r.winner));
  });
});
