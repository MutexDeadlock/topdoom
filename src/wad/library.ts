/**
 * The menu's WAD library, and this layer's one entry point: what a source is and where one comes
 * from (`library/`), which maps a game-WAD + add-on selection yields, and loading the picked set
 * into `WadFile`s. See docs/wad.md and docs/menu.md.
 */
import { WadFile } from './wad.ts';
import { idOf } from './checksum.ts';
import { bytesOf, describeWad } from './describe.ts';
import { decodeTextFile } from './library/textfile.ts';
import { levelTitleFor, missionOf, type TitleFrom } from './campaign/names.ts';
import type { Progress, WadSource } from './library/defs.ts';

// `library/` holds the shapes, the three places a source comes from, and the text file beside one;
// nothing outside this directory reaches into it (docs/conventions.md § File names).
export {
  fitsGameWad,
  mapNameStyle,
  mapStyle,
  pwadsFor,
  servedFolder,
  type DownloadProgress,
  type ManifestEntry,
  type Progress,
  type WadSource,
} from './library/defs.ts';

export { fetchLibrary, MANIFEST_PATH, WAD_DIR } from './library/manifest.ts';

export {
  decodeTextFile,
  isTextFile,
  siblingTextFile,
  textFileIndex,
  type WadTextFile,
} from './library/textfile.ts';

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
} from './library/disk.ts';

/** One row of the menu's level list. `title` is absent when nothing in the set names the level. */
export interface MergedMap {
  name: string;
  provider: string;
  title?: string;
}

/**
 * Parses an uploaded file far enough to categorise it, then keeps it in memory. `text` is the `.txt`
 * picked or dropped alongside it, which `Menu.addFiles` pairs by name — an upload sits in no folder,
 * so a sibling can only ever arrive in the same batch. The `File` itself, not its bytes: a handle
 * keeps the read where every other source has it, at the moment the player opens the popup
 * (docs/wad.md § The text file beside a WAD).
 */
export async function uploadedSource(name: string, buffer: ArrayBuffer, text?: File): Promise<WadSource> {
  const described = await describeWad(name, bytesOf(buffer));
  return {
    ...described,
    ...(text ? { textFile: { name: text.name, read: async () => decodeTextFile(await text.arrayBuffer()) } } : {}),
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
  // Each file's own titles — its MAPINFO's, or its DEHACKED's where MAPINFO named nothing — each
  // tagged with whether the IWAD is what named it, which decides whether it reaches a map an
  // add-on provides.
  const fileTitles = new Map<string, TitleFrom>();
  for (const [map, title] of Object.entries(iwad.levelNames)) fileTitles.set(map, { title, fromIwad: true });
  for (const pwad of pwads) {
    for (const map of pwad.maps) {
      if (!provider.has(map)) order.push(map);
      provider.set(map, pwad.label);
    }
    for (const [map, title] of Object.entries(pwad.levelNames)) fileTitles.set(map, { title, fromIwad: false });
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

/**
 * Loads the selected files in the order the engine has to merge them.
 *
 * `onProgress` reports the whole set at once — bytes arrived against bytes expected — because that
 * is the one number a progress bar can show while several files download in parallel. Every source
 * that will download declares itself in this same tick (`DownloadProgress`), so the total is the
 * sum of their manifest `size`s and is fixed before the first byte: the bar only ever moves
 * forward. A source already in memory (an upload, a second start on the same set) declares nothing
 * and is left out, which is why a warm start shows no bar rather than a full one.
 * docs/menu.md § The loading screen.
 */
export async function loadWadFiles(iwad: WadSource, pwads: WadSource[], onProgress?: Progress): Promise<WadFile[]> {
  const sources = [iwad, ...pwads];
  const loaded = sources.map(() => 0);
  let total = 0;

  const buffers = await Promise.all(
    sources.map((s, i) => {
      if (!onProgress) return s.bytes();
      let counted = false;
      return s.bytes((got) => {
        // The declaring call (0 bytes) only joins the total — reporting it would show a fraction of
        // a denominator the sources declared after this one have not been added to yet.
        if (!counted) {
          counted = true;
          total += s.size;
          return;
        }
        loaded[i] = got;
        onProgress(
          loaded.reduce((sum, n) => sum + n, 0),
          total,
        );
      });
    }),
  );
  return sources.map((s, i) => new WadFile(buffers[i], s.label));
}
