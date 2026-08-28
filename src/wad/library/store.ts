/**
 * Where the player's own WAD folder is remembered between visits: the directory handle itself, and
 * the scan memo that lets the folder list without re-reading a byte of it. IndexedDB rather than
 * `localStorage` because a `FileSystemDirectoryHandle` is structured-cloneable but not
 * JSON-serializable — `JSON.stringify(handle)` yields `{}`.
 * See docs/wad.md § The player's own library.
 */
import { asPromise, idbOpener, txDone } from '../../util/idb.ts';
import { asWadSupport, type WadSupport } from '../support.ts';
import type { WadType } from '../wad.ts';

/**
 * Its own database, deliberately not a `DB_VERSION` bump on the one holding savegames
 * (`game/savestore.ts`): an upgrade that fails here must not be able to take saves down with it,
 * and the two have nothing to say to each other.
 */
const DB_NAME = 'topdoom-wadlibrary';
const DB_VERSION = 1;
const ROOT_STORE = 'root';
const DESCRIPTOR_STORE = 'descriptors';
/** The `root` store holds exactly one record; this is its key. */
const ROOT_KEY = 'root';

/**
 * One scanned file, keyed by its path relative to the library root. Everything `describeWad`
 * answered, plus what makes the memo valid — a file whose size or mtime moved is re-described.
 */
export interface LibraryDescriptor {
  /** Relative to the library root, `/`-separated. Also the record's key. */
  path: string;
  size: number;
  lastModified: number;
  type: WadType;
  maps: string[];
  lumpCount: number;
  dehacked: boolean;
  levelNames: Record<string, string>;
  /** The support verdict. Optional only for a memo row written before the field existed, which
      `describeAll` re-reads rather than listing unknown — docs/wad.md § Will it run? */
  support?: WadSupport;
  /**
   * `hashBytes` content id, present once something has needed the file's identity —
   * `library.ts: ensureWadId`.
   */
  id?: string;
}

const openDb = idbOpener(DB_NAME, DB_VERSION, (db) => {
  if (!db.objectStoreNames.contains(ROOT_STORE)) db.createObjectStore(ROOT_STORE);
  if (!db.objectStoreNames.contains(DESCRIPTOR_STORE)) {
    db.createObjectStore(DESCRIPTOR_STORE, { keyPath: 'path' });
  }
});

/**
 * Every call here is best-effort: the library is a convenience, and a browser with IndexedDB
 * disabled (or a private window that refuses it) must fall back to "no remembered folder" rather
 * than take `Menu.init` down on the boot path.
 */
async function attempt<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    if (typeof indexedDB === 'undefined') return fallback;
    return await work();
  } catch {
    return fallback;
  }
}

/**
 * The remembered folder, or null when there is none — including on browsers with no handle to
 * store.
 */
export function readRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  return attempt(async () => {
    const db = await openDb();
    const stored = await asPromise(db.transaction(ROOT_STORE).objectStore(ROOT_STORE).get(ROOT_KEY));
    // Structured clone gives back a live handle; anything else is a record from a browser that no
    // longer supports them, and is no more use than nothing.
    return stored instanceof Object && 'getDirectoryHandle' in stored
      ? (stored as FileSystemDirectoryHandle)
      : null;
  }, null);
}

export function writeRootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  return attempt(async () => {
    const tx = (await openDb()).transaction(ROOT_STORE, 'readwrite');
    tx.objectStore(ROOT_STORE).put(handle, ROOT_KEY);
    return txDone(tx);
  }, undefined);
}

/**
 * Forgets the folder *and* its scan memo — picking a different root must not inherit the old one's
 * rows.
 */
export function clearRoot(): Promise<void> {
  return attempt(async () => {
    const tx = (await openDb()).transaction([ROOT_STORE, DESCRIPTOR_STORE], 'readwrite');
    tx.objectStore(ROOT_STORE).delete(ROOT_KEY);
    tx.objectStore(DESCRIPTOR_STORE).clear();
    return txDone(tx);
  }, undefined);
}

/** The whole scan memo, keyed by relative path. Empty when there is none or it can't be read. */
export function readDescriptors(): Promise<Map<string, LibraryDescriptor>> {
  return attempt(async () => {
    const db = await openDb();
    const rows = await asPromise(db.transaction(DESCRIPTOR_STORE).objectStore(DESCRIPTOR_STORE).getAll());
    const out = new Map<string, LibraryDescriptor>();
    for (const row of rows as unknown[]) {
      const descriptor = asDescriptor(row);
      if (descriptor) out.set(descriptor.path, descriptor);
    }
    return out;
  }, new Map<string, LibraryDescriptor>());
}

/** Writes the scan's result, dropping any row for a path the folder no longer has. */
export function writeDescriptors(descriptors: readonly LibraryDescriptor[]): Promise<void> {
  return attempt(async () => {
    const tx = (await openDb()).transaction(DESCRIPTOR_STORE, 'readwrite');
    const store = tx.objectStore(DESCRIPTOR_STORE);
    store.clear();
    for (const descriptor of descriptors) store.put(descriptor);
    return txDone(tx);
  }, undefined);
}

/**
 * Re-writes one row — how a content id reaches the memo, so a file is hashed once ever.
 *
 * Takes the whole finished record rather than reading the stored one and patching it: an IndexedDB
 * transaction auto-commits as soon as control returns to the event loop with no request pending, so
 * nothing may `await` between opening a transaction and issuing its requests. Same rule, and same
 * shape, as `game/savestore.ts`'s `putSave`.
 */
export function writeDescriptor(descriptor: LibraryDescriptor): Promise<void> {
  return attempt(async () => {
    const tx = (await openDb()).transaction(DESCRIPTOR_STORE, 'readwrite');
    tx.objectStore(DESCRIPTOR_STORE).put(descriptor);
    return txDone(tx);
  }, undefined);
}

/**
 * Validated on read with explicit defaults, the `besttimes.ts` shape: a half-written row degrades
 * rather than throws.
 */
function asDescriptor(value: unknown): LibraryDescriptor | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== 'string' || v.path === '') return null;
  if (v.type !== 'IWAD' && v.type !== 'PWAD') return null;
  const support = asWadSupport(v.support);
  return {
    path: v.path,
    size: typeof v.size === 'number' ? v.size : 0,
    lastModified: typeof v.lastModified === 'number' ? v.lastModified : 0,
    type: v.type,
    maps: Array.isArray(v.maps) ? v.maps.filter((m): m is string => typeof m === 'string') : [],
    lumpCount: typeof v.lumpCount === 'number' ? v.lumpCount : 0,
    dehacked: v.dehacked === true,
    levelNames: isTitleMap(v.levelNames) ? v.levelNames : {},
    ...(support ? { support } : {}),
    ...(typeof v.id === 'string' && v.id ? { id: v.id } : {}),
  };
}

function isTitleMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((title) => typeof title === 'string');
}
