import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPAT,
  REPLAY_VERSION,
  compatDrift,
  deleteReplay,
  describeReplay,
  exportReplay,
  importReplay,
  isReplayFileName,
  listReplays,
  readReplay,
  replayFileName,
  replayWadSet,
  setReplayBackend,
  writeReplay,
} from '../../src/game/replay.ts';
import { SAVE_VERSION, wadSetRefusal } from '../../src/game/savegames.ts';
import { STATE_ENCODING } from '../../src/game/savestore.ts';
import { memoryBackend, type MemoryBackend } from '../fixtures/savestore.ts';
import { replayCapture as capture } from '../fixtures/replay.ts';

/**
 * The replay store over an in-memory backend, the gzip codec real —
 * `tests/game/savegames.test.ts`'s rig for the format it mirrors. See docs/replays.md § Storage.
 */

let backend: MemoryBackend;

beforeEach(() => {
  backend = memoryBackend();
  setReplayBackend(backend);
});

describe('Replays · the store', () => {
  test('a written replay lists, reads back bit-exact and can be described', async () => {
    const meta = await writeReplay(capture(), '');
    assert.equal(meta.version, REPLAY_VERSION);
    assert.equal(meta.name, 'DOOM2 MAP01', 'a blank name gets the map provider and the map, as a save does');
    const [entry] = await listReplays();
    assert.equal(entry.meta.id, meta.id);
    assert.equal(entry.refusal, null);

    const replay = await readReplay(meta.id);
    assert.equal(
      replay.data.snapshots[0].players[0].player.x,
      1.000000123456789,
      'no float rounding on the way through',
    );

    await describeReplay(meta.id, { name: '  Speedrun  ', player: 'me', description: 'first exit' });
    const [{ meta: edited }] = await listReplays();
    assert.equal(edited.name, 'Speedrun');
    assert.equal(edited.player, 'me');
    assert.equal(edited.description, 'first exit');
    await assert.rejects(describeReplay(meta.id, { name: ' ' }), /needs a name/);
    assert.equal(backend.states.size, 1, 'describing never rewrites the record');
  });

  test('three fields edited at once all land — the writes are serialized', async () => {
    const meta = await writeReplay(capture(), 'x');
    await Promise.all([
      describeReplay(meta.id, { name: 'Speedrun' }),
      describeReplay(meta.id, { player: 'me' }),
      describeReplay(meta.id, { description: 'first exit' }),
    ]);
    const [{ meta: edited }] = await listReplays();
    assert.deepEqual(
      { name: edited.name, player: edited.player, description: edited.description },
      { name: 'Speedrun', player: 'me', description: 'first exit' },
    );
  });

  test('a refused edit does not take the writes queued behind it down', async () => {
    const meta = await writeReplay(capture(), 'x');
    const refused = describeReplay(meta.id, { name: '  ' }).catch(() => 'refused');
    const accepted = describeReplay(meta.id, { player: 'me' });
    assert.equal(await refused, 'refused');
    await accepted;
    const [{ meta: edited }] = await listReplays();
    assert.equal(edited.player, 'me');
  });

  test('deleting removes both records', async () => {
    const meta = await writeReplay(capture(), 'x');
    await deleteReplay(meta.id);
    assert.deepEqual(await listReplays(), []);
    assert.equal(backend.states.size, 0);
  });

  test('a download imports back under a fresh id', async () => {
    const meta = await writeReplay(capture(), 'x');
    const file = await exportReplay(meta.id);
    const parsed = JSON.parse(file);
    assert.equal(parsed.dataEncoding, STATE_ENCODING);
    assert.equal(typeof parsed.data, 'string');
    const imported = await importReplay(file);
    assert.notEqual(imported.id, meta.id);
    assert.equal((await listReplays()).length, 2);
    const replay = await readReplay(imported.id);
    assert.equal(replay.ticCount, 2);
  });

  test('the import refuses what is not a replay, naming a version mismatch', async () => {
    await assert.rejects(importReplay('not json'), /not a TopDoom replay/);
    await assert.rejects(importReplay(JSON.stringify({ version: 99, map: 'MAP01', wads: [], ticCount: 1 })), /version 99/);
    const meta = await writeReplay(capture(), 'x');
    const file = JSON.parse(await exportReplay(meta.id));
    await assert.rejects(importReplay(JSON.stringify({ ...file, data: 'nope' })), /not a TopDoom replay/);
    await assert.rejects(importReplay(JSON.stringify({ ...file, ticCount: 5 })), /not a TopDoom replay/);
    await assert.rejects(importReplay(JSON.stringify({ ...file, dataEncoding: 7 })), /not a TopDoom replay/);
  });

  test('both stored formats carry the version they are pinned at', () => {
    // Both literals here, so moving either is a deliberate act rather than a side effect. The
    // record embeds savegame snapshots, so a `SAVE_VERSION` bump is a replay-format change too —
    // once either has players to orphan. Until then a format change breaks old files and says so
    // when one is opened, and neither number moves. docs/savegames.md § The format and its version.
    assert.deepEqual([SAVE_VERSION, REPLAY_VERSION], [1, 1]);
  });

  test('a replay from another format version lists with its reason and refuses to play', async () => {
    const meta = await writeReplay(capture(), 'old');
    backend.metas.set(meta.id, { ...meta, version: REPLAY_VERSION + 1 });
    const [entry] = await listReplays();
    // The list's red line is the sentence the read would have thrown, so the row says the same
    // thing whether it is looked at or clicked. docs/replays.md § Storage.
    assert.match(entry.refusal ?? '', /format version/);
    await assert.rejects(readReplay(meta.id), new RegExp(entry.refusal ?? ''));
  });

  test('a damaged row lists with a reason of its own, not a version one', async () => {
    const meta = await writeReplay(capture(), 'broken');
    backend.metas.set(meta.id, { ...meta, levels: [] });
    const [entry] = await listReplays();
    assert.match(entry.refusal ?? '', /damaged/);
    await assert.rejects(readReplay(meta.id), /damaged/);
  });

  test('the WAD gate is the savegames’ own', async () => {
    const meta = await writeReplay(capture(), 'x');
    const set = replayWadSet(meta);
    const iwad = { name: 'DOOM2.WAD', id: 'iwad' };
    assert.equal(set.map, 'MAP01');
    // Every level the run visited, which is what the stand-in gate reads.
    assert.deepEqual(set.maps, ['MAP01']);
    assert.equal(wadSetRefusal(set, [iwad], () => iwad), null);
    assert.ok(wadSetRefusal(set, [{ name: 'DOOM.WAD', id: 'other' }], () => null));
  });

  // Last in the file: it leaves the remembered name set, which every later `writeReplay` would
  // then be credited to. docs/replays.md § Recording.
  test('a player entered on one replay credits the recordings after it', async () => {
    const first = await writeReplay(capture(), 'x');
    await describeReplay(first.id, { player: '  Ranger  ' });
    assert.equal((await writeReplay(capture(), 'y')).player, 'Ranger');

    await describeReplay(first.id, { player: '' });
    assert.equal((await writeReplay(capture(), 'z')).player, 'Ranger', 'a cleared field is not remembered');
  });

  test('a written replay is stamped with this build’s simulation epoch, and an unstamped one reads older', async () => {
    const meta = await writeReplay(capture(), 'x');
    assert.equal(meta.compat, COMPAT);
    assert.equal(compatDrift(meta.compat), null, 'what this build recorded runs under this build');

    // What every replay written before the field existed carries: no epoch at all.
    const { compat: _dropped, ...unstamped } = meta;
    backend.metas.set(meta.id, unstamped);
    const [{ meta: listed }] = await listReplays();
    assert.equal(listed.compat, 0);
    assert.equal(compatDrift(listed.compat), 'older', 'and it still lists, and still plays');
    assert.equal((await listReplays())[0].refusal, null);
    assert.equal(compatDrift(COMPAT + 1), 'newer', 'a replay from a later epoch is suspect too');
  });

  test('the download name is safe and recognizable', () => {
    assert.equal(replayFileName('DOOM2 MAP01'), 'DOOM2 MAP01.topdoomreplay.json');
    assert.equal(replayFileName('MAP01 — 3/9/2026, 10:00'), 'MAP01 _ 3_9_2026_ 10_00.topdoomreplay.json');
    assert.equal(replayFileName('   '), 'replay.topdoomreplay.json');
    assert.ok(isReplayFileName('Run.TopDoomReplay.JSON'));
    assert.ok(!isReplayFileName('MAP01-2026-09-03.topdoom.json'));
  });
});
