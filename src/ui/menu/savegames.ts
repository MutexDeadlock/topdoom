import {
  deleteSave,
  exportSave,
  importSave,
  listSaves,
  readSave,
  renameSave,
  type SaveGame,
  type SaveListEntry,
  type SaveMeta,
} from '../../game/savegames.ts';
import { SKILL_NAMES } from '../../game/skill.ts';
import { formatClock } from '../hud/hud.ts';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * How long Delete and Overwrite have to be held (`confirmOnHold`). Tuned by
 * feel: long enough that a stray click can't destroy a save, short enough that
 * nobody wonders whether the button is broken.
 */
const HOLD_MS = 1000;

/**
 * What the menu's owner (main.ts) does with a save request/pick — the UI itself
 * never touches the running game. A refusal is a thrown `Error` whose message
 * is shown in the status line, the same contract the store itself uses.
 */
export interface SaveHooks {
  /** Captures and stores the current moment under `name`. */
  onSave(name: string): void;
  /** Refills an existing save with the current moment, keeping its name. */
  onOverwrite(id: string): void;
  /** Tears down the current session and starts one from `save` — the load-side `onStart`. */
  onLoad(save: SaveGame): void | Promise<void>;
}

/**
 * What a row can only learn from the *current* library, not from the save
 * itself: the level's title, and which of the save's files are no longer around
 * to load it with. Supplied by `Menu`, which owns the source list.
 */
export interface SaveSetInfo {
  /** The level, named exactly as the level select names it (`describeMap`); the bare lump name where the set can't be resolved. */
  level: string;
  /** Files the save was made with that the library no longer offers, in load order. */
  missing: { name: string; role: 'IWAD' | 'PWAD' }[];
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
  private fileInput = el<HTMLInputElement>('save-file-input');

  private hooks: SaveHooks;
  private setStatus: (text: string, isError?: boolean) => void;
  private describe: (meta: SaveMeta) => SaveSetInfo;
  private inGame = false;
  /**
   * Which of the two lists is on screen, and whether each still matches the
   * store. Only the visible one is ever built: listing means parsing every
   * stored save's whole payload, which must not happen on a plain Esc pause or
   * at boot, and rendering means one thumbnail decode per row.
   */
  private visible: 'save' | 'load' | null = null;
  private stale = { save: true, load: true };

  constructor(
    hooks: SaveHooks,
    setStatus: (text: string, isError?: boolean) => void,
    describe: (meta: SaveMeta) => SaveSetInfo,
  ) {
    this.hooks = hooks;
    this.setStatus = setStatus;
    this.describe = describe;
    this.saveButton.addEventListener('click', () => this.save());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.save();
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
    this.saveButton.disabled = !inGame;
    this.stale.save = true;
    this.stale.load = true;
    this.renderVisible();
  }

  /** Which tab is showing, `null` for one of the menu's others — `Menu.setTab`'s hand-off. */
  setVisible(tab: 'save' | 'load' | null): void {
    this.visible = tab;
    this.renderVisible();
  }

  private renderVisible(): void {
    const tab = this.visible;
    if (!tab || !this.stale[tab]) return;
    this.renderList(tab === 'save' ? this.saveList : this.loadList, listSaves(), tab);
    this.stale[tab] = false;
  }

  private save(): void {
    if (!this.inGame) return;
    try {
      this.hooks.onSave(this.nameInput.value);
    } catch (err) {
      this.setStatus((err as Error).message, true);
      return;
    }
    this.nameInput.value = '';
    this.setStatus('Game saved.');
    this.refresh();
  }

  /** Imports downloaded `.json` saves — from the file picker or from a drop on the menu (see `Menu.installDropTarget`). */
  async importFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        const meta = importSave(await file.text());
        this.setStatus(`Imported "${meta.name}".`);
      } catch (err) {
        this.setStatus(`${file.name}: ${(err as Error).message}`, true);
      }
    }
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
    level.textContent = set.level;

    const parts = [SKILL_NAMES[meta.skill], formatClock(meta.levelTime)];
    if (meta.at) parts.push(new Date(meta.at).toLocaleString());
    if (!entry.supported) parts.push(`unsupported version ${meta.version}`);
    const detail = document.createElement('span');
    detail.className = 'meta';
    detail.textContent = parts.join(' · ');

    label.append(this.makeNameInput(meta), level, detail);
    // One line per missing file, so a set short two add-ons names both.
    for (const file of set.missing) {
      const warning = document.createElement('span');
      warning.className = 'warning';
      warning.textContent = `Missing ${file.role}: ${file.name}`;
      label.append(warning);
    }
    row.append(label);

    const actions = document.createElement('div');
    actions.className = 'save-actions';
    if (mode === 'load') {
      const load = document.createElement('button');
      load.className = 'primary';
      load.textContent = 'Load';
      load.disabled = !entry.supported;
      load.addEventListener('click', () => this.load(meta.id));
      actions.append(load);
    } else {
      const overwrite = document.createElement('button');
      overwrite.className = 'primary';
      overwrite.textContent = 'Overwrite';
      overwrite.title = `Hold to replace "${meta.name}" with the current moment`;
      overwrite.disabled = !this.inGame;
      this.confirmOnHold(overwrite, 'Hold Overwrite to replace that save.', () => this.overwrite(meta.id));
      actions.append(overwrite);
    }
    actions.append(this.makeDownloadButton(meta), this.makeDeleteButton(meta));
    row.append(actions);
    return row;
  }

  /**
   * The name, editable in place: Enter or leaving the field commits, Esc
   * reverts. Esc also stops there rather than bubbling to `main.ts`'s handler,
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
    input.addEventListener('blur', () => this.rename(meta, input));
    return input;
  }

  /**
   * Commits an edited name. An untouched field re-renders nothing — a plain
   * focus and blur must not rebuild the list under a click heading for one of
   * the row's own buttons.
   */
  private rename(meta: SaveMeta, input: HTMLInputElement): void {
    if (input.value.trim() === meta.name) return;
    try {
      renameSave(meta.id, input.value);
    } catch (err) {
      this.setStatus((err as Error).message, true);
    }
    this.refresh();
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
    this.confirmOnHold(button, 'Hold the trash button to delete that save.', () => {
      deleteSave(meta.id);
      this.refresh();
    });
    return button;
  }

  /**
   * Press-and-hold confirm, shared by Delete and Overwrite: the button fills
   * over `HOLD_MS` and the action fires when the fill lands; letting go early
   * cancels it and says so in the status line. An inline confirm, so the
   * changelog stays the menu's only popup (docs/menu.md § Changelog).
   *
   * The label moves into a `.label` span so the `.fill` bar can sit behind it,
   * and the fill's own duration is handed to CSS as `--hold-time` — one number,
   * so the bar can't finish at a different moment than the timer.
   */
  private confirmOnHold(button: HTMLButtonElement, hint: string, action: () => void): void {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = button.textContent;
    const fill = document.createElement('span');
    fill.className = 'fill';
    // Fill first: both are positioned, so DOM order is what paints the label on top.
    button.replaceChildren(fill, label);
    button.classList.add('hold');
    button.style.setProperty('--hold-time', `${HOLD_MS}ms`);

    let timer = 0;
    const cancel = () => {
      if (!timer) return;
      window.clearTimeout(timer);
      timer = 0;
      button.classList.remove('holding');
      this.setStatus(hint);
    };
    const start = () => {
      if (timer) return;
      button.classList.add('holding');
      timer = window.setTimeout(() => {
        timer = 0;
        button.classList.remove('holding');
        this.setStatus('');
        action();
      }, HOLD_MS);
    };

    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Keeps the press from starting a text selection or a drag of the row.
      e.preventDefault();
      start();
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      button.addEventListener(type, cancel);
    }
    // A button also activates on Space/Enter, so holding the key holds the
    // button — `repeat` keeps auto-repeat from restarting anything.
    button.addEventListener('keydown', (e) => {
      if (!e.repeat && (e.key === ' ' || e.key === 'Enter')) start();
    });
    button.addEventListener('keyup', cancel);
  }

  private overwrite(id: string): void {
    if (!this.inGame) return;
    try {
      this.hooks.onOverwrite(id);
    } catch (err) {
      this.setStatus((err as Error).message, true);
      return;
    }
    this.setStatus('Save overwritten.');
    this.refresh();
  }

  private load(id: string): void {
    try {
      const save = readSave(id);
      void this.hooks.onLoad(save);
    } catch (err) {
      this.setStatus((err as Error).message, true);
    }
  }

  private download(id: string, map: string): void {
    try {
      const blob = new Blob([exportSave(id)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${map}-${new Date().toISOString().slice(0, 10)}.topdoom.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      this.setStatus((err as Error).message, true);
    }
  }
}
