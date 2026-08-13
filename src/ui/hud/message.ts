/**
 * Center-screen messages ("You need a blue key…"), one at a time, in the WAD's own font.
 * See docs/hud.md § Center messages.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';
import type { KeyColor } from '../../game/inventory.ts';
import { WadFont, COLOR_YELLOW, type WadFontRecolor } from './wadfont.ts';

/**
 * How long one message stays up. Vanilla's `HU_MSGTIMEOUT` is 4 seconds
 * (`4*TICRATE`) for a message printed in the top-left corner you can read while
 * still playing; this one sits in the middle of the view, so it's shorter —
 * **tuned by feel**.
 */
const MESSAGE_SECONDS = 3;

/**
 * Each key color's own text color, sampled from that key's pickup sprite the same way
 * `COLOR_YELLOW` and `ui/hud/hud.ts`'s `LEVEL_STATS_GREEN` are — `RKEYA0`'s and `YKEYA0`'s
 * brightest pixel exactly.
 *
 * Blue is the one that isn't: `BKEYA0`'s brightest pixel is the palette's pure `0,0,255`
 * (index 200), which is unreadable as text over a dark playfield at `#hud-message`'s 0.75
 * opacity. This takes the light end of the *same* palette blue ramp instead (index 196) —
 * still WAD-derived, still unmistakably the blue key's color.
 */
const KEY_TEXT_COLORS: Record<KeyColor, WadFontRecolor> = {
  blue: [115, 115, 255],
  red: [227, 0, 0],
  yellow: [215, 187, 67],
};

/** One stretch of a message: a bare string draws in `COLOR_YELLOW`, otherwise in the color given. */
export type MessageRun = string | { text: string; color: WadFontRecolor };

/**
 * The line shown when a keyed door or switch is used without the key it wants: `d_englsh.h`'s
 * `PD_*K`/`PD_*O` verbatim, down to the "open this door" (`EV_VerticalDoor`) vs. "activate this
 * object" (`EV_DoLockedDoor`) split. The only departure is the color word, drawn in that key's own
 * color instead of the message's.
 *
 * Vanilla says "key" for a skull too, and it isn't being loose: its checks accept either
 * (`p_doors.c` tests `!p->cards[it_bluecard] && !p->cards[it_blueskull]`), so which of the two the
 * map placed is not something the linedef knows — see `KeyColor`'s own doc.
 */
export function lockedKeyMessage(key: KeyColor, kind: 'door' | 'switch'): MessageRun[] {
  const what = kind === 'door' ? 'open this door' : 'activate this object';
  return ['You need a ', { text: key, color: KEY_TEXT_COLORS[key] }, ` key to ${what}`];
}

/**
 * A short line of WAD-font text over the middle of the view — the secret announcement and the
 * locked-door line. Vanilla prints its messages in the top-left in `STCFN`'s own red
 * (`hu_stuff.c`); this engine puts them center-screen in `COLOR_YELLOW` instead, where a top-down
 * player is already looking. See docs/hud.md § Center messages.
 *
 * Same "canvas sized to its content, CSS scales it" pattern `Hud` uses — this class builds its own
 * recolored glyph sets rather than sharing `Hud`'s, which keeps the two independent about what
 * color each draws in. One `WadFont` per color, built on first use and kept for the level: a font
 * decodes all 63 `STCFN` patches, far too much to redo per message.
 */
export class CenterMessage {
  private gfx: GraphicsBank;
  private fonts = new Map<string, WadFont>();
  private canvas = document.getElementById('hud-message') as HTMLCanvasElement;
  /** Seconds of display time left; <= 0 means nothing is showing. */
  private secondsLeft = 0;

  constructor(gfx: GraphicsBank) {
    this.gfx = gfx;
  }

  private fontFor(color: WadFontRecolor): WadFont {
    const cacheKey = color.join(',');
    let font = this.fonts.get(cacheKey);
    if (!font) {
      font = new WadFont(this.gfx, color);
      this.fonts.set(cacheKey, font);
    }
    return font;
  }

  /**
   * Draws `runs` as one line and restarts the timeout — a second message replaces whatever is up,
   * it doesn't queue.
   */
  show(...runs: MessageRun[]): void {
    const parts = runs.map((run) =>
      typeof run === 'string'
        ? { text: run, font: this.fontFor(COLOR_YELLOW) }
        : { text: run.text, font: this.fontFor(run.color) },
    );
    let width = 0;
    let height = 0;
    for (const part of parts) {
      width += part.font.measure(part.text);
      height = Math.max(height, part.font.height);
    }
    this.canvas.width = Math.max(1, width);
    this.canvas.height = Math.max(1, height);
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    let x = 0;
    for (const part of parts) x = part.font.draw(ctx, x, 0, part.text);
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
