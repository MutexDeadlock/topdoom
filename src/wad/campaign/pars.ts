/**
 * Vanilla's par times (`g_game.c`) keyed by map lump name, and the per-WAD-set resolution that
 * folds a DEHACKED `[PARS]` section in. See docs/wad.md § Par times.
 */
import type { LevelMission } from './names.ts';

/**
 * `linuxdoom-1.10/g_game.c`'s `pars[4][10]`, flattened onto lump names. Row 0 is `{0}` and each
 * row's slot 0 is unused padding, because `G_DoCompleted` indexes `pars[gameepisode][gamemap]`
 * with both 1-based — so the table only ever describes E1M1-E3M9.
 *
 * **Episode 4 has no par time, and this is a deliberate deviation.** `pars` has four rows and
 * `gameepisode` is 4 on Ultimate Doom's E4, so vanilla reads `pars[4][gamemap]` — one row past the
 * array. That is an out-of-bounds read, not a value worth reproducing: `E4M*` resolves to
 * undefined here and the intermission simply omits the row unless a `[PARS]` section supplies one.
 */
const DOOM1_PARS: Record<string, number> = {
  E1M1: 30,
  E1M2: 75,
  E1M3: 120,
  E1M4: 90,
  E1M5: 165,
  E1M6: 180,
  E1M7: 180,
  E1M8: 30,
  E1M9: 165,
  E2M1: 90,
  E2M2: 90,
  E2M3: 90,
  E2M4: 120,
  E2M5: 90,
  E2M6: 360,
  E2M7: 240,
  E2M8: 30,
  E2M9: 170,
  E3M1: 90,
  E3M2: 45,
  E3M3: 90,
  E3M4: 150,
  E3M5: 90,
  E3M6: 90,
  E3M7: 165,
  E3M8: 30,
  E3M9: 135,
};

/**
 * `g_game.c`'s `cpars[32]`, indexed `cpars[gamemap-1]`. `G_DoCompleted` picks it over `pars` on
 * `gamemode == commercial`, which covers Plutonia and TNT as well as DOOM II — Final Doom shipped
 * on an unchanged `doom2.exe`, so all three genuinely use these same 32 numbers.
 */
const DOOM2_PARS: Record<string, number> = {
  MAP01: 30,
  MAP02: 90,
  MAP03: 120,
  MAP04: 120,
  MAP05: 90,
  MAP06: 150,
  MAP07: 120,
  MAP08: 120,
  MAP09: 270,
  MAP10: 90,
  MAP11: 210,
  MAP12: 150,
  MAP13: 150,
  MAP14: 150,
  MAP15: 210,
  MAP16: 150,
  MAP17: 420,
  MAP18: 150,
  MAP19: 210,
  MAP20: 150,
  MAP21: 240,
  MAP22: 150,
  MAP23: 180,
  MAP24: 150,
  MAP25: 150,
  MAP26: 300,
  MAP27: 330,
  MAP28: 420,
  MAP29: 300,
  MAP30: 180,
  MAP31: 120,
  MAP32: 30,
};

/** Everything the resolver below needs about one map, gathered from the loaded WAD set. */
export interface ParSources {
  /** The loaded IWAD's mission, or null if its file name wasn't recognised. */
  mission: LevelMission | null;
  /** Map lump name to seconds, from a DEHACKED/BEX `[PARS]` section anywhere in the set. */
  dehPars?: ReadonlyMap<string, number>;
}

/**
 * The level's par time in seconds, or undefined if nothing knows one: what the set's DEHACKED
 * `[PARS]` says, else the vanilla table for the IWAD's mission.
 *
 * Unlike `levelTitleFor`, the vanilla table is **not** gated on the map coming from the IWAD. A
 * PWAD's `MAP01` is a different level, but a par time is a target rather than a name, and vanilla
 * itself applies `cpars` to whatever `MAP01` is loaded — there is no provenance check in
 * `G_DoCompleted`.
 */
export function parSecondsFor(mapName: string, sources: ParSources): number | undefined {
  const upper = mapName.toUpperCase();
  const deh = sources.dehPars?.get(upper);
  if (deh !== undefined) return deh;
  if (!sources.mission) return undefined;
  return sources.mission === 'doom' ? DOOM1_PARS[upper] : DOOM2_PARS[upper];
}
