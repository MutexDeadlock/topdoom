/**
 * Center-screen messages ("You need a blue key…"), one at a time, in the WAD's own font.
 * See docs/hud.md § Center messages.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';
import type { KeyColor } from '../../game/inventory.ts';
import type { LockRule } from '../../game/specials/defs.ts';
import { lockedLine } from '../../game/specials/tables.ts';
import { LEVEL_STATS_GREEN } from './hud.ts';
import { WadFont, COLOR_YELLOW, type WadFontRecolor } from './wadfont.ts';

/**
 * How long one message stays up. Vanilla's `HU_MSGTIMEOUT` is 4 seconds
 * (`4*TICRATE`) for a message printed in the top-left corner you can read while
 * still playing; this one sits in the middle of the view, so it's shorter —
 * **tuned by feel**.
 */
const MESSAGE_SECONDS = 3;

/**
 * Shown with the engine's own `secret` sound (`public/secret.ogg`, not a WAD lump at all), so both
 * the message and the sound are this engine's own. Vanilla announces a
 * secret nowhere at all: the status bar's `S` count just ticks up. Lives here rather than with the
 * `specials/sectoreffects.ts` rule that detects one, because it is a line of display text and this
 * is the module that displays them. `game.ts` raises it. docs/hud.md § Center messages.
 */
export const SECRET_MESSAGE = 'You found a secret area';

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
 * The words a message draws in a color of their own rather than the message's. The three key
 * colors are `KEY_TEXT_COLORS`; `green` is the only other color this repo has a WAD-derived value
 * for (`hud.ts`'s `LEVEL_STATS_GREEN`, sampled from `ARM1A0`) and is here for a **patched** line —
 * no vanilla or Boom string names it, since DOOM has no green key.
 */
const COLOR_WORDS: Record<string, WadFontRecolor> = {
  blue: KEY_TEXT_COLORS.blue,
  red: KEY_TEXT_COLORS.red,
  yellow: KEY_TEXT_COLORS.yellow,
  green: LEVEL_STATS_GREEN,
};

/** Built from `COLOR_WORDS` rather than spelled twice; whole words only, so "redo" stays plain. */
const COLOR_WORD = new RegExp(`\\b(?:${Object.keys(COLOR_WORDS).join('|')})\\b`, 'gi');

/**
 * The line shown when a locked door or switch is used without what it wants — `specials/tables.ts`'s
 * `LOCKED_LINES`, which is where the vanilla/Boom wording and its `PD_*` mnemonics live, and where
 * a DEH patch will have replaced it.
 *
 * The one departure from those strings is presentational and applies to whatever text comes back:
 * a color word is drawn in that color instead of the message's. Splitting the finished line rather
 * than composing it from colored fragments is what lets a patched line keep the effect — the patch
 * writes "You need a blue card", not the three pieces this used to assemble.
 */
export function lockedLineMessage(lock: LockRule, kind: 'door' | 'switch'): MessageRun[] {
  const line = lockedLine(lock, kind);
  const runs: MessageRun[] = [];
  let at = 0;
  for (const match of line.matchAll(COLOR_WORD)) {
    if (match.index > at) runs.push(line.slice(at, match.index));
    runs.push({ text: match[0], color: COLOR_WORDS[match[0].toLowerCase()] });
    at = match.index + match[0].length;
  }
  if (at < line.length) runs.push(line.slice(at));
  return runs;
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
