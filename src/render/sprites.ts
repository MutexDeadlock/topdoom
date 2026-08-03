import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { GraphicsBank } from '../wad/graphics.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { World } from '../game/world.ts';
import { PLAYER_HEIGHT } from '../game/player.ts';
import {
  MONSTER_DEATH_FRAME_SECONDS,
  MONSTER_DEATH_FRAMES,
  MONSTER_HEALTH,
  MONSTER_TYPES,
  MONSTER_XDEATH_FRAMES,
  THING_SPRITES,
} from '../game/thingdefs.ts';
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

  /**
   * Once set (via `die`), permanently overrides the normal walk-cycle
   * animation with a one-shot sequence that advances forward and then holds
   * on its last frame forever — a corpse, not a loop. `setPose` ignores its
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
    let frames = this.animFrames;
    if (this.deathFrames) {
      frames = this.deathFrames;
      this.deathTimer += dt;
      while (this.deathTimer >= this.deathFrameDuration && this.deathIndex < frames.length - 1) {
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

    const digit = pickRotationDigit(facingDeg, viewerAngleDeg);
    const found = this.bank.lookup(this.spriteName, frames[this.animIndex], digit);
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

  /**
   * Switches this actor permanently into its one-shot death animation (see
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

interface PosedThing {
  /** Index into the `posed` array itself — a stable handle callers (main.ts) can hold onto across frames to target this exact instance with `ThingLayer.damage`. */
  id: number;
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
  /** Remaining hit points; only meaningful for a `MONSTER_TYPES` thing (see `MONSTER_HEALTH`) — everything else stays at `Infinity` and can never die. */
  health: number;
  /** Set once `health` reaches 0; see `ThingLayer.damage`. */
  dead: boolean;
}

export interface ThingLayer {
  group: THREE.Group;
  count: number;
  /**
   * Re-poses every thing at the camera's current viewer angle. Things don't
   * move in x/y or hold a walk cycle, so `dt` only ever matters for a dead
   * monster's death animation (SpriteActor.die) — everything else this
   * changes (which rotation-frame lump is shown, which way each plane faces,
   * and — because a thing's `z` is read from its sector's live `floorHeight`
   * rather than cached — its height, so a pickup resting on a lift/floor-mover
   * sector rides it up and down exactly like the floor geometry itself does)
   * is dt-independent. SpriteActor.setPose already skips the geometry/material
   * swap when the resolved lump is unchanged from last call, so this stays
   * cheap. `fogAlphaOf`, when given, hides things sitting in a subsector fog
   * of war hasn't revealed yet (game/fogofwar.ts) — a monster or item in an
   * unexplored/secret room would otherwise spoil it despite the room's own
   * geometry being faded out.
   */
  update(dt: number, viewerAngleDeg: number, fogAlphaOf?: (subsector: number) => number): void;
  /**
   * Consumes every not-yet-picked thing within `radius` of (x, y) *and*
   * within reach vertically of `z` whose type `consume` accepts (returning
   * true), hiding it permanently. `consume` is the inventory-side effect
   * (game/inventory.ts's applyPickup) — this layer only owns which world
   * instance disappears, not what picking one up means.
   */
  tryPickup(x: number, y: number, z: number, radius: number, consume: (type: number) => boolean): void;
  /**
   * DOOM (x, y, floor height) of the visible monster this ray hits first, or
   * null. Backs auto-aim (main.ts): aiming with the cursor over a monster
   * locks onto it instead of wherever the mouse's floor-plane projection
   * landed — both its position (so the shot's angle is exact even when the
   * click lands high on the sprite, far from the monster's own footprint)
   * and its height (so a shot bound for a monster standing on a raised or
   * lowered floor travels at *its* height, not the player's). Restricted the
   * same way `update`'s visibility toggle is — a monster fog of war hasn't
   * revealed, one already picked (dead end for a monster today, but the
   * check costs nothing to keep uniform), or one already dead — can't be
   * targeted through geometry that hides it on screen, or after it's been
   * killed. The returned `id` is what `damage` below takes, so a shot fired
   * this frame can still land on exactly this instance later (a projectile's
   * flight, or a wall check that might block it first) without re-picking.
   */
  pickMonster(raycaster: THREE.Raycaster): { id: number; x: number; y: number; z: number } | null;
  /**
   * Living monsters within `radius` (2D — matching vanilla's own radius-attack
   * distance test, which ignores height) of (x, y). Candidates for splash
   * damage (main.ts); the caller still has to check line-of-sight itself,
   * since that needs the `World` this layer doesn't otherwise touch.
   */
  monstersNear(x: number, y: number, radius: number): { id: number; x: number; y: number; z: number }[];
  /**
   * Living monsters standing in exactly `sector` — a reference-equality check
   * against the same mutable `Sector` object `PosedThing.sector` was seeded
   * from (see that field's doc), not a sector-index lookup this layer has no
   * way to perform on its own. Backs crush damage (main.ts's `onCrush`
   * callback into `SpecialsController`): a crusher/crushing floor knows only
   * which sector it's squeezing, not who's standing in it.
   */
  monstersInSector(sector: Sector): { id: number; x: number; y: number; z: number }[];
  /**
   * Applies `amount` damage to the monster `pickMonster`/`monstersNear`
   * returned as `id`, switching it to its death animation once health drops
   * to 0 — gibbed (`MONSTER_XDEATH_FRAMES`) instead of a plain death
   * (`MONSTER_DEATH_FRAMES`) if the killing blow overkilled by enough margin,
   * matching vanilla's own `P_KillMobj` rule, or just hiding it for a monster
   * type with no confirmed death art at all. A no-op if `id` is stale,
   * already dead, or the amount is non-positive — a projectile's flight can
   * outlive whatever picked its target, and splash damage rolls a falloff
   * that can reach 0 at the blast's edge.
   */
  damage(id: number, amount: number): void;
  /**
   * Nearest living monster whose body the ray from (x, y, z) along `angleRad`
   * crosses within `maxDist`, or null. Backs a *free* shot (no locked-on
   * target — main.ts's `spawnShot`): a shot fired at a wall with a monster
   * standing in the way should still hit that monster, the way any real
   * hitscan trace would, rather than sailing straight through it to whatever
   * is behind. A locked shot doesn't need this — it already knows its exact
   * target — this is specifically for the "didn't click anything, but
   * something's in the path anyway" case. `MONSTER_HIT_RADIUS`/`_HEIGHT` are a
   * single approximate hitbox rather than each monster's real (and quite
   * varied — 16 to 128 units) vanilla radius, since modelling that accurately
   * would need a whole per-species size table for a check this approximate
   * to begin with.
   */
  raycastMonster(
    x: number,
    y: number,
    z: number,
    angleRad: number,
    maxDist: number,
  ): { id: number; x: number; y: number; z: number; dist: number } | null;
}

/**
 * Single approximate hitbox `ThingLayer.raycastMonster` tests a free shot's
 * ray against — see that method's doc for why this isn't per-species.
 */
const MONSTER_HIT_RADIUS = 24;
const MONSTER_HIT_HEIGHT = 64;

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
    posed.push({
      id: posed.length,
      actor,
      x,
      y,
      sector,
      facingDeg,
      light,
      subsector,
      type: t.type,
      picked: false,
      health: MONSTER_HEALTH[t.type] ?? Infinity,
      dead: false,
    });
  }

  return {
    group,
    count: posed.length,
    update(dt: number, viewerAngleDeg: number, fogAlphaOf?: (subsector: number) => number): void {
      for (const p of posed) {
        if (p.picked) {
          p.actor.mesh.visible = false;
          continue;
        }
        p.actor.setPose(p.x, p.y, p.sector?.floorHeight ?? 0, p.facingDeg, p.light, dt, false, viewerAngleDeg);
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
    pickMonster(raycaster: THREE.Raycaster): { id: number; x: number; y: number; z: number } | null {
      const byMesh = new Map<THREE.Object3D, PosedThing>();
      for (const p of posed) {
        if (p.picked || p.dead || !p.actor.mesh.visible || !MONSTER_TYPES.has(p.type)) continue;
        byMesh.set(p.actor.mesh, p);
      }
      const hit = raycaster.intersectObjects([...byMesh.keys()], false)[0];
      if (!hit) return null;
      const p = byMesh.get(hit.object);
      return p ? { id: p.id, x: p.x, y: p.y, z: p.sector?.floorHeight ?? 0 } : null;
    },
    monstersNear(x: number, y: number, radius: number): { id: number; x: number; y: number; z: number }[] {
      const out: { id: number; x: number; y: number; z: number }[] = [];
      const rSq = radius * radius;
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type)) continue;
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy >= rSq) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.sector?.floorHeight ?? 0 });
      }
      return out;
    },
    monstersInSector(sector: Sector): { id: number; x: number; y: number; z: number }[] {
      const out: { id: number; x: number; y: number; z: number }[] = [];
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type) || p.sector !== sector) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: sector.floorHeight });
      }
      return out;
    },
    damage(id: number, amount: number): void {
      const p = posed[id];
      if (!p || p.dead || amount <= 0 || !MONSTER_TYPES.has(p.type)) return;
      p.health -= amount;
      if (p.health > 0) return;
      p.dead = true;
      // Matches vanilla's P_KillMobj: gib only if this killing blow overkilled
      // by more than the monster's own max health, and only if it actually has
      // gib art (most don't — see MONSTER_XDEATH_FRAMES's doc).
      const maxHealth = MONSTER_HEALTH[p.type] ?? 0;
      const gibbed = p.health < -maxHealth && MONSTER_XDEATH_FRAMES[p.type];
      const frames = gibbed || MONSTER_DEATH_FRAMES[p.type];
      if (frames) p.actor.die(frames, MONSTER_DEATH_FRAME_SECONDS);
      else p.actor.mesh.visible = false;
    },
    raycastMonster(
      x: number,
      y: number,
      z: number,
      angleRad: number,
      maxDist: number,
    ): { id: number; x: number; y: number; z: number; dist: number } | null {
      const dx = Math.cos(angleRad);
      const dy = Math.sin(angleRad);
      let nearest: { id: number; x: number; y: number; z: number; dist: number } | null = null;
      for (const p of posed) {
        if (p.dead || !p.actor.mesh.visible || !MONSTER_TYPES.has(p.type)) continue;
        const floorZ = p.sector?.floorHeight ?? 0;
        if (Math.abs(floorZ - z) > MONSTER_HIT_HEIGHT) continue;
        const relX = p.x - x;
        const relY = p.y - y;
        const t = relX * dx + relY * dy;
        if (t < 0 || t > maxDist || (nearest && t >= nearest.dist)) continue;
        const perpX = relX - dx * t;
        const perpY = relY - dy * t;
        if (perpX * perpX + perpY * perpY > MONSTER_HIT_RADIUS * MONSTER_HIT_RADIUS) continue;
        nearest = { id: p.id, x: x + dx * t, y: y + dy * t, z: floorZ, dist: t };
      }
      return nearest;
    },
  };
}
