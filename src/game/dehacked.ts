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
import { STATES } from './dehacked/states.ts';
import { decodeTextLump } from '../wad/textlump.ts';

export { parseDehacked } from './dehacked/parse.ts';

export type { DehPatch, DehShortfall, DehWarning } from './dehacked/defs.ts';

/** Lump name a WAD-embedded patch travels under. */
const DEHACKED_LUMP = 'DEHACKED';

/** A parsed patch, plus which files in the set contributed one. */
export interface LoadedDehacked extends DehPatch {
  /** In load order. The savegame's WAD-set identity keys off these — docs/savegames.md. */
  sources: readonly WadFile[];
  /**
   * Which file's patch set each string's winning value. Level naming asks — the IWAD's own titles
   * don't name a map an add-on provides (docs/wad.md § Level names) — and the merged
   * {@link DehPatch.strings} alone can't say.
   */
  stringSources: ReadonlyMap<string, WadFile>;
}

/** The files {@link readDehacked} merges a lump from, in load order, or null if none has one. */
export function dehackedSources(wad: Wad): WadFile[] | null {
  const lumps = wad.findAll(DEHACKED_LUMP);
  return lumps.length === 0 ? null : lumps.map((lump) => lump.source);
}

/**
 * Every `DEHACKED` lump in the set, parsed in load order and merged, or null if the set has none.
 * Cumulative rather than last-file-wins, unlike a MAPINFO lump; later files still win **per key**.
 * docs/dehacked.md § Where a patch comes from.
 *
 * @param titleLookup  reaches vanilla `Text` substitutions to a map (see {@link parseDehacked});
 *                     pass the one `campaign/names.ts` builds
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
  const pointerEdits = [];
  const misc: Record<string, number> = {};
  const spriteRenames = new Map<string, string>();
  const soundLumps = new Map<string, string>();
  const musicLumps = new Map<string, string>();
  const strings = new Map<string, string>();
  const stringSources = new Map<string, WadFile>();
  const pars = new Map<string, number>();
  const warnings = new WarningLog();
  const applied: Record<string, number> = {};
  const sources: WadFile[] = [];
  // The widest table any lump asked for: the merged edits are applied against one copy, and a lump
  // that grew it further does not shrink for the others.
  let stateCount = 0;

  for (const lump of lumps) {
    const patch = parseDehacked(decodeTextLump(wad.data(lump)), titleLookup);
    thingEdits.push(...patch.thingEdits);
    ammoEdits.push(...patch.ammoEdits);
    weaponEdits.push(...patch.weaponEdits);
    frameEdits.push(...patch.frameEdits);
    pointerEdits.push(...patch.pointerEdits);
    Object.assign(misc, patch.misc);
    for (const [key, value] of patch.spriteRenames) spriteRenames.set(key, value);
    for (const [key, value] of patch.soundLumps) soundLumps.set(key, value);
    for (const [key, value] of patch.musicLumps) musicLumps.set(key, value);
    for (const [key, value] of patch.strings) {
      strings.set(key, value);
      stringSources.set(key, lump.source);
    }
    for (const [key, value] of patch.pars) pars.set(key, value);
    stateCount = Math.max(stateCount, patch.stateCount);
    warnings.merge(patch.warnings);
    for (const [key, n] of Object.entries(patch.applied)) applied[key] = (applied[key] ?? 0) + n;
    sources.push(lump.source);
  }

  return {
    thingEdits,
    ammoEdits,
    weaponEdits,
    frameEdits,
    pointerEdits,
    spriteRenames,
    misc,
    soundLumps,
    musicLumps,
    strings,
    pars,
    stateCount,
    warnings: warnings.drain(),
    applied,
    sources,
    stringSources,
  };
}

/**
 * One line naming what a patch changed, and one naming what it asked for that this engine
 * couldn't do — the console half of the coverage report. `files` and `states` come back for
 * `inspect-wad`'s longer report, so its labels and phrasing match rather than re-joining sources.
 *
 * @returns empty strings where there is nothing to say, so a caller can skip the log entirely
 */
export function describeDehacked(
  patch: LoadedDehacked,
): { files: string; applied: string; skipped: string; states: string } {
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

  // Only where the patch grew the frame table past the one `info.c` ships — the number a reader
  // needs to tell an MBF21-era patch from a vanilla one. docs/dehacked.md § Extended states.
  const grown = patch.stateCount > STATES.length;

  return {
    files,
    applied: parts.length ? `DEHACKED (${files}): ${parts.join(', ')} applied` : '',
    skipped: skipped ? `DEHACKED (${files}): ${skipped}` : '',
    states: grown ? `extended states: table grown to ${patch.stateCount} rows (from ${STATES.length})` : '',
  };
}
