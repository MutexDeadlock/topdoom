import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { jsonManifest, statMemo } from './manifest.ts';
import { isDownloadFileName, isRecord } from '../src/game/savegames.ts';
import { STOCK_DIR, STOCK_MANIFEST_PATH, type StockReplayEntry } from '../src/game/replay/stock.ts';

/**
 * One file's manifest entry: the download file with its `data` left behind, for the reason
 * docs/replays.md § Stock replays gives.
 */
export function manifestEntry(path: string, file: string): StockReplayEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return null;
  // `dataEncoding` goes with it: it describes the record, and the fetched file carries both again.
  const { data: _data, dataEncoding: _encoding, ...meta } = parsed;
  return { file, meta };
}

/**
 * Publishes the contents of public/game/replay/ as JSON so the Replays tab can list the recordings
 * the engine ships — `wad-manifest.ts`'s shape for the folder next door.
 */
export function replayManifest(root = join('public', STOCK_DIR)): Plugin {
  return jsonManifest({ name: 'topdoom:replay-manifest', path: STOCK_MANIFEST_PATH, scan: () => scan(root) });
}

/** `manifestEntry` memoized per file: each entry parses a whole record's worth of JSON. */
const describeCached = statMemo<StockReplayEntry | null>();

/** The folder, flat: what a player dropped in it, in name order. */
function scan(root: string): StockReplayEntry[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }

  const out: StockReplayEntry[] = [];
  for (const name of names.sort()) {
    if (!isDownloadFileName(name, 'replay')) continue;
    const path = join(root, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const entry = describeCached(path, stat, () => manifestEntry(path, name));
      // Not JSON at all: it can't be listed, so say so where whoever dropped it will look.
      if (!entry) {
        console.warn(`[topdoom] ${path}: not a readable TopDoom replay — leaving it out of the menu`);
        continue;
      }
      out.push(entry);
    } catch {
      // Unreadable files simply don't show up in the menu.
    }
  }
  return out;
}
