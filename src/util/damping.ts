/**
 * Exponentially damped approach from `prev` toward `target` at the given rate
 * (1/seconds), framerate-independent via `dt`. A pure exponential lerp never
 * actually reaches its target, so once the remaining gap drops under
 * `snapEps` this snaps straight to `target` instead of leaving a permanent
 * asymptotic residue — load-bearing for anything gating a strict `<` test
 * downstream (e.g. dithered-discard alpha), where that residue would show up
 * as a faint permanent speckle. Shared by render/occlusion.ts's wall-occlusion
 * fade and game/fogofwar.ts's reveal fade — same smoothing, different rates.
 */
export function dampen(prev: number, target: number, rate: number, dt: number, snapEps: number): number {
  const lerpT = 1 - Math.exp(-rate * dt);
  const next = prev + (target - prev) * lerpT;
  return Math.abs(target - next) < snapEps ? target : next;
}
