import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
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
} from '../../src/game/rules.ts';
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
