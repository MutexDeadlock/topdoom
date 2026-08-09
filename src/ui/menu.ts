import {
  describeSource,
  fetchLibrary,
  mapStyle,
  mergedMaps,
  uploadedSource,
  type WadSource,
} from '../wad/library.ts';
import { DEFAULT_SKILL, SKILL_NAMES, type Skill } from '../game/skill.ts';
import { getAutorun, setAutorun } from '../game/player.ts';
import {
  getRightMouseAction,
  setRightMouseAction,
  type RightMouseAction,
} from '../game/input.ts';
import type { AudioEngine } from '../audio/audio.ts';
import { DEVMODE, VERSION } from '../constants.ts';

export interface Selection {
  iwad: WadSource;
  pwads: WadSource[];
  map: string;
  skill: Skill;
}

export interface MenuDefaults {
  /** Preselect by file name, as given in ?wad= / ?pwad=. Wins over the stored selection. */
  iwad?: string | null;
  pwads?: string[];
  map?: string | null;
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Tab = 'newgame' | 'settings';

const SKILL_STORAGE_KEY = 'topdoom.skill';
const SELECTION_STORAGE_KEY = 'topdoom.selection';

/** What `saveSelection` writes: `WadSource.key`s plus the level, all server-side. */
interface StoredSelection {
  iwad: string;
  pwads: string[];
  map: string;
}

/**
 * The start screen: pick a game WAD, stack any add-ons on top, choose a level.
 * WADs come either from public/wads/ or straight off the user's disk. It doubles
 * as the pause screen once a level is running — see `open` and docs/menu.md.
 */
export class Menu {
  private root = el<HTMLDivElement>('menu');
  private iwadSelect = el<HTMLSelectElement>('iwad-select');
  private pwadList = el<HTMLDivElement>('pwad-list');
  private levelSelect = el<HTMLSelectElement>('level-select');
  private skillSelect = el<HTMLSelectElement>('skill-select');
  private startButton = el<HTMLButtonElement>('start-button');
  private resumeButton = el<HTMLButtonElement>('resume-button');
  private statusEl = el<HTMLSpanElement>('menu-status');
  private fileInput = el<HTMLInputElement>('file-input');
  private volumeSlider = el<HTMLInputElement>('volume-slider');
  private volumeValue = el<HTMLSpanElement>('volume-value');
  private autorunCheckbox = el<HTMLInputElement>('autorun-checkbox');
  private shiftAction = el<HTMLSpanElement>('shift-action');
  private rightMouseSelect = el<HTMLSelectElement>('rightmouse-select');
  private tabButtons = {
    newgame: el<HTMLButtonElement>('tab-button-newgame'),
    settings: el<HTMLButtonElement>('tab-button-settings'),
  };
  private tabPanels = {
    newgame: el<HTMLDivElement>('tab-newgame'),
    settings: el<HTMLDivElement>('tab-settings'),
  };

  private sources: WadSource[] = [];
  private selectedIwad: WadSource | null = null;
  /** Ordered: add-ons are merged in the order the user picked them. */
  private selectedPwads: WadSource[] = [];
  /** Where an upload should land once the file dialog returns. */
  private uploadTarget: 'IWAD' | 'PWAD' = 'IWAD';

  private onStart: (selection: Selection) => void | Promise<void>;
  private onResume: () => void;
  private audio: AudioEngine;

  constructor(
    onStart: (selection: Selection) => void | Promise<void>,
    onResume: () => void,
    audio: AudioEngine,
  ) {
    this.onStart = onStart;
    this.onResume = onResume;
    this.audio = audio;

    el<HTMLButtonElement>('iwad-upload').addEventListener('click', () => this.pickFile('IWAD'));
    el<HTMLButtonElement>('pwad-upload').addEventListener('click', () => this.pickFile('PWAD'));
    this.iwadSelect.addEventListener('change', () => this.selectIwad());
    this.fileInput.addEventListener('change', () => void this.onFilesChosen());
    this.levelSelect.addEventListener('change', () => {
      this.refreshButtons();
      this.saveSelection();
    });
    this.startButton.addEventListener('click', () => this.startWithSkill(this.currentSkill()));
    this.resumeButton.addEventListener('click', () => this.onResume());
    for (const tab of Object.keys(this.tabButtons) as Tab[]) {
      this.tabButtons[tab].addEventListener('click', () => this.setTab(tab));
    }
    this.installDropTarget();
    this.installSkillSelect();
    this.installVolume();
    this.installAutorun();
    this.installRightMouse();
    this.setTab('newgame');
    // DEVMODE never changes at runtime, so the dev-only key row is revealed once.
    el<HTMLElement>('controls-dev').classList.toggle('hidden', !DEVMODE);
    el<HTMLSpanElement>('menu-version').textContent = `v${VERSION}`;
  }

  /**
   * Reads the server library, then resolves the selection: the URL wins, the
   * stored selection is next, and failing both the first game WAD on offer.
   */
  async init(defaults: MenuDefaults): Promise<void> {
    this.setStatus('Scanning public/wads/ …');
    this.sources = await fetchLibrary();

    const byKey = (name: string) =>
      this.sources.find((s) => s.key.toLowerCase() === name.toLowerCase());

    const stored = this.loadSelection();

    this.selectedIwad =
      (defaults.iwad ? byKey(defaults.iwad) : undefined) ??
      (stored ? byKey(stored.iwad) : undefined) ??
      this.sources.find((s) => s.type === 'IWAD') ??
      null;

    const wantedPwads = defaults.pwads?.length ? defaults.pwads : (stored?.pwads ?? []);
    this.selectedPwads = wantedPwads
      .map(byKey)
      .filter((s): s is WadSource => s !== undefined && s !== this.selectedIwad);
    // Restored add-ons can disagree with a game WAD that came from ?wad=.
    this.pruneIncompatiblePwads();

    this.render();
    const wantedMap = defaults.map ?? stored?.map ?? null;
    if (wantedMap) this.selectLevel(wantedMap);

    this.setStatus(this.sources.length === 0 ? 'No WADs found on the server — load one from disk.' : '');
  }

  /**
   * `inGame` says a level is loaded and paused behind the menu: the backdrop
   * turns translucent and "Return to game" appears. The active tab is whatever
   * the player last picked — reopening mid-level must not throw away the tab
   * they were on.
   */
  open(inGame = false): void {
    this.root.classList.remove('hidden');
    this.root.classList.toggle('ingame', inGame);
    this.resumeButton.classList.toggle('hidden', !inGame);
    this.refreshButtons();
  }

  close(): void {
    this.root.classList.add('hidden');
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private setTab(tab: Tab): void {
    for (const key of Object.keys(this.tabButtons) as Tab[]) {
      this.tabButtons[key].classList.toggle('active', key === tab);
      this.tabPanels[key].classList.toggle('hidden', key !== tab);
    }
  }

  /**
   * The sfx volume slider. Dragging it is itself a user gesture, so the engine
   * can start its context and preview the change right here rather than waiting
   * for the level to start — which is the only way to set volume by ear.
   */
  private installVolume(): void {
    const show = (v: number) => {
      this.volumeSlider.value = String(Math.round(v * 100));
      this.volumeValue.textContent = `${Math.round(v * 100)}%`;
    };
    show(this.audio.volume);
    this.volumeSlider.addEventListener('input', () => {
      const v = Number(this.volumeSlider.value) / 100;
      this.audio.setVolume(v);
      show(v);
      this.audio.resume();
      // The pickup blip: short, unmissable, and the sound a player hears most.
      this.audio.play('itemup');
    });
  }

  /**
   * Autorun defaults to on (`getAutorun`'s own default). It shares the `Shift`
   * row, whose description is *what that key does* — so the word has to follow
   * the checkbox rather than state one of the two cases and leave the other
   * to be inferred.
   */
  private installAutorun(): void {
    const show = (on: boolean) => {
      this.autorunCheckbox.checked = on;
      this.shiftAction.textContent = on ? 'walk' : 'run';
    };
    show(getAutorun());
    this.autorunCheckbox.addEventListener('change', () => {
      setAutorun(this.autorunCheckbox.checked);
      show(this.autorunCheckbox.checked);
    });
  }

  /**
   * What the right mouse button does — it has no fixed job since the camera
   * turns with Q/E rather than by dragging. Defaults to `previousweapon` (`getRightMouseAction`).
   * The `<option>` values are the `RightMouseAction` strings themselves.
   */
  private installRightMouse(): void {
    this.rightMouseSelect.value = getRightMouseAction();
    this.rightMouseSelect.addEventListener('change', () => {
      setRightMouseAction(this.rightMouseSelect.value as RightMouseAction);
    });
  }

  /** True once a level can actually be started. */
  get isReady(): boolean {
    return this.selectedIwad !== null && this.levelSelect.value !== '';
  }

  setStatus(text: string, isError = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', isError);
  }

  private render(): void {
    this.renderIwads();
    this.renderPwads();
    this.renderLevels();
  }

  private renderIwads(): void {
    this.iwadSelect.replaceChildren();
    const iwads = this.sources.filter((s) => s.type === 'IWAD');

    if (iwads.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No game WADs found — load one from disk.';
      this.iwadSelect.append(option);
      this.iwadSelect.disabled = true;
      return;
    }

    this.iwadSelect.disabled = false;
    for (const source of iwads) {
      const option = document.createElement('option');
      option.value = source.key;
      option.textContent = `${source.label}  —  ${describeSource(source)}`;
      this.iwadSelect.append(option);
    }
    if (this.selectedIwad) this.iwadSelect.value = this.selectedIwad.key;
  }

  /** Fired when the game-WAD select changes; mirrors the old radio-row callback. */
  private selectIwad(): void {
    const source = this.sources.find((s) => s.key === this.iwadSelect.value);
    if (!source) return;
    this.selectedIwad = source;
    this.selectedPwads = this.selectedPwads.filter((p) => p !== source);
    this.pruneIncompatiblePwads();
    this.render();
    this.saveSelection();
  }

  private renderPwads(): void {
    this.pwadList.replaceChildren();
    const iwadStyle = this.selectedIwad ? mapStyle(this.selectedIwad) : null;
    for (const source of this.sources) {
      // A PWAD uploaded via the "game WAD" picker still lands in selectedIwad
      // (see addFiles) and shouldn't also show up here as an add-on.
      if (source.type !== 'PWAD' || source === this.selectedIwad) continue;
      // Map-less add-ons (textures, sounds, ...) fit either game; one with
      // maps of its own only makes sense alongside a matching game WAD.
      const style = mapStyle(source);
      const incompatible = iwadStyle !== null && style !== null && style !== iwadStyle;
      const index = this.selectedPwads.indexOf(source);
      const row = this.makeRow(
        source,
        index >= 0,
        () => {
          if (index >= 0) this.selectedPwads.splice(index, 1);
          else this.selectedPwads.push(source);
          this.render();
          this.saveSelection();
        },
        incompatible,
      );
      if (index >= 0) {
        const order = document.createElement('span');
        order.className = 'meta';
        order.textContent = `#${index + 1}`;
        row.append(order);
      }
      this.pwadList.append(row);
    }
  }

  /** Drops any selected add-on whose own maps no longer match the selected game WAD. */
  private pruneIncompatiblePwads(): void {
    const iwadStyle = this.selectedIwad ? mapStyle(this.selectedIwad) : null;
    if (!iwadStyle) return;
    this.selectedPwads = this.selectedPwads.filter((p) => {
      const style = mapStyle(p);
      return style === null || style === iwadStyle;
    });
  }

  private makeRow(
    source: WadSource,
    selected: boolean,
    onPick: () => void,
    disabled = false,
  ): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'row' + (selected ? ' selected' : '') + (disabled ? ' disabled' : '');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selected;
    input.disabled = disabled;
    input.addEventListener('change', onPick);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = source.label;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = describeSource(source);

    row.append(input, name, meta);
    return row;
  }

  private renderLevels(): void {
    const previous = this.levelSelect.value;
    this.levelSelect.replaceChildren();

    if (!this.selectedIwad) {
      this.levelSelect.disabled = true;
      this.refreshButtons();
      return;
    }

    const maps = mergedMaps(this.selectedIwad, this.selectedPwads);
    this.levelSelect.disabled = maps.length === 0;

    // DOOM 1 names maps E<episode>M<mission>, so group them by episode.
    let group: HTMLOptGroupElement | null = null;
    let groupKey = '';
    for (const map of maps) {
      const key = /^E(\d)M\d$/.exec(map.name)?.[1] ?? '';
      if (!group || key !== groupKey) {
        group = document.createElement('optgroup');
        group.label = key ? `Episode ${key}` : 'Maps';
        groupKey = key;
        this.levelSelect.append(group);
      }
      const option = document.createElement('option');
      option.value = map.name;
      // Lump name first — it's what the level is picked by, and the only thing every map has.
      // Then its title where the WAD set knows one (docs/wad.md § Level names), and the provider
      // only when an add-on took the map over.
      const parts = [map.name];
      if (map.title) parts.push(map.title);
      if (map.provider !== this.selectedIwad.label) parts.push(map.provider);
      option.textContent = parts.join('  —  ');
      group.append(option);
    }

    if (maps.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'This WAD contains no maps';
      this.levelSelect.append(option);
    }

    if (previous && maps.some((m) => m.name === previous)) this.levelSelect.value = previous;
    this.refreshButtons();
  }

  /**
   * The difficulty select, at the bottom of the New Game tab. Static,
   * independent of the selected WADs: built once here. Picking a skill writes it
   * straight to storage, so the next visit — and any ?map= deep link, which
   * never passes the menu — starts at whatever was played last.
   */
  private installSkillSelect(): void {
    for (const skill of [1, 2, 3, 4, 5] as const) {
      const option = document.createElement('option');
      option.value = String(skill);
      option.textContent = SKILL_NAMES[skill];
      this.skillSelect.append(option);
    }
    this.skillSelect.value = String(this.storedSkill());
    this.skillSelect.addEventListener('change', () => {
      globalThis.localStorage?.setItem(SKILL_STORAGE_KEY, this.skillSelect.value);
    });
  }

  /** Reads back the last skill picked; falls back to vanilla's own default when unset or invalid. */
  private storedSkill(): Skill {
    const stored = Number(globalThis.localStorage?.getItem(SKILL_STORAGE_KEY));
    return stored >= 1 && stored <= 5 ? (stored as Skill) : DEFAULT_SKILL;
  }

  /**
   * What a start runs at: the select, which `installSkillSelect` seeded from
   * storage. Reading the control rather than storage keeps the pick working
   * where `localStorage` is unavailable and the write silently went nowhere.
   */
  private currentSkill(): Skill {
    const value = Number(this.skillSelect.value);
    return value >= 1 && value <= 5 ? (value as Skill) : DEFAULT_SKILL;
  }

  /**
   * Remembers the WAD set and level for the next visit. Called from the places
   * the *player* changes something, deliberately not from `render`: `init`
   * renders while restoring, and would write back a level select that hasn't
   * caught up with the stored map yet.
   *
   * Only server-side files are stored: an upload's bytes are gone after a
   * reload, so persisting its key would restore a selection that can never load
   * — better to leave the last restorable one in place. That also means a
   * missing manifest (every source gone, `selectedIwad` null) can't wipe a good
   * stored value.
   */
  private saveSelection(): void {
    if (!this.selectedIwad || this.selectedIwad.origin !== 'server') return;
    const stored: StoredSelection = {
      iwad: this.selectedIwad.key,
      pwads: this.selectedPwads.filter((p) => p.origin === 'server').map((p) => p.key),
      map: this.levelSelect.value,
    };
    globalThis.localStorage?.setItem(SELECTION_STORAGE_KEY, JSON.stringify(stored));
  }

  /**
   * The stored selection, or null if there is none or it isn't parseable. The
   * keys themselves aren't validated here — `init` resolves each against the
   * current library and drops whatever no longer exists.
   */
  private loadSelection(): StoredSelection | null {
    const raw = globalThis.localStorage?.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSelection>;
      if (typeof parsed?.iwad !== 'string') return null;
      return {
        iwad: parsed.iwad,
        pwads: Array.isArray(parsed.pwads) ? parsed.pwads.filter((p) => typeof p === 'string') : [],
        map: typeof parsed.map === 'string' ? parsed.map : '',
      };
    } catch {
      return null;
    }
  }

  private selectLevel(name: string): void {
    const upper = name.toUpperCase();
    if ([...this.levelSelect.options].some((o) => o.value === upper)) {
      this.levelSelect.value = upper;
      this.refreshButtons();
    }
  }

  private refreshButtons(): void {
    this.startButton.disabled = !this.isReady;
    // Only ever disabled for the duration of a start (see `startWithSkill`);
    // whether it's *shown* is `open`'s call.
    this.resumeButton.disabled = false;
  }

  private pickFile(target: 'IWAD' | 'PWAD'): void {
    this.uploadTarget = target;
    this.fileInput.multiple = target === 'PWAD';
    this.fileInput.value = '';
    this.fileInput.click();
  }

  private async onFilesChosen(): Promise<void> {
    const files = [...(this.fileInput.files ?? [])];
    if (files.length > 0) await this.addFiles(files, this.uploadTarget);
  }

  /**
   * Adds files from disk. `prefer` decides where an ambiguous pick lands; a file
   * that declares itself an IWAD is never silently treated as an add-on.
   */
  async addFiles(files: File[], prefer: 'IWAD' | 'PWAD' | 'auto' = 'auto'): Promise<void> {
    const added: string[] = [];
    for (const file of files) {
      try {
        const source = uploadedSource(file.name, await file.arrayBuffer());
        const existing = this.sources.findIndex((s) => s.key === source.key);
        if (existing >= 0) this.sources.splice(existing, 1, source);
        else this.sources.unshift(source);

        const asIwad = prefer === 'IWAD' || (prefer === 'auto' && source.type === 'IWAD');
        if (asIwad) {
          this.selectedIwad = source;
          this.selectedPwads = this.selectedPwads.filter((p) => p.key !== source.key);
          this.pruneIncompatiblePwads();
        } else if (!this.selectedPwads.some((p) => p.key === source.key)) {
          this.selectedPwads.push(source);
        }
        added.push(`${file.name} (${source.type})`);
      } catch (err) {
        this.setStatus(`${file.name}: ${(err as Error).message}`, true);
      }
    }

    if (added.length > 0) {
      this.render();
      this.saveSelection();
      this.setStatus(`Added ${added.join(', ')}`);
    }
  }

  private installDropTarget(): void {
    for (const type of ['dragenter', 'dragover']) {
      this.root.addEventListener(type, (e) => {
        e.preventDefault();
        this.root.classList.add('dragging');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      this.root.addEventListener(type, () => this.root.classList.remove('dragging'));
    }
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...((e as DragEvent).dataTransfer?.files ?? [])];
      if (files.length > 0) void this.addFiles(files);
    });
  }

  /**
   * Starts with whatever is currently selected — used by ?map= deep links,
   * which skip the menu entirely and so run at the last skill picked.
   */
  submit(): void {
    this.startWithSkill(this.currentSkill());
  }

  private startWithSkill(skill: Skill): void {
    if (!this.selectedIwad || !this.isReady) return;
    this.startButton.disabled = true;
    // The level being replaced is disposed part-way through this, so there is
    // nothing to return to until it either resolves or fails.
    this.resumeButton.disabled = true;
    void Promise.resolve(
      this.onStart({
        iwad: this.selectedIwad,
        pwads: [...this.selectedPwads],
        map: this.levelSelect.value,
        skill,
      }),
    ).finally(() => this.refreshButtons());
  }
}
