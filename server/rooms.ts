/**
 * The relay's rooms: who is in which, the code to join one by, and forwarding between members.
 * Pure — no sockets — so `tests/server/rooms.test.ts` and the client's loopback fixture drive it
 * directly; `relay.ts` and `cloudflare/worker.ts` put it behind WebSockets.
 * docs/multiplayer-net.md § The relay.
 */

/** One connection, as a room sees it: what it is sent arrives already serialized. */
export interface RoomMember {
  send(text: string): void;
  close(): void;
}

/** A connection's first message: open a room (`code` null) or take a seat in the one `code` names. */
export interface JoinRequest {
  type: 'join';
  code: string | null;
}

/** The host putting `member` out of its room — one of the two messages the relay reads. */
export interface KickRequest {
  type: 'kick';
  member: number;
  /** What the kicked member is told, passed on unread; absent for a plain kick. */
  reason?: string;
}

/**
 * A member's own round trip, told to its room as if the relay had measured it — the other message
 * the relay reads. docs/multiplayer-net.md § Keepalive.
 */
export interface LatencyReport {
  type: 'latency';
  /** Milliseconds from the member's `ping` to the relay's `pong`. */
  ms: number;
}

/**
 * The text a client sends to keep a quiet socket open. Not JSON, so a relay that reads messages
 * drops it unread.
 */
export type KeepalivePing = 'ping';

/** The answer a relay that times a {@link KeepalivePing} sends back. */
export type KeepalivePong = 'pong';

/** What the relay itself says to a member. The client's guard is `isRelayMessage` (`src/game/net/defs.ts`). */
export type RelayMessage =
  | { type: 'room'; code: string; member: number; host: boolean; members: number[] }
  | { type: 'joined'; member: number }
  | { type: 'left'; member: number }
  | { type: 'closed' }
  | { type: 'kicked'; reason?: string }
  | { type: 'refused'; reason: string }
  | { type: 'latency'; member: number; ms: number };

/** Where a seated member sits: enough to seat it again in a relay that has forgotten its rooms. */
export interface RoomSeat {
  code: string;
  member: number;
  /** The id the room's next joiner gets: an id is never handed out twice in one room. */
  next: number;
}

export interface RoomsOptions {
  /** Members a room holds at most — {@link MAX_MEMBERS} outside the tests. */
  capacity: number;
  /** The code a new room gets; injectable so the test can name its rooms. */
  makeCode?: () => string;
}

/** What `join` answers: the room's code and the member's own id, or why not. */
export type JoinResult = { code: string; member: number; host: boolean } | { refusal: string };

export interface Rooms {
  /**
   * Whatever `member` sent: its join while it has no seat, forwarded once it has one — a kick and a
   * latency report excepted. False where the connection is to be closed: a refused join, or
   * anything but a join or a latency report before a seat.
   */
  receive(member: RoomMember, message: Record<string, unknown>): boolean;
  /** `member` opens a room (`code` null) or joins one; what it is told is also returned. */
  join(member: RoomMember, code: string | null): JoinResult;
  /** `message` from `member`, sent to every other member of its room with `from` stamped on it. */
  relay(member: RoomMember, message: Record<string, unknown>): void;
  /**
   * The host `member` puts member `target` out: `target` hears `kicked` with `reason` and is closed,
   * the rest hear it leave. From anyone but the host, or at the host itself, nothing happens.
   */
  kick(member: RoomMember, target: number, reason?: string): void;
  /** `member` is gone: the room hears `left`, and a host leaving closes the whole room. */
  leave(member: RoomMember): void;
  /**
   * The round trip `member`'s last ping came back in, in milliseconds, told to every member of its
   * room — `member` included. Nothing for a connection with no seat.
   */
  latency(member: RoomMember, ms: number): void;
  /** Where `member` sits; null without a seat. */
  seatOf(member: RoomMember): RoomSeat | null;
  /**
   * Seats each member where its seat says, nobody told — a relay rebuilding its rooms. A room left
   * without its host is closed, as the host leaving closes it.
   */
  restore(seats: readonly { member: RoomMember; seat: RoomSeat }[]): void;
  readonly roomCount: number;
}

/** Members a room holds at most: the engine's `MAX_PLAYERS`, which the rooms test pins equal. */
export const MAX_MEMBERS = 4;

/**
 * Letters a code is drawn from — no `I`, `O`, `0` or `1`, which read as each other when a code is
 * passed on by voice or handwriting.
 */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const CODE_LENGTH = 5;

/** A room's members by id; the host is member 0, the room's first. */
interface Room {
  code: string;
  members: Map<number, RoomMember>;
  nextMember: number;
}

export function createRooms(options: RoomsOptions): Rooms {
  const { capacity, makeCode = randomCode } = options;
  const rooms = new Map<string, Room>();
  const seats = new Map<RoomMember, { room: Room; id: number }>();

  function receive(member: RoomMember, message: Record<string, unknown>): boolean {
    if (message.type === 'latency') {
      if (typeof message.ms === 'number' && Number.isFinite(message.ms)) {
        latency(member, message.ms);
      }
      return true;
    }
    if (seats.has(member)) {
      if (message.type !== 'kick') {
        relay(member, message);
      } else if (typeof message.member === 'number') {
        kick(member, message.member, typeof message.reason === 'string' ? message.reason : undefined);
      }
      return true;
    }
    if (message.type !== 'join') {
      refuse(member, 'join a room first');
      return false;
    }
    const code = typeof message.code === 'string' && message.code.trim() !== '' ? message.code : null;
    return !('refusal' in join(member, code));
  }

  function join(member: RoomMember, code: string | null): JoinResult {
    if (seats.has(member)) return refuse(member, 'already in a room');
    let room: Room;
    if (code === null) {
      room = { code: freshCode(), members: new Map(), nextMember: 0 };
      rooms.set(room.code, room);
    } else {
      const wanted = code.trim().toUpperCase();
      const found = rooms.get(wanted);
      if (!found) return refuse(member, `no room ${wanted}`);
      if (found.members.size >= capacity) return refuse(member, 'that room is full');
      room = found;
    }
    const id = room.nextMember++;
    room.members.set(id, member);
    seats.set(member, { room, id });
    const host = id === 0;
    const members = [...room.members.keys()];
    say(member, { type: 'room', code: room.code, member: id, host, members });
    for (const [other, conn] of room.members) {
      if (other !== id) say(conn, { type: 'joined', member: id });
    }
    return { code: room.code, member: id, host };
  }

  function relay(member: RoomMember, message: Record<string, unknown>): void {
    const seat = seats.get(member);
    if (!seat) return;
    // Serialized once for the whole room: a level snapshot is megabytes of JSON.
    const text = JSON.stringify({ ...message, from: seat.id });
    for (const [other, conn] of seat.room.members) {
      if (other !== seat.id) conn.send(text);
    }
  }

  function kick(member: RoomMember, target: number, reason?: string): void {
    const seat = seats.get(member);
    if (seat?.id !== 0 || target === 0) return;
    const conn = seat.room.members.get(target);
    if (!conn) return;
    say(conn, { type: 'kicked', reason });
    leave(conn);
    conn.close();
  }

  function leave(member: RoomMember): void {
    const seat = seats.get(member);
    if (!seat) return;
    const { room, id } = seat;
    seats.delete(member);
    room.members.delete(id);
    if (id === 0) {
      // The host is the game's arbiter; without one the room has nothing to run on.
      closeRoom(room);
      return;
    }
    for (const conn of room.members.values()) say(conn, { type: 'left', member: id });
  }

  function latency(member: RoomMember, ms: number): void {
    const seat = seats.get(member);
    if (!seat) return;
    const message: RelayMessage = { type: 'latency', member: seat.id, ms: Math.max(0, Math.round(ms)) };
    // Serialized once for the whole room, as `relay` does: every socket's pong lands here.
    const text = JSON.stringify(message);
    for (const conn of seat.room.members.values()) conn.send(text);
  }

  function seatOf(member: RoomMember): RoomSeat | null {
    const seat = seats.get(member);
    if (!seat) return null;
    return { code: seat.room.code, member: seat.id, next: seat.room.nextMember };
  }

  function restore(entries: readonly { member: RoomMember; seat: RoomSeat }[]): void {
    for (const { member, seat } of entries) {
      if (seats.has(member)) continue;
      let room = rooms.get(seat.code);
      if (!room) {
        room = { code: seat.code, members: new Map(), nextMember: 0 };
        rooms.set(seat.code, room);
      }
      room.members.set(seat.member, member);
      room.nextMember = Math.max(room.nextMember, seat.next, seat.member + 1);
      seats.set(member, { room, id: seat.member });
    }
    for (const room of rooms.values()) {
      if (!room.members.has(0)) closeRoom(room);
    }
  }

  function refuse(member: RoomMember, reason: string): JoinResult {
    say(member, { type: 'refused', reason });
    return { refusal: reason };
  }

  function freshCode(): string {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    return code;
  }

  /** Every member still in `room` hears `closed` and is closed; the code is free again. */
  function closeRoom(room: Room): void {
    for (const conn of room.members.values()) {
      say(conn, { type: 'closed' });
      seats.delete(conn);
      conn.close();
    }
    room.members.clear();
    rooms.delete(room.code);
  }

  return {
    receive,
    join,
    relay,
    kick,
    leave,
    latency,
    seatOf,
    restore,
    get roomCount() {
      return rooms.size;
    },
  };
}

function say(member: RoomMember, message: RelayMessage): void {
  member.send(JSON.stringify(message));
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  return code;
}
