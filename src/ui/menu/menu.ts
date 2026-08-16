/**
 * The start menu — launcher and pause screen in one: WAD/level/difficulty selection, the settings
 * and save/load tabs, and the changelog popup. See docs/menu.md.
 */
import { fetchLibrary, mapStyle, mergedMaps, uploadedSource, type WadSource } from '../../wad/library.ts';
import { describeMap, describeSource } from './labels.ts';
import { DEFAULT_SKILL, SKILL_NAMES, type Skill } from '../../game/skill.ts';
import { getAutorun, setAutorun } from '../../game/player.ts';
import {
  getRightMouseAction,
  setRightMouseAction,
  type RightMouseAction,
} from '../../game/input.ts';
import { getFpsCap, setFpsCap, type FpsCap } from '../../game.ts';
import { getInfiniteTallActors, setInfiniteTallActors } from '../../game/world.ts';
import { SavegamesUi, type SaveHooks, type SaveSetInfo } from './savegames.ts';
import { requiredWads, wadLabel, type MissingWad, type SaveMeta, type SaveWadSet } from '../../game/savegames.ts';
import { getProfilerVisible, setProfilerVisible } from '../devmode/profilerhud.ts';
import type { AudioEngine } from '../../audio/audio.ts';
import { DEVMODE, VERSION } from '../../constants.ts';

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

type Tab = 'newgame' | 'save' | 'load' | 'settings';
/** The Settings tab's own sub-tabs: everything key-related, and everything else. */
type SettingsTab = 'general' | 'controls';

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
  private musicSlider = el<HTMLInputElement>('music-volume-slider');
  private musicValue = el<HTMLSpanElement>('music-volume-value');
  private autorunCheckbox = el<HTMLInputElement>('autorun-checkbox');
  private shiftAction = el<HTMLSpanElement>('shift-action');
  private rightMouseSelect = el<HTMLSelectElement>('rightmouse-select');
  private fpsCapSelect = el<HTMLSelectElement>('fpscap-select');
  private infiniteTallCheckbox = el<HTMLInputElement>('infinitetall-checkbox');
  private profilerCheckbox = el<HTMLInputElement>('profiler-checkbox');
  private changelogRoot = el<HTMLDivElement>('changelog');
  private changelogText = el<HTMLPreElement>('changelog-text');
  private changelogLoaded = false;
  private tabButtons = {
    newgame: el<HTMLButtonElement>('tab-button-newgame'),
    save: el<HTMLButtonElement>('tab-button-save'),
    load: el<HTMLButtonElement>('tab-button-load'),
    settings: el<HTMLButtonElement>('tab-button-settings'),
  };
  private tabPanels = {
    newgame: el<HTMLDivElement>('tab-newgame'),
    save: el<HTMLDivElement>('tab-save'),
    load: el<HTMLDivElement>('tab-load'),
    settings: el<HTMLDivElement>('tab-settings'),
  };
  private activeTab: Tab = 'newgame';
  private settingsTabButtons = {
    general: el<HTMLButtonElement>('settings-tab-button-general'),
    controls: el<HTMLButtonElement>('settings-tab-button-controls'),
  };
  private settingsTabPanels = {
    general: el<HTMLDivElement>('settings-tab-general'),
    controls: el<HTMLDivElement>('settings-tab-controls'),
  };
  private savegames: SavegamesUi;

  private sources: WadSource[] = [];
  /**
   * `mergedMaps` per WAD set, for `describeSave`: building one merges every
   * lump directory in the set and titles every map in it, and a save list is a
   * page of rows all asking about the same handful of sets. Dropped whenever
   * `sources` changes, since an upload can complete a set that was short a file.
   */
  private mapCache = new Map<string, ReturnType<typeof mergedMaps>>();
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
    saves: SaveHooks,
  ) {
    this.onStart = onStart;
    this.onResume = onResume;
    this.audio = audio;
    this.savegames = new SavegamesUi(
      saves,
      (text, isError) => this.setStatus(text, isError),
      (meta) => this.describeSave(meta),
    );

    el<HTMLButtonElement>('iwad-upload').addEventListener('click', () => this.pickFile('IWAD'));
    el<HTMLButtonElement>('pwad-upload').addEventListener('click', () => this.pickFile('PWAD'));
    this.iwadSelect.addEventListener('change', () => this.selectIwad());
    this.fileInput.addEventListener('change', () => void this.onFilesChosen());
    this.levelSelect.addEventListener('change', () => {
      this.refreshButtons();
      this.saveSelection();
    });
    this.startButton.addEventListener('click', () => void this.startWithSkill(this.currentSkill()));
    this.resumeButton.addEventListener('click', () => this.onResume());
    for (const tab of Object.keys(this.tabButtons) as Tab[]) {
      this.tabButtons[tab].addEventListener('click', () => this.setTab(tab));
    }
    for (const tab of Object.keys(this.settingsTabButtons) as SettingsTab[]) {
      this.settingsTabButtons[tab].addEventListener('click', () => this.setSettingsTab(tab));
    }
    this.installDropTarget();
    this.installSkillSelect();
    this.installVolume();
    this.installAutorun();
    this.installRightMouse();
    this.installFpsCap();
    this.installInfiniteTall();
    this.installProfiler();
    this.installChangelog();
    this.setTab('newgame');
    this.setSettingsTab('general');
    // DEVMODE never changes at runtime, so the dev-only rows are revealed once.
    el<HTMLElement>('controls-dev').classList.toggle('hidden', !DEVMODE);
    el<HTMLElement>('settings-dev').classList.toggle('hidden', !DEVMODE);
    el<HTMLSpanElement>('menu-version').textContent = `v${VERSION}`;
  }

  /**
   * Reads the server library, then resolves the selection: the URL wins, the
   * stored selection is next, and failing both the first game WAD on offer.
   */
  async init(defaults: MenuDefaults): Promise<void> {
    this.setStatus('Scanning public/wads/ …');
    this.sources = await fetchLibrary();
    this.mapCache.clear();

    const stored = this.loadSelection();

    this.selectedIwad =
      (defaults.iwad ? this.findSource(defaults.iwad) : undefined) ??
      (stored ? this.findSource(stored.iwad) : undefined) ??
      this.sources.find((s) => s.type === 'IWAD') ??
      null;

    const wantedPwads = defaults.pwads?.length ? defaults.pwads : (stored?.pwads ?? []);
    this.selectedPwads = wantedPwads
      .map((key) => this.findSource(key))
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
    // The Save tab only exists while there is a game to save — same gate as
    // the resume button. Whoever was *on* it when the game ended is moved off
    // rather than left staring at a hidden tab's panel.
    this.tabButtons.save.classList.toggle('hidden', !inGame);
    if (!inGame && this.activeTab === 'save') this.setTab('newgame');
    this.savegames.refresh(inGame);
    this.refreshButtons();
  }

  close(): void {
    // Otherwise it would be waiting, still open, the next time the menu comes up.
    this.closeChangelog();
    // Nothing in the menu may keep focus once it's gone: a control that still
    // had it would go on taking keys the game wants (`isTyping`, game/input.ts)
    // — a level dropdown clicked on the way out would eat the arrow keys.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.root.contains(focused)) focused.blur();
    this.root.classList.add('hidden');
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private setTab(tab: Tab): void {
    this.activeTab = tab;
    for (const key of Object.keys(this.tabButtons) as Tab[]) {
      this.tabButtons[key].classList.toggle('active', key === tab);
      this.tabPanels[key].classList.toggle('hidden', key !== tab);
    }
    // A save list is only built while it's the tab on screen — see `SavegamesUi.setVisible`.
    this.savegames.setVisible(tab === 'save' || tab === 'load' ? tab : null);
  }

  /**
   * The Settings tab's sub-tabs. Like the tabs above it, the pick is kept
   * across opens rather than reset — nothing here is per-session state.
   */
  private setSettingsTab(tab: SettingsTab): void {
    for (const key of Object.keys(this.settingsTabButtons) as SettingsTab[]) {
      this.settingsTabButtons[key].classList.toggle('active', key === tab);
      this.settingsTabPanels[key].classList.toggle('hidden', key !== tab);
    }
  }

  /**
   * The two volume sliders. Dragging one is itself a user gesture, so the engine
   * can start its context and preview the change right here rather than waiting
   * for the level to start — which is the only way to set volume by ear.
   *
   * The music slider needs no preview of its own: it rides the track that is
   * already playing behind the menu, and there is nothing to audition on the
   * first visit, where no WAD set is loaded yet.
   */
  private installVolume(): void {
    const bind = (
      slider: HTMLInputElement,
      valueEl: HTMLSpanElement,
      current: number,
      set: (v: number) => void,
      preview?: () => void,
    ) => {
      const show = (v: number) => {
        slider.value = String(Math.round(v * 100));
        valueEl.textContent = `${Math.round(v * 100)}%`;
      };
      show(current);
      slider.addEventListener('input', () => {
        const v = Number(slider.value) / 100;
        set(v);
        show(v);
        this.audio.resume();
        preview?.();
      });
    };
    bind(
      this.volumeSlider,
      this.volumeValue,
      this.audio.volume,
      (v) => this.audio.setVolume(v),
      // The pickup blip: short, unmissable, and the sound a player hears most.
      () => this.audio.play('itemup'),
    );
    bind(this.musicSlider, this.musicValue, this.audio.music.volume, (v) => this.audio.music.setVolume(v));
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

  /**
   * The frame rate limit, `0` (unlimited) by default (`getFpsCap`). The running
   * level reads the setting per frame, so a change here applies without a
   * restart — same as volume and autorun. The `<option>` values are the capped
   * rates themselves.
   */
  private installFpsCap(): void {
    this.fpsCapSelect.value = String(getFpsCap());
    this.fpsCapSelect.addEventListener('change', () => {
      setFpsCap(Number(this.fpsCapSelect.value) as FpsCap);
    });
  }

  /**
   * Whether solid bodies block over their whole vertical extent, vanilla's
   * infinitely tall actors — off by default, and applied to the level already
   * running. docs/movement.md § Collision.
   */
  private installInfiniteTall(): void {
    this.infiniteTallCheckbox.checked = getInfiniteTallActors();
    this.infiniteTallCheckbox.addEventListener('change', () => {
      setInfiniteTallActors(this.infiniteTallCheckbox.checked);
    });
  }

  /**
   * The profiling overlay's on/off switch, in the DEVMODE-only section of the
   * General sub-tab. `setProfilerVisible` applies it to `#profiler-hud` itself,
   * so it takes effect on the running level like volume and the fps cap — the
   * point of the checkbox being to get the panel out of the way mid-play.
   */
  private installProfiler(): void {
    this.profilerCheckbox.checked = getProfilerVisible();
    this.profilerCheckbox.addEventListener('change', () => {
      setProfilerVisible(this.profilerCheckbox.checked);
    });
  }

  /**
   * The CHANGELOG reader behind the header's link. Dismissed by the close button, by clicking the
   * backdrop around the panel, or by Esc — see `closeChangelog` and docs/menu.md § Changelog.
   */
  private installChangelog(): void {
    el<HTMLButtonElement>('changelog-button').addEventListener('click', () => {
      this.changelogRoot.classList.remove('hidden');
      // Reopening always starts at the newest entry rather than where the last read left off.
      this.changelogText.scrollTop = 0;
      void this.loadChangelog();
    });
    el<HTMLButtonElement>('changelog-close').addEventListener('click', () => this.closeChangelog());
    this.changelogRoot.addEventListener('click', (e) => {
      if (e.target === this.changelogRoot) this.closeChangelog();
    });
  }

  /**
   * Fills the popup on first open. The file is a *dynamic* `import`, so the bundler resolves it at
   * build time (no `public/` copy, and nothing that can 404) but parks the text in its own chunk,
   * downloaded only by someone who actually opens the reader — docs/menu.md § Changelog.
   *
   * A failed load is reported in the panel and leaves `changelogLoaded` false, so simply reopening
   * retries.
   */
  private async loadChangelog(): Promise<void> {
    if (this.changelogLoaded) return;
    this.changelogText.textContent = 'Loading …';
    try {
      const { default: text } = await import('../../../CHANGELOG?raw');
      this.changelogText.textContent = text.trimEnd();
      this.changelogLoaded = true;
    } catch (err) {
      this.changelogText.textContent = `Could not load the changelog: ${(err as Error).message}`;
    }
  }

  /**
   * Closes the changelog popup, reporting whether it *was* open. `main.ts` calls this first in its
   * own Esc handler, so one Esc dismisses the popup instead of the whole menu — an explicit
   * hand-off rather than two window listeners racing over the same key.
   */
  closeChangelog(): boolean {
    if (this.changelogRoot.classList.contains('hidden')) return false;
    this.changelogRoot.classList.add('hidden');
    return true;
  }

  /** True once a level can actually be started. */
  get isReady(): boolean {
    return this.selectedIwad !== null && this.levelSelect.value !== '';
  }

  /**
   * Resolves a stored `WadSource.key` — `init`'s restored selection — against
   * the current library, uploads included, since `addFiles` unshifts a
   * re-uploaded file under the same key. A savegame's set does *not* come
   * through here: it resolves by content id (`resolveSaveWads`).
   */
  findSource(key: string): WadSource | undefined {
    return this.sources.find((s) => s.key.toLowerCase() === key.toLowerCase());
  }

  /**
   * Resolves a savegame's whole WAD set against the current library, in load
   * order — the one place that rule lives, so the save row and the load path
   * can't disagree about which files a save can be played with.
   *
   * Matching is by content id, the file's real identity, so a renamed WAD (or
   * the server's copy of one that was uploaded when the save was made) still
   * matches. The name is only the fallback *diagnosis*: a file matching by name
   * but not by id is the same WAD in a different version, worth saying
   * precisely rather than reporting as missing (docs/savegames.md § WAD-set
   * identity). `wads[0]` is the game WAD, so a file's role is just its position.
   *
   * A missing file is also classified, by `requiredWads`: only the game WAD and
   * the one `mapWad` names stop a load, since nothing else can have shaped what
   * the snapshot indexes into.
   */
  resolveSaveWads(save: SaveWadSet): { iwad?: WadSource; pwads: WadSource[]; missing: MissingWad[] } {
    const { wads, mapWad } = save;
    const required = requiredWads(wads, mapWad);
    const missing: MissingWad[] = [];
    const found = wads.map((wad, i) => {
      const source = this.sources.find((s) => s.id !== '' && s.id === wad.id);
      if (source) return source;
      missing.push({
        name: wadLabel(wad),
        role: i === 0 ? 'IWAD' : 'PWAD',
        wrongVersion: this.sources.some((s) => s.label.toLowerCase() === wad.name.toLowerCase()),
        required: required[i],
      });
      return undefined;
    });
    const [iwad, ...pwads] = found;
    // Add-ons the library no longer has are simply left out — a caller that
    // can't proceed without them reads `missing` instead.
    return { iwad, pwads: pwads.filter((p): p is WadSource => p !== undefined), missing };
  }

  /** `mergedMaps` for a set, from `mapCache` — see that field's doc. */
  private mapsFor(iwad: WadSource, pwads: WadSource[]): ReturnType<typeof mergedMaps> {
    const key = [iwad.key, ...pwads.map((p) => p.key)].join('\n');
    let maps = this.mapCache.get(key);
    if (!maps) {
      maps = mergedMaps(iwad, pwads);
      this.mapCache.set(key, maps);
    }
    return maps;
  }

  /**
   * What a save row shows beyond its own stored meta: the level named exactly as
   * the level select names it (`describeMap` — a save stores only the lump name,
   * which alone can't name a level, docs/wad.md § Level names), and whatever
   * `resolveSaveWads` reports as unavailable.
   */
  describeSave(meta: SaveMeta): SaveSetInfo {
    const { iwad, pwads, missing } = this.resolveSaveWads(meta);
    // Without the game WAD there is no map list to resolve against; the row
    // falls back to the bare lump name and says which file is missing.
    if (!iwad) return { level: meta.map, missing };
    const map = this.mapsFor(iwad, pwads).find((m) => m.name === meta.map);
    return { level: map ? describeMap(map, iwad.label) : meta.map, missing };
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

  /** Fired when the game-WAD select changes: adopts the pick and re-resolves the add-ons and level list under it. */
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
    // Emptying the scroller clamps its scrollTop to 0, so picking an add-on far down a
    // long list would jump the list back to the top. Restore the offset after refilling.
    const scrollTop = this.pwadList.scrollTop;
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
    this.pwadList.scrollTop = scrollTop;
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

    const maps = this.mapsFor(this.selectedIwad, this.selectedPwads);
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
      option.textContent = describeMap(map, this.selectedIwad.label);
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
      // The file just added may be the one a save was waiting for, so the save
      // rows are re-resolved here too: bringing a WAD back must clear its
      // "Missing …" warning right away, not on the menu's next open.
      this.mapCache.clear();
      this.savegames.refresh();
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
      // A dropped save import lands beside the WADs: `.json` can only be a
      // downloaded save, everything else keeps going to the WAD path.
      const saves = files.filter((f) => f.name.toLowerCase().endsWith('.json'));
      const wads = files.filter((f) => !saves.includes(f));
      if (saves.length > 0) void this.savegames.importFiles(saves);
      if (wads.length > 0) void this.addFiles(wads);
    });
  }

  /**
   * Starts with whatever is currently selected — used by ?map= deep links,
   * which skip the menu entirely and so run at the last skill picked. Settled
   * either way when the start is over, which is how `main.ts` knows a
   * deep-linked level has taken the screen (docs/menu.md § Session lifecycle).
   */
  submit(): Promise<void> {
    return this.startWithSkill(this.currentSkill());
  }

  private startWithSkill(skill: Skill): Promise<void> {
    if (!this.selectedIwad || !this.isReady) return Promise.resolve();
    this.startButton.disabled = true;
    // The level being replaced is disposed part-way through this, so there is
    // nothing to return to until it either resolves or fails.
    this.resumeButton.disabled = true;
    return Promise.resolve(
      this.onStart({
        iwad: this.selectedIwad,
        pwads: [...this.selectedPwads],
        map: this.levelSelect.value,
        skill,
      }),
    ).finally(() => this.refreshButtons());
  }
}
