/**
 * The persisted-volume read `AudioEngine` and `MusicPlayer` share — each restores its slider
 * from its own localStorage key through it. See docs/audio.md § Volume and the context.
 */

/** A stored 0-1 volume, or `fallback` when nothing valid is stored. */
export function storedVolume(key: string, fallback: number): number {
  // `getItem` returns null when unset, and `Number(null)` is 0 — which would
  // read as a stored volume of "silent" rather than as "no preference yet".
  const stored = globalThis.localStorage?.getItem(key);
  const parsed = stored === null || stored === undefined ? NaN : Number(stored);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
