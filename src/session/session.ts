/**
 * {@link Session}: what outlives a level — the menu as launcher and pause screen, the one running
 * {@link Game}, the network {@link Room} — and the one lifecycle every start goes through: New
 * Game, a load, a replay, a network game. `main.ts` boots one for the page.
 * docs/session.md § Session lifecycle.
 */
import { Wad } from '../wad/wad.ts';
import { loadWadFiles, type WadSource } from '../wad/library.ts';
import { stockGldefs } from '../wad/gldefs.ts';
import { shippedWad } from '../wad/shipped.ts';
import { Menu, type MenuSession, type MenuTab, type Selection } from '../ui/menu/menu.ts';
import { formatClock } from '../ui/hud/hud.ts';
import type { LoadingScreen } from '../ui/loading.ts';
import type { Viewport } from '../render/viewport.ts';
import type { AudioEngine } from '../audio/audio.ts';
import * as savegames from '../game/savegames.ts';
import { replayMap, replayWadSet, writeReplay, type Replay } from '../game/replay.ts';
import type { NetGame, NetRestore, NetSession } from '../game/net.ts';
import { Game } from '../game.ts';
import { Room } from './room.ts';
import type { Pos2 } from '../types.ts';

/** What a session starts its fresh levels with — the page's URL parameters, parsed by `main.ts`. */
export interface SessionOptions {
  view: Viewport;
  audio: AudioEngine;
  /** The boot screen, reused by every level load — docs/session.md § The loading screen. */
  loading: LoadingScreen;
  /** `?pos=x,y` — where a fresh start drops the player (docs/menu.md § URL parameters). */
  startPos: Pos2 | null;
  /** `?coop=N` or `?deathmatch=N` — how many players a fresh start runs, null for one. */
  players: number | null;
  /** `?deathmatch=N` — whether that netgame is a deathmatch. */
  deathmatch: boolean;
}

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

export class Session {
  /** The launcher and pause screen — docs/menu.md. */
  readonly menu: Menu;
  private readonly view: Viewport;
  private readonly audio: AudioEngine;
  private readonly loading: LoadingScreen;
  private readonly startPos: Pos2 | null;
  private readonly players: number | null;
  private readonly deathmatch: boolean;
  /** The running level, or null. A {@link Game} is per-WAD-set/per-level, thrown away and replaced. */
  private game: Game | null = null;
  private readonly room: Room;

  constructor(options: SessionOptions) {
    const { view, audio, loading, startPos, players, deathmatch } = options;
    this.view = view;
    this.audio = audio;
    this.loading = loading;
    this.startPos = startPos;
    this.players = players;
    this.deathmatch = deathmatch;
    // Before the menu, whose Multiplayer tab the room answers; it reads `menu` only once asked.
    this.room = new Room(this);
    this.menu = new Menu(audio, {
      onStart: (selection) => this.startLevel(selection),
      onResume: () => this.resumeGame(),
      startRefusal: () => this.room.startRefusal(),
      saves: {
        onSave: (name) => this.withCapture((capture) => savegames.writeSave(capture, name)),
        onOverwrite: (id) => this.withCapture((capture) => savegames.overwriteSave(id, capture)),
        onLoad: (save) => this.loadSave(save),
        // No game is the menu's own `session` gate, so there is nothing to say here.
        saveRefusal: () => this.game?.saveRefusal() ?? null,
      },
      replays: {
        onPlay: (replay) => this.playReplay(replay),
        onStartRecording: () => {
          if (!this.game) throw new Error('no running game to record');
          this.game.startRecording();
        },
        onStopRecording: async () => {
          const capture = this.game?.finishRecording();
          if (!capture) throw new Error('nothing is being recorded');
          await writeReplay(capture, '');
        },
        // The same end, with the capture dropped on the floor: nothing is stored now, and
        // {@link Session.storeRecording} finds no recording later either.
        onCancelRecording: () => {
          if (!this.game?.finishRecording()) throw new Error('nothing is being recorded');
        },
        recordingRefusal: () => this.game?.recordingRefusal() ?? null,
        isRecording: () => this.game?.recording ?? false,
      },
      multiplayer: this.room.hooks,
    });
  }

  /**
   * What the menu is opened over: nothing, a run of the player's own, or a replay. The difference
   * between the last two is what a start, a load or a Play would cost — docs/menu.md § One screen,
   * two jobs.
   */
  menuSession(): MenuSession {
    return this.game === null ? 'none' : this.game.watchingReplay ? 'replay' : 'game';
  }

  /** Freezes the level behind the menu — {@link Game.pause}. Nothing without a level. */
  pauseGame(): void {
    this.game?.pause();
  }

  /** "Return to game": closes the menu onto the level paused behind it. */
  resumeGame(): void {
    if (!this.game) return;
    this.menu.close();
    this.game.resume();
  }

  /** Opens the menu over whatever runs, on `tab` where given. */
  openMenu(tab?: MenuTab): void {
    this.menu.open(this.menuSession(), tab);
  }

  /** Whether the level running, if any, is a network game's — {@link Game.networked}. */
  inNetGame(): boolean {
    return this.game?.networked ?? false;
  }

  /**
   * Ends the running level, if any: `game` is nulled before the dispose, and whatever it was still
   * recording is stored first — docs/session.md § Session lifecycle.
   */
  disposeGame(): void {
    const finished = this.game;
    this.game = null;
    if (!finished) return;
    this.storeRecording(finished);
    finished.dispose();
  }

  /**
   * A network game's level, as the session asks for it: the host's set resolved like a save's,
   * the level the game starts on or the one the host's snapshot is of.
   * docs/multiplayer-net.md § The session.
   */
  startGame(net: NetSession, game: NetGame, restore: NetRestore | null): Promise<void> {
    return this.startFromSet(game.set, 'game', (iwad, pwads) =>
      this.startLevel({ iwad, pwads, map: restore?.map ?? game.set.map, skill: game.skill }, { net, restore }),
    );
  }

  /**
   * The one session lifecycle for every start — New Game, a load, a replay, a network game:
   * assemble the WAD set, tear the old level down, build the new one.
   * docs/session.md § Session lifecycle.
   */
  private async startLevel(selection: Selection, from: LevelSource = {}): Promise<void> {
    const { save = null, replay = null, net: netGame = null, restore: netRestore = null } = from;
    const { room, menu, loading, audio } = this;
    // Which of the session's levels this is, read before the first `await`: the `startGame` hook
    // has just bumped it.
    const netStart = room.starts;
    // The menu greys every start of the player's own while a network game runs; this is the gate.
    const refused = netGame ? null : room.startRefusal();
    if (refused) throw new Error(refused);
    // A start of the player's own leaves a lobby behind; the session's own starts are the one
    // exception (docs/multiplayer-net.md § Leaving).
    if (room.net && netGame !== room.net) {
      room.leave();
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

      // A session that ended while its level loaded has no level to start (docs/multiplayer-net.md
      // § Leaving); the level running meanwhile, if any, stays.
      if (netGame && netGame !== room.net) throw new Error(netGame.endReason ?? 'you left the room');
      // Nor has a game the host ended meanwhile: its room is back in the lobby the menu shows.
      if (netGame && netStart !== room.starts) {
        loading.hide();
        return;
      }
      this.disposeGame();
      // `?pos=`, `?coop=` and `?deathmatch=` are for a fresh start only: a load, a replay and a
      // network game carry their own position and players.
      const freshStart = !save && !replay && !netGame;
      this.game = new Game(this.view, audio, wad, {
        startMap: selection.map,
        title: [selection.iwad, ...selection.pwads].map((source) => source.label).join(' + '),
        skill: selection.skill,
        startPos: freshStart ? this.startPos : null,
        players: freshStart ? this.players : null,
        deathmatch: freshStart && this.deathmatch,
        // A replay starts from its own first snapshot — docs/replays.md § Playback — and a joiner
        // from the host's (docs/multiplayer-net.md § Joining a game).
        restore: replay ? replay.data.snapshots[0] : (save?.state ?? netRestore?.state ?? null),
        playback: replay,
        net: netGame,
        autoSave: () => this.withCapture((capture) => savegames.writeSave(capture, takeOverSaveName(replay, capture))),
        onCampaignEnd: () => this.campaignEnded(),
        gldefsText,
        playerSkins,
        loading,
      });

      // Recording begins on the level as loaded, before the first tic.
      // docs/replays.md § Recording.
      if (selection.record) this.game.startRecording();
      menu.close();
      loading.hide();
      this.game.resume();
    } catch (err) {
      loading.hide();
      // The level's music starts before its map is built; a build that threw leaves it playing
      // with no `Game` to dispose it (docs/music.md § Which track a level plays).
      audio.music.stop();
      menu.setStatus((err as Error).message, 'error');
      // The previous level is gone by now, so re-sync the menu: with nothing
      // left to return to, it must stop offering it.
      this.openMenu();
      console.error(err);
    }
  }

  /**
   * The stored-set side of {@link Session.startLevel}, for a save, a replay and a network game
   * alike: re-resolves the set from the current library and hands `start` what it could supply. A
   * *required* file the library no longer offers fails here, before anything is torn down.
   */
  private async startFromSet(
    set: savegames.SaveWadSet,
    noun: 'save' | 'replay' | 'game',
    start: (iwad: WadSource, pwads: WadSource[]) => Promise<void>,
  ): Promise<void> {
    try {
      // The resolution the row shows, so a row that reports no problem can't fail here
      // (docs/savegames.md § WAD-set identity).
      const { iwad, pwads, missing } = this.menu.resolveSaveWads(set);
      const blocker = savegames.blockingWadText(missing);
      if (blocker) throw new Error(blocker);
      if (!iwad) throw new Error(`this ${noun} does not name a game WAD`);
      await start(iwad, pwads);
    } catch (err) {
      this.menu.setStatus((err as Error).message, 'error');
      console.error(err);
    }
  }

  private loadSave(save: savegames.SaveGame): Promise<void> {
    return this.startFromSet(save, 'save', (iwad, pwads) =>
      this.startLevel({ iwad, pwads, map: save.map, skill: save.skill }, { save }),
    );
  }

  private playReplay(replay: Replay): Promise<void> {
    return this.startFromSet(replayWadSet(replay), 'replay', (iwad, pwads) =>
      this.startLevel({ iwad, pwads, map: replayMap(replay), skill: replay.skill }, { replay }),
    );
  }

  /**
   * The end card's continue key with nowhere left to go (docs/hud.md § End card): the level is
   * torn down — the call arrives from inside that very {@link Game}'s tic — and the menu reopens
   * as a launcher; a network game's room goes back to its lobby instead.
   */
  private campaignEnded(): void {
    if (this.game?.networked) {
      this.room.campaignEnded();
      return;
    }
    this.disposeGame();
    this.menu.open('none');
  }

  /**
   * Stores whatever `finished` was still recording (docs/replays.md § Recording). Fire-and-forget:
   * a refused write must not take the session change down with it.
   */
  private storeRecording(finished: Game): void {
    const capture = finished.finishRecording();
    if (!capture) return;
    void writeReplay(capture, '')
      .then((meta) => this.menu.setStatus(`Replay "${meta.name}" stored.`))
      .catch((err: unknown) => {
        console.warn('replay not stored:', err);
        this.menu.setStatus(`replay not stored: ${(err as Error).message}`, 'error');
      });
  }

  /**
   * The body Save, Overwrite and the autosave share: only the store call differs, and
   * {@link Game.saveVia} owns the capture around it — docs/menu-saves.md § Save and Load tabs.
   */
  private async withCapture(write: (capture: savegames.SaveCapture) => Promise<unknown>): Promise<void> {
    if (!this.game) throw new Error('no running game to save');
    await this.game.saveVia(write);
  }
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
