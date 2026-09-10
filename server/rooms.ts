/**
 * The relay's rooms: who is in which, the code to join one by, and forwarding between members.
 * Pure — no sockets — so `tests/server/rooms.test.ts` and the client's loopback fixture drive it
 * directly; `relay.ts` puts it behind WebSockets. docs/multiplayer-net.md § The relay.
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

/** What the relay itself says to a member. The client's guard is `isRelayMessage` (`src/game/net/defs.ts`). */
export type RelayMessage =
  | { type: 'room'; code: string; member: number; host: boolean; members: number[] }
  | { type: 'joined'; member: number }
  | { type: 'left'; member: number }
  | { type: 'closed' }
  | { type: 'refused'; reason: string };

export interface RoomsOptions {
  /** Members a room holds at most — the engine's `MAX_PLAYERS`; `relay.ts` states 4 and the test pins them equal. */
  capacity: number;
  /** The code a new room gets; injectable so the test can name its rooms. */
  makeCode?: () => string;
}

/** What `join` answers: the room's code and the member's own id, or why not. */
export type JoinResult = { code: string; member: number; host: boolean } | { refusal: string };

export interface Rooms {
  /**
   * Whatever `member` sent: its join while it has no seat, forwarded once it has one. False where
   * the connection is to be closed — a refused join, or a first message that was not one.
   */
  receive(member: RoomMember, message: Record<string, unknown>): boolean;
  /** `member` opens a room (`code` null) or joins one; what it is told is also returned. */
  join(member: RoomMember, code: string | null): JoinResult;
  /** `message` from `member`, sent to every other member of its room with `from` stamped on it. */
  relay(member: RoomMember, message: Record<string, unknown>): void;
  /** `member` is gone: the room hears `left`, and a host leaving closes the whole room. */
  leave(member: RoomMember): void;
  readonly roomCount: number;
}

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
    if (seats.has(member)) {
      relay(member, message);
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

  function leave(member: RoomMember): void {
    const seat = seats.get(member);
    if (!seat) return;
    const { room, id } = seat;
    seats.delete(member);
    room.members.delete(id);
    if (id === 0) {
      // The host is the game's arbiter; without one the room has nothing to run on.
      for (const conn of room.members.values()) {
        say(conn, { type: 'closed' });
        seats.delete(conn);
        conn.close();
      }
      room.members.clear();
    } else {
      for (const conn of room.members.values()) say(conn, { type: 'left', member: id });
    }
    if (room.members.size === 0) rooms.delete(room.code);
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

  return {
    receive,
    join,
    relay,
    leave,
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
