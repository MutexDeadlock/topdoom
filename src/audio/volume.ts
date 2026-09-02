/**
 * The persisted-volume read `AudioEngine` and `MusicPlayer` share — each restores its slider from
 * its own setting through it. See docs/audio.md § Volume and the context.
 */

import { readStorage } from '../util/storage.ts';

/** A stored 0-1 volume, or `fallback` when nothing in range is stored. */
export function storedVolume(key: string, fallback: number): number {
  const stored = readStorage(key, fallback);
  return stored >= 0 && stored <= 1 ? stored : fallback;
}
