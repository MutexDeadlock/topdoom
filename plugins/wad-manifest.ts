import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { bytesOf, describeWad } from '../src/wad/describe.ts';
import { hashBytes } from '../src/wad/checksum.ts';
import { isTextFile, MANIFEST_PATH, siblingTextFile, WAD_DIR, type ManifestEntry } from '../src/wad/library.ts';
import type { WadSupport } from '../src/wad/support.ts';

/** The two folders that are scanned, and what a file found under each is offered as. */
export type WadRoot = 'iwad' | 'pwad';

/**
 * Where a WAD sits under `public/game/`, relative to it and `/`-separated — also the URL path it is
 * served under. A root on its own (`pwad`), or a subfolder below one (`pwad/megawads`): both roots
 * are scanned recursively, so a collection can be filed the same way it would be on disk and the
 * menu shows it as a tree (docs/menu.md § WAD Library).
 */
export type WadFolder = string;

/**
 * What this plugin writes into `index.json`. The shape itself is the menu's — `ManifestEntry` in
 * `src/wad/library.ts`, the module that casts the fetched JSON to it — so producer and consumer
 * cannot drift. `id` and `support` are always written here even though the consumer tolerates their
 * absence, which is only there for an `index.json` cached from before either field existed.
 */
export type WadManifestEntry = ManifestEntry & { id: string; support: WadSupport };

/**
 * One file's manifest entry. The description itself is `wad/describe.ts`'s, shared with the two
 * in-browser callers so the same file cannot list differently served, uploaded, or found in the
 * player's own library; the id is added here because these bytes are already in memory.
 */
export async function manifestEntry(path: string, folder: WadFolder): Promise<WadManifestEntry | null> {
  const buf = readFileSync(path);
  const file = path.split('/').pop()!;

  let described;
  try {
    described = await describeWad(file, bytesOf(buf));
  } catch {
    // Not a WAD, or a malformed one: it simply doesn't show up in the menu.
    return null;
  }

  return {
    file,
    folder,
    size: buf.length,
    type: described.type,
    maps: described.maps,
    lumpCount: described.lumpCount,
    // Over the whole file, exactly as `wadId` does at runtime — the two must
    // agree or `verifyWadSet` would refuse every load.
    id: hashBytes(buf),
    ...(described.dehacked ? { dehacked: true } : {}),
    // On every row, empty ones included: absent is *unknown*, not "fine" — docs/wad.md § Will it run?
    support: described.support,
    ...(Object.keys(described.levelNames).length > 0 ? { levelNames: described.levelNames } : {}),
  };
}

/**
 * `manifestEntry` memoized on the file's mtime and size, which `scanFolder`'s
 * `statSync` already has. The dev middleware re-scans on *every* request for
 * the manifest, and each entry reads and hashes its file whole — ~57 MB of
 * WADs here, added to every page reload on the path that gates `Menu.init`.
 * Editing a WAD still re-describes it; reloading the page no longer does.
 *
 * The *promise* is memoized, not the entry: two overlapping requests for the manifest would
 * otherwise both miss and describe every file twice.
 */
const described = new Map<string, { mtimeMs: number; size: number; entry: Promise<WadManifestEntry | null> }>();

function describeCached(
  path: string,
  folder: WadFolder,
  mtimeMs: number,
  size: number,
): Promise<WadManifestEntry | null> {
  const hit = described.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.entry;
  const entry = manifestEntry(path, folder);
  described.set(path, { mtimeMs, size, entry });
  return entry;
}

/**
 * Depth cap on the recursion, so a stray symlink or a deeply nested pack can't turn a page load into
 * an unbounded walk. Nobody files a WAD collection eight folders deep.
 */
const MAX_DEPTH = 8;

/**
 * One folder and everything under it. `folder` is the path relative to `public/game/`, which is both
 * how the menu groups the file and the URL it is served from — so a subfolder needs no extra
 * bookkeeping, it just carries a longer path.
 */
async function scanFolder(dir: string, folder: WadFolder, root: WadRoot, depth = 0): Promise<WadManifestEntry[]> {
  if (depth >= MAX_DEPTH) return [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const out: WadManifestEntry[] = [];
  // The folder's own listing is what answers "is there a `.txt` beside this WAD" — one pass over
  // the names already read, rather than a `statSync` per WAD.
  const texts = names.filter(isTextFile);
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) {
        out.push(...(await scanFolder(path, `${folder}/${name}`, root, depth + 1)));
        continue;
      }
      if (!stat.isFile() || !/\.wad$/i.test(name)) continue;
      const entry = await describeCached(path, folder, stat.mtimeMs, stat.size);
      if (!entry) continue;
      // The root is what decides how the file is used; a signature mismatch
      // (e.g. a PWAD dropped into the `iwad` folder) still gets listed, just flagged.
      if ((root === 'iwad') !== (entry.type === 'IWAD')) {
        console.warn(
          `[topdoom] ${path}: ${entry.type} signature but placed in ${WAD_DIR}/${root}/ — ` +
            `serving it as ${root} anyway`,
        );
      }
      // Merged onto the memo's answer rather than described with it: the sibling is a property of
      // the folder's listing, not of this file's bytes, so a `.txt` dropped in later must not have
      // to invalidate a description that is still correct. `library/disk.ts` does the same.
      const textFile = siblingTextFile(name, texts);
      out.push(textFile ? { ...entry, textFile } : entry);
    } catch {
      // Unreadable or malformed files simply don't show up in the menu.
    }
  }
  return out;
}

async function scan(root: string): Promise<WadManifestEntry[]> {
  return [
    ...(await scanFolder(join(root, 'iwad'), 'iwad', 'iwad')),
    ...(await scanFolder(join(root, 'pwad'), 'pwad', 'pwad')),
  ];
}

/**
 * Publishes the contents of public/game/{iwad,pwad} as JSON so the start menu
 * can offer the WADs already on disk. Served live in dev, baked into the
 * output on build.
 */
export function wadManifest(root = join('public', WAD_DIR)): Plugin {
  return {
    name: 'topdoom:wad-manifest',

    configureServer(server) {
      // Registered here, so it runs before Vite's static handler would 404.
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/' + MANIFEST_PATH) return next();
        void scan(root).then((entries) => {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(entries));
        }, next);
      });
    },

    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST_PATH, source: JSON.stringify(await scan(root)) });
    },
  };
}
