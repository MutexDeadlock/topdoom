/**
 * {@link NetSession}: one browser's seat in a network game — the lobby through the relay, then the
 * lockstep run: every slot's rows served as its input, the local slot's sampled and sent ahead, the
 * host's desync samples, and the snapshot a join or a resync lands on. `game.ts` reads it per tic;
 * `session/room.ts` builds it and answers its hooks. docs/multiplayer-net.md.
 */
import type { TicInput } from '../input.ts';
import { CHECK_INTERVAL, checkCoord, type PlayerSettings } from '../replay/defs.ts';
import { RowInput, copyRow, emptyRow, rowFromWire, rowPose, rowToWire, type TicRow } from '../replay/row.ts';
import { samePlayerSettings, withSessionDefaults } from '../replay/settings.ts';
import type { GameSnapshot } from '../snapshot.ts';
import { MAX_PLAYERS } from '../playerstarts.ts';
import { getRandomCursors } from '../../util/random.ts';
import type { CameraPose } from '../../render/camera.ts';
import type { Pos2 } from '../../types.ts';
import { asPlayerColor, DEFAULT_PLAYER_COLOR, slotColor, type PlayerColor } from '../../wad/playercolor.ts';
import {
  DROP_TIMEOUT_MS,
  INPUT_DELAY,
  STALL_NOTICE_MS,
  asNetGame,
  isPeerMessage,
  isRelayMessage,
  nameRefusal,
  type JoinRequest,
  type KickRequest,
  type LobbyPeer,
  type NetGame,
  type NetNotice,
  type NetRestore,
  type NetRules,
  type PeerMessage,
  type RelayMessage,
  type SlotAssignment,
  type Stamped,
} from './defs.ts';
import { LockstepScheduler } from './lockstep.ts';
import type { Transport } from './transport.ts';

/**
 * Where a session stands: in the room's lobby, the level building after a start or a join
 * (`loading`), running (`playing`), or over (`ended`, with {@link NetSession.endReason}).
 */
export type NetPhase = 'lobby' | 'loading' | 'playing' | 'ended';

/** What the session needs from the page around it — `session/room.ts` answers these. */
export interface NetHooks {
  /** Why this browser cannot play `game`'s set, or null — the menu's own WAD gate. */
  setRefusal(game: NetGame): string | null;
  /**
   * Start the level.
   *
   * @param restore  the host's snapshot for a joiner; null starts fresh at tic 0
   */
  startGame(game: NetGame, restore: NetRestore | null): void;
  /** Something the lobby shows changed. */
  changed(): void;
  /**
   * The room's game is over and the room is back in its lobby — the host's End game, or the
   * campaign's end. A level running in it ends here (docs/multiplayer-net.md § Leaving).
   */
  backInLobby(): void;
  /**
   * The session is over — the room closed, the connection dropped, a refusal — and why. A level
   * running in it ends with it (docs/multiplayer-net.md § Leaving).
   */
  ended(reason: string): void;
  /** The clock the stall notice and the drop timeout read; `performance.now` unless a test says. */
  now?(): number;
}

/** This browser's player, as the lobby introduces them. */
export interface NetIdentity {
  name: string;
  /** The armour colour the player picked — docs/sprites.md § Player colours. */
  color: PlayerColor;
  settings: PlayerSettings;
  /** `VERSION` and `COMPAT`: a peer on other game rules is refused, one on another build noted. */
  build: string;
  compat: number;
}

export interface HostOptions extends NetIdentity {
  game: NetGame;
  session: NetRules;
}

export interface JoinOptions extends NetIdentity {
  code: string;
}

/** What the host captures for a snapshot: the level as a save holds it, on its map. */
export interface NetCapture {
  map: string;
  state: GameSnapshot;
}

/** One slot as the roster shows it during a game. */
export interface RosterEntry {
  slot: number;
  /** The relay member playing it, null once its player is gone. */
  member: number | null;
  name: string;
  color: PlayerColor;
  /** False for a slot whose player is gone — it stands idle in the level. */
  present: boolean;
  local: boolean;
  /**
   * The player's round trip to the relay in milliseconds, as the relay last measured it; null
   * before its first report, from a relay that sends none, and once the player is gone.
   */
  pingMs: number | null;
}

/**
 * `partial` as whole {@link NetRules}: a lobby from before the netgame rules carries only two
 * session settings, and reads as coop with none. docs/multiplayer-deathmatch.md § Settings.
 */
export function withRulesDefaults(partial: Partial<NetRules>): NetRules {
  return { ...withSessionDefaults(partial), deathmatch: partial.deathmatch ?? false };
}

/** What a slot with no row this tic reads — nothing held, nothing aimed. */
const IDLE_ROW: TicRow = emptyRow();

/**
 * A resync or a join, landing at {@link PendingSync.atTic}; {@link PendingSync.sent} is the host's:
 * the snapshot went out.
 */
interface PendingSync {
  atTic: number;
  joining: SlotAssignment | null;
  sent: boolean;
}

/** One desync sample: the random cursor and every slot's rounded position at a tic. */
interface CheckSample {
  cursor: number;
  x: number[];
  y: number[];
}

export class NetSession {
  phase: NetPhase = 'lobby';
  /** Why the session ended, once it has. */
  endReason: string | null = null;
  code: string | null = null;
  /** The lobby's players, the host first — the host's list, mirrored to everyone. */
  peers: LobbyPeer[] = [];
  game: NetGame | null;
  /** The host's session settings; every peer runs under them. */
  session: NetRules;
  delay: number;
  /** The tic the first check sample disagreed at since the last snapshot, or null. */
  desyncedAt: number | null = null;
  /**
   * Hears a line for the level's feed — a player joining or leaving the running game — while a
   * `NetSeat` sits on this session; null between levels, when there is no feed to tell.
   * docs/multiplayer-net.md § Joining a game, § Leaving.
   */
  onNotice: ((notice: NetNotice) => void) | null = null;

  private transport: Transport;
  private hooks: NetHooks;
  private me: NetIdentity;
  private member = -1;
  private host = false;
  /** Whether the host's game is running — what a lobby shows a joiner, and what queues a join. */
  private playing = false;
  private assignments: SlotAssignment[] = [];
  private mySlot = -1;
  private scheduler: LockstepScheduler | null = null;
  private inputs: RowInput[] = [];
  private lastSentSettings: PlayerSettings | null = null;
  private pendingSync: PendingSync | null = null;
  private restoreAt: NetRestore | null = null;
  /** Members that reported ready while the game runs, waiting for a sync of their own. */
  private joinQueue: number[] = [];
  /** Members the host refused for running other game rules — a verdict no set check lifts. */
  private otherRules = new Set<number>();
  /** A peer's last answer on the host's set, so an unchanged one is not sent again. */
  private lastRefusal: string | null = null;
  /** The host's samples by tic (a peer's), and the peer's own until the host's arrives. */
  private hostChecks = new Map<number, CheckSample>();
  private ownChecks = new Map<number, CheckSample>();
  private desyncReported = false;
  /** Each member's last round trip to the relay, in milliseconds — the relay's `latency`. */
  private latencies = new Map<number, number>();
  private stalledSince: number | null = null;
  private now: () => number;

  /** Opens a room on `transport` and sits in it as its host. */
  static host(transport: Transport, hooks: NetHooks, options: HostOptions): NetSession {
    const session = new NetSession(transport, hooks, options, options.game, options.session, INPUT_DELAY);
    transport.send({ type: 'join', code: null } satisfies JoinRequest);
    return session;
  }

  /** Joins the room {@link JoinOptions.code} names on `transport`. */
  static join(transport: Transport, hooks: NetHooks, options: JoinOptions): NetSession {
    const session = new NetSession(transport, hooks, options, null, withRulesDefaults({}), INPUT_DELAY);
    // The relay reads the code the way it was typed: blank, spaced or lowercase.
    transport.send({ type: 'join', code: options.code } satisfies JoinRequest);
    return session;
  }

  private constructor(
    transport: Transport,
    hooks: NetHooks,
    me: NetIdentity,
    game: NetGame | null,
    session: NetRules,
    delay: number,
  ) {
    this.transport = transport;
    this.hooks = hooks;
    this.me = me;
    this.game = game;
    this.session = session;
    this.delay = delay;
    this.now = hooks.now ?? (() => performance.now());
    transport.onMessage = (message) => this.receive(message);
    transport.onClose = (reason) => this.end(reason);
  }

  get isHost(): boolean {
    return this.host;
  }

  /** The slot this browser plays, once a game is set up. */
  get slot(): number {
    return this.mySlot;
  }

  get slotCount(): number {
    return this.assignments.length;
  }

  /** The tic about to run. */
  get tic(): number {
    return this.scheduler?.tic ?? 0;
  }

  /** Whether this browser is in the room's game: its level loading or running. */
  get gameRunning(): boolean {
    return this.phase === 'loading' || this.phase === 'playing';
  }

  /**
   * Whether the host may start: someone besides the host is in the room, and everyone can play the
   * set. docs/multiplayer-net.md § The session.
   */
  get canStart(): boolean {
    if (!this.host || this.phase !== 'lobby' || this.game === null || this.peers.length < 2) return false;
    return this.peers.every((peer) => peer.ready === true);
  }

  /** The slots of the running game, for the tab's list. */
  roster(): RosterEntry[] {
    return this.assignments.map((a) => ({
      slot: a.slot,
      member: a.member,
      name: a.name,
      color: a.color,
      present: a.member !== null,
      local: a.slot === this.mySlot,
      pingMs: a.member === null ? null : (this.latencies.get(a.member) ?? null),
    }));
  }

  /**
   * The player settings `slot` runs under: one record per slot, changed in place as the rows'
   * settings events land, so the reference `Game` holds follows them.
   */
  settingsOf(slot: number): PlayerSettings | undefined {
    return this.assignments[slot]?.settings;
  }

  /** The armour colour `slot`'s player picked — docs/sprites.md § Player colours. */
  colorOf(slot: number): PlayerColor | undefined {
    return this.assignments[slot]?.color;
  }

  /**
   * The host's pick, handed to the room again in the lobby: what is played and the session settings
   * it runs under. Another set or skill has every peer check it again — a check, never a vote; an
   * unchanged pick sends nothing.
   *
   * @returns whether anything changed
   */
  setGame(game: NetGame, session: NetRules): boolean {
    if (!this.host || this.phase !== 'lobby') return false;
    const gameChanged = JSON.stringify(game) !== JSON.stringify(this.game);
    if (!gameChanged && JSON.stringify(session) === JSON.stringify(this.session)) return false;
    this.game = game;
    this.session = { ...session };
    for (const peer of this.peers) {
      if (!gameChanged || peer.member === this.member || this.otherRules.has(peer.member)) continue;
      peer.ready = null;
      peer.refusal = null;
    }
    this.broadcastLobby();
    return true;
  }

  setDelay(delay: number): void {
    if (!this.host || this.phase !== 'lobby') return;
    this.delay = delay;
    this.broadcastLobby();
  }

  /**
   * This browser's player picks another armour colour in the lobby: the host's own row takes it, a
   * joiner's goes to the host, and the room sees it in the next `lobby`. A game under way keeps the
   * colours it started with. docs/multiplayer-net.md § Protocol.
   */
  setColor(color: PlayerColor): void {
    if (this.phase !== 'lobby' || color === this.me.color) return;
    this.me = { ...this.me, color };
    // Not seated by the relay yet: `hello`, or the host's own first row, carries it.
    if (this.member < 0) return;
    if (this.host) this.recolor(this.member, color);
    else this.transport.send({ type: 'color', color } satisfies PeerMessage);
  }

  /** The host starts the game for everyone in the room. */
  start(): void {
    if (!this.canStart) return;
    const slots: SlotAssignment[] = this.peers.map((peer, slot) => ({
      slot,
      member: peer.member,
      name: peer.name,
      color: peer.color,
      settings: peer.settings,
    }));
    const message: PeerMessage = { type: 'start', slots, session: this.session, delay: this.delay };
    this.transport.send(message);
    this.handle({ ...message, from: this.member });
  }

  /**
   * The host ends the running game — its End game, or the campaign's end — and takes the room back
   * to its lobby on every browser. docs/multiplayer-net.md § Leaving.
   */
  endGame(): void {
    if (!this.host || !this.gameRunning) return;
    this.transport.send({ type: 'ended' });
    this.handle({ type: 'ended', from: this.member });
  }

  /** Leaves the room; nothing is reported back, the caller knows. */
  leave(): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.endReason = null;
    this.transport.close();
  }

  /**
   * The session is over for `reason` — the room closed, the connection dropped, a refusal, a
   * snapshot these WADs cannot play: the room is left and {@link NetHooks.ended} hears why.
   */
  end(reason: string): void {
    if (this.phase === 'ended') return;
    this.leave();
    this.endReason = reason;
    this.hooks.ended(reason);
  }

  /** The host puts `member` out of the room; the relay's `left` for it does the rest (§ Leaving). */
  kick(member: number): void {
    if (!this.host || this.phase === 'ended' || member === this.member) return;
    this.transport.send({ type: 'kick', member } satisfies KickRequest);
  }

  /**
   * A peer's WADs changed — a file added from disk or the library: its answer on the host's set is
   * asked again, and sent where it differs from the last one.
   */
  recheckSet(): void {
    if (this.host || this.phase !== 'lobby' || !this.game) return;
    const refusal = this.hooks.setRefusal(this.game);
    if (refusal === this.lastRefusal) return;
    this.lastRefusal = refusal;
    this.transport.send({ type: 'ready', refusal } satisfies PeerMessage);
  }

  // The game's side, per tic. docs/multiplayer-net.md § What a tic does.

  /** The level is built and running: the lobby's `loading` is over. */
  attach(): void {
    if (this.phase === 'loading') this.phase = 'playing';
    this.hooks.changed();
  }

  /** Slot `slot`'s input: its row for the tic about to run. */
  input(slot: number): TicInput {
    return this.inputs[slot];
  }

  /** The camera `slot`'s row was read at, or null where the slot is idle this tic. */
  poseAt(slot: number): CameraPose | null {
    const row = this.scheduler?.rowAt(slot);
    return row ? rowPose(row) : null;
  }

  /**
   * Whether the tic about to run has every row it needs. Not: the frame holds, and the host drops
   * a peer that has sent nothing for {@link DROP_TIMEOUT_MS}.
   */
  readyForTic(): boolean {
    const scheduler = this.scheduler;
    if (!scheduler) return false;
    if (scheduler.readyFor()) {
      this.stalledSince = null;
      return true;
    }
    const now = this.now();
    this.stalledSince ??= now;
    if (this.host && now - this.stalledSince > DROP_TIMEOUT_MS) {
      for (const slot of scheduler.missingAt()) this.drop(slot);
      this.stalledSince = null;
      return scheduler.readyFor();
    }
    return false;
  }

  /** What the player is told about a wait that has gone on long enough to notice, or null. */
  stallNotice(): string | null {
    const scheduler = this.scheduler;
    if (!scheduler || this.stalledSince === null || this.now() - this.stalledSince < STALL_NOTICE_MS) return null;
    const missing = scheduler.missingAt();
    if (missing.length === 0) return this.pendingSync ? 'waiting for the host…' : null;
    const joining = this.pendingSync?.joining;
    if (joining && missing.length === 1 && missing[0] === joining.slot) return `${joining.name} is joining…`;
    return `waiting for ${missing.map((slot) => this.nameOf(slot)).join(', ')}…`;
  }

  /**
   * A sync landing on the tic about to run, if one is due: the host captures the level through
   * `capture` and sends it, everyone restores it. A moment the host cannot capture (an intermission
   * up) moves the sync ahead and lets the tics run on.
   *
   * @returns `'wait'` while the snapshot is still on its way, null when nothing is due and the tic
   *          may simply run
   */
  pendingRestore(capture: (joining: SlotAssignment | null) => NetCapture | null): NetRestore | 'wait' | null {
    const sync = this.pendingSync;
    if (!sync || !this.scheduler || sync.atTic !== this.scheduler.tic) return null;
    if (this.host && !sync.sent) {
      const captured = capture(sync.joining);
      if (!captured) {
        this.scheduleSync(sync.joining);
        return null;
      }
      const slots = this.assignments.map((a) => ({ ...a }));
      if (sync.joining) slots[sync.joining.slot] = sync.joining;
      const restore: NetRestore = { tic: sync.atTic, map: captured.map, state: captured.state, slots };
      this.transport.send({ type: 'snapshot', restore } satisfies PeerMessage);
      this.restoreAt = restore;
      sync.sent = true;
    }
    const restore = this.restoreAt;
    return restore && restore.tic === sync.atTic ? restore : 'wait';
  }

  /** The restore {@link NetSession.pendingRestore} handed over is in: the run continues from it. */
  restoreApplied(): void {
    const restore = this.restoreAt;
    if (restore) this.applyAssignments(restore.slots);
    this.scheduler?.seek(restore?.tic ?? this.tic);
    this.restoreAt = null;
    this.pendingSync = null;
    this.clearChecks();
    this.hooks.changed();
    if (this.host) this.processJoinQueue();
  }

  /**
   * Ahead of the tic: the local row — sampled by the game from its live input, under the menu's
   * player settings — goes out for `tic + delay` and into the table, the settings events and rows
   * due this tic reach every slot's input, and the desync sample is taken where one is due.
   *
   * @param bodies  every slot's body, by slot
   */
  beginTic(row: TicRow, settings: PlayerSettings, bodies: readonly Pos2[]): void {
    const scheduler = this.scheduler;
    if (!scheduler) return;
    const target = scheduler.tic + this.delay;
    const changed = this.lastSentSettings === null || !samePlayerSettings(settings, this.lastSentSettings);
    if (changed) this.lastSentSettings = { ...settings };
    const wire = rowToWire(row);
    const carried = changed ? this.lastSentSettings! : undefined;
    this.transport.send({ type: 'input', slot: this.mySlot, tic: target, row: wire, settings: carried } satisfies PeerMessage);
    scheduler.push(this.mySlot, target, rowFromWire(wire), carried);

    for (let slot = 0; slot < this.inputs.length; slot++) {
      const moved = scheduler.settingsAt(slot);
      if (moved) {
        Object.assign(this.assignments[slot].settings, moved);
        this.inputs[slot].rightMouse = moved.rightMouse;
      }
      copyRow(scheduler.rowAt(slot) ?? IDLE_ROW, this.inputs[slot].row);
    }
    if (scheduler.tic % CHECK_INTERVAL === 0) this.sample(scheduler.tic, bodies);
  }

  /** The tic ran: the cursor moves on. */
  endTic(): void {
    this.scheduler?.advance();
  }

  private receive(message: unknown): void {
    if (this.phase === 'ended') return;
    if (isRelayMessage(message)) {
      this.handleRelay(message);
      return;
    }
    if (isPeerMessage(message)) this.handle(message);
  }

  private handleRelay(m: RelayMessage): void {
    switch (m.type) {
      case 'room':
        this.member = m.member;
        this.host = m.host;
        this.code = m.code;
        if (this.host) {
          this.peers = [this.selfPeer()];
        } else {
          this.transport.send({
            type: 'hello',
            name: this.me.name,
            color: this.me.color,
            settings: this.me.settings,
            build: this.me.build,
            compat: this.me.compat,
          } satisfies PeerMessage);
        }
        this.hooks.changed();
        return;
      case 'joined':
        return;
      case 'left':
        this.memberLeft(m.member);
        return;
      case 'closed':
        this.end('the host closed the room');
        return;
      case 'kicked':
        this.end(m.reason ?? 'the host kicked you from the room');
        return;
      case 'refused':
        this.end(m.reason);
        return;
      case 'latency':
        this.latencies.set(m.member, m.ms);
        return;
    }
  }

  private handle(message: Stamped<PeerMessage>): void {
    switch (message.type) {
      case 'hello':
        if (this.host) this.hello(message);
        return;
      case 'lobby':
        if (this.host) return;
        this.lobby(message);
        return;
      case 'ready':
        if (this.host) this.ready(message.from, message.refusal);
        return;
      case 'color':
        if (this.host) this.recolor(message.from, message.color);
        return;
      case 'start':
        this.started(message.slots, message.session, message.delay);
        return;
      case 'input':
        this.scheduler?.push(message.slot, message.tic, rowFromWire(message.row), message.settings);
        return;
      case 'check':
        if (!this.host) this.compare(message.tic, { cursor: message.cursor, x: message.x, y: message.y });
        return;
      case 'desync':
        if (this.host && !this.pendingSync) {
          this.scheduleSync(null);
        }
        return;
      case 'sync':
        this.sync(message.atTic, message.joining);
        return;
      case 'snapshot':
        this.snapshot(message.restore);
        return;
      case 'drop':
        this.dropped(message.slot, message.atTic);
        return;
      case 'ended':
        this.gameEnded();
        return;
    }
  }

  private hello(message: Stamped<Extract<PeerMessage, { type: 'hello' }>>): void {
    const { from, name, settings, build, compat } = message;
    // A name the room cannot tell apart is refused its seat outright, where a build is only marked.
    const others = this.peers.filter((p) => p.member !== from).map((p) => p.name);
    const unnamed = nameRefusal(name, others);
    if (unnamed) {
      this.transport.send({ type: 'kick', member: from, reason: unnamed } satisfies KickRequest);
      return;
    }
    const refusal =
      compat !== this.me.compat ? `runs other game rules (build v${build}); this game runs v${this.me.build}` : null;
    // A build without colours still takes a seat, in the default one.
    const color = asPlayerColor(message.color, DEFAULT_PLAYER_COLOR);
    const peer: LobbyPeer = { member: from, name, color, settings, build, ready: refusal ? false : null, refusal };
    if (refusal) this.otherRules.add(from);
    else this.otherRules.delete(from);
    const known = this.peers.findIndex((p) => p.member === from);
    if (known >= 0) this.peers[known] = peer;
    else this.peers.push(peer);
    this.broadcastLobby();
  }

  private lobby(message: Extract<PeerMessage, { type: 'lobby' }>): void {
    const game = asNetGame(message.game);
    const changed = this.game === null || JSON.stringify(this.game) !== JSON.stringify(game);
    this.game = game;
    this.session = withRulesDefaults(message.session);
    this.delay = message.delay;
    this.peers = message.peers.map((peer) => ({ ...peer, color: asPlayerColor(peer.color, DEFAULT_PLAYER_COLOR) }));
    this.playing = message.playing;
    if (changed) {
      this.lastRefusal = this.hooks.setRefusal(game);
      this.transport.send({ type: 'ready', refusal: this.lastRefusal } satisfies PeerMessage);
    }
    this.hooks.changed();
  }

  private ready(member: number, refusal: string | null): void {
    const peer = this.peers.find((p) => p.member === member);
    if (!peer) return;
    // The host's own verdict on the peer's build stands over whatever the peer says of the set.
    if (!this.otherRules.has(member)) {
      peer.refusal = refusal;
      peer.ready = refusal === null;
    }
    this.broadcastLobby();
    if (this.playing && peer.ready && !this.joinQueue.includes(member)) {
      this.joinQueue.push(member);
      this.processJoinQueue();
    }
  }

  /**
   * `member`'s new colour, on the host — read through {@link asPlayerColor}, so one this build
   * doesn't know keeps the old. A member seated in the running game keeps its starting colour.
   */
  private recolor(member: number, color: PlayerColor): void {
    const peer = this.peers.find((p) => p.member === member);
    if (!peer) return;
    if (this.playing && this.assignments.some((a) => a.member === member)) {
      return;
    }
    const next = asPlayerColor(color, peer.color);
    if (next === peer.color) return;
    peer.color = next;
    this.broadcastLobby();
  }

  private started(slots: SlotAssignment[], session: NetRules, delay: number): void {
    if (!this.game) return;
    this.session = withRulesDefaults(session);
    this.delay = delay;
    this.playing = true;
    this.scheduler = new LockstepScheduler({ delay, slots: slots.length });
    this.applyAssignments(slots);
    this.phase = 'loading';
    this.hooks.changed();
    this.hooks.startGame(this.game, null);
  }

  private sync(atTic: number, joining: SlotAssignment | null): void {
    this.pendingSync = { atTic, joining, sent: false };
    if (joining && joining.member === this.member) {
      // My own way in: a table from the sync tic, my rows idle until the snapshot has landed.
      this.mySlot = joining.slot;
      if (this.scheduler) this.scheduler.seek(atTic);
      else this.scheduler = new LockstepScheduler({ delay: this.delay, slots: 0, startTic: atTic });
      this.scheduler.ensureSlot(joining.slot, atTic + this.delay);
      this.phase = 'loading';
      this.hooks.changed();
      return;
    }
    if (joining) {
      this.scheduler?.ensureSlot(joining.slot, atTic + this.delay);
      this.onNotice?.({ name: joining.name, color: joining.color, event: 'joined' });
    }
  }

  private snapshot(restore: NetRestore): void {
    this.restoreAt = restore;
    const joining = this.pendingSync?.joining;
    if (!joining || joining.member !== this.member || !this.game) return;
    // The joiner: the level is built from this rather than restored into.
    const scheduler = this.scheduler!;
    for (const a of restore.slots) {
      if (a.member === null && a.slot !== joining.slot) {
        scheduler.ensureSlot(a.slot, Infinity);
      }
    }
    this.applyAssignments(restore.slots);
    this.pendingSync = null;
    this.restoreAt = null;
    this.playing = true;
    this.hooks.startGame(this.game, restore);
  }

  private dropped(slot: number, atTic: number): void {
    this.scheduler?.markLeft(slot, atTic);
    const assignment = this.assignments[slot];
    if (assignment) assignment.member = null;
    if (slot === this.mySlot && this.phase !== 'lobby') {
      this.end('dropped from the game: nothing you pressed reached the others for too long');
      return;
    }
    if (this.playing) {
      this.onNotice?.({ name: this.nameOf(slot), color: this.colorOf(slot) ?? slotColor(slot), event: 'left' });
    }
    this.hooks.changed();
  }

  private gameEnded(): void {
    this.playing = false;
    this.scheduler = null;
    this.pendingSync = null;
    this.restoreAt = null;
    this.joinQueue.length = 0;
    this.clearChecks();
    this.stalledSince = null;
    this.phase = 'lobby';
    this.hooks.backInLobby();
    this.hooks.changed();
  }

  /** Forgets every desync check and verdict: a restore, or a game ended, compares from scratch. */
  private clearChecks(): void {
    this.hostChecks.clear();
    this.ownChecks.clear();
    this.desyncedAt = null;
    this.desyncReported = false;
  }

  private memberLeft(member: number): void {
    this.joinQueue = this.joinQueue.filter((m) => m !== member);
    this.otherRules.delete(member);
    this.latencies.delete(member);
    if (!this.host) return;
    const slot = this.assignments.findIndex((a) => a.member === member);
    if (this.playing && slot >= 0) {
      this.drop(slot);
    }
    this.peers = this.peers.filter((p) => p.member !== member);
    this.broadcastLobby();
  }

  /** The host drops `slot` from the tic its rows stop being read at. */
  private drop(slot: number): void {
    if (!this.scheduler || this.scheduler.hasLeft(slot)) return;
    const atTic = this.scheduler.dropTicFor(slot);
    this.transport.send({ type: 'drop', slot, atTic } satisfies PeerMessage);
    this.dropped(slot, atTic);
  }

  /** The host announces a sync `2 × delay` ahead of its own tic, which no peer has reached. */
  private scheduleSync(joining: SlotAssignment | null): void {
    const atTic = this.tic + 2 * this.delay;
    this.transport.send({ type: 'sync', atTic, joining } satisfies PeerMessage);
    this.sync(atTic, joining);
  }

  /** The next member waiting to join a running game, once no sync is in flight. */
  private processJoinQueue(): void {
    if (this.pendingSync || !this.playing) return;
    const member = this.joinQueue.shift();
    if (member === undefined) return;
    const peer = this.peers.find((p) => p.member === member);
    if (!peer) {
      this.processJoinQueue();
      return;
    }
    let slot = this.assignments.findIndex((a) => a.member === null);
    if (slot < 0) slot = this.assignments.length;
    if (slot >= MAX_PLAYERS) return;
    this.scheduleSync({ slot, member, name: peer.name, color: peer.color, settings: peer.settings });
  }

  /** The slots as announced: names and settings by slot, an input each; the table grows with them. */
  private applyAssignments(slots: SlotAssignment[]): void {
    this.assignments = slots.map((a) => ({
      ...a,
      color: asPlayerColor(a.color, DEFAULT_PLAYER_COLOR),
      settings: { ...a.settings },
    }));
    for (const a of this.assignments) {
      if (!this.inputs[a.slot]) this.inputs[a.slot] = new RowInput({ rightMouse: a.settings.rightMouse });
      else this.inputs[a.slot].rightMouse = a.settings.rightMouse;
      if (a.member === this.member) this.mySlot = a.slot;
    }
    this.inputs.length = this.assignments.length;
    // A copy: the assignment's own record changes in place when a row's settings land.
    const mine = this.assignments[this.mySlot];
    this.lastSentSettings = mine ? { ...mine.settings } : null;
  }

  /** The host's sample goes out; a peer's is compared with the host's, whichever arrived first. */
  private sample(tic: number, bodies: readonly Pos2[]): void {
    const sample: CheckSample = {
      cursor: getRandomCursors().p,
      x: bodies.map((body) => checkCoord(body.x)),
      y: bodies.map((body) => checkCoord(body.y)),
    };
    if (this.host) {
      this.transport.send({ type: 'check', tic, ...sample } satisfies PeerMessage);
      return;
    }
    const theirs = this.hostChecks.get(tic);
    if (theirs) {
      this.hostChecks.delete(tic);
      this.verdict(tic, sample, theirs);
    } else {
      this.ownChecks.set(tic, sample);
    }
    this.prune(this.ownChecks, tic);
  }

  private compare(tic: number, theirs: CheckSample): void {
    const mine = this.ownChecks.get(tic);
    if (mine) {
      this.ownChecks.delete(tic);
      this.verdict(tic, mine, theirs);
    } else if (tic >= this.tic) {
      this.hostChecks.set(tic, theirs);
    }
    this.prune(this.hostChecks, tic);
  }

  /** The first disagreement since the last snapshot is reported to the host once. */
  private verdict(tic: number, mine: CheckSample, theirs: CheckSample): void {
    const agree =
      mine.cursor === theirs.cursor &&
      mine.x.length === theirs.x.length &&
      mine.x.every((x, i) => x === theirs.x[i] && mine.y[i] === theirs.y[i]);
    if (agree || this.desyncReported) return;
    this.desyncedAt = tic;
    this.desyncReported = true;
    this.transport.send({ type: 'desync', tic } satisfies PeerMessage);
    this.hooks.changed();
  }

  /** Samples nobody will compare any more: ten seconds behind the one just taken. */
  private prune(samples: Map<number, CheckSample>, tic: number): void {
    for (const at of samples.keys()) {
      if (at < tic - 10 * CHECK_INTERVAL) samples.delete(at);
    }
  }

  private broadcastLobby(): void {
    if (!this.host || !this.game) return;
    this.transport.send({
      type: 'lobby',
      game: this.game,
      session: this.session,
      delay: this.delay,
      peers: this.peers,
      playing: this.playing,
    } satisfies PeerMessage);
    this.hooks.changed();
  }

  private selfPeer(): LobbyPeer {
    return {
      member: this.member,
      name: this.me.name,
      color: this.me.color,
      settings: this.me.settings,
      build: this.me.build,
      ready: true,
      refusal: null,
    };
  }

  private nameOf(slot: number): string {
    return this.assignments[slot]?.name ?? `player ${slot + 1}`;
  }
}
