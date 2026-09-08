/**
 * Replays: a level's state plus one input record per tic, played back through the same
 * simulation. This is the layer's public entry — the format, the recorder and the playback are
 * `replay/`'s; this file owns the store (over `savestore.ts`'s backend, in its own database), the
 * download/import file and the persisted player name. docs/replays.md.
 */
import { VERSION } from '../constants.ts';
import { readStorage, writeStorageSoon } from '../util/storage.ts';
import {
  asNumber,
  asSkill,
  asText,
  asWad,
  defaultName,
  downloadFileName,
  isDownloadFileName,
  isLoadableState,
  isRecord,
} from './savegames.ts';
import {
  STATE_ENCODING,
  base64ToBytes,
  bytesToBase64,
  compressText,
  decompressText,
  freshId as freshStoredId,
  idbBackend,
  putStored,
  readStoredMeta,
  type SaveStoreBackend,
  type StoredState,
} from './savestore.ts';
import {
  COMPAT,
  REPLAY_VERSION,
  describeEngine,
  packTics,
  replayMap,
  unpackTics,
  type Replay,
  type ReplayCapture,
  type ReplayData,
  type ReplayListEntry,
  type ReplayMeta,
} from './replay/defs.ts';

import { fetchStockManifest, fetchStockReplay, isStockReplay, stockReplayId } from './replay/stock.ts';

export { replayMap, replayWadSet } from './replay/defs.ts';
export { isStockReplay } from './replay/stock.ts';

export type {
  Keyframe,
  LevelMarker,
  Replay,
  ReplayCapture,
  ReplayData,
  ReplayEvent,
  ReplayListEntry,
  ReplayMeta,
  SimSettings,
  TicColumns,
} from './replay/defs.ts';
export {
  BUTTON_FIRE,
  BUTTON_RIGHT_EDGE,
  CHECK_INTERVAL,
  COMPAT,
  KEYFRAME_INTERVAL,
  NORMAL_SPEED_INDEX,
  POSE_QUANTUM,
  REPLAY_VERSION,
  SPEED_STEPS,
  compatDrift,
  describeEngine,
  poseAt,
  positionFraction,
  quantizePose,
  replaySeconds,
  replayTics,
  unpackTics,
  speedAt,
  ticAtFraction,
} from './replay/defs.ts';
export { BOUND_KEYS, maskHas } from './replay/keys.ts';
export { ReplayPlayback } from './replay/playback.ts';
export { ReplayRecorder, type RecordingStart } from './replay/recorder.ts';
export { applySimSettings, captureSimSettings, releaseSimSettings } from './replay/settings.ts';

/** The fields a row lets the player edit in place. */
export type ReplayDescription = Partial<Pick<ReplayMeta, 'name' | 'description' | 'player'>>;

const PLAYER_NAME_STORAGE_KEY = 'playerName';

/**
 * The name a new recording is credited to: whatever a replay's Player field was last filled in
 * with (`describeReplay`), so it is entered once and inherited afterwards. Shaped like every
 * persisted setting — docs/menu.md § Persisted settings.
 */
let playerName = readStorage(PLAYER_NAME_STORAGE_KEY, '');

/** Replays keep their own database beside the saves' — docs/replays.md § Storage. */
let backend: SaveStoreBackend | null = null;
const store = (): SaveStoreBackend => (backend ??= idbBackend({ database: 'topdoom-replays', prefix: 'replays' }));

/** Test seam: replaces the backend with an in-memory one (`tests/game/replaystore.test.ts`). */
export function setReplayBackend(replacement: SaveStoreBackend): void {
  backend = replacement;
}

/** This build and browser, as a replay records them — what a mismatch is measured against. */
export function currentEngine(): string {
  return describeEngine(typeof navigator === 'undefined' ? '' : navigator.userAgent);
}

/** Every stored replay, newest first; a damaged row still lists so it can be deleted. */
export async function listReplays(): Promise<ReplayListEntry[]> {
  const raws = await store().listMeta();
  return listing(raws.map((raw) => ({ raw, id: isRecord(raw) && typeof raw.id === 'string' ? raw.id : '' })));
}

/**
 * Every replay served from `public/game/replay/`, newest first — the ones the engine ships rather
 * than the ones this browser recorded. Read through the store's own degradation, so a stock file
 * this build can't play lists with the sentence saying why. docs/replays.md § Stock replays.
 */
export async function listStockReplays(): Promise<ReplayListEntry[]> {
  const entries = await fetchStockManifest();
  return listing(entries.map((entry) => ({ raw: entry.meta, id: stockReplayId(entry.file) })));
}

/**
 * Why this build cannot read a replay written in `version` — one sentence, shown wherever an
 * unplayable replay is: `readReplay`'s refusal, `importReplay`'s, and the list's own red line.
 */
export function versionRefusal(version: unknown): string {
  return `this replay uses format version ${String(version)}; this build plays version ${REPLAY_VERSION}`;
}

/**
 * The whole replay, or a thrown, user-readable refusal — from the store, or from the served folder
 * for a stock row (docs/replays.md § Stock replays). One id space, so nothing above this call has
 * to know which of the two a replay came from.
 */
export async function readReplay(id: string): Promise<Replay> {
  if (isStockReplay(id)) return readStock(id);
  const rawMeta = await readMeta(id);
  const refused = metaRefusal(rawMeta);
  if (refused !== null) throw new Error(refused);
  const record = await store().readState(id);
  if (!record || record.encoding !== STATE_ENCODING) throw damaged();
  let data: unknown;
  try {
    data = JSON.parse(await decompressText(record.bytes));
  } catch {
    throw damaged();
  }
  const meta = asReplayMeta(rawMeta, id);
  if (!isPlayableData(data, meta.ticCount)) throw damaged();
  return { ...meta, data: { ...data, tics: unpackTics(data.tics) } };
}

/**
 * Stores a finished recording under a fresh ID, stamping what only the storing moment knows: the
 * date, this build, this browser's engine and the player name. A blank name gets `defaultName`'s,
 * the saves' own.
 */
export async function writeReplay(capture: ReplayCapture, name: string): Promise<ReplayMeta> {
  const { data, ...rest } = capture;
  const meta: ReplayMeta = {
    ...rest,
    id: await freshId(),
    version: REPLAY_VERSION,
    at: new Date().toISOString(),
    name: name.trim() || defaultName({ map: replayMap(capture), wads: capture.wads, mapWad: capture.mapWad }),
    description: '',
    player: playerName,
    build: VERSION,
    compat: COMPAT,
    engine: currentEngine(),
  };
  await putReplay(meta, await encodeData(meta.id, data));
  return meta;
}

/**
 * Patches the editable fields, meta only — the record's bytes are never rewritten. Serialized
 * against every other call (`patchQueue`): a row has three fields, and leaving one is enough to
 * start a second read-modify-write while the first is still in flight, where both would read the
 * same stored meta and the later write would drop the earlier field.
 */
export async function describeReplay(id: string, fields: ReplayDescription): Promise<void> {
  if (isStockReplay(id)) throw new Error(stockText);
  const patch: ReplayDescription = {};
  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (!name) throw new Error('a replay needs a name');
    patch.name = name;
  }
  if (fields.description !== undefined) patch.description = fields.description.trim();
  if (fields.player !== undefined) {
    patch.player = fields.player.trim();
    rememberPlayerName(patch.player);
  }
  return queued(async () => {
    const raw = await readMeta(id);
    if (!isRecord(raw)) throw new Error('this replay is damaged and cannot be edited');
    await store().putMeta({ ...raw, ...patch });
  });
}

export async function deleteReplay(id: string): Promise<void> {
  if (isStockReplay(id)) throw new Error(stockText);
  await store().remove(id);
}

/** The download file: the meta in the clear, the record as its stored gzip bytes, base64'd. */
export async function exportReplay(id: string): Promise<string> {
  // A stock replay already *is* such a file, so it is handed over unchanged — nothing is re-encoded
  // and a downloaded copy is byte-identical to the served one.
  if (isStockReplay(id)) return fetchStockReplay(id);
  const [rawMeta, record] = await Promise.all([readMeta(id), store().readState(id)]);
  if (!record) throw new Error('this replay is missing its data and cannot be downloaded');
  const file = { ...asReplayMeta(rawMeta, id), dataEncoding: record.encoding, data: bytesToBase64(record.bytes) };
  return JSON.stringify(file, null, '\t');
}

/** `<name>.topdoomreplay.json` — a downloaded replay, `saveFileName`'s twin. */
export function replayFileName(name: string): string {
  return downloadFileName(name, 'replay');
}

/** Whether a dropped or picked file is a replay download rather than a save's. */
export function isReplayFileName(name: string): boolean {
  return isDownloadFileName(name, 'replay');
}

/**
 * Validates a downloaded replay and stores it under a fresh ID; the record is decoded here, the
 * one moment a foreign file's bytes are in hand, and stored as decoded rather than recompressed.
 */
export async function importReplay(text: string): Promise<ReplayMeta> {
  const { meta, bytes } = await decodeFile(text, 'that file is not a TopDoom replay');
  const stored: ReplayMeta = { ...meta, id: await freshId() };
  await putReplay(stored, { id: stored.id, encoding: STATE_ENCODING, bytes });
  return stored;
}

/**
 * Carries a name entered on one replay over to the next recording. Blank is not remembered:
 * clearing one row's credit drops that row's, not the name every later replay would carry.
 */
function rememberPlayerName(name: string): void {
  if (!name || name === playerName) return;
  playerName = name;
  writeStorageSoon(PLAYER_NAME_STORAGE_KEY, name);
}

const damagedText = 'this replay is damaged and cannot be played';
const damaged = (): Error => new Error(damagedText);

/** Why a stock replay refuses an edit or a delete — the two things a served file cannot do. */
const stockText = 'this replay ships with TopDoom: it can be played and downloaded, but not changed';

/** A served replay, fetched and decoded — never stored, so watching one leaves nothing behind. */
async function readStock(id: string): Promise<Replay> {
  const { meta, data } = await decodeFile(await fetchStockReplay(id), damagedText);
  return { ...meta, id, data: { ...data, tics: unpackTics(data.tics) } };
}

/**
 * A download file validated into a replay: the import's path and a stock file's, which are the two
 * ways a record reaches this build from outside the store. `message` is what a shape this build
 * cannot read is called where the caller stands — a foreign file is "not a TopDoom replay", a
 * served one is damaged — while a version mismatch says so in its own words either way. The
 * returned `data` is still the stored form; `id` is the caller's to settle.
 */
async function decodeFile(
  text: string,
  message: string,
): Promise<{ meta: ReplayMeta; data: ReplayData; bytes: Uint8Array<ArrayBuffer> }> {
  const refusal = (): Error => new Error(message);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw refusal();
  }
  if (isRecord(raw) && typeof raw.version === 'number' && raw.version !== REPLAY_VERSION) {
    throw new Error(versionRefusal(raw.version));
  }
  // The file's own shape refusal, not the stored row's: a file this build cannot read is the
  // caller's own sentence whatever is wrong with it beyond the version above.
  if (metaRefusal(raw) !== null) throw refusal();
  const record = raw as Record<string, unknown>;
  if (typeof record.data !== 'string' || record.dataEncoding !== STATE_ENCODING) throw refusal();
  let bytes: Uint8Array<ArrayBuffer>;
  let data: unknown;
  try {
    bytes = base64ToBytes(record.data);
    data = JSON.parse(await decompressText(bytes));
  } catch {
    throw refusal();
  }
  const meta: ReplayMeta = { ...asReplayMeta(raw, ''), version: REPLAY_VERSION };
  if (!isPlayableData(data, meta.ticCount)) throw refusal();
  return { meta, data, bytes };
}

/**
 * Raw metas as the two lists hand them over, newest first — the store's rows and the served
 * folder's, which differ only in where the id comes from. A damaged one still gets a row, carrying
 * the sentence saying why.
 */
function listing(raws: { raw: unknown; id: string }[]): ReplayListEntry[] {
  return raws
    .map(({ raw, id }) => ({ meta: asReplayMeta(raw, id), refusal: metaRefusal(raw) }))
    .sort((a, b) => b.meta.at.localeCompare(a.meta.at));
}

/** Best-effort meta for the list; every field degrades to something displayable. */
function asReplayMeta(raw: unknown, id: string): ReplayMeta {
  const r = isRecord(raw) ? raw : {};
  const levels = Array.isArray(r.levels) ? r.levels : [];
  return {
    id,
    version: asNumber(r.version),
    at: asText(r.at),
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name : '(unreadable replay)',
    description: asText(r.description),
    player: asText(r.player),
    build: asText(r.build),
    // 0 for a replay written before the epoch was recorded — older than any of them, which is
    // exactly what such a replay is (`compatDrift`).
    compat: asNumber(r.compat),
    engine: asText(r.engine),
    skill: asSkill(r.skill),
    wads: Array.isArray(r.wads) ? r.wads.map(asWad) : [],
    mapWad: asText(r.mapWad),
    ...(Array.isArray(r.patchWads) ? { patchWads: r.patchWads.filter((v) => typeof v === 'string') } : {}),
    ticCount: asNumber(r.ticCount),
    levels: levels
      .filter((l): l is Record<string, unknown> => isRecord(l))
      .map((l) => ({ tic: asNumber(l.tic), map: asText(l.map) })),
  };
}

/** The meta half of playability — everything a listing can check without the record. */
function metaRefusal(raw: unknown): string | null {
  if (!isRecord(raw)) return damagedText;
  if (raw.version !== REPLAY_VERSION) return versionRefusal(raw.version);
  const whole =
    Array.isArray(raw.levels) && raw.levels.length > 0 && Array.isArray(raw.wads) && typeof raw.ticCount === 'number';
  return whole ? null : damagedText;
}

/**
 * One snapshot's thing list, in either of the two forms `ThingsSnapshot` allows. Checked for every
 * snapshot, not just the one `isLoadableState` sees: a keyframe is restored the same way, and a
 * malformed list is what a restore would crash on rather than refuse over.
 */
function hasThingList(snapshot: unknown): boolean {
  const things = isRecord(snapshot) && isRecord(snapshot.things) ? snapshot.things : null;
  return things !== null && Array.isArray(things.changed);
}

/** The record half: what the playback would crash without. */
function isPlayableData(data: unknown, ticCount: number): data is ReplayData {
  if (!isRecord(data) || !Array.isArray(data.snapshots) || !isLoadableState(data.snapshots[0])) return false;
  if (!data.snapshots.every(hasThingList)) return false;
  if (!isRecord(data.tics) || !isRecord(data.settings)) return false;
  // The seek anchors, `[0]` the start the level is built from — every playback needs that one.
  const keyframes = data.keyframes;
  if (!Array.isArray(keyframes) || !isRecord(keyframes[0]) || keyframes[0].tic !== 0) return false;
  const snapshots = data.snapshots;
  for (const frame of keyframes) {
    if (!isRecord(frame) || typeof frame.map !== 'string') return false;
    if (!isRecord(snapshots[frame.snapshot as number])) return false;
  }
  const tics = data.tics;
  // The input columns, then the camera the tic ran at, without which the playback would have to
  // recompute it.
  const columns = ['held', 'pressed', 'buttons', 'wheel', 'aimX', 'aimY', 'poseYaw', 'poseX', 'poseY', 'poseZ', 'poseDistance', 'poseTilt'];
  for (const column of columns) {
    if (!Array.isArray(tics[column]) || tics[column].length !== ticCount) return false;
  }
  return Array.isArray(data.typed) && Array.isArray(data.events) && Array.isArray(data.checks);
}

/** The tail of the serialized meta writes; a rejection must not poison the ones behind it. */
let patchQueue: Promise<unknown> = Promise.resolve();

/** Runs `action` after every call already queued, and hands back its own result. */
function queued<T>(action: () => Promise<T>): Promise<T> {
  const result = patchQueue.then(action, action);
  patchQueue = result.catch(() => undefined);
  return result;
}

const readMeta = (id: string): Promise<unknown> => readStoredMeta(store(), 'replay', id);
const putReplay = (meta: ReplayMeta, data: StoredState): Promise<void> => putStored(store(), 'replay', meta, data);
const freshId = (): Promise<string> => freshStoredId(store());

/**
 * Serialized without the savegames' float rounding: a replay's snapshots must restore the exact
 * state the recording ran on, and a shortest-roundtrip double reads back bit-identical.
 */
async function encodeData(id: string, data: ReplayData): Promise<StoredState> {
  const stored = { ...data, tics: packTics(data.tics) };
  return { id, encoding: STATE_ENCODING, bytes: await compressText(JSON.stringify(stored)) };
}
