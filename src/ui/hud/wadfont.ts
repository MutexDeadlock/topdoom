/**
 * `WadFont`: rasterizes the WAD's `STCFN*` glyph lumps for HUD/menu text, with recoloring.
 * `WadNumbers`: the status bar's own `STTNUM`/`STYSNUM` digit sets, for the HUD's readouts.
 * See docs/hud.md § WadFont and WadNumbers.
 */
import type { GraphicsBank } from '../../wad/graphics.ts';

/**
 * Flattens every glyph's hue to this color instead of the lump's own — alpha is left
 * untouched, and each opaque pixel is scaled by its *own* brightness first (`max(r,g,b)/255`)
 * before tinting, so a pixel that was a darker shade of the source color (STCFN's anti-aliased
 * edges) still comes out a darker shade of the tint rather than every opaque pixel flattening to
 * one flat fill — the glyph's own shading survives the recolor.
 */
export type WadFontRecolor = readonly [number, number, number];

/**
 * The blue security armor's own ramp (`ARM2A0`'s pixels sit on PLAYPAL's blue range, indices
 * 192-207), taken four rungs above the sprite's brightest pixel (index 201, `0,0,227`): pure blue
 * is the darkest hue in the palette and read too dim against the level behind it, so this picks
 * index 197 off the same ramp — **brightness tuned by feel**, hue still WAD-derived. Here rather
 * than with either consumer for the same reason `COLOR_YELLOW` is: the HUD's over-100
 * health/armor digits (`ui/hud/hud.ts`'s `VALUE_TIERS`) and the crosshair's over-100 reticle
 * (`ui/hud/crosshair.ts`) are the same cue in two places and must not drift apart.
 */
export const COLOR_BLUE: WadFontRecolor = [99, 99, 255];

/**
 * Sampled from `STYSNUM1` — vanilla's own status-bar yellow. Lives here rather than with either
 * consumer because both the level-stats numbers (`ui/hud/hud.ts`) and the center message
 * (`ui/hud/message.ts`) recolor to the same WAD-derived yellow.
 */
export const COLOR_YELLOW: WadFontRecolor = [255, 255, 115];

/**
 * Which of vanilla's two status-bar digit sets a `WadNumbers` draws (`st_stuff.c`'s `tallnum` and
 * `shortnum`): `'tall'` is `STTNUM0`-`STTNUM9`, the big red digits the original prints health,
 * armor and the current weapon's ammo in; `'short'` is `STYSNUM0`-`STYSNUM9`, the small yellow
 * ones its ammo list is drawn with. Both already carry their color in the lump — recoloring is for
 * the cues this HUD adds on top (`LEVEL_STATS_GREEN`), not for getting the vanilla look.
 */
export type WadNumberSet = 'tall' | 'short';

/** One right-aligned readout: the number to draw and how many digit cells it is drawn in. */
export interface DigitRun {
  value: number;
  cells: number;
}

/** Vanilla `hu_stuff.h`'s `HU_FONTSTART`/`HU_FONTEND` — the `STCFN033`-`STCFN095` range. */
const FONT_FIRST = 33; // '!'
const FONT_LAST = 95; // '_'

/**
 * `hu_lib.c`'s `HUlib_drawTextLine` advance for a space or any character outside the font's range.
 */
const SPACE_ADVANCE = 4;

/** ASCII `'0'`, where `WadNumbers`' fallback digits start in the STCFN range. */
const STCFN_DIGIT_ZERO = 48;

/** The lump prefix each set's ten digits are named with. */
const NUMBER_LUMPS: Record<WadNumberSet, string> = { tall: 'STTNUM', short: 'STYSNUM' };

interface Glyph {
  /**
   * Built once at load rather than per blit: `putImageData` copies out of it, so one `ImageData`
   * serves every draw of this glyph into every canvas.
   */
  image: ImageData;
  /**
   * The patch's own hotspots, negated — where this glyph starts relative to the pen position,
   * the way `V_DrawPatch` draws at `x - leftoffset, y - topoffset`. The short glyphs are not
   * full-height images with blank rows: `.` is a 3px-tall patch with a `topoffset` of -4, and only
   * lands on the baseline because of that subtraction. Ignoring it puts every period, comma,
   * hyphen and underscore at the *top* of the line; ignoring `left` shifts DOOM2's `STTNUM1`
   * (`leftoffset` -1) inside its cell.
   */
  left: number;
  top: number;
}

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
      const glyph = loadGlyph(gfx, stcfnLump(code), recolor);
      if (!glyph) continue;
      this.glyphs.set(code, glyph);
      // The line box has to cover where each glyph actually lands, not just how tall its patch is.
      height = Math.max(height, glyph.top + glyph.image.height);
    }
    this.height = height;
  }

  /** Total pixel width `text` would draw at, for sizing a canvas or composing multiple runs. */
  measure(text: string): number {
    let w = 0;
    for (const ch of text) w += this.glyphFor(ch)?.image.width ?? SPACE_ADVANCE;
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
      putGlyph(ctx, glyph, x, y);
      x += glyph.image.width;
    }
    return x;
  }

  private glyphFor(ch: string): Glyph | undefined {
    return this.glyphs.get(ch.toUpperCase().charCodeAt(0));
  }
}

/**
 * Draws integers with the status bar's own digit lumps, laid out like `st_lib.c`'s
 * `STlib_drawNum`: a fixed cell the width of digit `0` (vanilla's `ST_TALLNUMWIDTH`), digits
 * filled in from the right of a block that many cells wide, and 0 drawn as a single `0` rather
 * than a blank. Everything the HUD counts is unsigned, so vanilla's `STTMINUS` branch has no
 * counterpart here — a negative value clamps to 0. docs/hud.md § The HUD.
 *
 * A WAD missing the set falls back to the message font's own digits (`STCFN048`-`STCFN057`);
 * one missing both draws nothing at all.
 */
export class WadNumbers {
  readonly height: number;
  /**
   * Every digit occupies this much width, whatever its own patch measures — `STlib_drawNum`'s `w`.
   */
  private cellWidth: number;
  private digits: readonly Glyph[];

  constructor(gfx: GraphicsBank, set: WadNumberSet, recolor?: WadFontRecolor) {
    const prefix = NUMBER_LUMPS[set];
    this.digits =
      loadDigits(gfx, (d) => `${prefix}${d}`, recolor) ??
      loadDigits(gfx, (d) => stcfnLump(STCFN_DIGIT_ZERO + d), recolor) ??
      [];
    let height = 0;
    for (const glyph of this.digits) height = Math.max(height, glyph.top + glyph.image.height);
    this.height = height;
    this.cellWidth = this.digits[0]?.image.width ?? 0;
  }

  /** Pixel width of a `cells`-wide block, for sizing a canvas. */
  measure(cells: number): number {
    return cells * this.cellWidth;
  }

  /** Draws `run.value` right-aligned in a `run.cells`-wide block whose top-left is (x, y). */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, run: DigitRun): void {
    if (this.digits.length === 0) return;
    let { cells } = run;
    let num = Math.max(0, Math.floor(run.value));
    let right = x + this.measure(cells);
    if (num === 0) {
      putGlyph(ctx, this.digits[0], right - this.cellWidth, y);
      return;
    }
    // A value too wide for the block keeps its lowest `cells` digits, as vanilla's own
    // `while (num && numdigits--)` does rather than clipping or widening.
    while (num > 0 && cells-- > 0) {
      right -= this.cellWidth;
      putGlyph(ctx, this.digits[num % 10], right, y);
      num = Math.floor(num / 10);
    }
  }
}

/**
 * The lump holding one STCFN glyph. The three-digit padding is the whole rule and it lives here
 * once — spelled out a second way, unpadded, it silently finds nothing.
 */
function stcfnLump(code: number): string {
  return `STCFN${String(code).padStart(3, '0')}`;
}

/**
 * Decodes one glyph lump, applying `recolor` to its pixels; undefined when the WAD has no such
 * lump.
 */
function loadGlyph(gfx: GraphicsBank, lump: string, recolor?: WadFontRecolor): Glyph | undefined {
  const bmp = gfx.picture(lump);
  if (!bmp) return undefined;
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
  // `data` has to be wrapped here, from the local rather than from a field: `ImageData`'s
  // constructor wants a `Uint8ClampedArray<ArrayBuffer>`, which TS only narrows to from the
  // inline `new` expression's own contextual typing.
  return { image: new ImageData(data, bmp.width, bmp.height), left: -(bmp.left ?? 0), top: -(bmp.top ?? 0) };
}

/** Blits one glyph with its pen position at (x, y), placed by its own patch offsets. */
function putGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, x: number, y: number): void {
  ctx.putImageData(glyph.image, x + glyph.left, y + glyph.top);
}

/**
 * All ten digits of one lump family, or undefined unless the WAD has the whole set. Answered per
 * set rather than per digit: a PWAD shipping only some of `STTNUM` would otherwise render a mix of
 * the two families inside one cell block, with nothing to signal it.
 */
function loadDigits(gfx: GraphicsBank, lumpFor: (d: number) => string, recolor?: WadFontRecolor): Glyph[] | undefined {
  const digits: Glyph[] = [];
  for (let d = 0; d <= 9; d++) {
    const glyph = loadGlyph(gfx, lumpFor(d), recolor);
    if (!glyph) return undefined;
    digits.push(glyph);
  }
  return digits;
}
