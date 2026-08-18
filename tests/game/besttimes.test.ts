import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RECORDS, bestTimeKey, clearBestTimes, readBestTime, recordBestTime } from '../../src/game/besttimes.ts';

const STORAGE_KEY = 'topdoom.bestTimes';

/**
 * Node has no `localStorage` unless webstorage is enabled, and the store reaches for it through
 * `globalThis.localStorage?` — so installing a plain in-memory stand-in is enough, and lets a test
 * seed a deliberately broken blob to check what survives it.
 */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  const fake = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => void backing.delete(key),
    setItem: (key: string, value: string) => void backing.set(key, value),
  };
  (globalThis as { localStorage?: Storage }).localStorage = fake as Storage;
  return backing;
}

let store: Map<string, string>;

beforeEach(() => {
  store = installStorage();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

const meta = { wad: 'DOOM.WAD', map: 'E1M1', skill: 3 };

/**
 * Per-level best times: what gets written, what doesn't, and what a corrupted blob costs. See
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

  test('a first completion is a record, with nothing before it', () => {
    const result = recordBestTime('k', 161, meta);
    assert.deepEqual(result, { previous: null, isNewBest: true });
    assert.equal(readBestTime('k'), 161);
  });

  test('a slower run reports the time to beat and leaves it alone', () => {
    recordBestTime('k', 161, meta);
    const result = recordBestTime('k', 200, meta);
    assert.deepEqual(result, { previous: 161, isNewBest: false });
    assert.equal(readBestTime('k'), 161);
  });

  test('a faster run takes over and hands back the old time', () => {
    recordBestTime('k', 161, meta);
    const result = recordBestTime('k', 140.5, meta);
    assert.deepEqual(result, { previous: 161, isNewBest: true });
    assert.equal(readBestTime('k'), 140.5);
  });

  test('an equal run is not a record', () => {
    recordBestTime('k', 161, meta);
    assert.equal(recordBestTime('k', 161, meta).isNewBest, false);
  });

  test('an unset key has no best time', () => {
    assert.equal(readBestTime('never-played'), null);
  });

  test('the stored blob names the WAD and map, for anyone reading it by hand', () => {
    recordBestTime(bestTimeKey('abc', 'E1M1', 3), 161, meta);
    const parsed = JSON.parse(store.get(STORAGE_KEY)!);
    assert.equal(parsed['abc|E1M1|3'].wad, 'DOOM.WAD');
    assert.equal(parsed['abc|E1M1|3'].map, 'E1M1');
    assert.equal(parsed['abc|E1M1|3'].skill, 3);
    assert.match(parsed['abc|E1M1|3'].at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('an unparseable blob reads as no records rather than throwing', () => {
    store.set(STORAGE_KEY, '{not json');
    assert.equal(readBestTime('k'), null);
    assert.deepEqual(recordBestTime('k', 161, meta), { previous: null, isNewBest: true });
  });

  test('a blob of the wrong shape reads as no records', () => {
    store.set(STORAGE_KEY, '[1,2,3]');
    assert.equal(readBestTime('k'), null);
  });

  test('one malformed entry is dropped, the rest of the table survives', () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        good: { seconds: 100, wad: 'DOOM.WAD', map: 'E1M1', skill: 3, at: '2026-01-01T00:00:00.000Z' },
        noSeconds: { wad: 'DOOM.WAD' },
        negative: { seconds: -5 },
        notANumber: { seconds: 'fast' },
        notAnObject: 7,
      }),
    );
    assert.equal(readBestTime('good'), 100);
    for (const key of ['noSeconds', 'negative', 'notANumber', 'notAnObject']) {
      assert.equal(readBestTime(key), null, key);
    }
    // And the surviving entry is still there after the next write, i.e. the bad ones didn't take it.
    recordBestTime('fresh', 10, meta);
    assert.equal(readBestTime('good'), 100);
  });

  test('the table is capped, and the oldest record is what goes', () => {
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < MAX_RECORDS; i++) {
      seeded[`k${i}`] = { seconds: 100, wad: 'W', map: 'M', skill: 3, at: '2026-01-01T00:00:00.000Z' };
    }
    seeded.ancient = { seconds: 100, wad: 'W', map: 'M', skill: 3, at: '2001-01-01T00:00:00.000Z' };
    store.set(STORAGE_KEY, JSON.stringify(seeded));

    recordBestTime('brand-new', 50, meta);
    const parsed = JSON.parse(store.get(STORAGE_KEY)!);
    assert.equal(Object.keys(parsed).length, MAX_RECORDS);
    assert.equal(parsed.ancient, undefined, 'the oldest entry is the one evicted');
    assert.equal(parsed['brand-new'].seconds, 50, 'the record that triggered the write is kept');
  });

  test('clearing drops everything', () => {
    recordBestTime('k', 161, meta);
    clearBestTimes();
    assert.equal(readBestTime('k'), null);
  });
});
