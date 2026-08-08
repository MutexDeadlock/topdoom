/**
 * Deterministic stand-ins for `Math.random`, for the damage dice. Install one
 * with node:test's `t.mock.method(Math, 'random', …)`, which restores the real
 * function when the test ends — and node runs one process per test file, so a
 * patch cannot escape its file even if a test throws.
 */

/** Replays a fixed list of values, wrapping. For pinning exact roll boundaries. */
export function scriptedRandom(values: readonly number[]): () => number {
  if (values.length === 0) throw new Error('scriptedRandom: needs at least one value');
  let i = 0;
  return () => values[i++ % values.length];
}

/**
 * A Numerical Recipes linear congruential generator — deterministic across
 * runs, and good enough for the distribution-shape assertions. Not a
 * cryptographic or statistically rigorous source, and not meant to be.
 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}
