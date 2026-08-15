/**
 * The menu's WAD library: `WadSource` (a server-manifest file or a disk upload), which maps a
 * game-WAD + add-on selection yields, and loading the picked set into `WadFile`s.
 * See docs/wad.md and docs/menu.md.
 */
import { Wad, WadFile, type WadType } from './wad.ts';
import { wadId } from './checksum.ts';
import { mapInfoNames } from './mapinfo.ts';
import { levelTitleFor, missionOf } from './levelnames.ts';

const MANIFEST_URL = '/wads/index.json';

/**
 * A WAD the menu can offer, whether it sits on the server or was picked from
 * the user's disk. Bytes are only pulled in when something actually needs them.
 */
export interface WadSource {
  /** Where the file lives: the UI's handle for it, and what ?wad= / ?pwad= name. Not an identity — a rename changes it, and the same bytes have different keys as a server file and as an upload. */
  key: string;
  /**
   * Content id of the bytes (`hashBytes`), known without downloading them: the
   * manifest carries it for a server file, an upload is hashed as it is added.
   * *This* is the file's identity — what a savegame's WAD set is matched
   * against (docs/savegames.md § WAD-set identity).
   */
  id: string;
  label: string;
  type: WadType;
  /** Map markers this file defines. */
  maps: string[];
  /** Total lump count — shown for map-less add-ons so they don't look empty. */
  lumpCount: number;
  /** Level titles this file's MAPINFO defines, keyed by map lump name — see docs/wad.md § Level names. */
  levelNames: Record<string, string>;
  size: number;
  origin: 'server' | 'upload';
  bytes(): Promise<ArrayBuffer>;
}

type WadFolder = 'iwad' | 'pwad';

interface ManifestEntry {
  file: string;
  folder: WadFolder;
  size: number;
  type: WadType;
  maps: string[];
  lumpCount: number;
  /**
   * `hashBytes` content id — see the plugin's own note for why it is computed at build time.
   * Optional because a cached `index.json` can predate the field, which is what the `?? ''`
   * below degrades to: a source with no id matches no savegame rather than matching wrongly.
   */
  id?: string;
  /** Only present for the few WADs that carry a MAPINFO lump — see plugins/wad-manifest.ts. */
  levelNames?: Record<string, string>;
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
    levelNames: entry.levelNames ?? {},
    size: entry.size,
    origin: 'server',
    bytes() {
      cached ??= fetch(`/wads/${entry.folder}/${encodeURIComponent(entry.file)}`).then(async (res) => {
        if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
        return res.arrayBuffer();
      });
      return cached;
    },
  };
}

/** Parses an uploaded file far enough to categorise it, then keeps it in memory. */
export function uploadedSource(name: string, buffer: ArrayBuffer): WadSource {
  const file = new WadFile(buffer, name);
  return {
    key: `upload:${name}:${buffer.byteLength}`,
    // The one place an id costs real work (a pass over up to ~14 MB), paid here
    // rather than lazily: the save list matches by id and renders synchronously.
    // `wadId` memoizes per file, so loading this source later re-uses it.
    id: wadId(file),
    label: name,
    type: file.type,
    maps: file.mapNames(),
    lumpCount: file.entries.length,
    // The manifest plugin does this server-side for the WADs on disk; a file picked here has to
    // read its own MAPINFO, and the bytes are already in memory.
    levelNames: Object.fromEntries(mapInfoNames(new Wad(file))),
    size: buffer.byteLength,
    origin: 'upload',
    bytes: () => Promise.resolve(buffer),
  };
}

/** WADs the server offers under public/wads/. Empty if the manifest is missing. */
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
 * Titles resolve exactly as they do in-game (`wad/levelnames.ts`), off the manifest alone so the
 * list can be built without downloading anything: MAPINFO from anywhere in the set (later files
 * winning, as with lumps), else the vanilla title for the IWAD's own maps.
 */
export function mergedMaps(iwad: WadSource, pwads: WadSource[]): MergedMap[] {
  const provider = new Map<string, string>();
  for (const map of iwad.maps) provider.set(map, iwad.label);

  const order = [...iwad.maps];
  const mapInfoTitles = new Map(Object.entries(iwad.levelNames));
  for (const pwad of pwads) {
    for (const map of pwad.maps) {
      if (!provider.has(map)) order.push(map);
      provider.set(map, pwad.label);
    }
    for (const [map, title] of Object.entries(pwad.levelNames)) mapInfoTitles.set(map, title);
  }

  const mission = missionOf(iwad.label);
  return order.map((name) => {
    const from = provider.get(name)!;
    const title = levelTitleFor(name, {
      mapInfoTitle: mapInfoTitles.get(name),
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
