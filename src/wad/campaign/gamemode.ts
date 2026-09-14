/**
 * Which of vanilla's game modes a loaded WAD set is, read off the map names it provides. Vanilla
 * identifies its IWAD by file name (`d_main.c: IdentifyVersion`), which nothing here can trust —
 * a set is whatever files the player picked, under whatever names.
 * See docs/wad.md § What game mode a set is.
 */

/**
 * The game modes this engine tells apart — `d_main.c`'s `GameMode_t`, less two of its five.
 * `retail` folds into `registered`. `indetermined` has no place at all — a set with no maps never
 * starts a game (`game.ts` refuses it), and one whose maps are named neither way is read as
 * `registered` below.
 */
export type GameMode = 'shareware' | 'registered' | 'commercial';

/** DOOM 2's map-name scheme, which the shareware and registered sets have no map of. */
const COMMERCIAL_MAP = /^MAP\d\d$/;

/** DOOM 1's scheme, split at the episode the shareware IWAD stops before. */
const FIRST_EPISODE_MAP = /^E1M\d$/;
const LATER_EPISODE_MAP = /^E[2-9]M\d$/;

/**
 * The mode a set's map list makes it. `MAPxx` anywhere is DOOM 2; any episode past the first is the
 * registered DOOM 1 (vanilla's own test, `D_DoomMain`); episode 1 and nothing else is shareware. A
 * set naming its maps neither way is `registered`, the mode that withholds nothing a DOOM 1 set can
 * have.
 */
export function gameModeOf(mapNames: readonly string[]): GameMode {
  if (mapNames.some((name) => COMMERCIAL_MAP.test(name))) return 'commercial';
  if (mapNames.some((name) => LATER_EPISODE_MAP.test(name))) return 'registered';
  return mapNames.some((name) => FIRST_EPISODE_MAP.test(name)) ? 'shareware' : 'registered';
}
