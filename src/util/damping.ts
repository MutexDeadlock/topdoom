/**
 * The smoothing curves shared across layers: the framerate-independent damped approach the fades
 * run on, the per-tic decay the movement channels shed speed with, and the Hermite ease the render
 * layer shapes its falloffs with.
 * See docs/render-occlusion.md and docs/fogofwar.md § How reveal reaches the geometry.
 */
import { exp } from './fdlibm.ts';

/**
 * Exponentially damped approach from `prev` toward `target` at the given rate (1/seconds),
 * framerate-independent via `dt`. A pure exponential lerp never actually reaches its target, so
 * once the remaining gap drops under `snapEps` this snaps straight to `target` instead of leaving a
 * permanent asymptotic residue — load-bearing for anything gating a strict `<` test downstream
 * (e.g. dithered-discard alpha), where that residue would show up as a faint permanent speckle.
 * Shared by the two cameras' framing glide; a loop with one rate per pass takes `dampenWith`
 * instead. See docs/render-occlusion.md and docs/fogofwar.md § How reveal reaches
 * the geometry. The exponential is `util/fdlibm.ts`'s, not the platform's, so that nothing in
 * `src/game/` can reach an approximated `Math` through this helper — the rule the tic is held to
 * either way (docs/replays.md § What breaks determinism).
 */
export function dampen(prev: number, target: number, rate: number, dt: number, snapEps: number): number {
  return dampenWith(prev, target, 1 - exp(-rate * dt), snapEps);
}

/**
 * `dampen` with the exponential lerp factor `1 - exp(-rate * dt)` precomputed —
 * for loops damping thousands of values with the same rate and dt per frame
 * (the occlusion faders, the fog reveal), where the exponential is loop-invariant.
 */
export function dampenWith(prev: number, target: number, lerpT: number, snapEps: number): number {
  const next = prev + (target - prev) * lerpT;
  return Math.abs(target - next) < snapEps ? target : next;
}

/**
 * A **per-tic** decay factor — vanilla's friction, and anything else quoted per tic — applied over
 * whatever fraction of a tic `dt` covers.
 *
 * The simulation always advances by exactly one tic, so the exponent is exactly 1 and the answer is
 * `factor` itself; that case returns without reaching `Math.pow`, whose result ECMA-262 leaves
 * implementation-approximated — the movement channels this decays have to come out identical on
 * every engine (`util/geom.ts: vecLength` makes the same point). A caller stepping by anything else
 * keeps the general form. docs/movement.md § Knockback.
 */
export function decayOverTics(factor: number, dt: number): number {
  const tics = dt * 35; // vanilla's tic rate, of which `DOOM_TIC` is the reciprocal
  return tics === 1 ? factor : Math.pow(factor, tics);
}

/**
 * Hermite ease over [0, 1] — GLSL's `smoothstep` without the clamp, so the caller clamps where it
 * needs to. Shapes `render/playershadow.ts`'s rim falloff and `render/voidfloor.ts`'s noise
 * upsample.
 */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}
