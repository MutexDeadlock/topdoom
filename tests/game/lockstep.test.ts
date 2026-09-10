import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LockstepScheduler } from '../../src/game/net/lockstep.ts';
import { emptyRow, type TicRow } from '../../src/game/replay/row.ts';

/**
 * The lockstep table: readiness over every slot, the idle tics at a start, a join and a drop, and
 * what a row's settings change does. docs/multiplayer-net.md § Lockstep.
 */

function row(held: number): TicRow {
  return { ...emptyRow(), held };
}

const SETTINGS = { autorun: false, autoSwitchWeapon: true, rightMouse: 'use', cameraMode: 'manual' } as const;

describe('Network · lockstep scheduler', () => {
  test('the first `delay` tics need no rows, and every later one needs every slot', () => {
    const s = new LockstepScheduler({ delay: 3, slots: 2 });
    for (let tic = 0; tic < 3; tic++) {
      assert.ok(s.readyFor(tic), `tic ${tic} runs on idle rows`);
      assert.equal(s.rowAt(0, tic), null);
    }
    assert.deepEqual(s.missingAt(3), [0, 1]);
    assert.equal(s.push(0, 3, row(1)), 'stored');
    assert.deepEqual(s.missingAt(3), [1]);
    assert.equal(s.push(1, 3, row(2)), 'stored');
    assert.ok(s.readyFor(3));
    assert.equal(s.rowAt(1, 3)?.held, 2);
  });

  test('advancing drops the tic just run and refuses a row for it afterwards', () => {
    const s = new LockstepScheduler({ delay: 1, slots: 1 });
    s.push(0, 1, row(5));
    s.advance();
    assert.equal(s.tic, 1);
    assert.equal(s.rowAt(0)?.held, 5);
    s.advance();
    assert.equal(s.push(0, 1, row(6)), 'late');
    assert.equal(s.rowAt(0, 1), null);
  });

  test('a settings change rides the row it was stamped for and no other', () => {
    const s = new LockstepScheduler({ delay: 1, slots: 1 });
    s.push(0, 1, row(0), SETTINGS);
    s.push(0, 2, row(0));
    assert.deepEqual(s.settingsAt(0, 1), SETTINGS);
    assert.equal(s.settingsAt(0, 2), undefined);
  });

  test('a dropped slot is idle from its drop tic and waited for no more', () => {
    const s = new LockstepScheduler({ delay: 2, slots: 2 });
    s.push(1, 2, row(1));
    s.push(1, 3, row(1));
    s.push(1, 5, row(1));
    // One past the last row that arrived, whatever gap sits before it.
    assert.equal(s.dropTicFor(1), 6);
    s.markLeft(1, 4);
    assert.ok(s.hasLeft(1));
    assert.equal(s.rowAt(1, 3)?.held, 1, 'rows before the drop still serve');
    assert.equal(s.rowAt(1, 5), null, 'a row past the drop is thrown away');
    assert.equal(s.push(1, 7, row(1)), 'ignored');
    s.push(0, 4, row(1));
    assert.ok(s.readyFor(4), 'only the slots still present are waited for');
  });

  test('a slot never heard from drops at its first non-idle tic', () => {
    const s = new LockstepScheduler({ delay: 3, slots: 2 });
    assert.equal(s.dropTicFor(1), 3);
  });

  test('a joining slot is idle until `delay` past the sync tic, and a reused one starts afresh', () => {
    const s = new LockstepScheduler({ delay: 2, slots: 2 });
    s.markLeft(1, 10);
    s.ensureSlot(2, 22);
    assert.equal(s.slotCount, 3);
    assert.ok(s.readyFor(21) === false, 'the old slots still owe their rows');
    s.push(0, 21, row(0));
    assert.ok(s.readyFor(21), 'the joiner owes nothing before its idle tics end');
    assert.equal(s.push(2, 21, row(1)), 'ignored');
    assert.equal(s.push(2, 22, row(1)), 'stored');
    s.ensureSlot(1, 30);
    assert.ok(!s.hasLeft(1), 'a dropped slot handed to a joiner is back');
    assert.equal(s.push(1, 30, row(1)), 'stored');
  });

  test('a seek keeps the rows past the tic it lands on', () => {
    const s = new LockstepScheduler({ delay: 1, slots: 1 });
    s.push(0, 1, row(1));
    s.push(0, 4, row(4));
    s.push(0, 5, row(5));
    s.seek(4);
    assert.equal(s.tic, 4);
    assert.equal(s.rowAt(0, 4)?.held, 4);
    assert.equal(s.rowAt(0, 5)?.held, 5);
    assert.equal(s.push(0, 1, row(1)), 'late');
  });
});
