/**
 * The WADs the server itself offers: where they are served from, the `index.json` listing them, and
 * the {@link WadSource} one served file becomes — the only place in this layer that fetches.
 * See docs/wad.md § The `public/game/` manifest.
 */
import { decodeTextFile } from './textfile.ts';
import type { DownloadProgress, ManifestEntry, WadSource } from './defs.ts';

/**
 * The folder game WADs are served from, without slashes — `public/<WAD_DIR>/{iwad,pwad}` on disk,
 * `/<WAD_DIR>/…` as a URL. Declared here, with the code that fetches through it, and imported by
 * `plugins/wad-manifest.ts` rather than restated there: the two must name the same folder or the
 * menu lists files it cannot then load. docs/wad.md § The `public/game/` manifest.
 */
export const WAD_DIR = 'game';

/** The manifest's path under that folder — also the name the plugin emits it as. */
export const MANIFEST_PATH = `${WAD_DIR}/index.json`;

/** WADs the server offers under public/game/. Empty if the manifest is missing. */
export async function fetchLibrary(): Promise<WadSource[]> {
  try {
    const res = await fetch(`/${MANIFEST_PATH}`);
    if (!res.ok) return [];
    const entries = (await res.json()) as ManifestEntry[];
    if (!Array.isArray(entries)) return [];
    return entries.map(serverSource);
  } catch {
    return [];
  }
}

/** Wraps a server-side file; the fetched bytes are kept so restarts are instant. */
function serverSource(entry: ManifestEntry): WadSource {
  let cached: Promise<ArrayBuffer> | null = null;
  const text = entry.textFile;
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
    ...(text ? { textFile: { name: text, read: () => fetchText(servedPath(entry.folder, text)) } } : {}),
    bytes(onProgress) {
      // Announced before the fetch, not on the first chunk: `loadWadFiles` calls every source in
      // one tick, so declaring here is what lets it fix the total before any byte lands.
      if (!cached) onProgress?.(0);
      cached ??= fetch(servedPath(entry.folder, entry.file)).then(async (res) => {
        if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
        // Streamed only when someone is watching: an unwatched load has no reason to pay for
        // chunk bookkeeping over up to 28 MB.
        return onProgress && res.body ? drain(res.body, entry.size, onProgress) : res.arrayBuffer();
      });
      return cached;
    },
  };
}

/**
 * The URL one served file sits at. `folder` is a path, not one segment — each segment is encoded on
 * its own so the separators survive (docs/wad.md § The `public/game/` manifest).
 */
function servedPath(folder: string, file: string): string {
  const dir = folder.split('/').map(encodeURIComponent).join('/');
  return `/${WAD_DIR}/${dir}/${encodeURIComponent(file)}`;
}

/**
 * A served text file as text — the sibling `.txt` a WAD row offers, fetched only when the player
 * opens it. Decoded by {@link decodeTextFile} rather than `res.text()`, which would assume UTF-8
 * and turn a DOS-era file's box art into replacement characters.
 */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decodeTextFile(await res.arrayBuffer());
}

/**
 * Reads a response body chunk by chunk, reporting the running total. Written straight into one
 * buffer of the size the manifest already promised, rather than collected and joined: for a 28 MB
 * IWAD that would be a second full copy on the one path that always runs. A body that turns out to
 * be a different length than promised — a re-encoded file the manifest predates — is trimmed or
 * rejoined then, where the copy is the price of being wrong rather than the standing cost.
 */
async function drain(body: ReadableStream<Uint8Array>, expected: number, onProgress: DownloadProgress): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const out = new Uint8Array(expected);
  const overflow: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // A chunk straddling the promised end is split, so `out` stays contiguous and `overflow` holds
    // exactly what came after it.
    const fits = Math.min(value.length, Math.max(0, expected - loaded));
    if (fits > 0) out.set(value.subarray(0, fits), loaded);
    if (fits < value.length) overflow.push(value.subarray(fits));
    loaded += value.length;
    onProgress(loaded);
  }
  if (loaded === expected) return out.buffer;

  const joined = new Uint8Array(loaded);
  joined.set(out.subarray(0, Math.min(loaded, expected)));
  let at = expected;
  for (const chunk of overflow) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined.buffer;
}
