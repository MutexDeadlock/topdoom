/**
 * The menu's Save and Load tabs: listing, naming, overwrite/delete, download and import.
 * See docs/menu-saves.md § Save and Load tabs and docs/savegames.md.
 */
import {
  blockingWad,
  deleteSave,
  exportSave,
  importSave,
  listSaves,
  missingWadLabel,
  missingWadText,
  readSave,
  renameSave,
  saveFileName,
  type MissingWad,
  type SaveGame,
  type SaveListEntry,
  type SaveMeta,
} from '../../game/savegames.ts';
import { SKILL_NAMES } from '../../game/skill.ts';
import { formatClock } from '../hud/hud.ts';
import {
  attempt,
  downloadJson,
  emptyLine,
  iconButton,
  installFilter,
  matchesFilter,
  noteLine,
  type StatusLine,
} from './actions.ts';
import { confirmOnHold } from './hold.ts';
import type { MenuSession } from './menu.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * What the menu's owner (main.ts) does with a save request/pick — the UI itself
 * never touches the running game. A refusal is a thrown `Error` whose message
 * is shown in the status line, the same contract the store itself uses.
 */
export interface SaveHooks {
  /** Captures and stores the current moment under `name`. */
  onSave(name: string): void | Promise<void>;
  /** Refills an existing save with the current moment, keeping its name. */
  onOverwrite(id: string): void | Promise<void>;
  /** Tears down the current session and starts one from `save` — the load-side `onStart`. */
  onLoad(save: SaveGame): void | Promise<void>;
  /**
   * Why the current moment can't be saved — the same sentence
   * {@link SaveHooks.onSave}/{@link SaveHooks.onOverwrite} would throw, asked ahead of the click so
   * the buttons can be disabled rather than failing when pressed.
   * @returns null when it can, and with no game running too: {@link SavegamesUi.session} is the
   *          gate for that, not this
   */
  saveRefusal(): string | null;
}

/**
 * What a row can only learn from the *current* library, not from the save
 * itself: the level's title, and which of the save's files are no longer around
 * to load it with. Supplied by `Menu`, which owns the source list.
 */
export interface SaveSetInfo {
  /**
   * The level, named exactly as the level select names it (`describeMap`); the bare lump name where
   * the set can't be resolved.
   */
  level: string;
  /** Files the save was made with that the library can no longer supply, in load order. */
  missing: MissingWad[];
}

/**
 * The Save and Load tab panels: the two save lists (thumbnail, editable name,
 * level, meta, download/delete per row), the save form, and import from disk.
 * Pure DOM over `game/savegames.ts`; every failure goes to the menu's own status
 * line. docs/menu-saves.md § Save and Load tabs.
 */
export class SavegamesUi {
  /**
   * The two list containers, keyed like {@link SavegamesUi.stale} and {@link SavegamesUi.filters} —
   * everything per tab indexes alike.
   */
  private lists = { save: el<HTMLDivElement>('save-list'), load: el<HTMLDivElement>('load-list') };
  private nameInput = el<HTMLInputElement>('save-name');
  private saveButton = el<HTMLButtonElement>('save-button');
  private refusalHint = el<HTMLSpanElement>('save-refusal');
  private fileInput = el<HTMLInputElement>('save-file-input');

  private hooks: SaveHooks;
  private setStatus: StatusLine;
  private describe: (meta: SaveMeta) => SaveSetInfo;
  private session: MenuSession = 'none';
  /**
   * Which of the two lists is on screen, and whether each still matches the
   * store. Only the visible one is ever built: listing itself is a cheap meta
   * read now, but rendering still means one thumbnail decode and one WAD-set
   * resolution per row, which must not happen on a plain ESC pause or at boot.
   */
  private visible: 'save' | 'load' | null = null;
  private stale = { save: true, load: true };
  /**
   * Monotonic ticket for {@link SavegamesUi.renderVisible}: a render that finds a newer one started
   * while it awaited discards itself.
   */
  private renderEpoch = 0;
  /**
   * The heading's filter, per tab: the two lists are looked through for different reasons, so text
   * typed over one must not hide rows on the other.
   */
  private filters = { save: '', load: '' };
  /**
   * What the last listing returned, so a keystroke in a filter re-renders without re-reading. One
   * array for both tabs: they list the same store, and only the *rendering* of it is per tab.
   */
  private entries: SaveListEntry[] = [];

  constructor(
    hooks: SaveHooks,
    setStatus: StatusLine,
    describe: (meta: SaveMeta) => SaveSetInfo,
  ) {
    this.hooks = hooks;
    this.setStatus = setStatus;
    this.describe = describe;
    // Spelled out rather than looped over the two tabs: an element is looked up by a literal id
    // (docs/styles.md § One owner per element), which `tests/ui/markup.test.ts` is what enforces.
    installFilter(el<HTMLInputElement>('save-filter'), (filter) => {
      this.filters.save = filter;
      this.renderList('save', true);
    });
    installFilter(el<HTMLInputElement>('load-filter'), (filter) => {
      this.filters.load = filter;
      this.renderList('load', true);
    });
    this.saveButton.addEventListener('click', () => void this.save());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.save();
    });
    el<HTMLButtonElement>('save-import').addEventListener('click', () => {
      this.fileInput.value = '';
      this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => {
      void this.importFiles([...(this.fileInput.files ?? [])]);
    });
  }

  /**
   * Marks both lists stale and rebuilds whichever is on screen; called on every menu open and after
   * each store mutation.
   * @param session  defaults to the last value `Menu.open` gave, so a refresh from elsewhere (an
   *                 upload) doesn't have to carry it
   */
  refresh(session = this.session): void {
    this.session = session;
    this.saveButton.disabled = !this.canSave;
    // A disabled button shows no tooltip, so the reason has to be on screen.
    this.refusalHint.textContent = this.hooks.saveRefusal() ?? '';
    this.stale.save = true;
    this.stale.load = true;
    void this.renderVisible();
  }

  /**
   * Which tab is showing — `Menu.setTab`'s hand-off.
   * @param tab  null for one of the menu's others
   */
  setVisible(tab: 'save' | 'load' | null): void {
    this.visible = tab;
    void this.renderVisible();
  }

  /**
   * Imports downloaded `.json` saves — from the file picker or from a drop on the menu (see
   * `Menu.installDropTarget`).
   */
  async importFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        const meta = await importSave(await file.text());
        this.setStatus(`Imported "${meta.name}".`);
      } catch (err) {
        this.setStatus(`${file.name}: ${(err as Error).message}`, 'error');
      }
    }
    this.refresh();
  }

  /**
   * Whether Save and Overwrite are live: a game to save, and a moment it would
   * accept. Asked afresh each time rather than cached — it is three field reads
   * behind the hook, and a stored copy would have to be refreshed before the
   * rows are built.
   */
  private get canSave(): boolean {
    return this.session !== 'none' && this.hooks.saveRefusal() === null;
  }

  /**
   * Rebuilds the visible list from the store, if it's stale. Async, so two hazards need the epoch
   * ticket: a {@link SavegamesUi.refresh} or tab switch while the listing is in flight starts a
   * newer render, and the older one must discard rather than paint over it —
   * {@link SavegamesUi.stale} is only cleared by the render that actually painted, so a discarded
   * one leaves the tab marked for the next look.
   */
  private async renderVisible(): Promise<void> {
    const tab = this.visible;
    if (!tab || !this.stale[tab]) return;
    const epoch = ++this.renderEpoch;
    let entries: SaveListEntry[];
    try {
      entries = await listSaves();
    } catch (err) {
      this.setStatus((err as Error).message, 'error');
      return;
    }
    if (epoch !== this.renderEpoch || this.visible !== tab) return;
    this.stale[tab] = false;
    this.entries = entries;
    this.renderList(tab);
  }

  private async save(): Promise<void> {
    // The disabled check covers a save already in flight (Enter bypasses the
    // button's own disabled state), so one keypress can't store two.
    if (!this.canSave || this.saveButton.disabled) return;
    this.saveButton.disabled = true;
    const ok = await attempt(this.setStatus, () => this.hooks.onSave(this.nameInput.value), 'Game saved.');
    this.saveButton.disabled = !this.canSave;
    if (!ok) return;
    this.nameInput.value = '';
    this.refresh();
  }

  /**
   * Builds one tab's list from the cached listing, minus what its filter hides.
   * @param fromFilter  a keystroke rather than a re-list: the rows are a different set now, so the
   *                    offset goes back to the top instead of leaving the player in the middle of
   *                    fresh results
   */
  private renderList(tab: 'save' | 'load', fromFilter = false): void {
    const container = this.lists[tab];
    const scrollTop = fromFilter ? 0 : container.scrollTop;
    container.replaceChildren();
    let shown = 0;
    for (const entry of this.entries) {
      // The level is the filter's second field and the row's own second line, so it is resolved
      // once here rather than again inside the row.
      const set = this.describe(entry.meta);
      if (!matchesFilter(this.filters[tab], [entry.meta.name, set.level])) continue;
      container.append(this.makeRow(entry, set, tab));
      shown++;
    }
    // Nothing stored and nothing kept are different sentences, and this is what knows which.
    if (shown === 0) {
      container.append(emptyLine(this.entries.length === 0 ? 'No saved games yet.' : 'No save matches that filter.'));
    }
    container.scrollTop = scrollTop;
  }

  private makeRow(entry: SaveListEntry, set: SaveSetInfo, mode: 'save' | 'load'): HTMLDivElement {
    const { meta } = entry;
    const row = document.createElement('div');
    row.className = 'row' + (entry.refusal === null ? '' : ' unsupported');

    if (meta.thumb) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = meta.thumb;
      img.alt = '';
      row.append(img);
    }

    const label = document.createElement('div');
    label.className = 'save-label';

    const level = document.createElement('span');
    level.className = 'level';
    // The level time rides on the level line rather than in the meta line: it is
    // a property of *this level's* run, and the bottom line is about the save.
    level.textContent = `${set.level} · ${formatClock(meta.levelTime)}`;

    const parts = [SKILL_NAMES[meta.skill]];
    if (meta.at) parts.push(new Date(meta.at).toLocaleString());
    const detail = document.createElement('span');
    detail.className = 'meta';
    detail.textContent = parts.join(' · ');

    label.append(this.makeNameInput(meta), level, detail);
    // Red, and never only a greyed button: a row that cannot be loaded says why, in the same weight
    // as a missing file the load would refuse over. docs/menu-saves.md § Save and Load tabs.
    if (entry.refusal !== null) label.append(noteLine('warning', entry.refusal, entry.refusal));
    // One line per missing file, so a set short two add-ons names both. Both are
    // warnings; only a required one is the accent's red, since red is what says
    // this save can't be loaded — the rest are amber, a file that is gone from a
    // load that still works. The line is the short label — this column
    // ellipsizes — with the full sentence on the tooltip, where there is room for
    // what to do about it.
    for (const file of set.missing) {
      label.append(noteLine(file.required ? 'warning' : 'caution', missingWadLabel(file), missingWadText(file)));
    }
    row.append(label);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (mode === 'load') {
      const load = document.createElement('button');
      load.className = 'primary';
      load.textContent = 'Load';
      // Greyed for a file the load would refuse over, the same courtesy Save and
      // Overwrite get: the row's red line beside it already names the file, and a
      // disabled button shows no tooltip of its own. `loadSave` stays the gate.
      load.disabled = entry.refusal !== null || blockingWad(set.missing) !== undefined;
      // Only asked for over a run of the player's own, which a load throws away — Start new game's
      // own conditional hold (docs/menu-saves.md § Save and Load tabs). The tooltip follows the
      // hold: from the launcher, and over a replay, this is an ordinary button with nothing to warn
      // about.
      load.title = this.session === 'game' ? 'Hold to abandon the game you are running' : '';
      confirmOnHold(load, {
        hint: 'Hold Load to abandon the game you are running.',
        setStatus: this.setStatus,
        action: () => this.load(meta.id),
        required: () => this.session === 'game',
      });
      actions.append(load);
    } else {
      const overwrite = document.createElement('button');
      overwrite.className = 'primary';
      overwrite.textContent = 'Overwrite';
      // Deliberately not naming the save: `rename` patches a row in place, so a
      // name baked in here would go stale, and the row's own field shows it anyway.
      // The refusal, when there is one, is in the heading's hint instead: a
      // disabled button never shows its tooltip.
      overwrite.title = 'Hold to replace this save with the current moment';
      overwrite.disabled = !this.canSave;
      confirmOnHold(overwrite, {
        hint: 'Hold Overwrite to replace that save.',
        setStatus: this.setStatus,
        action: () => void this.overwrite(meta.id),
      });
      actions.append(overwrite);
    }
    actions.append(this.makeDownloadButton(meta), this.makeDeleteButton(meta));
    row.append(actions);
    return row;
  }

  /**
   * The name, editable in place: Enter or leaving the field commits, ESC
   * reverts. ESC also stops there rather than bubbling to `main.ts`'s handler,
   * which would otherwise close the whole menu on the same key.
   */
  private makeNameInput(meta: SaveMeta): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'name';
    input.type = 'text';
    input.value = meta.name;
    input.maxLength = 60;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.title = 'Rename this save';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') {
        e.stopPropagation();
        input.value = meta.name;
        input.blur();
      }
    });
    input.addEventListener('blur', () => void this.rename(meta, input));
    return input;
  }

  /**
   * Commits an edited name. An untouched field re-renders nothing — a plain
   * focus and blur must not rebuild the list under a click heading for one of
   * the row's own buttons. Nor does a successful rename: the name is the only
   * thing that changed and it is already on screen, so the row is patched in
   * place and only the *other* tab's list is marked stale. Re-listing here
   * would redecode every row's thumbnail to redraw one string — and renaming
   * several saves in a row is the one path a player repeats.
   */
  private async rename(meta: SaveMeta, input: HTMLInputElement): Promise<void> {
    const trimmed = input.value.trim();
    if (trimmed === meta.name) return;
    if (!(await attempt(this.setStatus, () => renameSave(meta.id, input.value)))) {
      input.value = meta.name;
      return;
    }
    meta.name = trimmed;
    input.value = trimmed;
    this.markOtherListStale();
  }

  /**
   * After a row is patched in place: the tab on screen is up to date, the other one has to be
   * rebuilt before it is shown again.
   */
  private markOtherListStale(): void {
    this.stale.save = this.visible !== 'save';
    this.stale.load = this.visible !== 'load';
  }

  private makeDownloadButton(meta: SaveMeta): HTMLButtonElement {
    const button = iconButton('download', 'Download this save to disk');
    button.addEventListener('click', () => this.download(meta));
    return button;
  }

  private makeDeleteButton(meta: SaveMeta): HTMLButtonElement {
    const button = iconButton('delete', 'Hold to delete this save');
    confirmOnHold(button, {
      hint: 'Hold the trash button to delete that save.',
      setStatus: this.setStatus,
      action: () => {
        void attempt(this.setStatus, async () => {
          await deleteSave(meta.id);
          // Dropped from the cache and the list redrawn from it — what `rename` avoids is the
          // *re-listing*, and this needs none. Measured at ~3 ms over 40 rows, the thumbnails
          // coming back from the browser's own image cache, which is what a filter keystroke has
          // paid since it started rebuilding the same rows.
          this.entries = this.entries.filter((e) => e.meta.id !== meta.id);
          if (this.visible) this.renderList(this.visible);
          this.markOtherListStale();
        });
      },
    });
    return button;
  }

  private async overwrite(id: string): Promise<void> {
    if (!this.canSave) return;
    if (await attempt(this.setStatus, () => this.hooks.onOverwrite(id), 'Save overwritten.')) this.refresh();
  }

  private load(id: string): void {
    void attempt(this.setStatus, async () => this.hooks.onLoad(await readSave(id)));
  }

  private download(meta: SaveMeta): void {
    void attempt(this.setStatus, async () => downloadJson(await exportSave(meta.id), saveFileName(meta.name)));
  }
}
