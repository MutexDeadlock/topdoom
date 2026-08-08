import type { GraphicsBank } from '../wad/graphics.ts';
import { WadFont, COLOR_YELLOW } from './wadfont.ts';

/**
 * How long one message stays up. Vanilla's `HU_MSGTIMEOUT` is 4 seconds
 * (`4*TICRATE`) for a message printed in the top-left corner you can read while
 * still playing; this one sits in the middle of the view, so it's shorter —
 * **tuned by feel**.
 */
const MESSAGE_SECONDS = 3;

/**
 * A short line of WAD-font text over the middle of the view — currently only
 * "You found a secret area". Vanilla prints its messages in the top-left in
 * `STCFN`'s own red (`hu_stuff.c`); this engine puts them center-screen in
 * `COLOR_YELLOW` instead, where a top-down player is already looking.
 * See docs/items.md § Center messages.
 *
 * Same "canvas sized to its content, CSS scales it" pattern `Hud` uses, and
 * the same one-`WadFont`-per-level-load cost — this class builds its own
 * recolored glyph set rather than sharing `Hud`'s, which keeps the two
 * independent about what color each draws in.
 */
export class CenterMessage {
  private font: WadFont;
  private canvas = document.getElementById('hud-message') as HTMLCanvasElement;
  /** Seconds of display time left; <= 0 means nothing is showing. */
  private secondsLeft = 0;

  constructor(gfx: GraphicsBank) {
    this.font = new WadFont(gfx, COLOR_YELLOW);
  }

  /** Draws `text` and restarts the timeout — a second message replaces whatever is up, it doesn't queue. */
  show(text: string): void {
    this.canvas.width = Math.max(1, this.font.measure(text));
    this.canvas.height = Math.max(1, this.font.height);
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.font.draw(ctx, 0, 0, text);
    this.secondsLeft = MESSAGE_SECONDS;
    this.canvas.classList.remove('hidden');
  }

  /** Ticks the timeout down. Not called while the game is paused, so the menu doesn't eat a message's display time. */
  update(dt: number): void {
    if (this.secondsLeft <= 0) return;
    this.secondsLeft -= dt;
    if (this.secondsLeft <= 0) this.clear();
  }

  /** Drops whatever is up. Every level (re)load goes through here, so a message can't outlive its level. */
  clear(): void {
    this.secondsLeft = 0;
    this.canvas.classList.add('hidden');
  }
}
