import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOSAVE_ID,
  MAX_SAVES,
  SAVE_VERSION,
  deleteSave,
  exportSave,
  importSave,
  listSaves,
  missingWadLabel,
  missingWadText,
  overwriteSave,
  readAutosave,
  readSave,
  renameSave,
  requiredWads,
  setSaveBackend,
  wadLabel,
  wadSetRefusal,
  writeAutosave,
  writeSave,
  type SaveCapture,
} from '../../src/game/savegames.ts';
import {
  STATE_ENCODING,
  base64ToBytes,
  bytesToBase64,
  compressText,
  decompressText,
  type SaveStoreBackend,
  type StoredState,
} from '../../src/game/savestore.ts';

/**
 * The two IndexedDB object stores as two Maps, exposed so tests can tamper with
 * stored records the way devtools (or a future build) could. The gzip codec is
 * *not* faked — `CompressionStream` is global in Node, so every test compresses
 * and decompresses for real.
 */
interface MemoryBackend extends SaveStoreBackend {
  metas: Map<string, unknown>;
  states: Map<string, StoredState>;
}

function memoryBackend(): MemoryBackend {
  const metas = new Map<string, unknown>();
  const states = new Map<string, StoredState>();
  return {
    metas,
    states,
    listMeta: async () => [...metas.values()],
    readMeta: async (id) => metas.get(id),
    readState: async (id) => states.get(id),
    putSave: async (meta, state) => {
      metas.set((meta as { id: string }).id, meta);
      states.set(state.id, state);
    },
    putMeta: async (meta) => void metas.set((meta as { id: string }).id, meta),
    remove: async (id) => {
      metas.delete(id);
      states.delete(id);
    },
    count: async () => metas.size,
  };
}

let store: MemoryBackend;

beforeEach(() => {
  store = memoryBackend();
  setSaveBackend(store);
});

/** The smallest state payload the loadability check accepts — the store never looks deeper than this. */
const state = { player: { x: 0 }, rng: { p: 0, m: 0 } } as unknown as SaveCapture['state'];

const capture = (map = 'E1M1'): SaveCapture => ({
  map,
  skill: 3,
  wads: [{ name: 'DOOM.WAD', id: 'abc123' }],
  mapWad: 'abc123',
  levelTime: 61.5,
  thumb: 'data:image/jpeg;base64,xyz',
  state,
});

/** Mutates a stored meta record in place — the devtools-style tampering `asMeta` has to survive. */
function tamperMeta(id: string, patch: Record<string, unknown>): void {
  store.metas.set(id, { ...(store.metas.get(id) as Record<string, unknown>), ...patch });
}

/** The savegame store: the meta/state split, the cap, version refusal, and what a damaged record costs. See docs/savegames.md § Storage and the cap. */
describe('Savegames · the store', () => {
  test('write, list, read and delete round-trip', async () => {
    const meta = await writeSave(capture(), 'my save');
    assert.equal(meta.version, SAVE_VERSION);
    assert.equal(meta.name, 'my save');
    assert.ok(store.metas.has(meta.id), 'meta stored under its id');
    assert.ok(store.states.has(meta.id), 'state stored under the same id');

    const listed = await listSaves();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], { meta, supported: true });

    const back = await readSave(meta.id);
    assert.equal(back.map, 'E1M1');
    assert.deepEqual(back.state, state);

    await deleteSave(meta.id);
    assert.deepEqual(await listSaves(), []);
    assert.equal(store.states.size, 0, 'the state record went with the meta');
  });

  test('the stored state is gzip, and listing never touches it', async () => {
    const meta = await writeSave(capture(), 'zipped');
    const record = store.states.get(meta.id)!;
    assert.equal(record.encoding, STATE_ENCODING);
    assert.deepEqual(record.bytes.subarray(0, 2), new Uint8Array([0x1f, 0x8b]), 'gzip magic bytes');
    assert.deepEqual(JSON.parse(await decompressText(record.bytes)), state);

    store.readState = async () => {
      throw new Error('listing must not read a state record');
    };
    assert.equal((await listSaves()).length, 1);
  });

  test('the WAD set is stored verbatim as one load-order list of content ids', async () => {
    const set: SaveCapture = {
      ...capture(),
      wads: [
        { name: 'DOOM2.WAD', id: 'aaa' },
        { name: 'SCYTHE.WAD', id: 'bbb' },
      ],
      mapWad: 'bbb',
    };
    // Nothing is added on the way in: `wadSetId`'s output is already the format,
    // so no library key can go stale inside a save.
    const meta = await writeSave(set, 'byid');
    assert.deepEqual(meta.wads, set.wads);
    assert.deepEqual((await readSave(meta.id)).wads, set.wads, 'and survives the round-trip');
  });

  test('only the game WAD and the map provider are required back', () => {
    const wads = [
      { name: 'DOOM2.WAD', id: 'aaa' },
      { name: 'SCYTHE.WAD', id: 'bbb' },
      { name: 'sounds.wad', id: 'ccc' },
    ];
    // The add-on that supplied the map is required; the one that supplied only
    // sounds is not, and neither is a set whose map came from the IWAD itself.
    assert.deepEqual(requiredWads(wads, 'bbb'), [true, true, false]);
    assert.deepEqual(requiredWads(wads, 'aaa'), [true, false, false]);
  });

  test('a mapWad naming no file in the set requires all of them', () => {
    // Both the pre-`mapWad` save (no provider named) and a damaged field land
    // here, and must fail towards refusing loads — never towards allowing one
    // whose map may have come from the file it dropped.
    const wads = [
      { name: 'DOOM2.WAD', id: 'aaa' },
      { name: 'SCYTHE.WAD', id: 'bbb' },
    ];
    assert.deepEqual(requiredWads(wads, ''), [true, true]);
    assert.deepEqual(requiredWads(wads, 'gone'), [true, true]);
  });

  test('the load gate passes a set short an add-on the level never came from', () => {
    const save = {
      map: 'MAP03',
      wads: [
        { name: 'DOOM2.WAD', id: 'aaa' },
        { name: 'test_spectre.wad', id: 'ccc' },
      ],
      mapWad: 'aaa',
    };
    const iwad = { name: 'DOOM2.WAD', id: 'aaa' };
    assert.equal(wadSetRefusal(save, [iwad], iwad), null, 'the add-on supplied no lump this save indexes into');
    assert.match(
      wadSetRefusal(save, [{ name: 'DOOM.WAD', id: 'zzz' }], iwad) ?? '',
      /DOOM\.WAD differs from the game WAD/,
      'but the game WAD is named when it is the wrong one',
    );
    assert.match(
      wadSetRefusal(save, [iwad], { name: 'SCYTHE.WAD', id: 'bbb' }) ?? '',
      /SCYTHE\.WAD provides MAP03/,
      'and so is a file that provides the map in another version',
    );
    assert.match(wadSetRefusal(save, [iwad], null) ?? '', /no map MAP03/);
  });

  test('a save naming no provider is gated on its whole set, in order', () => {
    // The pre-`mapWad` rule, which is also where a damaged field lands.
    const wads = [
      { name: 'DOOM2.WAD', id: 'aaa' },
      { name: 'SCYTHE.WAD', id: 'bbb' },
    ];
    const save = { map: 'MAP03', wads, mapWad: '' };
    assert.equal(wadSetRefusal(save, wads, { name: 'SCYTHE.WAD', id: 'bbb' }), null);
    assert.match(wadSetRefusal(save, [wads[0]], null) ?? '', /different file count/);
    assert.match(
      wadSetRefusal(save, [wads[0], { name: 'SCYTHE.WAD', id: 'other' }], null) ?? '',
      /SCYTHE\.WAD differs from the file this save was made with/,
    );
  });

  test('a save from before mapWad still loads, under the whole-set rule', async () => {
    const meta = await writeSave(capture(), 'pre-mapwad');
    const { mapWad: _dropped, ...withoutField } = store.metas.get(meta.id) as Record<string, unknown>;
    store.metas.set(meta.id, withoutField);

    const [entry] = await listSaves();
    assert.equal(entry.supported, true, 'the field costs no version bump');
    assert.equal((await readSave(meta.id)).mapWad, '', 'and reads as "no provider named"');
  });

  test('a missing optional file reads as a note, a required one as something to go and find', () => {
    const optional = { name: 'sounds.wad', role: 'PWAD' as const, wrongVersion: false, required: false };
    // The optional sentences promise the level plays, and no more than that:
    // what the absent file skinned or sounded is gone with it.
    assert.match(missingWadText(optional), /plays without it, but content it added may be missing/);
    assert.match(missingWadText({ ...optional, wrongVersion: true }), /content it added may differ/);
    assert.match(missingWadText({ ...optional, required: true }), /load it from disk first/);
    assert.match(
      missingWadText({ ...optional, required: true, wrongVersion: true }),
      /not the version this save was made with/,
    );
  });

  test('the row label opens the tooltip sentence, so one file is never named two ways', () => {
    for (const required of [false, true]) {
      for (const wrongVersion of [false, true]) {
        const file = { name: 'sounds.wad', role: 'PWAD' as const, required, wrongVersion };
        assert.ok(
          missingWadText(file).startsWith(missingWadLabel(file)),
          `"${missingWadText(file)}" does not open with "${missingWadLabel(file)}"`,
        );
      }
    }
  });

  test('every row label fits the save row, which ellipsizes what it cannot show', () => {
    // ~55 characters is what the label column holds at 12px
    // (docs/menu.md § Save and Load tabs); the advice lives in `missingWadText`
    // precisely because it does not fit here.
    const name = 'a-rather-long-addon.wad';
    for (const required of [false, true]) {
      for (const wrongVersion of [false, true]) {
        const label = missingWadLabel({ name, role: 'PWAD', required, wrongVersion });
        assert.ok(label.includes(name), `${label} names the file`);
        assert.ok(label.length <= 55, `${label} is ${label.length} characters, too long for the row`);
      }
    }
  });

  test('a damaged WAD entry is blanked, not dropped — load order decides the role', async () => {
    const meta = await writeSave({ ...capture(), wads: [{ name: 'A', id: 'a' }, { name: 'B', id: 'b' }] }, 's');
    tamperMeta(meta.id, { wads: ['nonsense', { name: 'B', id: 'b' }] });

    const listed = (await listSaves())[0].meta;
    assert.equal(listed.wads.length, 2, 'the entry keeps its slot so B stays an add-on');
    assert.deepEqual(listed.wads[0], { name: '', id: '' });
    assert.equal(wadLabel(listed.wads[0]), 'unknown file');
    assert.deepEqual(listed.wads[1], { name: 'B', id: 'b' });
  });

  test('an empty name defaults to map and date', async () => {
    assert.match((await writeSave(capture('MAP05'), '   ')).name, /^MAP05 — /);
  });

  test('the list is newest first', async () => {
    const a = await writeSave(capture('E1M1'), 'a');
    tamperMeta(a.id, { at: '2001-01-01T00:00:00.000Z' });
    await writeSave(capture('E1M2'), 'b');
    assert.deepEqual(
      (await listSaves()).map((e) => e.meta.name),
      ['b', 'a'],
    );
  });

  test('an unsupported version is listed but refuses to load', async () => {
    const meta = await writeSave(capture(), 'old');
    tamperMeta(meta.id, { version: SAVE_VERSION + 1 });

    const [entry] = await listSaves();
    assert.equal(entry.supported, false);
    assert.equal(entry.meta.name, 'old', 'the row still shows its own name');
    await assert.rejects(readSave(meta.id), new RegExp(`version ${SAVE_VERSION + 1}.*version ${SAVE_VERSION}`));
  });

  test('a damaged meta is one unloadable row, not a broken list', async () => {
    await writeSave(capture(), 'good');
    store.metas.set('broken', 'not even an object');
    const listed = await listSaves();
    assert.equal(listed.length, 2);
    const broken = listed.find((e) => e.meta.map === '?')!;
    assert.equal(broken.supported, false);
    assert.equal(broken.meta.name, '(unreadable save)');
    await assert.rejects(readSave('broken'), /damaged/);
    assert.equal(listed.find((e) => e.meta.name === 'good')!.supported, true);
  });

  test('a damaged state lists as loadable and fails at load, readably', async () => {
    const meta = await writeSave(capture(), 'hollow');

    // Listing reads metas only, so neither problem below can show up in the list.
    store.states.set(meta.id, { id: meta.id, encoding: STATE_ENCODING, bytes: new Uint8Array([1, 2, 3]) });
    assert.equal((await listSaves())[0].supported, true);
    await assert.rejects(readSave(meta.id), /damaged/);

    store.states.delete(meta.id);
    assert.equal((await listSaves())[0].supported, true);
    await assert.rejects(readSave(meta.id), /damaged/);
    await deleteSave(meta.id);
    assert.deepEqual(await listSaves(), [], 'still deletable');
  });

  test('a state under an unknown encoding refuses to load', async () => {
    const meta = await writeSave(capture(), 's');
    const record = store.states.get(meta.id)!;
    store.states.set(meta.id, { ...record, encoding: STATE_ENCODING + 1 });
    await assert.rejects(readSave(meta.id), /damaged/);
  });

  test('overwriting keeps the id and the name, and replaces the payload', async () => {
    const meta = await writeSave(capture('E1M1'), 'slot one');
    const replaced = await overwriteSave(meta.id, capture('E1M9'));
    assert.equal(replaced.id, meta.id);
    assert.equal(replaced.name, 'slot one', 'the slot keeps its label');
    assert.equal(replaced.map, 'E1M9');
    assert.equal((await listSaves()).length, 1, 'one slot, not two');
    assert.equal((await readSave(meta.id)).map, 'E1M9');
    await assert.rejects(overwriteSave('never-existed', capture()), /no longer exists/);
  });

  test('overwriting works with the list full — no new save, so no cap', async () => {
    const first = await writeSave(capture(), 's0');
    for (let i = 1; i < MAX_SAVES; i++) await writeSave(capture(), `s${i}`);
    await assert.rejects(writeSave(capture(), 'one too many'), /delete a save first/);
    assert.equal((await overwriteSave(first.id, capture('MAP07'))).map, 'MAP07');
    assert.equal((await listSaves()).length, MAX_SAVES);
  });

  test('renaming touches the meta only, and refuses a damaged row', async () => {
    const meta = await writeSave(capture(), 'before');
    const record = store.states.get(meta.id)!;
    await renameSave(meta.id, '  after  ');
    const [entry] = await listSaves();
    assert.equal(entry.meta.name, 'after', 'trimmed');
    assert.equal(entry.meta.at, meta.at, 'the list does not reorder under a rename');
    assert.equal(store.states.get(meta.id), record, 'the state record was not rewritten');

    await assert.rejects(renameSave(meta.id, '   '), /needs a name/);
    assert.equal((await listSaves())[0].meta.name, 'after');

    store.metas.set('broken', 'not even an object');
    await assert.rejects(renameSave('broken', 'x'), /damaged/);
    assert.equal(store.metas.get('broken'), 'not even an object', 'left as it was');
  });

  test('the cap refuses the write instead of evicting', async () => {
    for (let i = 0; i < MAX_SAVES; i++) await writeSave(capture(), `s${i}`);
    await assert.rejects(writeSave(capture(), 'one too many'), /delete a save first/);
    assert.equal((await listSaves()).length, MAX_SAVES);
  });

  test('a full quota surfaces as a readable error', async () => {
    store.putSave = async () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    await assert.rejects(writeSave(capture(), 's'), /storage/);
  });

  test('the download is one readable JSON file carrying the stored gzip bytes', async () => {
    const meta = await writeSave(capture(), 'readable');
    const downloaded = await exportSave(meta.id);
    assert.match(downloaded, /^\{\n\t"/, 'newlines and tab indents');

    const file = JSON.parse(downloaded);
    assert.equal(file.name, 'readable', 'meta fields stay human-readable');
    assert.equal(file.version, SAVE_VERSION);
    assert.equal(file.stateEncoding, STATE_ENCODING);
    assert.deepEqual(base64ToBytes(file.state), store.states.get(meta.id)!.bytes, 'the stored bytes, verbatim');
  });

  test('an unsupported version still downloads, its version intact', async () => {
    const meta = await writeSave(capture(), 'old');
    tamperMeta(meta.id, { version: SAVE_VERSION + 9 });
    const file = JSON.parse(await exportSave(meta.id));
    assert.equal(file.version, SAVE_VERSION + 9, 'carried verbatim so a matching build can re-import it');
  });

  test('a state too damaged to decompress still downloads, byte-exact', async () => {
    const meta = await writeSave(capture(), 'corrupt');
    const junk = new Uint8Array([9, 9, 9, 9]);
    store.states.set(meta.id, { id: meta.id, encoding: STATE_ENCODING, bytes: junk });
    const file = JSON.parse(await exportSave(meta.id));
    assert.deepEqual(base64ToBytes(file.state), junk);

    store.states.delete(meta.id);
    await assert.rejects(exportSave(meta.id), /cannot be downloaded/, 'nothing left to hand over');
    await assert.rejects(exportSave('never-existed'), /no longer exists/);
  });

  test('importing a downloaded save re-ids it, so importing twice makes two', async () => {
    const meta = await writeSave(capture(), 'exported');
    const text = await exportSave(meta.id);
    const imported = await importSave(text);
    assert.notEqual(imported.id, meta.id);
    assert.equal((await importSave(text)).id === imported.id, false);
    assert.equal((await listSaves()).length, 3);
  });

  test('import stores the file’s bytes verbatim and the state round-trips', async () => {
    const meta = await writeSave(capture(), 'round');
    const original = store.states.get(meta.id)!.bytes;
    const imported = await importSave(await exportSave(meta.id));
    assert.deepEqual(store.states.get(imported.id)!.bytes, original, 'no recompression drift');
    assert.deepEqual((await readSave(imported.id)).state, state);
  });

  test('import refuses non-saves, old versions by name, and un-encoded states', async () => {
    await assert.rejects(importSave('hello'), /not a TopDoom save/);
    await assert.rejects(importSave('{"some": "json"}'), /not a TopDoom save/);
    const base = { ...capture(), id: 'x', version: SAVE_VERSION, at: '', name: 'x' };
    await assert.rejects(importSave(JSON.stringify({ ...base, version: 99 })), /version 99/);
    // The pre-IndexedDB export shape — `state` as a plain object — is refused:
    // the format is unreleased, so it gets no compat path.
    await assert.rejects(importSave(JSON.stringify(base)), /not a TopDoom save/);
    const garbled = { ...base, stateEncoding: STATE_ENCODING, state: 'not base64!!' };
    await assert.rejects(importSave(JSON.stringify(garbled)), /not a TopDoom save/);
  });
});

/** The level-entry checkpoint: one reserved id, hidden from both tabs and outside the cap. See docs/savegames.md § The checkpoint. */
describe('Savegames · the checkpoint', () => {
  test('it replaces itself and never appears in the list', async () => {
    await writeAutosave(capture('E1M1'));
    await writeAutosave(capture('E1M2'));
    assert.equal(store.metas.size, 1, 'one meta, not one per level');
    assert.equal(store.states.size, 1);
    assert.equal((await readAutosave())?.map, 'E1M2', 'the later write won');

    assert.deepEqual(await listSaves(), [], 'hidden with nothing else stored');
    const mine = await writeSave(capture(), 'my save');
    assert.deepEqual(
      (await listSaves()).map((e) => e.meta.id),
      [mine.id],
      'and hidden beside a real save',
    );
  });

  test('it costs nobody a save slot', async () => {
    await writeAutosave(capture());
    for (let i = 0; i < MAX_SAVES; i++) await writeSave(capture(), `s${i}`);
    assert.equal((await listSaves()).length, MAX_SAVES, 'the full list is still the player’s own');
    await assert.rejects(writeSave(capture(), 'one too many'), /delete a save first/);
    // Same discount on the import path, which shares the cap check.
    const exported = await exportSave((await listSaves())[0].meta.id);
    await assert.rejects(importSave(exported), /delete a save first/);
  });

  test('an unusable checkpoint reads as null rather than throwing', async () => {
    assert.equal(await readAutosave(), null, 'nothing stored');

    await writeAutosave(capture());
    store.states.delete(AUTOSAVE_ID);
    assert.equal(await readAutosave(), null, 'state record gone');

    await writeAutosave(capture());
    tamperMeta(AUTOSAVE_ID, { version: SAVE_VERSION + 1 });
    assert.equal(await readAutosave(), null, 'written by another build');
  });

  test('the capture round-trips through it, thumbnail-less and all', async () => {
    await writeAutosave({ ...capture('MAP12'), thumb: '' });
    const save = await readAutosave();
    assert.equal(save?.id, AUTOSAVE_ID);
    assert.equal(save?.skill, 3);
    assert.equal(save?.thumb, '');
    assert.deepEqual(save?.wads, [{ name: 'DOOM.WAD', id: 'abc123' }]);
    assert.deepEqual(save?.state, state);
  });
});

/** The byte codecs under the store: real gzip both ways, and the export file's base64. */
describe('Savegames · codecs', () => {
  test('gzip round-trips, non-ASCII included', async () => {
    const text = '{"name":"Ärger im Töten-Level ✓","x":1.5}';
    assert.equal(await decompressText(await compressText(text)), text);
  });

  test('compression actually shrinks a repetitive payload', async () => {
    const text = JSON.stringify(Array.from({ length: 500 }, (_, i) => [i, { floorHeight: 128, light: 255 }]));
    const bytes = await compressText(text);
    assert.ok(bytes.length < text.length / 4, `${bytes.length} of ${text.length} bytes`);
  });

  test('base64 round-trips a large buffer through the chunked encoder', () => {
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 8)) & 0xff;
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  });
});
