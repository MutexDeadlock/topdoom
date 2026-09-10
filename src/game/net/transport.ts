/**
 * The connection a `NetSession` talks through: JSON messages in, JSON messages out, and the one
 * signal that the other end is gone. `WebSocketTransport` is the real one, over the relay; the
 * tests' loopback in `tests/fixtures/net.ts` is the other. docs/multiplayer-net.md § The relay.
 */

export interface Transport {
  send(message: object): void;
  /** Every message the other end sends, already parsed; set by the session, one handler. */
  onMessage: ((message: unknown) => void) | null;
  /** The connection ended, with why — set by the session, one handler, called at most once. */
  onClose: ((reason: string) => void) | null;
  close(): void;
}

export class WebSocketTransport implements Transport {
  onMessage: ((message: unknown) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  private socket: WebSocket;
  private closed = false;

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
  }

  send(message: object): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }

  /** `onClose` once, whichever of the two events arrives first, and never after `close`. */
  private ended(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}
