/**
 * The relay on Cloudflare: a Worker handing every WebSocket to one Durable Object, which holds
 * every room (`../rooms.ts`) over the hibernation API. `npm --prefix server run deploy` puts it up.
 * docs/multiplayer-net.md § The relay on Cloudflare.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  createRooms,
  MAX_MEMBERS,
  type KeepalivePing,
  type KeepalivePong,
  type RoomMember,
  type Rooms,
  type RoomSeat,
} from '../rooms.ts';

interface Env {
  RELAY: DurableObjectNamespace<Relay>;
}

/** The one object every connection lands in: a room's code arrives only in the first message. */
const RELAY_NAME = 'relay';

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('TopDoom relay: connect with a WebSocket.\n', { status: 426 });
    }
    return env.RELAY.getByName(RELAY_NAME).fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Every room, rebuilt from its sockets' attachments whenever the object wakes: hibernating keeps
 * the connections and forgets everything else.
 */
export class Relay extends DurableObject<Env> {
  private rooms: Rooms = createRooms({ capacity: MAX_MEMBERS });
  private members = new Map<WebSocket, RoomMember>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    const ping: KeepalivePing = 'ping';
    const pong: KeepalivePong = 'pong';
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong));
    const seats: { member: RoomMember; seat: RoomSeat }[] = [];
    for (const socket of ctx.getWebSockets()) {
      const seat = socket.deserializeAttachment() as RoomSeat | null;
      if (seat) seats.push({ member: this.memberOf(socket), seat });
    }
    this.rooms.restore(seats);
  }

  fetch(): Response {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const member = this.memberOf(socket);
    const joining = this.rooms.seatOf(member) === null;
    if (!this.rooms.receive(member, message as Record<string, unknown>)) member.close();
    // A join moves its room's next id on, which every seat in the room carries.
    if (joining) this.keepSeats();
  }

  webSocketClose(socket: WebSocket): void {
    this.drop(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.drop(socket);
  }

  private memberOf(socket: WebSocket): RoomMember {
    let member = this.members.get(socket);
    if (!member) {
      member = {
        send: (text) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        },
        close: () => {
          socket.serializeAttachment(null);
          closeSocket(socket);
        },
      };
      this.members.set(socket, member);
    }
    return member;
  }

  /** Every socket's attachment is its seat, what the next wake restores. */
  private keepSeats(): void {
    for (const [socket, member] of this.members) socket.serializeAttachment(this.rooms.seatOf(member));
  }

  private drop(socket: WebSocket): void {
    const member = this.members.get(socket);
    if (member) this.rooms.leave(member);
    this.members.delete(socket);
    // `wrangler dev` answers no client's close frame on its own: the client would see 1006 after
    // its own timeout. Where the runtime answers, this close is ignored.
    closeSocket(socket);
  }
}

/** Closes `socket` normally; one already closed throws, and is left as it is. */
function closeSocket(socket: WebSocket): void {
  try {
    socket.close(1000);
  } catch {}
}
