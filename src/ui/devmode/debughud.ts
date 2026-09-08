/**
 * The top-left status text, the fps counter behind it, and the camera framing
 * keys — the text collapsing to "`N` fps" without the debug-info setting. Both
 * whether it shows and how much it says are the player's own settings, each
 * defaulting to `DEVMODE`.
 * See docs/devmode.md § Dev mode and § FPS counter.
 */
import type { TicInput } from '../../game/input.ts';
import type { TopDownCamera } from '../../render/camera.ts';
import { getCameraMode } from '../../game/autocamera.ts';
import { DEVMODE } from '../../constants.ts';
import { readStorage, writeStorage } from '../../util/storage.ts';

/**
 * The camera framing keys. Zoom and tilt are player-facing controls
 * (`TopDownCamera.applyFramingKeys`) and are not gated on `DEVMODE`: the camera
 * distance/tilt they set are framing preferences, not debug state. They act in
 * manual camera mode only and are inert while the auto camera drives the
 * framing — docs/camera.md § Auto camera.
 */
export function handleHotkeys(input: TicInput, camera: TopDownCamera): void {
  if (getCameraMode() === 'manual') camera.applyFramingKeys(input);
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
  applyHudVisible();
}

const DEBUG_INFO_STORAGE_KEY = 'debuginfo';

/** `getDebugInfo`'s memo of the stored setting; null until first read. */
let debugInfo: boolean | null = null;

/**
 * Whether the status text says more than the frame rate — the map, the
 * position, the sector, the camera, the awake monsters and the sound channels
 * (`Game.debugLines`). Defaults to `DEVMODE` like the two overlays' own
 * settings, and a stored choice overrides that either way.
 * See docs/devmode.md § FPS counter.
 */
export function getDebugInfo(): boolean {
  // Memoized for the same reason `getFpsVisible` is: `DebugHud.update` asks every frame.
  if (debugInfo === null) debugInfo = readStorage(DEBUG_INFO_STORAGE_KEY, DEVMODE);
  return debugInfo;
}

export function setDebugInfo(on: boolean): void {
  debugInfo = on;
  writeStorage(DEBUG_INFO_STORAGE_KEY, on);
  applyHudVisible();
}

export class DebugHud {
  private el = document.getElementById('hud')!;
  private accum = 0;
  private frames = 0;
  private fps = 0;

  constructor() {
    // Seeds the class for the level starting now; the menu's checkboxes toggle it live.
    applyHudVisible();
  }

  /**
   * Counts one frame and repaints the status text. `rawDt` must be the real
   * elapsed time, never `Game.frame`'s clamped `dt` — see that clamp's own
   * comment for why a clamped delta under-reports a genuine slideshow.
   *
   * `details` is a closure rather than a prepared string list so its body —
   * which walks the BSP for the player's sector, among other things — only
   * runs when the block is actually shown. It takes a null frame rate for a
   * block whose fps counter is switched off — docs/devmode.md § FPS counter.
   */
  update(rawDt: number, details: (fps: number | null) => string[]): void {
    // Counted even while hidden, so switching the text on mid-level reads a
    // real rate rather than one built from that first half second.
    this.accum += rawDt;
    this.frames++;
    if (this.accum >= 0.5) {
      this.fps = Math.round(this.frames / this.accum);
      this.accum = 0;
      this.frames = 0;
    }
    // Both switched off in the menu: nothing on screen to write, and the
    // element's own class is the single source of that (`applyHudVisible`).
    if (!this.el.classList.contains('visible')) return;
    // Reaching the `else` means the counter is the only one on, since the class
    // above is what the two of them together decide.
    if (!getDebugInfo()) {
      this.el.textContent = `${this.fps} fps`;
      return;
    }
    this.el.textContent = details(getFpsVisible() ? this.fps : null).join('\n');
  }
}

/**
 * Puts the two settings on `#hud`'s class — what debughud.css shows the text by
 * and what `DebugHud.update` reads to skip its work, so the three can't
 * disagree. Either one alone keeps the element up: the debug block is not the
 * counter's to hide. Safe to call before any `DebugHud` exists: the element is
 * static markup.
 */
function applyHudVisible(): void {
  const wanted = getFpsVisible() || getDebugInfo();
  document.getElementById('hud')?.classList.toggle('visible', wanted);
}
