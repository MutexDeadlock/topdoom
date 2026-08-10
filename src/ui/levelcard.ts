import type { GraphicsBank } from '../wad/graphics.ts';
import { drawIcon } from './hud.ts';
import { WadFont, type WadFontRecolor } from './wadfont.ts';

/**
 * How long the card stays up after a level loads — long enough to read the name while already
 * moving, short enough not to sit over the first fight. **Tuned by feel**; vanilla has no
 * equivalent (its level name is part of the intermission screen you just left, not of the level
 * you arrive in).
 */
const CARD_SECONDS = 3.5;

/**
 * How much of that is spent fading out. Driven from `update`'s `dt` like the timeout itself rather
 * than handed to a CSS transition: a transition keeps running while the game is paused, so opening
 * the menu on a fresh level would leave the card to fade away behind it and be gone on return.
 * **Tuned by feel.**
 */
const FADE_SECONDS = 1;

/** The fixed first line; the level's own name is the second. */
const ENTERING = 'Entering';

/**
 * The grey a name drawn as text takes, so it reads as the same thing as the `CWILV` graphic it
 * stands in for. Sampled from `CWILV00`'s glyphs — the most common of its body greys (`179`), not
 * its brightest pixel (nine white highlight pixels) and not its most common color overall (the
 * `67` grey of its drop shadow); neither is what that type reads as. Lifted 10% from there,
 * **tuned by feel**: the patch carries its own highlights and shadow, and flat text at the body
 * grey alone comes out dimmer than the graphic it stands in for.
 */
const LEVEL_NAME_GREY: WadFontRecolor = [197, 197, 197];

/**
 * The "Entering / <level name>" card raised by every map load — see docs/hud.md § Level card.
 * Same "canvas sized to its content, CSS scales it" pattern `Hud` and `CenterMessage` use, one
 * canvas per line so the name can be drawn at twice the label's size without a second font: both
 * canvases hold native-size art and `levelcard.css` gives them different heights.
 */
export class LevelCard {
  private gfx: GraphicsBank;
  private root = document.getElementById('level-card')!;
  private enterCanvas = this.root.querySelector<HTMLCanvasElement>('.enter')!;
  private nameCanvas = this.root.querySelector<HTMLCanvasElement>('.name')!;
  private redFont: WadFont;
  private greyFont: WadFont;
  /** Seconds of display time left; <= 0 means nothing is showing. */
  private secondsLeft = 0;

  constructor(gfx: GraphicsBank) {
    this.gfx = gfx;
    this.redFont = new WadFont(gfx);
    this.greyFont = new WadFont(gfx, LEVEL_NAME_GREY);
    this.draw(this.enterCanvas, this.redFont, ENTERING);
  }

  private draw(canvas: HTMLCanvasElement, font: WadFont, text: string): void {
    canvas.width = Math.max(1, font.measure(text));
    canvas.height = Math.max(1, font.height);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    font.draw(ctx, 0, 0, text);
  }

  /**
   * Raises the card for `name`, restarting the timeout if one was already up. `patch` is the
   * WAD's own level-name graphic (`LevelNames.graphicFor`) where the set has one that belongs to
   * this map — the name as its artist drew it, in place of the text; `name` still covers the maps
   * and WADs that have no such lump, which is why both are passed.
   */
  show(name: string, patch?: string): void {
    if (!patch || !drawIcon(this.nameCanvas, this.gfx, patch)) {
      this.draw(this.nameCanvas, this.greyFont, name);
    }
    this.secondsLeft = CARD_SECONDS;
    this.root.style.opacity = '1';
    this.root.classList.remove('hidden');
  }

  /**
   * Ticks the timeout down and fades the card out over its last `FADE_SECONDS`. Not called while
   * the game is paused, so the menu doesn't eat the card's display time — or its fade.
   */
  update(dt: number): void {
    if (this.secondsLeft <= 0) return;
    this.secondsLeft -= dt;
    if (this.secondsLeft <= 0) this.clear();
    else this.root.style.opacity = String(Math.min(1, this.secondsLeft / FADE_SECONDS));
  }

  /** Drops the card. The element is static markup outliving any one `Game`, so `dispose` goes through here too. */
  clear(): void {
    this.secondsLeft = 0;
    this.root.classList.add('hidden');
  }
}
