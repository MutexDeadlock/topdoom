/**
 * The network's shapes: what peers say to each other through the relay, and the lockstep dials.
 * The relay's own messages are `server/rooms.ts`'s, which stamps `from` on every forwarded one; a
 * tic row on the wire is `replay/row.ts`'s. Nothing here knows a socket.
 * docs/multiplayer-net.md § Protocol.
 */
import type { RelayMessage } from '../../../server/rooms.ts';
import { CAMERA_MODES } from '../autocamera.ts';
import { RIGHT_MOUSE_ACTIONS } from '../input.ts';
import type { PlayerSettings, SessionSettings } from '../replay/defs.ts';
import type { SaveWadSet } from '../savegames.ts';
import type { Skill } from '../skill.ts';
import type { GameSnapshot } from '../snapshot.ts';
import type { PlayerColor } from '../../wad/playercolor.ts';
import { asSkill, asWad, isLoadableState, isRecord } from '../savegames.ts';
import { isWireRow, type WireRow } from '../replay/row.ts';
import { sessionFieldsValid } from '../replay/settings.ts';

export type { JoinRequest, KickRequest, RelayMessage } from '../../../server/rooms.ts';

/**
 * Tics between a key going down and the tic it drives, so every peer's row for a tic has arrived
 * before the tic runs — 86 ms, about one round trip on a decent link. **Tuned by feel**; the lobby
 * lets the host pick another within {@link MIN_INPUT_DELAY}..{@link MAX_INPUT_DELAY}.
 * docs/multiplayer-net.md § Lockstep.
 */
export const INPUT_DELAY = 3;
export const MIN_INPUT_DELAY = 1;
export const MAX_INPUT_DELAY = 8;

/** How long a wait for a peer's rows goes unremarked before "waiting for …" — tuned by feel. */
export const STALL_NOTICE_MS = 400;

/**
 * How long the host waits on a peer's rows before dropping it. Long: a joiner is waited for the
 * same way while it builds the level, and a large map takes seconds. Tuned by feel.
 */
export const DROP_TIMEOUT_MS = 30_000;

/** Where the relay runs when nothing else is entered — `npm run relay` on this machine. */
export const DEFAULT_RELAY_URL = 'wss://relay.topdoom.workers.dev';

/** The fewest characters a player's name has, trimmed — tuned by feel. */
export const MIN_NAME_LENGTH = 3;

/**
 * What the host is running, as every peer must match it: the WAD set a save identifies its files
 * by, and the skill — every input to the simulation that is decided before tic 0.
 */
export interface NetGame {
  set: SaveWadSet;
  skill: Skill;
}

/**
 * What a lobby's host sets the room to play under: the {@link SessionSettings} every browser pins
 * per tic, and the mode beside them — {@link NetRules.deathmatch}, which `Game` reads once at the
 * level start and the snapshot keeps ({@link GameSnapshot.deathmatch}), so neither a pin nor a
 * replay carries it. docs/multiplayer-deathmatch.md § Settings.
 */
export interface NetRules extends SessionSettings {
  deathmatch: boolean;
}

/** A player in the lobby, by relay member — what every peer's roster shows. */
export interface LobbyPeer {
  member: number;
  name: string;
  /**
   * The armour colour the player picked (docs/sprites.md § Player colours). {@link isPeerMessage}
   * leaves it unchecked and the session reads it through `asPlayerColor`, so a build without
   * colours still takes a seat.
   */
  color: PlayerColor;
  settings: PlayerSettings;
  build: string;
  /** Whether the peer can play the host's set, null while unanswered; the host's own is ready. */
  ready: boolean | null;
  /**
   * Why it cannot, when {@link LobbyPeer.ready} is false — the peer's own sentence, or the host's
   * over `compat`.
   */
  refusal: string | null;
}

/** One slot as a game starts or a snapshot hands it over: who plays it, under what. */
export interface SlotAssignment {
  slot: number;
  /** The relay member, or null for a slot nobody drives any more. */
  member: number | null;
  name: string;
  /** As {@link LobbyPeer.color}. */
  color: PlayerColor;
  settings: PlayerSettings;
}

/** What the host hands a joiner, and every peer on a resync: the level at one tic. */
export interface NetRestore {
  tic: number;
  map: string;
  state: GameSnapshot;
  slots: SlotAssignment[];
}

/** What peers say to each other; the relay adds `from`. */
export type PeerMessage =
  | { type: 'hello'; name: string; color: PlayerColor; settings: PlayerSettings; build: string; compat: number }
  | {
      type: 'lobby';
      game: NetGame;
      session: NetRules;
      delay: number;
      peers: LobbyPeer[];
      playing: boolean;
    }
  | { type: 'ready'; refusal: string | null }
  | { type: 'color'; color: PlayerColor }
  | { type: 'start'; slots: SlotAssignment[]; session: NetRules; delay: number }
  | { type: 'input'; slot: number; tic: number; row: WireRow; settings?: PlayerSettings }
  | { type: 'check'; tic: number; cursor: number; x: number[]; y: number[] }
  | { type: 'desync'; tic: number }
  | { type: 'sync'; atTic: number; joining: SlotAssignment | null }
  | { type: 'snapshot'; restore: NetRestore }
  | { type: 'drop'; slot: number; atTic: number }
  | { type: 'ended' };

export type Stamped<M> = M & { from: number };

/** Whether `v` is one of the relay's own messages, well enough formed to act on. */
export function isRelayMessage(v: unknown): v is RelayMessage {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case 'room':
      return (
        typeof v.code === 'string' &&
        isIndex(v.member) &&
        typeof v.host === 'boolean' &&
        Array.isArray(v.members) &&
        v.members.every(isIndex)
      );
    case 'joined':
    case 'left':
      return isIndex(v.member);
    case 'closed':
      return true;
    case 'kicked':
      return v.reason === undefined || typeof v.reason === 'string';
    case 'refused':
      return typeof v.reason === 'string';
    case 'latency':
      return isIndex(v.member) && isIndex(v.ms);
    default:
      return false;
  }
}

/**
 * Whether `v` is a peer's message with the relay's stamp, every field a handler reads present and
 * of the right type. A message failing this is dropped, never half-applied.
 */
export function isPeerMessage(v: unknown): v is Stamped<PeerMessage> {
  if (!isRecord(v) || !isIndex(v.from)) return false;
  switch (v.type) {
    case 'hello':
      return (
        typeof v.name === 'string' &&
        isPlayerSettings(v.settings) &&
        typeof v.build === 'string' &&
        typeof v.compat === 'number'
      );
    case 'lobby':
      return (
        isNetGame(v.game) &&
        isNetRules(v.session) &&
        isIndex(v.delay) &&
        Array.isArray(v.peers) &&
        v.peers.every(isLobbyPeer) &&
        typeof v.playing === 'boolean'
      );
    case 'ready':
      return v.refusal === null || typeof v.refusal === 'string';
    case 'color':
      return typeof v.color === 'string';
    case 'start':
      return Array.isArray(v.slots) && v.slots.every(isSlotAssignment) && isNetRules(v.session) && isIndex(v.delay);
    case 'input':
      return (
        isIndex(v.slot) && isIndex(v.tic) && isWireRow(v.row) && (v.settings === undefined || isPlayerSettings(v.settings))
      );
    case 'check':
      return isIndex(v.tic) && typeof v.cursor === 'number' && isNumbers(v.x) && isNumbers(v.y);
    case 'desync':
      return isIndex(v.tic);
    case 'sync':
      return isIndex(v.atTic) && (v.joining === null || isSlotAssignment(v.joining));
    case 'snapshot':
      return isNetRestore(v.restore);
    case 'drop':
      return isIndex(v.slot) && isIndex(v.atTic);
    case 'ended':
      return true;
    default:
      return false;
  }
}

/**
 * `game` with every WAD entry degraded through {@link asWad}, so a damaged one names rather than
 * crashes.
 */
export function asNetGame(game: NetGame): NetGame {
  const { map, wads, mapWad, patchWads } = game.set;
  return {
    set: { map, wads: wads.map(asWad), mapWad, ...(patchWads ? { patchWads } : {}) },
    skill: game.skill,
  };
}

/**
 * Why `name` cannot sit beside `others`, or null: too short, or already one of theirs — trimmed,
 * case-insensitively. The tab asks it before connecting, the host of every `hello`.
 * docs/multiplayer-net.md § The session.
 *
 * @param others  the names of the room's present players
 */
export function nameRefusal(name: string, others: readonly string[]): string | null {
  const wanted = name.trim();
  if ([...wanted].length < MIN_NAME_LENGTH) return `your name needs at least ${MIN_NAME_LENGTH} characters`;
  const key = wanted.toLowerCase();
  if (others.some((other) => other.trim().toLowerCase() === key)) return `someone named ${wanted} is already in this room`;
  return null;
}

function isPlayerSettings(v: unknown): v is PlayerSettings {
  return (
    isRecord(v) &&
    typeof v.autorun === 'boolean' &&
    typeof v.autoSwitchWeapon === 'boolean' &&
    RIGHT_MOUSE_ACTIONS.some((action) => action === v.rightMouse) &&
    CAMERA_MODES.some((mode) => mode === v.cameraMode)
  );
}

/**
 * The netgame rules are optional on the wire, each typed when present — the session settings by
 * {@link sessionFieldsValid}'s table: a lobby from a build before them still seats a newer joiner,
 * who reads it through `withRulesDefaults`. docs/multiplayer-deathmatch.md § Settings.
 */
function isNetRules(v: unknown): v is NetRules {
  return isRecord(v) && sessionFieldsValid(v) && (v.deathmatch === undefined || typeof v.deathmatch === 'boolean');
}

function isNetGame(v: unknown): v is NetGame {
  if (!isRecord(v) || !isRecord(v.set)) return false;
  const { set } = v;
  return (
    typeof set.map === 'string' &&
    Array.isArray(set.wads) &&
    typeof set.mapWad === 'string' &&
    (set.patchWads === undefined || isStrings(set.patchWads)) &&
    asSkill(v.skill) === v.skill
  );
}

function isSlotAssignment(v: unknown): v is SlotAssignment {
  return (
    isRecord(v) &&
    isIndex(v.slot) &&
    (v.member === null || isIndex(v.member)) &&
    typeof v.name === 'string' &&
    isPlayerSettings(v.settings)
  );
}

function isLobbyPeer(v: unknown): v is LobbyPeer {
  return (
    isRecord(v) &&
    isIndex(v.member) &&
    typeof v.name === 'string' &&
    isPlayerSettings(v.settings) &&
    typeof v.build === 'string' &&
    (v.ready === null || typeof v.ready === 'boolean') &&
    (v.refusal === null || typeof v.refusal === 'string')
  );
}

function isNetRestore(v: unknown): v is NetRestore {
  return (
    isRecord(v) &&
    isIndex(v.tic) &&
    typeof v.map === 'string' &&
    isLoadableState(v.state) &&
    Array.isArray(v.slots) &&
    v.slots.every(isSlotAssignment)
  );
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isNumbers(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number');
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}
