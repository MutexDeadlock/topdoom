/**
 * Exponentially damped approach from `prev` toward `target` at the given rate
 * (1/seconds), framerate-independent via `dt`. A pure exponential lerp never
 * actually reaches its target, so once the remaining gap drops under
 * `snapEps` this snaps straight to `target` instead of leaving a permanent
 * asymptotic residue — load-bearing for anything gating a strict `<` test
 * downstream (e.g. dithered-discard alpha), where that residue would show up
 * as a faint permanent speckle. Shared by render/occlusion.ts's wall-occlusion
 * fade and game/fogofwar.ts's reveal fade — same smoothing, different rates.
 * See docs/render.md § Wall occlusion fading and docs/fogofwar.md § How reveal reaches the geometry.
 */
export function dampen(prev: number, target: number, rate: number, dt: number, snapEps: number): number {
  return dampenWith(prev, target, 1 - Math.exp(-rate * dt), snapEps);
}

/**
 * `dampen` with the exponential lerp factor `1 - exp(-rate * dt)` precomputed —
 * for loops damping thousands of values with the same rate and dt per frame
 * (the occlusion faders), where the per-call `Math.exp` is loop-invariant.
 */
export function dampenWith(prev: number, target: number, lerpT: number, snapEps: number): number {
  const next = prev + (target - prev) * lerpT;
  return Math.abs(target - next) < snapEps ? target : next;
}
