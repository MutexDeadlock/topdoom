/**
 * What a WAD the menu can offer looks like — `WadSource`, the `index.json` row a served one is
 * built from, and the pure rules over those shapes: which folder a file is served under, which
 * game its maps belong to, and which add-ons a game WAD leaves standing.
 * See docs/wad.md and docs/menu-wads.md.
 */
import type { WadType } from '../wad.ts';
import type { WadSupport } from '../support.ts';
import type { WadTextFile } from './textfile.ts';

/**
 * A WAD the menu can offer, whether it sits on the server or was picked from
 * the user's disk. Bytes are only pulled in when something actually needs them.
 */
export interface WadSource {
  /**
   * Where the file lives: the UI's handle for it, and what ?wad= / ?pwad= name. Not an identity — a
   * rename changes it, and the same bytes have different keys as a server file and as an upload.
   */
  key: string;
  /**
   * Content ID of the bytes (`hashBytes`), known without downloading them: the
   * manifest carries it for a server file, an upload is hashed as it is added.
   * *This* is the file's identity — what a savegame's WAD set is matched
   * against (docs/savegames.md § WAD-set identity).
   *
   * Empty until `ensureWadId` fills it in for a library file, which is the one source that has
   * *not* read its bytes yet — an empty ID matches no savegame rather than matching wrongly.
   * docs/wad.md § The player's own library.
   */
  id: string;
  label: string;
  type: WadType;
  /** Map markers this file defines. */
  maps: string[];
  /** Total lump count — shown for map-less add-ons so they don't look empty. */
  lumpCount: number;
  /** Whether the file carries a `DEHACKED` lump — docs/dehacked.md § The coverage report. */
  dehacked?: boolean;
  /**
   * Every reason this engine can't fully run the file; absent is *unknown* — docs/wad.md § Will it
   * run?
   */
  support?: WadSupport;
  /**
   * Level titles this file's MAPINFO defines, keyed by map lump name — see docs/wad.md § Level
   * names.
   */
  levelNames: Record<string, string>;
  size: number;
  /**
   * Where the bytes come from, which is also how long they last: `server` and `library` files
   * outlive the session and can be named in a stored selection, an `upload` cannot
   * (docs/menu.md § Remembered selection).
   */
  origin: 'server' | 'upload' | 'library';
  /**
   * Which folder the file sits in, and so which group the WAD Library overlay files it under:
   * `iwad`/`pwad` for a server file (the folder decides how it is served — docs/wad.md § The
   * `public/game/` manifest), a path relative to the library root for a library file, absent for
   * an upload, which sits in no folder at all.
   */
  folder?: string;
  /**
   * The text file sitting beside this WAD, when there is one — `SCYTHE.TXT` next to `SCYTHE.WAD`.
   * Its presence is known without reading anything (the manifest carries the name, a library scan
   * and an upload pair the two by name), which is what lets both WAD lists draw their info column
   * off the same listing they draw the rest of the row from. docs/wad.md § The text file beside a
   * WAD.
   */
  textFile?: WadTextFile;
  /**
   * `onProgress` is reported as the bytes arrive, and only by a source that actually downloads —
   * a file already in memory has nothing to report and calls it not at all. It is ignored on every
   * call after the first, which is what the memo hands back.
   */
  bytes(onProgress?: DownloadProgress): Promise<ArrayBuffer>;
}

/**
 * How many of a source's `size` bytes have arrived. A source that is going to download calls this
 * with 0 before it starts — that first call is what declares it, so `loadWadFiles` can total up
 * everything that will download before any of it arrives. One already in memory never calls it.
 */
export type DownloadProgress = (loaded: number) => void;

/**
 * How far a whole batch has got, against how much of it there is: the one number a bar can show
 * while several files are worked in parallel. Both the folder scan and a set's download report
 * through it.
 */
export type Progress = (done: number, total: number) => void;

/**
 * One `index.json` row — the manifest's wire format, declared **here and only here**. The
 * build-time producer (`plugins/wad-manifest.ts`) imports this same interface rather than restating
 * it: the two had drifted on `folder` alone, and a shape the consumer casts raw JSON to is one the
 * producer must be checked against. See docs/wad.md § The `public/game/` manifest.
 */
export interface ManifestEntry {
  file: string;
  /**
   * Where the file sits under `public/game/`, relative to it and `/`-separated — also the URL path
   * it is served under. A root on its own (`pwad`), or a subfolder below one (`pwad/megawads`):
   * both roots are scanned recursively, so a collection can be filed the way it would be on disk
   * and the menu shows it as a tree. `servedFolder` is what splits the root back off.
   */
  folder: string;
  size: number;
  type: WadType;
  /** Map markers the file defines, so the menu can list levels without downloading it. */
  maps: string[];
  /** Total lump count, shown for map-less add-ons so they don't look empty. */
  lumpCount: number;
  /** Whether the file carries a `DEHACKED` lump. Presence only — what a patch actually changes
      needs the bytes, which the menu hasn't downloaded. docs/dehacked.md § The coverage report. */
  dehacked?: boolean;
  /**
   * The support verdict, written on every row. Optional for the same reason `id` is, and only that
   * reason: an `index.json` cached from before the field reads as unknown — docs/wad.md § Will it
   * run?
   */
  support?: WadSupport;
  /**
   * `hashBytes` content ID, so the menu knows a file's identity without downloading it — what a
   * savegame's WAD set is matched against (docs/savegames.md § WAD-set identity). Computed at build
   * time because those bytes are already in memory; the alternative is fetching every WAD in the
   * library just to draw the save list.
   *
   * Optional because a cached `index.json` can predate the field, which is what `serverSource`'s
   * `?? ''` degrades to: a source with no ID matches no savegame rather than matching wrongly.
   */
  id?: string;
  /**
   * The name of the `.txt` sitting beside the WAD in the same served folder, absent when there is
   * none — spelled as it is on disk, since that is the name the fetch has to ask for.
   */
  textFile?: string;
  /**
   * Each map's title, so the menu can name levels without downloading the file — the same reason
   * `maps` is here. What the file's own MAPINFO defines, and where it defines nothing, what its
   * `DEHACKED` patch names. Absent when it has neither, which is most of them.
   */
  levelNames?: Record<string, string>;
}

/**
 * Splits a served file's `folder` into the root it was served from and the path below it — the one
 * place that knows the first segment *is* the root (docs/wad.md § The `public/game/` manifest), so
 * the menu can group by both halves without decoding the path itself. The fallback covers a source
 * carrying no folder at all: its own signature is the root it would have been served from.
 */
export function servedFolder(source: WadSource): { root: string; under: string } {
  const path = source.folder ?? (source.type === 'IWAD' ? 'iwad' : 'pwad');
  const cut = path.indexOf('/');
  return cut < 0 ? { root: path, under: '' } : { root: path.slice(0, cut), under: path.slice(cut + 1) };
}

/**
 * Which DOOM's map-naming convention a single map lump name follows, if any. DOOM names maps
 * `E<episode>M<mission>`, DOOM II `MAP<nn>`, and anything else belongs to neither.
 *
 * **The one spelling of the two schemes**: `mapStyle` reads a file's own maps through it, and the
 * stand-in game WAD a save resolves to is picked with it against the map *name* the save stored
 * (docs/savegames.md § A stand-in game WAD) — a second copy is how the picker comes to accept a
 * file the level list then names nothing in.
 */
export function mapNameStyle(map: string): 'doom1' | 'doom2' | null {
  if (/^E\dM\d$/.test(map)) return 'doom1';
  if (/^MAP\d\d$/.test(map)) return 'doom2';
  return null;
}

/**
 * Which DOOM's map-naming convention a WAD's maps follow, if any. The two schemes never mix within
 * one game, so a WAD's own maps (if it has any) say which game it belongs to — the first one that
 * names a scheme settles it. A WAD with no maps of its own (a texture/sound add-on) has no style
 * and is compatible with either.
 */
export function mapStyle(source: WadSource): 'doom1' | 'doom2' | null {
  for (const map of source.maps) {
    const style = mapNameStyle(map);
    if (style) return style;
  }
  return null;
}

/**
 * Whether an add-on can be merged with a game WAD: a map-less add-on (a texture or sound pack) has
 * no style of its own and fits either game, one carrying maps only makes sense beside a game WAD
 * naming its maps the same way, and a game WAD with no maps constrains nothing.
 *
 * **The one statement of that rule.** The menu prunes its picks with it and the WAD Library greys
 * its rows out with it; two copies is how the overlay comes to offer a row the prune then silently
 * drops.
 */
export function fitsGameWad(iwad: WadSource | null, pwad: WadSource): boolean {
  const style = iwad && mapStyle(iwad);
  if (!style) return true;
  const own = mapStyle(pwad);
  return own === null || own === style;
}

/**
 * The add-ons a game WAD leaves standing: the ones it can be merged with (`fitsGameWad`), minus the
 * file that *is* the game WAD, which cannot also be an add-on to itself.
 *
 * **What a set costs to pick, in one statement.** The menu applies it to its own selection and the
 * WAD Library previews it against the draft the player is assembling; two copies is how the overlay
 * comes to show a set that Apply then quietly produces differently.
 */
export function pwadsFor(iwad: WadSource | null, pwads: readonly WadSource[]): WadSource[] {
  return pwads.filter((p) => p.key !== iwad?.key && fitsGameWad(iwad, p));
}
