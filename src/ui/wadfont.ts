import type { GraphicsBank } from '../wad/graphics.ts';

/** Vanilla `hu_stuff.h`'s `HU_FONTSTART`/`HU_FONTEND` — the `STCFN033`-`STCFN095` range. */
const FONT_FIRST = 33; // '!'
const FONT_LAST = 95; // '_'

/** `hu_lib.c`'s `HUlib_drawTextLine` advance for a space or any character outside the font's range. */
const SPACE_ADVANCE = 4;

interface Glyph {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * The patch's own vertical hotspot, negated — how far below the line's top this glyph starts.
   * The short glyphs are not full-height images with blank rows: `.` is a 3px-tall patch with a
   * `topoffset` of -4, and only lands on the baseline because `V_DrawPatch` draws it at
   * `y - topoffset`. Ignoring it puts every period, comma, hyphen and underscore at the *top* of
   * the line.
   */
  top: number;
}

/**
 * Flattens every glyph's hue to this color instead of STCFN's own native red — alpha is left
 * untouched, and each opaque pixel is scaled by its *own* brightness first (`max(r,g,b)/255`)
 * before tinting, so a pixel that was a darker shade of the source color (STCFN's anti-aliased
 * edges) still comes out a darker shade of the tint rather than every opaque pixel flattening to
 * one flat fill — the glyph's own shading survives the recolor.
 */
export type WadFontRecolor = readonly [number, number, number];

/**
 * Sampled from `STYSNUM1` — vanilla's own status-bar yellow. Lives here rather than with either
 * consumer because both the level-stats numbers (`ui/hud.ts`) and the center message
 * (`ui/message.ts`) recolor to the same WAD-derived yellow.
 */
export const COLOR_YELLOW: WadFontRecolor = [255, 255, 115];

/**
 * Draws text with the IWAD's own status-bar font (`STCFN033`-`STCFN095`, the same lumps
 * vanilla's on-screen messages use), proportionally spaced exactly like `hu_lib.c`'s
 * `HUlib_drawTextLine`: each glyph advances by its own patch width with no kerning, a space or
 * any character outside the font advances a flat 4px, and each is placed vertically by its own
 * patch offset the way `V_DrawPatch` does (see `Glyph.top` — without it the short glyphs float at
 * the top of the line). Text is uppercased before lookup, matching vanilla's `toupper` — the font
 * has no lowercase glyphs. docs/hud.md § Level stats.
 *
 * STCFN's own pixels are already vanilla's HUD-message red; pass `recolor` to retint every glyph
 * to a different color instead (see `WadFontRecolor`'s doc) — this repo has no
 * palette-translation-table mechanism, so this is the only way to get a second color out of one
 * glyph set.
 */
export class WadFont {
  readonly height: number;
  private glyphs = new Map<number, Glyph>();

  constructor(gfx: GraphicsBank, recolor?: WadFontRecolor) {
    let height = 0;
    for (let code = FONT_FIRST; code <= FONT_LAST; code++) {
      const bmp = gfx.picture(`STCFN${String(code).padStart(3, '0')}`);
      if (!bmp) continue;
      const data = new Uint8ClampedArray(bmp.data);
      if (recolor) {
        const [r, g, b] = recolor;
        for (let i = 0; i < data.length; i += 4) {
          const brightness = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
          data[i] = r * brightness;
          data[i + 1] = g * brightness;
          data[i + 2] = b * brightness;
        }
      }
      const top = -(bmp.top ?? 0);
      this.glyphs.set(code, { data, width: bmp.width, height: bmp.height, top });
      // The line box has to cover where each glyph actually lands, not just how tall its patch is.
      height = Math.max(height, top + bmp.height);
    }
    this.height = height;
  }

  private glyphFor(ch: string): Glyph | undefined {
    return this.glyphs.get(ch.toUpperCase().charCodeAt(0));
  }

  /** Total pixel width `text` would draw at, for sizing a canvas or composing multiple runs. */
  measure(text: string): number {
    let w = 0;
    for (const ch of text) w += this.glyphFor(ch)?.width ?? SPACE_ADVANCE;
    return w;
  }

  /** Draws `text` with its top-left at (x, y); returns the x position just past the last glyph. */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, text: string): number {
    for (const ch of text) {
      const glyph = this.glyphFor(ch);
      if (!glyph) {
        x += SPACE_ADVANCE;
        continue;
      }
      // Re-wrapped rather than reusing `glyph.data` directly: `ImageData`'s constructor wants a
      // `Uint8ClampedArray<ArrayBuffer>`, and TS only narrows to that from an inline `new`
      // expression's contextual typing, not from a pre-typed field.
      ctx.putImageData(new ImageData(new Uint8ClampedArray(glyph.data), glyph.width, glyph.height), x, y + glyph.top);
      x += glyph.width;
    }
    return x;
  }
}
