/**
 * The replays the engine itself ships: the folder they are served from, the manifest listing them
 * without their records, and the id one served file is addressed by. The only place this layer
 * fetches — decoding, listing and the store's own rows are `game/replay.ts`'s.
 * docs/replays.md § Stock replays.
 */

/**
 * Where stock replays sit, without slashes — `public/<STOCK_DIR>/` on disk, `/<STOCK_DIR>/…` as a
 * URL. Declared here, beside the code that fetches through it, and imported by
 * `plugins/replay-manifest.ts` rather than restated there: the two must name the same folder or the
 * menu lists files it cannot then play. The WAD manifest's `WAD_DIR` rule, one folder over
 * (docs/wad.md § The `public/game/` manifest).
 */
export const STOCK_DIR = 'game/replay';

/** The manifest's path under that folder — also the name the plugin emits it as. */
export const STOCK_MANIFEST_PATH = `${STOCK_DIR}/index.json`;

/**
 * One served replay, as the plugin writes it: the download file's own meta fields with its `data`
 * left behind. `meta` is raw JSON and stays unvalidated here; `asReplayMeta`/`metaRefusal`
 * (`game/replay.ts`) are what a stored row's meta goes through too, so a damaged stock file lists
 * and says why rather than vanishing.
 */
export interface StockReplayEntry {
  file: string;
  meta: unknown;
}

/**
 * The id a served file is listed, played and downloaded under. Stock and stored replays share one
 * id space, so the prefix is what routes a read to the folder instead of to the store, and what the
 * menu asks to mark a row read-only.
 */
export function stockReplayId(file: string): string {
  return `${STOCK_PREFIX}${file}`;
}

/** Whether an id names a served replay rather than a stored one. */
export function isStockReplay(id: string): boolean {
  return id.startsWith(STOCK_PREFIX);
}

/** The served replays, listing metas alone. Empty where the manifest is missing or unreadable. */
export async function fetchStockManifest(): Promise<StockReplayEntry[]> {
  try {
    const res = await fetch(`/${STOCK_MANIFEST_PATH}`);
    if (!res.ok) return [];
    const entries: unknown = await res.json();
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is StockReplayEntry => typeof (entry as StockReplayEntry)?.file === 'string');
  } catch {
    return [];
  }
}

/**
 * One served replay's download file, as text — the same JSON a downloaded replay is, which is what
 * lets the read and the download share it: neither re-encodes anything.
 */
export async function fetchStockReplay(id: string): Promise<string> {
  const res = await fetch(`/${STOCK_DIR}/${encodeURIComponent(id.slice(STOCK_PREFIX.length))}`);
  if (!res.ok) throw new Error(`this replay could not be loaded from the server (HTTP ${res.status})`);
  return res.text();
}

/** Not a legal `freshId`, so no stored row can ever answer to one of these. */
const STOCK_PREFIX = 'stock:';
