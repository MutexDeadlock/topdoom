/**
 * The save format: `SAVE_VERSION`, the stored payload around a `GameSnapshot`, named saves and
 * autosaves over the IndexedDB store, and download/import. See docs/savegames.md.
 */
import { roundFloat, type GameSnapshot } from './snapshot.ts';
import { type Skill } from './skill.ts';
import {
  STATE_ENCODING,
  base64ToBytes,
  bytesToBase64,
  compressText,
  decompressText,
  idbBackend,
  type SaveStoreBackend,
  type StoredState,
} from './savestore.ts';

/**
 * The savegame store: one meta record and one gzipped state record per save,
 * both keyed by ID, in `game/savestore.ts`'s IndexedDB backend — split so that
 * listing reads metas alone and never touches a snapshot. Reads are validated
 * per entry in the `besttimes.ts` style, but unlike every other `topdoom.*`
 * value a save carries an explicit `version`, refused (not half-read) on
 * mismatch. docs/savegames.md § Storage.
 */

export const SAVE_VERSION = 1;

/**
 * The checkpoint's reserved ID. An ordinary save under a fixed ID, which is what
 * makes it self-overwriting and needs no field of its own: it is hidden from
 * `listSaves` by *this ID*, not by a `SaveMeta` flag a v1 reader would not know
 * about. docs/savegames.md § The checkpoint.
 *
 * `freshId` can never produce it (base-36 timestamp and counter), so no player
 * save can land on it.
 */
export const AUTOSAVE_ID = 'auto';
/**
 * Never shown anywhere — `createMeta` wants a name, and a blank one would be replaced by the
 * map-and-date default.
 */
const AUTOSAVE_NAME = 'Checkpoint';

/**
 * The IndexedDB backend, created on first touch so importing this module in Node never reaches for
 * `indexedDB`.
 */
let backend: SaveStoreBackend | null = null;
const store = (): SaveStoreBackend => (backend ??= idbBackend());

/** Test seam: replaces the backend with an in-memory one (`tests/game/savegames.test.ts`). */
export function setSaveBackend(replacement: SaveStoreBackend): void {
  backend = replacement;
}

/**
 * One file of a save's WAD set — the two facts a load needs about it, in one
 * record so they cannot disagree: what it must contain, and what to call it
 * when it can't be found. docs/savegames.md § WAD-set identity.
 */
export interface SaveWad {
  /**
   * What the file was called when the save was made. Purely for the player —
   * it names the file to go and find when one is missing, and no lookup keys
   * through it, so a renamed WAD is still found.
   */
  name: string;
  /**
   * `wadId` content hash — **the file's identity**, and what a load matches the
   * library against. Deliberately not the name or a library key: those are
   * addresses that change under a rename or when the same bytes arrive from
   * disk instead of the server. docs/savegames.md § WAD-set identity.
   */
  id: string;
}

/**
 * What to call a saved file in a message; the name is for humans, so it needs a fallback and the ID
 * doesn't.
 */
export function wadLabel(wad: SaveWad): string {
  return wad.name || 'unknown file';
}

/** The identity half of a save's meta: every field the WAD gate reads, and all it reads. */
export type SaveWadSet = Pick<SaveMeta, 'map' | 'wads' | 'mapWad' | 'patchWads'>;

/**
 * Which entries of a save's set a load actually requires back, positionally:
 * the game WAD (`[0]`), and the file `mapWad` names. Everything else supplied
 * textures, sprites or sounds at most — never an index the snapshot keys
 * through — so its absence changes how the level looks, not what it means.
 *
 * A file carrying a `DEHACKED` lump is the exception, and `patchWads` names those: a patch rewrites
 * the stat tables a restore re-derives every monster from, so dropping it would silently change
 * what the save means rather than how it looks. Defaulted to empty for a save written before the
 * field existed — correct for those, which were made by a build that applied no patch.
 * docs/savegames.md § WAD-set identity.
 */
export function requiredWads(wads: SaveWad[], mapWad: string, patchWads: readonly string[] = []): boolean[] {
  const wholeSet = requiresWholeSet(wads, mapWad);
  return wads.map((wad, i) => i === 0 || wad.id === mapWad || wholeSet || patchWads.includes(wad.id));
}

/**
 * Why the assembled set can't play this save, or null when it can — **the load
 * gate itself**, as one function over plain facts rather than over a `Wad`, so
 * the format module owns the rule and nothing has to re-derive it. `actual` is
 * `wadSetId`'s list for the set in hand and `mapProvider` the file supplying
 * `save.map` in it (null when it supplies none).
 *
 * Both callers are the same question asked in two shapes: `main.ts` throws the
 * message on a load, `Game.matchesSession` compares it to null for a
 * checkpoint. docs/savegames.md § WAD-set identity.
 */
export function wadSetRefusal(save: SaveWadSet, actual: SaveWad[], mapProvider: SaveWad | null): string | null {
  if (requiresWholeSet(save.wads, save.mapWad)) {
    if (actual.length !== save.wads.length) {
      return 'the loaded WAD set has a different file count than the one this save was made with';
    }
    const differing = actual.find((file, i) => file.id !== save.wads[i].id);
    return differing ? `${differing.name} differs from the file this save was made with` : null;
  }
  const iwad = actual[0] as SaveWad | undefined;
  if (!iwad || iwad.id !== save.wads[0]?.id) {
    return `${iwad ? iwad.name : 'the game WAD'} differs from the game WAD this save was made with`;
  }
  if (!mapProvider) return `the loaded WADs have no map ${save.map}`;
  if (mapProvider.id !== save.mapWad) {
    return `${mapProvider.name} provides ${save.map}, but not the version this save was made on`;
  }
  // A DEHACKED-carrying file is required back even though it supplied no map lumps: without it
  // every patched stat silently reverts under a save written against it.
  for (const id of save.patchWads ?? []) {
    if (actual.some((file) => file.id === id)) continue;
    const missing = save.wads.find((file) => file.id === id);
    return `${missing ? missing.name : 'a DEHACKED patch'} carries a DEHACKED patch this save was made with`;
  }
  return null;
}

/**
 * One file of a save's set the library can't supply. The role is just the position in `wads`, `[0]`
 * being the game WAD.
 */
export interface MissingWad {
  name: string;
  role: 'IWAD' | 'PWAD';
  /**
   * The library has a file by this name, but not these bytes — worth saying, since "missing" would
   * send the player looking for something they already have.
   */
  wrongVersion: boolean;
  /**
   * Whether the load actually needs this file back: the game WAD and `mapWad`'s provider, nothing
   * else. docs/savegames.md § WAD-set identity.
   */
  required: boolean;
}

/**
 * What a file the library can't supply is called in a **save row**: which file,
 * and what is wrong with it, in no more than a few words plus the name. The row
 * ellipsizes every line it can't fit on one (docs/menu.md § Save and Load tabs),
 * and the label column is only ~55 characters wide, so the advice lives in
 * `missingWadText` instead — where the surfaces showing it have the room.
 */
export function missingWadLabel(file: MissingWad): string {
  if (!file.required) return file.wrongVersion ? `Other version: ${file.name}` : `Not loaded: ${file.name}`;
  return file.wrongVersion ? `Different ${file.role}: ${file.name}` : `Missing ${file.role}: ${file.name}`;
}

/**
 * The label plus what to *do* about it: the load error and the row's tooltip,
 * both of which have a whole line's width. An optional file's clause says
 * outright that the save loads — the label alone would read as a refusal for
 * something that works. Built *from* `missingWadLabel` rather than written out
 * again, so a row and its own tooltip cannot name the same file two ways.
 * docs/savegames.md § WAD-set identity.
 */
export function missingWadText(file: MissingWad): string {
  return `${missingWadLabel(file)} ${adviceFor(file)}`;
}

function adviceFor(file: MissingWad): string {
  if (!file.required) {
    return file.wrongVersion
      ? '— this level plays with the version you have, but content it added may differ'
      : '— this level plays without it, but content it added may be missing';
  }
  return file.wrongVersion ? '— not the version this save was made with' : '— load it from disk first';
}

/**
 * The one file of a set that stops a load, or undefined when the set is playable — what greys Load
 * out and what `loadSave` refuses over.
 */
export function blockingWad(missing: MissingWad[]): MissingWad | undefined {
  return missing.find((file) => file.required);
}

export interface SaveMeta {
  id: string;
  version: number;
  /** ISO date of the save — the list's sort order, newest first. */
  at: string;
  /** User-visible name; defaults to map + local date at save time. */
  name: string;
  /** Map lump name, e.g. `MAP05`. */
  map: string;
  /**
   * Load-bearing for thing identity, not just difficulty — the save's things were filtered by it.
   */
  skill: Skill;
  /**
   * The whole WAD set in load order, `[0]` the game WAD — one list, so a file's name and ID can't
   * drift apart and a file's role is just its position (docs/savegames.md § WAD-set identity).
   */
  wads: SaveWad[];
  /**
   * Content ID of the file that supplied `map`'s lumps. **This, with the game
   * WAD, is what a load requires** — every index a snapshot keys through
   * (sector, `posed`, subsector) comes from that one map, so an add-on which
   * supplied none of it can be absent without the save meaning anything else.
   *
   * `''` names no provider, and then the whole set is required back
   * (`requiresWholeSet`). docs/savegames.md § WAD-set identity.
   */
  mapWad: string;
  /**
   * Content IDs of the files in `wads` that carry a `DEHACKED` lump, if any. Optional: **absent
   * means no patch was applied**, which is what every save written before this field existed
   * meant, so an older save keeps exactly today's looser rule. docs/savegames.md § WAD-set
   * identity, docs/dehacked.md § Savegames and patched tables.
   */
  patchWads?: string[];
  levelTime: number;
  /** JPEG data URL thumbnail, ~320px wide. */
  thumb: string;
}

export interface SaveGame extends SaveMeta {
  state: GameSnapshot;
}

/**
 * What `Game.captureSave` produces — everything but the store's own bookkeeping.
 * `wads` and `mapWad` need nothing added: a save identifies its files by
 * content, which is exactly what `wadSetId` and `wadId` hand back, so `Game`
 * never has to know which library the files were picked from.
 */
export type SaveCapture = Omit<SaveGame, 'id' | 'version' | 'at' | 'name'>;

export interface SaveListEntry {
  meta: SaveMeta;
  /**
   * False for a version this build can't load, or a meta too damaged to trust — still listed so it
   * can be deleted or downloaded. A damaged *state* is invisible here (listing never reads it) and
   * surfaces at load instead.
   */
  supported: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const asSkill = (v: unknown): Skill => (v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 3);

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * One stored WAD entry, each field degraded on its own. Deliberately *mapped*
 * rather than filtered: `wads` is in load order and `[0]` is the game WAD, so
 * dropping a damaged entry would silently shift every file after it into the
 * wrong role. A blanked entry instead fails loudly — an empty ID matches
 * nothing in the library, so the file is reported as one to go and find.
 */
const asWad = (v: unknown): SaveWad => {
  const w = isRecord(v) ? v : {};
  return { name: asText(w.name), id: asText(w.id) };
};

/**
 * Best-effort meta for the list; every field degrades to something displayable rather than failing
 * the whole row.
 */
function asMeta(raw: unknown, id: string): SaveMeta {
  const r = isRecord(raw) ? raw : {};
  return {
    id,
    version: typeof r.version === 'number' ? r.version : 0,
    at: asText(r.at),
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name : '(unreadable save)',
    map: typeof r.map === 'string' ? r.map : '?',
    skill: asSkill(r.skill),
    wads: Array.isArray(r.wads) ? r.wads.map(asWad) : [],
    mapWad: asText(r.mapWad),
    // Absent for every save written before the field existed, which is the right reading: those
    // were made by a build that applied no patch. docs/dehacked.md § Savegames and patched tables.
    ...(Array.isArray(r.patchWads) ? { patchWads: r.patchWads.filter((v) => typeof v === 'string') } : {}),
    levelTime: typeof r.levelTime === 'number' ? r.levelTime : 0,
    thumb: asText(r.thumb),
  };
}

/**
 * The meta half of loadability — everything checkable without the state record
 * in hand, which is all a listing ever sees. Deliberately says nothing about
 * `mapWad`: a save without one is still perfectly loadable, since a blank only
 * makes the WAD gate stricter (`requiresWholeSet`).
 */
function hasLoadableMeta(raw: unknown): boolean {
  return isRecord(raw) && raw.version === SAVE_VERSION && typeof raw.map === 'string' && Array.isArray(raw.wads);
}

/**
 * The state half: without these the restore path would crash mid-load. Checked wherever a snapshot
 * is actually decoded.
 */
function isLoadableState(state: unknown): state is GameSnapshot {
  return isRecord(state) && isRecord(state.player) && isRecord(state.rng);
}

/**
 * The stored meta for `id`, or a thrown refusal — the shared opening of every read-modify-write
 * below.
 */
async function readMeta(id: string): Promise<unknown> {
  const raw = await store().readMeta(id);
  if (raw === undefined) throw new Error('that save no longer exists');
  return raw;
}

/**
 * Every stored save, newest first, unsupported versions included (marked, not
 * hidden). Reads metas only — never a state. The checkpoint is the one row
 * dropped outright: it is the engine's, not the player's, and both tabs list
 * through here, so one filter keeps it out of Save and Load alike.
 */
export async function listSaves(): Promise<SaveListEntry[]> {
  const raws = await store().listMeta();
  const entries = raws
    .map((raw) => {
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '';
      return { meta: asMeta(raw, id), supported: hasLoadableMeta(raw) };
    })
    .filter((entry) => entry.meta.id !== AUTOSAVE_ID);
  return entries.sort((a, b) => b.meta.at.localeCompare(a.meta.at));
}

const damaged = (): Error => new Error('this save is damaged and cannot be loaded');

/**
 * The full save, or a thrown, user-readable refusal — an unsupported version names both versions
 * rather than half-loading.
 */
export async function readSave(id: string): Promise<SaveGame> {
  const rawMeta = await readMeta(id);
  if (isRecord(rawMeta) && rawMeta.version !== SAVE_VERSION) {
    throw new Error(`this save uses format version ${String(rawMeta.version)}; this build loads version ${SAVE_VERSION}`);
  }
  if (!hasLoadableMeta(rawMeta)) throw damaged();
  const record = await store().readState(id);
  if (!record || record.encoding !== STATE_ENCODING) throw damaged();
  let state: unknown;
  try {
    state = JSON.parse(await decompressText(record.bytes));
  } catch {
    throw damaged();
  }
  if (!isLoadableState(state)) throw damaged();
  return { ...asMeta(rawMeta, id), state };
}

/**
 * The one place a snapshot is serialized, so `roundFloat` is applied exactly where the bytes it
 * saves are counted.
 */
async function encodeState(id: string, state: GameSnapshot): Promise<StoredState> {
  return { id, encoding: STATE_ENCODING, bytes: await compressText(JSON.stringify(state, roundFloat)) };
}

/**
 * The one write of a whole save: both records in the backend's single
 * transaction, with a quota refusal — the only failure a player can act on —
 * translated to a readable message. Mapped here rather than in the backend so
 * the tests' in-memory backend exercises the same translation.
 */
async function putSave(meta: SaveMeta, state: StoredState): Promise<void> {
  try {
    await store().putSave(meta, state);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      throw new Error('not enough browser storage for this save — delete an older save and try again');
    }
    throw err;
  }
}

/**
 * Session-scoped tiebreaker for saves landing in the same millisecond; uniqueness is checked
 * against the stored IDs anyway.
 */
let idCounter = 0;

/**
 * Deliberately entropy-free — the engine's one randomness source is the DOOM table
 * (docs/random.md), and a save ID needs uniqueness, not randomness.
 */
async function freshId(): Promise<string> {
  const existing = new Set((await store().listMeta()).map((raw) => (isRecord(raw) ? raw.id : undefined)));
  let id: string;
  do {
    id = Date.now().toString(36) + '-' + (idCounter++).toString(36);
  } while (existing.has(id));
  return id;
}

/** What an unnamed save is called: the map and when it was taken. */
const defaultName = (map: string): string => `${map} — ${new Date().toLocaleString()}`;

/**
 * Owns the naming rule for both writers: a blank (or all-whitespace) name falls
 * back to `defaultName`. `levelTime` is rounded here — the meta is stored as an
 * object, where digits cost nothing, but the export file stringifies it without
 * a replacer.
 */
function createMeta(id: string, name: string, capture: SaveCapture): SaveMeta {
  const { state: _state, ...rest } = capture;
  return {
    ...rest,
    id,
    version: SAVE_VERSION,
    at: new Date().toISOString(),
    name: name.trim() || defaultName(capture.map),
    levelTime: Math.round(capture.levelTime * 1e6) / 1e6,
  };
}

/** Stores a fresh capture under a new ID; throws (readably) at the storage quota. */
export async function writeSave(capture: SaveCapture, name: string): Promise<SaveMeta> {
  const meta = createMeta(await freshId(), name, capture);
  await putSave(meta, await encodeState(meta.id, capture.state));
  return meta;
}

/**
 * Refills an existing save from a fresh capture, keeping its ID and its name —
 * an overwrite replaces a slot's contents, and the name is the slot's label
 * (changed on its own through `renameSave`).
 */
export async function overwriteSave(id: string, capture: SaveCapture): Promise<SaveMeta> {
  const previous = await readMeta(id);
  // A damaged row can still be overwritten — it just can't lend its name.
  const kept = isRecord(previous) && typeof previous.name === 'string' ? previous.name : '';
  const meta = createMeta(id, kept, capture);
  await putSave(meta, await encodeState(id, capture.state));
  return meta;
}

/**
 * What `Game` is handed so it can keep a checkpoint without ever reaching for
 * the store itself — the same split as `SaveHooks`: the session (main.ts) owns
 * the library and the database, `Game` owns the moment worth capturing.
 */
export interface CheckpointStore {
  write(capture: SaveCapture): Promise<void>;
  read(): Promise<SaveGame | null>;
}

/**
 * Replaces the checkpoint with a fresh capture: the ID is the engine's own, so
 * the same key replaces both records and there is only ever one.
 * docs/savegames.md § The checkpoint.
 */
export async function writeAutosave(capture: SaveCapture): Promise<void> {
  const meta = createMeta(AUTOSAVE_ID, AUTOSAVE_NAME, capture);
  await putSave(meta, await encodeState(AUTOSAVE_ID, capture.state));
}

/**
 * The checkpoint, or `null` when there isn't a usable one — missing, damaged,
 * or written by a build with a different `SAVE_VERSION`. Every refusal
 * `readSave` throws collapses to `null` here: nothing in this path is worth a
 * message, because the caller's fallback (an ordinary restart) is a perfectly
 * good outcome. docs/savegames.md § The checkpoint.
 */
export async function readAutosave(): Promise<SaveGame | null> {
  try {
    return await readSave(AUTOSAVE_ID);
  } catch {
    return null;
  }
}

/**
 * Renames a save in place, leaving its `at` — so the list doesn't reorder under
 * the cursor — untouched, and never rewriting the state record at all: the name
 * is the only field the menu lets anyone edit, and renaming several saves in a
 * row is the one path a player repeats. A row too damaged to parse is refused
 * rather than replaced by a bare `{ name }`.
 */
export async function renameSave(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('a save needs a name');
  const raw = await readMeta(id);
  if (!isRecord(raw)) throw new Error('this save is damaged and cannot be renamed');
  await store().putMeta({ ...raw, name: trimmed });
}

export async function deleteSave(id: string): Promise<void> {
  await store().remove(id);
}

/**
 * The download file, tab-indented: the meta fields stay something a person can
 * open and read, while `state` travels as the stored gzip bytes, base64'd —
 * compressed-plus-base64 is still far smaller than the snapshot's plain JSON.
 * Deliberately *not* `readSave`, and deliberately no decompression: downloading
 * is how an unsupported-version — or even undecompressable — save escapes to
 * disk, so the bytes are handed over verbatim with their `stateEncoding` and
 * the stored `version` intact (only `importSave` ever stamps `SAVE_VERSION`).
 * Only a save whose state record is missing outright has nothing to hand over.
 */
export async function exportSave(id: string): Promise<string> {
  const rawMeta = await readMeta(id);
  const record = await store().readState(id);
  if (!record) throw new Error('this save is missing its data and cannot be downloaded');
  const file = {
    ...asMeta(rawMeta, id),
    stateEncoding: record.encoding,
    state: bytesToBase64(record.bytes),
  };
  return JSON.stringify(file, null, '\t');
}

/**
 * Validates a downloaded save's JSON and stores it under a fresh ID (never the
 * embedded one — importing the same file twice must not overwrite). Same
 * version strictness as `readSave`: an old-format file is refused with both
 * versions named, not stored as a dead row. The embedded state is fully decoded
 * here — the one moment a foreign file's bytes are in hand — and then stored
 * *as decoded*, byte-exact, rather than recompressed.
 */
export async function importSave(text: string): Promise<SaveMeta> {
  const refusal = (): Error => new Error('that file is not a TopDoom save');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw refusal();
  }
  if (isRecord(raw) && typeof raw.version === 'number' && raw.version !== SAVE_VERSION) {
    throw new Error(`this save uses format version ${raw.version}; this build loads version ${SAVE_VERSION}`);
  }
  if (!hasLoadableMeta(raw)) throw refusal();
  const record = raw as Record<string, unknown>;
  if (typeof record.state !== 'string' || record.stateEncoding !== STATE_ENCODING) throw refusal();
  let bytes: Uint8Array<ArrayBuffer>;
  let state: unknown;
  try {
    bytes = base64ToBytes(record.state);
    state = JSON.parse(await decompressText(bytes));
  } catch {
    throw refusal();
  }
  if (!isLoadableState(state)) throw refusal();
  // `asMeta` supplies every meta field, so nothing of the file's own top level
  // is spread in: an imported file must not smuggle extra keys into storage.
  const meta: SaveMeta = { ...asMeta(raw, await freshId()), version: SAVE_VERSION };
  await putSave(meta, { id: meta.id, encoding: STATE_ENCODING, bytes });
  return meta;
}

/**
 * Whether this save falls back to demanding its **whole** set: its `mapWad` is
 * blank, or names a file the set doesn't have. The **one** definition of that
 * condition — every gate reads it, so none of them can disagree about
 * which saves are in the narrow regime, and an unusable field can then only
 * ever be too strict. docs/savegames.md § WAD-set identity.
 */
function requiresWholeSet(wads: SaveWad[], mapWad: string): boolean {
  return mapWad === '' || !wads.some((wad) => wad.id === mapWad);
}
