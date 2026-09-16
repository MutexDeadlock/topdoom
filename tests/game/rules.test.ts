import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TICS_PER_MINUTE,
  KILL_LIMIT_WARNING,
  TIME_LIMIT_COUNTDOWN_SECONDS,
  fragCredit,
  fragSum,
  getFragLimit,
  getFriendlyFire,
  getTimeLimit,
  overrideFragLimit,
  overrideFriendlyFire,
  setDeathmatch,
  setFragLimit,
  setFriendlyFire,
  setTimeLimit,
  killsToLimit,
  timeLimitCountdown,
  timeLimitLeft,
} from '../../src/game/rules.ts';
import { TICRATE } from '../../src/constants.ts';
import { captureSessionSettings, withSessionDefaults } from '../../src/game/replay/settings.ts';
import { targetOfSlot } from '../../src/game/things/defs.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { fakeStorage, installStorage } from '../fixtures/storage.ts';

/**
 * The host's netgame rules and the frag arithmetic — `game/rules.ts`.
 * docs/multiplayer-deathmatch.md § Settings, § Frags.
 */

describe('Rules · frags', () => {
  test('net frags are everyone else killed, minus oneself', () => {
    // `WI_fragSum`: three kills of others, one suicide.
    assert.equal(fragSum([1, 2, 0, 1], 0), 2);
    assert.equal(fragSum([0, 0, 0, 0], 2), 0);
    assert.equal(fragSum([0, 0, 2, 0], 2), -2, 'a match can go negative');
  });

  test("a death is the killing player's frag, nobody's for a monster's hit, the victim's for none", () => {
    // `P_KillMobj`'s three cases, over the hit's `slot` and `source`.
    const imp = { id: 3, type: ThingType.imp };
    assert.equal(fragCredit(1, { cause: targetOfSlot(0), slot: 0 }), 0);
    assert.equal(fragCredit(1, { cause: 'self', slot: 1 }), 1, 'their own splash');
    assert.equal(fragCredit(1, { cause: ThingType.imp, source: imp }), null);
    assert.equal(fragCredit(1, { cause: ThingType.barrel, source: imp }), null, 'a barrel an imp set off');
    assert.equal(fragCredit(1, { cause: ThingType.barrel }), 1, 'a barrel nobody set off');
    assert.equal(fragCredit(1, { cause: 'crush' }), 1);
  });
});

describe('Rules · settings', () => {
  test('a limit is stored whole and non-negative; anything else is none', () => {
    installStorage(fakeStorage());
    setFragLimit(20.7);
    assert.equal(getFragLimit(), 20);
    setFragLimit(-3);
    assert.equal(getFragLimit(), 0);
    setTimeLimit(Number.NaN);
    assert.equal(getTimeLimit(), 0);
    setTimeLimit(10);
    assert.equal(getTimeLimit(), 10);
  });

  test('an override pins the value without touching the stored one, and null lifts it', () => {
    installStorage(fakeStorage());
    setFriendlyFire(false);
    overrideFriendlyFire(true);
    assert.equal(getFriendlyFire(), true);
    overrideFriendlyFire(null);
    assert.equal(getFriendlyFire(), false);
    setFragLimit(5);
    overrideFragLimit(0);
    assert.equal(getFragLimit(), 0);
    overrideFragLimit(null);
    assert.equal(getFragLimit(), 5);
  });

  test('the capture carries the three rules a tic reads and never the mode; a record without them is coop', () => {
    installStorage(fakeStorage());
    setDeathmatch(true);
    setFragLimit(3);
    setTimeLimit(0);
    assert.deepEqual(captureSessionSettings(), {
      infiniteTallActors: false,
      pistolStart: false,
      friendlyFire: false,
      fragLimit: 3,
      timeLimit: 0,
    });
    assert.deepEqual(withSessionDefaults({ infiniteTallActors: true, pistolStart: false }), {
      infiniteTallActors: true,
      pistolStart: false,
      friendlyFire: false,
      fragLimit: 0,
      timeLimit: 0,
    });
    setDeathmatch(false);
    setFragLimit(0);
  });
});

describe('Rules · the time limit countdown', () => {
  test('one line on each of the last whole seconds, none between them, before them or at the limit', () => {
    const limit = 2 * TICS_PER_MINUTE;
    const last = TIME_LIMIT_COUNTDOWN_SECONDS;
    assert.equal(timeLimitCountdown(limit - last * TICRATE, 2), last);
    assert.equal(timeLimitCountdown(limit - TICRATE, 2), 1);
    assert.equal(timeLimitCountdown(limit - last * TICRATE + 1, 2), null, 'between two seconds');
    assert.equal(timeLimitCountdown(limit - (last + 1) * TICRATE, 2), null, 'before the last seconds');
    assert.equal(timeLimitCountdown(limit, 2), null, 'the limit itself ends the level');
    assert.equal(timeLimitCountdown(0, 0), null, 'no limit');
  });

  test('the HUD clock reads the whole seconds left, rounded up, and none without a limit', () => {
    const limit = 2 * TICS_PER_MINUTE;
    assert.equal(timeLimitLeft(0, 2), 120);
    assert.equal(timeLimitLeft(1, 2), 120, 'a tic in, the second has not passed');
    assert.equal(timeLimitLeft(limit - TIME_LIMIT_COUNTDOWN_SECONDS * TICRATE, 2), TIME_LIMIT_COUNTDOWN_SECONDS, 'with the countdown');
    assert.equal(timeLimitLeft(limit, 2), 0);
    assert.equal(timeLimitLeft(limit + TICRATE, 2), 0, 'never negative');
    assert.equal(timeLimitLeft(500, 0), null);
  });
});

describe('Rules · the kill limit announcement', () => {
  test('only within the warning of the limit, never at it, and never without one', () => {
    const limit = 10;
    assert.equal(killsToLimit(limit - KILL_LIMIT_WARNING - 1, limit), null, 'further off');
    assert.equal(killsToLimit(limit - KILL_LIMIT_WARNING, limit), KILL_LIMIT_WARNING);
    assert.equal(killsToLimit(limit - 1, limit), 1);
    assert.equal(killsToLimit(limit, limit), null, 'the limit itself ends the level');
    assert.equal(killsToLimit(9, 0), null, 'no limit');
  });
});
