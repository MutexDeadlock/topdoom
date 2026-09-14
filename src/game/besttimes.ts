/**
 * Per-level best completion times, persisted across sessions and shown on the end-of-level popup —
 * see docs/hud.md § Best times. Owned here rather than by `ui/hud/intermission.ts` for the same
 * reason every other persisted value lives with the module whose behavior it changes
 * (docs/menu.md § Persisted settings): the popup only renders what this decides. The records live
 * in their own IndexedDB database behind a synchronous in-memory cache — docs/hud.md § The store.
 */
import { asPromise, idbOpener, txDone } from '../util/idb.ts';
import { webStorage } from '../util/storage.ts';
import type { Skill } from './skill.ts';

/**
 * The `localStorage` blob records lived in before the IndexedDB store; read once on load, then
 * dropped — docs/hud.md § Migration off localStorage.
 */
const LEGACY_STORAGE_KEY = 'topdoom.bestTimes';

/**
 * Upper bound on stored records, oldest evicted first. A record is ~110 bytes, so this is a bound
 * against a table that only ever grows, not a real constraint on how many levels can be tracked.
 * Exported for the test that pins the eviction, so the two can't drift apart.
 */
export const MAX_RECORDS = 400;

/**
 * One level's best time. {@link BestTime.wad}/{@link BestTime.map}/{@link BestTime.skill} are
 * duplicated from the key purely so the stored record reads.
 */
export interface BestTime {
  seconds: number;
  wad: string;
  map: string;
  skill: number;
  /** ISO date the record was set; also the eviction order. */
  at: string;
}

/** The stored row: one record per level, keyed by {@link bestTimeKey} — the store's `keyPath`. */
export interface StoredBestTime extends BestTime {
  key: string;
}

/** What the popup needs after a completion: the time to beat, and whether this run beat it. */
export interface BestTimeResult {
  /** The best time before this run, or null if the level had never been completed. */
  previous: number | null;
  isNewBest: boolean;
}

/**
 * What the record store needs from storage — small enough that tests replace it with one Map
 * ({@link setBestTimeBackend}). Rows are `unknown` on read; validation stays with the caller, in
 * the style every other store here reads in.
 */
export interface BestTimeBackend {
  readAll(): Promise<unknown[]>;
  /**
   * Upserts and deletes in one transaction, so an eviction can't survive the write that caused it.
   */
  write(puts: readonly StoredBestTime[], deletes: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

/**
 * The record key. The WAD part is the content ID of the file that actually *provides* the map
 * (`Wad.find(map)!.source`), not of the whole loaded set — see docs/hud.md § Best times for why
 * the distinction matters.
 */
export function bestTimeKey(wadId: string, map: string, skill: Skill): string {
  return `${wadId}|${map.toUpperCase()}|${skill}`;
}

/**
 * The table as the session sees it, so the two readers below can stay synchronous for the frame
 * that ends a level. Filled by {@link loadBestTimes}; empty before it, which is why boot awaits
 * that — docs/hud.md § The store.
 */
const cache = new Map<string, StoredBestTime>();

/** The stored best time in seconds, or null if there is none. */
export function readBestTime(key: string): number | null {
  return cache.get(key)?.seconds ?? null;
}

/**
 * Files a completion, writing only when it improves on what was stored. Returns the time that was
 * there before, so the caller can show both the old record and the fact that it fell. The database
 * write is fire-and-forget: the popup must not wait on storage, and a refused write costs the
 * record, not the run.
 */
export function recordBestTime(key: string, seconds: number, meta: Omit<BestTime, 'seconds' | 'at'>): BestTimeResult {
  const previous = cache.get(key)?.seconds ?? null;
  const isNewBest = previous === null || seconds < previous;
  if (!isNewBest) return { previous, isNewBest };

  const row: StoredBestTime = { key, seconds, ...meta, at: new Date().toISOString() };
  cache.set(key, row);
  // `evict` runs here, not inside the closure: the write carries the list its own overflow
  // produced, rather than whatever the cache has drifted to by the time the queue drains.
  const dropped = evict();
  queue(() => store().write([row], dropped));
  return { previous, isNewBest };
}

/** Drops every stored record — no UI calls it; it gives the store a way back to empty. */
export function clearBestTimes(): void {
  cache.clear();
  queue(() => store().clear());
}

/**
 * Fills the cache from the database and folds in whatever the old `localStorage` blob still holds
 * (docs/hud.md § Migration off localStorage). Never rejects — a browser that refuses IndexedDB
 * plays on with no records rather than failing to boot. Awaited once, on the boot path.
 */
export function loadBestTimes(): Promise<void> {
  return (loading ??= load());
}

/**
 * Test seam: replaces the backend with an in-memory one and resets everything the session had built
 * on top of the old one, so a test can replay a boot. Every module-level mutable below the cache
 * belongs here — a reset that forgets one leaks the previous test into the next.
 */
export function setBestTimeBackend(replacement: BestTimeBackend): void {
  backend = replacement;
  cache.clear();
  loading = null;
  pending = Promise.resolve();
}

let loading: Promise<void> | null = null;

async function load(): Promise<void> {
  // A read that *failed* is not an empty database, and only the first may let the migration below
  // drop the blob it just folded in — the times would have nowhere else to be.
  let usable = true;
  try {
    for (const row of await store().readAll()) {
      const entry = asStoredBestTime(row);
      if (entry) cache.set(entry.key, entry);
    }
  } catch {
    usable = false;
  }

  const migrated = foldLegacyIn();
  if (!migrated || !usable) return;
  try {
    await store().write(migrated, evict());
    webStorage()?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Left in place, so the next visit tries again.
  }
}

/**
 * Folds the `localStorage` table into the cache and reports the rows the database is still missing,
 * or null when there is no blob to migrate at all. An entry only wins where the cache has nothing
 * faster for its key. docs/hud.md § Migration off localStorage.
 */
function foldLegacyIn(): StoredBestTime[] | null {
  const legacy = readLegacy();
  if (!legacy) return null;

  const migrated: StoredBestTime[] = [];
  for (const [key, entry] of Object.entries(legacy)) {
    const have = cache.get(key);
    if (have && have.seconds <= entry.seconds) continue;
    const row = { key, ...entry };
    cache.set(key, row);
    migrated.push(row);
  }
  return migrated;
}

/**
 * The old blob, validated per entry, or null when there is none to migrate. A single malformed
 * entry is dropped rather than the blob: losing one level's record to a bad hand-edit shouldn't
 * cost every other level's.
 */
function readLegacy(): Record<string, BestTime> | null {
  const raw = webStorage()?.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const out: Record<string, BestTime> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = asBestTime(value);
    if (entry) out[key] = entry;
  }
  return out;
}

/** A stored row read back, or null if it isn't one. Same fail-soft stance as {@link readLegacy}. */
function asStoredBestTime(value: unknown): StoredBestTime | null {
  const entry = asBestTime(value);
  if (!entry) return null;
  const key = (value as { key?: unknown }).key;
  return typeof key === 'string' && key !== '' ? { key, ...entry } : null;
}

function asBestTime(value: unknown): BestTime | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<BestTime>;
  // A negative or non-finite time would win every comparison it took part in, so it fails the
  // check rather than being clamped.
  if (typeof v.seconds !== 'number' || !Number.isFinite(v.seconds) || v.seconds < 0) return null;
  return {
    seconds: v.seconds,
    wad: typeof v.wad === 'string' ? v.wad : '',
    map: typeof v.map === 'string' ? v.map : '',
    skill: typeof v.skill === 'number' ? v.skill : 0,
    at: typeof v.at === 'string' ? v.at : '',
  };
}

/**
 * Trims the cache back to {@link MAX_RECORDS} and reports the keys that went, for the same
 * transaction as the write that overflowed it. Oldest first: an entry with no usable date sorts
 * oldest — it predates that field or was hand-edited, and either way is the least worth keeping.
 */
function evict(): string[] {
  if (cache.size <= MAX_RECORDS) return [];
  const rows = [...cache.values()].sort((a, b) => a.at.localeCompare(b.at));
  const dropped = rows.slice(0, cache.size - MAX_RECORDS).map((row) => row.key);
  for (const key of dropped) cache.delete(key);
  return dropped;
}

/**
 * One write at a time, in call order, with a refused one swallowed. Each `write` awaits the
 * database handle before it opens its transaction, so two overlapping calls could otherwise commit
 * in the other order and leave the stored row disagreeing with the cache.
 */
function queue(work: () => Promise<void>): void {
  pending = pending.then(work).catch(() => {});
}

let pending: Promise<void> = Promise.resolve();

/**
 * Its own database, deliberately not a `DB_VERSION` bump on the savegames one —
 * docs/hud.md § The store.
 */
const DB_NAME = 'topdoom-besttimes';
const DB_VERSION = 1;
const TIMES_STORE = 'times';

const openDb = idbOpener(DB_NAME, DB_VERSION, (db) => {
  if (!db.objectStoreNames.contains(TIMES_STORE)) db.createObjectStore(TIMES_STORE, { keyPath: 'key' });
});

/**
 * The IndexedDB backend, created on first touch so importing this module in Node never reaches for
 * `indexedDB`.
 */
let backend: BestTimeBackend | null = null;
const store = (): BestTimeBackend => (backend ??= idbBackend());

/**
 * The real backend: one object store, one record per level keyed by {@link bestTimeKey}
 * (docs/hud.md § The store). An IndexedDB transaction auto-commits as soon as control returns to
 * the event loop with no request pending, so nothing here may `await` between opening a transaction
 * and issuing its requests — `game/savestore.ts`'s rule, and its shape. A browser with no
 * `indexedDB` rejects out of {@link openDb}, which {@link load} reads as "no database" rather than
 * as an empty one.
 */
function idbBackend(): BestTimeBackend {
  return {
    readAll: async () => asPromise((await openDb()).transaction(TIMES_STORE).objectStore(TIMES_STORE).getAll()),
    write: async (puts, deletes) => {
      if (puts.length === 0 && deletes.length === 0) return;
      const tx = (await openDb()).transaction(TIMES_STORE, 'readwrite');
      const times = tx.objectStore(TIMES_STORE);
      for (const row of puts) times.put(row);
      for (const key of deletes) times.delete(key);
      return txDone(tx);
    },
    clear: async () => {
      const tx = (await openDb()).transaction(TIMES_STORE, 'readwrite');
      tx.objectStore(TIMES_STORE).clear();
      return txDone(tx);
    },
  };
}
