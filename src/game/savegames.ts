import { roundFloat, type GameSnapshot } from './snapshot.ts';
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

/** What to call a saved file in a message; the name is for humans, so it needs a fallback and the id doesn't. */
export function wadLabel(wad: SaveWad): string {
  return wad.name || 'unknown file';
}

/** One file of a save's set the library can't supply. The role is just the position in `wads`, `[0]` being the game WAD. */
export interface MissingWad {
  name: string;
  role: 'IWAD' | 'PWAD';
  /** The library has a file by this name, but not these bytes — worth saying, since "missing" would send the player looking for something they already have. */
  wrongVersion: boolean;
}

/**
 * The one sentence about a file the library can't supply, shared by the save
 * row and the load error so the two surfaces can't word the same problem
 * differently. docs/savegames.md § WAD-set identity.
 */
export function missingWadText(file: MissingWad): string {
  return file.wrongVersion
    ? `Different ${file.role}: ${file.name} is not the version this save was made with`
    : `Missing ${file.role}: ${file.name} — load it from disk first`;
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
  /** Load-bearing for thing identity, not just difficulty — the save's things were filtered by it. */
  skill: Skill;
  /** The whole WAD set in load order, `[0]` the game WAD — one list, so a file's name and id can't drift apart and a file's role is just its position (docs/savegames.md § WAD-set identity). */
  wads: SaveWad[];
  levelTime: number;
  /** JPEG data URL thumbnail, ~320px wide. */
  thumb: string;
}

export interface SaveGame extends SaveMeta {
  state: GameSnapshot;
}

/**
 * What `Game.captureSave` produces — everything but the store's own bookkeeping.
 * `wads` needs nothing added: a save identifies its files by content, which is
 * exactly what `wadSetId` hands back, so `Game` never has to know which library
 * the files were picked from.
 */
export type SaveCapture = Omit<SaveGame, 'id' | 'version' | 'at' | 'name'>;

export interface SaveListEntry {
  meta: SaveMeta;
  /** False for a version this build can't load, or an entry too damaged to trust — still listed so it can be deleted or downloaded. */
  supported: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const asSkill = (v: unknown): Skill => (v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 3);

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * One stored WAD entry, each field degraded on its own. Deliberately *mapped*
 * rather than filtered: `wads` is in load order and `[0]` is the game WAD, so
 * dropping a damaged entry would silently shift every file after it into the
 * wrong role. A blanked entry instead fails loudly — an empty id matches
 * nothing in the library, so the file is reported as one to go and find.
 */
const asWad = (v: unknown): SaveWad => {
  const w = isRecord(v) ? v : {};
  return { name: asText(w.name), id: asText(w.id) };
};

/** Best-effort meta for the list; every field degrades to something displayable rather than failing the whole row. */
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
    levelTime: typeof r.levelTime === 'number' ? r.levelTime : 0,
    thumb: asText(r.thumb),
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

/** The stored JSON for `id`, or a thrown refusal — the shared opening of every read-modify-write below. */
function readRaw(id: string): string {
  const text = globalThis.localStorage?.getItem(KEY_PREFIX + id);
  if (!text) throw new Error('that save no longer exists');
  return text;
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
  const text = readRaw(id);
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

/** The one place a save is serialized, so `roundFloat` is applied exactly where the bytes it saves are counted. */
function put(id: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(KEY_PREFIX + id, JSON.stringify(value, roundFloat));
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

/** A save without its payload — what every mutator hands back to the menu. */
function metaOf(save: SaveGame): SaveMeta {
  const { state: _state, ...meta } = save;
  return meta;
}

/** Stores a fresh capture under a new id; throws (readably) at the cap or the storage quota. */
export function writeSave(capture: SaveCapture, name: string): SaveMeta {
  const save = createSave(freshId(), name, capture);
  store(save);
  return metaOf(save);
}

/**
 * Refills an existing save from a fresh capture, keeping its id and its name —
 * an overwrite replaces a slot's contents, and the name is the slot's label
 * (changed on its own through `renameSave`). Deliberately not `store`: no new
 * key appears, so the cap can't refuse an overwrite even when the list is full.
 */
export function overwriteSave(id: string, capture: SaveCapture): SaveMeta {
  const text = readRaw(id);
  let previous: unknown = null;
  try {
    previous = JSON.parse(text);
  } catch {
    // A damaged row can still be overwritten — it just can't lend its name.
  }
  const kept = isRecord(previous) && typeof previous.name === 'string' ? previous.name : '';
  const save = createSave(id, kept, capture);
  put(save.id, save);
  return metaOf(save);
}

/** Owns the naming rule for both writers: a blank (or all-whitespace) name falls back to `defaultName`. */
function createSave(id: string, name: string, capture: SaveCapture): SaveGame {
  return {
    id,
    version: SAVE_VERSION,
    at: new Date().toISOString(),
    name: name.trim() || defaultName(capture.map),
    ...capture,
  };
}

/**
 * Renames a save in place, leaving its payload — and its `at`, so the list
 * doesn't reorder under the cursor — untouched. The name is the only field the
 * menu lets anyone edit; a row too damaged to parse is refused rather than
 * replaced by a bare `{ name }`.
 */
export function renameSave(id: string, name: string): void {
  const text = readRaw(id);
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
  const text = readRaw(id);
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
  // `asMeta` supplies every meta field, so nothing of the file's own top level
  // is spread in: an imported file must not smuggle extra keys into storage.
  const save: SaveGame = { ...asMeta(raw, freshId()), version: SAVE_VERSION, state: raw.state };
  store(save);
  return metaOf(save);
}
