/**
 * The menu's Replays tab: recording from the pause menu (and the light on the tab while one runs),
 * and the replay library as a list beside a detail panel — the picked replay's editable name,
 * player and notes, what it was recorded from, and play/download/delete. The replays the engine
 * ships are listed here too, marked and read-only. Pure DOM over `game/replay.ts`; every failure
 * goes to the menu's status line.
 * docs/replays.md, and docs/menu-saves.md § Replays tab.
 */
import {
  compatDrift,
  deleteReplay,
  describeReplay,
  exportReplay,
  importReplay,
  isStockReplay,
  listReplays,
  listStockReplays,
  readReplay,
  replayFileName,
  replaySeconds,
  replayWadSet,
  type Replay,
  type ReplayDescription,
  type ReplayListEntry,
  type ReplayMeta,
} from '../../game/replay.ts';
import { blockingWadText, missingWadText, wadLabel, type SaveWadSet } from '../../game/savegames.ts';
import { SKILL_NAMES } from '../../game/skill.ts';
import { formatClock } from '../hud/hud.ts';
import {
  attempt,
  downloadJson,
  emptyLine,
  fillFacts,
  iconButton,
  installFilter,
  markChip,
  matchesFilter,
  noteLine,
  type StatusLine,
} from './actions.ts';
import { confirmOnHold } from './hold.ts';
import type { MenuSession } from './menu.ts';
import type { SaveSetInfo } from './savegames.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * How many lines of notes the detail panel shows before scrolling them — three, which is what the
 * panel has room for beside the fields and facts without the facts themselves scrolling.
 */
const NOTES_ROWS = 3;

/**
 * Why the record button is greyed with no game behind the menu — a moment `Game.recordingRefusal`
 * never sees. The **one** refusal on this tab that is a tooltip rather than a line of red beside
 * the control: nobody expects to record a game that isn't running, so printing it would be noise
 * on the launcher's every visit. It hangs on the row, not on the button — a disabled button gets
 * no hover events, which is why every *unobvious* refusal is still text.
 */
const NO_LEVEL_TOOLTIP = 'Nothing to record yet — start or load a level first.';

/**
 * What the mark on a stock row says on hover, and the whole explanation of why that row has no
 * fields to type in and no trash button: the file is the server's, not this browser's.
 * docs/replays.md § Stock replays.
 */
const STOCK_HINT = 'Ships with TopDoom; it cannot be edited or deleted.';

/**
 * What the menu's owner (session/session.ts) does with a replay request — the UI never touches
 * the running game. A refusal is a thrown `Error` whose message is shown in the status line.
 */
export interface ReplayHooks {
  /** Tears down the current session and plays `replay` from its start. */
  onPlay(replay: Replay): void | Promise<void>;
  /** Starts recording the level behind the menu from this moment. */
  onStartRecording(): void | Promise<void>;
  /** Ends the recording in progress and stores it. */
  onStopRecording(): void | Promise<void>;
  /** Ends the recording in progress and throws the record away; the level plays on. */
  onCancelRecording(): void | Promise<void>;
  /**
   * Why a recording can't start now — `Game.recordingRefusal`.
   * @returns null when one can, and with no game too
   */
  recordingRefusal(): string | null;
  isRecording(): boolean;
}

export class ReplaysUi {
  private list = el<HTMLDivElement>('replay-list');
  private detail = el<HTMLDivElement>('replay-detail');
  private tabButton = el<HTMLButtonElement>('tab-button-replays');
  private recordSection = el<HTMLElement>('replay-record-section');
  private recordButton = el<HTMLButtonElement>('replay-record');
  private cancelButton = el<HTMLButtonElement>('replay-cancel');
  private recordHint = el<HTMLSpanElement>('replay-record-hint');
  private fileInput = el<HTMLInputElement>('replay-file-input');

  private hooks: ReplayHooks;
  private setStatus: StatusLine;
  private describe: (meta: SaveWadSet) => SaveSetInfo;
  private session: MenuSession = 'none';
  /** Whether a running network game refuses every Play — `refresh`'s, like `session`. */
  private startRefused = false;
  private visible = false;
  private stale = true;
  /** Monotonic ticket for {@link ReplaysUi.renderVisible} — the `SavegamesUi` rule. */
  private renderEpoch = 0;
  /** What the last render listed, so a pick can be shown without re-reading the store. */
  private entries: ReplayListEntry[] = [];
  /**
   * The replay the detail panel is showing. Kept across a re-list so an edit or an import doesn't
   * move what the player is looking at; the newest replay stands in when it names none.
   */
  private selectedId: string | null = null;
  /** The heading's filter, already trimmed and lowercased — {@link installFilter}'s hand-off. */
  private filter = '';

  constructor(
    hooks: ReplayHooks,
    setStatus: StatusLine,
    describe: (meta: SaveWadSet) => SaveSetInfo,
  ) {
    this.hooks = hooks;
    this.setStatus = setStatus;
    this.describe = describe;
    installFilter(el<HTMLInputElement>('replay-filter'), (filter) => {
      this.filter = filter;
      this.renderList(true);
    });
    this.recordButton.addEventListener('click', () => void this.toggleRecording());
    // Wired once, and the label never rewritten afterwards: `confirmOnHold` rebuilds the button's
    // children around a `.label` span, which a later `textContent` would throw away.
    confirmOnHold(this.cancelButton, {
      hint: 'Hold Cancel to throw the recording away.',
      setStatus: this.setStatus,
      action: () => void this.cancelRecording(),
    });
    el<HTMLButtonElement>('replay-import').addEventListener('click', () => {
      this.fileInput.value = '';
      this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => {
      void this.importFiles([...(this.fileInput.files ?? [])]);
    });
  }

  /**
   * Marks the list stale and rebuilds it if on screen; called on every menu open and mutation.
   * @param startRefused  whether `MenuHooks.startRefusal` refuses every Play, its reason in the
   *                      tab's hint; like `session`, defaults to the last value given
   */
  refresh(session = this.session, startRefused = this.startRefused): void {
    this.session = session;
    this.startRefused = startRefused;
    this.refreshRecordButton();
    this.stale = true;
    void this.renderVisible();
  }

  /** Whether the Replays tab is showing — `Menu.setTab`'s hand-off. */
  setVisible(on: boolean): void {
    this.visible = on;
    void this.renderVisible();
  }

  /** Imports downloaded replays, from the file picker or a drop on the menu. */
  async importFiles(files: File[]): Promise<void> {
    let arrived: string | null = null;
    for (const file of files) {
      try {
        const meta = await importReplay(await file.text());
        arrived = meta.id;
        this.setStatus(`Imported "${meta.name}".`);
      } catch (err) {
        this.setStatus(`${file.name}: ${(err as Error).message}`, 'error');
      }
    }
    // The panel is the answer to "where did it go?", so it shows what just arrived.
    if (arrived !== null) this.selectedId = arrived;
    this.refresh();
  }

  /**
   * The record button reads as what pressing it does, and is greyed with the reason beside it
   * when nothing can start — a disabled button shows no tooltip. Stopping is the **primary**
   * button: that press is what turns the run into a stored replay, and nothing else on the tab
   * competes with it while one is running.
   */
  private refreshRecordButton(): void {
    const recording = this.hooks.isRecording();
    const inGame = this.session !== 'none';
    const refusal = recording || !inGame ? null : this.hooks.recordingRefusal();
    this.recordButton.textContent = recording ? 'Stop and save recording' : 'Record from here';
    this.recordButton.className = recording ? 'primary' : 'ghost';
    this.recordButton.disabled = !inGame || refusal !== null;
    // Only while one runs: there is nothing to throw away otherwise, and a greyed second button
    // beside a greyed first says nothing the first hasn't.
    this.cancelButton.classList.toggle('hidden', !recording);
    this.recordHint.textContent = recording ? 'recording…' : (refusal ?? '');
    this.recordSection.title = inGame ? '' : NO_LEVEL_TOOLTIP;
    // The tab's own light, so a recording is visible from every tab rather than only from this
    // one — the HUD's is behind the menu meanwhile. docs/replays.md § Recording.
    this.tabButton.classList.toggle('recording', recording);
  }

  private async toggleRecording(): Promise<void> {
    if (this.hooks.isRecording()) {
      if (!(await attempt(this.setStatus, () => this.hooks.onStopRecording(), 'Replay stored.'))) return;
      // The recording just stored is the newest, which is what an unnamed pick falls back to — so
      // the panel is showing the run the player just finished rather than whatever was picked
      // before it.
      this.selectedId = null;
      this.refresh();
      return;
    }
    if (await attempt(this.setStatus, () => this.hooks.onStartRecording(), 'Recording.')) this.refreshRecordButton();
  }

  /**
   * Throws the running recording away. Nothing reaches the store, so the list is left alone — only
   * the record row goes back to offering a fresh start. docs/replays.md § Recording.
   */
  private async cancelRecording(): Promise<void> {
    await attempt(this.setStatus, () => this.hooks.onCancelRecording(), 'Recording discarded.');
    this.refreshRecordButton();
  }

  private async renderVisible(): Promise<void> {
    if (!this.visible || !this.stale) return;
    const epoch = ++this.renderEpoch;
    let entries: ReplayListEntry[];
    try {
      // This browser's own recordings first, the shipped ones under them — two lists rather than
      // one sort by date, so a stock replay never lands between two runs the player recorded.
      const [stored, stock] = await Promise.all([listReplays(), listStockReplays()]);
      entries = [...stored, ...stock];
    } catch (err) {
      this.setStatus((err as Error).message, 'error');
      return;
    }
    if (epoch !== this.renderEpoch || !this.visible) return;
    this.stale = false;
    this.entries = entries;
    this.renderList();
  }

  /**
   * Builds the list from the cached listing, minus what the filter hides, and re-aims the panel:
   * the pick has to be one of the rows on screen, or the panel would be showing a replay the
   * filter says isn't there.
   * @param fromFilter  a keystroke rather than a re-list — the rows are a different set now, so the
   *                    offset goes back to the top
   */
  private renderList(fromFilter = false): void {
    const shown = this.entries.filter((entry) => this.matches(entry));
    const picked = this.selectedId;
    if (!shown.some((entry) => entry.meta.id === picked)) this.selectedId = shown[0]?.meta.id ?? null;
    const scrollTop = fromFilter ? 0 : this.list.scrollTop;
    this.list.replaceChildren();
    for (const entry of shown) this.list.append(this.makeRow(entry));
    // Nothing recorded and nothing kept are different sentences, and this is what knows which.
    if (shown.length === 0) {
      this.list.append(emptyLine(this.entries.length === 0 ? 'No replays yet.' : 'No replay matches that filter.'));
    }
    this.list.scrollTop = scrollTop;
    // A keystroke that left the pick where it was leaves the panel alone: it is a form of
    // thirty-odd elements, and a re-list is the only thing that can change what one of them says.
    if (!fromFilter || this.selectedId !== picked) {
      this.renderDetail();
    }
  }

  /**
   * What the filter looks through: everything about a replay the player wrote themselves, plus the
   * level it was recorded on — the one thing worth searching for that they didn't. The level costs
   * a {@link ReplaysUi.describe} per row, so an empty filter never asks for it.
   */
  private matches(entry: ReplayListEntry): boolean {
    if (this.filter === '') return true;
    const { meta } = entry;
    const level = this.describe(replayWadSet(meta)).level;
    return matchesFilter(this.filter, [meta.name, meta.player, meta.description, level]);
  }

  /**
   * A list row: what tells one replay from another at a glance — its name, who played it, how long
   * it runs. Everything else is the panel's, one click away. A replay that cannot be played is
   * dimmed here with the reason on its tooltip, and the panel prints that reason in red beside the
   * Play button it greys (docs/menu-saves.md § Replays tab).
   */
  private makeRow(entry: ReplayListEntry): HTMLDivElement {
    const { meta } = entry;
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = meta.id;
    row.classList.toggle('selected', meta.id === this.selectedId);
    const blocked = this.blockedReason(entry);
    if (blocked !== null) {
      row.classList.add('unsupported');
      row.title = blocked;
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = meta.name;
    const player = document.createElement('span');
    player.className = 'player';
    player.textContent = meta.player;
    const length = document.createElement('span');
    length.className = 'length';
    length.textContent = formatClock(replaySeconds(meta.ticCount));

    row.append(name);
    if (isStockReplay(meta.id)) row.append(stockMark());
    row.append(player, length);
    row.addEventListener('click', () => this.select(meta.id));
    return row;
  }

  /** Moves the pick without re-reading the store — the list on screen is already the answer. */
  private select(id: string): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    for (const row of this.list.children) {
      row.classList.toggle('selected', (row as HTMLElement).dataset.id === id);
    }
    this.renderDetail();
  }

  /**
   * The right-hand panel: the picked replay in full. Rebuilt outright on every pick — a panel is
   * one replay's worth of DOM, and patching it in place would be the same code a second time.
   */
  private renderDetail(): void {
    const entry = this.entries.find((e) => e.meta.id === this.selectedId);
    this.detail.replaceChildren();
    this.detail.classList.toggle('empty', entry === undefined);
    if (!entry) {
      const placeholder = document.createElement('span');
      placeholder.className = 'placeholder';
      placeholder.textContent =
        this.entries.length === 0 ? 'Record a run and it lands here.' : 'Pick a replay on the left.';
      this.detail.append(placeholder);
      return;
    }
    const { meta } = entry;
    const set = this.describe(replayWadSet(meta));
    // The fields and facts scroll inside `body`; the buttons below it never do — a panel whose
    // Play has to be scrolled to is the one thing this layout must not produce.
    const body = document.createElement('div');
    body.className = 'detail-body';
    if (isStockReplay(meta.id)) {
      // Nothing on a served file is this browser's to change, so the three fields read rather than
      // edit — the name carrying the mark that says why, the player joining the facts below, and
      // the notes only where the recording came with some.
      body.append(readOnlyField('Name', meta.name, stockMark()));
      if (meta.description) body.append(readOnlyField('Notes', meta.description));
    } else {
      const named = document.createElement('div');
      named.className = 'field-row';
      named.append(
        this.makeField(meta, 'name', 'Name', 'Give it a name'),
        this.makeField(meta, 'player', 'Player', 'Who played it'),
      );
      body.append(named, this.makeField(meta, 'description', 'Notes', 'Anything worth remembering'));
    }
    body.append(this.makeFacts(meta, set));
    this.detail.append(body);
    // Red, and not a grey note among the facts above: this is why the replay cannot be played, and
    // that is what red says here — the same weight a save the load would refuse over gets. Outside
    // the scroller with the buttons, since a reason scrolled out of sight beside a greyed Play is
    // the state the rule exists to prevent (CLAUDE.md § Project-wide rules).
    if (entry.refusal !== null) this.detail.append(noteLine('warning', entry.refusal));
    // Amber, not red: a simulation the recording didn't run under is a risk, not a refusal — the
    // replay plays, and `desyncedAt` says whether it actually diverged (docs/replays.md
    // § Compatibility).
    const drift = compatDrift(meta.compat);
    if (drift !== null) {
      this.detail.append(noteLine('caution', `Recorded under ${drift} game rules — it may desync.`));
    }
    for (const file of set.missing) {
      this.detail.append(noteLine(file.required ? 'warning' : 'caution', missingWadText(file)));
    }
    this.detail.append(this.makeActions(entry));
  }

  /** What the replay was recorded from and on — read-only, one label/value pair per line. */
  private makeFacts(meta: ReplayMeta, set: SaveSetInfo): HTMLDivElement {
    const levels = meta.levels.length > 1 ? ` (+${meta.levels.length - 1} more)` : '';
    // The build and the JavaScript engine are provenance, not a warning: both differ on most kept
    // replays and neither says this one diverges (docs/replays.md § Compatibility).
    const facts: [string, string][] = [
      ['Level', `${set.level}${levels}`],
      ['Skill', SKILL_NAMES[meta.skill]],
      ['Recorded', meta.at ? new Date(meta.at).toLocaleString() : '—'],
      ['WADs', meta.wads.map(wadLabel).join(', ') || '—'],
      ['Engine', [meta.build && `v${meta.build}`, meta.engine].filter(Boolean).join(' · ') || '—'],
    ];
    // Who played it is an editable field on a stored replay and a fact on a stock one, which is the
    // only difference between the two panels beyond the fields above.
    if (isStockReplay(meta.id)) facts.unshift(['Player', meta.player || '—']);
    const block = document.createElement('div');
    block.className = 'fact-grid';
    fillFacts(block, facts);
    return block;
  }

  private makeActions(entry: ReplayListEntry): HTMLDivElement {
    const { meta } = entry;
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const play = document.createElement('button');
    play.className = 'primary';
    play.textContent = 'Play';
    // A running network game greys it too, its reason in the tab's hint rather than the panel's.
    play.disabled = this.blockedReason(entry) !== null || this.startRefused;
    // Held to confirm over a run of the player's own, which playing this one throws away — Load's
    // rule and Start new game's (docs/menu-saves.md § Save and Load tabs). Not over a replay: the
    // one being watched can be watched again.
    play.title = this.session === 'game' ? 'Hold to abandon the game you are running' : '';
    confirmOnHold(play, {
      hint: 'Hold Play to abandon the game you are running.',
      setStatus: this.setStatus,
      action: () => this.play(meta.id),
      required: () => this.session === 'game',
    });
    actions.append(play, this.makeDownloadButton(meta));
    // No trash on a stock row: the file is on the server, and deleting it is a matter for whoever
    // put it there. The mark beside the name is what says so (`STOCK_HINT`).
    if (!isStockReplay(meta.id)) actions.append(this.makeDeleteButton(meta));
    return actions;
  }

  /**
   * One labelled editable field: leaving commits, and so does Enter outside the notes, where a
   * newline is a newline. ESC reverts and stops short of `main.ts`'s menu-closing handler. A
   * committed edit patches the list row rather than re-listing.
   */
  private makeField(meta: ReplayMeta, key: keyof ReplayDescription, label: string, title: string): HTMLLabelElement {
    const notes = key === 'description';
    const field = document.createElement('label');
    field.className = 'field';
    const caption = document.createElement('span');
    caption.className = 'label';
    caption.textContent = label;
    const input = notes ? document.createElement('textarea') : document.createElement('input');
    if (input instanceof HTMLTextAreaElement) input.rows = NOTES_ROWS;
    else input.type = 'text';
    input.className = key;
    input.value = meta[key];
    input.placeholder = title;
    input.maxLength = notes ? 200 : 60;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.title = title;
    // `event` is typed by hand: `addEventListener` on an input/textarea *union* falls back to the
    // bare `Event` overload, which has no `key`.
    input.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.key === 'Enter' && !notes) {
        input.blur();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        input.value = meta[key];
        input.blur();
      }
    });
    input.addEventListener('blur', () => void this.commit(meta, key, input));
    field.append(caption, input);
    return field;
  }

  private async commit(
    meta: ReplayMeta,
    key: keyof ReplayDescription,
    input: HTMLInputElement | HTMLTextAreaElement,
  ): Promise<void> {
    const trimmed = input.value.trim();
    if (trimmed === meta[key]) return;
    if (!(await attempt(this.setStatus, () => describeReplay(meta.id, { [key]: input.value })))) {
      input.value = meta[key];
      return;
    }
    meta[key] = trimmed;
    input.value = trimmed;
    this.patchRow(meta.id, key, trimmed);
  }

  /** Keeps a list row in step with an edit made in the panel — both show name and player. */
  private patchRow(id: string, key: keyof ReplayDescription, value: string): void {
    if (key === 'description') return;
    const cell = this.list.querySelector<HTMLElement>(`.row[data-id="${id}"] .${key}`);
    if (cell) cell.textContent = value;
  }

  private makeDownloadButton(meta: ReplayMeta): HTMLButtonElement {
    const button = iconButton('download', 'Download this replay to disk');
    button.addEventListener('click', () => this.download(meta));
    return button;
  }

  private makeDeleteButton(meta: ReplayMeta): HTMLButtonElement {
    const button = iconButton('delete', 'Hold to delete this replay');
    confirmOnHold(button, {
      hint: 'Hold the trash button to delete that replay.',
      setStatus: this.setStatus,
      action: () => {
        void attempt(this.setStatus, async () => {
          await deleteReplay(meta.id);
          // The panel was showing what has just gone, so the re-list picks the newest for it.
          this.selectedId = null;
          this.refresh();
        });
      },
    });
    return button;
  }

  /** Why this replay can't be played, or null — the format's own refusal, then a missing WAD. */
  private blockedReason(entry: ReplayListEntry): string | null {
    if (entry.refusal !== null) return entry.refusal;
    return blockingWadText(this.describe(replayWadSet(entry.meta)).missing);
  }

  private play(id: string): void {
    void attempt(this.setStatus, async () => this.hooks.onPlay(await readReplay(id)));
  }

  private download(meta: ReplayMeta): void {
    void attempt(this.setStatus, async () => downloadJson(await exportReplay(meta.id), replayFileName(meta.name)));
  }
}

/**
 * The mark a stock replay wears in the list and at the head of its panel: a word rather than a
 * glyph, since what it says — this one came with the game and is read-only — has no icon everybody
 * reads the same way, and the row has the width for it.
 */
function stockMark(): HTMLSpanElement {
  return markChip('included', STOCK_HINT);
}

/**
 * A panel line that only reads: {@link ReplaysUi.makeField}'s shape with the input replaced by its
 * value.
 */
function readOnlyField(label: string, value: string, mark?: HTMLElement): HTMLDivElement {
  const field = document.createElement('div');
  field.className = 'field';
  const caption = document.createElement('span');
  caption.className = 'label';
  caption.textContent = label;
  if (mark) caption.append(mark);
  const text = document.createElement('span');
  text.className = 'value';
  text.textContent = value;
  field.append(caption, text);
  return field;
}
