/**
 * A player's armour colour: the PLAYPAL ramps a player sprite's sixteen greens can be drawn as —
 * vanilla's own translations for players 2-4 and four more — the palette a recoloured bank decodes
 * through, and the setting the local player picks one in. See docs/sprites.md § Player colours.
 */
import { readStorage, writeStorage } from '../util/storage.ts';

/** A colour's name, as the setting, the network and a replay record carry it. */
export type PlayerColor = 'green' | 'gray' | 'brown' | 'red' | 'blue' | 'white' | 'orange' | 'pink';

/**
 * Where each colour's sixteen shades start in PLAYPAL, running brightest to darkest as the green
 * does. Green is the armour as drawn (`0x70`-`0x7f`); gray, brown and red are the ramps
 * `R_InitTranslationTables` (`r_draw.c`) maps it onto for players 2-4. Blue, white, orange and pink
 * are PLAYPAL ramps of the same shape, picked by eye — tuned by feel. In the menu's order.
 */
export const PLAYER_COLOR_RAMPS: Record<PlayerColor, number> = {
  green: 0x70,
  gray: 0x60,
  brown: 0x40,
  red: 0x20,
  blue: 0xc0,
  white: 0x50,
  orange: 0xd0,
  pink: 0x10,
};

/** Every colour, in the menu's order. */
export const PLAYER_COLORS = Object.keys(PLAYER_COLOR_RAMPS) as PlayerColor[];

/** What the setting holds until a player picks: player 1's own. */
export const DEFAULT_PLAYER_COLOR: PlayerColor = 'green';

const COLOR_STORAGE_KEY = 'playerColor';

/**
 * Read per drawn frame, so a pick applies to the level already running. Shaped like every
 * persisted setting — docs/menu.md § Persisted settings.
 */
let playerColor = asPlayerColor(readStorage(COLOR_STORAGE_KEY, DEFAULT_PLAYER_COLOR), DEFAULT_PLAYER_COLOR);

export function getPlayerColor(): PlayerColor {
  return playerColor;
}

export function setPlayerColor(color: PlayerColor): void {
  playerColor = color;
  writeStorage(COLOR_STORAGE_KEY, color);
}

/** The colour player `slot` wears in vanilla — what a slot whose player picked none draws in. */
export function slotColor(slot: number): PlayerColor {
  return VANILLA_SLOT_COLORS[slot % VANILLA_SLOT_COLORS.length];
}

/** `v` where it names a colour, else `fallback` — how a peer's, a file's or the store's is read. */
export function asPlayerColor(v: unknown, fallback: PlayerColor): PlayerColor {
  return PLAYER_COLORS.find((color) => color === v) ?? fallback;
}

/**
 * `palette` with the green ramp's sixteen entries replaced by `color`'s: vanilla's index
 * translation applied to the palette rather than to the pixels, so a bank decoding through it draws
 * the whole sprite translated, as `MF_TRANSLATION` does. Green hands `palette` itself back.
 */
export function translatedPalette(palette: Uint8Array, color: PlayerColor): Uint8Array {
  if (color === 'green') return palette;
  const from = PLAYER_COLOR_RAMPS.green * 3;
  const to = PLAYER_COLOR_RAMPS[color] * 3;
  const translated = palette.slice();
  translated.set(palette.subarray(to, to + RAMP_LENGTH * 3), from);
  return translated;
}

/** Vanilla's players 1-4: green, then `R_InitTranslationTables`' three (`r_draw.c`). */
const VANILLA_SLOT_COLORS: readonly PlayerColor[] = ['green', 'gray', 'brown', 'red'];

/** Shades in a ramp — `R_InitTranslationTables` translates `0x70`-`0x7f`. */
const RAMP_LENGTH = 16;
