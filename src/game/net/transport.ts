/**
 * The connection a `NetSession` talks through: JSON messages in, JSON messages out, and the one
 * signal that the other end is gone. {@link WebSocketTransport} is the real one, over the relay;
 * the tests' loopback in `tests/fixtures/net.ts` is the other. docs/multiplayer-net.md § The relay.
 */
import type { KeepalivePing, KeepalivePong, LatencyReport } from '../../../server/rooms.ts';

export interface Transport {
  send(message: object): void;
  /** Every message the other end sends, already parsed; set by the session, one handler. */
  onMessage: ((message: unknown) => void) | null;
  /** The connection ended, with why — set by the session, one handler, called at most once. */
  onClose: ((reason: string) => void) | null;
  close(): void;
}

/**
 * How often the socket sends its keepalive: under the idle close of a relay behind Cloudflare, and
 * the round trip a relay that cannot ping hears back — tuned by feel.
 */
const PING_MS = 2_000;

const PING: KeepalivePing = 'ping';
const PONG: KeepalivePong = 'pong';

/** Keeps its socket alive and reports its round trip. docs/multiplayer-net.md § Keepalive. */
export class WebSocketTransport implements Transport {
  onMessage: ((message: unknown) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  private socket: WebSocket;
  private closed = false;
  private pinger: ReturnType<typeof setInterval>;
  /** When the oldest unanswered ping went out; null while none is. */
  private pingSentAt: number | null = null;

  /** Resolves once the socket is open, rejects when the relay cannot be reached. */
  static connect(url: string): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(new Error(`cannot open ${url}: ${(err as Error).message}`));
        return;
      }
      socket.addEventListener('open', () => resolve(new WebSocketTransport(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error(`no relay answered at ${url}`)), { once: true });
    });
  }

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      if (event.data === PONG) {
        this.answered();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.onMessage?.(message);
    });
    socket.addEventListener('close', () => this.ended('the connection to the relay closed'));
    socket.addEventListener('error', () => this.ended('the connection to the relay failed'));
    this.pinger = setInterval(() => this.ping(), PING_MS);
  }

  send(message: object): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pinger);
    this.socket.close();
  }

  /**
   * {@link WebSocketTransport.onClose} once, whichever of the two events arrives first, and never
   * after {@link WebSocketTransport.close}.
   */
  private ended(reason: string): void {
    clearInterval(this.pinger);
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }

  /** An unanswered ping keeps its time, so a late answer is timed from the ping it answers. */
  private ping(): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.pingSentAt ??= performance.now();
    this.socket.send(PING);
  }

  private answered(): void {
    if (this.pingSentAt === null) return;
    const ms = performance.now() - this.pingSentAt;
    this.pingSentAt = null;
    this.send({ type: 'latency', ms } satisfies LatencyReport);
  }
}
