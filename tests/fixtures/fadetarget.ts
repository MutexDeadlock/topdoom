/**
 * The `FadeTarget` the occlusion faders take, built once here so a dial added to
 * that type does not mean editing every case in every fade test. The dials are
 * still *read* from the source rather than mirrored (docs/render.md § The fade
 * is a hole, not a wall); `over` is for the cases that vary one.
 */
import { FADE_ALPHA, FADE_RADIUS, type FadeTarget } from '../../src/render/occlusion.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';

/** A player-strength fade target at a point, with any dial overridden. */
export function targetAt(x: number, y: number, z: number, over: Partial<FadeTarget> = {}): FadeTarget {
  return {
    x,
    y,
    z,
    halfHeight: PLAYER_HEIGHT / 2,
    fadeFloor: FADE_ALPHA,
    fadeRadius: FADE_RADIUS,
    ...over,
  };
}
