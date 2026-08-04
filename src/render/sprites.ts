import * as THREE from 'three';
import type { GraphicsBank } from '../wad/graphics.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import { doomToWorld, lightToColor } from './mapmesh.ts';

/**
 * Default viewer angle (DOOM-space, 0 = east, 90 = north, counter-clockwise):
 * due south, matching TopDownCamera's yaw=0. The camera can orbit (see
 * TopDownCamera.viewerAngleDeg), so this constant is only the fallback for
 * callers that don't pass a live angle; SpriteActor.setPose is re-called
 * every frame with the camera's actual current viewer angle.
 */
export const VIEWER_ANGLE_DEG = -90;

/** Which of a sprite's 8 rotation frames (1-8) faces this viewer angle, given the thing's own facing. */
export function pickRotationDigit(facingDeg: number, viewerAngleDeg = VIEWER_ANGLE_DEG): number {
  const diff = (((viewerAngleDeg - facingDeg) % 360) + 360) % 360;
  return (Math.floor((diff + 22.5) / 45) % 8) + 1;
}

export interface CachedSprite {
  material: THREE.MeshBasicMaterial;
  geometry: THREE.BufferGeometry;
}

/**
 * Builds and caches billboard geometry/materials for sprite lumps, one per
 * (lump, mirrored) pair.
 *
 * Things are rendered as flat planes fixed upright in the world rather than
 * as THREE.Sprite billboards, which fully face the camera on every axis. A
 * camera-facing billboard tips flat whenever the camera tilts toward looking
 * straight down, making a standing DOOM sprite read as a figure lying on the
 * floor. Since this game's camera only ever tilts a fixed amount off
 * vertical (it can orbit in yaw, but never pitches further down or up), the
 * plane only ever needs to turn around its vertical axis to track the
 * camera's azimuth (see SpriteActor.setPose's viewerAngleDeg), never tilt —
 * a cheaper, always-upright approximation instead of a true billboard.
 */
export class SpriteMaterialCache {
  private cache = new Map<string, CachedSprite | null>();
  private gfx: GraphicsBank;
  private maxAnisotropy = 1;

  constructor(gfx: GraphicsBank, renderer?: THREE.WebGLRenderer) {
    this.gfx = gfx;
    if (renderer) this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  }

  get(lump: string, flip: boolean): CachedSprite | null {
    const key = lump + (flip ? ':flip' : '');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const bmp = this.gfx.picture(lump);
    let result: CachedSprite | null = null;
    if (bmp) {
      const texture = new THREE.DataTexture(bmp.data, bmp.width, bmp.height, THREE.RGBAFormat);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.maxAnisotropy;

      // WAD bitmaps start at their top row, but a plane's default UVs put v=0
      // along its bottom edge, so the art arrives upside down. Texture.flipY
      // cannot fix it: WebGL only honours UNPACK_FLIP_Y_WEBGL for image
      // sources, not for the typed-array uploads every DataTexture uses —
      // hence the V axis is inverted through the texture transform instead.
      // (The map meshes dodge this by building their own UVs with V running
      // downward.)
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.y = -1;
      texture.offset.y = 1;

      // Horizontal centring uses the patch's `left` hotspot, DOOM's usual
      // convention. Vertically, DOOM instead trusts `top` (world position =
      // thing.z + top, i.e. the top edge sits `top` units above the floor)
      // and gets away with whatever slack that leaves beneath the sprite
      // because its software renderer floor-clips every column and the
      // camera sits near floor height anyway. Neither safety net exists
      // here — a tilted-down 3D view over an unclipped plane — so any patch
      // whose `top` is less than its full height would draw with its feet
      // below the floor. Anchoring the bottom edge to the floor outright
      // sidesteps that instead of trusting the offset.
      const left = bmp.left ?? bmp.width / 2;
      let offsetX = bmp.width / 2 - left;
      const offsetY = bmp.height / 2;

      if (flip) {
        // Mirrors the U axis: DOOM reuses one lump for two mirrored
        // rotations. The hotspot mirrors with it.
        texture.wrapS = THREE.RepeatWrapping;
        texture.repeat.x = -1;
        texture.offset.x = 1;
        offsetX = -offsetX;
      }
      texture.needsUpdate = true;

      const geometry = new THREE.PlaneGeometry(bmp.width, bmp.height);
      geometry.translate(offsetX, offsetY, 0);
      // An all-white per-vertex color, purely so the *instanced* path
      // (render/spritebatch.ts) can tint each instance by its own sector
      // light. three.js's fragment shader only multiplies `vColor` in under
      // `USE_COLOR` — i.e. `material.vertexColors` — and `USE_INSTANCING_COLOR`
      // alone populates `vColor` in the vertex shader but is then ignored
      // downstream, so an InstancedMesh's per-instance color needs
      // `vertexColors: true`, which in turn needs this attribute to exist or
      // WebGL's default (0,0,0) generic attribute renders every sprite black.
      // White here means the instanced path's tint is exactly its instanceColor.
      // Ignored entirely by the non-instanced material below (`vertexColors`
      // stays false there), which tints via `material.color` instead.
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(1), 3));

      const material = new THREE.MeshBasicMaterial({
        map: texture,
        alphaTest: 0.5,
        transparent: false,
        fog: true,
        // The fixed-orientation approximation can put the camera behind a
        // thing far from the player (see class doc); a single-sided plane
        // would simply vanish there.
        side: THREE.DoubleSide,
      });
      result = { material, geometry };
    }
    this.cache.set(key, result);
    return result;
  }

  dispose(): void {
    for (const c of this.cache.values()) {
      c?.material.map?.dispose();
      c?.material.dispose();
      c?.geometry.dispose();
    }
    this.cache.clear();
  }
}

/** Vanilla DOOM runs its state machine at 35 tics/second. */
const DOOM_TIC = 1 / 35;

/**
 * The frame-cycle state of one animated sprite, and the lookup from that
 * state to the geometry/material actually drawn — with **no `THREE.Object3D`
 * of its own**. That split is what lets the same animation logic serve both
 * ways this engine draws a sprite: `SpriteActor` below (one `THREE.Mesh` per
 * sprite, for the handful of standalone actors — the player, teleport fog,
 * projectiles, impacts) and `render/spritebatch.ts`'s `SpriteBatch` (one
 * `InstancedMesh` per lump, for `game/things.ts`'s map things, of which a
 * stress-test map like NUTS.WAD has over ten thousand — see SpriteBatch's own
 * doc for why those must not be one mesh each).
 *
 * Animation is a plain frame-letter cycle, e.g. DOOM's own PLAY sprite reuses
 * A, B, C, D as a 4-step leg cycle while walking and simply holds frame A
 * while idle — there is no separate "idle" art, just the walk cycle stopped
 * on its first frame. `animFrames` defaults to a single held frame, which is
 * every non-animated actor.
 */
export class SpriteAnimator {
  private lastKey = '';
  private cached: CachedSprite | null = null;
  private animIndex = 0;
  private animTimer = 0;

  private bank: SpriteBank;
  private materials: SpriteMaterialCache;
  private spriteName: string;
  private animFrames: string[];
  private frameDuration: number;

  /**
   * Once set (via `die`), permanently overrides the normal walk-cycle
   * animation with a one-shot sequence that advances forward and then holds
   * on its last frame forever — a corpse, not a loop. `advance` ignores its
   * own `animating` parameter entirely while this is set: unlike the alive
   * cycle (which idles by holding frame 0 and resumes from the start once
   * moving again), a death animation has no "idle" state to fall back to and
   * must never run in reverse or reset.
   */
  private deathFrames: string[] | null = null;
  private deathFrameDuration = 0;
  private deathIndex = 0;
  private deathTimer = 0;

  constructor(
    bank: SpriteBank,
    materials: SpriteMaterialCache,
    spriteName: string,
    animFrames: string[] = ['A'],
    frameDuration = 4 * DOOM_TIC,
  ) {
    this.bank = bank;
    this.materials = materials;
    this.spriteName = spriteName;
    this.animFrames = animFrames;
    this.frameDuration = frameDuration;
  }

  /**
   * Advances the frame cycle by `dt`. `animating` selects the cycle (e.g. the
   * player only cycles legs while actually moving); while false the actor
   * holds on `animFrames[0]` and the cycle resets, so motion always resumes
   * from the first frame instead of wherever it happened to stop.
   */
  advance(dt: number, animating: boolean): void {
    if (this.deathFrames) {
      this.deathTimer += dt;
      while (this.deathTimer >= this.deathFrameDuration && this.deathIndex < this.deathFrames.length - 1) {
        this.deathTimer -= this.deathFrameDuration;
        this.deathIndex++;
      }
      this.animIndex = this.deathIndex;
    } else if (animating && this.animFrames.length > 1) {
      this.animTimer += dt;
      while (this.animTimer >= this.frameDuration) {
        this.animTimer -= this.frameDuration;
        this.animIndex = (this.animIndex + 1) % this.animFrames.length;
      }
    } else {
      this.animTimer = 0;
      this.animIndex = 0;
    }
  }

  /**
   * The geometry/material for the current frame as seen from `viewerAngleDeg`,
   * or null if the WAD has no such lump. Memoized on the resolved lump name,
   * so the steady state (a sprite whose frame and rotation digit haven't
   * changed) costs one `SpriteBank` lookup and nothing else.
   */
  resolve(facingDeg: number, viewerAngleDeg: number): CachedSprite | null {
    const frames = this.deathFrames ?? this.animFrames;
    const digit = pickRotationDigit(facingDeg, viewerAngleDeg);
    const found = this.bank.lookup(this.spriteName, frames[this.animIndex], digit);
    if (!found) return null;

    const key = found.lump + (found.flip ? ':f' : '');
    if (key !== this.lastKey) {
      this.cached = this.materials.get(found.lump, found.flip);
      this.lastKey = key;
    }
    return this.cached;
  }

  /**
   * Switches this sprite permanently into its one-shot death animation (see
   * the `deathFrames` field doc). Idempotent-ish: calling it again just
   * restarts the sequence, which nothing currently does since a monster/the
   * player only dies once per life.
   */
  die(frames: string[], frameDuration: number): void {
    this.deathFrames = frames;
    this.deathFrameDuration = frameDuration;
    this.deathIndex = 0;
    this.deathTimer = 0;
  }

  /** Undoes `die`, back to the normal alive animation — used when a level restart brings the player back to life. */
  revive(): void {
    this.deathFrames = null;
    this.deathIndex = 0;
    this.deathTimer = 0;
    this.animIndex = 0;
    this.animTimer = 0;
  }
}

/**
 * One sprite drawn as its own upright `THREE.Mesh`. The plane never tilts —
 * see SpriteMaterialCache's class doc — but does turn around its vertical
 * axis to keep facing the camera as it orbits, so posing an actor
 * repositions it, yaws it to the current viewer angle, and, if the facing
 * angle or animation frame now picks a different rotation frame, swaps in
 * that lump's geometry/material.
 *
 * Used only for the handful of sprites that aren't map things — the player,
 * teleport fog, projectiles, impact explosions. Map things go through
 * `SpriteBatch` instead: one mesh each is fine for a dozen actors and far too
 * many draw calls for ten thousand.
 */
export class SpriteActor {
  readonly mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
  private anim: SpriteAnimator;

  constructor(
    bank: SpriteBank,
    materials: SpriteMaterialCache,
    spriteName: string,
    animFrames: string[] = ['A'],
    frameDuration = 4 * DOOM_TIC,
  ) {
    this.anim = new SpriteAnimator(bank, materials, spriteName, animFrames, frameDuration);
  }

  /** Repositions the actor and advances its animation; returns false if no matching lump was found. */
  setPose(
    x: number,
    y: number,
    z: number,
    facingDeg: number,
    light: number,
    dt = 0,
    animating = false,
    viewerAngleDeg = VIEWER_ANGLE_DEG,
  ): boolean {
    this.anim.advance(dt, animating);
    const cached = this.anim.resolve(facingDeg, viewerAngleDeg);
    if (!cached) return false;
    if (this.mesh.geometry !== cached.geometry) {
      this.mesh.geometry = cached.geometry;
      this.mesh.material = cached.material;
    }

    doomToWorld(x, y, z, this.mesh.position);
    // The plane's un-rotated pose already faces VIEWER_ANGLE_DEG (see
    // SpriteMaterialCache's doc); turn it by however far the live viewer
    // angle has moved from that default so it keeps facing the camera.
    this.mesh.rotation.y = THREE.MathUtils.degToRad(viewerAngleDeg - VIEWER_ANGLE_DEG);
    (this.mesh.material as THREE.MeshBasicMaterial).color.setScalar(lightToColor(light));
    return true;
  }

  die(frames: string[], frameDuration: number): void {
    this.anim.die(frames, frameDuration);
  }

  revive(): void {
    this.anim.revive();
  }
}
