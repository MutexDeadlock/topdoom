import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { parseMapInfoNames } from '../src/wad/mapinfo.ts';

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
  /** Total lump count, shown for map-less add-ons so they don't look empty. */
  lumpCount: number;
  /**
   * Level titles this file's own MAPINFO defines, so the menu can name levels without downloading
   * it — the same reason `maps` is here. Absent when the file has no MAPINFO, which is most of them.
   */
  levelNames?: Record<string, string>;
}

/** The MAPINFO flavours `parseMapInfoNames` reads, and the order one file's own lumps win in. */
const MAPINFO_LUMPS = ['UMAPINFO', 'ZMAPINFO', 'MAPINFO'];

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
  const mapInfoLumps = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < numLumps; i++) {
    const at = dirOffset + i * 16;
    const name = buf.toString('ascii', at + 8, at + 16).replace(/\0.*$/, '').toUpperCase();
    if (/^(E\dM\d|MAP\d\d)$/.test(name)) maps.push(name);
    else if (MAPINFO_LUMPS.includes(name)) {
      mapInfoLumps.set(name, { offset: buf.readInt32LE(at), size: buf.readInt32LE(at + 4) });
    }
  }

  // `ZMAPINFO` suppresses this file's `MAPINFO`, the same rule wad/mapinfo.ts applies to the
  // merged set; the rest are read in the order above, later winning.
  const levelNames: Record<string, string> = {};
  for (const lump of MAPINFO_LUMPS) {
    if (lump === 'MAPINFO' && mapInfoLumps.has('ZMAPINFO')) continue;
    const at = mapInfoLumps.get(lump);
    if (!at || at.offset < 0 || at.offset + at.size > buf.length) continue;
    for (const [map, title] of parseMapInfoNames(buf.toString('latin1', at.offset, at.offset + at.size))) {
      levelNames[map] = title;
    }
  }

  return {
    file: path.split('/').pop()!,
    folder,
    size: buf.length,
    type: ident,
    maps,
    lumpCount: numLumps,
    ...(Object.keys(levelNames).length > 0 ? { levelNames } : {}),
  };
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
      if (!statSync(path).isFile()) continue;
      const entry = describeWad(path, folder);
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
