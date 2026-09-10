/**
 * The network: cooperative play across browsers through a relay, in lockstep. This is the layer's
 * public entry — the shapes, the transport, the scheduler and the session are `net/`'s.
 * docs/multiplayer-net.md.
 */
export {
  DEFAULT_RELAY_URL,
  INPUT_DELAY,
  MAX_INPUT_DELAY,
  MIN_INPUT_DELAY,
  type LobbyPeer,
  type NetGame,
  type NetRestore,
  type SlotAssignment,
} from './net/defs.ts';
export { WebSocketTransport, type Transport } from './net/transport.ts';
export {
  NetSession,
  type HostOptions,
  type JoinOptions,
  type NetCapture,
  type NetHooks,
  type NetIdentity,
  type NetPhase,
  type RosterEntry,
} from './net/session.ts';
