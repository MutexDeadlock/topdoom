import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { GraphicsBank } from '../wad/graphics.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { World } from '../game/world.ts';
import { PLAYER_HEIGHT } from '../game/player.ts';
import { THING_SPRITES } from '../game/thingdefs.ts';
import { isMultiplayerOnly, spawnsAtSkill, type Skill } from '../game/skill.ts';
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

interface CachedSprite {
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
 * A single thing rendered as an upright plane. The plane never tilts — see
 * SpriteMaterialCache's class doc — but does turn around its vertical axis
 * to keep facing the camera as it orbits, so posing an actor repositions it,
 * yaws it to the current viewer angle, and, if the facing angle or animation
 * frame now picks a different rotation frame, swaps in that lump's
 * geometry/material.
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

  private bank: SpriteBank;
  private materials: SpriteMaterialCache;
  private spriteName: string;
  private animFrames: string[];
  private frameDuration: number;

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
    viewerAngleDeg = VIEWER_ANGLE_DEG,
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

    const digit = pickRotationDigit(facingDeg, viewerAngleDeg);
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
    // The plane's un-rotated pose already faces VIEWER_ANGLE_DEG (see
    // SpriteMaterialCache's doc); turn it by however far the live viewer
    // angle has moved from that default so it keeps facing the camera.
    this.mesh.rotation.y = THREE.MathUtils.degToRad(viewerAngleDeg - VIEWER_ANGLE_DEG);
    (this.mesh.material as THREE.MeshBasicMaterial).color.setScalar(lightToColor(light));
    return true;
  }
}

interface PosedThing {
  actor: SpriteActor;
  x: number;
  y: number;
  /** Its containing sector, read live every frame — see `ThingLayer.update`'s doc on why `z` isn't cached. */
  sector: Sector | undefined;
  facingDeg: number;
  light: number;
  subsector: number;
  type: number;
  /** Set once a pickup consumes this instance; it then stays permanently hidden (see ThingLayer.update). */
  picked: boolean;
}

export interface ThingLayer {
  group: THREE.Group;
  count: number;
  /**
   * Re-poses every thing at the camera's current viewer angle. Things don't
   * move in x/y or animate yet, so this only ever changes which rotation-frame
   * lump is shown, which way each plane faces, and — because a thing's `z` is
   * read from its sector's live `floorHeight` rather than cached — its height,
   * so a pickup resting on a lift/floor-mover sector rides it up and down
   * exactly like the floor geometry itself does. SpriteActor.setPose already
   * skips the geometry/material swap when the resolved lump is unchanged from
   * last call, so this stays cheap. `fogAlphaOf`, when given, hides things
   * sitting in a subsector fog-of-war hasn't revealed yet (game/fogofwar.ts) —
   * a monster or item in an unexplored/secret room would otherwise spoil it
   * despite the room's own geometry being faded out.
   */
  update(viewerAngleDeg: number, fogAlphaOf?: (subsector: number) => number): void;
  /**
   * Consumes every not-yet-picked thing within `radius` of (x, y) *and*
   * within reach vertically of `z` whose type `consume` accepts (returning
   * true), hiding it permanently. `consume` is the inventory-side effect
   * (game/inventory.ts's applyPickup) — this layer only owns which world
   * instance disappears, not what picking one up means.
   */
  tryPickup(x: number, y: number, z: number, radius: number, consume: (type: number) => boolean): void;
}

/** One static upright plane per map THING whose type is a known, visible sprite. */
export function buildThingSprites(
  map: DoomMap,
  world: World,
  bank: SpriteBank,
  materials: SpriteMaterialCache,
  skill: Skill,
): ThingLayer {
  const group = new THREE.Group();
  group.name = 'things';
  const posed: PosedThing[] = [];

  for (const t of map.things) {
    const spriteName = THING_SPRITES[t.type];
    if (!spriteName) continue;
    if (isMultiplayerOnly(t.flags)) continue;
    if (!spawnsAtSkill(t.flags, skill)) continue;

    const subsector = world.subsectorAt(t.x, t.y);
    const sector = world.sectorAt(t.x, t.y);
    const x = t.x;
    const y = t.y;
    const facingDeg = t.angle;
    const light = sector?.light ?? 128;

    const actor = new SpriteActor(bank, materials, spriteName);
    if (!actor.setPose(x, y, sector?.floorHeight ?? 0, facingDeg, light)) continue;
    group.add(actor.mesh);
    posed.push({ actor, x, y, sector, facingDeg, light, subsector, type: t.type, picked: false });
  }

  return {
    group,
    count: posed.length,
    update(viewerAngleDeg: number, fogAlphaOf?: (subsector: number) => number): void {
      for (const p of posed) {
        if (p.picked) {
          p.actor.mesh.visible = false;
          continue;
        }
        p.actor.setPose(p.x, p.y, p.sector?.floorHeight ?? 0, p.facingDeg, p.light, 0, false, viewerAngleDeg);
        if (fogAlphaOf) p.actor.mesh.visible = fogAlphaOf(p.subsector) > 0.5;
      }
    },
    tryPickup(x: number, y: number, z: number, radius: number, consume: (type: number) => boolean): void {
      const rSq = radius * radius;
      for (const p of posed) {
        if (p.picked) continue;
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy > rSq) continue;
        // Matches vanilla's PIT_CheckThing overhead/underneath gate: a thing
        // sitting on a not-yet-lowered pillar is in 2D range but out of
        // physical reach, and must stay uncollected until the pillar drops
        // (e.g. DOOM2 MAP04's blue key). Read live off the sector rather than
        // a cached height for the same reason `update` does.
        if (Math.abs((p.sector?.floorHeight ?? 0) - z) > PLAYER_HEIGHT) continue;
        if (consume(p.type)) {
          p.picked = true;
          p.actor.mesh.visible = false;
        }
      }
    },
  };
}
