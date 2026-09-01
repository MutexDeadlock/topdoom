/**
 * Running a simulation for a stated number of seconds at the fixed tic, the way `game.ts` does —
 * so a test says `stepFor(2, …)` rather than carrying its own rounding and loop.
 * docs/testing.md § Shared helpers.
 */
import { DOOM_TIC } from '../../src/constants.ts';

/** `seconds` as whole tics, rounded. */
export function ticsIn(seconds: number): number {
  return Math.round(seconds / DOOM_TIC);
}

/**
 * Calls `step` once per tic for `seconds`, with the tic index; stops early the first time `done`
 * holds. Returns the seconds actually run.
 */
export function stepFor(seconds: number, step: (tic: number) => void, done?: () => boolean): number {
  const tics = ticsIn(seconds);
  for (let i = 0; i < tics; i++) {
    step(i);
    if (done?.()) return (i + 1) * DOOM_TIC;
  }
  return seconds;
}
