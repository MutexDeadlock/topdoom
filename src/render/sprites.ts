import * as THREE from 'three';
import type { DoomMap } from '../wad/map.ts';
import type { GraphicsBank } from '../wad/graphics.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { World } from '../game/world.ts';
import { THING_SPRITES } from '../game/thingdefs.ts';
import { doomToWorld, lightToColor } from './mapmesh.ts';

/**
 * The camera never orbits (see TopDownCamera): its offset from whatever it
 * looks at is always south-and-tilted-up. So the direction from any point in
 * the level to the viewer is, for sprite-rotation purposes, this fixed
 * DOOM-space angle (0 = east, 90 = north, counter-clockwise) rather than
 * something recomputed per thing per frame.
 */
export const VIEWER_ANGLE_DEG = -90;

/** Which of a sprite's 8 rotation frames (1-8) faces this viewer angle, given the thing's own facing. */
export function pickRotationDigit(facingDeg: number, viewerAngleDeg = VIEWER_ANGLE_DEG): number {
  const diff = (((viewerAngleDeg - facingDeg) % 360) + 360) % 360;
  return (Math.floor((diff + 22.5) / 45) % 8) + 1;
}

interface CachedSprite {
  material: THREE.MeshBasicMaterial;
  geometry: THREE.BufferGeometry;
}

/**
 * Builds and caches billboard geometry/materials for sprite lumps, one per
 * (lump, mirrored) pair.
 *
 * Things are rendered as flat planes fixed upright in the world rather than
 * as THREE.Sprite billboards, which fully face the camera. A camera-facing
 * billboard tips flat whenever the camera tilts toward looking straight
 * down, making a standing DOOM sprite read as a figure lying on the floor.
 * Since this game's camera never changes azimuth (see VIEWER_ANGLE_DEG), the
 * "face the viewer" direction is the same fixed world direction for every
 * actor, so the plane's orientation can be baked in once instead of
 * recomputed as a true billboard: it only ever needs to stay vertical.
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
 * A single thing rendered as an upright plane. The plane's own orientation
 * never changes — see SpriteMaterialCache's class doc — so posing an actor
 * only ever repositions it and, if the facing angle or animation frame now
 * picks a different rotation frame, swaps in that lump's geometry/material.
 *
 * Animation is a plain frame-letter cycle, e.g. DOOM's own PLAY sprite reuses
 * A, B, C, D as a 4-step leg cycle while walking and simply holds frame A
 * while idle — there is no separate "idle" art, just the walk cycle stopped
 * on its first frame. `animFrames` defaults to a single held frame, which is
 * every non-animated actor (all things, for now).
 */
export class SpriteActor {
  readonly mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }));

  private lastKey = '';
  private animIndex = 0;
  private animTimer = 0;

  constructor(
    private bank: SpriteBank,
    private materials: SpriteMaterialCache,
    private spriteName: string,
    private animFrames: string[] = ['A'],
    private frameDuration = 4 * DOOM_TIC,
  ) {}

  /**
   * Repositions the actor and advances its animation; returns false if no
   * matching lump was found. `animating` selects the frame cycle (e.g. the
   * player only cycles legs while actually moving); while false the actor
   * holds on `animFrames[0]` and the cycle resets, so motion always resumes
   * from the first frame instead of wherever it happened to stop.
   */
  setPose(
    x: number,
    y: number,
    z: number,
    facingDeg: number,
    light: number,
    dt = 0,
    animating = false,
  ): boolean {
    if (animating && this.animFrames.length > 1) {
      this.animTimer += dt;
      while (this.animTimer >= this.frameDuration) {
        this.animTimer -= this.frameDuration;
        this.animIndex = (this.animIndex + 1) % this.animFrames.length;
      }
    } else {
      this.animTimer = 0;
      this.animIndex = 0;
    }

    const digit = pickRotationDigit(facingDeg);
    const found = this.bank.lookup(this.spriteName, this.animFrames[this.animIndex], digit);
    if (!found) return false;

    const key = found.lump + (found.flip ? ':f' : '');
    if (key !== this.lastKey) {
      const cached = this.materials.get(found.lump, found.flip);
      if (!cached) return false;
      this.mesh.geometry = cached.geometry;
      this.mesh.material = cached.material;
      this.lastKey = key;
    }

    doomToWorld(x, y, z, this.mesh.position);
    (this.mesh.material as THREE.MeshBasicMaterial).color.setScalar(lightToColor(light));
    return true;
  }
}

export interface ThingLayer {
  group: THREE.Group;
  count: number;
}

/** One static upright plane per map THING whose type is a known, visible sprite. */
export function buildThingSprites(
  map: DoomMap,
  world: World,
  bank: SpriteBank,
  materials: SpriteMaterialCache,
): ThingLayer {
  const group = new THREE.Group();
  group.name = 'things';
  let count = 0;

  for (const t of map.things) {
    const spriteName = THING_SPRITES[t.type];
    if (!spriteName) continue;

    const sector = world.sectorAt(t.x, t.y);
    const actor = new SpriteActor(bank, materials, spriteName);
    if (!actor.setPose(t.x, t.y, sector?.floorHeight ?? 0, t.angle, sector?.light ?? 128)) continue;
    group.add(actor.mesh);
    count++;
  }

  return { group, count };
}
