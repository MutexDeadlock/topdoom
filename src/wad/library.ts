/**
 * The menu's WAD library: `WadSource` (a server-manifest file, a disk upload, or a file in the
 * player's own library folder), which maps a game-WAD + add-on selection yields, and loading the
 * picked set into `WadFile`s. See docs/wad.md and docs/menu.md.
 */
import { WadFile, type WadType } from './wad.ts';
import { idOf } from './checksum.ts';
import { bytesOf, describeWad } from './describe.ts';
import type { WadSupport } from './support.ts';
import { levelTitleFor, missionOf } from './campaign/names.ts';

// This file is the layer's one entry point (docs/conventions.md § File names); `library/` holds
// the player's own folder, which only the menu drives. The edge runs one way — `library/disk.ts`
// takes `WadSource` as a type alone, so re-exporting it here makes no cycle.
export {
  acceptableWads,
  adoptFolderFiles,
  ensureLibraryAccess,
  forgetLibrary,
  libraryName,
  libraryPicked,
  librarySkips,
  librarySources,
  pickerBlock,
  pickLibraryFolder,
  rememberLibraryId,
  rescanIfPermitted,
  rescanLibrary,
  restoreLibrary,
  type LibrarySkip,
  type PickerBlock,
} from './library/disk.ts';

const MANIFEST_URL = '/game/index.json';

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
  origin: WadOrigin;
  /**
   * Which folder the file sits in, and so which group the WAD Library overlay files it under:
   * `iwad`/`pwad` for a server file (the folder decides how it is served — docs/wad.md § The
   * `public/game/` manifest), a path relative to the library root for a library file, absent for
   * an upload, which sits in no folder at all.
   */
  folder?: string;
  bytes(): Promise<ArrayBuffer>;
}

/**
 * Where a source's bytes come from, which is also how long they last: `server` and `library` files
 * outlive the session and can be named in a stored selection, an `upload` cannot
 * (docs/menu.md § Remembered selection).
 */
export type WadOrigin = 'server' | 'upload' | 'library';

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
   * Optional because a cached `index.json` can predate the field, which is what the `?? ''` below
   * degrades to: a source with no ID matches no savegame rather than matching wrongly.
   */
  id?: string;
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

/** Which DOOM's map-naming convention a WAD's maps follow, if any. */
export type MapStyle = 'doom1' | 'doom2' | null;

/**
 * DOOM names maps `E<episode>M<mission>`, DOOM II `MAP<nn>` — the two schemes
 * never mix within one game, so a WAD's own maps (if it has any) say which
 * game it belongs to. A WAD with no maps of its own (a texture/sound add-on)
 * has no style and is compatible with either.
 */
export function mapStyle(source: WadSource): MapStyle {
  if (source.maps.some((m) => /^E\dM\d$/.test(m))) return 'doom1';
  if (source.maps.some((m) => /^MAP\d\d$/.test(m))) return 'doom2';
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

/** Wraps a server-side file; the fetched bytes are kept so restarts are instant. */
function serverSource(entry: ManifestEntry): WadSource {
  let cached: Promise<ArrayBuffer> | null = null;
  return {
    key: entry.file,
    id: entry.id ?? '',
    label: entry.file,
    type: entry.type,
    maps: entry.maps,
    lumpCount: entry.lumpCount,
    dehacked: entry.dehacked,
    support: entry.support,
    levelNames: entry.levelNames ?? {},
    size: entry.size,
    origin: 'server',
    folder: entry.folder,
    bytes() {
      // `folder` is a path now, not one segment — each segment is encoded on its own so the
      // separators survive (docs/wad.md § The `public/game/` manifest).
      const dir = entry.folder.split('/').map(encodeURIComponent).join('/');
      cached ??= fetch(`/game/${dir}/${encodeURIComponent(entry.file)}`).then(async (res) => {
        if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
        return res.arrayBuffer();
      });
      return cached;
    },
  };
}

/** Parses an uploaded file far enough to categorise it, then keeps it in memory. */
export async function uploadedSource(name: string, buffer: ArrayBuffer): Promise<WadSource> {
  const described = await describeWad(name, bytesOf(buffer));
  return {
    ...described,
    key: `upload:${name}:${buffer.byteLength}`,
    // The one place an ID costs real work (a pass over up to ~14 MB), paid here
    // rather than lazily: the save list matches by ID and renders synchronously,
    // and unlike a library file these bytes are already in memory. Memoized against
    // the buffer, so starting a level with this file does not walk it a second time.
    id: idOf(buffer),
    label: name,
    size: buffer.byteLength,
    origin: 'upload',
    bytes: () => Promise.resolve(buffer),
  };
}

/**
 * A source's content ID, hashing its bytes if that hasn't happened yet, and writing the answer
 * back onto the source so it is paid once. Only a library file ever needs this — its scan reads a
 * few hundred KB per file rather than the whole thing (docs/wad.md § The player's own library),
 * so the menu calls this the moment such a file is picked, which is strictly before it can appear
 * in a savegame.
 */
export async function ensureWadId(source: WadSource): Promise<string> {
  if (source.id) return source.id;
  source.id = idOf(await source.bytes());
  return source.id;
}

/** WADs the server offers under public/game/. Empty if the manifest is missing. */
export async function fetchLibrary(): Promise<WadSource[]> {
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) return [];
    const entries = (await res.json()) as ManifestEntry[];
    if (!Array.isArray(entries)) return [];
    return entries.map(serverSource);
  } catch {
    return [];
  }
}

/** One row of the menu's level list. `title` is absent when nothing in the set names the level. */
export interface MergedMap {
  name: string;
  provider: string;
  title?: string;
}

/**
 * Map list for an IWAD plus its add-ons: the IWAD's own maps in order, then any
 * extra maps a PWAD introduces. Each map is attributed to the file that wins.
 *
 * Titles resolve exactly as they do in-game (`wad/campaign/names.ts`), off the manifest alone so
 * the list can be built without downloading anything: MAPINFO from anywhere in the set (later files
 * winning, as with lumps), else the vanilla title for the IWAD's own maps.
 */
export function mergedMaps(iwad: WadSource, pwads: WadSource[]): MergedMap[] {
  const provider = new Map<string, string>();
  for (const map of iwad.maps) provider.set(map, iwad.label);

  const order = [...iwad.maps];
  // Each file's own titles — its MAPINFO's, or its DEHACKED's where MAPINFO named nothing.
  const fileTitles = new Map(Object.entries(iwad.levelNames));
  for (const pwad of pwads) {
    for (const map of pwad.maps) {
      if (!provider.has(map)) order.push(map);
      provider.set(map, pwad.label);
    }
    for (const [map, title] of Object.entries(pwad.levelNames)) fileTitles.set(map, title);
  }

  const mission = missionOf(iwad.label);
  return order.map((name) => {
    const from = provider.get(name)!;
    const title = levelTitleFor(name, {
      mapInfoTitle: fileTitles.get(name),
      mission,
      providerName: from,
      providerIsPwad: from !== iwad.label,
    });
    return title ? { name, provider: from, title } : { name, provider: from };
  });
}

/** Loads the selected files in the order the engine has to merge them. */
export async function loadWadFiles(iwad: WadSource, pwads: WadSource[]): Promise<WadFile[]> {
  const sources = [iwad, ...pwads];
  const buffers = await Promise.all(sources.map((s) => s.bytes()));
  return sources.map((s, i) => new WadFile(buffers[i], s.label));
}
