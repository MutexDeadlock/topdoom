/**
 * The network: cooperative play across browsers through a relay, in lockstep. This is the layer's
 * public entry — the shapes, the transport, the scheduler and the session are `net/`'s.
 * docs/multiplayer-net.md.
 */
export {
  INPUT_DELAY,
  MAX_INPUT_DELAY,
  MIN_INPUT_DELAY,
  MIN_NAME_LENGTH,
  nameRefusal,
  type LobbyPeer,
  type NetGame,
  type NetRestore,
  type NetRules,
  type SlotAssignment,
} from './net/defs.ts';
export { WebSocketTransport, type Transport } from './net/transport.ts';
export { NetSeat, type NetHost } from './net/seat.ts';
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
