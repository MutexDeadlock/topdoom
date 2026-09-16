/**
 * The entry point: boots the page — the viewport, the audio engine, the loading screen, the
 * {@link Session} and the page's own keys — and hands the screen to the menu or to a `?map=` deep
 * link. See docs/session.md § Boot.
 */
import { Viewport } from './render/viewport.ts';
import { AudioEngine } from './audio/audio.ts';
import { LoadingScreen } from './ui/loading.ts';
import type { MenuTab } from './ui/menu/menu.ts';
import { Session } from './session/session.ts';
import { loadBestTimes } from './game/besttimes.ts';
import { MAX_PLAYERS } from './game/playerstarts.ts';
import type { Pos2 } from './types.ts';

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
  /**
   * `?coop=N`: 2 to {@link MAX_PLAYERS} players in one browser — docs/menu.md § URL parameters.
   */
  const coop = parsePlayerCount(params.get('coop'));
  /**
   * `?deathmatch=N`: the same, as a deathmatch; wins over `?coop=`.
   * docs/multiplayer-deathmatch.md § Testing locally.
   */
  const deathmatch = parsePlayerCount(params.get('deathmatch'));
  /**
   * One `AudioContext` for the whole page, started by the first {@link AudioEngine.resume} (a user
   * gesture).
   */
  const audio = new AudioEngine();
  /** The boot screen, reused by every level load — docs/session.md § The loading screen. */
  const loading = new LoadingScreen();
  const session = new Session({
    view,
    audio,
    loading,
    startPos: parsePos(params.get('pos')),
    players: deathmatch ?? coop,
    deathmatch: deathmatch !== null,
  });
  const { menu } = session;

  // A `?map=` deep link gets no click to start audio in, so the first gesture does it.
  const unlockAudio = () => audio.resume();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  // A reload during a run of the player's own is confirmed — docs/session.md § Session lifecycle.
  window.addEventListener('beforeunload', (e) => {
    if (session.menuSession() !== 'game' || menu.isOpen) return;
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
      session.pauseGame();
      session.openMenu();
      return;
    }
    session.resumeGame();
  });

  // Tab holds the scoreboard up over a level rather than walking the page's focus; with the menu
  // open it walks the focus as ever (docs/hud.md § Scoreboard).
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab' && session.menuSession() !== 'none' && !menu.isOpen) {
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
    if (!menu.showTab(tab, session.menuSession())) return;
    e.preventDefault();
    if (!wasOpen) session.pauseGame();
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

/** `?coop=N` or `?deathmatch=N`: 2 to {@link MAX_PLAYERS} players, null for anything else. */
function parsePlayerCount(raw: string | null): number | null {
  const count = Number(raw);
  return Number.isInteger(count) && count >= 2 && count <= MAX_PLAYERS ? count : null;
}

/**
 * `#fatal-error` sits above `#loading` on the stacking ladder, so it covers the boot screen rather
 * than having to take it down. Why `new Viewport` is the one call wrapped, and why the GPU-specific
 * message is conditional: docs/session.md § Boot.
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
