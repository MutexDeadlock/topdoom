import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRooms, type RoomMember } from '../../server/rooms.ts';
import { MAX_PLAYERS } from '../../src/game/playerstarts.ts';

/**
 * The relay's room logic, driven without sockets: codes, seats, forwarding with the sender
 * stamped on, and what leaving does. docs/multiplayer-net.md § The relay.
 */

/** A member that keeps what it was sent. */
function member(): RoomMember & { got: unknown[]; closed: boolean } {
  const m = {
    got: [] as unknown[],
    closed: false,
    send: (text: string) => {
      m.got.push(JSON.parse(text));
    },
    close: () => {
      m.closed = true;
    },
  };
  return m;
}

function rooms(codes = ['AAAAA', 'BBBBB']) {
  let next = 0;
  return createRooms({ capacity: MAX_PLAYERS, makeCode: () => codes[next++ % codes.length] });
}

describe('Relay · rooms', () => {
  test('the first joiner opens a room as its host and hears its code', () => {
    const r = rooms();
    const host = member();
    assert.deepEqual(r.join(host, null), { code: 'AAAAA', member: 0, host: true });
    assert.deepEqual(host.got, [{ type: 'room', code: 'AAAAA', member: 0, host: true, members: [0] }]);
    assert.equal(r.roomCount, 1);
  });

  test('a joiner is seated by code, case-insensitively, and the others hear it', () => {
    const r = rooms();
    const host = member();
    const guest = member();
    r.join(host, null);
    assert.deepEqual(r.join(guest, ' aaaaa '), { code: 'AAAAA', member: 1, host: false });
    assert.deepEqual(guest.got[0], { type: 'room', code: 'AAAAA', member: 1, host: false, members: [0, 1] });
    assert.deepEqual(host.got[1], { type: 'joined', member: 1 });
  });

  test('a code nobody opened, a full room and a second seat are refused', () => {
    const r = rooms();
    const stranger = member();
    assert.deepEqual(r.join(stranger, 'ZZZZZ'), { refusal: 'no room ZZZZZ' });
    assert.deepEqual(stranger.got, [{ type: 'refused', reason: 'no room ZZZZZ' }]);
    const host = member();
    r.join(host, null);
    for (let i = 1; i < MAX_PLAYERS; i++) r.join(member(), 'AAAAA');
    assert.deepEqual(r.join(member(), 'AAAAA'), { refusal: 'that room is full' });
    assert.deepEqual(r.join(host, null), { refusal: 'already in a room' });
  });

  test('a message is forwarded to every other member with the sender stamped on', () => {
    const r = rooms();
    const host = member();
    const a = member();
    const b = member();
    r.join(host, null);
    r.join(a, 'AAAAA');
    r.join(b, 'AAAAA');
    r.relay(a, { type: 'input', tic: 7 });
    assert.deepEqual(host.got.at(-1), { type: 'input', tic: 7, from: 1 });
    assert.deepEqual(b.got.at(-1), { type: 'input', tic: 7, from: 1 });
    assert.ok(
      !a.got.some((m) => (m as { type: string }).type === 'input'),
      'a sender never hears its own message',
    );
  });

  test("a connection's first message must be its join, and everything after it is forwarded", () => {
    const r = rooms();
    const stranger = member();
    assert.equal(r.receive(stranger, { type: 'input', tic: 0 }), false);
    assert.deepEqual(stranger.got, [{ type: 'refused', reason: 'join a room first' }]);
    const host = member();
    assert.equal(r.receive(host, { type: 'join', code: '  ' }), true, 'a blank code opens a room');
    const guest = member();
    assert.equal(r.receive(guest, { type: 'join', code: 'ZZZZZ' }), false);
    assert.equal(r.receive(guest, { type: 'join', code: 'aaaaa' }), true);
    // Seated, a second `join` is just another message: the relay never reads what it forwards.
    assert.equal(r.receive(guest, { type: 'join', code: null }), true);
    assert.deepEqual(host.got.at(-1), { type: 'join', code: null, from: 1 });
  });

  test('a member leaving is announced; the host leaving closes the room for everyone', () => {
    const r = rooms();
    const host = member();
    const a = member();
    const b = member();
    r.join(host, null);
    r.join(a, 'AAAAA');
    r.join(b, 'AAAAA');
    r.leave(a);
    assert.deepEqual(host.got.at(-1), { type: 'left', member: 1 });
    assert.deepEqual(b.got.at(-1), { type: 'left', member: 1 });
    r.leave(host);
    assert.deepEqual(b.got.at(-1), { type: 'closed' });
    assert.ok(b.closed);
    assert.equal(r.roomCount, 0);
    // A closed room's code is free again, and the members that were in it can seat elsewhere.
    assert.deepEqual(r.join(b, null), { code: 'BBBBB', member: 0, host: true });
  });

  test('a fresh room never reuses a code still in use', () => {
    const r = rooms(['AAAAA', 'AAAAA', 'BBBBB']);
    r.join(member(), null);
    assert.deepEqual(r.join(member(), null), { code: 'BBBBB', member: 0, host: true });
  });

  test('the relay seats as many as the engine has slots', () => {
    // `server/relay.ts` states its own 4, being dependency-free; this is what keeps the two equal.
    assert.equal(MAX_PLAYERS, 4);
  });
});
