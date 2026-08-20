import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { MAPINFO_LUMPS, parseMapInfoNames, preferredMapInfoLump } from '../src/wad/campaign/mapinfo.ts';
import { dehTitlesFor, missionOf, titleLookupFor } from '../src/wad/campaign/names.ts';
import { parseDehacked } from '../src/game/dehacked.ts';
import { hashBytes } from '../src/wad/checksum.ts';

export const MANIFEST_PATH = 'wads/index.json';

/** Which subfolder a WAD was found in — also the URL segment it is served under. */
export type WadFolder = 'iwad' | 'pwad';

export interface WadManifestEntry {
  file: string;
  folder: WadFolder;
  size: number;
  type: 'IWAD' | 'PWAD';
  /** Map markers the file defines, so the menu can list levels without downloading it. */
  maps: string[];
  /** Whether the file carries a `DEHACKED` lump. Presence only — what a patch actually changes
      needs the bytes, which the menu hasn't downloaded. docs/dehacked.md § The coverage report. */
  dehacked?: boolean;
  /** Total lump count, shown for map-less add-ons so they don't look empty. */
  lumpCount: number;
  /**
   * `hashBytes` content id, so the menu knows a file's identity without downloading it — what a
   * savegame's WAD set is matched against (docs/savegames.md § WAD-set identity). Computed here
   * because these bytes are already in memory; the alternative is fetching every WAD in the
   * library to draw the save list.
   */
  id: string;
  /**
   * Each map's title, so the menu can name levels without downloading the file — the same reason
   * `maps` is here. What this file's own MAPINFO defines, and where it defines nothing, what its
   * `DEHACKED` patch names. Absent when the file has neither, which is most of them.
   */
  levelNames?: Record<string, string>;
}

/**
 * Reads the header and directory of a WAD — a few kilobytes even for a 14 MB IWAD — plus its
 * MAPINFO lump if it has one, to find out what it is and which levels it holds.
 */
function describeWad(path: string, folder: WadFolder): WadManifestEntry | null {
  const buf = readFileSync(path);
  if (buf.length < 12) return null;

  const ident = buf.toString('ascii', 0, 4);
  if (ident !== 'IWAD' && ident !== 'PWAD') return null;

  const numLumps = buf.readInt32LE(4);
  const dirOffset = buf.readInt32LE(8);
  if (dirOffset < 0 || numLumps < 0 || dirOffset + numLumps * 16 > buf.length) return null;

  const maps: string[] = [];
  let dehLump: { offset: number; size: number } | undefined;
  const mapInfoLumps = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < numLumps; i++) {
    const at = dirOffset + i * 16;
    const name = buf.toString('ascii', at + 8, at + 16).replace(/\0.*$/, '').toUpperCase();
    if (/^(E\dM\d|MAP\d\d)$/.test(name)) maps.push(name);
    // Last one wins within a file, matching the merged directory.
    else if (name === 'DEHACKED') dehLump = { offset: buf.readInt32LE(at), size: buf.readInt32LE(at + 4) };
    else if (MAPINFO_LUMPS.includes(name)) {
      mapInfoLumps.set(name, { offset: buf.readInt32LE(at), size: buf.readInt32LE(at + 4) });
    }
  }

  // Exactly one lump per file, chosen by `preferredMapInfoLump` — the menu's titles and the
  // in-game ones come from the same rule, or a WAD shipping two flavours gets two different names.
  const levelNames: Record<string, string> = {};
  const wanted = preferredMapInfoLump([...mapInfoLumps.keys()]);
  const at = wanted ? mapInfoLumps.get(wanted) : undefined;
  if (at && at.offset >= 0 && at.offset + at.size <= buf.length) {
    for (const [map, title] of parseMapInfoNames(buf.toString('latin1', at.offset, at.offset + at.size))) {
      levelNames[map] = title;
    }
  }

  // A DEHACKED patch fills the gaps MAPINFO left, never overwrites them — the same order
  // `levelTitleFor` applies in-game, so the menu and the level card name a level alike.
  // Projected against this file's own name, which for an IWAD is exactly the mission
  // (`plutonia.wad` picks its `PHUSTR_*` set) and for a PWAD is the plain `HUSTR_*` one.
  const file = path.split('/').pop()!;
  if (dehLump && dehLump.offset >= 0 && dehLump.offset + dehLump.size <= buf.length) {
    const text = buf.toString('latin1', dehLump.offset, dehLump.offset + dehLump.size);
    const patch = parseDehacked(text, titleLookupFor());
    for (const [map, title] of dehTitlesFor(missionOf(file), patch.strings)) {
      levelNames[map] ??= title;
    }
  }

  return {
    file,
    folder,
    size: buf.length,
    type: ident,
    maps,
    lumpCount: numLumps,
    // Over the whole file, exactly as `wadId` does at runtime — the two must
    // agree or `verifyWadSet` would refuse every load.
    id: hashBytes(buf),
    ...(dehLump ? { dehacked: true } : {}),
    ...(Object.keys(levelNames).length > 0 ? { levelNames } : {}),
  };
}

/**
 * `describeWad` memoized on the file's mtime and size, which `scanFolder`'s
 * `statSync` already has. The dev middleware re-scans on *every* request for
 * the manifest, and `describeWad` reads and hashes each file whole — ~57 MB of
 * WADs here, added to every page reload on the path that gates `Menu.init`.
 * Editing a WAD still re-describes it; reloading the page no longer does.
 */
const described = new Map<string, { mtimeMs: number; size: number; entry: WadManifestEntry | null }>();

function describeCached(path: string, folder: WadFolder, mtimeMs: number, size: number): WadManifestEntry | null {
  const hit = described.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.entry;
  const entry = describeWad(path, folder);
  described.set(path, { mtimeMs, size, entry });
  return entry;
}

function scanFolder(dir: string, folder: WadFolder): WadManifestEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const out: WadManifestEntry[] = [];
  for (const name of names.sort()) {
    if (!/\.wad$/i.test(name)) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const entry = describeCached(path, folder, stat.mtimeMs, stat.size);
      if (!entry) continue;
      // The folder is what decides how the file is used; a signature mismatch
      // (e.g. a PWAD dropped into wads/iwad/) still gets listed, just flagged.
      if ((folder === 'iwad') !== (entry.type === 'IWAD')) {
        console.warn(
          `[topdoom] ${path}: ${entry.type} signature but placed in wads/${folder}/ — ` +
            `serving it as ${folder} anyway`,
        );
      }
      out.push(entry);
    } catch {
      // Unreadable or malformed files simply don't show up in the menu.
    }
  }
  return out;
}

function scan(root: string): WadManifestEntry[] {
  return [...scanFolder(join(root, 'iwad'), 'iwad'), ...scanFolder(join(root, 'pwad'), 'pwad')];
}

/**
 * Publishes the contents of public/wads/{iwad,pwad} as JSON so the start menu
 * can offer the WADs already on disk. Served live in dev, baked into the
 * output on build.
 */
export function wadManifest(root = 'public/wads'): Plugin {
  return {
    name: 'topdoom:wad-manifest',

    configureServer(server) {
      // Registered here, so it runs before Vite's static handler would 404.
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/' + MANIFEST_PATH) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(scan(root)));
      });
    },

    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST_PATH, source: JSON.stringify(scan(root)) });
    },
  };
}
