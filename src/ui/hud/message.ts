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
 * Shown with the engine's own `secret` sound, so both the message and the sound are this engine's
 * own: vanilla announces a secret nowhere at all. Lives here rather than with the
 * `specials/sectoreffects.ts` rule that detects one, because it is a line of display text and this
 * is the module that displays them. `game.ts` raises it. docs/hud.md § Center messages.
 */
export const SECRET_MESSAGE = 'You found a secret area';

/**
 * What the player is told when the set has no sprite for something the map placed, which means the
 * thing did not spawn at all (docs/wad.md § Art a WAD set doesn't have). `console.warn` names the
 * doomednums; this only says how many, because the number is what tells the player the level is
 * not the one its author built — most often after a game WAD stood in for the one a save or replay
 * was made on (docs/savegames.md § A stand-in game WAD). `game.ts` raises it at level load.
 */
export function missingArtMessage(types: number): string {
  return types === 1
    ? 'A thing type has no sprite in this WAD set'
    : `${types} thing types have no sprite in this WAD set`;
}

/**
 * Each key color's own text color, sampled from that key's pickup sprite the same way
 * {@link COLOR_YELLOW} and {@link LEVEL_STATS_GREEN} are — `RKEYA0`'s and `YKEYA0`'s brightest
 * pixel exactly.
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

/**
 * One stretch of a message: a bare string draws in {@link COLOR_YELLOW}, otherwise in the color
 * given.
 */
export type MessageRun = string | { text: string; color: WadFontRecolor };

/**
 * The words a message draws in a color of their own rather than the message's. The three key
 * colors are {@link KEY_TEXT_COLORS}; `green` is the only other color this repo has a WAD-derived
 * value for ({@link LEVEL_STATS_GREEN}, sampled from `ARM1A0`) and is here for a **patched**
 * line — no vanilla or Boom string names it, since DOOM has no green key.
 */
const COLOR_WORDS: Record<string, WadFontRecolor> = {
  blue: KEY_TEXT_COLORS.blue,
  red: KEY_TEXT_COLORS.red,
  yellow: KEY_TEXT_COLORS.yellow,
  green: LEVEL_STATS_GREEN,
};

/** Built from {@link COLOR_WORDS}; whole words only, so "redo" stays plain. */
const COLOR_WORD = new RegExp(`\\b(?:${Object.keys(COLOR_WORDS).join('|')})\\b`, 'gi');

/**
 * The line shown when a locked door or switch is used without what it wants —
 * `specials/tables.ts`'s `LOCKED_LINES`, which is where the vanilla/Boom wording and its `PD_*`
 * mnemonics live, and where a DEH patch will have replaced it.
 *
 * The one departure from those strings is presentational: a color word is drawn in that color,
 * split out of the finished line rather than composed from colored fragments so a patched line
 * keeps the effect. docs/hud.md § Center messages.
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
 * A short line of WAD-font text over the middle of the view; docs/hud.md § Center messages lists
 * what raises one. Vanilla prints its messages in the top-left in `STCFN`'s own red
 * (`hu_stuff.c`); this engine puts them center-screen in {@link COLOR_YELLOW} instead, where a
 * top-down player is already looking.
 *
 * One {@link WadFont} per color, built on first use and kept for the level: a font decodes all 63
 * `STCFN` patches, far too much to redo per message.
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

  /**
   * Ticks the timeout down. Not called while the game is paused, so the menu doesn't eat a
   * message's display time.
   */
  update(dt: number): void {
    if (this.secondsLeft <= 0) return;
    this.secondsLeft -= dt;
    if (this.secondsLeft <= 0) this.clear();
  }

  /**
   * Drops whatever is up. Every level (re)load goes through here, so a message can't outlive its
   * level.
   */
  clear(): void {
    this.secondsLeft = 0;
    this.canvas.classList.add('hidden');
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
}
