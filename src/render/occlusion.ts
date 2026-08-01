import * as THREE from 'three';
import type { FlatSurface, WallOccluder } from './mapmesh.ts';
import { segmentIntersect } from '../util/geom.ts';
import { dampen } from '../util/damping.ts';

/**
 * Target coverage (0..1) once a wall sits on the camera-player sightline —
 * rendered as a dithered discard (see MaterialBank.get), not real alpha
 * blending, so this reads as "fraction of pixels kept," not translucency.
 */
const FADE_ALPHA = 0.2;
/** Exponential smoothing rate (1/seconds) so fades don't pop in/out per frame. */
const FADE_SPEED = 10;
/** Snap-to-target threshold for `dampen` — see its doc for why this matters. */
const SNAP_EPS = 0.004;

/**
 * Fades the specific wall quad(s) currently between the camera and the
 * player, rather than the coarser fix of drawing the player on top of
 * everything (which would also show it through walls that genuinely
 * separate it from the camera). Wall quads are already backface-culled when
 * their front faces away from the camera (see mapmesh.ts's dollhouse
 * comment) — this covers what's left: quads that legitimately face the
 * camera but happen to sit on the line of sight to the player.
 *
 * `update` only computes this sightline factor; it does not touch geometry.
 * A wall's on-screen alpha is actually the *product* of this factor and
 * `FogOfWar`'s per-sector reveal factor (game/fogofwar.ts) — two independent
 * systems driving the same vertex-alpha channel — so `commit` writes the
 * combined value once both are known, instead of each system overwriting
 * the other's work.
 */
export class WallFader {
  private occluders: WallOccluder[];
  private meshes: Map<string, THREE.Mesh>;
  private occlusionAlpha: Float32Array;

  constructor(occluders: WallOccluder[], meshes: Map<string, THREE.Mesh>) {
    this.occluders = occluders;
    this.meshes = meshes;
    this.occlusionAlpha = new Float32Array(occluders.length).fill(1);
  }

  /** Camera and target (player) positions in DOOM (x, y, height) coordinates. */
  update(
    dt: number,
    camX: number,
    camY: number,
    camZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
  ): void {
    for (let i = 0; i < this.occluders.length; i++) {
      const o = this.occluders[i];
      const cross = segmentIntersect(camX, camY, targetX, targetY, o.ax, o.ay, o.bx, o.by);
      let occluding = false;
      if (cross) {
        const height = camZ + (targetZ - camZ) * cross.t;
        occluding = height > o.botH && height < o.topH;
      }

      const target = occluding ? FADE_ALPHA : 1;
      this.occlusionAlpha[i] = dampen(this.occlusionAlpha[i], target, FADE_SPEED, dt, SNAP_EPS);
    }
  }

  /**
   * Writes occlusion × fog-of-war combined alpha into each wall's vertex-colour
   * alpha channel. `fogAlphaOf` is keyed by the wall's index in this list, not
   * by sector: which subsector a wall quad faces into is geometry FogOfWar
   * works out for itself (see its `wallAlpha`), so the mesh builder doesn't
   * have to carry a fog-specific field around.
   */
  commit(fogAlphaOf: (occluderIndex: number) => number): void {
    const dirty = new Set<string>();

    for (let i = 0; i < this.occluders.length; i++) {
      const o = this.occluders[i];
      const combined = this.occlusionAlpha[i] * fogAlphaOf(i);
      const attr = this.meshes.get(o.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      if (attr.getW(o.vertexStart) === combined) continue;
      for (let v = 0; v < o.vertexCount; v++) attr.setW(o.vertexStart + v, combined);
      dirty.add(o.key);
    }

    for (const key of dirty) {
      const attr = this.meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}

/**
 * Writes each floor/ceiling triangle fan's fog-of-war alpha into its
 * vertex-colour alpha channel. Flats have no sightline-occlusion pass (only
 * walls can stand between the camera and the player), so unlike
 * `WallFader.commit` there's only the one writer here.
 */
export function applyFogToFlats(
  surfaces: FlatSurface[],
  meshes: Map<string, THREE.Mesh>,
  fogAlphaOf: (subsector: number) => number,
): void {
  const dirty = new Set<string>();

  for (const s of surfaces) {
    const value = fogAlphaOf(s.subsector);
    const attr = meshes.get(s.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr) continue;
    if (attr.getW(s.vertexStart) === value) continue;
    for (let v = 0; v < s.vertexCount; v++) attr.setW(s.vertexStart + v, value);
    dirty.add(s.key);
  }

  for (const key of dirty) {
    const attr = meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
  }
}
