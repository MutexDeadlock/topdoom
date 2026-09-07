/**
 * What every sprite reader shares: the viewer angle a billboard is picked against, the material a
 * sprite lump is drawn with, and the cached-lump shapes the batches index.
 * See docs/sprites.md.
 */
import * as THREE from 'three';

/**
 * Default viewer angle (DOOM-space, 0 = east, 90 = north, counter-clockwise):
 * due south, matching TopDownCamera's yaw=0. The camera can orbit (see
 * TopDownCamera.viewerAngleDeg), so this constant is only the fallback for
 * callers that don't pass a live angle; SpriteActor.setPose is re-called
 * every frame with the camera's actual current viewer angle.
 */
export const VIEWER_ANGLE_DEG = -90;

/**
 * The material a sprite draws through. Shared with `SpriteBatch`'s per-page material, so a lump
 * drawn off the atlas and one drawn from its own texture take the same alpha test and the same
 * fog. `side` is double because the fixed-orientation approximation can put the camera behind a
 * thing far from the player (`SpriteMaterialCache`'s class doc); a single-sided plane would simply
 * vanish there.
 */
export function spriteMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, transparent: false, fog: true, side: THREE.DoubleSide });
}

/**
 * Gives `geometry` the all-white per-vertex colour the *instanced* path (render/sprites/batch.ts)
 * needs: `vertexColors` is what makes `instanceColor` reach the fragment shader, and without this
 * attribute WebGL's default (0, 0, 0) draws every batched sprite black. A non-instanced material
 * ignores it and tints via `material.color`. docs/sprites.md § Batching.
 */
export function whiteVertexColors(geometry: THREE.BufferGeometry): void {
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(1), 3));
}


/**
 * A lump's place in the atlas as the batch shader reads it, already mirrored where the cached
 * sprite is: `u0`/`v0` are the quad's bottom-left corner and `u1`/`v1` its top-right, so a
 * mirrored sprite has `u0 > u1`. `offsetX` is how far the quad's centre sits right of the thing —
 * the hotspot's `left` — negated when mirrored. docs/sprites.md § Batching.
 */
export interface AtlasSprite {
  page: THREE.DataTexture;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  width: number;
  height: number;
  offsetX: number;
}

export interface CachedSprite {
  /**
   * The lump's own plane and the material over its own texture — **built on first read**, not on
   * the lookup that returned this. A lump the atlas packed is drawn by `SpriteBatch` from the
   * page's material and a shared unit plane, and most of a set's lumps are never drawn any other
   * way; `SpriteActor` is what asks for these. docs/sprites.md § Batching.
   */
  material: THREE.MeshBasicMaterial;
  geometry: THREE.BufferGeometry;
  /** Where the batches draw this lump from; null with no atlas, or a lump too big for a page. */
  atlas: AtlasSprite | null;
  /**
   * Where vanilla hangs this patch's bottom edge, relative to the thing's own z: `topoffset -
   * height`, `R_ProjectSprite`'s `gzt = z + topoffset` read from the bottom up. Zero or a few units
   * negative for floor-standing art, deeply negative for anything meant to straddle its point (a
   * rocket's explosion is 60 tall and hangs 31 below it).
   *
   * A caller adds it to the drawn z where the sprite is airborne; one drawing something that rests
   * on the floor ignores it and keeps the plane's own bottom anchor.
   * docs/sprites.md § Why upright planes, not `THREE.Sprite`.
   */
  bottomOffset: number;
}
