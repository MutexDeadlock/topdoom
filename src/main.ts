import { Wad } from './wad/wad.ts';
import { wadSetId } from './wad/checksum.ts';
import { loadWadFiles, type WadSource } from './wad/library.ts';
import { Menu, type Selection } from './ui/menu/menu.ts';
import {
  overwriteSave,
  writeSave,
  type SaveCapture,
  type SaveGame,
  type SaveMeta,
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
 * `new Viewport` synchronously throws when the browser can't create a WebGL2
 * context (blocklisted GPU, disabled hardware acceleration, ...) — three.js's
 * own error is a raw `Error`, not something a player can act on. Without this,
 * `boot()` throws before the menu ever opens and the page is left showing only
 * the static HUD markup, which reads as "broken" rather than "your browser
 * can't run this". The `try` necessarily wraps all of `Viewport`'s
 * construction (camera setup, input listeners), not just the renderer call,
 * so the GPU-specific message and its chrome://gpu hint are only shown when
 * the error actually looks like a WebGL context failure — anything else gets
 * a generic message so it doesn't misreport an unrelated bug as a GPU issue.
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
   * The selection the running `game` was built from — what a save records as
   * its `sourceKeys`, so a load can re-resolve the same files from the
   * library. Only ever set beside a successful `Game` construction.
   */
  let currentSelection: Selection | null = null;

  const startLevel = async (selection: Selection): Promise<void> => {
    // Synchronously, before the first `await`: this call is still inside the
    // Start button's own click handler, which is the safest moment a browser
    // will let an AudioContext start.
    audio.resume();
    menu.setStatus('Loading …');
    try {
      const files = await loadWadFiles(selection.iwad, selection.pwads);
      const wad = new Wad(files);

      // Cleared before the old level is torn down, so a constructor that throws
      // (a WAD with no maps, a mesh build failure) can't leave `game` pointing at
      // a disposed instance — the menu's "Return to game" and the Esc handler
      // both key off it being null.
      const previous = game;
      game = null;
      previous?.dispose();
      game = new Game(view, audio, wad, selection.map, titleOf(selection.iwad, selection.pwads), selection.skill, startPos);
      currentSelection = selection;

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
   * The load-side `startLevel`: re-resolves the save's WAD set from the
   * library, verifies every file's content id against what the save was made
   * with (docs/savegames.md § WAD-set identity), then rebuilds the level with
   * the snapshot threaded through `Game`'s restore path.
   */
  const loadSave = async (save: SaveGame): Promise<void> => {
    audio.resume();
    menu.setStatus('Loading …');
    try {
      const resolve = (key: string, role: string): WadSource => {
        const found = menu.findSource(key);
        if (!found) throw new Error(`${key || role} is not available — load it from disk first`);
        return found;
      };
      const iwad = resolve(save.sourceKeys.iwad, save.wads[0]?.name ?? 'the game WAD');
      const pwads = save.sourceKeys.pwads.map((key) => resolve(key, 'an add-on'));

      const files = await loadWadFiles(iwad, pwads);
      const wad = new Wad(files);
      const actual = wadSetId(wad);
      if (actual.length !== save.wads.length) {
        throw new Error('the loaded WAD set has a different file count than the one this save was made with');
      }
      for (let i = 0; i < actual.length; i++) {
        if (actual[i].id !== save.wads[i].id) {
          throw new Error(`${actual[i].name} differs from the file this save was made with`);
        }
      }

      // Same dispose discipline as startLevel: cleared before teardown so a
      // throwing constructor can't leave `game` pointing at a disposed level.
      const previous = game;
      game = null;
      previous?.dispose();
      game = new Game(view, audio, wad, save.map, titleOf(iwad, pwads), save.skill, null, save.state);
      currentSelection = { iwad, pwads, map: save.map, skill: save.skill };

      menu.setStatus('');
      menu.close();
      game.resume();
    } catch (err) {
      menu.setStatus((err as Error).message, true);
      menu.open(game !== null);
      console.error(err);
    }
  };

  const resumeGame = (): void => {
    if (!game) return;
    menu.close();
    game.resume();
  };

  /**
   * The shared body of the two save hooks: refuse when there is no game or the
   * moment can't be captured, otherwise hand the capture and the running
   * selection's source keys to `write`. Returns a user-readable error for the
   * menu's status line, or null on success.
   */
  const withCapture = (
    write: (capture: SaveCapture, sourceKeys: SaveMeta['sourceKeys']) => void,
  ): string | null => {
    if (!game || !currentSelection) return 'no running game to save';
    try {
      const capture = game.captureSave();
      if (!capture) return 'this moment cannot be saved — dead, exiting or between levels';
      write(capture, {
        iwad: currentSelection.iwad.key,
        pwads: currentSelection.pwads.map((p) => p.key),
      });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  const menu: Menu = new Menu((selection) => startLevel(selection), resumeGame, audio, {
    onSave: (name) => withCapture((capture, keys) => void writeSave(capture, name, keys)),
    onOverwrite: (id) => withCapture((capture, keys) => void overwriteSave(id, capture, keys)),
    onLoad: (save) => loadSave(save),
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
    // The changelog popup takes Esc first: dismissing it must not also close the menu behind it.
    if (menu.closeChangelog()) return;
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
  const deepLink = params.get('map');
  if (deepLink && menu.isReady) menu.submit();
  else menu.open();
}

void boot();
