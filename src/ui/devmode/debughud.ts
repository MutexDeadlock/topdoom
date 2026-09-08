/**
 * The top-left status text, the fps counter behind it, and the debug hotkeys —
 * the text collapsing to "`N` fps" and the hotkeys to the camera framing keys
 * once DEVMODE is off. Whether the text shows at all is the player's own
 * setting. See docs/devmode.md § Dev mode and § FPS counter.
 */
import type { TicInput } from '../../game/input.ts';
import type { TopDownCamera } from '../../render/camera.ts';
import { getCameraMode } from '../../game/autocamera.ts';
import { DEVMODE } from '../../constants.ts';
import { readStorage, writeStorage } from '../../util/storage.ts';

/**
 * Camera framing, then the level switching DEVMODE gates. Zoom and tilt are
 * player-facing controls (`TopDownCamera.applyFramingKeys`), so they sit ahead
 * of that gate — the camera distance/tilt they set are framing preferences, not
 * debug state. They act in manual camera mode only and are inert while the auto
 * camera drives the framing (the same inert-not-error shape N/P have outside
 * dev mode) — docs/camera.md § Auto camera.
 */
export function handleHotkeys(
  input: TicInput,
  camera: TopDownCamera,
  /** Null while a cheat code is being typed, whose letters must not also jump level — game.ts. */
  changeMap: ((delta: number) => void) | null,
  /**
   * Whether the map-jump keys exist: this build's `DEVMODE`, or the one a replay was recorded
   * under, so its `N`/`P` presses jump on any build (docs/replays.md § What breaks determinism).
   */
  devmode = DEVMODE,
): void {
  if (getCameraMode() === 'manual') camera.applyFramingKeys(input);
  if (!devmode || !changeMap) return;
  if (input.pressed('KeyN')) changeMap(1);
  if (input.pressed('KeyP')) changeMap(-1);
}

const FPS_STORAGE_KEY = 'fps';

/** `getFpsVisible`'s memo of the stored setting; null until first read. */
let fpsVisible: boolean | null = null;

/**
 * Whether the top-left status text is wanted. Defaults to `DEVMODE`, like the
 * profiling overlay's own setting, and a stored choice overrides that either
 * way. See docs/devmode.md § FPS counter.
 */
export function getFpsVisible(): boolean {
  if (fpsVisible === null) fpsVisible = readStorage(FPS_STORAGE_KEY, DEVMODE);
  return fpsVisible;
}

export function setFpsVisible(on: boolean): void {
  fpsVisible = on;
  writeStorage(FPS_STORAGE_KEY, on);
  applyFpsVisible();
}

export class DebugHud {
  private el = document.getElementById('hud')!;
  private accum = 0;
  private frames = 0;
  private fps = 0;

  constructor() {
    // The menu's checkbox owns the setting and toggles the same class live, so
    // this only has to seed it for the level starting now.
    applyFpsVisible();
  }

  /**
   * Counts one frame and repaints the status text. `rawDt` must be the real
   * elapsed time, never `Game.frame`'s clamped `dt` — see that clamp's own
   * comment for why a clamped delta under-reports a genuine slideshow.
   *
   * `details` is a closure rather than a prepared string list so its body —
   * which walks the BSP for the player's sector, among other things — only
   * runs when the panel is actually shown.
   */
  update(rawDt: number, details: (fps: number) => string[]): void {
    // Counted even while hidden, so switching the text on mid-level reads a
    // real rate rather than one built from that first half second.
    this.accum += rawDt;
    this.frames++;
    if (this.accum >= 0.5) {
      this.fps = Math.round(this.frames / this.accum);
      this.accum = 0;
      this.frames = 0;
    }
    // Switched off in the menu: nothing on screen to write, and the element's
    // own class is the single source of that (`applyFpsVisible`).
    if (!this.el.classList.contains('visible')) return;
    this.el.textContent = DEVMODE ? details(this.fps).join('\n') : `${this.fps} fps`;
  }
}

/**
 * Puts the setting on `#hud`'s class — what debughud.css shows the text by and
 * what `DebugHud.update` reads to skip its work, so the two can't disagree.
 * Safe to call before any `DebugHud` exists: the element is static markup.
 */
function applyFpsVisible(): void {
  document.getElementById('hud')?.classList.toggle('visible', getFpsVisible());
}
