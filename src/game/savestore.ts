/**
 * The savegame store's storage layer: the IndexedDB backend behind `game/savegames.ts` (and, over
 * its own database, `game/replay.ts`), the byte codecs (gzip, base64) the save formats are built
 * on, and the store rules both formats share — a fresh ID, the missing-row refusal, the quota
 * refusal. Deliberately typed over `unknown` meta records — validation and the `SaveMeta` shape
 * stay in `savegames.ts`, so this file owns bytes, transactions and IDs, nothing about what a save
 * means. docs/savegames.md § Storage.
 */
import { asPromise, idbOpener, txDone } from '../util/idb.ts';

/**
 * How a record's stored bytes are encoded. `1` = gzip-compressed text: a save's state one JSON
 * document ({@link compressText}), a replay's record one JSON document a line
 * ({@link compressLines}). Versioned separately from `SAVE_VERSION`, which governs the snapshot's
 * *content* — the two evolve independently, and an exported file carries both.
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

const DB_VERSION = 1;

/**
 * The real backend: one database, two object stores keyed by record ID — `<prefix>-meta` holds
 * plain meta objects so listing never touches a snapshot, `<prefix>-state` the compressed bytes.
 * Saves and replays each get their own database (docs/replays.md § Storage). An IndexedDB
 * transaction auto-commits as soon as control returns to the event loop with no request pending, so
 * nothing here may `await` between opening a transaction and issuing its requests — which is why
 * {@link SaveStoreBackend.putSave} takes finished bytes.
 */
export function idbBackend(names: { database: string; prefix: string }): SaveStoreBackend {
  const META_STORE = `${names.prefix}-meta`;
  const STATE_STORE = `${names.prefix}-state`;
  const openDb = idbOpener(names.database, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE, { keyPath: 'id' });
  });
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

/** The stored meta for `id`, or a thrown refusal — the opening of every read-modify-write. */
export async function readStoredMeta(backend: SaveStoreBackend, noun: string, id: string): Promise<unknown> {
  const raw = await backend.readMeta(id);
  if (raw === undefined) throw new Error(`that ${noun} no longer exists`);
  return raw;
}

/**
 * The one write of a whole record: both halves in the backend's single transaction, with a quota
 * refusal — the only failure a player can act on — translated to a readable message. Mapped here
 * rather than in the backend so the tests' in-memory backend exercises the same translation.
 */
export async function putStored(backend: SaveStoreBackend, noun: string, meta: unknown, state: StoredState): Promise<void> {
  try {
    await backend.putSave(meta, state);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      throw new Error(`not enough browser storage for this ${noun} — delete an older ${noun} and try again`);
    }
    throw err;
  }
}

/**
 * Session-scoped tiebreaker for records landing in the same millisecond; uniqueness is checked
 * against the stored IDs anyway.
 */
let idCounter = 0;

/**
 * Deliberately entropy-free — the engine's one randomness source is the DOOM table
 * (docs/random.md), and a record ID needs uniqueness, not randomness.
 */
export async function freshId(backend: SaveStoreBackend): Promise<string> {
  const existing = new Set(
    (await backend.listMeta()).map((raw) => (typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined)),
  );
  let id: string;
  do {
    id = Date.now().toString(36) + '-' + (idCounter++).toString(36);
  } while (existing.has(id));
  return id;
}

/**
 * Gzips a string. Gzip rather than `deflate-raw`: the 18-byte header is noise
 * against a save's size, the magic bytes make a stray stored blob identifiable
 * (and recoverable with any external gunzip), and the trailing CRC makes a
 * corrupted state fail loudly in {@link decompressText} instead of yielding garbage
 * JSON. `CompressionStream`/`Blob`/`Response` are global in every supported
 * browser and in Node, so the round-trip runs unchanged in tests.
 */
export function compressText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return gzip(new Blob([text]).stream());
}

export function decompressText(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return new Response(gunzip(bytes)).text();
}

/**
 * Gzips `lines` as one newline-separated stream, pulling each line only as the compressor wants
 * it — so no string larger than one line is ever built, where joining them first would hit the
 * engine's string-length limit on a record of hours. A JSON document can be a line because
 * `JSON.stringify` escapes every newline it writes. docs/replays.md § Storage.
 */
export async function compressLines(lines: Iterable<string>): Promise<Uint8Array<ArrayBuffer>> {
  const iterator = lines[Symbol.iterator]();
  const text = new ReadableStream<string>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(`${next.value}\n`);
    },
  });
  return gzip(text.pipeThrough(new TextEncoderStream()));
}

/**
 * {@link compressLines} undone, a line at a time. Throws where the bytes are not gzip; bytes that
 * hold no newline at all come back as one line.
 */
export async function* decompressLines(bytes: Uint8Array<ArrayBuffer>): AsyncGenerator<string> {
  const reader = gunzip(bytes).pipeThrough(new TextDecoderStream()).getReader();
  try {
    // A line's pieces are kept apart until its newline arrives: appending chunks to one string and
    // searching it would flatten the whole line again for every chunk.
    let pieces: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let end = value.indexOf('\n'); end >= 0; end = value.indexOf('\n', start)) {
        pieces.push(value.slice(start, end));
        yield pieces.join('');
        pieces = [];
        start = end + 1;
      }
      if (start < value.length) pieces.push(value.slice(start));
    }
    if (pieces.length > 0) yield pieces.join('');
  } finally {
    // A reader that stops early — a record that frames wrong — leaves nothing decompressing.
    await reader.cancel();
  }
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

/** `stream` gzipped and collected — both compressors' tail. */
async function gzip(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

/** Stored bytes as a stream of what they gzipped — both decompressors' head. */
function gunzip(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
}
