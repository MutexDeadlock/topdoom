/**
 * Every persisted setting, in one `localStorage` key holding one JSON object: a read parses that
 * object and matches the stored field against the caller's default, a write merges one field back
 * in. The same seam `idb.ts` is for the three IndexedDB stores. See docs/menu.md § Persisted
 * settings.
 */

/**
 * The key the settings object lives under. The only other `topdoom.*` key a browser still holds is
 * `topdoom.bestTimes`, the pre-IndexedDB best-times blob `game/besttimes.ts` reads once and drops
 * (docs/hud.md § Migration off localStorage).
 */
const SETTINGS_KEY = 'topdoom.settings';

/** What a setting may be, beyond the menu's own WAD selection — see `readStorageObject`. */
type Scalar = boolean | number | string;

/**
 * How long `writeStorageSoon` holds a field before storing it: long enough that one drag of a
 * slider lands as a single write, short enough that a reload straight after the release still sees
 * it. Tuned by feel.
 */
const WRITE_COALESCE_MS = 250;

/** Fields written but not yet stored, and the timer that will store them. */
const pending = new Map<string, Scalar | object>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushOnHideArmed = false;

/**
 * The stored value for `key`, or `fallback` where nothing is stored, the stored type differs from
 * the fallback's, or a hand-edited object left a number non-finite (`JSON.parse('1e999')` is
 * `Infinity`). Type only: a caller wanting a range or one of a set of names checks that itself —
 * `storedVolume`, `readStoredFpsCap`.
 *
 * Overloaded per type rather than generic so a `true` fallback reads back as `boolean`: a type
 * parameter constrained to these three infers the literal, and every setting here is a `let` the
 * menu writes back to.
 */
export function readStorage(key: string, fallback: boolean): boolean;
export function readStorage(key: string, fallback: number): number;
export function readStorage(key: string, fallback: string): string;
export function readStorage(key: string, fallback: Scalar): Scalar {
  const stored = settings()[key];
  if (typeof stored !== typeof fallback) return fallback;
  if (typeof stored === 'number' && !Number.isFinite(stored)) return fallback;
  return stored as Scalar;
}

/**
 * The stored object for `key`, for the one setting that isn't a scalar — the menu's WAD selection.
 * Null where nothing is stored or what is stored isn't an object; the fields are the caller's to
 * validate, since nothing here knows what they should be.
 */
export function readStorageObject(key: string): Record<string, unknown> | null {
  const stored = settings()[key];
  return isRecord(stored) ? stored : null;
}

/**
 * Merges one field into the stored object. Re-reads before merging, so a second tab open on the
 * game loses only the fields it changed rather than every setting the first one wrote. Best-effort:
 * a browser refusing the write (private mode's quota of zero) keeps the setting for the session and
 * forgets it for the next.
 */
export function writeStorage(key: string, value: Scalar | object): void {
  const store = webStorage();
  if (!store) return;
  try {
    store.setItem(SETTINGS_KEY, JSON.stringify({ ...settings(store), [key]: value }));
  } catch {
    // Quota or a refusal — no setting here is worth failing a menu click over.
  }
}

/**
 * `writeStorage`, coalesced: the field is held for `WRITE_COALESCE_MS`, and everything pending when
 * that expires is stored in one write. For a setting a **continuous** control drives — the volume
 * sliders fire on every `input`, dozens across one drag, each of which would otherwise re-encode
 * the whole settings object. A read in between still sees the pending value, and a page going away
 * flushes early, so the delay loses nothing. docs/menu.md § Persisted settings.
 */
export function writeStorageSoon(key: string, value: Scalar | object): void {
  pending.set(key, value);
  if (flushTimer === null) flushTimer = setTimeout(flushStorage, WRITE_COALESCE_MS);
  armFlushOnHide();
}

/** Stores every field `writeStorageSoon` is still holding. The timer's own call, and the page's. */
export function flushStorage(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0) return;
  const store = webStorage();
  // Before the clear: `settings` is what lays the pending fields over the stored ones.
  const merged = settings(store);
  pending.clear();
  if (!store) return;
  try {
    store.setItem(SETTINGS_KEY, JSON.stringify(merged));
  } catch {
    // Quota or a refusal — best-effort, exactly as an immediate write is.
  }
}

/**
 * `localStorage`, or null where there is none. The property access itself throws in a browser with
 * site data blocked, so the guard has to be a `try` and not a `?.` — which is why nothing in `src/`
 * reaches for `globalThis.localStorage` on its own. Exported for `game/besttimes.ts`, whose one
 * pre-IndexedDB key is not a setting and so has no `readStorage` of its own.
 */
export function webStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The stored object, parsed per read: nothing here runs per frame, and a live read is what lets a
 * second tab's writes be seen at all.
 */
function settings(store: Storage | null = webStorage()): Record<string, unknown> {
  const raw = store?.getItem(SETTINGS_KEY);
  let stored: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) stored = parsed;
    } catch {
      // A truncated or hand-mangled blob reads as no settings at all.
    }
  }
  // A field still waiting on `flushStorage` reads back as the value that was written, not the one
  // it is about to replace.
  for (const [key, value] of pending) stored[key] = value;
  return stored;
}

/**
 * Flushes on the way out, so a page closed inside the coalescing window keeps the setting.
 * `visibilitychange` is what a mobile browser fires before killing a backgrounded tab, which may
 * never reach `pagehide`. Armed on the first coalesced write rather than at import, so a headless
 * run that never writes installs nothing.
 */
function armFlushOnHide(): void {
  if (flushOnHideArmed || typeof globalThis.addEventListener !== 'function') return;
  flushOnHideArmed = true;
  globalThis.addEventListener('pagehide', flushStorage);
  globalThis.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStorage();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
