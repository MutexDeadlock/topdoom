import * as THREE from 'three';
import type { WallOccluder } from './mapmesh.ts';

/**
 * Target coverage (0..1) once a wall sits on the camera-player sightline —
 * rendered as a dithered discard (see MaterialBank.get), not real alpha
 * blending, so this reads as "fraction of pixels kept," not translucency.
 */
const FADE_ALPHA = 0.2;
/** Exponential smoothing rate (1/seconds) so fades don't pop in/out per frame. */
const FADE_SPEED = 10;

/**
 * Fades the specific wall quad(s) currently between the camera and the
 * player, rather than the coarser fix of drawing the player on top of
 * everything (which would also show it through walls that genuinely
 * separate it from the camera). Wall quads are already backface-culled when
 * their front faces away from the camera (see mapmesh.ts's dollhouse
 * comment) — this covers what's left: quads that legitimately face the
 * camera but happen to sit on the line of sight to the player.
 */
export class WallFader {
  private occluders: WallOccluder[];
  private meshes: Map<string, THREE.Mesh>;
  private alpha: Float32Array;

  constructor(occluders: WallOccluder[], meshes: Map<string, THREE.Mesh>) {
    this.occluders = occluders;
    this.meshes = meshes;
    this.alpha = new Float32Array(occluders.length).fill(1);
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
    const lerpT = 1 - Math.exp(-FADE_SPEED * dt);
    const dirty = new Set<string>();

    for (let i = 0; i < this.occluders.length; i++) {
      const o = this.occluders[i];
      const cross = segmentIntersect(camX, camY, targetX, targetY, o.ax, o.ay, o.bx, o.by);
      let occluding = false;
      if (cross) {
        const height = camZ + (targetZ - camZ) * cross.t;
        occluding = height > o.botH && height < o.topH;
      }

      const target = occluding ? FADE_ALPHA : 1;
      const prev = this.alpha[i];
      let next = prev + (target - prev) * lerpT;
      // The exponential approach never actually reaches `target` — left as
      // pure lerp, a wall settles a hair short of fully opaque (e.g. 0.996)
      // and stays there forever once the per-frame delta drops below the
      // skip threshold below. Since the dither test is a strict `<`, that
      // permanent gap still discards the sliver of pixels whose per-pixel
      // threshold lands in it, i.e. a faint residual speckle on a wall
      // that's supposed to be fully solid again. Snapping once close closes
      // the gap for good instead of leaving it asymptotically open.
      if (Math.abs(target - next) < 0.004) next = target;
      if (next === prev) continue;

      this.alpha[i] = next;
      const attr = this.meshes.get(o.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      for (let v = 0; v < o.vertexCount; v++) attr.setW(o.vertexStart + v, next);
      dirty.add(o.key);
    }

    for (const key of dirty) {
      const attr = this.meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}

/**
 * 2D segment intersection between (ax,ay)-(bx,by) and (cx,cy)-(dx,dy).
 * Returns the crossing's parameter `t` along the first segment, or null if
 * they don't cross within both segments' bounds.
 */
function segmentIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { t: number } | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;

  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;

  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t };
}
