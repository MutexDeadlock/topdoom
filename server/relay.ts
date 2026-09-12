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

/**
 * How often every socket is pinged; the round trip of its answer is the player's ping. Tuned by
 * feel.
 */
const PING_MS = 2_000;

/** A socket that has answered no ping for this long is dropped — tuned by feel. */
const SILENT_MS = 20_000;

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
  let answeredAt = performance.now();
  const ping = setInterval(() => {
    if (performance.now() - answeredAt > SILENT_MS) {
      socket.terminate();
      return;
    }
    // The send time rides the ping and comes back on its pong, so a late answer is never timed
    // against a later ping.
    socket.ping(String(performance.now()));
  }, PING_MS);

  socket.on('pong', (data) => {
    const now = performance.now();
    answeredAt = now;
    const sent = Number(String(data));
    if (Number.isFinite(sent)) rooms.latency(member, now - sent);
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
