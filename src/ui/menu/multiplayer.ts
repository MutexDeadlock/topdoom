/**
 * The menu's Multiplayer tab: the relay and name fields, hosting the New Game tab's level or
 * joining a room by code, and the room itself — its code, what is being played, who is in it and
 * whether they can play it, the host's input delay and Start. Pure DOM over a `NetSession`;
 * every failure goes to the menu's status line. docs/multiplayer-net.md § The Multiplayer tab.
 */
import {
  DEFAULT_RELAY_URL,
  MAX_INPUT_DELAY,
  MIN_INPUT_DELAY,
  MIN_NAME_LENGTH,
  nameRefusal,
  type NetSession,
} from '../../game/net.ts';
import { getPlayerName, setPlayerName } from '../../game/replay.ts';
import { wadLabel, type SaveWadSet } from '../../game/savegames.ts';
import { SKILL_NAMES } from '../../game/skill.ts';
import { readStorage, writeStorage } from '../../util/storage.ts';
import { DOOM_TIC, VERSION } from '../../constants.ts';
import { attempt, emptyLine, fillFacts, markChip, noteLine, type StatusLine } from './actions.ts';
import type { SaveSetInfo } from './savegames.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The relay's address, remembered like every setting (docs/menu.md § Persisted settings); the
 * default is the one `npm run relay` listens on.
 */
const RELAY_URL_STORAGE_KEY = 'relayUrl';

/**
 * What the menu's owner (main.ts) does with the tab's requests — the UI never touches the session
 * it is handed beyond reading it. A refusal is a thrown `Error`, shown in the status line.
 */
export interface MultiplayerHooks {
  /** The session in progress, or null. */
  session(): NetSession | null;
  /** Opens a room on the relay at `url` and hosts the New Game tab's level in it. */
  host(url: string, name: string): Promise<void>;
  /** Joins the room `code` names on the relay at `url`. */
  join(url: string, code: string, name: string): Promise<void>;
  /** The host's lobby takes the New Game tab's current pick; whether anything changed. */
  announce(): Promise<boolean>;
  /** The host starts the game. */
  start(): void;
  /** The host puts relay member `member` out of the room. */
  kick(member: number): void;
  /** This browser's WADs changed: a peer's answer on the host's set is asked again. */
  recheckWads(): void;
  /** Leaves the room; a level already running plays on alone. */
  leave(): void;
}

export class MultiplayerUi {
  private connect = el<HTMLElement>('net-connect');
  private room = el<HTMLElement>('net-room');
  private relayInput = el<HTMLInputElement>('net-relay');
  private nameInput = el<HTMLInputElement>('net-name');
  private hostButton = el<HTMLButtonElement>('net-host');
  private codeInput = el<HTMLInputElement>('net-code');
  private joinButton = el<HTMLButtonElement>('net-join');
  private connectHint = el<HTMLSpanElement>('net-connect-hint');
  private codeEl = el<HTMLSpanElement>('net-room-code');
  private phaseEl = el<HTMLSpanElement>('net-phase');
  private facts = el<HTMLDivElement>('net-facts');
  private peers = el<HTMLDivElement>('net-peers');
  private delaySelect = el<HTMLSelectElement>('net-delay');
  private delayRow = el<HTMLElement>('net-delay-row');
  private startButton = el<HTMLButtonElement>('net-start');
  private leaveButton = el<HTMLButtonElement>('net-leave');
  private roomHint = el<HTMLSpanElement>('net-room-hint');
  private tabButton = el<HTMLButtonElement>('tab-button-multiplayer');

  private hooks: MultiplayerHooks;
  private setStatus: StatusLine;
  private describe: (set: SaveWadSet) => SaveSetInfo;
  private visible = false;
  /** A connect in flight: both buttons wait for it rather than opening a second room. */
  private connecting = false;
  /** The New Game tab's pick being read for the room: Start waits for it. */
  private announcing = false;

  constructor(hooks: MultiplayerHooks, setStatus: StatusLine, describe: (set: SaveWadSet) => SaveSetInfo) {
    this.hooks = hooks;
    this.setStatus = setStatus;
    this.describe = describe;
    this.relayInput.value = readStorage(RELAY_URL_STORAGE_KEY, DEFAULT_RELAY_URL);
    this.relayInput.placeholder = DEFAULT_RELAY_URL;
    this.nameInput.value = getPlayerName();
    this.nameInput.placeholder = `at least ${MIN_NAME_LENGTH} characters`;
    // Stored as typed, so a Host or a Join only reads them.
    this.relayInput.addEventListener('input', () => writeStorage(RELAY_URL_STORAGE_KEY, this.relayInput.value.trim()));
    this.nameInput.addEventListener('input', () => setPlayerName(this.nameInput.value));
    // Typed as they are read back: a code is five capitals, and a lowercase one is the same room.
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase();
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.join();
    });
    for (let delay = MIN_INPUT_DELAY; delay <= MAX_INPUT_DELAY; delay++) {
      const option = document.createElement('option');
      option.value = String(delay);
      option.textContent = `${ticsLabel(delay)} (${Math.round(delay * DOOM_TIC * 1000)} ms)`;
      this.delaySelect.append(option);
    }
    this.delaySelect.addEventListener('change', () => {
      this.hooks.session()?.setDelay(Number(this.delaySelect.value));
    });
    this.hostButton.addEventListener('click', () => void this.host());
    this.joinButton.addEventListener('click', () => void this.join());
    this.startButton.addEventListener('click', () => this.hooks.start());
    this.leaveButton.addEventListener('click', () => {
      // The host leaving takes the room with it (docs/multiplayer-net.md § Leaving).
      const hosting = this.hooks.session()?.isHost ?? false;
      this.hooks.leave();
      this.setStatus(hosting ? 'Room closed.' : 'Room left.');
      this.refresh();
    });
  }

  /** Redraws from the session as it stands — every menu open, and every change the session reports. */
  refresh(): void {
    this.refreshTabLight();
    if (!this.visible) return;
    this.render();
  }

  /** Whether the Multiplayer tab is showing — `Menu.setTab`'s hand-off. */
  setVisible(on: boolean): void {
    this.visible = on;
    if (!on) return;
    this.render();
    void this.announce();
  }

  /** A WAD was added or the library rescanned — the menu's hand-off, beside the save rows' refresh. */
  wadsChanged(): void {
    this.hooks.recheckWads();
  }

  private host(): Promise<void> {
    return this.enter((url, name) => this.hooks.host(url, name), 'Room opened — hand the code to the others.');
  }

  private join(): Promise<void> {
    const code = this.codeInput.value.trim().toUpperCase();
    if (code === '') {
      this.setStatus('Enter the room code the host gave you.', true);
      return Promise.resolve();
    }
    return this.enter((url, name) => this.hooks.join(url, code, name), `Joined room ${code}.`);
  }

  /** A Host or a Join: one connect at a time, both buttons waiting on it, the outcome in the status line. */
  private async enter(request: (url: string, name: string) => Promise<void>, done: string): Promise<void> {
    if (this.connecting) return;
    const url = this.relayInput.value.trim() || DEFAULT_RELAY_URL;
    const name = this.nameInput.value.trim();
    // Said before connecting; the host asks the same of the name against the room's.
    const unnamed = nameRefusal(name, []);
    if (unnamed) {
      this.setStatus(unnamed, true);
      this.nameInput.focus();
      return;
    }
    this.connecting = true;
    this.renderConnect();
    this.setStatus(`Connecting to ${url} …`);
    await attempt(this.setStatus, () => request(url, name), done);
    this.connecting = false;
    this.render();
  }

  /**
   * Back on the tab, a host's lobby follows whatever the New Game tab was changed to meanwhile.
   * docs/multiplayer-net.md § The Multiplayer tab.
   */
  private async announce(): Promise<void> {
    const session = this.hooks.session();
    if (!session?.isHost || session.phase !== 'lobby' || this.announcing) return;
    this.announcing = true;
    this.render();
    let changed = false;
    await attempt(this.setStatus, async () => {
      changed = await this.hooks.announce();
    });
    this.announcing = false;
    if (changed) this.setStatus("The room now plays the New Game tab's pick.");
    this.refresh();
  }

  /**
   * The tab's own light, seen from every tab: a ring while this browser sits in a room's lobby,
   * filled while its game loads or runs, off outside a room.
   */
  private refreshTabLight(): void {
    const phase = this.hooks.session()?.phase;
    const inGame = phase === 'loading' || phase === 'playing';
    this.tabButton.classList.toggle('net-lobby', phase === 'lobby');
    this.tabButton.classList.toggle('net-game', inGame);
    this.tabButton.title = phase === 'lobby' ? 'In a lobby' : inGame ? 'In a network game' : '';
  }

  private render(): void {
    const session = this.hooks.session();
    this.connect.classList.toggle('hidden', session !== null);
    this.room.classList.toggle('hidden', session === null);
    if (!session) {
      this.renderConnect();
      return;
    }
    this.codeEl.textContent = session.code ?? '…';
    this.phaseEl.textContent = phaseText(session);
    this.renderFacts(session);
    this.renderPeers(session);
    // The host's three controls are the lobby's; a running game shows the roster and Leave.
    const hosting = session.isHost && session.phase === 'lobby';
    this.delayRow.classList.toggle('hidden', !hosting);
    this.delaySelect.value = String(session.delay);
    this.startButton.classList.toggle('hidden', !hosting);
    this.startButton.disabled = !session.canStart || this.announcing;
    // The host leaving takes the room with it (docs/multiplayer-net.md § Leaving).
    this.leaveButton.textContent = session.isHost ? 'Close' : 'Leave';
    this.roomHint.textContent = this.announcing ? "reading the New Game tab's pick…" : roomHint(session);
  }

  private renderConnect(): void {
    this.hostButton.disabled = this.connecting;
    this.joinButton.disabled = this.connecting;
    this.connectHint.textContent = this.connecting ? 'connecting…' : '';
  }

  /** What is being played: the level as the level select names it, the skill, the WADs. */
  private renderFacts(session: NetSession): void {
    const { game } = session;
    if (!game) {
      this.facts.replaceChildren(emptyLine('Waiting for the host to pick a level…'));
      return;
    }
    const rules = [
      session.session.pistolStart ? 'pistol start' : null,
      session.session.infiniteTallActors ? 'infinitely tall actors' : null,
    ].filter((rule): rule is string => rule !== null);
    fillFacts(this.facts, [
      ['Level', this.describe(game.set).level],
      ['Skill', SKILL_NAMES[game.skill]],
      ['WADs', game.set.wads.map(wadLabel).join(', ') || '—'],
      ['Rules', rules.length > 0 ? rules.join(', ') : 'vanilla'],
      ['Input delay', ticsLabel(session.delay)],
    ]);
  }

  /**
   * Who is in the room and whether they can play what the host picked; during a game, which slot
   * each one holds and whose player stands idle.
   */
  private renderPeers(session: NetSession): void {
    this.peers.replaceChildren();
    const roster = session.roster();
    if (session.phase === 'lobby' || roster.length === 0) {
      for (const [index, peer] of session.peers.entries()) {
        const marks = index === 0 ? [markChip('host')] : [];
        if (peer.build && peer.build !== VERSION) {
          marks.push(markChip(`v${peer.build}`, 'another build'));
        }
        const state = stateLine(peer.ready === true ? 'ready' : peer.ready === null ? 'checking…' : 'not ready');
        state.classList.toggle('ready', peer.ready === true);
        const note = peer.ready === false ? noteLine('warning', peer.refusal ?? 'cannot play this set') : null;
        const name = peer.name || `player ${index + 1}`;
        // The host is the list's first row; everyone after it can be kicked.
        const kick = session.isHost && index > 0 ? this.kickButton(peer.member, name) : null;
        this.peers.append(peerRow({ name, note, marks, state, kick }));
      }
      return;
    }
    for (const entry of roster) {
      const marks: HTMLSpanElement[] = [];
      if (entry.slot === 0) marks.push(markChip('host'));
      if (entry.local) marks.push(markChip('you'));
      const state = stateLine(entry.present ? `player ${entry.slot + 1}` : 'left — standing idle');
      const kick = session.isHost && !entry.local && entry.member !== null ? this.kickButton(entry.member, entry.name) : null;
      const row = peerRow({ name: entry.name, note: null, marks, state, kick });
      row.classList.toggle('disabled', !entry.present);
      this.peers.append(row);
    }
  }

  /** The host's Kick beside a player's row — savegames.css's `.row-actions` shape. */
  private kickButton(member: number, name: string): HTMLDivElement {
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const button = document.createElement('button');
    button.textContent = 'Kick';
    button.title = `Put ${name} out of the room`;
    button.addEventListener('click', () => this.hooks.kick(member));
    actions.append(button);
    return actions;
  }
}

/** Where the session stands, in the room heading's own words. */
function phaseText(session: NetSession): string {
  switch (session.phase) {
    case 'lobby':
      return session.isHost ? 'lobby — start when everyone is ready' : 'lobby — waiting for the host to start';
    case 'loading':
      return 'loading the level…';
    case 'playing':
      return 'playing';
    case 'ended':
      return session.endReason ?? 'over';
  }
}

/** The one line under the room's controls: what is keeping Start greyed, or a desync in progress. */
function roomHint(session: NetSession): string {
  if (session.desyncedAt !== null) return `out of step since tic ${session.desyncedAt} — the host is resyncing`;
  if (session.phase !== 'lobby' || !session.isHost) return '';
  const waiting = session.peers.filter((peer) => peer.ready !== true);
  if (waiting.length === 0) return session.peers.length === 1 ? 'alone so far — Start works, or wait for the others' : '';
  return `waiting on ${waiting.map((peer) => peer.name).join(', ')}`;
}

function ticsLabel(tics: number): string {
  return `${tics} tic${tics === 1 ? '' : 's'}`;
}

/** What one line of the room's list shows; `note` and `kick` are null where the row has none. */
interface PeerRowParts {
  name: string;
  /** Why that player cannot play the host's pick. */
  note: HTMLElement | null;
  marks: readonly HTMLElement[];
  state: HTMLSpanElement;
  kick: HTMLElement | null;
}

/**
 * One line of the room's list: the name, why that player cannot play, the host's Kick and the
 * chips in one cell, where that player stands. Always the four cells, so the list's shared columns
 * line up down it; Kick leads its cell, so it starts where the host row's badge does — no row
 * carries both.
 */
function peerRow({ name, note, marks, state, kick }: PeerRowParts): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('span');
  label.className = 'name truncate';
  label.textContent = name;
  const why = document.createElement('span');
  why.className = 'note';
  if (note) why.append(note);
  const tags = document.createElement('div');
  tags.className = 'marks';
  if (kick) tags.append(kick);
  tags.append(...marks);
  row.append(label, why, tags, state);
  return row;
}

/** A row's state column: where that player stands, in a word or two. */
function stateLine(text: string): HTMLSpanElement {
  const state = document.createElement('span');
  state.className = 'meta state';
  state.textContent = text;
  return state;
}
