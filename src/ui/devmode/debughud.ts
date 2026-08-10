import { ProfilerHud } from './profilerhud.ts';
import type { FrameProfiler } from '../../util/profiler.ts';
import type { Input } from '../../game/input.ts';
import type { TopDownCamera } from '../../render/camera.ts';
import { DEVMODE } from '../../constants.ts';

/**
 * The top-left status text, the fps counter behind it, and the debug hotkeys —
 * all of which collapse to "`N` fps" and the camera framing keys once DEVMODE
 * is off. See docs/menu.md § Dev mode.
 */

/**
 * Camera framing, then the level switching DEVMODE gates. Zoom and tilt are
 * player-facing controls, so they sit ahead of that gate — the camera
 * distance/tilt they set are framing preferences, not debug state.
 */
export function handleHotkeys(
  input: Input,
  camera: TopDownCamera,
  changeMap: (delta: number) => void,
): void {
  if (input.held('Equal', 'NumpadAdd')) camera.distance = Math.max(200, camera.distance - 8);
  if (input.held('Minus', 'NumpadSubtract')) camera.distance = Math.min(2400, camera.distance + 8);
  if (input.held('BracketLeft')) camera.tiltDeg = Math.max(0, camera.tiltDeg - 0.5);
  if (input.held('BracketRight')) camera.tiltDeg = Math.min(70, camera.tiltDeg + 0.5);
  if (!DEVMODE) return;
  if (input.pressed('KeyN')) changeMap(1);
  if (input.pressed('KeyP')) changeMap(-1);
}

export class DebugHud {
  private el = document.getElementById('hud')!;
  private profilerHud = new ProfilerHud();
  private accum = 0;
  private frames = 0;
  private fps = 0;

  constructor() {
    // DEVMODE never changes at runtime, so the panel's visibility is set once.
    document.getElementById('profiler-hud')!.classList.toggle('visible', DEVMODE);
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
  update(rawDt: number, profiler: FrameProfiler, details: (fps: number) => string[]): void {
    this.accum += rawDt;
    this.frames++;
    if (this.accum >= 0.5) {
      this.fps = Math.round(this.frames / this.accum);
      this.accum = 0;
      this.frames = 0;
    }
    if (!DEVMODE) {
      this.el.textContent = `${this.fps} fps`;
      return;
    }
    this.el.textContent = details(this.fps).join('\n');
    this.profilerHud.update(profiler.samples(), profiler.totalMs);
  }
}
