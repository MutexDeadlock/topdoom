/**
 * An in-memory `Storage` and the installing of one over the global. Node has no `localStorage`
 * unless webstorage is enabled, and `util/storage.ts` reaches the real one through a guarded
 * property access — so a stand-in here is what lets a test seed a blob, inspect what was written,
 * or stand for a browser with no storage at all. See docs/menu.md § Persisted settings.
 */

/**
 * A `Storage` over a `Map`, only as much of the interface as `util/storage.ts` calls. The backing
 * map comes back on `.map`, so a test can seed a deliberately broken blob or read what a write
 * left.
 */
export function fakeStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

/** Puts `value` in place of the global for the rest of the test; `null` stands for no storage. */
export function installStorage(value: Storage | null): void {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}
