import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorage, installStorage } from '../fixtures/storage.ts';

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

let store = fakeStorage();
installStorage(store);

const { flushStorage, readStorage, readStorageObject, writeStorage, writeStorageSoon } =
  await import('../../src/util/storage.ts');

const SETTINGS_KEY = 'topdoom.settings';
const blob = () => JSON.parse(store.map.get(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;

afterEach(() => {
  // Before the swap, so a field left pending drains into the outgoing store and never surfaces in
  // the next test's.
  flushStorage();
  store = fakeStorage();
  installStorage(store);
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
    installStorage(null);
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
    installStorage(full);
    assert.doesNotThrow(() => writeStorage('bloom', true));
    assert.equal(readStorage('bloom', false), false);
  });
});

/**
 * The coalesced write a continuous control uses. What matters is that a drag costs one write, that
 * nothing reads stale in the meantime, and that the value is not lost if the page goes away first.
 */
describe('Storage · coalesced writes', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  test('a burst on one field stores once, at the last value', () => {
    for (let i = 0; i <= 10; i++) writeStorageSoon('sfxVolume', i / 10);
    assert.deepEqual([...store.map.keys()], [], 'nothing stored while the drag is still going');
    // A getter re-read mid-drag sees what was written, not what is still in the store.
    assert.equal(readStorage('sfxVolume', -1), 1);
    mock.timers.tick(250);
    assert.equal(blob().sfxVolume, 1);
  });

  test('fields pending together land in one write, over what is already stored', () => {
    writeStorage('autorun', false);
    writeStorageSoon('sfxVolume', 0.4);
    writeStorageSoon('musicVolume', 0.2);
    mock.timers.tick(250);
    assert.deepEqual(blob(), { autorun: false, sfxVolume: 0.4, musicVolume: 0.2 });
  });

  test('an immediate write carries the pending fields rather than dropping them', () => {
    writeStorageSoon('sfxVolume', 0.4);
    writeStorage('bloom', true);
    assert.deepEqual(blob(), { sfxVolume: 0.4, bloom: true });
  });

  test('flushing early stores what is pending and leaves the timer nothing to do', () => {
    writeStorageSoon('sfxVolume', 0.4);
    flushStorage();
    assert.equal(blob().sfxVolume, 0.4);
    store.map.clear();
    mock.timers.tick(250);
    assert.deepEqual([...store.map.keys()], [], 'the cleared timer writes nothing more');
  });

  test('no storage at all swallows a coalesced write the way an immediate one is swallowed', () => {
    installStorage(null);
    writeStorageSoon('sfxVolume', 0.4);
    assert.doesNotThrow(() => mock.timers.tick(250));
    assert.equal(readStorage('sfxVolume', -1), -1);
  });
});
