/**
 * The start menu — launcher and pause screen in one: WAD/level/difficulty selection, the settings
 * and save/load tabs, and the About and WAD Library popups. See docs/menu.md.
 */
import * as wadlib from '../../wad/library.ts';
import type { WadSource } from '../../wad/library.ts';
import { badge, describeMap, describeSource, rowButton, sourceColumnSpans } from './labels.ts';
import { AboutUi } from './about.ts';
import { WelcomeUi } from './welcome.ts';
import { confirmOnHold } from './hold.ts';
import { LibraryUi } from './library.ts';
import { WadInfoUi } from './wadinfo.ts';
import type { MenuOverlay } from './overlay.ts';
import { DEFAULT_SKILL, SKILL_NAMES, type Skill } from '../../game/skill.ts';
import { getAutorun, setAutorun } from '../../game/player.ts';
import {
  getRightMouseAction,
  setRightMouseAction,
  type RightMouseAction,
} from '../../game/input.ts';
import { getCameraMode, setCameraMode, type CameraMode } from '../../game/autocamera.ts';
import { getFpsCap, setFpsCap, type FpsCap } from '../../game.ts';
import { getInfiniteTallActors, setInfiniteTallActors } from '../../game/world.ts';
import { getDynamicLights, setDynamicLights } from '../../render/lights.ts';
import { getVoidFog, setVoidFog } from '../../render/voidfloor.ts';
import { getBloom, setBloom } from '../../render/bloom.ts';
import { getWallShade, setWallShade } from '../../render/wallshadow.ts';
import { getSkyTint, setSkyTint } from '../../render/skytint.ts';
import {
  getPlayerSpriteMode,
  setPlayerSpriteMode,
  type PlayerSpriteMode,
} from '../../wad/playerskin.ts';
import { getAutoSwitchWeapon, getPistolStart, setAutoSwitchWeapon, setPistolStart } from '../../game/inventory.ts';
import { SavegamesUi, type SaveHooks, type SaveSetInfo } from './savegames.ts';
import { ReplaysUi, type ReplayHooks } from './replays.ts';
import { isReplayFileName } from '../../game/replay.ts';
import { readStorage, readStorageObject, writeStorage } from '../../util/storage.ts';
import {
  requiredWads,
  standInBlocker,
  substitutableIwad,
  wadLabel,
  type MissingWad,
  type SaveWadSet,
  type StandInBlocker,
} from '../../game/savegames.ts';
import { getProfilerVisible, setProfilerVisible } from '../hud/profiler.ts';
import { getFpsVisible, setFpsVisible } from '../devmode/debughud.ts';
import type { AudioEngine } from '../../audio/audio.ts';
import { DEVMODE, VERSION } from '../../constants.ts';

export interface Selection {
  iwad: WadSource;
  pwads: WadSource[];
  map: string;
  skill: Skill;
  /** Whether the game starts recording a replay as it begins (docs/replays.md § Recording). */
  record?: boolean;
}

export interface MenuDefaults {
  /** Preselect by file name, as given in ?wad= / ?pwad=. Wins over the stored selection. */
  iwad?: string | null;
  pwads?: string[];
  map?: string | null;
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The menu's top-level tabs; exported for the F2/F3/F4 hotkeys in `main.ts`. */
export type MenuTab = 'newgame' | 'save' | 'load' | 'replays' | 'settings';

/** The Settings tab's own sub-tabs, in the order they are shown. */
type SettingsTab = 'general' | 'controls' | 'visuals' | 'audio';

const SKILL_STORAGE_KEY = 'skill';
const SELECTION_STORAGE_KEY = 'selection';

/** What `saveSelection` writes: `WadSource.key`s plus the level, for every source but an upload. */
interface StoredSelection {
  iwad: string;
  pwads: string[];
  /** Keys of picked add-ons that are unticked. Optional: absent means every pick is on. */
  disabled?: string[];
  map: string;
}

/**
 * The start screen: pick a game WAD, stack any add-ons on top, choose a level.
 * WADs come from public/game/, from the player's own library folder, or straight
 * off their disk — all three list and behave identically (`LibraryUi`,
 * docs/menu.md § WAD Library). It doubles as the pause screen once a level is
 * running — see `open` and docs/menu.md.
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
  private masterSlider = el<HTMLInputElement>('master-volume-slider');
  private masterValue = el<HTMLSpanElement>('master-volume-value');
  private volumeSlider = el<HTMLInputElement>('volume-slider');
  private volumeValue = el<HTMLSpanElement>('volume-value');
  private musicSlider = el<HTMLInputElement>('music-volume-slider');
  private musicValue = el<HTMLSpanElement>('music-volume-value');
  private autorunCheckbox = el<HTMLInputElement>('autorun-checkbox');
  private shiftAction = el<HTMLSpanElement>('shift-action');
  private rightMouseSelect = el<HTMLSelectElement>('rightmouse-select');
  private cameraModeSelect = el<HTMLSelectElement>('cameramode-select');
  private fpsCapSelect = el<HTMLSelectElement>('fpscap-select');
  private playerSpritesSelect = el<HTMLSelectElement>('playersprites-select');
  private infiniteTallCheckbox = el<HTMLInputElement>('infinitetall-checkbox');
  private dynLightsCheckbox = el<HTMLInputElement>('dynlights-checkbox');
  private voidFogCheckbox = el<HTMLInputElement>('voidfog-checkbox');
  private bloomCheckbox = el<HTMLInputElement>('bloom-checkbox');
  private wallShadeCheckbox = el<HTMLInputElement>('wallshade-checkbox');
  private skyTintCheckbox = el<HTMLInputElement>('skytint-checkbox');
  private pistolStartCheckbox = el<HTMLInputElement>('pistolstart-checkbox');
  private autoSwitchCheckbox = el<HTMLInputElement>('autoswitch-checkbox');
  private fpsCheckbox = el<HTMLInputElement>('fps-checkbox');
  private profilerCheckbox = el<HTMLInputElement>('profiler-checkbox');
  private tabButtons = {
    newgame: el<HTMLButtonElement>('tab-button-newgame'),
    save: el<HTMLButtonElement>('tab-button-save'),
    load: el<HTMLButtonElement>('tab-button-load'),
    replays: el<HTMLButtonElement>('tab-button-replays'),
    settings: el<HTMLButtonElement>('tab-button-settings'),
  };
  private tabPanels = {
    newgame: el<HTMLDivElement>('tab-newgame'),
    save: el<HTMLDivElement>('tab-save'),
    load: el<HTMLDivElement>('tab-load'),
    replays: el<HTMLDivElement>('tab-replays'),
    settings: el<HTMLDivElement>('tab-settings'),
  };
  private activeTab: MenuTab = 'newgame';
  private settingsTabButtons = {
    general: el<HTMLButtonElement>('settings-tab-button-general'),
    controls: el<HTMLButtonElement>('settings-tab-button-controls'),
    visuals: el<HTMLButtonElement>('settings-tab-button-visuals'),
    audio: el<HTMLButtonElement>('settings-tab-button-audio'),
  };
  private settingsTabPanels = {
    general: el<HTMLDivElement>('settings-tab-general'),
    controls: el<HTMLDivElement>('settings-tab-controls'),
    visuals: el<HTMLDivElement>('settings-tab-visuals'),
    audio: el<HTMLDivElement>('settings-tab-audio'),
  };
  private savegames: SavegamesUi;
  private replays: ReplaysUi;
  private recordToggle = el<HTMLButtonElement>('record-toggle');
  /** Whether the next game starts recording; session-only, so it can't outlive the tab it was set in. */
  private recordArmed = false;
  private library: LibraryUi;
  private about = new AboutUi();
  private welcome = new WelcomeUi();
  private wadinfo = new WadInfoUi();
  /**
   * Every popup that can sit over the menu, **topmost first** — the one statement of that order,
   * which `close`, `closeTopOverlay` and `hasOverlay` all derive from rather than each listing them
   * again. The reader leads because it opens from a row *inside* the WAD Library, the same relation
   * its `z-index` rung states in CSS (docs/styles.md § Tokens). Filled in the constructor: `library`
   * is not built until then.
   */
  private overlays: MenuOverlay[] = [];

  private sources: WadSource[] = [];
  /**
   * `mergedMaps` per WAD set, for `describeSave`: building one merges every
   * lump directory in the set and titles every map in it, and a save list is a
   * page of rows all asking about the same handful of sets. Dropped whenever
   * `sources` changes, since an upload can complete a set that was short a file.
   */
  private mapCache = new Map<string, ReturnType<typeof wadlib.mergedMaps>>();
  private selectedIwad: WadSource | null = null;
  /** Ordered: add-ons are merged in the order the user picked them. */
  private selectedPwads: WadSource[] = [];
  /**
   * Keys of picked add-ons the player has unticked. **Disabled, not removed** — the row stays in
   * the list with its place in the order, so a mod can be switched off for one run and back on
   * without being hunted down in the library again. Tracked as the *off* set so a newly picked
   * add-on is on by default, which is what picking it meant.
   */
  private disabledPwads = new Set<string>();

  private onStart: (selection: Selection) => void | Promise<void>;
  private onResume: () => void;
  private audio: AudioEngine;

  constructor(
    onStart: (selection: Selection) => void | Promise<void>,
    onResume: () => void,
    audio: AudioEngine,
    saves: SaveHooks,
    replays: ReplayHooks,
  ) {
    this.onStart = onStart;
    this.onResume = onResume;
    this.audio = audio;
    this.savegames = new SavegamesUi(
      saves,
      (text, isError) => this.setStatus(text, isError),
      (meta) => this.describeSave(meta),
    );
    this.replays = new ReplaysUi(
      replays,
      (text, isError) => this.setStatus(text, isError),
      (meta) => this.describeSave(meta),
    );

    this.library = new LibraryUi({
      sources: () => this.sources,
      iwad: () => this.selectedIwad,
      pwads: () => this.selectedPwads,
      applyPicks: (iwad, pwads) => this.applyPicks(iwad, pwads),
      setLibrarySources: (sources) => this.setLibrarySources(sources),
      pickFiles: () => this.pickFiles(),
      showTextFile: (source) => this.wadinfo.open(source),
    });
    this.overlays = [this.wadinfo, this.about, this.welcome, this.library];
    el<HTMLButtonElement>('library-button').addEventListener('click', () => this.library.open());
    this.iwadSelect.addEventListener('change', () => this.selectIwad());
    this.fileInput.addEventListener('change', () => void this.onFilesChosen());
    this.levelSelect.addEventListener('change', () => {
      this.refreshButtons();
      this.saveSelection();
    });
    confirmOnHold(this.startButton, {
      hint: 'Hold Start new game to abandon the game you are running.',
      setStatus: (text) => this.setStatus(text),
      action: () => void this.startWithSkill(this.currentSkill()),
      // Only a start that throws a running level away is worth confirming; from the launcher it
      // stays an ordinary button.
      required: () => this.inGame,
    });
    this.resumeButton.addEventListener('click', () => this.onResume());
    for (const tab of Object.keys(this.tabButtons) as MenuTab[]) {
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
    this.installCameraMode();
    this.installFpsCap();
    this.installInfiniteTall();
    this.installDynamicLights();
    // The presentation toggles, each read live by the module that owns it so a change reaches the
    // level already running — docs/render.md, and docs/lights.md § Turning it on for the bloom,
    // which is **off** by default alone among them because of what it costs.
    this.installToggle(this.voidFogCheckbox, getVoidFog, setVoidFog);
    this.installToggle(this.wallShadeCheckbox, getWallShade, setWallShade);
    this.installToggle(this.skyTintCheckbox, getSkyTint, setSkyTint);
    this.installToggle(this.bloomCheckbox, getBloom, setBloom);
    this.installPlayerSprites();
    this.installPistolStart();
    this.installAutoSwitch();
    this.installFps();
    this.installProfiler();
    this.installRecordToggle();
    this.installAbout();
    this.setTab('newgame');
    this.setSettingsTab('general');
    // DEVMODE never changes at runtime, so the dev-only row is revealed once.
    el<HTMLElement>('controls-dev').classList.toggle('hidden', !DEVMODE);
    el<HTMLSpanElement>('menu-version').textContent = `v${VERSION}`;
  }

  /**
   * Reads the server library, then resolves the selection: the URL wins, the
   * stored selection is next, and failing both the first game WAD on offer.
   */
  async init(defaults: MenuDefaults): Promise<void> {
    this.setStatus('Scanning public/game/ …');
    // The player's own folder is restored from its memo, then rescanned where the permission
    // already stands — both prompt for nothing, because this is the boot path
    // (docs/wad.md § The player's own library).
    const [served] = await Promise.all([
      wadlib.fetchLibrary(),
      wadlib.restoreLibrary().then(wadlib.rescanIfPermitted),
    ]);
    this.sources = [...wadlib.librarySources(), ...served];
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
    // A key naming an add-on that is no longer picked is harmless — it simply matches nothing.
    this.disabledPwads = new Set(stored?.disabled ?? []);

    this.render();
    const wantedMap = defaults.map ?? stored?.map ?? null;
    if (wantedMap) this.selectLevel(wantedMap);

    this.setStatus(this.sources.length === 0 ? 'No WADs found on the server — open the WAD Library to add your own.' : '');
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
    this.replays.refresh(inGame);
    this.refreshButtons();
  }

  /**
   * Brings the welcome popup up over the launcher, unless the player has muted it — `main.ts`'s
   * boot, once the menu is open (docs/menu.md § Welcome popup). Not part of `open`, which is also
   * the pause screen: a run interrupted by ESC is nobody's first look at the game.
   */
  showWelcome(): void {
    this.welcome.open();
  }

  close(): void {
    // Otherwise they would be waiting, still open, the next time the menu comes up.
    for (const overlay of this.overlays) overlay.close();
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

  /**
   * Brings one tab to the front, opening the menu first if it is closed — what the
   * F2/F3/F4 hotkeys do (docs/menu.md § Hotkeys). `inGame` is `open`'s and gates Save
   * the same way: with no level loaded there is nothing to save, so the key does
   * nothing rather than opening the menu on a hidden tab. Reports whether the tab is up.
   */
  showTab(tab: MenuTab, inGame: boolean): boolean {
    if (tab === 'save' && !inGame) return false;
    if (!this.isOpen) this.open(inGame);
    this.setTab(tab);
    return true;
  }

  /**
   * Dismisses whichever overlay is up, topmost first, and reports whether there was one — the
   * hand-off `main.ts` gives ESC before it acts on the menu itself. The order is `overlays`' and
   * lives here rather than in the caller, so another overlay is one edit and never changes what ESC
   * does elsewhere.
   */
  closeTopOverlay(): boolean {
    return this.overlays.some((overlay) => overlay.close());
  }

  /** Whether any of them is up — the same list `closeTopOverlay` walks. */
  get hasOverlay(): boolean {
    return this.overlays.some((overlay) => overlay.isOpen);
  }

  /** True once a level can actually be started. */
  get isReady(): boolean {
    return this.selectedIwad !== null && this.levelSelect.value !== '';
  }

  /**
   * Resolves a stored `WadSource.key` — `init`'s restored selection — against
   * the current library, uploads included, since `addFiles` unshifts a
   * re-uploaded file under the same key. A savegame's set does *not* come
   * through here: it resolves by content ID (`resolveSaveWads`).
   */
  findSource(key: string): WadSource | undefined {
    return this.sources.find((s) => s.key.toLowerCase() === key.toLowerCase());
  }

  /**
   * Resolves a savegame's whole WAD set against the current library, in load order — the one place
   * that rule lives, so the save row and the load path can't disagree about which files a save can
   * be played with. Matching is by content ID; the name is only the fallback *diagnosis*, and
   * `wads[0]` is the game WAD, so a file's role is its position. `requiredWads` decides which
   * missing file stops a load, and a stand-in taken here is the one thing that releases `wads[0]`
   * from that (docs/savegames.md § A stand-in game WAD, § WAD-set identity).
   */
  resolveSaveWads(save: SaveWadSet): { iwad?: WadSource; pwads: WadSource[]; missing: MissingWad[] } {
    const { wads, mapWad, patchWads } = save;
    const required = requiredWads(wads, mapWad, patchWads);
    const found = wads.map((wad) => this.sources.find((s) => s.id !== '' && s.id === wad.id));
    // The add-ons are what decides whether a stand-in is safe — a level they supply is one the
    // game WAD would not have to — so they are resolved before the game WAD is chosen against
    // them. With no candidate the load is blocked after all.
    const addOns = found.slice(1).filter((s): s is WadSource => s !== undefined);
    const standIn = found[0] ? {} : this.substituteIwad(save, addOns);
    found[0] ??= standIn.source;
    // A stand-in under the game WAD's own name is left unnamed as one: that is the file in another
    // version, which `wrongVersion` already says (docs/savegames.md § A stand-in game WAD).
    const named = this.sourceNamed(wads[0]?.name ?? '');
    const substitute = standIn.source && standIn.source !== named ? standIn.source.label : undefined;

    // A stand-in is a note on a file that *was* found, so index 0 keeps its entry either way.
    const missing: MissingWad[] = [];
    wads.forEach((wad, i) => {
      const stoodIn = i === 0 && standIn.source !== undefined;
      if (found[i] && !stoodIn) return;
      missing.push({
        name: wadLabel(wad),
        role: i === 0 ? 'IWAD' : 'PWAD',
        wrongVersion: this.sourceNamed(wad.name) !== undefined,
        required: required[i] && !stoodIn,
        ...(stoodIn && substitute ? { substitute } : {}),
        ...(i === 0 && standIn.blockedBy ? { blockedBy: standIn.blockedBy } : {}),
      });
    });
    const [iwad, ...pwads] = found;
    // Add-ons the library no longer has are simply left out — a caller that
    // can't proceed without them reads `missing` instead.
    return { iwad, pwads: pwads.filter((p): p is WadSource => p !== undefined), missing };
  }

  /**
   * What a save row shows beyond its own stored meta: the level named exactly as
   * the level select names it (`describeMap` — a save stores only the lump name,
   * which alone can't name a level, docs/wad.md § Level names), and whatever
   * `resolveSaveWads` reports as unavailable.
   */
  describeSave(meta: SaveWadSet): SaveSetInfo {
    const { iwad, pwads, missing } = this.resolveSaveWads(meta);
    // Without the game WAD there is no map list to resolve against; the row
    // falls back to the bare lump name and says which file is missing.
    if (!iwad) return { level: meta.map, missing };
    const map = this.mapsFor(iwad, pwads).find((m) => m.name === meta.map);
    return { level: map ? describeMap(map, iwad.label) : meta.map, missing };
  }

  /**
   * The menu's status line — or the WAD Library's, while that overlay is up. It covers `#menu`
   * completely, so everything raised behind it (a file the overlay's own `Add single WADs…` just
   * loaded, a WAD that wouldn't parse) would otherwise be reported to a line nobody can see, and
   * would then surface on the New Game tab once the overlay closed, out of the context that
   * explains it. docs/menu.md § WAD Library.
   */
  setStatus(text: string, isError = false): void {
    if (this.library.isOpen) {
      this.library.showStatus(text, isError);
      return;
    }
    this.statusEl.textContent = text;
    // Clamped to two lines (menu.css), so the whole of a long one lives in the tooltip.
    this.statusEl.title = text;
    this.statusEl.classList.toggle('error', isError);
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

  /**
   * Whether a level is loaded and paused behind the menu. `open`'s own flag, read back off the
   * class it sets rather than mirrored in a field — one owner for the state, so the two can't
   * disagree about what the backdrop is showing.
   */
  private get inGame(): boolean {
    return this.root.classList.contains('ingame');
  }

  private setTab(tab: MenuTab): void {
    this.activeTab = tab;
    // A message explains the tab it was raised on; carried onto the next one it explains nothing.
    this.setStatus('');
    for (const key of Object.keys(this.tabButtons) as MenuTab[]) {
      this.tabButtons[key].classList.toggle('active', key === tab);
      this.tabPanels[key].classList.toggle('inactive', key !== tab);
    }
    // A save list is only built while it's the tab on screen — see `SavegamesUi.setVisible`.
    this.savegames.setVisible(tab === 'save' || tab === 'load' ? tab : null);
    this.replays.setVisible(tab === 'replays');
  }

  /**
   * The Settings tab's sub-tabs. Like the tabs above it, the pick is kept
   * across opens rather than reset — nothing here is per-session state.
   */
  private setSettingsTab(tab: SettingsTab): void {
    for (const key of Object.keys(this.settingsTabButtons) as SettingsTab[]) {
      this.settingsTabButtons[key].classList.toggle('active', key === tab);
      this.settingsTabPanels[key].classList.toggle('inactive', key !== tab);
    }
  }

  /**
   * The three volume sliders. Dragging one is itself a user gesture, so the engine can start its
   * context and preview the change here rather than at level start — the only way to set volume by
   * ear. The music slider needs no preview of its own (it rides the track already playing behind
   * the menu); the master slider takes the sfx one's.
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
    // The pickup blip: short, unmissable, and the sound a player hears most.
    const blip = () => this.audio.play('itemup');
    bind(this.masterSlider, this.masterValue, this.audio.masterVolume, (v) => this.audio.setMasterVolume(v), blip);
    bind(this.volumeSlider, this.volumeValue, this.audio.volume, (v) => this.audio.setVolume(v), blip);
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
   * Whether the camera frames itself from the openness around the player
   * (`auto`, the default) or stays on the manual `+ - [ ]` keys — applied to
   * the level already running, read per tic. The `<option>` values are the
   * `CameraMode` strings themselves. docs/camera.md § Auto camera.
   */
  private installCameraMode(): void {
    this.cameraModeSelect.value = getCameraMode();
    this.cameraModeSelect.addEventListener('change', () => {
      setCameraMode(this.cameraModeSelect.value as CameraMode);
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
   * Whether GLDEFS dynamic lights are drawn — on by default, and applied to the level already
   * running, since the renderer reads the flag per frame. docs/lights.md § The toggle.
   */
  private installDynamicLights(): void {
    this.dynLightsCheckbox.checked = getDynamicLights();
    this.dynLightsCheckbox.addEventListener('change', () => {
      setDynamicLights(this.dynLightsCheckbox.checked);
    });
  }

  /**
   * One checkbox against the module-level flag it shows: the setting's own `get`/`set` pair is the
   * whole of it, since every such flag is read live where it is used.
   * docs/menu.md § Persisted settings.
   */
  private installToggle(box: HTMLInputElement, read: () => boolean, write: (on: boolean) => void): void {
    box.checked = read();
    box.addEventListener('change', () => write(box.checked));
  }

  /**
   * When the player's billboard draws the shipped weapon-matching art rather than the loaded set's
   * own `PLAY` — `auto` by default, and read per drawn frame, so a change applies to the level
   * already running. docs/sprites.md § Weapon-matching player sprites.
   */
  private installPlayerSprites(): void {
    this.playerSpritesSelect.value = getPlayerSpriteMode();
    this.playerSpritesSelect.addEventListener('change', () => {
      setPlayerSpriteMode(this.playerSpritesSelect.value as PlayerSpriteMode);
    });
  }

  /**
   * Whether every level is entered on a fresh inventory rather than carrying one over — off by
   * default, read at each level transition, so it applies to the run already in progress.
   * docs/items.md § Pistol start.
   */
  private installPistolStart(): void {
    this.pistolStartCheckbox.checked = getPistolStart();
    this.pistolStartCheckbox.addEventListener('change', () => {
      setPistolStart(this.pistolStartCheckbox.checked);
    });
  }

  /**
   * The record toggle beside the level and difficulty pickers. A button rather than a checkbox:
   * it reads as one of the three things being chosen about the game, and says which state it is
   * in rather than what ticking it would mean. docs/menu.md § Replays tab.
   */
  private installRecordToggle(): void {
    const show = () => {
      this.recordToggle.textContent = this.recordArmed ? '● Recording' : 'Not recording';
      this.recordToggle.setAttribute('aria-pressed', String(this.recordArmed));
      this.recordToggle.title = this.recordArmed
        ? 'This game is recorded; the replay is stored when it ends'
        : 'Record this game as a replay';
    };
    show();
    this.recordToggle.addEventListener('click', () => {
      this.recordArmed = !this.recordArmed;
      show();
    });
  }

  /**
   * Whether ammo collected from empty and a weapon running dry pick a weapon for you — on by
   * default, read at each pickup and each trigger pull, so it applies to the run already in
   * progress. docs/weapons.md § Automatic weapon switching.
   */
  private installAutoSwitch(): void {
    this.autoSwitchCheckbox.checked = getAutoSwitchWeapon();
    this.autoSwitchCheckbox.addEventListener('change', () => {
      setAutoSwitchWeapon(this.autoSwitchCheckbox.checked);
    });
  }

  /**
   * The top-left status text's on/off switch, beside the profiler's in the
   * Debug / Dev section. Like it, `setFpsVisible` applies to `#hud` itself, so
   * it takes effect on the running level — see docs/menu.md § FPS counter.
   */
  private installFps(): void {
    this.fpsCheckbox.checked = getFpsVisible();
    this.fpsCheckbox.addEventListener('change', () => {
      setFpsVisible(this.fpsCheckbox.checked);
    });
  }

  /**
   * The profiling overlay's on/off switch, in the Debug / Dev section of the
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
   * The two header links, each opening `AboutUi` on its own tab — see docs/menu.md § About. The
   * popup handles its own dismissal; `Menu` only decides when it comes up, and closes it with the
   * menu (`close`, `closeTopOverlay`).
   */
  private installAbout(): void {
    el<HTMLButtonElement>('about-button').addEventListener('click', () => this.about.open('about'));
    el<HTMLButtonElement>('changelog-button').addEventListener('click', () =>
      this.about.open('changelog'),
    );
  }

  /**
   * A game WAD that may stand in for the one a save's set names, when the library no longer has
   * it — the first loaded IWAD whose own maps follow the same scheme as the saved map name
   * (`mapNameStyle`), since a DOOM II map needs a DOOM II asset set and a DOOM one a DOOM one.
   * `substitutableIwad` has already said whether a stand-in is admissible at all; this only picks
   * which. A candidate needs no content ID: nothing matches it by identity, which is the point.
   * docs/savegames.md § A stand-in game WAD.
   */
  private substituteIwad(
    save: SaveWadSet,
    pwads: WadSource[],
  ): { source?: WadSource; blockedBy?: StandInBlocker } {
    if (!substitutableIwad(save.wads, save.mapWad)) return {};
    const style = wadlib.mapNameStyle(save.map);
    const named = this.sourceNamed(save.wads[0]?.name ?? '');
    const candidates = this.sources.filter(
      (s) => s.type === 'IWAD' && (style === null || wadlib.mapStyle(s) === style),
    );
    // The same file in another version is what the player most likely still means by it, so it
    // wins over an unrelated game WAD — and the row then says `Other version:` rather than naming
    // the file as a stand-in for itself (`resolveSaveWads`).
    candidates.sort((a, b) => Number(b === named) - Number(a === named));

    let blockedBy: StandInBlocker | undefined;
    for (const source of candidates) {
      // `mergedMaps` attributes each map to the providing file's label, so that is the identity
      // `standInBlocker` compares here — a content ID is what the load gate compares instead.
      const maps = this.mapsFor(source, pwads);
      const blocker = standInBlocker(
        save.maps ?? [],
        source.label,
        (map) => maps.find((m) => m.name === map)?.provider ?? null,
      );
      if (!blocker) return { source };
      blockedBy ??= blocker;
    }
    return { blockedBy };
  }

  /**
   * The library's file under a save's stored *name*, which is what a save falls back to where a
   * content ID matches nothing: the same file in another version. Both readings of that fallback
   * ask here — `resolveSaveWads` for `wrongVersion`, `substituteIwad` for the candidate a stand-in
   * prefers — so the row and the pick cannot disagree about which file the player still means.
   */
  private sourceNamed(name: string): WadSource | undefined {
    return this.sources.find((s) => s.label.toLowerCase() === name.toLowerCase());
  }

  /** `mergedMaps` for a set, from `mapCache` — see that field's doc. */
  private mapsFor(iwad: WadSource, pwads: WadSource[]): ReturnType<typeof wadlib.mergedMaps> {
    const key = [iwad.key, ...pwads.map((p) => p.key)].join('\n');
    let maps = this.mapCache.get(key);
    if (!maps) {
      maps = wadlib.mergedMaps(iwad, pwads);
      this.mapCache.set(key, maps);
    }
    return maps;
  }

  private render(): void {
    this.renderIwads();
    this.renderPwads();
    this.renderLevels();
    // The overlay draws against the same `sources`, so it redraws with the lists under it — its own
    // draft is untouched by this (docs/menu.md § WAD Library).
    this.library.refresh();
  }

  private renderIwads(): void {
    this.iwadSelect.replaceChildren();
    const iwads = this.sources.filter((s) => s.type === 'IWAD');

    if (iwads.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No game WADs found — open the WAD Library to add your own.';
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

  /**
   * Fired when the game-WAD select changes: adopts the pick and re-resolves the add-ons and level
   * list under it.
   */
  private selectIwad(): void {
    const source = this.sources.find((s) => s.key === this.iwadSelect.value);
    if (source) void this.adoptIwad(source);
  }

  /**
   * Adopts a source as the game WAD: the New Game tab's select, which picks one file at a time.
   * The WAD Library commits a whole set instead (`applyPicks`); both prune through `pwadsFor`, so
   * the two can't drift on what picking a game WAD does to the add-ons.
   */
  private async adoptIwad(source: WadSource): Promise<void> {
    await this.identify(source);
    this.takeAsIwad(source);
    this.render();
    this.saveSelection();
  }

  /**
   * Drops one add-on from the set — the `×` on its own row, the only way a pick leaves the New Game
   * tab. Adding is the WAD Library's job (`applyPicks`), so this half needs no `identify`.
   */
  private removePwad(source: WadSource): void {
    const index = this.selectedPwads.indexOf(source);
    if (index < 0) return;
    this.selectedPwads.splice(index, 1);
    // Nothing should remember an off-flag for a row that is gone; re-picking it starts on.
    this.disabledPwads.delete(source.key);
    this.render();
    this.saveSelection();
  }

  /**
   * Adopts the WAD Library's whole pick in one go — the overlay stages its ticks and commits them
   * here, on Apply (docs/menu.md § WAD Library). A set rather than a row at a time, so a game WAD
   * and the add-ons picked beside it land together rather than in an order the player never chose.
   */
  private async applyPicks(iwad: WadSource | null, pwads: readonly WadSource[]): Promise<void> {
    // Together, since each may read and hash a whole file off disk and no two touch each other.
    await Promise.all((iwad ? [iwad, ...pwads] : pwads).map((source) => this.identify(source)));

    // An off-flag outlives only an add-on that was in the set before and still is — anything picked
    // again after being dropped starts on, the rule `takeAsPwad` keeps for a single tick.
    const before = new Set(this.selectedPwads.map((p) => p.key));
    const after = new Set(pwads.map((p) => p.key));
    this.disabledPwads = new Set([...this.disabledPwads].filter((k) => before.has(k) && after.has(k)));

    this.selectedIwad = iwad;
    this.selectedPwads = [...pwads];
    this.render();
    this.saveSelection();
  }

  /**
   * What picking actually does to the selection, with no redraw of its own — so `addFiles`, which
   * adopts a whole drop before drawing once, applies the identical rules rather than restating
   * them. The redraw and the save stay with the callers above, which pick one file at a time.
   */
  private takeAsIwad(source: WadSource): void {
    // Nothing is dropped from the add-ons here: one a new game WAD can't take goes quiet in the
    // list instead, and comes back the moment one that can is picked (docs/menu.md § Picking a WAD
    // set).
    this.selectedIwad = source;
  }

  private takeAsPwad(source: WadSource): void {
    if (this.selectedPwads.some((p) => p.key === source.key)) return;
    // As above: an off-flag left over from an earlier pick of the same file must not survive into
    // this one, or the add-on lands already unticked.
    this.disabledPwads.delete(source.key);
    this.selectedPwads.push(source);
  }

  /**
   * Gives a source its content ID before it can end up in a savegame. Only a library file ever
   * needs this — its scan read a few hundred KB rather than the whole file — and the answer is
   * remembered on disk, so it is hashed once ever (docs/wad.md § The player's own library).
   */
  private async identify(source: WadSource): Promise<void> {
    if (source.id) return;
    try {
      await wadlib.ensureWadId(source);
      await wadlib.rememberLibraryId(source);
    } catch (err) {
      // A file that can't be read still selects: the failure to *load* it is the level start's to
      // report, with the WAD set in hand, rather than this one's on a tick.
      this.setStatus(`${source.label}: ${(err as Error).message}`, true);
    }
  }

  /**
   * Replaces every library-provided source with what the folder now holds, keeping the picks that
   * survive.
   */
  private setLibrarySources(sources: WadSource[]): void {
    const byKey = new Map(sources.map((s) => [s.key, s]));
    const carry = (source: WadSource): WadSource | null =>
      source.origin === 'library' ? (byKey.get(source.key) ?? null) : source;

    this.sources = [...sources, ...this.sources.filter((s) => s.origin !== 'library')];
    // A rescan builds fresh source objects, and the selection holds them by identity — so a file
    // still in the folder keeps its place rather than silently unticking itself.
    if (this.selectedIwad) this.selectedIwad = carry(this.selectedIwad);
    this.selectedPwads = this.selectedPwads
      .map(carry)
      .filter((s): s is WadSource => s !== null);
    this.mapCache.clear();
    this.render();
    this.savegames.refresh();
    this.saveSelection();
  }

  /**
   * The add-ons **the player has picked**, in merge order — not every add-on on offer. Browsing is
   * the WAD Library's job (docs/menu.md § WAD Library), so this list is the picks themselves:
   * short, always exactly what a start will merge, and never a second picker that would have to
   * agree with the first about what is compatible.
   */
  private renderPwads(): void {
    // Emptying the scroller clamps its scrollTop to 0, so removing an add-on far down a
    // long list would jump the list back to the top. Restore the offset after refilling.
    const scrollTop = this.pwadList.scrollTop;
    this.pwadList.replaceChildren();
    const active = this.activePwads();
    // The badge column is only rendered when something in the list has a reason to give — it costs
    // the name column its width, and a game WAD that suits every pick is the ordinary case. When it
    // is rendered it is rendered on *every* row, empty ones included, or the fixed-width columns
    // behind it would begin somewhere different on each row.
    const reasons = this.selectedPwads.map((source) => this.mismatchReason(source));
    const anyReason = reasons.some((reason) => reason !== '');
    for (const [index, source] of this.selectedPwads.entries()) {
      const reason = reasons[index];
      const enabled = reason === '' && !this.disabledPwads.has(source.key);
      const row = document.createElement('label');
      row.className = 'row' + (enabled ? ' selected' : '') + (reason === '' ? '' : ' disabled');

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = enabled;
      // A pick the game WAD can't take keeps its row and its off-flag untouched, so it comes back
      // ticked the moment a game WAD that suits it is picked again (docs/menu.md § Picking a WAD
      // set).
      input.disabled = reason !== '';
      input.title =
        reason === ''
          ? 'Merge this add-on into the game'
          : `Not merged: ${source.label} doesn't fit ${this.selectedIwad?.label ?? 'the game WAD'}`;
      input.addEventListener('change', () => this.setPwadEnabled(source, input.checked));

      const name = document.createElement('span');
      name.className = 'name truncate';
      name.textContent = source.label;

      // The merge position among the add-ons actually being merged, so the numbers stay 1..n with
      // no gaps when one is switched off.
      const order = document.createElement('span');
      order.className = 'meta order truncate';
      order.textContent = enabled ? `#${active.indexOf(source) + 1}` : 'off';

      row.append(
        input,
        name,
        ...(anyReason ? [badge(reason, 'reason')] : []),
        // The same columns the WAD Library lists, so a file reads identically in both places —
        // just narrower, since this panel has a fraction of the overlay's width.
        ...sourceColumnSpans(source, () => this.wadinfo.open(source)),
        order,
        this.removeButton(source),
      );
      this.pwadList.append(row);
    }
    this.pwadList.scrollTop = scrollTop;
  }

  /**
   * Why the selected game WAD can't merge one of the picks, as the badge its row carries — '' when
   * it can. The rule is `library.ts: fitsGameWad`'s, the same one `pwadsFor` and the WAD Library's
   * greying read; only the wording is shorter than the overlay's, this panel being a fraction of
   * its width. See docs/menu.md § Picking a WAD set.
   */
  private mismatchReason(source: WadSource): string {
    if (this.selectedIwad && source.key === this.selectedIwad.key) return 'game WAD';
    if (wadlib.fitsGameWad(this.selectedIwad, source)) return '';
    return wadlib.mapStyle(source) === 'doom1' ? 'DOOM 1' : 'DOOM II';
  }

  /**
   * The add-ons a start would actually merge: picked, still ticked, *and* mergeable with the game
   * WAD in front of them (`pwadsFor`). Everything that resolves a WAD set — the level list, the
   * start, the stored selection's ordering — reads this rather than `selectedPwads`, so neither an
   * unticked row nor one the game WAD can't take can leak into a loaded game. That guard is what
   * lets a mismatched pick keep its row instead of being pruned out of the list.
   */
  private activePwads(): WadSource[] {
    return wadlib.pwadsFor(
      this.selectedIwad,
      this.selectedPwads.filter((p) => !this.disabledPwads.has(p.key)),
    );
  }

  /**
   * Ticks or unticks one add-on. It keeps its place in the list either way — see `disabledPwads`.
   */
  private setPwadEnabled(source: WadSource, enabled: boolean): void {
    if (enabled) this.disabledPwads.delete(source.key);
    else this.disabledPwads.add(source.key);
    this.render();
    this.saveSelection();
  }

  /**
   * Drops an add-on from the picks. The file itself stays on offer in the WAD Library, which is
   * where it was chosen from — this only undoes the pick.
   */
  private removeButton(source: WadSource): HTMLButtonElement {
    return rowButton('forget', '×', `Remove ${source.label}`, () => this.removePwad(source));
  }

  private renderLevels(): void {
    const previous = this.levelSelect.value;
    this.levelSelect.replaceChildren();

    if (!this.selectedIwad) {
      this.levelSelect.disabled = true;
      this.refreshButtons();
      return;
    }

    const maps = this.mapsFor(this.selectedIwad, this.activePwads());
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
      writeStorage(SKILL_STORAGE_KEY, Number(this.skillSelect.value));
    });
  }

  /**
   * Reads back the last skill picked; falls back to vanilla's own default when unset or invalid.
   */
  private storedSkill(): Skill {
    const stored = readStorage(SKILL_STORAGE_KEY, DEFAULT_SKILL);
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
   * Remembers the WAD set and level for the next visit. Called from the places the *player* changes
   * something, never from `render`: `init` renders while restoring, and would write back a level
   * select that hasn't caught up with the stored map yet.
   *
   * Uploads are never stored — their bytes are gone after a reload, so a stored key would restore a
   * selection that can never load. That also keeps a missing manifest (every source gone,
   * `selectedIwad` null) from wiping a good stored value. docs/menu.md § Persisted settings.
   */
  private saveSelection(): void {
    if (!this.selectedIwad || this.selectedIwad.origin === 'upload') return;
    const stored: StoredSelection = {
      iwad: this.selectedIwad.key,
      pwads: this.selectedPwads.filter((p) => p.origin !== 'upload').map((p) => p.key),
      disabled: [...this.disabledPwads],
      map: this.levelSelect.value,
    };
    writeStorage(SELECTION_STORAGE_KEY, stored);
  }

  /**
   * The stored selection, or null where nothing is stored or what is stored names no IWAD. The keys
   * themselves aren't validated here — `init` resolves each against the current library and drops
   * whatever no longer exists.
   */
  private loadSelection(): StoredSelection | null {
    const parsed = readStorageObject(SELECTION_STORAGE_KEY) as Partial<StoredSelection> | null;
    if (typeof parsed?.iwad !== 'string') return null;
    return {
      iwad: parsed.iwad,
      pwads: Array.isArray(parsed.pwads) ? parsed.pwads.filter((p) => typeof p === 'string') : [],
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled.filter((p) => typeof p === 'string') : [],
      map: typeof parsed.map === 'string' ? parsed.map : '',
    };
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
    // The hold is only asked for in game (`confirmOnHold`'s `required`), so the tooltip is too.
    this.startButton.title = this.inGame ? 'Hold to abandon the game you are running' : '';
    // Only ever disabled for the duration of a start (see `startWithSkill`);
    // whether it's *shown* is `open`'s call.
    this.resumeButton.disabled = false;
  }

  /**
   * The WAD Library's "single WADs" button: loose files, wherever they sit, rather than a folder.
   */
  private pickFiles(): void {
    this.fileInput.value = '';
    this.fileInput.click();
  }

  private async onFilesChosen(): Promise<void> {
    const files = [...(this.fileInput.files ?? [])];
    // Reported rather than dropped, for the reason every folder-pick path is (docs/menu.md §
    // WAD Library): a picker that answers nothing at all is indistinguishable from a broken button.
    if (files.length === 0) {
      this.setStatus('No files chosen.');
      return;
    }
    await this.addFiles(files);
  }

  /**
   * Adds files from disk — the multi-file picker and the menu's drop target. A file that declares
   * itself an IWAD is adopted as the game WAD; everything else joins the add-ons. Drawn once at the
   * end rather than per file, which is why this routes through `takeAsIwad`/`takeAsPwad` instead of
   * the single-pick handlers.
   *
   * **Where the picks land depends on what is on top.** With the WAD Library up they are ticked
   * into its draft instead, which applies on Apply — the same routing `setStatus` does, and for the
   * same reason: the overlay covers `#menu`, so a selection made behind it is one the player never
   * saw happen and `Close` would not undo (docs/menu.md § WAD Library).
   */
  private async addFiles(files: File[]): Promise<void> {
    const added: WadSource[] = [];
    // Kept rather than reported as they happen: the "Added …" line below would overwrite each one,
    // leaving a part-failed multi-file pick claiming nothing but success.
    const failed: string[] = [];
    const staged = this.library.isOpen;
    // An upload sits in no folder, so a WAD's text file can only reach it in the same batch — a
    // `.txt` picked or dropped beside it. One that names no WAD here is simply not a WAD and is
    // dropped, rather than being reported as one that failed to parse.
    const texts = wadlib.textFileIndex(files, (f) => f.name);
    for (const file of files) {
      if (wadlib.isTextFile(file.name)) continue;
      try {
        const sibling = texts.get(wadlib.siblingTextFile(file.name, texts.keys()) ?? '');
        const source = await wadlib.uploadedSource(file.name, await file.arrayBuffer(), sibling);
        const existing = this.sources.findIndex((s) => s.key === source.key);
        if (existing >= 0) this.sources.splice(existing, 1, source);
        else this.sources.unshift(source);

        if (!staged) {
          if (source.type === 'IWAD') this.takeAsIwad(source);
          else this.takeAsPwad(source);
        }
        added.push(source);
      } catch (err) {
        failed.push(`${file.name}: ${(err as Error).message}`);
      }
    }

    if (added.length === 0) {
      const nothing =
        texts.size > 0 ? 'Only text files there — a .txt is read beside its WAD, never on its own.' : 'Nothing to add.';
      this.setStatus(failed.join('; ') || nothing, true);
      return;
    }
    if (staged) this.library.stage(added);

    this.render();
    // The file just added may be the one a save was waiting for, so the save
    // rows are re-resolved here too: bringing a WAD back must clear its
    // "Missing …" warning right away, not on the menu's next open.
    this.mapCache.clear();
    this.savegames.refresh();
    this.saveSelection();
    const skipped = failed.length > 0 ? ` — skipped ${failed.join('; ')}` : '';
    this.setStatus(`Added ${added.map((s) => `${s.label} (${s.type})`).join(', ')}${skipped}`, failed.length > 0);
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
      // A dropped download lands beside the WADs: a replay by its own suffix, any other `.json`
      // is a save, everything else keeps going to the WAD path.
      const replays = files.filter((f) => isReplayFileName(f.name));
      const saves = files.filter((f) => !replays.includes(f) && f.name.toLowerCase().endsWith('.json'));
      const wads = files.filter((f) => !saves.includes(f) && !replays.includes(f));
      if (replays.length > 0) void this.replays.importFiles(replays);
      if (saves.length > 0) void this.savegames.importFiles(saves);
      if (wads.length > 0) void this.addFiles(wads);
    });
  }

  private startWithSkill(skill: Skill): Promise<void> {
    if (!this.selectedIwad || !this.isReady) return Promise.resolve();
    // Reached synchronously, before the first `await`, while the click's transient activation is
    // still live: a browser refuses a file-permission prompt raised any later, and the set may
    // include a library file whose folder needs re-granting. The same trick `main.ts` uses for
    // `audio.resume()` — docs/menu.md § Session lifecycle.
    const access = this.needsLibraryAccess() ? wadlib.ensureLibraryAccess() : Promise.resolve(true);
    this.startButton.disabled = true;
    // The level being replaced is disposed part-way through this, so there is
    // nothing to return to until it either resolves or fails.
    this.resumeButton.disabled = true;
    const iwad = this.selectedIwad;
    const pwads = this.activePwads();
    const map = this.levelSelect.value;
    const record = this.recordArmed;
    return access
      .then((granted) => {
        if (!granted) {
          throw new Error('Permission to read your WAD folder was refused — reopen the WAD Library.');
        }
        return this.onStart({ iwad, pwads, map, skill, record });
      })
      .catch((err: Error) => this.setStatus(err.message, true))
      .finally(() => this.refreshButtons());
  }

  /** Whether anything in the current selection lives in the player's own folder. */
  private needsLibraryAccess(): boolean {
    return this.selectedIwad?.origin === 'library' || this.activePwads().some((p) => p.origin === 'library');
  }
}
