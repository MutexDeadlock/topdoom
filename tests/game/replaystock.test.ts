import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestEntry } from '../../plugins/replay-manifest.ts';
import {
  deleteReplay,
  describeReplay,
  exportReplay,
  isStockReplay,
  listStockReplays,
  readReplay,
  replayFileName,
  setReplayBackend,
  writeReplay,
} from '../../src/game/replay.ts';
import { STOCK_DIR, STOCK_MANIFEST_PATH, type StockReplayEntry } from '../../src/game/replay/stock.ts';
import { memoryBackend } from '../fixtures/savestore.ts';
import { replayCapture } from '../fixtures/replay.ts';

/**
 * The replays served out of `public/game/replay/`: the plugin's entry for a file on disk, and the
 * same file reaching the menu through a stubbed fetch. Producer and consumer are checked together
 * for the WAD manifest's reason — a shape the consumer casts raw JSON to is one the producer has to
 * be held against. docs/replays.md § Stock replays.
 */

/** The download file itself, written by the store and then deleted from it. */
const FILE = replayFileName('Shipped run');
const ID = `stock:${FILE}`;
let text = '';
let entry: StockReplayEntry | null = null;
/** What the stubbed manifest serves — assigned per test where one wants a different file. */
let manifest: StockReplayEntry[] = [];

before(async () => {
  setReplayBackend(memoryBackend());
  const meta = await writeReplay(replayCapture(4), 'Shipped run');
  text = await exportReplay(meta.id);
  await deleteReplay(meta.id);

  const path = join(mkdtempSync(join(tmpdir(), 'topdoom-replay-')), FILE);
  writeFileSync(path, text);
  entry = manifestEntry(path, FILE);
  manifest = entry ? [entry] : [];

  globalThis.fetch = ((url: string) => {
    if (url === `/${STOCK_MANIFEST_PATH}`) return Promise.resolve(Response.json(manifest));
    if (url === `/${STOCK_DIR}/${encodeURIComponent(FILE)}`) return Promise.resolve(new Response(text));
    return Promise.resolve(new Response('', { status: 404 }));
  }) as typeof fetch;
});

after(() => {
  // Node's own `fetch` back: every later test file in this process shares the global.
  globalThis.fetch = undefined as unknown as typeof fetch;
});

describe('Replays · the ones the engine ships', () => {
  test('the manifest entry is the download file with its record left behind', () => {
    assert.ok(entry);
    assert.equal(entry.file, FILE);
    const meta = entry.meta as Record<string, unknown>;
    assert.equal(meta.name, 'Shipped run');
    assert.equal(meta.ticCount, 4);
    // The whole point of the manifest: a listing costs no record.
    assert.equal(meta.data, undefined);
    assert.equal(meta.dataEncoding, undefined);
  });

  test('a served file lists as a playable row under a stock id', async () => {
    const [row, ...rest] = await listStockReplays();
    assert.equal(rest.length, 0);
    assert.ok(isStockReplay(row.meta.id));
    assert.equal(row.meta.id, `stock:${FILE}`, 'the prefix a stored id can never carry');
    assert.equal(row.meta.name, 'Shipped run');
    assert.equal(row.refusal, null, 'a file this build can read gives the row no reason to grey Play');
  });

  test('playing one reads the record through the same id space as a stored replay', async () => {
    const replay = await readReplay(ID);
    assert.equal(replay.id, ID);
    assert.equal(replay.ticCount, 4);
    assert.equal(replay.data.slots[0].tics.held.length, 4);
    // Nothing about the record is re-encoded on the way through, floats included.
    assert.equal(replay.data.snapshots[0].players[0].player.x, 1.000000123456789);
  });

  test('downloading one hands over the served file unchanged', async () => {
    assert.equal(await exportReplay(ID), text);
  });

  test('editing or deleting one says why rather than writing a stored row', async () => {
    await assert.rejects(describeReplay(ID, { name: 'mine now' }), /ships with TopDoom/);
    await assert.rejects(deleteReplay(ID), /ships with TopDoom/);
  });

  test('a file this build cannot read still lists, with the reason beside it', async () => {
    const meta = { ...(entry!.meta as Record<string, unknown>), version: 99 };
    const served = manifest;
    manifest = [{ file: FILE, meta }];
    try {
      const [row] = await listStockReplays();
      assert.match(row.refusal ?? '', /version 99/);
      assert.equal(row.meta.name, 'Shipped run', 'the row still names the replay it refuses');
    } finally {
      manifest = served;
    }
  });
});
