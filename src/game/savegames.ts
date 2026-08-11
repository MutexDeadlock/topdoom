import type { GameSnapshot } from './snapshot.ts';
import { type Skill } from './skill.ts';

/**
 * The savegame store: one localStorage key per save under `topdoom.save.<id>`,
 * listed by prefix scan — no index key that could desync, deletion is one
 * `removeItem`. Reads are validated per entry in the `besttimes.ts` style, but
 * unlike every other `topdoom.*` key a save carries an explicit `version`,
 * refused (not half-read) on mismatch. docs/savegames.md § Storage and the cap.
 */

export const SAVE_VERSION = 1;
/** The store refuses a write past this rather than evicting — deleting somebody's save silently is worse than asking. */
export const MAX_SAVES = 24;
const KEY_PREFIX = 'topdoom.save.';

export interface SaveMeta {
  id: string;
  version: number;
  /** ISO date of the save — the list's sort order, newest first. */
  at: string;
  /** User-visible name; defaults to map + local date at save time. */
  name: string;
  /** Map lump name, e.g. `MAP05`. */
  map: string;
  /** Load-bearing for thing identity, not just difficulty — the save's things were filtered by it. */
  skill: Skill;
  /** `wadSetId(wad)` in load order, `[0]` the game WAD — verified file by file on load (docs/savegames.md § WAD-set identity). */
  wads: { name: string; id: string }[];
  /** The menu `WadSource.key`s the set was assembled from, to re-resolve the files from the library. */
  sourceKeys: { iwad: string; pwads: string[] };
  levelTime: number;
  /** Player health at save time — display only. */
  health: number;
  /** JPEG data URL thumbnail, ~320px wide. */
  thumb: string;
}

export interface SaveGame extends SaveMeta {
  state: GameSnapshot;
}

/** What `Game.captureSave` produces — everything but the store's own bookkeeping and the menu's source keys. */
export type SaveCapture = Omit<SaveGame, 'id' | 'version' | 'at' | 'name' | 'sourceKeys'>;

export interface SaveListEntry {
  meta: SaveMeta;
  /** False for a version this build can't load, or an entry too damaged to trust — still listed so it can be deleted or downloaded. */
  supported: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const asSkill = (v: unknown): Skill => (v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 3);

/** Best-effort meta for the list; every field degrades to something displayable rather than failing the whole row. */
function asMeta(raw: unknown, id: string): SaveMeta {
  const r = isRecord(raw) ? raw : {};
  const sk = isRecord(r.sourceKeys) ? r.sourceKeys : {};
  return {
    id,
    version: typeof r.version === 'number' ? r.version : 0,
    at: typeof r.at === 'string' ? r.at : '',
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name : '(unreadable save)',
    map: typeof r.map === 'string' ? r.map : '?',
    skill: asSkill(r.skill),
    wads: Array.isArray(r.wads)
      ? r.wads.filter((w): w is { name: string; id: string } => isRecord(w) && typeof w.name === 'string' && typeof w.id === 'string')
      : [],
    sourceKeys: {
      iwad: typeof sk.iwad === 'string' ? sk.iwad : '',
      pwads: Array.isArray(sk.pwads) ? sk.pwads.filter((p): p is string => typeof p === 'string') : [],
    },
    levelTime: typeof r.levelTime === 'number' ? r.levelTime : 0,
    health: typeof r.health === 'number' ? r.health : 0,
    thumb: typeof r.thumb === 'string' ? r.thumb : '',
  };
}

/** The shape check `readSave`/`importSave` insist on beyond the meta: without these the restore path would crash mid-load. */
function isLoadable(raw: unknown): raw is SaveGame {
  return (
    isRecord(raw) &&
    raw.version === SAVE_VERSION &&
    typeof raw.map === 'string' &&
    Array.isArray(raw.wads) &&
    isRecord(raw.state) &&
    isRecord((raw.state as Record<string, unknown>).player) &&
    isRecord((raw.state as Record<string, unknown>).rng)
  );
}

function saveKeys(): string[] {
  const storage = globalThis.localStorage;
  if (!storage) return [];
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Every stored save, newest first, unsupported versions included (marked, not hidden). */
export function listSaves(): SaveListEntry[] {
  const entries: SaveListEntry[] = [];
  for (const key of saveKeys()) {
    const id = key.slice(KEY_PREFIX.length);
    let raw: unknown = null;
    try {
      raw = JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null');
    } catch {
      // fall through: asMeta on null renders the row as unreadable
    }
    entries.push({ meta: asMeta(raw, id), supported: isLoadable(raw) });
  }
  return entries.sort((a, b) => b.meta.at.localeCompare(a.meta.at));
}

/** The full save, or a thrown, user-readable refusal — an unsupported version names both versions rather than half-loading. */
export function readSave(id: string): SaveGame {
  const text = globalThis.localStorage?.getItem(KEY_PREFIX + id);
  if (!text) throw new Error('that save no longer exists');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('this save is damaged and cannot be loaded');
  }
  if (isRecord(raw) && raw.version !== SAVE_VERSION) {
    throw new Error(`this save uses format version ${String(raw.version)}; this build loads version ${SAVE_VERSION}`);
  }
  if (!isLoadable(raw)) throw new Error('this save is damaged and cannot be loaded');
  return { ...raw, id };
}

function put(id: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(KEY_PREFIX + id, JSON.stringify(value));
  } catch {
    // Overwhelmingly QuotaExceededError — the origin's ~5 MB budget, shared
    // with everything else this site stores.
    throw new Error('not enough browser storage for this save — delete an older save and try again');
  }
}

/** `put` plus the cap, which only a *new* key can hit — replacing one adds nothing to the count. */
function store(save: SaveGame): void {
  if (saveKeys().length >= MAX_SAVES) {
    throw new Error(`the save list is full (${MAX_SAVES}) — delete a save first`);
  }
  put(save.id, save);
}

/** Session-scoped tiebreaker for saves landing in the same millisecond; uniqueness is checked against the stored keys anyway. */
let idCounter = 0;

/** Deliberately entropy-free — the engine's one randomness source is the DOOM table (docs/random.md), and a save id needs uniqueness, not randomness. */
function freshId(): string {
  const existing = new Set(saveKeys());
  let id: string;
  do {
    id = Date.now().toString(36) + '-' + (idCounter++).toString(36);
  } while (existing.has(KEY_PREFIX + id));
  return id;
}

/** What an unnamed save is called: the map and when it was taken. */
const defaultName = (map: string): string => `${map} — ${new Date().toLocaleString()}`;

/** Stores a fresh capture under a new id; throws (readably) at the cap or the storage quota. */
export function writeSave(capture: SaveCapture, name: string, sourceKeys: SaveMeta['sourceKeys']): SaveMeta {
  const at = new Date().toISOString();
  const save: SaveGame = {
    ...capture,
    id: freshId(),
    version: SAVE_VERSION,
    at,
    name: name.trim() || defaultName(capture.map),
    sourceKeys,
  };
  store(save);
  const { state: _state, ...meta } = save;
  return meta;
}

/**
 * Refills an existing save from a fresh capture, keeping its id and its name —
 * an overwrite replaces a slot's contents, and the name is the slot's label
 * (changed on its own through `renameSave`). Deliberately not `store`: no new
 * key appears, so the cap can't refuse an overwrite even when the list is full.
 */
export function overwriteSave(id: string, capture: SaveCapture, sourceKeys: SaveMeta['sourceKeys']): SaveMeta {
  const text = globalThis.localStorage?.getItem(KEY_PREFIX + id);
  if (!text) throw new Error('that save no longer exists');
  let previous: unknown = null;
  try {
    previous = JSON.parse(text);
  } catch {
    // A damaged row can still be overwritten — it just can't lend its name.
  }
  const kept = isRecord(previous) && typeof previous.name === 'string' ? previous.name : '';
  const save: SaveGame = {
    ...capture,
    id,
    version: SAVE_VERSION,
    at: new Date().toISOString(),
    name: kept || defaultName(capture.map),
    sourceKeys,
  };
  put(save.id, save);
  const { state: _state, ...meta } = save;
  return meta;
}

/**
 * Renames a save in place, leaving its payload — and its `at`, so the list
 * doesn't reorder under the cursor — untouched. The name is the only field the
 * menu lets anyone edit; a row too damaged to parse is refused rather than
 * replaced by a bare `{ name }`.
 */
export function renameSave(id: string, name: string): void {
  const text = globalThis.localStorage?.getItem(KEY_PREFIX + id);
  if (!text) throw new Error('that save no longer exists');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('a save needs a name');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (!isRecord(raw)) throw new Error('this save is damaged and cannot be renamed');
  put(id, { ...raw, name: trimmed });
}

export function deleteSave(id: string): void {
  globalThis.localStorage?.removeItem(KEY_PREFIX + id);
}

/**
 * The stored JSON for the download button, tab-indented: stored saves are
 * compact to spare the quota, but a downloaded file is something a person can
 * open and read. Deliberately *not* `readSave` — downloading is how an
 * unsupported-version save escapes to disk, so it must work exactly where
 * loading refuses, and a save too damaged to even parse is handed over
 * verbatim rather than withheld.
 */
export function exportSave(id: string): string {
  const text = globalThis.localStorage?.getItem(KEY_PREFIX + id);
  if (!text) throw new Error('that save no longer exists');
  try {
    return JSON.stringify(JSON.parse(text), null, '\t');
  } catch {
    return text;
  }
}

/**
 * Validates a downloaded save's JSON and stores it under a fresh id (never the
 * embedded one — importing the same file twice must not overwrite). Same
 * version strictness as `readSave`: an old-format file is refused with both
 * versions named, not stored as a dead row.
 */
export function importSave(text: string): SaveMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('that file is not a TopDoom save');
  }
  if (isRecord(raw) && typeof raw.version === 'number' && raw.version !== SAVE_VERSION) {
    throw new Error(`this save uses format version ${raw.version}; this build loads version ${SAVE_VERSION}`);
  }
  if (!isLoadable(raw)) throw new Error('that file is not a TopDoom save');
  const save: SaveGame = { ...raw, ...asMeta(raw, freshId()), version: SAVE_VERSION, state: raw.state };
  store(save);
  const { state: _state, ...meta } = save;
  return meta;
}
