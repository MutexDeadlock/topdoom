import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The settings blob: one `localStorage` key, one JSON object, every persisted setting a field in
 * it. What is pinned here is what the call sites depend on — a wrong-typed or missing field reads
 * as the caller's default, a write keeps the fields it didn't touch, and a browser with no storage
 * at all degrades to defaults rather than throwing on the boot path.
 * See docs/menu.md § Persisted settings.
 *
 * The fake is installed before the dynamic import below, so nothing here ever reaches Node's own
 * `localStorage` and no test is left reading what an earlier one wrote.
 */

/** A `Storage` over a `Map`, only as much of the interface as `util/storage.ts` calls. */
function fakeStorage(): Storage & { map: Map<string, string> } {
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
function install(value: Storage | null): void {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}

let store = fakeStorage();
install(store);

const { readStorage, readStorageObject, writeStorage } = await import('../../src/util/storage.ts');

const SETTINGS_KEY = 'topdoom.settings';
const blob = () => JSON.parse(store.map.get(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;

afterEach(() => {
  store = fakeStorage();
  install(store);
});

describe('Storage · settings blob', () => {
  test('reads back what it wrote, for each type a setting can be', () => {
    writeStorage('bloom', true);
    writeStorage('sfxVolume', 0.4);
    writeStorage('cameraMode', 'manual');
    assert.equal(readStorage('bloom', false), true);
    assert.equal(readStorage('sfxVolume', 0.8), 0.4);
    assert.equal(readStorage('cameraMode', 'auto'), 'manual');
  });

  test('every setting lands in one key', () => {
    writeStorage('bloom', true);
    writeStorage('autorun', false);
    assert.deepEqual([...store.map.keys()], [SETTINGS_KEY]);
    assert.deepEqual(blob(), { bloom: true, autorun: false });
  });

  test('an unset field is the fallback, either way round', () => {
    assert.equal(readStorage('autorun', true), true);
    assert.equal(readStorage('pistolStart', false), false);
    assert.equal(readStorage('fpsCap', 60), 60);
  });

  test('a stored false or 0 is a value, not an absence', () => {
    writeStorage('autorun', false);
    writeStorage('masterVolume', 0);
    assert.equal(readStorage('autorun', true), false);
    assert.equal(readStorage('masterVolume', 0.8), 0);
  });

  test('a field of the wrong type is the fallback', () => {
    writeStorage('bloom', 'yes');
    writeStorage('fpsCap', '120');
    assert.equal(readStorage('bloom', false), false);
    assert.equal(readStorage('fpsCap', 0), 0);
  });

  test('a number JSON parsed to infinity is the fallback', () => {
    store.map.set(SETTINGS_KEY, '{"sfxVolume":1e999}');
    assert.equal(readStorage('sfxVolume', 0.8), 0.8);
  });

  test('a write keeps the fields it did not touch', () => {
    writeStorage('bloom', true);
    writeStorage('skyTint', false);
    writeStorage('bloom', false);
    assert.deepEqual(blob(), { bloom: false, skyTint: false });
  });

  test('a write merges over what another tab stored in the meantime', () => {
    writeStorage('bloom', true);
    store.map.set(SETTINGS_KEY, JSON.stringify({ ...blob(), autorun: false }));
    writeStorage('bloom', false);
    assert.deepEqual(blob(), { bloom: false, autorun: false });
  });

  test('a blob that is not an object of settings reads as defaults, and a write repairs it', () => {
    for (const raw of ['', 'not json', '[1,2]', 'null', '"string"']) {
      store.map.set(SETTINGS_KEY, raw);
      assert.equal(readStorage('autorun', true), true, raw);
      assert.equal(readStorageObject('selection'), null, raw);
      writeStorage('autorun', false);
      assert.deepEqual(blob(), { autorun: false }, raw);
    }
  });

  test('an object field reads back whole, and anything else as null', () => {
    writeStorage('selection', { iwad: 'DOOM.WAD', pwads: ['SCYTHE.WAD'] });
    assert.deepEqual(readStorageObject('selection'), { iwad: 'DOOM.WAD', pwads: ['SCYTHE.WAD'] });
    assert.equal(readStorageObject('missing'), null);
    writeStorage('bloom', true);
    assert.equal(readStorageObject('bloom'), null);
    writeStorage('list', ['a']);
    assert.equal(readStorageObject('list'), null);
  });

  test('no storage at all reads as defaults and swallows the write', () => {
    install(null);
    writeStorage('bloom', true);
    assert.equal(readStorage('bloom', false), false);
    assert.equal(readStorageObject('selection'), null);
  });

  test('storage that throws on access reads as defaults and swallows the write', () => {
    // Site data blocked: the property access itself throws, so a `?.` guard would not have held.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('access denied', 'SecurityError');
      },
    });
    writeStorage('bloom', true);
    assert.equal(readStorage('bloom', false), false);
  });

  test('storage that refuses a write keeps the setting readable for the session', () => {
    const full = fakeStorage();
    full.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    };
    install(full);
    assert.doesNotThrow(() => writeStorage('bloom', true));
    assert.equal(readStorage('bloom', false), false);
  });
});
