import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRow } from '../../src/game/replay/row.ts';
import { DROP_TIMEOUT_MS, STALL_NOTICE_MS, type NetNotice } from '../../src/game/net/defs.ts';
import { withRulesDefaults, type NetSession } from '../../src/game/net/session.ts';
import { GAME, Hub, SETTINGS, hostSession, joinSession, snapshotFor } from '../fixtures/net.ts';

/**
 * Two and three sessions through the relay's own room logic: the lobby handshake, a run in
 * lockstep where every browser reads the same rows, a stall and a drop, a desync resynced from the
 * host's snapshot, and a player joining a game already running. docs/multiplayer-net.md.
 */

/** The bodies a session hands its check sample: one per slot, all at the origin unless told. */
const bodiesFor = (slots: number, x = 0) => Array.from({ length: slots }, () => ({ x, y: 0 }));

/**
 * One tic on every session at once, the way `Game.frame` runs it: readiness, the local row for
 * `delay` ahead, the tic, the cursor — then the relay delivers. Each session's row holds a mark of
 * whose it is and which tic sampled it, so what a tic read can be told apart later.
 */
function runTic(hub: Hub, sessions: NetSession[], seen: Map<NetSession, number[][]>, bodyX = new Map<NetSession, number>()) {
  for (const session of sessions) {
    assert.ok(session.readyForTic(), `${session.slot} ready for tic ${session.tic}`);
    const row = { ...emptyRow(), held: session.tic * 10 + session.slot + 1 };
    session.beginTic(row, SETTINGS, bodiesFor(session.slotCount, bodyX.get(session) ?? 0));
    const rows: number[] = [];
    for (let slot = 0; slot < session.slotCount; slot++) rows.push(session.input(slot).held('KeyW') ? 1 : 0);
    // What each slot's row held this tic, read back off the input's own row.
    const held: number[] = [];
    for (let slot = 0; slot < session.slotCount; slot++) {
      held.push((session.input(slot) as unknown as { row: { held: number } }).row.held);
    }
    seen.get(session)!.push(held);
    session.endTic();
  }
  hub.flush();
}

function attached(...sessions: NetSession[]): void {
  for (const session of sessions) session.attach();
}

describe('Network · session', () => {
  test('the lobby: a joiner is announced, checked against the set, and refused on other rules', () => {
    const hub = new Hub();
    const host = hostSession(hub);
    assert.equal(host.session.code, 'ROOM1');
    assert.ok(host.session.isHost);
    assert.ok(!host.session.canStart, 'a host alone cannot start');

    const guest = joinSession(hub, 'ROOM1');
    assert.ok(!guest.session.isHost);
    assert.deepEqual(guest.session.game, GAME, "the lobby carried the host's game");
    assert.deepEqual(
      host.session.peers.map((p) => [p.name, p.ready]),
      [
        ['host', true],
        ['guest', true],
      ],
    );
    assert.deepEqual(guest.session.peers.map((p) => p.name), ['host', 'guest'], 'mirrored to the guest');
    assert.ok(host.session.canStart);

    const other = joinSession(hub, 'ROOM1', { name: 'other', build: '0.9', compat: 2 });
    const refused = host.session.peers.find((p) => p.name === 'other')!;
    assert.equal(refused.ready, false);
    assert.match(refused.refusal!, /other game rules/);
    assert.ok(!host.session.canStart);
    other.session.leave();
    hub.flush();
    assert.deepEqual(host.session.peers.map((p) => p.name), ['host', 'guest']);
    assert.ok(host.session.canStart);
  });

  test('a joiner that cannot play the set says so, in its own words', () => {
    const hub = new Hub();
    const host = hostSession(hub);
    const short = joinSession(hub, 'ROOM1', { name: 'short', refusal: 'Missing IWAD: DOOM2.WAD' });
    const peer = () => host.session.peers.find((p) => p.name === 'short')!;
    assert.equal(peer().ready, false);
    assert.equal(peer().refusal, 'Missing IWAD: DOOM2.WAD');
    assert.ok(!host.session.canStart);

    // Its WADs changing asks again; only a different answer goes out.
    const readies = () => short.transport.sent.filter((m) => (m as { type: string }).type === 'ready').length;
    const answered = readies();
    short.session.recheckSet();
    assert.equal(readies(), answered, 'the same answer is not sent again');
    short.log.refusal = null;
    short.session.recheckSet();
    hub.flush();
    assert.equal(peer().ready, true);
    assert.equal(peer().refusal, null);
    assert.ok(host.session.canStart);
  });

  test("the host's new pick has every peer check again; an unchanged one, or a game under way, sends nothing", () => {
    const hub = new Hub();
    const host = hostSession(hub);
    const short = joinSession(hub, 'ROOM1', { name: 'short', refusal: 'Missing IWAD: DOOM2.WAD' });
    const other = joinSession(hub, 'ROOM1', { name: 'other', build: '0.9', compat: 2 });
    const peer = (name: string) => host.session.peers.find((p) => p.name === name)!;
    const vanilla = withRulesDefaults({});
    assert.equal(host.session.setGame(GAME, vanilla), false, 'the same pick is no change');

    // The next pick is one `short` can play: its refusal is lifted, the other build's is not.
    short.log.refusal = null;
    assert.equal(host.session.setGame({ ...GAME, skill: 4 }, vanilla), true);
    assert.equal(peer('short').ready, null, 'checking again');
    hub.flush();
    assert.equal(short.session.game?.skill, 4);
    assert.equal(peer('short').ready, true);
    assert.equal(peer('short').refusal, null);
    assert.equal(peer('other').ready, false);
    assert.match(peer('other').refusal!, /other game rules/);

    // A session setting alone reaches everyone without a new check.
    assert.equal(host.session.setGame({ ...GAME, skill: 4 }, { ...vanilla, pistolStart: true }), true);
    assert.equal(peer('short').ready, true);
    hub.flush();
    assert.equal(short.session.session.pistolStart, true);

    other.session.leave();
    hub.flush();
    host.session.start();
    hub.flush();
    assert.equal(host.session.setGame({ ...GAME, skill: 2 }, vanilla), false, 'a game under way keeps its pick');
  });

  test('a colour picked in the lobby reaches the room; a game under way keeps the one it started with', () => {
    const hub = new Hub();
    const host = hostSession(hub);
    const guest = joinSession(hub, 'ROOM1');
    const colors = (session: NetSession) => session.peers.map((p) => p.color);

    guest.session.setColor('red');
    host.session.setColor('blue');
    hub.flush();
    assert.deepEqual(colors(host.session), ['blue', 'red']);
    assert.deepEqual(colors(guest.session), ['blue', 'red'], 'mirrored to the guest');

    guest.transport.send({ type: 'color', color: 'mauve' });
    hub.flush();
    assert.deepEqual(colors(host.session), ['blue', 'red'], 'a colour this build does not know keeps the old');

    host.session.start();
    hub.flush();
    assert.equal(host.session.colorOf(1), 'red', 'the start carries the lobby colour');
    const sent = guest.transport.sent.length;
    guest.session.setColor('pink');
    assert.equal(guest.transport.sent.length, sent, 'nothing goes out during a game');
    guest.transport.send({ type: 'color', color: 'pink' });
    host.session.setColor('white');
    hub.flush();
    assert.deepEqual(colors(host.session), ['blue', 'red'], 'the host takes no colour from a seated player');
    assert.deepEqual(host.session.roster().map((r) => r.color), ['blue', 'red']);
  });

  test('a start hands every session the same game and slots, and the run reads the same rows', () => {
    const hub = new Hub();
    const host = hostSession(hub, 'host', 2);
    const guest = joinSession(hub, 'ROOM1', { color: 'red' });
    host.session.start();
    hub.flush();
    assert.equal(host.log.starts.length, 1);
    assert.equal(guest.log.starts.length, 1);
    assert.equal(guest.log.starts[0].restore, null);
    assert.equal(host.session.slot, 0);
    assert.equal(guest.session.slot, 1);
    assert.equal(guest.session.delay, 2);
    assert.deepEqual(guest.session.roster().map((r) => [r.name, r.color, r.present, r.local]), [
      ['host', 'green', true, false],
      ['guest', 'red', true, true],
    ]);
    assert.equal(host.session.colorOf(1), 'red', "the guest's colour reached the host's slot");
    attached(host.session, guest.session);
    assert.equal(guest.session.phase, 'playing');

    const seen = new Map([
      [host.session, [] as number[][]],
      [guest.session, [] as number[][]],
    ]);
    for (let tic = 0; tic < 40; tic++) runTic(hub, [host.session, guest.session], seen);
    const hostSaw = seen.get(host.session)!;
    const guestSaw = seen.get(guest.session)!;
    assert.deepEqual(hostSaw, guestSaw, 'both browsers ran every tic on the same rows');
    assert.deepEqual(hostSaw[0], [0, 0], 'the first tics run on idle rows');
    assert.deepEqual(hostSaw[1], [0, 0]);
    // Tic 2 reads what each sampled at tic 0: 0 * 10 + slot + 1.
    assert.deepEqual(hostSaw[2], [1, 2]);
    assert.deepEqual(hostSaw[39], [37 * 10 + 1, 37 * 10 + 2]);
    assert.equal(host.session.desyncedAt, null);
    assert.equal(guest.session.desyncedAt, null);
  });

  test("the host's End game takes every browser back to the lobby and keeps the room", () => {
    const hub = new Hub();
    const host = hostSession(hub, 'host', 1);
    const guest = joinSession(hub, 'ROOM1');
    host.session.endGame();
    hub.flush();
    assert.equal(host.log.lobbies + guest.log.lobbies, 0, 'a lobby has no game to end');

    host.session.start();
    hub.flush();
    attached(host.session, guest.session);
    assert.ok(host.session.gameRunning && guest.session.gameRunning);
    const seen = new Map([
      [host.session, [] as number[][]],
      [guest.session, [] as number[][]],
    ]);
    for (let tic = 0; tic < 5; tic++) runTic(hub, [host.session, guest.session], seen);
    guest.session.endGame();
    hub.flush();
    assert.equal(host.session.phase, 'playing', "a peer's End game does nothing");

    host.session.endGame();
    hub.flush();
    for (const { session, log } of [host, guest]) {
      assert.equal(session.phase, 'lobby');
      assert.ok(!session.gameRunning);
      assert.equal(log.lobbies, 1);
      assert.deepEqual(log.ended, [], 'nobody left the room');
      assert.ok(!session.readyForTic(), 'no rows are served any more');
    }
    assert.deepEqual(guest.session.peers.map((p) => p.name), ['host', 'guest']);
    assert.ok(host.session.canStart, 'the room can start again');
    host.session.start();
    hub.flush();
    assert.equal(guest.log.starts.length, 2, 'the next game starts on every browser');
  });

  test('a settings change rides the row and lands on every browser at the same tic', () => {
    const hub = new Hub();
    const host = hostSession(hub, 'host', 1);
    const guest = joinSession(hub, 'ROOM1');
    host.session.start();
    hub.flush();
    attached(host.session, guest.session);
    const seen = new Map([
      [host.session, [] as number[][]],
      [guest.session, [] as number[][]],
    ]);
    runTic(hub, [host.session, guest.session], seen);
    // The guest turns autorun off at tic 1; every browser's slot 1 runs under it from tic 2.
    guest.session.beginTic(emptyRow(), { ...SETTINGS, autorun: false }, bodiesFor(2));
    host.session.beginTic(emptyRow(), SETTINGS, bodiesFor(2));
    hub.flush();
    const held = host.session.settingsOf(1)!;
    assert.equal(held.autorun, true, 'not yet: the row is for the next tic');
    host.session.endTic();
    guest.session.endTic();
    host.session.beginTic(emptyRow(), SETTINGS, bodiesFor(2));
    guest.session.beginTic(emptyRow(), { ...SETTINGS, autorun: false }, bodiesFor(2));
    assert.equal(host.session.settingsOf(1)!.autorun, false);
    assert.equal(held.autorun, false, "changed in place: the record a Game's slot holds follows it");
    assert.equal(guest.session.settingsOf(1)!.autorun, false);
    assert.equal(host.session.settingsOf(0)!.autorun, true);
  });

  test('a peer whose rows stop stalls the others, is named, and is dropped in time', () => {
    const hub = new Hub();
    const host = hostSession(hub, 'host', 2);
    const guest = joinSession(hub, 'ROOM1');
    host.session.start();
    hub.flush();
    attached(host.session, guest.session);
    const seen = new Map([
      [host.session, [] as number[][]],
      [guest.session, [] as number[][]],
    ]);
    for (let tic = 0; tic < 4; tic++) runTic(hub, [host.session, guest.session], seen);
    const notices: NetNotice[] = [];
    host.session.onNotice = (notice) => notices.push(notice);
    // The guest goes quiet: nothing it sends is delivered any more.
    guest.transport.closed = true;
    runTic(hub, [host.session], seen);
    runTic(hub, [host.session], seen);
    assert.ok(!host.session.readyForTic(), 'tic 6 needs a row the guest never sent');
    assert.equal(host.session.stallNotice(), null, 'too soon to say');
    host.clock.now += STALL_NOTICE_MS + 1;
    assert.equal(host.session.stallNotice(), 'waiting for guest…');
    host.clock.now += DROP_TIMEOUT_MS;
    assert.ok(host.session.readyForTic(), 'the drop frees the tic');
    assert.deepEqual(host.session.roster().map((r) => r.present), [true, false]);
    assert.deepEqual(
      notices,
      [{ name: 'guest', color: host.session.colorOf(1), event: 'left' }],
      "the drop is the feed's line, by roster name and colour",
    );
    const drop = host.transport.sent.at(-1) as { type: string; slot: number; atTic: number };
    assert.equal(drop.type, 'drop');
    assert.equal(drop.slot, 1);
    // One past the guest's last row, which it sent for tic 3 + 2.
    assert.equal(drop.atTic, 6);
    for (let tic = 6; tic < 10; tic++) runTic(hub, [host.session], seen);
    assert.deepEqual(seen.get(host.session)![9], [7 * 10 + 1, 0], 'the dropped slot reads idle');
  });

  test("a joiner under a present player's name, in any case, or a short one, is refused and told why", () => {
    const hub = new Hub();
    const host = hostSession(hub);
    const twin = joinSession(hub, 'ROOM1', { name: ' HOST ' });
    assert.equal(twin.session.phase, 'ended');
    assert.deepEqual(twin.log.ended, ['someone named HOST is already in this room']);
    const short = joinSession(hub, 'ROOM1', { name: 'ab' });
    assert.deepEqual(short.log.ended, ['your name needs at least 3 characters']);
    assert.deepEqual(host.session.peers.map((p) => p.name), ['host']);

    // A player who left a running game holds no name: they can come back under it.
    const guest = joinSession(hub, 'ROOM1');
    host.session.start();
    hub.flush();
    guest.session.leave();
    hub.flush();
    const back = joinSession(hub, 'ROOM1', { name: 'Guest' });
    assert.deepEqual(back.log.ended, []);
    assert.equal(back.session.phase, 'loading', 'queued for its sync like any late joiner');
  });

  test('a kicked player hears why; the lobby loses them, a running game drops their slot', () => {
    const hub = new Hub();
    const host = hostSession(hub, 'host', 2);
    const guest = joinSession(hub, 'ROOM1');
    const other = joinSession(hub, 'ROOM1', { name: 'other' });
    guest.session.kick(2);
    assert.ok(!guest.transport.sent.some((m) => (m as { type: string }).type === 'kick'), 'only the host kicks');
    host.session.kick(2);
    hub.flush();
    assert.equal(other.session.phase, 'ended');
    assert.deepEqual(other.log.ended, ['the host kicked you from the room']);
    assert.deepEqual(host.session.peers.map((p) => p.name), ['host', 'guest']);
    assert.deepEqual(guest.session.peers.map((p) => p.name), ['host', 'guest'], 'mirrored to the guest');

    host.session.start();
    hub.flush();
    attached(host.session, guest.session);
    const seen = new Map([
      [host.session, [] as number[][]],
      [guest.session, [] as number[][]],
    ]);
    for (let tic = 0; tic < 4; tic++) runTic(hub, [host.session, guest.session], seen);
    host.session.kick(1);
    hub.flush();
    assert.deepEqual(guest.log.ended, ['the host kicked you from the room']);
    assert.deepEqual(host.session.roster().map((r) => [r.present, r.member]), [
      [true, 0],
      [false, null],
    ]);
    assert.equal((host.transport.sent.at(-2) as { type: string }).type, 'drop');
    for (let tic = 4; tic < 8; tic++) runTic(hub, [host.session], seen);
  });

  test("the relay's round trips reach every roster, and a player who left has none", () => {
    const hub = new Hub();
    const host = hostSession(hub, 'host', 2);
    const guest = joinSession(hub, 'ROOM1');
    host.session.start();
    hub.flush();
    const pings = (session: NetSession) => session.roster().map((r) => r.pingMs);
    assert.deepEqual(pings(host.session), [null, null], 'nothing measured yet');
    hub.rooms.latency(host.transport.member, 12.4);
    hub.rooms.latency(guest.transport.member, 87.6);
    hub.flush();
    assert.deepEqual(pings(host.session), [12, 88]);
    assert.deepEqual(pings(guest.session), [12, 88], 'the same numbers on both browsers');
    guest.session.leave();
    hub.flush();
    assert.deepEqual(pings(host.session), [12, null]);
  });

  test('a desync is reported to the host, which lands a snapshot everyone restores', () => {
    const hub = new Hub();
    const host = hostSession(hub, 'host', 2);
    const guest = joinSession(hub, 'ROOM1');
    host.session.start();
    hub.flush();
    attached(host.session, guest.session);
    const seen = new Map([
      [host.session, [] as number[][]],
      [guest.session, [] as number[][]],
    ]);
    const drift = new Map([[guest.session, 100]]);
    let captured = 0;
    const capture = (session: NetSession) =>
      session.pendingRestore(() => {
        captured++;
        return { map: 'MAP01', state: snapshotFor(2) };
      });
    // The first sample is tic 0's, and the guest's drift shows in it.
    runTic(hub, [host.session, guest.session], seen, drift);
    assert.equal(guest.session.desyncedAt, 0);
    assert.equal(host.session.desyncedAt, null, 'the host is the reference');
    const syncAt = (host.transport.sent.find((m) => (m as { type: string }).type === 'sync') as { atTic: number }).atTic;
    assert.equal(syncAt, 1 + 4, "twice the delay past the host's tic when it heard");
    while (host.session.tic < syncAt) {
      for (const session of [host.session, guest.session]) assert.equal(capture(session), null);
      runTic(hub, [host.session, guest.session], seen, drift);
    }
    // The host captures on its own; the guest waits for the snapshot to arrive.
    assert.equal(capture(guest.session), 'wait');
    const restore = capture(host.session);
    assert.ok(restore !== null && restore !== 'wait');
    assert.equal(restore.tic, syncAt);
    assert.equal(captured, 1);
    host.session.restoreApplied();
    hub.flush();
    const theirs = capture(guest.session);
    assert.ok(theirs !== null && theirs !== 'wait');
    assert.deepEqual(theirs.slots.map((s) => s.name), ['host', 'guest']);
    guest.session.restoreApplied();
    assert.equal(guest.session.desyncedAt, null);
    for (let tic = 0; tic < 5; tic++) runTic(hub, [host.session, guest.session], seen);
    assert.deepEqual(seen.get(host.session)!.at(-1), seen.get(guest.session)!.at(-1));
  });

  test("a player joining a running game gets the host's snapshot and a slot idle until its rows come", () => {
    const hub = new Hub();
    const host = hostSession(hub, 'host', 2);
    const guest = joinSession(hub, 'ROOM1');
    host.session.start();
    hub.flush();
    attached(host.session, guest.session);
    const seen = new Map([
      [host.session, [] as number[][]],
      [guest.session, [] as number[][]],
    ]);
    for (let tic = 0; tic < 10; tic++) runTic(hub, [host.session, guest.session], seen);

    const notices = new Map<NetSession, NetNotice[]>();
    for (const session of [host.session, guest.session]) {
      notices.set(session, []);
      session.onNotice = (notice) => notices.get(session)!.push(notice);
    }
    const late = joinSession(hub, 'ROOM1', { name: 'late', color: 'orange' });
    assert.equal(late.session.phase, 'loading', 'told its sync tic, waiting for the snapshot');
    const joined: NetNotice[] = [{ name: 'late', color: 'orange', event: 'joined' }];
    assert.deepEqual(notices.get(host.session), joined, "the sync is everyone else's feed line, in the joiner's colour");
    assert.deepEqual(notices.get(guest.session), joined);
    assert.equal(late.session.slot, 2);
    const syncAt = 10 + 4;
    const capture = (session: NetSession) =>
      session.pendingRestore((joining) => {
        assert.equal(joining?.slot, 2);
        return { map: 'MAP01', state: snapshotFor(3) };
      });
    while (host.session.tic < syncAt) {
      for (const session of [host.session, guest.session]) assert.equal(capture(session), null);
      runTic(hub, [host.session, guest.session], seen);
    }
    const hosts = capture(host.session);
    assert.ok(hosts !== null && hosts !== 'wait');
    host.session.restoreApplied();
    hub.flush();
    assert.equal(late.log.starts.length, 1, 'the joiner builds the level from the snapshot');
    assert.equal(late.log.starts[0].restore?.tic, syncAt);
    assert.deepEqual(late.log.starts[0].restore?.slots.map((s) => s.name), ['host', 'guest', 'late']);
    const guests = capture(guest.session);
    assert.ok(guests !== null && guests !== 'wait');
    guest.session.restoreApplied();
    late.session.attach();
    seen.set(late.session, []);
    assert.equal(host.session.slotCount, 3);
    assert.equal(late.session.tic, syncAt);

    for (let tic = 0; tic < 8; tic++) runTic(hub, [host.session, guest.session, late.session], seen);
    const hostSaw = seen.get(host.session)!;
    const lateSaw = seen.get(late.session)!;
    assert.deepEqual(hostSaw.slice(syncAt), lateSaw, 'the joiner reads what the others read');
    assert.equal(hostSaw[syncAt][2], 0, "the joiner's slot is idle through its first tics");
    assert.equal(hostSaw[syncAt + 2][2], syncAt * 10 + 3, 'and reads its rows from `delay` past the sync');
  });
});
