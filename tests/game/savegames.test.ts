import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SAVES,
  SAVE_VERSION,
  deleteSave,
  exportSave,
  importSave,
  listSaves,
  overwriteSave,
  readSave,
  renameSave,
  writeSave,
  type SaveCapture,
} from '../../src/game/savegames.ts';

/** Same in-memory stand-in as besttimes.test.ts — the store only reaches localStorage through `globalThis.localStorage?`. */
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

/** The smallest state payload `isLoadable` accepts — the store never looks deeper than this. */
const state = { player: { x: 0 }, rng: { p: 0, m: 0 } } as unknown as SaveCapture['state'];

const capture = (map = 'E1M1'): SaveCapture => ({
  map,
  skill: 3,
  wads: [{ name: 'DOOM.WAD', id: 'abc123' }],
  levelTime: 61.5,
  health: 80,
  thumb: 'data:image/jpeg;base64,xyz',
  state,
});

const keys = { iwad: 'DOOM.WAD', pwads: [] };

/** The savegame store: keys, the cap, version refusal, and what a damaged entry costs. See docs/savegames.md § Storage and the cap. */
describe('Savegames · the store', () => {
  test('write, list, read and delete round-trip', () => {
    const meta = writeSave(capture(), 'my save', keys);
    assert.equal(meta.version, SAVE_VERSION);
    assert.equal(meta.name, 'my save');
    assert.ok(store.has(`topdoom.save.${meta.id}`), 'stored under its own key');

    const listed = listSaves();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], { meta, supported: true });

    const back = readSave(meta.id);
    assert.equal(back.map, 'E1M1');
    assert.deepEqual(back.state, state);

    deleteSave(meta.id);
    assert.deepEqual(listSaves(), []);
  });

  test('an empty name defaults to map and date', () => {
    assert.match(writeSave(capture('MAP05'), '   ', keys).name, /^MAP05 — /);
  });

  test('the prefix scan ignores every other topdoom key', () => {
    store.set('topdoom.bestTimes', '{}');
    store.set('topdoom.skill', '3');
    writeSave(capture(), 's', keys);
    assert.equal(listSaves().length, 1);
  });

  test('the list is newest first', () => {
    const a = writeSave(capture('E1M1'), 'a', keys);
    store.set(`topdoom.save.${a.id}`, JSON.stringify({ ...readSave(a.id), at: '2001-01-01T00:00:00.000Z' }));
    writeSave(capture('E1M2'), 'b', keys);
    assert.deepEqual(
      listSaves().map((e) => e.meta.name),
      ['b', 'a'],
    );
  });

  test('an unsupported version is listed but refuses to load', () => {
    const meta = writeSave(capture(), 'old', keys);
    const raw = JSON.parse(store.get(`topdoom.save.${meta.id}`)!);
    raw.version = SAVE_VERSION + 1;
    store.set(`topdoom.save.${meta.id}`, JSON.stringify(raw));

    const [entry] = listSaves();
    assert.equal(entry.supported, false);
    assert.equal(entry.meta.name, 'old', 'the row still shows its own name');
    assert.throws(() => readSave(meta.id), new RegExp(`version ${SAVE_VERSION + 1}.*version ${SAVE_VERSION}`));
  });

  test('a damaged entry is one unloadable row, not a broken list', () => {
    writeSave(capture(), 'good', keys);
    store.set('topdoom.save.broken', '{not json');
    const listed = listSaves();
    assert.equal(listed.length, 2);
    const broken = listed.find((e) => e.meta.id === 'broken')!;
    assert.equal(broken.supported, false);
    assert.equal(broken.meta.name, '(unreadable save)');
    assert.throws(() => readSave('broken'), /damaged/);
    assert.equal(listed.find((e) => e.meta.name === 'good')!.supported, true);
  });

  test('overwriting keeps the id and the name, and replaces the payload', () => {
    const meta = writeSave(capture('E1M1'), 'slot one', keys);
    const replaced = overwriteSave(meta.id, capture('E1M9'), keys);
    assert.equal(replaced.id, meta.id);
    assert.equal(replaced.name, 'slot one', 'the slot keeps its label');
    assert.equal(replaced.map, 'E1M9');
    assert.equal(listSaves().length, 1, 'one slot, not two');
    assert.equal(readSave(meta.id).map, 'E1M9');
    assert.throws(() => overwriteSave('never-existed', capture(), keys), /no longer exists/);
  });

  test('overwriting works with the list full — no new key, so no cap', () => {
    const first = writeSave(capture(), 's0', keys);
    for (let i = 1; i < MAX_SAVES; i++) writeSave(capture(), `s${i}`, keys);
    assert.throws(() => writeSave(capture(), 'one too many', keys), /delete a save first/);
    assert.equal(overwriteSave(first.id, capture('MAP07'), keys).map, 'MAP07');
    assert.equal(listSaves().length, MAX_SAVES);
  });

  test('renaming touches the name only, and refuses a damaged row', () => {
    const meta = writeSave(capture(), 'before', keys);
    renameSave(meta.id, '  after  ');
    const [entry] = listSaves();
    assert.equal(entry.meta.name, 'after', 'trimmed');
    assert.equal(entry.meta.at, meta.at, 'the list does not reorder under a rename');
    assert.deepEqual(readSave(meta.id).state, state);

    assert.throws(() => renameSave(meta.id, '   '), /needs a name/);
    assert.equal(listSaves()[0].meta.name, 'after');

    store.set('topdoom.save.broken', '{not json');
    assert.throws(() => renameSave('broken', 'x'), /damaged/);
    assert.equal(store.get('topdoom.save.broken'), '{not json', 'left as it was');
  });

  test('the cap refuses the write instead of evicting', () => {
    for (let i = 0; i < MAX_SAVES; i++) writeSave(capture(), `s${i}`, keys);
    assert.throws(() => writeSave(capture(), 'one too many', keys), /delete a save first/);
    assert.equal(listSaves().length, MAX_SAVES);
  });

  test('a full quota surfaces as a readable error', () => {
    const fake = globalThis.localStorage as Storage;
    const originalSet = fake.setItem.bind(fake);
    fake.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    assert.throws(() => writeSave(capture(), 's', keys), /storage/);
    fake.setItem = originalSet;
  });

  test('the download is tab-indented, while the stored copy stays compact', () => {
    const meta = writeSave(capture(), 'readable', keys);
    assert.equal(store.get(`topdoom.save.${meta.id}`)!.includes('\n'), false, 'stored compact for the quota');
    const downloaded = exportSave(meta.id);
    assert.match(downloaded, /^\{\n\t"/, 'downloaded with newlines and tab indents');
    assert.deepEqual(JSON.parse(downloaded), JSON.parse(store.get(`topdoom.save.${meta.id}`)!));
  });

  test('a save too damaged to parse still downloads, verbatim', () => {
    store.set('topdoom.save.broken', '{not json');
    assert.equal(exportSave('broken'), '{not json');
    assert.throws(() => exportSave('never-existed'), /no longer exists/);
  });

  test('importing a downloaded save re-ids it, so importing twice makes two', () => {
    const meta = writeSave(capture(), 'exported', keys);
    const text = exportSave(meta.id);
    const imported = importSave(text);
    assert.notEqual(imported.id, meta.id);
    assert.equal(importSave(text).id === imported.id, false);
    assert.equal(listSaves().length, 3);
  });

  test('import refuses non-saves and old versions by name', () => {
    assert.throws(() => importSave('hello'), /not a TopDoom save/);
    assert.throws(() => importSave('{"some": "json"}'), /not a TopDoom save/);
    const old = JSON.stringify({ ...capture(), id: 'x', version: 99, at: '', name: 'x', sourceKeys: keys });
    assert.throws(() => importSave(old), /version 99/);
  });
});
