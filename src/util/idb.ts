/**
 * The IndexedDB request plumbing shared by the three things this game stores in a browser database —
 * savegames (`game/savestore.ts`), the remembered WAD folder (`wad/library/store.ts`) and the
 * per-level best times (`game/besttimes.ts`). Callbacks as promises, and one lazily-opened handle
 * per database; what is *in* any of them, and what it means, stays with its own module. See
 * docs/savegames.md § Storage, docs/wad.md § The player's own library and docs/hud.md § The store.
 */

/**
 * One request's result. Note that an IndexedDB transaction auto-commits as soon as control returns
 * to the event loop with no request pending, so a caller must not `await` between opening a
 * transaction and issuing its requests — build both in one synchronous expression.
 */
export const asPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('browser storage read failed'));
  });

/** Resolves on commit; an abort (a quota refusal, mostly) rejects with the transaction's own `DOMException`, name intact. */
export const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('browser storage write failed'));
  });

/**
 * A database's one handle, opened lazily on the first call and reused after — a failed open is
 * un-cached, so the next attempt retries rather than the tab being stuck with the failure for as
 * long as it lives, and a browser with no `indexedDB` at all rejects without ever caching. Each
 * caller keeps its own opener: the databases are deliberately separate, so an upgrade that fails
 * for one cannot take the others down with it.
 */
export function idbOpener(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): () => Promise<IDBDatabase> {
  let dbPromise: Promise<IDBDatabase> | null = null;
  return () => {
    // Ahead of the cache, not inside the promise: a `new Promise` executor that throws rejects a
    // promise `??=` has already stored, which is the one failed open the retry contract above would
    // otherwise miss — `onerror` is what un-caches, and it never fires when there is no `open` to
    // fail. Every caller then reads the rejection as "no database", which is what it is.
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('browser storage is unavailable'));
    }
    dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error('browser storage is unavailable'));
      };
    });
    return dbPromise;
  };
}
