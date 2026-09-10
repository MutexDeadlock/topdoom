/**
 * The WebSocket relay: `ws` on `PORT` (8765 by default), each connection one member of one room
 * (`rooms.ts`), every message after the join handed to the room. No game logic lives here — the
 * host browser is the arbiter. `npm run relay` starts it. docs/multiplayer-net.md § The relay.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { createRooms, type RoomMember } from './rooms.ts';

const PORT = Number(process.env.PORT ?? 8765);

/** `MAX_PLAYERS` (`src/game/playerstarts.ts`); `tests/server/rooms.test.ts` pins the two equal. */
const MAX_PLAYERS = 4;

/** A socket answering no ping for two of these is dropped — tuned by feel. */
const PING_MS = 10_000;

/** A level snapshot for a large map is a few megabytes of JSON. */
const MAX_PAYLOAD = 64 * 1024 * 1024;

const rooms = createRooms({ capacity: MAX_PLAYERS });
const server = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD });

server.on('connection', (socket: WebSocket, req) => {
  console.log(`connected: ${req.socket.remoteAddress}`);

  const member: RoomMember = {
    send: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    close: () => socket.close(),
  };
  let alive = true;
  const ping = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, PING_MS);

  socket.on('pong', () => {
    alive = true;
  });
  socket.on('message', (data) => {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if (!rooms.receive(member, message as Record<string, unknown>)) socket.close();
  });
  socket.on('close', () => {
    console.log(`disconnected: ${req.socket.remoteAddress}`);
    clearInterval(ping);
    rooms.leave(member);
  });
  socket.on('error', () => socket.close());
});

console.log(`TopDoom relay listening on ws://localhost:${PORT}`);
