/**
 * DEHACKED/BEX patches: finding the lump in a loaded WAD set, parsing it, and reporting what it
 * asked for against what this engine can actually do. The parser and the index bridges live in
 * `game/dehacked/`.
 *
 * **Reading a patch is this file; writing one into the tables is `dehacked/apply.ts`.** The layer
 * has those two entry points rather than one, and the split is by audience: the menu's WAD library
 * and the build-time manifest plugin only ever want a patch's *text* (level titles, par times), and
 * re-exporting the applier here would make them evaluate every game table to get it.
 * docs/dehacked.md § The two entry points.
 */
import type { Wad, WadFile } from '../wad/wad.ts';
import type { DehPatch, DehShortfall } from './dehacked/defs.ts';
import { parseDehacked, WarningLog } from './dehacked/parse.ts';

export { parseDehacked } from './dehacked/parse.ts';

export type { DehPatch, DehShortfall, DehWarning } from './dehacked/defs.ts';

/** Lump name a WAD-embedded patch travels under. BOOM made this the standard place for one. */
const DEHACKED_LUMP = 'DEHACKED';

/** A parsed patch, plus which files in the set contributed one. */
export interface LoadedDehacked extends DehPatch {
  /** In load order. The savegame's WAD-set identity keys off these — docs/savegames.md. */
  sources: readonly WadFile[];
}

/** Latin-1, matching `campaign/mapinfo.ts`: a DEHACKED lump is bytes, not UTF-8. */
const DECODER = new TextDecoder('latin1');

/**
 * Every `DEHACKED` lump in the set, parsed in load order and merged, or null if the set has none.
 *
 * Merged rather than last-file-wins, unlike a MAPINFO lump: DEH patches are cumulative in every
 * engine that reads them — a `.deh` that retunes one monster does not repeal an earlier one that
 * renamed the levels. Later files still win **per key**, which is what the merge order gives.
 *
 * `titleLookup` reaches vanilla `Text` substitutions to a map (see `parseDehacked`); pass the one
 * `campaign/names.ts` builds.
 */
export function readDehacked(
  wad: Wad,
  titleLookup?: (title: string) => string | undefined,
): LoadedDehacked | null {
  const lumps = wad.findAll(DEHACKED_LUMP);
  if (lumps.length === 0) return null;

  const thingEdits = [];
  const ammoEdits = [];
  const weaponEdits = [];
  const frameEdits = [];
  const misc: Record<string, number> = {};
  const spriteRenames = new Map<string, string>();
  const soundLumps = new Map<string, string>();
  const musicLumps = new Map<string, string>();
  const strings = new Map<string, string>();
  const pars = new Map<string, number>();
  const warnings = new WarningLog();
  const applied: Record<string, number> = {};
  const sources: WadFile[] = [];

  for (const lump of lumps) {
    const patch = parseDehacked(DECODER.decode(wad.data(lump)), titleLookup);
    thingEdits.push(...patch.thingEdits);
    ammoEdits.push(...patch.ammoEdits);
    weaponEdits.push(...patch.weaponEdits);
    frameEdits.push(...patch.frameEdits);
    Object.assign(misc, patch.misc);
    for (const [key, value] of patch.spriteRenames) spriteRenames.set(key, value);
    for (const [key, value] of patch.soundLumps) soundLumps.set(key, value);
    for (const [key, value] of patch.musicLumps) musicLumps.set(key, value);
    for (const [key, value] of patch.strings) strings.set(key, value);
    for (const [key, value] of patch.pars) pars.set(key, value);
    warnings.merge(patch.warnings);
    for (const [key, n] of Object.entries(patch.applied)) applied[key] = (applied[key] ?? 0) + n;
    sources.push(lump.source);
  }

  return {
    thingEdits,
    ammoEdits,
    weaponEdits,
    frameEdits,
    spriteRenames,
    misc,
    soundLumps,
    musicLumps,
    strings,
    pars,
    warnings: warnings.drain(),
    applied,
    sources,
  };
}

/**
 * One line naming what a patch changed, and one naming what it asked for that this engine
 * couldn't do — the console half of the coverage report. Empty strings where there is nothing to
 * say, so a caller can skip the log entirely. `files` comes back too, so `inspect-wad`'s longer
 * report labels itself the same way rather than re-joining the sources.
 */
export function describeDehacked(patch: LoadedDehacked): { files: string; applied: string; skipped: string } {
  const files = patch.sources.map((f) => f.name).join(', ');
  const parts = Object.entries(patch.applied)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`);

  const groups = new Map<DehShortfall, number>();
  for (const w of patch.warnings) {
    groups.set(w.support, (groups.get(w.support) ?? 0) + w.count);
  }
  const skipped = [...groups]
    .map(([support, n]) => `${n} ${support}`)
    .join(', ');

  return {
    files,
    applied: parts.length ? `DEHACKED (${files}): ${parts.join(', ')} applied` : '',
    skipped: skipped ? `DEHACKED (${files}): ${skipped}` : '',
  };
}
