/**
 * The session: boots the page, runs the menu as launcher and pause screen, starts and tears down
 * one `Game` per level, and autosaves around the edges. See docs/menu.md § Session lifecycle.
 */
import { Wad } from './wad/wad.ts';
import { mapProvider, wadSetId } from './wad/checksum.ts';
import { loadWadFiles, type WadSource } from './wad/library.ts';
import { Menu, type Selection } from './ui/menu/menu.ts';
import {
  blockingWad,
  missingWadText,
  overwriteSave,
  readAutosave,
  wadSetRefusal,
  writeAutosave,
  writeSave,
  type CheckpointStore,
  type SaveCapture,
  type SaveGame,
} from './game/savegames.ts';
import { Game } from './game.ts';
import { Viewport } from './render/viewport.ts';
import { AudioEngine } from './audio/audio.ts';
import type { Pos2 } from './types.ts';

/** A short label naming the WAD set, for the HUD. */
function titleOf(iwad: WadSource, pwads: WadSource[]): string {
  return pwads.length === 0 ? iwad.label : `${iwad.label} + ${pwads.map((p) => p.label).join(' + ')}`;
}

/** `?pos=x,y` — drop the player there instead of at the map's own start. */
function parsePos(raw: string | null): Pos2 | null {
  if (!raw) return null;
  const [x, y] = raw.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Refuses a load the freshly assembled set can't play, naming the offending
 * file. The rule itself is `wadSetRefusal`'s (docs/savegames.md § WAD-set
 * identity); this re-hashes the bytes actually in hand to feed it, which is
 * what catches a manifest id left stale by a changed file.
 */
function verifySaveWads(wad: Wad, save: SaveGame): void {
  const refusal = wadSetRefusal(save, wadSetId(wad), mapProvider(wad, save.map));
  if (refusal) throw new Error(refusal);
}

/**
 * `new Viewport` synchronously throws when the browser can't create a WebGL2
 * context (blocklisted GPU, disabled hardware acceleration, ...) — three.js's
 * own error is a raw `Error`, not something a player can act on. Without this,
 * `boot()` throws before the menu ever opens and the page is left sitting on the
 * boot screen's `Loading …` forever, which reads as "hung" rather than "your
 * browser can't run this". The `try` necessarily wraps all of `Viewport`'s
 * construction (camera setup, input listeners), not just the renderer call,
 * so the GPU-specific message and its chrome://gpu hint are only shown when
 * the error actually looks like a WebGL context failure — anything else gets
 * a generic message so it doesn't misreport an unrelated bug as a GPU issue.
 * `#fatal-error` sits above `#loading` on the stacking ladder, so it covers the
 * boot screen rather than having to take it down.
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

async function boot(): Promise<void> {
  let view: Viewport;
  try {
    view = new Viewport(document.getElementById('app')!);
  } catch (err) {
    console.error(err);
    showFatalError(err);
    return;
  }
  const startPos = parsePos(new URLSearchParams(location.search).get('pos'));
  // Session-level, like the Viewport: one AudioContext for every level and WAD
  // set that follows (see AudioEngine). Constructing it starts nothing — the
  // context itself waits for the first `resume`, i.e. for a user gesture.
  const audio = new AudioEngine();
  let game: Game | null = null;

  /**
   * The level-entry checkpoint's two directions, handed to every `Game` — the
   * store stays this layer's business, the same split the save hooks below use
   * (docs/savegames.md § The checkpoint).
   */
  const checkpoint: CheckpointStore = { write: writeAutosave, read: readAutosave };

  /**
   * The campaign is over and nothing follows it: the finished `Game` is torn down and the menu
   * reopens as a launcher — `open(false)`, so there is no "Return to game" back into a run that
   * has ended. Called from inside the finished `Game`'s own tic, which is why `game` is nulled
   * before `dispose()`, the same order `startLevel` uses (docs/menu.md § Session lifecycle).
   */
  const endSession = (): void => {
    const finished = game;
    game = null;
    finished?.dispose();
    menu.open(false);
  };

  /**
   * The one session lifecycle, for both a fresh start and a load: assemble the
   * WAD set, tear the old level down, build the new one. With `save` given it
   * additionally verifies the set against what the save was made with and
   * threads the snapshot through `Game`'s restore path — the two are the same
   * sequence, so they stay one function rather than drifting apart.
   */
  const startLevel = async (selection: Selection, save: SaveGame | null = null): Promise<void> => {
    // Synchronously, before the first `await`: this call is still inside the
    // Start button's own click handler, which is the safest moment a browser
    // will let an AudioContext start.
    audio.resume();
    menu.setStatus('Loading …');
    try {
      const files = await loadWadFiles(selection.iwad, selection.pwads);
      const wad = new Wad(files);
      if (save) verifySaveWads(wad, save);

      // Cleared before the old level is torn down, so a constructor that throws
      // (a WAD with no maps, a mesh build failure) can't leave `game` pointing at
      // a disposed instance — the menu's "Return to game" and the Esc handler
      // both key off it being null.
      const previous = game;
      game = null;
      previous?.dispose();
      const title = titleOf(selection.iwad, selection.pwads);
      game = new Game(
        view,
        audio,
        wad,
        selection.map,
        title,
        selection.skill,
        save ? null : startPos,
        save?.state ?? null,
        checkpoint,
        endSession,
      );

      menu.setStatus('');
      menu.close();
      game.resume();
    } catch (err) {
      menu.setStatus((err as Error).message, true);
      // The previous level is gone by now, so re-sync the menu: with nothing
      // left to return to, it must stop offering it.
      menu.open(game !== null);
      console.error(err);
    }
  };

  /**
   * The load side of `startLevel`: re-resolves the save's WAD set from the
   * current library and hands over what it could supply. A *required* file the
   * library no longer offers fails here, before anything is torn down, so the
   * running level survives a load that can't happen.
   */
  const loadSave = async (save: SaveGame): Promise<void> => {
    try {
      // The same resolution the save row shows, so a row that reports no
      // problem can't fail here — and a file it does report is named in the
      // same words (docs/savegames.md § WAD-set identity). Only a *required*
      // file stops the load; the rest are a note on the row and are simply left
      // out of the set.
      const { iwad, pwads, missing } = menu.resolveSaveWads(save);
      const blocker = blockingWad(missing);
      if (blocker) throw new Error(missingWadText(blocker));
      if (!iwad) throw new Error('this save does not name a game WAD');
      await startLevel({ iwad, pwads, map: save.map, skill: save.skill }, save);
    } catch (err) {
      menu.setStatus((err as Error).message, true);
      console.error(err);
    }
  };

  const resumeGame = (): void => {
    if (!game) return;
    menu.close();
    game.resume();
  };

  /**
   * The shared body of the two save hooks: the only thing they need from the
   * session is that there *is* one, since a capture identifies its WAD set by
   * content and needs nothing else from around it. Which store call to make is
   * all that separates Save from Overwrite, so it is the one thing handed to
   * `Game.saveVia`, which owns the capture around it. `saveVia` throws its own
   * reason when the moment is unsaveable, like the store's writers do — the
   * menu turns any of them into its status line (see `SaveHooks`).
   */
  const withCapture = async (write: (capture: SaveCapture) => Promise<unknown>): Promise<void> => {
    if (!game) throw new Error('no running game to save');
    await game.saveVia(write);
  };

  const menu: Menu = new Menu((selection) => startLevel(selection), resumeGame, audio, {
    onSave: (name) => withCapture((capture) => writeSave(capture, name)),
    onOverwrite: (id) => withCapture((capture) => overwriteSave(id, capture)),
    onLoad: (save) => loadSave(save),
    // No game is the menu's own `inGame` gate, so there is nothing to say here.
    saveRefusal: () => game?.saveRefusal() ?? null,
  });

  // A `?map=` deep link starts a level without the player ever clicking
  // anything, so no gesture has unlocked audio by then — the first one that
  // arrives does it. Idempotent, and `once` keeps it off the hot path.
  const unlockAudio = () => audio.resume();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  // Esc toggles between playing and the menu; the level survives the trip.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    // An overlay inside the menu takes Esc first: dismissing one must not also close the menu
    // behind it. Asked of the menu rather than each overlay registering its own listener, which
    // would make "which one closes" depend on registration order.
    if (menu.closeTopOverlay()) return;
    if (!menu.isOpen) {
      game?.pause();
      menu.open(game !== null);
      return;
    }
    resumeGame();
  });

  const params = new URLSearchParams(location.search);
  await menu.init({
    iwad: params.get('wad'),
    pwads: (params.get('pwad') ?? '').split(',').filter(Boolean),
    map: params.get('map'),
  });

  // A deep link with ?map= skips the menu; otherwise the menu is the entry point.
  // Awaited, so the boot screen below covers the deep link's WAD load too.
  const deepLink = params.get('map');
  if (deepLink && menu.isReady) await menu.submit();
  else menu.open();

  // Whatever just took the screen replaces `#loading`, which is in the page from
  // the first paint (docs/menu.md § Session lifecycle).
  document.getElementById('loading')!.classList.add('hidden');
}

void boot();
