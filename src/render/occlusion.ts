import * as THREE from 'three';
import type { FlatSurface, WallOccluder } from './mapmesh.ts';
import { pointNearConvexPolygon, segmentIntersect } from '../util/geom.ts';
import { dampen } from '../util/damping.ts';
import { PLAYER_RADIUS } from '../game/player.ts';

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
 * Fades a raised floor (a room "further up") when it sits between the camera
 * and the player on the way down — the same problem `WallFader` solves for
 * vertical walls, but for a horizontal plane: an elevated room's floor is
 * solid geometry too, and the tilted top-down camera can easily be looking
 * *through* the space above a lower room, past the underside of a floor it
 * doesn't clip, at a player standing beneath it.
 *
 * Only floors above the player's own eye height are considered (`s.height >
 * targetZ`), which is what keeps this from flagging the player's own current
 * floor: standing on a floor means that floor's height is at or below the
 * player's centre height, so it's excluded by construction rather than by
 * tracking "which subsector is the player in" separately. Ceilings
 * (`isCeiling`) are left out for now — `renderCeilings` is an off-by-default
 * debug toggle, and a room's own ceiling sitting directly above the player
 * would otherwise flag itself the same way every frame.
 *
 * The sightline only ever crosses a given height at one exact (x, y) point,
 * but a single physical floor (e.g. a raised platform) routinely gets split
 * into several adjacent subsector polygons by the BSP — that's a rendering
 * detail, invisible to the player. Testing the crossing point with plain
 * point-in-polygon would flag only whichever one fragment happens to contain
 * it, leaving the other fragments of the same platform solid right next to
 * the one that faded (confirmed on DOOM2 MAP05's rocket-ammo balcony, whose
 * sector is split into 3 subsectors at the same height). `pointNearConvexPolygon`
 * inflates the test by the player's own radius so neighbouring fragments the
 * player's width would also be behind fade together.
 */
export class FlatFader {
  private surfaces: FlatSurface[];
  private meshes: Map<string, THREE.Mesh>;
  private alpha: Float32Array;

  constructor(surfaces: FlatSurface[], meshes: Map<string, THREE.Mesh>) {
    this.surfaces = surfaces;
    this.meshes = meshes;
    this.alpha = new Float32Array(surfaces.length).fill(1);
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
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      let occluding = false;
      if (!s.isCeiling && s.height > targetZ && s.height < camZ) {
        const t = (s.height - camZ) / (targetZ - camZ);
        if (t > 0 && t < 1) {
          const x = camX + (targetX - camX) * t;
          const y = camY + (targetY - camY) * t;
          occluding = pointNearConvexPolygon(x, y, s.points, PLAYER_RADIUS);
        }
      }

      const target = occluding ? FADE_ALPHA : 1;
      this.alpha[i] = dampen(this.alpha[i], target, FADE_SPEED, dt, SNAP_EPS);
    }
  }

  /** Same combined occlusion × fog-of-war write as `WallFader.commit`. */
  commit(fogAlphaOf: (subsector: number) => number): void {
    const dirty = new Set<string>();

    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      const combined = this.alpha[i] * fogAlphaOf(s.subsector);
      const attr = this.meshes.get(s.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      if (attr.getW(s.vertexStart) === combined) continue;
      for (let v = 0; v < s.vertexCount; v++) attr.setW(s.vertexStart + v, combined);
      dirty.add(s.key);
    }

    for (const key of dirty) {
      const attr = this.meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}
