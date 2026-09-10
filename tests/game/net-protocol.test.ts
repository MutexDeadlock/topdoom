import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isPeerMessage, isRelayMessage } from '../../src/game/net/defs.ts';
import { emptyRow, isWireRow, rowFromWire, rowToWire, type TicRow, type WireRow } from '../../src/game/replay/row.ts';
import { snapshotFor } from '../fixtures/net.ts';

/**
 * The wire shapes: a row round-trips through its array form, and the guards let a well-formed
 * message through and nothing else. docs/multiplayer-net.md § Protocol.
 */

const SETTINGS = { autorun: true, autoSwitchWeapon: false, rightMouse: 'none', cameraMode: 'auto' };

describe('Network · protocol', () => {
  test('a row survives the wire, typed excepted', () => {
    const row: TicRow = {
      held: 5,
      pressed: 1,
      buttons: 3,
      wheel: -1,
      aimX: 640,
      aimY: null,
      poseYaw: 5760,
      poseX: 4096,
      poseY: -2624,
      poseZ: 8192,
      poseDistance: 30720,
      poseTilt: 3680,
      typed: 'iddqd',
    };
    const wire = rowToWire(row);
    assert.equal(wire.length, 12);
    assert.ok(isWireRow(wire));
    assert.deepEqual(rowFromWire(wire), { ...row, typed: '' });
    assert.deepEqual(rowToWire(emptyRow()), [0, 0, 0, 0, null, null, 0, 0, 0, 0, 0, 0]);
  });

  test('a wire row is twelve finite numbers, nulls allowed on the aim pair alone', () => {
    const good: WireRow = [0, 0, 0, 0, null, null, 0, 0, 0, 0, 0, 0];
    assert.ok(isWireRow(good));
    assert.ok(!isWireRow(good.slice(0, 11)));
    assert.ok(!isWireRow([null, 0, 0, 0, null, null, 0, 0, 0, 0, 0, 0]));
    assert.ok(!isWireRow([0, 0, 0, 0, null, null, 0, 0, 0, 0, 0, Infinity]));
    assert.ok(!isWireRow([0, 0, 0, 0, null, null, 0, 0, 0, 0, 0, '0']));
  });

  test('the relay messages are recognised and a malformed one is not', () => {
    assert.ok(isRelayMessage({ type: 'room', code: 'ABCDE', member: 0, host: true, members: [0] }));
    assert.ok(isRelayMessage({ type: 'joined', member: 2 }));
    assert.ok(isRelayMessage({ type: 'closed' }));
    assert.ok(isRelayMessage({ type: 'kicked' }));
    assert.ok(!isRelayMessage({ type: 'room', code: 'ABCDE', member: -1, host: true, members: [] }));
    assert.ok(!isRelayMessage({ type: 'left' }));
    assert.ok(!isRelayMessage(null));
  });

  test('a peer message needs its stamp and every field its handler reads', () => {
    const row = rowToWire(emptyRow());
    assert.ok(isPeerMessage({ type: 'input', slot: 1, tic: 40, row, from: 1 }));
    assert.ok(isPeerMessage({ type: 'input', slot: 1, tic: 40, row, settings: SETTINGS, from: 1 }));
    assert.ok(!isPeerMessage({ type: 'input', slot: 1, tic: 40, row }), 'no stamp');
    assert.ok(!isPeerMessage({ type: 'input', slot: 1, tic: 40, row, settings: { autorun: 1 }, from: 1 }));
    assert.ok(isPeerMessage({ type: 'check', tic: 35, cursor: 12, x: [1, 2], y: [3, 4], from: 0 }));
    assert.ok(!isPeerMessage({ type: 'check', tic: 35, cursor: 12, x: [1, 'a'], y: [3, 4], from: 0 }));
    assert.ok(isPeerMessage({ type: 'sync', atTic: 100, joining: null, from: 0 }));
    assert.ok(
      isPeerMessage({
        type: 'snapshot',
        restore: { tic: 100, map: 'MAP01', state: snapshotFor(2), slots: [] },
        from: 0,
      }),
    );
    assert.ok(!isPeerMessage({ type: 'snapshot', restore: { tic: 100, map: 'MAP01', state: {}, slots: [] }, from: 0 }));
    assert.ok(!isPeerMessage({ type: 'teleport', from: 0 }), 'an unknown type');
  });
});
