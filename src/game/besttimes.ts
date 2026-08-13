/**
 * Per-level best completion times, persisted across sessions and shown on the end-of-level popup —
 * see docs/hud.md § Best times. Owned here rather than by `ui/hud/intermission.ts` for the same
 * reason every other `topdoom.*` value lives with the module whose behavior it changes
 * (docs/menu.md § Persisted settings): the popup only renders what this decides.
 */
import type { Skill } from './skill.ts';

const STORAGE_KEY = 'topdoom.bestTimes';

/**
 * Upper bound on stored records, oldest evicted first. A record is ~110 bytes, so this is a bound
 * against a table that only ever grows, not a real constraint on how many levels can be tracked.
 * Exported for the test that pins the eviction, so the two can't drift apart.
 */
export const MAX_RECORDS = 400;

/** One level's best time. `wad`/`map`/`skill` are duplicated from the key purely so the stored blob reads. */
export interface BestTime {
  seconds: number;
  wad: string;
  map: string;
  skill: number;
  /** ISO date the record was set; also the eviction order. */
  at: string;
}

/** What the popup needs after a completion: the time to beat, and whether this run beat it. */
export interface BestTimeResult {
  /** The best time before this run, or null if the level had never been completed. */
  previous: number | null;
  isNewBest: boolean;
}

/**
 * The record key. The WAD part is the content id of the file that actually *provides* the map
 * (`Wad.find(map)!.source`), not of the whole loaded set — see docs/hud.md § Best times for why
 * the distinction matters.
 */
export function bestTimeKey(wadId: string, map: string, skill: Skill): string {
  return `${wadId}|${map.toUpperCase()}|${skill}`;
}

/** The stored best time in seconds, or null if there is none (or the stored blob is unusable). */
export function readBestTime(key: string): number | null {
  return readAll()[key]?.seconds ?? null;
}

/**
 * Files a completion, writing only when it improves on what was stored. Returns the time that was
 * there before, so the caller can show both the old record and the fact that it fell.
 */
export function recordBestTime(key: string, seconds: number, meta: Omit<BestTime, 'seconds' | 'at'>): BestTimeResult {
  const all = readAll();
  const previous = all[key]?.seconds ?? null;
  const isNewBest = previous === null || seconds < previous;
  if (!isNewBest) return { previous, isNewBest };

  all[key] = { seconds, wad: meta.wad, map: meta.map, skill: meta.skill, at: new Date().toISOString() };
  writeAll(all);
  return { previous, isNewBest };
}

/** Drops every stored record. Not wired to any UI yet; here so the store has a way back to empty. */
export function clearBestTimes(): void {
  globalThis.localStorage?.removeItem(STORAGE_KEY);
}

/**
 * The whole table, validated on read. A single malformed entry is dropped rather than the blob:
 * losing one level's record to a bad hand-edit shouldn't cost every other level's.
 */
function readAll(): Record<string, BestTime> {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const out: Record<string, BestTime> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = asBestTime(value);
    if (entry) out[key] = entry;
  }
  return out;
}

function asBestTime(value: unknown): BestTime | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<BestTime>;
  // A negative or non-finite time would win every comparison it took part in, so it fails the
  // check rather than being clamped.
  if (typeof v.seconds !== 'number' || !Number.isFinite(v.seconds) || v.seconds < 0) return null;
  return {
    seconds: v.seconds,
    wad: typeof v.wad === 'string' ? v.wad : '',
    map: typeof v.map === 'string' ? v.map : '',
    skill: typeof v.skill === 'number' ? v.skill : 0,
    at: typeof v.at === 'string' ? v.at : '',
  };
}

function writeAll(all: Record<string, BestTime>): void {
  const keys = Object.keys(all);
  if (keys.length > MAX_RECORDS) {
    // Oldest first. An entry with no usable date sorts oldest and so goes first — it predates this
    // field or was hand-edited, and either way is the least worth keeping.
    keys.sort((a, b) => all[a].at.localeCompare(all[b].at));
    for (const key of keys.slice(0, keys.length - MAX_RECORDS)) delete all[key];
  }
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
}
