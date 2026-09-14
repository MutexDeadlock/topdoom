/**
 * The save format: {@link SAVE_VERSION}, the stored payload around a {@link GameSnapshot}, named
 * saves over the IndexedDB store, and download/import. One meta record and one gzipped state record
 * per save, split so that listing reads metas alone and never touches a snapshot. See
 * docs/savegames.md.
 */
import { roundFloat, type GameSnapshot } from './snapshot.ts';
import { type Skill } from './skill.ts';
import { MAX_PLAYERS } from './playerstarts.ts';
import { mapProvider, wadId, wadSetId } from '../wad/checksum.ts';
import type { Wad, WadFile } from '../wad/wad.ts';
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

/**
 * The version of a snapshot's content. Unlike every other `topdoom.*` value, which degrades field
 * by field in the `besttimes.ts` style, a save carries it explicitly and is refused on a mismatch
 * rather than half-read. docs/savegames.md § The format and its version.
 */
export const SAVE_VERSION = 1;

/**
 * The IndexedDB backend, created on first touch so importing this module in Node never reaches for
 * `indexedDB`.
 */
let backend: SaveStoreBackend | null = null;
const store = (): SaveStoreBackend => (backend ??= idbBackend({ database: 'topdoom', prefix: 'saves' }));

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
   * What the file was called when the save was made, for the player to go and find; nothing keys
   * through it, so a renamed WAD is still found.
   */
  name: string;
  /**
   * {@link wadId} content hash — **the file's identity**, and what a load matches the library
   * against; deliberately not the name or a library key, which a rename or another source changes.
   * docs/savegames.md § WAD-set identity.
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

/**
 * What the file at `index` of a stored set does there, for the inspection scripts: the game WAD
 * is `[0]`, the map provider is {@link SaveMeta.mapWad}'s, a DEH patch is one
 * {@link SaveMeta.patchWads} names.
 */
export function wadRoles(set: Pick<SaveWadSet, 'wads' | 'mapWad' | 'patchWads'>, index: number): string[] {
  const wad = set.wads[index];
  const roles: string[] = [];
  if (index === 0) roles.push('game WAD');
  if (wad.id === set.mapWad) roles.push('map provider');
  if (set.patchWads?.includes(wad.id)) roles.push('DEH patch');
  return roles;
}

/** The identity half of a save's meta: every field the WAD gate reads, and all it reads. */
export type SaveWadSet = Pick<SaveMeta, 'map' | 'wads' | 'mapWad' | 'patchWads'> & {
  /**
   * Every map the record actually visits, `[0]` being {@link SaveMeta.map}. A save has exactly one
   * and leaves this out; a replay can walk the campaign into levels no add-on supplied, and
   * `replayWadSet` fills it from the level markers. Only the stand-in gate reads it — the rest of
   * the set is about the map a snapshot indexes into, which is {@link SaveMeta.map} alone.
   * docs/savegames.md § A stand-in game WAD.
   */
  maps?: readonly string[];
};

/**
 * What an unnamed save or replay is called: the WAD that supplied the map, extension dropped, and
 * the map — `DOOM2 MAP05`. No date, which the row already shows from {@link SaveMeta.at}. The map
 * provider is {@link SaveMeta.mapWad}'s file, falling back to the game WAD when the set names none.
 */
export function defaultName(set: Pick<SaveWadSet, 'map' | 'wads' | 'mapWad'>): string {
  const provider = set.wads.find((wad) => wad.id === set.mapWad) ?? set.wads[0];
  const file = (provider?.name ?? '').replace(/\.[^.]*$/, '').trim();
  return file ? `${file} ${set.map}` : set.map;
}

/**
 * A download's file name: the record's own name with anything a filesystem could object to
 * replaced, under `kind`'s suffix. The suffix is also what `Menu.installDropTarget` routes a
 * dropped file by, so the two importers can't take each other's files.
 */
export function downloadFileName(name: string, kind: 'save' | 'replay'): string {
  const safe = name.replace(/[^\p{L}\p{N} _.-]+/gu, '_').trim() || kind;
  return `${safe}.topdoom${kind}.json`;
}

/** Whether a dropped or picked file is one of `kind`'s downloads. */
export function isDownloadFileName(name: string, kind: 'save' | 'replay'): boolean {
  return name.toLowerCase().endsWith(`.topdoom${kind}.json`);
}

/** `<name>.topdoomsave.json` — a downloaded save, `replayFileName`'s twin. */
export function saveFileName(name: string): string {
  return downloadFileName(name, 'save');
}

/**
 * Which entries of a save's set a load requires back, positionally: the game WAD (`[0]`), the file
 * `mapWad` names, and any file carrying a `DEHACKED` lump. Releasing the game WAD needs the library
 * and is `Menu.resolveSaveWads`'s answer, not this one.
 * docs/savegames.md § WAD-set identity, § A stand-in game WAD.
 *
 * @param patchWads  the DEHACKED-carrying files' IDs; empty for a save written before the field
 */
export function requiredWads(wads: SaveWad[], mapWad: string, patchWads: readonly string[] = []): boolean[] {
  const wholeSet = requiresWholeSet(wads, mapWad);
  return wads.map((wad, i) => i === 0 || wad.id === mapWad || wholeSet || patchWads.includes(wad.id));
}

/**
 * Whether another game WAD may stand in for `wads[0]` — true exactly when the map came from
 * something else, so nothing the snapshot indexes through was read out of the game WAD at all. A
 * blank or unmatched `mapWad` keeps the whole-set rule. *Which* file may stand in is the caller's
 * (`Menu.substituteIwad`). docs/savegames.md § A stand-in game WAD.
 */
export function substitutableIwad(wads: SaveWad[], mapWad: string): boolean {
  return !requiresWholeSet(wads, mapWad) && wads[0]?.id !== mapWad;
}

/** The first map a record visited that no stand-in game WAD can be taken under, and why. */
export interface StandInBlocker {
  map: string;
  /**
   * Whether the game WAD is what supplies that level, so the stand-in would run *its* version;
   * false is a map the assembled set supplies nowhere, which no choice of game WAD helps.
   */
  fromIwad: boolean;
}

/**
 * The first map of `maps` that stops a stand-in game WAD being taken, or null when none does, with
 * which of the two reasons ({@link StandInBlocker.fromIwad}). The load gate and the menu's pick
 * both ask this rather than spelling the rule twice. docs/savegames.md § A stand-in game WAD.
 *
 * @param providerOf  the file supplying a map in the set being assembled, under whatever identity
 *                    the caller can compare — a content ID for the load gate, a library label for
 *                    the menu's pick, which is what `mergedMaps` attributes with
 */
export function standInBlocker(
  maps: readonly string[],
  iwad: string,
  providerOf: (map: string) => string | null,
): StandInBlocker | null {
  for (const map of maps) {
    const provider = providerOf(map);
    if (provider === null) return { map, fromIwad: false };
    if (provider === iwad) return { map, fromIwad: true };
  }
  return null;
}

/**
 * Why the assembled set can't play this save, or null when it can — **the load gate itself**, over
 * plain facts rather than a {@link Wad}. `main.ts` asks it over a loaded set through
 * {@link loadedSetRefusal} and throws the message. docs/savegames.md § WAD-set identity.
 *
 * @param actual      {@link wadSetId}'s list for the set in hand
 * @param providerOf  the file supplying a map in that set, null where it supplies none
 */
export function wadSetRefusal(
  save: SaveWadSet,
  actual: SaveWad[],
  providerOf: (map: string) => SaveWad | null,
): string | null {
  if (requiresWholeSet(save.wads, save.mapWad)) {
    if (actual.length !== save.wads.length) {
      return 'the loaded WAD set has a different file count than the one this save was made with';
    }
    const differing = actual.find((file, i) => file.id !== save.wads[i].id);
    return differing ? `${differing.name} differs from the file this save was made with` : null;
  }
  const iwad = actual[0] as SaveWad | undefined;
  if (!iwad) return 'no game WAD is loaded';
  if (iwad.id !== save.wads[0]?.id) {
    if (!substitutableIwad(save.wads, save.mapWad)) {
      return `${iwad.name} differs from the game WAD this save was made with`;
    }
    // A stand-in is otherwise accepted by *any* ID here: this gate sees content hashes, and whether
    // one file may replace another is a question about its maps, settled where the set was
    // resolved. What it does check is a record that walked out of the add-on's maps and played the
    // rest from the game WAD itself, where a stand-in would run its own version of those levels.
    const blocker = standInBlocker(save.maps ?? [], iwad.id, (map) => providerOf(map)?.id ?? null);
    if (blocker) {
      return blocker.fromIwad
        ? `this recording plays ${blocker.map} from the game WAD it was made with`
        : `the loaded WADs have no map ${blocker.map}`;
    }
  }
  const mapProvider = providerOf(save.map);
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
 * {@link wadSetRefusal} asked of a loaded set: its files' content IDs, and the file supplying each
 * map.
 */
export function loadedSetRefusal(save: SaveWadSet, wad: Wad): string | null {
  return wadSetRefusal(save, wadSetId(wad), (map) => mapProvider(wad, map));
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
   * Whether the load actually needs this file back: {@link SaveMeta.mapWad}'s provider, and the
   * game WAD where nothing may stand in for it. docs/savegames.md § WAD-set identity.
   */
  required: boolean;
  /**
   * The file standing in for this one — only ever a game WAD ({@link substitutableIwad}), and then
   * {@link MissingWad.required} is false. A stand-in under this file's *own* name is left out:
   * {@link MissingWad.wrongVersion} already says that. docs/savegames.md § A stand-in game WAD.
   */
  substitute?: string;
  /**
   * Why no stand-in was taken where a candidate was there to take: the map that stopped it, and
   * which of {@link standInBlocker}'s two reasons. Set only alongside {@link MissingWad.required}.
   * docs/savegames.md § A stand-in game WAD.
   */
  blockedBy?: StandInBlocker;
}

/**
 * What a file the library can't supply is called in a **save row**: which file, and what is wrong
 * with it, in a few words. The row ellipsizes (docs/menu-saves.md § Save and Load tabs), so the
 * advice lives in {@link missingWadText}.
 */
export function missingWadLabel(file: MissingWad): string {
  if (file.substitute) return `Stand-in for ${file.name}: ${file.substitute}`;
  if (!file.required) return file.wrongVersion ? `Other version: ${file.name}` : `Not loaded: ${file.name}`;
  return file.wrongVersion ? `Different ${file.role}: ${file.name}` : `Missing ${file.role}: ${file.name}`;
}

/**
 * {@link missingWadLabel} plus what to *do* about it, for the load error and the row's tooltip. An
 * optional file's clause says outright that the save loads — the label alone would read as a
 * refusal. docs/savegames.md § WAD-set identity.
 */
export function missingWadText(file: MissingWad): string {
  // A stand-in carries no advice at either length: the label already names the file that stood in,
  // and there is nothing for the player to go and do about it.
  if (file.substitute) return missingWadLabel(file);
  return `${missingWadLabel(file)} ${adviceFor(file)}`;
}

/**
 * The one file of a set that stops a load, or undefined when the set is playable — what greys Load
 * out and what `loadSave` refuses over.
 */
export function blockingWad(missing: MissingWad[]): MissingWad | undefined {
  return missing.find((file) => file.required);
}

/**
 * {@link blockingWad}'s file in {@link missingWadText}'s words, or null when nothing stops the
 * start.
 */
export function blockingWadText(missing: MissingWad[]): string | null {
  const blocker = blockingWad(missing);
  return blocker ? missingWadText(blocker) : null;
}

/**
 * `wad` as a set records itself, playing `map`: every file by content ID, the map's provider, and
 * the files a DEHACKED patch came from — what a save stores and a network game's peers must match.
 * docs/savegames.md § WAD-set identity.
 *
 * @param patchSources  the files a DEHACKED patch came from, null for none
 */
export function wadSetOf(wad: Wad, map: string, patchSources: readonly WadFile[] | null): SaveWadSet {
  return {
    map,
    wads: wadSetId(wad),
    // A level is running, so the map has a provider; `''` would only mean the
    // save asks for its whole set back, which is the safe way to be wrong.
    mapWad: mapProvider(wad, map)?.id ?? '',
    // Only when a patch was actually applied: an empty list would read the same as absent, and
    // absent is what an unpatched save means. docs/dehacked.md § Savegames and patched tables.
    ...(patchSources ? { patchWads: patchSources.map((f) => wadId(f)) } : {}),
  };
}

export interface SaveMeta {
  id: string;
  version: number;
  /** ISO date of the save — the list's sort order, newest first. */
  at: string;
  /** User-visible name; a blank one is {@link defaultName}'s. */
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
   * Content ID of the file that supplied {@link SaveMeta.map}'s lumps — **with the game WAD, what
   * a load requires**. `''` names no provider, and then the whole set is required back
   * ({@link requiresWholeSet}). docs/savegames.md § WAD-set identity.
   */
  mapWad: string;
  /**
   * Content IDs of the files in {@link SaveMeta.wads} that carry a `DEHACKED` lump. **Absent means
   * no patch was applied**, which is what every save written before the field meant.
   * docs/savegames.md § WAD-set identity, docs/dehacked.md § Savegames and patched tables.
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
 * What `Game.captureSave` produces — everything but the store's own bookkeeping. Its files are
 * identified by content ({@link wadSetId}, {@link wadId}), so `Game` never has to know which
 * library they were picked from.
 */
export type SaveCapture = Omit<SaveGame, 'id' | 'version' | 'at' | 'name'>;

export interface SaveListEntry {
  meta: SaveMeta;
  /**
   * Why this build cannot load the row — a format version it does not read, or a meta too damaged
   * to trust — and null when it can. The same sentence {@link readSave} would throw, so the list
   * can say *why* Load is greyed instead of only that it is; the row still lists, downloads and
   * deletes. A damaged *state* is invisible here (listing never reads it) and surfaces at load
   * instead.
   */
  refusal: string | null;
}

/** The field readers every stored meta degrades through — the replay's too (`game/replay.ts`). */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
export const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
export const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const asSkill = (v: unknown): Skill => (v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 3);

/**
 * One stored WAD entry, each field degraded on its own — deliberately *mapped* rather than
 * filtered, since dropping an entry would shift every later file of {@link SaveMeta.wads} into the
 * wrong role. docs/savegames.md § WAD-set identity.
 */
export const asWad = (v: unknown): SaveWad => {
  const w = isRecord(v) ? v : {};
  return { name: asText(w.name), id: asText(w.id) };
};

/**
 * The state half: without these the restore path would crash mid-load. Checked wherever a snapshot
 * is actually decoded.
 */
export function isLoadableState(state: unknown): state is GameSnapshot {
  if (!isRecord(state) || !isRecord(state.rng) || !Array.isArray(state.players)) return false;
  const { players } = state;
  return players.length > 0 && players.length <= MAX_PLAYERS && players.every((slot) => isRecord(slot) && isRecord(slot.player));
}

const readMeta = (id: string): Promise<unknown> => readStoredMeta(store(), 'save', id);
const putSave = (meta: SaveMeta, state: StoredState): Promise<void> => putStored(store(), 'save', meta, state);
const freshId = (): Promise<string> => freshStoredId(store());

/**
 * Every stored save, newest first, unsupported versions included (marked, not hidden). Reads metas
 * only — never a state.
 */
export async function listSaves(): Promise<SaveListEntry[]> {
  const raws = await store().listMeta();
  const entries = raws.map((raw) => {
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '';
    return { meta: asMeta(raw, id), refusal: metaRefusal(raw) };
  });
  return entries.sort((a, b) => b.meta.at.localeCompare(a.meta.at));
}

const damagedText = 'this save is damaged and cannot be loaded';
const damaged = (): Error => new Error(damagedText);

/**
 * Why this build cannot read a save written in `version`, one sentence — {@link readSave}'s refusal
 * and the list's own line beside the row, which are the same thing said in two places.
 */
export function versionRefusal(version: unknown): string {
  return `this save uses format version ${String(version)}; this build loads version ${SAVE_VERSION}`;
}

/**
 * The full save, or a thrown, user-readable refusal — an unsupported version names both versions
 * rather than half-loading.
 */
export async function readSave(id: string): Promise<SaveGame> {
  const rawMeta = await readMeta(id);
  const refused = metaRefusal(rawMeta);
  if (refused !== null) throw new Error(refused);
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

/** Stores a fresh capture under a new ID; throws (readably) at the storage quota. */
export async function writeSave(capture: SaveCapture, name: string): Promise<SaveMeta> {
  const meta = createMeta(await freshId(), name, capture);
  await putSave(meta, await encodeState(meta.id, capture.state));
  return meta;
}

/**
 * Refills an existing save from a fresh capture, keeping its ID and its name — an overwrite
 * replaces a slot's contents, and the name is the slot's label (changed on its own through
 * {@link renameSave}).
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
 * Renames a save in place: meta only, {@link SaveMeta.at} untouched so the list doesn't reorder
 * under the cursor. A row too damaged to parse is refused rather than replaced by a bare
 * `{ name }`.
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
 * The download file, tab-indented: the meta fields in the clear, `state` as the stored gzip bytes,
 * base64'd. Deliberately not {@link readSave} and no decompression, so an unsupported-version or
 * undecompressable save escapes to disk verbatim, its `version` intact (only {@link importSave}
 * stamps {@link SAVE_VERSION}). docs/savegames.md § Download and import.
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
 * Validates a downloaded save's JSON and stores it under a fresh ID, never the embedded one; the
 * same version strictness as {@link readSave}. The decoded state is stored byte-exact rather than
 * recompressed. docs/savegames.md § Download and import.
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
    throw new Error(versionRefusal(raw.version));
  }
  // The imported file's own shape refusal, not a stored row's: a file this build cannot read is
  // "not a TopDoom save" whatever is wrong with it beyond the version above.
  if (metaRefusal(raw) !== null) throw refusal();
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
 * Whether this save falls back to demanding its **whole** set: its `mapWad` is blank, or names a
 * file the set doesn't have. The **one** definition of that condition — every gate reads it, so
 * none of them can disagree about which saves are in the narrow regime, and an unusable field can
 * then only ever be too strict. docs/savegames.md § WAD-set identity.
 */
function requiresWholeSet(wads: SaveWad[], mapWad: string): boolean {
  return mapWad === '' || !wads.some((wad) => wad.id === mapWad);
}

function adviceFor(file: MissingWad): string {
  // Why no stand-in was taken, where one was there to take — without it the same library plays one
  // record and refuses another under the same sentence. Loading this file back is the fix for only
  // one of the two reasons: the other is a level nothing in the set supplies, which no game WAD
  // answers for.
  if (file.blockedBy) {
    const { map, fromIwad } = file.blockedBy;
    return fromIwad ? `— it provides ${map}; load it from disk first` : `— no loaded WAD provides ${map}`;
  }
  if (!file.required) {
    return file.wrongVersion
      ? '— this level plays with the version you have, but content it added may differ'
      : '— this level plays without it, but content it added may be missing';
  }
  return file.wrongVersion ? '— not the version this save was made with' : '— load it from disk first';
}

/**
 * Best-effort meta for the list; every field degrades to something displayable rather than failing
 * the whole row.
 */
function asMeta(raw: unknown, id: string): SaveMeta {
  const r = isRecord(raw) ? raw : {};
  return {
    id,
    version: asNumber(r.version),
    at: asText(r.at),
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name : '(unreadable save)',
    map: typeof r.map === 'string' ? r.map : '?',
    skill: asSkill(r.skill),
    wads: Array.isArray(r.wads) ? r.wads.map(asWad) : [],
    mapWad: asText(r.mapWad),
    // Absent for every save written before the field existed, which is the right reading: those
    // were made by a build that applied no patch. docs/dehacked.md § Savegames and patched tables.
    ...(Array.isArray(r.patchWads) ? { patchWads: r.patchWads.filter((v) => typeof v === 'string') } : {}),
    levelTime: asNumber(r.levelTime),
    thumb: asText(r.thumb),
  };
}

/**
 * The meta half of loadability — everything checkable without the state record in hand, which is
 * all a listing ever sees. Deliberately says nothing about {@link SaveMeta.mapWad}: a save without
 * one is still perfectly loadable, since a blank only makes the WAD gate stricter
 * ({@link requiresWholeSet}).
 */
function metaRefusal(raw: unknown): string | null {
  if (!isRecord(raw)) return damagedText;
  if (raw.version !== SAVE_VERSION) return versionRefusal(raw.version);
  return typeof raw.map === 'string' && Array.isArray(raw.wads) ? null : damagedText;
}

/**
 * The one place a snapshot is serialized, so {@link roundFloat} is applied exactly where the bytes
 * it saves are counted.
 */
async function encodeState(id: string, state: GameSnapshot): Promise<StoredState> {
  return { id, encoding: STATE_ENCODING, bytes: await compressText(JSON.stringify(state, roundFloat)) };
}

/**
 * Owns the naming rule for both writers: a blank (or all-whitespace) name falls back to
 * {@link defaultName}, shared with replays. {@link SaveMeta.levelTime} is rounded here — the meta
 * is stored as an object, where digits cost nothing, but the export file stringifies it without a
 * replacer.
 */
function createMeta(id: string, name: string, capture: SaveCapture): SaveMeta {
  const { state: _state, ...rest } = capture;
  return {
    ...rest,
    id,
    version: SAVE_VERSION,
    at: new Date().toISOString(),
    name: name.trim() || defaultName(capture),
    levelTime: Math.round(capture.levelTime * 1e6) / 1e6,
  };
}
