/**
 * Boom's named colormap lumps — the ones a 242 line's sidedef points at to
 * recolour the view inside or under a sector. Only their overall colour cast is
 * decoded, not the 34-row remap itself. See docs/wad.md § Colormap lumps.
 */
import type { Wad } from './wad.ts';
import { readPalette } from './graphics.ts';

/**
 * A colormap lump is 34 rows of 256 palette indexes: 32 light levels, the invulnerability row, and
 * one spare.
 */
const COLORMAP_SIZE = 34 * 256;

/** A per-channel multiplier against the plain palette, 0-1 each. */
export interface ColorTint {
  r: number;
  g: number;
  b: number;
}

/**
 * The colour cast of the colormap lump called `name`, or null when the WAD has no such lump or it
 * is the wrong size (in which case the name is an ordinary texture — Boom decides the same way,
 * `p_setup.c: P_LoadSideDefs2`). The cast is read off **row 0**, the unlit-by-distance row, as a
 * per-channel ratio — docs/wad.md § Colormap lumps.
 */
export function colormapTint(wad: Wad, name: string): ColorTint | null {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === '-') return null;
  const lump = wad.find(trimmed);
  if (!lump || lump.size < COLORMAP_SIZE) return null;

  const palette = readPalette(wad);
  const rows = wad.data(lump);
  const sums = [0, 0, 0];
  const plain = [0, 0, 0];
  for (let i = 0; i < 256; i++) {
    const mapped = rows[i] * 3;
    const own = i * 3;
    for (let c = 0; c < 3; c++) {
      sums[c] += palette[mapped + c];
      plain[c] += palette[own + c];
    }
  }

  const ratio = (c: number) => (plain[c] === 0 ? 1 : Math.min(1, sums[c] / plain[c]));
  return { r: ratio(0), g: ratio(1), b: ratio(2) };
}
