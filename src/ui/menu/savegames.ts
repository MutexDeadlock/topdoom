/**
 * The menu's Save and Load tabs: listing, naming, overwrite/delete, download and import.
 * See docs/menu.md § Save and Load tabs and docs/savegames.md.
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
  type MissingWad,
  type SaveGame,
  type SaveListEntry,
  type SaveMeta,
} from '../../game/savegames.ts';
import { SKILL_NAMES } from '../../game/skill.ts';
import { formatClock } from '../hud/hud.ts';
import { confirmOnHold } from './hold.ts';

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
   * Why the current moment can't be saved, or null when it can — the same
   * sentence `onSave`/`onOverwrite` would throw, asked ahead of the click so
   * the buttons can be disabled rather than failing when pressed. Null with no
   * game running too: `inGame` is the gate for that, not this.
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
 * line. docs/menu.md § Save and Load tabs.
 */
export class SavegamesUi {
  private saveList = el<HTMLDivElement>('save-list');
  private loadList = el<HTMLDivElement>('load-list');
  private nameInput = el<HTMLInputElement>('save-name');
  private saveButton = el<HTMLButtonElement>('save-button');
  private refusalHint = el<HTMLSpanElement>('save-refusal');
  private fileInput = el<HTMLInputElement>('save-file-input');

  private hooks: SaveHooks;
  private setStatus: (text: string, isError?: boolean) => void;
  private describe: (meta: SaveMeta) => SaveSetInfo;
  private inGame = false;
  /**
   * Which of the two lists is on screen, and whether each still matches the
   * store. Only the visible one is ever built: listing itself is a cheap meta
   * read now, but rendering still means one thumbnail decode and one WAD-set
   * resolution per row, which must not happen on a plain ESC pause or at boot.
   */
  private visible: 'save' | 'load' | null = null;
  private stale = { save: true, load: true };
  /**
   * Monotonic ticket for `renderVisible`: a render that finds a newer one started while it awaited
   * discards itself.
   */
  private renderEpoch = 0;

  constructor(
    hooks: SaveHooks,
    setStatus: (text: string, isError?: boolean) => void,
    describe: (meta: SaveMeta) => SaveSetInfo,
  ) {
    this.hooks = hooks;
    this.setStatus = setStatus;
    this.describe = describe;
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
   * Marks both lists stale and rebuilds whichever is on screen; called on every
   * menu open and after each store mutation. `inGame` defaults to the last
   * value `Menu.open` gave, so a refresh from elsewhere (an upload) doesn't
   * have to carry it.
   */
  refresh(inGame = this.inGame): void {
    this.inGame = inGame;
    this.saveButton.disabled = !this.canSave;
    // A disabled button shows no tooltip, so the reason has to be on screen.
    this.refusalHint.textContent = this.hooks.saveRefusal() ?? '';
    this.stale.save = true;
    this.stale.load = true;
    void this.renderVisible();
  }

  /** Which tab is showing, `null` for one of the menu's others — `Menu.setTab`'s hand-off. */
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
        this.setStatus(`${file.name}: ${(err as Error).message}`, true);
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
    return this.inGame && this.hooks.saveRefusal() === null;
  }

  /**
   * Rebuilds the visible list from the store, if it's stale. Async, so two
   * hazards need the epoch ticket: a `refresh` or tab switch while the listing
   * is in flight starts a newer render, and the older one must discard rather
   * than paint over it — `stale` is only cleared by the render that actually
   * painted, so a discarded one leaves the tab marked for the next look.
   */
  private async renderVisible(): Promise<void> {
    const tab = this.visible;
    if (!tab || !this.stale[tab]) return;
    const epoch = ++this.renderEpoch;
    let entries: SaveListEntry[];
    try {
      entries = await listSaves();
    } catch (err) {
      this.setStatus((err as Error).message, true);
      return;
    }
    if (epoch !== this.renderEpoch || this.visible !== tab) return;
    this.stale[tab] = false;
    this.renderList(tab === 'save' ? this.saveList : this.loadList, entries, tab);
  }

  /**
   * Runs one store or hook call under this class's single refusal contract:
   * anything thrown becomes the status line, and the caller learns whether to
   * go on. Every action routes through here so the contract the class doc
   * states is written once rather than at each of them — the store's calls all
   * being async now, the action is awaited and so is the verdict.
   */
  private async attempt(action: () => void | Promise<void>, done?: string): Promise<boolean> {
    try {
      await action();
    } catch (err) {
      this.setStatus((err as Error).message, true);
      return false;
    }
    if (done !== undefined) this.setStatus(done);
    return true;
  }

  private async save(): Promise<void> {
    // The disabled check covers a save already in flight (Enter bypasses the
    // button's own disabled state), so one keypress can't store two.
    if (!this.canSave || this.saveButton.disabled) return;
    this.saveButton.disabled = true;
    const ok = await this.attempt(() => this.hooks.onSave(this.nameInput.value), 'Game saved.');
    this.saveButton.disabled = !this.canSave;
    if (!ok) return;
    this.nameInput.value = '';
    this.refresh();
  }

  private renderList(container: HTMLDivElement, entries: SaveListEntry[], mode: 'save' | 'load'): void {
    const scrollTop = container.scrollTop;
    container.replaceChildren();
    for (const entry of entries) container.append(this.makeRow(entry, mode));
    container.scrollTop = scrollTop;
  }

  private makeRow(entry: SaveListEntry, mode: 'save' | 'load'): HTMLDivElement {
    const { meta } = entry;
    const set = this.describe(meta);
    const row = document.createElement('div');
    row.className = 'row' + (entry.supported ? '' : ' unsupported');

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
    if (!entry.supported) parts.push(`unsupported version ${meta.version}`);
    const detail = document.createElement('span');
    detail.className = 'meta';
    detail.textContent = parts.join(' · ');

    label.append(this.makeNameInput(meta), level, detail);
    // One line per missing file, so a set short two add-ons names both. Both are
    // warnings; only a required one is the accent's red, since red is what says
    // this save can't be loaded — the rest are amber, a file that is gone from a
    // load that still works. The line is the short label — this column
    // ellipsizes — with the full sentence on the tooltip, where there is room for
    // what to do about it.
    for (const file of set.missing) {
      const warning = document.createElement('span');
      warning.className = file.required ? 'warning' : 'caution';
      warning.textContent = missingWadLabel(file);
      warning.title = missingWadText(file);
      label.append(warning);
    }
    row.append(label);

    const actions = document.createElement('div');
    actions.className = 'save-actions';
    if (mode === 'load') {
      const load = document.createElement('button');
      load.className = 'primary';
      load.textContent = 'Load';
      // Greyed for a file the load would refuse over, the same courtesy Save and
      // Overwrite get: the row's red line beside it already names the file, and a
      // disabled button shows no tooltip of its own. `loadSave` stays the gate.
      load.disabled = !entry.supported || blockingWad(set.missing) !== undefined;
      load.addEventListener('click', () => this.load(meta.id));
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
      confirmOnHold(overwrite, 'Hold Overwrite to replace that save.', (t) => this.setStatus(t), () =>
        void this.overwrite(meta.id),
      );
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
    if (!(await this.attempt(() => renameSave(meta.id, input.value)))) {
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
    const button = document.createElement('button');
    button.className = 'icon';
    // U+2913, a plain arrow-to-bar rather than an emoji: it inherits the menu's
    // own colour instead of arriving pre-coloured from a system emoji font.
    button.textContent = '⤓';
    button.title = 'Download this save to disk';
    button.setAttribute('aria-label', 'Download this save to disk');
    button.addEventListener('click', () => this.download(meta.id, meta.map));
    return button;
  }

  private makeDeleteButton(meta: SaveMeta): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'icon';
    // U+1F5D1 with the text-presentation selector U+FE0E: the wastebasket, asked
    // to render as a glyph in the menu's own colour rather than as a colour emoji.
    button.textContent = '🗑︎';
    button.title = 'Hold to delete this save';
    button.setAttribute('aria-label', 'Hold to delete this save');
    confirmOnHold(button, 'Hold the trash button to delete that save.', (t) => this.setStatus(t), () => {
      void this.attempt(async () => {
        await deleteSave(meta.id);
        // Only this row goes; re-listing would redecode every remaining row's
        // thumbnail to redraw rows that didn't change (see `rename`).
        button.closest('.row')?.remove();
        this.markOtherListStale();
      });
    });
    return button;
  }

  private async overwrite(id: string): Promise<void> {
    if (!this.canSave) return;
    if (await this.attempt(() => this.hooks.onOverwrite(id), 'Save overwritten.')) this.refresh();
  }

  private load(id: string): void {
    void this.attempt(async () => this.hooks.onLoad(await readSave(id)));
  }

  private download(id: string, map: string): void {
    void this.attempt(async () => {
      const blob = new Blob([await exportSave(id)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${map}-${new Date().toISOString().slice(0, 10)}.topdoom.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}
