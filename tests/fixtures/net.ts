import { createRooms, type RoomMember, type Rooms } from '../../server/rooms.ts';
import type { Transport } from '../../src/game/net/transport.ts';
import { MAX_PLAYERS } from '../../src/game/playerstarts.ts';
import type { PlayerSettings } from '../../src/game/replay/defs.ts';
import type { PlayerColor } from '../../src/wad/playercolor.ts';
import type { NetGame, NetRestore } from '../../src/game/net/defs.ts';
import { NetSession, withRulesDefaults, type NetHooks } from '../../src/game/net/session.ts';
import type { GameSnapshot } from '../../src/game/snapshot.ts';

/**
 * The network without sockets: a hub over the relay's own room logic, transports that queue what
 * they send until `flush` delivers it, and a session builder whose hooks record what they were
 * asked. Delivery is explicit so a test states where the messages are between two steps.
 * docs/testing.md § The network fixture.
 */

/** A message waiting to be delivered, and to whom. */
interface Delivery {
  to: LoopbackTransport;
  message: unknown;
}

export class LoopbackTransport implements Transport {
  onMessage: ((message: unknown) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  /** Everything this end sent, in order — a test's view of the wire. */
  readonly sent: unknown[] = [];
  private hub: Hub;
  member: RoomMember;
  closed = false;

  constructor(hub: Hub) {
    this.hub = hub;
    this.member = {
      send: (text) => hub.queue.push({ to: this, message: JSON.parse(text) }),
      close: () => this.drop('closed by the relay'),
    };
  }

  send(message: object): void {
    if (this.closed) return;
    this.sent.push(structuredClone(message));
    // The relay's own dispatch; a refused join closes the connection as `relay.ts` does.
    if (!this.hub.rooms.receive(this.member, message as Record<string, unknown>)) this.drop('closed by the relay');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.rooms.leave(this.member);
  }

  /** The relay's side of an end: the connection is gone, and the session hears it. */
  drop(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.queue.push({ to: this, message: { closeReason: reason } });
  }
}

/** The relay: rooms over queued deliveries. `flush` runs the queue until it is empty. */
export class Hub {
  readonly rooms: Rooms;
  readonly queue: Delivery[] = [];

  constructor(codes: string[] = ['ROOM1', 'ROOM2', 'ROOM3']) {
    let next = 0;
    this.rooms = createRooms({ capacity: MAX_PLAYERS, makeCode: () => codes[next++ % codes.length] });
  }

  transport(): LoopbackTransport {
    return new LoopbackTransport(this);
  }

  /** Delivers everything queued, and everything that delivering it queued in turn. */
  flush(): void {
    while (this.queue.length > 0) {
      const { to, message } = this.queue.shift()!;
      if (typeof message === 'object' && message !== null && 'closeReason' in message) {
        to.onClose?.(String((message as { closeReason: unknown }).closeReason));
        continue;
      }
      to.onMessage?.(message);
    }
  }
}

export const SETTINGS: PlayerSettings = { autorun: true, autoSwitchWeapon: true, rightMouse: 'use', cameraMode: 'auto' };

export const GAME: NetGame = {
  set: { map: 'MAP01', wads: [{ name: 'DOOM2.WAD', id: 'iwad' }], mapWad: 'iwad' },
  skill: 3,
};

/** The smallest snapshot `isLoadableState` accepts, with `players` slots. */
export function snapshotFor(players: number): GameSnapshot {
  return { players: Array.from({ length: players }, () => ({ player: {} })), rng: { p: 0, m: 0 } } as unknown as GameSnapshot;
}

/** What a session's hooks were asked, for the assertions. */
export interface HookLog {
  starts: { game: NetGame; restore: NetRestore | null }[];
  ended: string[];
  changes: number;
  /** What `setRefusal` answers, null unless a test says otherwise. */
  refusal: string | null;
}

export function hookLog(): { hooks: NetHooks; log: HookLog; clock: { now: number } } {
  const clock = { now: 0 };
  const log: HookLog = { starts: [], ended: [], changes: 0, refusal: null };
  const hooks: NetHooks = {
    setRefusal: () => log.refusal,
    startGame: (game, restore) => log.starts.push({ game, restore }),
    changed: () => log.changes++,
    ended: (reason) => log.ended.push(reason),
    now: () => clock.now,
  };
  return { hooks, log, clock };
}

/** A hosting session on `hub`, joined by nobody yet; the room message has been delivered. */
export function hostSession(hub: Hub, name = 'host', delay = 3) {
  const { hooks, log, clock } = hookLog();
  const transport = hub.transport();
  const session = NetSession.host(transport, hooks, {
    name,
    color: 'green',
    settings: SETTINGS,
    build: '1.0',
    compat: 1,
    game: GAME,
    session: withRulesDefaults({}),
  });
  hub.flush();
  session.setDelay(delay);
  return { session, transport, log, clock };
}

export interface JoinerOptions {
  name?: string;
  color?: PlayerColor;
  build?: string;
  compat?: number;
  /** What the joiner's set check answers the host's lobby with. */
  refusal?: string | null;
}

/** A session joining `code` on `hub`, its hello delivered and the host's lobby answered. */
export function joinSession(hub: Hub, code: string, options: JoinerOptions = {}) {
  const { name = 'guest', color = 'green', build = '1.0', compat = 1, refusal = null } = options;
  const { hooks, log, clock } = hookLog();
  log.refusal = refusal;
  const transport = hub.transport();
  const session = NetSession.join(transport, hooks, { name, color, settings: SETTINGS, build, compat, code });
  hub.flush();
  return { session, transport, log, clock };
}
