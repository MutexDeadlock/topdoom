/**
 * What the occlusion-fade tests share: the `FadeTarget` the faders aim at, the
 * opening lookup their wall half takes, and the vertex-alpha readbacks their
 * assertions are written against. Built once here so a dial added to
 * `FadeTarget`, or a change to how `commit` writes alpha, does not mean editing
 * every case in every fade test. The dials are still *read* from the source
 * rather than mirrored (docs/render.md § The fade is a hole, not a wall).
 */
import * as THREE from 'three';
import { FADE_ALPHA, FADE_RADIUS, type FadeTarget } from '../../src/render/occlusion.ts';
import type { WallOccluder } from '../../src/render/mapmesh.ts';
import type { Opening, World } from '../../src/game/world.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';

/** A player-strength fade target at a point, with any dial overridden — `over` is for the cases that vary one. */
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

/** The real opening lookup, in the shape the wall fade takes it. */
export function openingsOf(world: World): (line: number, out: Opening) => boolean {
  return (line, out) => world.openingInto(line, out);
}

/** The alpha channel of a mesh's vertex colours, or `undefined` for a batch that has none. */
function alphaOf(mesh: THREE.Mesh | undefined): THREE.BufferAttribute | undefined {
  return mesh?.geometry?.getAttribute?.('color') as THREE.BufferAttribute | undefined;
}

/**
 * The lowest alpha `commit` has written anywhere in a batch of meshes — every
 * vertex, whichever quad or fan wrote it. A minimum over everything, so it
 * answers "did anything fade at all" rather than "did *this* wall fade".
 */
export function lowestAlpha(meshes: ReadonlyMap<string, THREE.Mesh>): number {
  let low = 1;
  for (const mesh of meshes.values()) {
    const attr = alphaOf(mesh);
    if (!attr) continue;
    for (let v = 0; v < attr.count; v++) low = Math.min(low, attr.getW(v));
  }
  return low;
}

/**
 * The same over the wall quads standing at `x` alone, walked through each
 * occluder's own vertex range. For a case about one wall on a map that has
 * others, where a minimum over everything would answer about the wrong one.
 */
export function lowestAlphaAt(
  occluders: readonly WallOccluder[],
  meshes: ReadonlyMap<string, THREE.Mesh>,
  x: number,
): number {
  let low = 1;
  for (const o of occluders) {
    if (Math.min(o.ax, o.bx) > x || Math.max(o.ax, o.bx) < x) continue;
    const attr = alphaOf(meshes.get(o.key));
    if (!attr) continue;
    for (let v = 0; v < o.vertexCount; v++) low = Math.min(low, attr.getW(o.vertexStart + v));
  }
  return low;
}
