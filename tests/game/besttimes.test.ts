import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RECORDS,
  bestTimeKey,
  clearBestTimes,
  loadBestTimes,
  readBestTime,
  recordBestTime,
  setBestTimeBackend,
  type BestTimeBackend,
  type StoredBestTime,
} from '../../src/game/besttimes.ts';
import { fakeStorage, installStorage } from '../fixtures/storage.ts';

/**
 * The per-level best times: what the store keeps, what it refuses, and the one-time migration
 * off `localStorage`.
 * See docs/hud.md § Best times.
 */

const LEGACY_STORAGE_KEY = 'topdoom.bestTimes';

/**
 * The object store as one Map, exposed so a test can seed rows and tamper with them the way
 * devtools could. `fail` stands in for a browser that refuses IndexedDB — private mode, storage
 * pressure — which the migration has to tell apart from an empty database.
 */
interface MemoryBackend extends BestTimeBackend {
  rows: Map<string, StoredBestTime>;
  failReads: boolean;
  failWrites: boolean;
}

function memoryBackend(): MemoryBackend {
  const refuse = (): never => {
    throw new Error('refused');
  };
  const backend: MemoryBackend = {
    rows: new Map(),
    failReads: false,
    failWrites: false,
    readAll: async () => (backend.failReads ? refuse() : [...backend.rows.values()]),
    write: async (puts, deletes) => {
      if (backend.failWrites) refuse();
      for (const row of puts) backend.rows.set(row.key, row);
      for (const key of deletes) backend.rows.delete(key);
    },
    clear: async () => {
      if (backend.failWrites) refuse();
      backend.rows.clear();
    },
  };
  return backend;
}

let store: MemoryBackend;
let legacy: Map<string, string>;

beforeEach(() => {
  const fake = fakeStorage();
  installStorage(fake);
  legacy = fake.map;
  store = memoryBackend();
  setBestTimeBackend(store);
});

/** Database writes are fire-and-forget, so a test that inspects a row waits a turn for the queue to drain. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const meta = { wad: 'DOOM.WAD', map: 'E1M1', skill: 3 };
const legacyEntry = (seconds: number): Record<string, unknown> => ({
  seconds,
  wad: 'W',
  map: 'M',
  skill: 3,
  at: '2020-01-01T00:00:00.000Z',
});
const row = (key: string, seconds: number, at: string): StoredBestTime => ({
  key,
  seconds,
  wad: 'W',
  map: 'M',
  skill: 3,
  at,
});

/**
 * Per-level best times: what gets written, what doesn't, and what a damaged record costs. See
 * docs/hud.md § Best times.
 */
describe('Best times · the record store', () => {
  test('the key separates WAD, map and skill', () => {
    assert.equal(bestTimeKey('abc123', 'E1M1', 3), 'abc123|E1M1|3');
    assert.notEqual(bestTimeKey('abc123', 'E1M1', 3), bestTimeKey('abc123', 'E1M1', 4));
    assert.notEqual(bestTimeKey('abc123', 'E1M1', 3), bestTimeKey('def456', 'E1M1', 3));
  });

  test('the map name is normalized so a lump-case difference cannot split a record', () => {
    assert.equal(bestTimeKey('abc', 'map01', 2), bestTimeKey('abc', 'MAP01', 2));
  });

  test('a first completion is a record, with nothing before it', async () => {
    await loadBestTimes();
    const result = recordBestTime('k', 161, meta);
    assert.deepEqual(result, { previous: null, isNewBest: true });
    assert.equal(readBestTime('k'), 161);
  });

  test('a slower run reports the time to beat and leaves it alone', async () => {
    await loadBestTimes();
    recordBestTime('k', 161, meta);
    const result = recordBestTime('k', 200, meta);
    assert.deepEqual(result, { previous: 161, isNewBest: false });
    assert.equal(readBestTime('k'), 161);
  });

  test('a faster run takes over and hands back the old time', async () => {
    await loadBestTimes();
    recordBestTime('k', 161, meta);
    const result = recordBestTime('k', 140.5, meta);
    assert.deepEqual(result, { previous: 161, isNewBest: true });
    assert.equal(readBestTime('k'), 140.5);
  });

  test('an equal run is not a record', async () => {
    await loadBestTimes();
    recordBestTime('k', 161, meta);
    assert.equal(recordBestTime('k', 161, meta).isNewBest, false);
  });

  test('an unset key has no best time', async () => {
    await loadBestTimes();
    assert.equal(readBestTime('never-played'), null);
  });

  test('a record survives the session that set it', async () => {
    await loadBestTimes();
    recordBestTime('k', 161, meta);
    await flush();
    // A second visit: same database, a fresh cache.
    setBestTimeBackend(store);
    await loadBestTimes();
    assert.equal(readBestTime('k'), 161);
  });

  test('the stored row names the WAD and map, for anyone reading it by hand', async () => {
    await loadBestTimes();
    recordBestTime(bestTimeKey('abc', 'E1M1', 3), 161, meta);
    await flush();
    const stored = store.rows.get('abc|E1M1|3')!;
    assert.equal(stored.wad, 'DOOM.WAD');
    assert.equal(stored.map, 'E1M1');
    assert.equal(stored.skill, 3);
    assert.match(stored.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('one malformed row is dropped, the rest of the table survives', async () => {
    store.rows.set('good', row('good', 100, '2026-01-01T00:00:00.000Z'));
    for (const [key, value] of Object.entries({
      noSeconds: { key: 'noSeconds', wad: 'DOOM.WAD' },
      negative: { key: 'negative', seconds: -5 },
      notANumber: { key: 'notANumber', seconds: 'fast' },
      noKey: { seconds: 10 },
      notAnObject: 7,
    })) {
      store.rows.set(key, value as unknown as StoredBestTime);
    }
    await loadBestTimes();

    assert.equal(readBestTime('good'), 100);
    for (const key of ['noSeconds', 'negative', 'notANumber', 'noKey', 'notAnObject']) {
      assert.equal(readBestTime(key), null, key);
    }
    // And the surviving entry is still there after the next write, i.e. the bad ones didn't
    // take it.
    recordBestTime('fresh', 10, meta);
    assert.equal(readBestTime('good'), 100);
  });

  test('a database that refuses to be read costs the records, not the boot', async () => {
    store.failReads = true;
    await loadBestTimes();
    assert.equal(readBestTime('k'), null);
    assert.deepEqual(recordBestTime('k', 161, meta), { previous: null, isNewBest: true });
    await flush();
  });

  test('the table is capped, and the oldest record is what goes', async () => {
    for (let i = 0; i < MAX_RECORDS; i++) store.rows.set(`k${i}`, row(`k${i}`, 100, '2026-01-01T00:00:00.000Z'));
    store.rows.set('ancient', row('ancient', 100, '2001-01-01T00:00:00.000Z'));
    await loadBestTimes();

    recordBestTime('brand-new', 50, meta);
    await flush();
    assert.equal(store.rows.size, MAX_RECORDS);
    assert.equal(store.rows.get('ancient'), undefined, 'the oldest entry is the one evicted');
    assert.equal(readBestTime('ancient'), null, 'and it is gone from the session too');
    assert.equal(store.rows.get('brand-new')!.seconds, 50, 'the record that triggered the write is kept');
  });

  test('clearing drops everything', async () => {
    await loadBestTimes();
    recordBestTime('k', 161, meta);
    clearBestTimes();
    await flush();
    assert.equal(readBestTime('k'), null);
    assert.equal(store.rows.size, 0);
  });
});

/** The one-time move off `topdoom.bestTimes`. See docs/hud.md § The store. */
describe('Best times · the localStorage migration', () => {
  test('the old blob is folded into the database and then dropped', async () => {
    legacy.set(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        'abc|E1M1|3': { seconds: 161, wad: 'DOOM.WAD', map: 'E1M1', skill: 3, at: '2026-01-01T00:00:00.000Z' },
      }),
    );
    await loadBestTimes();

    assert.equal(readBestTime('abc|E1M1|3'), 161);
    assert.deepEqual(store.rows.get('abc|E1M1|3'), {
      key: 'abc|E1M1|3',
      seconds: 161,
      wad: 'DOOM.WAD',
      map: 'E1M1',
      skill: 3,
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(legacy.get(LEGACY_STORAGE_KEY), undefined, 'the blob is removed once it has landed');
  });

  test('a migrated record does not overwrite a faster one already in the database', async () => {
    store.rows.set('k', row('k', 100, '2026-01-01T00:00:00.000Z'));
    legacy.set(LEGACY_STORAGE_KEY, JSON.stringify({ k: legacyEntry(200) }));
    await loadBestTimes();

    assert.equal(readBestTime('k'), 100);
    assert.equal(store.rows.get('k')!.seconds, 100);
    assert.equal(legacy.get(LEGACY_STORAGE_KEY), undefined);
  });

  test('a slower database record loses to the migrated one', async () => {
    store.rows.set('k', row('k', 300, '2026-01-01T00:00:00.000Z'));
    legacy.set(LEGACY_STORAGE_KEY, JSON.stringify({ k: legacyEntry(200) }));
    await loadBestTimes();

    assert.equal(readBestTime('k'), 200);
    assert.equal(store.rows.get('k')!.seconds, 200);
  });

  test('a malformed entry does not abort the fold — the rest of the blob migrates', async () => {
    legacy.set(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        good: { seconds: 100, wad: 'DOOM.WAD', map: 'E1M1', skill: 3, at: '2026-01-01T00:00:00.000Z' },
        negative: { seconds: -5 },
      }),
    );
    await loadBestTimes();

    assert.equal(readBestTime('good'), 100);
    assert.equal(readBestTime('negative'), null);
    assert.equal(store.rows.size, 1, 'and only the good one lands');
  });

  // Two tests rather than a loop: the migration runs once per load, so a second blob in the same
  // test would never be looked at.
  test('an unparseable blob migrates nothing and is dropped', async () => {
    legacy.set(LEGACY_STORAGE_KEY, '{not json');
    await loadBestTimes();
    assert.equal(readBestTime('k'), null);
    assert.equal(legacy.get(LEGACY_STORAGE_KEY), undefined);
  });

  test('a blob of the wrong shape migrates nothing and is dropped', async () => {
    legacy.set(LEGACY_STORAGE_KEY, '[1,2,3]');
    await loadBestTimes();
    assert.equal(readBestTime('k'), null);
    assert.equal(legacy.get(LEGACY_STORAGE_KEY), undefined);
  });

  test('a refusing database keeps the blob, and the session still reads it', async () => {
    store.failReads = true;
    store.failWrites = true;
    legacy.set(LEGACY_STORAGE_KEY, JSON.stringify({ k: legacyEntry(161) }));
    await loadBestTimes();

    assert.equal(readBestTime('k'), 161, 'the times are still the session\'s, even with nowhere to put them');
    assert.ok(legacy.get(LEGACY_STORAGE_KEY), 'and are not thrown away');
  });

  test('a failing write keeps the blob for the next visit', async () => {
    legacy.set(LEGACY_STORAGE_KEY, JSON.stringify({ k: legacyEntry(161) }));
    // Reads fine, refuses the write: the blob has been read but has not landed anywhere.
    store.failWrites = true;
    await loadBestTimes();

    assert.ok(legacy.get(LEGACY_STORAGE_KEY));
  });

  test('nothing stored means nothing to migrate', async () => {
    await loadBestTimes();
    assert.equal(legacy.size, 0);
    assert.equal(store.rows.size, 0);
  });
});
