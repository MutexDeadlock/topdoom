/**
 * The player's blob shadow: one soft disc on the ground beneath them, faint while they stand on it
 * and darkening as they leave it, so a drop reads as a drop.
 * See docs/render.md § The player's shadow.
 */
import * as THREE from 'three';
import { smoothstep } from '../util/damping.ts';
import { doomToWorld } from './mapmesh.ts';
import { vecLength } from '../util/geom.ts';

/**
 * Disc radius in map units, against the player's own 16-unit radius (`game/player.ts`).
 * Tuned by feel — wider than the body, or it reads as a smudge rather than a mark on the floor.
 */
const RADIUS = 24;

/** Segments around the disc. Tuned by feel — enough that the rim never reads as a polygon. */
const SEGMENTS = 32;

/**
 * How far above the ground the disc sits, in map units. Site-local: floor heights are integers, so
 * any fraction clears the depth test against the floor it lies on without ever showing a gap.
 */
const LIFT = 0.25;

/** The two ends of the height ramp. Tuned by feel — docs/render.md § The player's shadow. */
const ALPHA_GROUNDED = 0.12;
const ALPHA_AIRBORNE = 0.45;

/**
 * Height above the ground, in map units, at which the darkening tops out. Tuned by feel and set
 * near a tall DOOM drop, so a step down barely registers. Exported with {@link shadowAlpha} so a
 * test states heights as points along the ramp
 * (docs/testing.md § Feel dials are read, never pinned).
 */
export const FALL_RANGE = 160;

/**
 * How dark the shadow draws at this height above its ground — {@link ALPHA_GROUNDED} at zero,
 * ramping to {@link ALPHA_AIRBORNE} at {@link FALL_RANGE} and holding there. Exported for the test.
 */
export function shadowAlpha(heightAboveGround: number): number {
  const t = Math.min(Math.max(heightAboveGround / FALL_RANGE, 0), 1);
  return ALPHA_GROUNDED + (ALPHA_AIRBORNE - ALPHA_GROUNDED) * t;
}

/** The disc, session-scoped like the player's own billboard. */
export class PlayerShadow {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshBasicMaterial;
  /** Multiplies the height ramp, so the invisibility powerup fades the shadow with the body. */
  private opacityScale = 1;

  constructor() {
    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: falloffTexture(),
      transparent: true,
      // The disc lies within half a unit of the floor it is cast on, so it must not write depth or
      // it fights every sprite standing in it.
      depthWrite: false,
      opacity: ALPHA_GROUNDED,
    });
    const geometry = new THREE.CircleGeometry(RADIUS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'playershadow';
  }

  /** What the screen effects fade the player's own billboard by (`game.ts`), applied here too. */
  setOpacityScale(scale: number): void {
    this.opacityScale = scale;
  }

  /**
   * Puts the disc under the player.
   *
   * @param groundZ  where they would stand here
   * @param feetZ    where they are now
   */
  update(x: number, y: number, groundZ: number, feetZ: number): void {
    doomToWorld(x, y, groundZ + LIFT, this.mesh.position);
    this.material.opacity = shadowAlpha(feetZ - groundZ) * this.opacityScale;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

/**
 * Fraction of the radius the soft rim takes up, the rest being solid core. Tuned by feel: a pure
 * radial gradient reads as a blur, a hard circle as a coin.
 */
const EDGE_FRACTION = 0.45;

/** Texture resolution of the falloff. Power of two, for mipmaps. */
const TEXTURE_SIZE = 64;

/** The disc's alpha falloff: opaque core, smooth rim, nothing outside the radius. */
function falloffTexture(): THREE.DataTexture {
  // RGB stays white and `material.color` supplies the black, so `opacity` alone drives strength;
  // only alpha is written below.
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4).fill(255);
  const centre = (TEXTURE_SIZE - 1) / 2;
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const r = vecLength(x - centre, y - centre) / (TEXTURE_SIZE / 2);
      const at = (y * TEXTURE_SIZE + x) * 4;
      data[at + 3] = Math.round(255 * smoothstep(Math.min(Math.max((1 - r) / EDGE_FRACTION, 0), 1)));
    }
  }
  const tex = new THREE.DataTexture(data, TEXTURE_SIZE, TEXTURE_SIZE, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
