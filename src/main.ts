/**
 * The session: boots the page, runs the menu as launcher and pause screen, starts and tears down
 * one {@link Game} per level, and autosaves around the edges.
 * See docs/session.md § Session lifecycle.
 */
import { Wad } from './wad/wad.ts';
import { loadWadFiles, type WadSource } from './wad/library.ts';
import { Menu, type MenuSession, type MenuTab, type Selection } from './ui/menu/menu.ts';
import * as savegames from './game/savegames.ts';
import {
  COMPAT,
  GLOBAL_PLAYER_SETTINGS,
  captureSessionSettings,
  replayMap,
  replayWadSet,
  writeReplay,
  type Replay,
} from './game/replay.ts';
import {
  NetSession,
  WebSocketTransport,
  type NetGame,
  type NetHooks,
  type NetIdentity,
  type NetRestore,
} from './game/net.ts';
import { dehackedSources } from './game/dehacked.ts';
import { formatClock } from './ui/hud/hud.ts';
import { Game } from './game.ts';
import { loadBestTimes } from './game/besttimes.ts';
import { stockGldefs } from './wad/gldefs.ts';
import { shippedWad } from './wad/shipped.ts';
import { getPlayerColor } from './wad/playercolor.ts';
import { LoadingScreen } from './ui/loading.ts';
import { Viewport } from './render/viewport.ts';
import { AudioEngine } from './audio/audio.ts';
import type { Pos2 } from './types.ts';
import { MAX_PLAYERS } from './game/playerstarts.ts';
import { VERSION } from './constants.ts';

/** What a level start begins from beside the selection — at most one of the three. */
interface LevelSource {
  save?: savegames.SaveGame;
  /** A replay to watch — docs/replays.md § Playback. */
  replay?: Replay;
  /**
   * A network game's level, from its start or ({@link LevelSource.restore}) the host's snapshot —
   * docs/multiplayer-net.md.
   */
  net?: NetSession;
  restore?: NetRestore | null;
}

async function boot(): Promise<void> {
  let view: Viewport;
  try {
    view = new Viewport(document.getElementById('app')!);
  } catch (err) {
    console.error(err);
    showFatalError(err);
    return;
  }

  const params = new URLSearchParams(location.search);
  const startPos = parsePos(params.get('pos'));
  /**
   * `?coop=N`: 2 to {@link MAX_PLAYERS} players in one browser — docs/menu.md § URL parameters.
   */
  const coopParam = Number(params.get('coop'));
  const coop = Number.isInteger(coopParam) && coopParam >= 2 && coopParam <= MAX_PLAYERS ? coopParam : null;
  /**
   * One `AudioContext` for the whole page, started by the first {@link AudioEngine.resume} (a user
   * gesture).
   */
  const audio = new AudioEngine();
  /** The boot screen, reused by every level load — docs/session.md § The loading screen. */
  const loading = new LoadingScreen();
  let game: Game | null = null;
  /** The network session this browser sits in, or null — docs/multiplayer-net.md § The session. */
  let net: NetSession | null = null;

  /**
   * What the menu is opened over: nothing, a run of the player's own, or a replay. The difference
   * between the last two is what a start, a load or a Play would cost — docs/menu.md § One screen,
   * two jobs.
   */
  const session = (): MenuSession => (game === null ? 'none' : game.watchingReplay ? 'replay' : 'game');

  /**
   * The one session lifecycle for every start — New Game, a load, a replay, a network game:
   * assemble the WAD set, tear the old level down, build the new one.
   * docs/session.md § Session lifecycle.
   */
  const startLevel = async (selection: Selection, from: LevelSource = {}): Promise<void> => {
    const { save = null, replay = null, net: netGame = null, restore: netRestore = null } = from;
    // A start of the player's own leaves a network game behind; the session's own starts are the
    // one exception (docs/multiplayer-net.md § Leaving).
    if (net && netGame !== net) {
      leaveNet();
    }
    // Before the first `await`, still inside the click — docs/session.md § Session lifecycle.
    audio.resume();
    // Over the menu rather than in its status line: a 28 MB IWAD is tens of seconds, and the menu
    // behind it is one the player can no longer use.
    loading.show(`Loading ${selection.map}`);
    menu.setStatus('');
    try {
      const [files, gldefsText, playerSkins] = await Promise.all([
        loadWadFiles(selection.iwad, selection.pwads, (got, total) => loading.progress(got, total)),
        stockGldefs(),
        // The shipped WAD itself: its sprite block is the player art, and `stockGldefs` above
        // resolves from the same one fetch (docs/wad.md § The WAD the engine ships).
        shippedWad(),
      ]);
      const wad = new Wad(files);
      const set = save ?? (replay ? replayWadSet(replay) : (netGame?.game?.set ?? null));
      if (set) verifySaveWads(wad, set);
      // Awaited: on a big map this line is what the player reads for as long as the build takes,
      // and `painted` is what gets it there first.
      loading.detail(`Building ${selection.map} …`);
      await loading.painted();

      disposeGame();
      // `?pos=` and `?coop=` are for a fresh start only: a load, a replay and a network game carry
      // their own position and players.
      const freshStart = !save && !replay && !netGame;
      game = new Game(view, audio, wad, {
        startMap: selection.map,
        title: [selection.iwad, ...selection.pwads].map((source) => source.label).join(' + '),
        skill: selection.skill,
        startPos: freshStart ? startPos : null,
        coop: freshStart ? coop : null,
        // A replay starts from its own first snapshot — docs/replays.md § Playback — and a joiner
        // from the host's (docs/multiplayer-net.md § Joining a game).
        restore: replay ? replay.data.snapshots[0] : (save?.state ?? netRestore?.state ?? null),
        playback: replay,
        net: netGame,
        autoSave: () => withCapture((capture) => savegames.writeSave(capture, takeOverSaveName(replay, capture))),
        checkpoint: { write: savegames.writeAutosave, read: savegames.readAutosave },
        onCampaignEnd: () => {
          disposeGame();
          // Every browser in the game reaches this tic together; the host takes the room back to
          // its lobby (docs/multiplayer-net.md § Leaving).
          net?.endGame();
          menu.open('none');
        },
        gldefsText,
        playerSkins,
        loading,
      });

      // Recording begins on the level as loaded, before the first tic.
      // docs/replays.md § Recording.
      if (selection.record) game.startRecording();
      menu.close();
      loading.hide();
      game.resume();
    } catch (err) {
      loading.hide();
      // The level's music starts before its map is built; a build that threw leaves it playing
      // with no `Game` to dispose it (docs/music.md § Which track a level plays).
      audio.music.stop();
      menu.setStatus((err as Error).message, true);
      // The previous level is gone by now, so re-sync the menu: with nothing
      // left to return to, it must stop offering it.
      menu.open(session());
      console.error(err);
    }
  };

  /**
   * The stored-set side of `startLevel`, for a save, a replay and a network game alike:
   * re-resolves the set from the current library and hands `start` what it could supply. A
   * *required* file the library no longer offers fails here, before anything is torn down.
   */
  const startFromSet = async (
    set: savegames.SaveWadSet,
    noun: 'save' | 'replay' | 'game',
    start: (iwad: WadSource, pwads: WadSource[]) => Promise<void>,
  ): Promise<void> => {
    try {
      // The resolution the row shows, so a row that reports no problem can't fail here
      // (docs/savegames.md § WAD-set identity).
      const { iwad, pwads, missing } = menu.resolveSaveWads(set);
      const blocker = savegames.blockingWadText(missing);
      if (blocker) throw new Error(blocker);
      if (!iwad) throw new Error(`this ${noun} does not name a game WAD`);
      await start(iwad, pwads);
    } catch (err) {
      menu.setStatus((err as Error).message, true);
      console.error(err);
    }
  };

  const loadSave = (save: savegames.SaveGame): Promise<void> =>
    startFromSet(save, 'save', (iwad, pwads) => startLevel({ iwad, pwads, map: save.map, skill: save.skill }, { save }));

  const playReplay = (replay: Replay): Promise<void> =>
    startFromSet(replayWadSet(replay), 'replay', (iwad, pwads) =>
      startLevel({ iwad, pwads, map: replayMap(replay), skill: replay.skill }, { replay }),
    );

  /**
   * A network game's level, as the session asks for it: the host's set resolved like a save's,
   * the level the game starts on or the one the host's snapshot is of.
   * docs/multiplayer-net.md § The session.
   */
  const startNetGame = (room: NetSession, netGame: NetGame, restore: NetRestore | null): Promise<void> =>
    startFromSet(netGame.set, 'game', (iwad, pwads) =>
      startLevel({ iwad, pwads, map: restore?.map ?? netGame.set.map, skill: netGame.skill }, { net: room, restore }),
    );

  /**
   * Leaves the room; a level already running plays on alone ({@link Game} sees the session end).
   */
  const leaveNet = (): void => {
    net?.leave();
    net = null;
    menu.refreshMultiplayer();
  };

  /** This browser's player, as a lobby introduces them: the name, the menu's player settings, the build. */
  const identity = (name: string): NetIdentity => ({
    name,
    color: getPlayerColor(),
    settings: { ...GLOBAL_PLAYER_SETTINGS },
    build: VERSION,
    compat: COMPAT,
  });

  /**
   * The New Game tab's selection as the room must match it: the set as a save records it
   * ({@link savegames.wadSetOf}, as {@link Game.captureSave} reads it), which costs the host its
   * WAD download up front and the level start nothing more.
   */
  const netGameOf = async (selection: Selection): Promise<NetGame> => {
    const wad = new Wad(await loadWadFiles(selection.iwad, selection.pwads));
    return { set: savegames.wadSetOf(wad, selection.map, dehackedSources(wad)), skill: selection.skill };
  };

  /**
   * The New Game pick the hosted room was last handed, by where its files live — an unchanged one
   * is not read again, reading it being its WAD download.
   */
  let hostedPick = '';
  const pickKey = (selection: Selection): string =>
    JSON.stringify([selection.iwad.key, selection.pwads.map((pwad) => pwad.key), selection.map, selection.skill]);

  /** What the session needs from the page — docs/multiplayer-net.md § The session. */
  const netHooks: NetHooks = {
    // The file's label alone: the advice a Load row adds after it is not what a lobby's line needs.
    setRefusal: (netGame) => {
      const blocker = savegames.blockingWad(menu.resolveSaveWads(netGame.set).missing);
      return blocker ? savegames.missingWadLabel(blocker) : null;
    },
    startGame: (netGame, restore) => {
      if (!net) return;
      void startNetGame(net, netGame, restore);
    },
    changed: () => menu.refreshMultiplayer(),
    ended: (reason) => {
      leaveNet();
      menu.setStatus(reason, true);
    },
  };

  /**
   * Ends the running level, if any: `game` is nulled before the dispose, and whatever it was still
   * recording is stored first — docs/session.md § Session lifecycle.
   */
  const disposeGame = (): void => {
    const finished = game;
    game = null;
    if (!finished) return;
    storeRecording(finished);
    finished.dispose();
  };

  /**
   * Stores whatever `finished` was still recording (docs/replays.md § Recording). Fire-and-forget
   * like the checkpoint: a refused write must not take the session change down with it.
   */
  const storeRecording = (finished: Game): void => {
    const capture = finished.finishRecording();
    if (!capture) return;
    void writeReplay(capture, '')
      .then((meta) => menu.setStatus(`Replay "${meta.name}" stored.`))
      .catch((err: unknown) => {
        console.warn('replay not stored:', err);
        menu.setStatus(`replay not stored: ${(err as Error).message}`, true);
      });
  };

  const resumeGame = (): void => {
    if (!game) return;
    menu.close();
    game.resume();
  };

  /**
   * The body Save, Overwrite and the autosave share: only the store call differs, and
   * {@link Game.saveVia} owns the capture around it — docs/menu-saves.md § Save and Load tabs.
   */
  const withCapture = async (write: (capture: savegames.SaveCapture) => Promise<unknown>): Promise<void> => {
    if (!game) throw new Error('no running game to save');
    await game.saveVia(write);
  };

  const menu: Menu = new Menu(audio, {
    onStart: (selection) => startLevel(selection),
    onResume: resumeGame,
    saves: {
      onSave: (name) => withCapture((capture) => savegames.writeSave(capture, name)),
      onOverwrite: (id) => withCapture((capture) => savegames.overwriteSave(id, capture)),
      onLoad: loadSave,
      // No game is the menu's own `session` gate, so there is nothing to say here.
      saveRefusal: () => game?.saveRefusal() ?? null,
    },
    replays: {
      onPlay: playReplay,
      onStartRecording: () => {
        if (!game) throw new Error('no running game to record');
        game.startRecording();
      },
      onStopRecording: async () => {
        const capture = game?.finishRecording();
        if (!capture) throw new Error('nothing is being recorded');
        await writeReplay(capture, '');
      },
      // The same end, with the capture dropped on the floor: nothing is stored now, and the
      // session's own `storeRecording` finds no recording later either.
      onCancelRecording: () => {
        if (!game?.finishRecording()) throw new Error('nothing is being recorded');
      },
      recordingRefusal: () => game?.recordingRefusal() ?? null,
      isRecording: () => game?.recording ?? false,
    },
    multiplayer: {
      session: () => net,
      host: async (url, name) => {
        const selection = menu.currentSelection();
        if (!selection) throw new Error('pick a game WAD and a level on the New Game tab first');
        const netGame = await netGameOf(selection);
        const transport = await WebSocketTransport.connect(url);
        leaveNet();
        net = NetSession.host(transport, netHooks, {
          ...identity(name),
          game: netGame,
          session: captureSessionSettings(),
        });
        hostedPick = pickKey(selection);
      },
      announce: async () => {
        const room = net;
        const selection = menu.currentSelection();
        if (!room?.isHost || room.phase !== 'lobby' || !selection) return false;
        const key = pickKey(selection);
        const netGame = key === hostedPick ? room.game : await netGameOf(selection);
        if (!netGame) return false;
        hostedPick = key;
        return room.setGame(netGame, captureSessionSettings());
      },
      join: async (url, code, name) => {
        const transport = await WebSocketTransport.connect(url);
        leaveNet();
        net = NetSession.join(transport, netHooks, { ...identity(name), code });
      },
      start: () => net?.start(),
      kick: (member) => net?.kick(member),
      recheckWads: () => net?.recheckSet(),
      leave: leaveNet,
    },
  });

  // A `?map=` deep link gets no click to start audio in, so the first gesture does it.
  const unlockAudio = () => audio.resume();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  // A reload over a run of the player's own is confirmed — docs/session.md § Session lifecycle.
  window.addEventListener('beforeunload', (e) => {
    if (session() !== 'game') return;
    e.preventDefault();
    e.returnValue = true; // what browsers before Chrome 119 read instead
  });

  // ESC toggles between playing and the menu; the level survives the trip.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    // An overlay inside the menu takes ESC first: dismissing one must not also close the menu
    // behind it. Asked of the menu rather than each overlay registering its own listener, which
    // would make "which one closes" depend on registration order.
    if (menu.closeTopOverlay()) return;
    if (!menu.isOpen) {
      game?.pause();
      menu.open(session());
      return;
    }
    resumeGame();
  });

  // Tab holds the scoreboard up over a level rather than walking the page's focus; with the menu
  // open it walks the focus as ever (docs/hud.md § Scoreboard).
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab' && game && !menu.isOpen) {
      e.preventDefault();
    }
  });

  // F2/F3/F4 open the menu straight on one tab, pausing the level on the way in like ESC
  // does (docs/menu.md § Hotkeys).
  const TAB_KEYS: Record<string, MenuTab> = { F2: 'save', F3: 'load', F4: 'settings' };
  window.addEventListener('keydown', (e) => {
    const tab = TAB_KEYS[e.code];
    if (tab === undefined) return;
    // An overlay owns the screen while it's up and ESC is what dismisses it — the same
    // precedence the handler above gives it. Nothing is swapped behind it.
    if (menu.hasOverlay) return;
    const wasOpen = menu.isOpen;
    // Refused when the tab isn't available (Save, with no level loaded): the browser's own
    // binding for the key is left alone rather than swallowed for nothing.
    if (!menu.showTab(tab, session())) return;
    e.preventDefault();
    if (!wasOpen) game?.pause();
  });

  // Alongside the menu's own library scan rather than in front of it — the two share nothing, and
  // the records aren't needed until a level *ends* (docs/hud.md § The store). Awaited here all the
  // same, since the frame that ends one compares and files synchronously.
  await Promise.all([
    loadBestTimes(),
    menu.init({
      iwad: params.get('wad'),
      pwads: (params.get('pwad') ?? '').split(',').filter(Boolean),
      map: params.get('map'),
    }),
  ]);

  // A deep link with ?map= skips the menu; otherwise the menu is the entry point.
  // Awaited, so the boot screen below covers the deep link's WAD load too.
  if (params.get('map') && menu.isReady) {
    await menu.submit();
  } else {
    menu.open();
    // Over the launcher only: a deep link never shows the menu, and a returning player has muted
    // it (docs/menu.md § Welcome popup).
    menu.showWelcome();
  }

  // Whatever took the screen replaces the boot screen — docs/session.md § Session lifecycle.
  loading.hide();
}

/** `?pos=x,y` — drop the player there instead of at the map's own start. */
function parsePos(raw: string | null): Pos2 | null {
  if (!raw) return null;
  const [x, y] = raw.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** What taking a replay over calls the savegame it writes: the replay and how far into it. */
function takeOverSaveName(replay: Replay | null, capture: savegames.SaveCapture): string {
  return replay ? `${replay.name} @ ${formatClock(capture.levelTime)}` : '';
}

/**
 * Refuses a load the freshly assembled set can't play, naming the offending file. The rule is
 * {@link savegames.wadSetRefusal}'s (docs/savegames.md § WAD-set identity), asked over the bytes
 * actually in hand, which is what catches a manifest ID left stale by a changed file.
 */
function verifySaveWads(wad: Wad, save: savegames.SaveWadSet): void {
  const refusal = savegames.loadedSetRefusal(save, wad);
  if (refusal) throw new Error(refusal);
}

/**
 * `#fatal-error` sits above `#loading` on the stacking ladder, so it covers the boot screen rather
 * than having to take it down. Why `new Viewport` is the one call wrapped, and why the GPU-specific
 * message is conditional: docs/session.md § Session lifecycle.
 */
function showFatalError(err: unknown): void {
  const overlay = document.getElementById('fatal-error')!;
  const isWebglError = err instanceof Error && /webgl/i.test(err.message);
  overlay.querySelector('.message')!.textContent = isWebglError
    ? "Your browser couldn't create a WebGL2 context, so TopDoom can't render."
    : 'TopDoom failed to start.';
  overlay.querySelector('.hint')!.classList.toggle('hidden', !isWebglError);
  overlay.querySelector('.detail')!.textContent = err instanceof Error ? err.message : String(err);
  overlay.classList.remove('hidden');
}

void boot();
