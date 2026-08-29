/**
 * The savegame store's storage layer: the IndexedDB backend behind
 * `game/savegames.ts`, plus the byte codecs (gzip, base64) the save formats are
 * built on. Deliberately typed over `unknown` meta records — validation and the
 * `SaveMeta` shape stay in `savegames.ts`, so this file owns bytes and
 * transactions, nothing about what a save means.
 * docs/savegames.md § Storage.
 */
import { asPromise, idbOpener, txDone } from '../util/idb.ts';

/**
 * How a state's stored bytes are encoded. `1` = gzip-compressed JSON. Versioned
 * separately from `SAVE_VERSION`, which governs the snapshot's *content* — the
 * two evolve independently, and an exported file carries both.
 */
export const STATE_ENCODING = 1;

/**
 * A save's state record: the compressed snapshot, opaque to this layer. (`<ArrayBuffer>`: a plain
 * `Uint8Array` could sit on a `SharedArrayBuffer`, which `Blob` refuses.)
 */
export interface StoredState {
  id: string;
  encoding: number;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * What `savegames.ts` needs from storage — small enough that tests replace it
 * with two Maps (`setSaveBackend`). Meta records are `unknown` here; every read
 * is validated by the caller in the `besttimes.ts` style.
 */
export interface SaveStoreBackend {
  listMeta(): Promise<unknown[]>;
  /** `undefined` when no save has this ID. */
  readMeta(id: string): Promise<unknown>;
  readState(id: string): Promise<StoredState | undefined>;
  /**
   * Writes both records in one transaction — all or nothing, so a quota failure can't leave an
   * orphan meta.
   */
  putSave(meta: unknown, state: StoredState): Promise<void>;
  /** Meta only — a rename must not rewrite the state bytes. */
  putMeta(meta: unknown): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'topdoom';
const DB_VERSION = 1;
const META_STORE = 'saves-meta';
const STATE_STORE = 'saves-state';

const openDb = idbOpener(DB_NAME, DB_VERSION, (db) => {
  if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
  if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE, { keyPath: 'id' });
});

/**
 * The real backend: one database, two object stores keyed by save ID —
 * `saves-meta` holds plain `SaveMeta` objects so listing never touches a
 * snapshot, `saves-state` the compressed bytes. An IndexedDB transaction
 * auto-commits as soon as control returns to the event loop with no request
 * pending, so nothing here may `await` between opening a transaction and
 * issuing its requests — which is why `putSave` takes finished bytes and the
 * compression happens before it is called.
 */
export function idbBackend(): SaveStoreBackend {
  // Transaction creation and its request in one synchronous expression — see
  // the auto-commit rule above.
  const read = async <T>(store: string, request: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    asPromise(request((await openDb()).transaction(store).objectStore(store)));
  return {
    listMeta: () => read(META_STORE, (s) => s.getAll()),
    readMeta: (id) => read<unknown>(META_STORE, (s) => s.get(id)),
    readState: (id) => read<StoredState | undefined>(STATE_STORE, (s) => s.get(id)),
    putSave: async (meta, state) => {
      const tx = (await openDb()).transaction([META_STORE, STATE_STORE], 'readwrite');
      tx.objectStore(META_STORE).put(meta);
      tx.objectStore(STATE_STORE).put(state);
      return txDone(tx);
    },
    putMeta: async (meta) => {
      const tx = (await openDb()).transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put(meta);
      return txDone(tx);
    },
    remove: async (id) => {
      const tx = (await openDb()).transaction([META_STORE, STATE_STORE], 'readwrite');
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(STATE_STORE).delete(id);
      return txDone(tx);
    },
  };
}

/**
 * Gzips a string. Gzip rather than `deflate-raw`: the 18-byte header is noise
 * against a save's size, the magic bytes make a stray stored blob identifiable
 * (and recoverable with any external gunzip), and the trailing CRC makes a
 * corrupted state fail loudly in `decompressText` instead of yielding garbage
 * JSON. `CompressionStream`/`Blob`/`Response` are global in every supported
 * browser and in Node, so the round-trip runs unchanged in tests.
 */
export async function compressText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decompressText(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * Base64 for the export file, where the compressed state has to travel inside
 * JSON. Chunked because `String.fromCharCode(...bytes)` spreads the whole array
 * into one call, and a large save would blow the engine's argument-count limit.
 * (`Uint8Array.prototype.toBase64` does this natively but is too new to rely
 * on.)
 */
export function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Throws on text that isn't base64 — an import feeds user files through here, and the caller turns
 * the throw into its refusal.
 */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
