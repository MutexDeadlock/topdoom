/**
 * {@link Room}: the network room this browser sits in, as the page runs it — hosting and joining,
 * what the session asks of the page ({@link NetHooks}) and what the Multiplayer tab asks of the
 * session ({@link MultiplayerHooks}). The level a network game runs is the {@link RoomHost}'s to
 * start and end. docs/multiplayer-net.md § The session, § Leaving.
 */
import { Wad } from '../wad/wad.ts';
import { loadWadFiles } from '../wad/library.ts';
import { getPlayerColor } from '../wad/playercolor.ts';
import type { Menu, MenuTab, Selection } from '../ui/menu/menu.ts';
import type { MultiplayerHooks } from '../ui/menu/multiplayer.ts';
import * as savegames from '../game/savegames.ts';
import { COMPAT, GLOBAL_PLAYER_SETTINGS, captureSessionSettings } from '../game/replay.ts';
import {
  NetSession,
  WebSocketTransport,
  type NetGame,
  type NetHooks,
  type NetIdentity,
  type NetRestore,
  type NetRules,
} from '../game/net.ts';
import { dehackedSources } from '../game/dehacked.ts';
import { getDeathmatch } from '../game/rules.ts';
import { VERSION } from '../constants.ts';

/** What the room asks of the session around it — `Session` answers these. */
export interface RoomHost {
  readonly menu: Menu;
  /** Whether the level running, if any, is a network game's. */
  inNetGame(): boolean;
  /** Ends the running level, if any. */
  disposeGame(): void;
  /**
   * The network game's level: the host's set resolved like a save's, the level the game starts on
   * or the one the host's snapshot is of.
   *
   * @param restore  the host's snapshot for a joiner; null starts fresh at tic 0
   */
  startGame(net: NetSession, game: NetGame, restore: NetRestore | null): Promise<void>;
  /** Opens the menu over whatever runs, on `tab` where given. */
  openMenu(tab?: MenuTab): void;
}

export class Room {
  private readonly host: RoomHost;
  /** What the Multiplayer tab asks — handed to the menu as its `multiplayer` hooks. */
  readonly hooks: MultiplayerHooks;
  /** The network session this browser sits in, or null — docs/multiplayer-net.md § The session. */
  private session: NetSession | null = null;
  /**
   * Bumped by every level the session asks for and every return to its lobby: a level still loading
   * for a game that has ended since starts nothing (docs/multiplayer-net.md § Leaving).
   */
  private levelStarts = 0;
  /**
   * The New Game pick the hosted room was last handed, by where its files live — an unchanged one
   * is not read again, reading it being its WAD download.
   */
  private hostedPick = '';
  /** What the session needs from the page — docs/multiplayer-net.md § The session. */
  private readonly netHooks: NetHooks = {
    // The file's label alone: the advice a Load row adds after it is not what a lobby's line needs.
    setRefusal: (game) => {
      const blocker = savegames.blockingWad(this.host.menu.resolveSaveWads(game.set).missing);
      return blocker ? savegames.missingWadLabel(blocker) : null;
    },
    startGame: (game, restore) => {
      if (!this.session) return;
      this.levelStarts++;
      void this.host.startGame(this.session, game, restore);
    },
    changed: () => this.host.menu.refreshMultiplayer(),
    // Wherever the game's level still runs — a peer short of the last tic too, whose frame would
    // otherwise hold forever — it ends here (docs/multiplayer-net.md § Leaving).
    backInLobby: () => {
      this.levelStarts++;
      this.endLevel();
    },
    ended: (reason) => {
      const inGame = this.host.inNetGame();
      this.leave();
      // Back to the launcher on the tab the room was on, the reason in its status line; a level of
      // the player's own behind a lobby is left alone.
      if (inGame) this.host.openMenu('multiplayer');
      this.host.menu.setStatus(reason, 'error');
    },
  };

  constructor(host: RoomHost) {
    this.host = host;
    this.hooks = {
      session: () => this.session,
      host: async (url, name) => {
        const selection = this.host.menu.currentSelection();
        if (!selection) throw new Error('pick a game WAD and a level on the New Game tab first');
        const game = await netGameOf(selection);
        const transport = await WebSocketTransport.connect(url);
        this.leave();
        this.session = NetSession.host(transport, this.netHooks, {
          ...identity(name),
          game,
          session: hostRules(),
        });
        this.hostedPick = pickKey(selection);
      },
      announce: async () => {
        const room = this.session;
        const selection = this.host.menu.currentSelection();
        if (!room?.isHost || room.phase !== 'lobby' || !selection) return false;
        const key = pickKey(selection);
        const game = key === this.hostedPick ? room.game : await netGameOf(selection);
        if (!game) return false;
        this.hostedPick = key;
        return room.setGame(game, hostRules());
      },
      join: async (url, code, name) => {
        const transport = await WebSocketTransport.connect(url);
        this.leave();
        this.session = NetSession.join(transport, this.netHooks, { ...identity(name), code });
      },
      start: () => this.session?.start(),
      endGame: () => this.session?.endGame(),
      kick: (member) => this.session?.kick(member),
      recheckWads: () => this.session?.recheckSet(),
      // From the open menu, which drops "Return to game" where the level went with the room.
      leave: () => {
        this.leave();
        this.host.openMenu();
      },
    };
  }

  /** The network session this browser sits in, or null. */
  get net(): NetSession | null {
    return this.session;
  }

  /**
   * Which of the session's levels a start is, read before its first `await`: a game the host ended
   * meanwhile has bumped it (docs/multiplayer-net.md § Leaving).
   */
  get starts(): number {
    return this.levelStarts;
  }

  /**
   * Why a start of the player's own — New Game, Load, a replay — is refused: while a network game
   * runs, it would end that game for this player. docs/multiplayer-net.md § Leaving.
   */
  startRefusal(): string | null {
    return this.session?.gameRunning ? 'Multiplayer game running' : null;
  }

  /**
   * Leaves the room, and ends the level it runs, if one does: nobody plays a network game's level
   * on alone. The caller puts the menu right. docs/multiplayer-net.md § Leaving.
   */
  leave(): void {
    this.session?.leave();
    this.session = null;
    if (this.host.inNetGame()) this.host.disposeGame();
    this.host.menu.refreshMultiplayer();
  }

  /**
   * The room's game is over and its lobby kept: the level it runs, if one does, ends and the menu
   * opens on the Multiplayer tab, saying so. docs/multiplayer-net.md § Leaving.
   */
  endLevel(): void {
    if (!this.host.inNetGame()) return;
    this.host.disposeGame();
    this.host.openMenu('multiplayer');
    this.host.menu.setStatus('The game is over — everyone is back in the lobby.');
  }

  /**
   * The campaign's end, reached by every browser in the game: the host's `endGame` takes the room
   * back to its lobby, and a peer's level ends ahead of the host's word
   * (docs/multiplayer-net.md § Leaving).
   */
  campaignEnded(): void {
    this.session?.endGame();
    this.endLevel();
  }
}

/** This browser's player, as a lobby introduces them: the name, the menu's player settings, the build. */
function identity(name: string): NetIdentity {
  return {
    name,
    color: getPlayerColor(),
    settings: { ...GLOBAL_PLAYER_SETTINGS },
    build: VERSION,
    compat: COMPAT,
  };
}

/**
 * What a hosted room plays under: the session settings as they stand, and the mode beside them —
 * docs/multiplayer-deathmatch.md § Settings.
 */
function hostRules(): NetRules {
  return { ...captureSessionSettings(), deathmatch: getDeathmatch() };
}

/**
 * The New Game tab's selection as the room must match it: the set as a save records it
 * ({@link savegames.wadSetOf}, as `Game.captureSave` reads it), which costs the host its WAD
 * download up front and the level start nothing more.
 */
async function netGameOf(selection: Selection): Promise<NetGame> {
  const wad = new Wad(await loadWadFiles(selection.iwad, selection.pwads));
  return { set: savegames.wadSetOf(wad, selection.map, dehackedSources(wad)), skill: selection.skill };
}

/** A New Game pick by where its files live, its level and skill — what {@link Room.hooks}' `announce` compares. */
function pickKey(selection: Selection): string {
  return JSON.stringify([selection.iwad.key, selection.pwads.map((pwad) => pwad.key), selection.map, selection.skill]);
}
