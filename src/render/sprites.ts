import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { GraphicsBank } from '../wad/graphics.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import { hasLineOfSight, type World } from '../game/world.ts';
import { PLAYER_HEIGHT } from '../game/player.ts';
import {
  MONSTER_DEATH_FRAME_SECONDS,
  MONSTER_DEATH_FRAMES,
  MONSTER_DROPS,
  MONSTER_HEALTH,
  MONSTER_TYPES,
  MONSTER_XDEATH_FRAMES,
  THING_SPRITES,
  WEAPON_TYPES,
} from '../game/thingdefs.ts';
import { isAmbush, isMultiplayerOnly, spawnsAtSkill, type Skill } from '../game/skill.ts';
import {
  canSpotPlayer,
  MONSTER_FIRE_HEIGHT,
  MONSTER_STATS,
  REACTION_TIME,
  reactToDamage,
  stepMonsterAI,
  type MonsterAttack,
} from '../game/monsters.ts';
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
  /**
   * Feet height. For anything that never moves (every non-monster, and a
   * dead or not-yet-alerted monster) this is refreshed every frame straight
   * from `sector.floorHeight` in `update()`, the same "ride a moving floor
   * for free" trick as before monsters could move at all. Once a monster is
   * alerted, `stepMonsterAI` owns it instead (`groundFloor` + gravity, the
   * same physics `Player.update` uses), since a chasing monster needs to
   * fall off ledges and cross sector boundaries rather than trust a single
   * fixed sector reference.
   */
  z: number;
  /** Its containing sector — the live reference `z` is read from while not an alerted monster; reassigned each frame by `update()` once a monster starts moving. */
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
  /** True for an item `ThingLayer.damage` spawned itself (`MONSTER_DROPS`) rather than one the map placed — threaded through to `applyPickup`'s own `dropped` param, which halves the ammo it grants. */
  dropped: boolean;

  // --- Monster AI (game/monsters.ts) — inert defaults for every non-monster PosedThing. ---
  /** True once this monster has spotted the player and started chasing (`update`'s throttled wake check, LOOK_INTERVAL). */
  alerted: boolean;
  /** The map thing's "ambush"/deaf flag (`game/skill.ts: isAmbush`) — gates whether a sound-alerted sector alone can wake this monster; see `update`'s wake check. */
  ambush: boolean;
  velZ: number;
  angle: number;
  attackCooldown: number;
  painTimer: number;
  stuckTimer: number;
  stuckX: number;
  stuckY: number;
  jitterAngle: number;
  jitterTimer: number;
}

/** A monster's fired attack, plus where it fired from — `main.ts` turns a `'ranged'` one into a tracer and applies `damage` to the player either way. */
export interface MonsterAttackEvent extends MonsterAttack {
  x: number;
  y: number;
  z: number;
}

/** How often an unalerted monster re-checks line of sight to the player — vanilla's own idle `A_Look` calls run every 10 tics (~0.29s), not every tic. */
const LOOK_INTERVAL = 0.3;

/**
 * DOOM's own walk-cycle convention: every monster's RUN states step through 4
 * frames (A-D), the same convention `PLAY`'s own walk cycle already uses
 * elsewhere in this file. Unlike the death frames above, this isn't
 * rederived from the WAD itself (attack/pain frames aren't structurally
 * distinguishable from walk frames the way the rotation-0-only death tail
 * is) — it's vanilla's well-known `info.c` state layout, cross-checked
 * arithmetically against this file's own WAD-confirmed death-frame start
 * letters (e.g. POSS's death starting at `H`, position 8, matches exactly
 * 4 walk + 2 attack + 1 pain frame before it). Attack/pain get no dedicated
 * pose here for the same reason `SpriteActor`'s own doc gives for deferring
 * monster idle animation: guessing unconfirmed letters risks silently wrong
 * art rather than just missing art. A ranged attack's tracer (main.ts) is
 * the actual on-screen "it's firing" cue instead.
 */
const MONSTER_WALK_FRAMES = ['A', 'B', 'C', 'D'];

export interface ThingLayer {
  group: THREE.Group;
  count: number;
  /**
   * Re-poses every thing at the camera's current viewer angle and, for a
   * living `MONSTER_TYPES` thing, ticks its AI (`game/monsters.ts`): an
   * unalerted monster re-checks line of sight to `player` every
   * `LOOK_INTERVAL`, and once alerted, `stepMonsterAI` moves/faces/attacks it
   * every frame — same movement primitives (`slideMove`, `groundFloor`,
   * gravity) `Player.update` uses, so a chasing monster falls off ledges and
   * steps up onto low platforms the same way the player does. `player` is
   * `null` while the player is dead, which freezes every monster in place
   * (nothing to chase) without touching their pose/animation/fog-visibility,
   * which keep updating normally. Returns every attack fired this frame —
   * the caller (main.ts) applies its damage and, for a `'ranged'` one, draws
   * a tracer from where it fired.
   *
   * For anything else (or a dead/not-yet-alerted monster), `z` is refreshed
   * straight from the thing's sector's live `floorHeight`, the same "ride a
   * moving floor for free" trick as before monsters could move — a corpse
   * left on a lift still rides it, same as a pickup always has.
   * `fogAlphaOf`, when given, hides things sitting in a subsector fog of war
   * hasn't revealed yet (game/fogofwar.ts) — a monster or item in an
   * unexplored/secret room would otherwise spoil it despite the room's own
   * geometry being faded out.
   */
  update(
    dt: number,
    viewerAngleDeg: number,
    player: { x: number; y: number; z: number } | null,
    fogAlphaOf?: (subsector: number) => number,
  ): MonsterAttackEvent[];
  /**
   * Consumes every not-yet-picked thing within `radius` of (x, y) *and*
   * within reach vertically of `z` whose type `consume` accepts (returning
   * true), hiding it permanently. `consume` is the inventory-side effect
   * (game/inventory.ts's applyPickup) — this layer only owns which world
   * instance disappears, not what picking one up means. `consume`'s second
   * argument is the instance's own `dropped` flag, so a monster's dropped
   * clip/weapon can grant half ammo the way vanilla's own dropped pickups do.
   */
  tryPickup(x: number, y: number, z: number, radius: number, consume: (type: number, dropped: boolean) => boolean): void;
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

/**
 * Non-monster, non-weapon things (ammo, health/armor, keys, powerups,
 * decorations) are drawn at vanilla's native patch size times this factor.
 * The far, tilted top-down camera reads a lot worse than DOOM's own
 * ground-level first-person view at the same pixel size, and small
 * collectibles like a clip or a shell box are the ones that suffer most —
 * monsters are already large enough to read fine, and weapons already stand
 * out, so both are left at their native size instead.
 */
const PICKUP_SCALE = 1.4;

/** Whether `type` gets the up-scale above — everything except monsters and weapons. */
function pickupScaleFor(type: number): number {
  return MONSTER_TYPES.has(type) || WEAPON_TYPES.has(type) ? 1 : PICKUP_SCALE;
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
    const z = sector?.floorHeight ?? 0;
    const isMonster = MONSTER_TYPES.has(t.type);

    const actor = new SpriteActor(bank, materials, spriteName, isMonster ? MONSTER_WALK_FRAMES : ['A']);
    if (!actor.setPose(x, y, z, facingDeg, light)) continue;
    actor.mesh.scale.setScalar(pickupScaleFor(t.type));
    group.add(actor.mesh);
    posed.push({
      id: posed.length,
      actor,
      x,
      y,
      z,
      sector,
      facingDeg,
      light,
      subsector,
      type: t.type,
      picked: false,
      health: MONSTER_HEALTH[t.type] ?? Infinity,
      dead: false,
      dropped: false,
      alerted: false,
      ambush: isAmbush(t.flags),
      velZ: 0,
      angle: (facingDeg * Math.PI) / 180,
      attackCooldown: 0,
      painTimer: 0,
      stuckTimer: 0,
      stuckX: x,
      stuckY: y,
      jitterAngle: 0,
      jitterTimer: 0,
    });
  }

  /**
   * Spawns a monster's death drop (`MONSTER_DROPS`) at its own position —
   * called from `damage` below, the only place a `PosedThing` is ever added
   * after the initial map-load loop above. Mirrors that loop's own
   * pose/push, just for one instance instead of every map THING, and always
   * marked `dropped: true` (see `PosedThing`'s doc) so `tryPickup` grants it
   * at vanilla's halved dropped-item rate rather than a map-placed one's.
   */
  function spawnDrop(x: number, y: number, sector: Sector | undefined, facingDeg: number, type: number): void {
    const spriteName = THING_SPRITES[type];
    if (!spriteName) return;
    const light = sector?.light ?? 128;
    const z = sector?.floorHeight ?? 0;
    const subsector = world.subsectorAt(x, y);
    const actor = new SpriteActor(bank, materials, spriteName);
    if (!actor.setPose(x, y, z, facingDeg, light)) return;
    actor.mesh.scale.setScalar(pickupScaleFor(type));
    group.add(actor.mesh);
    posed.push({
      id: posed.length,
      actor,
      x,
      y,
      z,
      sector,
      facingDeg,
      light,
      subsector,
      type,
      picked: false,
      health: Infinity,
      dead: false,
      dropped: true,
      alerted: false,
      ambush: false,
      velZ: 0,
      angle: (facingDeg * Math.PI) / 180,
      attackCooldown: 0,
      painTimer: 0,
      stuckTimer: 0,
      stuckX: x,
      stuckY: y,
      jitterAngle: 0,
      jitterTimer: 0,
    });
  }

  return {
    group,
    count: posed.length,
    update(
      dt: number,
      viewerAngleDeg: number,
      player: { x: number; y: number; z: number } | null,
      fogAlphaOf?: (subsector: number) => number,
    ): MonsterAttackEvent[] {
      const attacks: MonsterAttackEvent[] = [];
      for (const p of posed) {
        if (p.picked) {
          p.actor.mesh.visible = false;
          continue;
        }

        let animating = false;
        const stats = !p.dead ? MONSTER_STATS[p.type] : undefined;
        if (stats && player) {
          if (!p.alerted) {
            // Throttled the same way vanilla's own idle A_Look is — see LOOK_INTERVAL.
            p.stuckTimer += dt;
            if (p.stuckTimer >= LOOK_INTERVAL) {
              p.stuckTimer = 0;
              // Matches vanilla's A_Look: a sound-alerted sector (World.noiseAlert,
              // fired on player gunshots) wakes this monster with no sight check
              // at all — unless it's "ambush"/deaf, which still needs to actually
              // see the source, just without the usual forward-FOV restriction
              // (see isAmbush's doc). Either way, a monster that isn't woken by
              // sound still falls through to the ordinary FOV+sight check every
              // monster gets, sound-alerted sector or not.
              const heardIt = !!p.sector && world.isSoundAlerted(p.sector);
              const seesDespiteDeaf = p.ambush && heardIt && hasLineOfSight(world, p.x, p.y, player.x, player.y);
              const heardAndAware = !p.ambush && heardIt;
              const spottedNormally =
                canSpotPlayer(p.facingDeg, p.x, p.y, player.x, player.y) && hasLineOfSight(world, p.x, p.y, player.x, player.y);
              if (seesDespiteDeaf || heardAndAware || spottedNormally) {
                p.alerted = true;
                // Starts moving immediately (matching vanilla) but can't fire
                // until REACTION_TIME passes — see that constant's doc for why
                // skipping this made a monster with a long sightline attack
                // the instant it came into view, with no perceptible reaction.
                p.attackCooldown = REACTION_TIME;
              }
            }
          }
          if (p.alerted) {
            const beforeX = p.x;
            const beforeY = p.y;
            const result = stepMonsterAI(p, stats, dt, world, player.x, player.y, player.z);
            p.sector = world.sectorAt(p.x, p.y);
            p.subsector = world.subsectorAt(p.x, p.y);
            if (p.sector) p.light = p.sector.light;
            p.facingDeg = (p.angle * 180) / Math.PI;
            animating = p.x !== beforeX || p.y !== beforeY;
            if (result) attacks.push({ ...result, x: p.x, y: p.y, z: p.z + MONSTER_FIRE_HEIGHT });
          } else {
            p.z = p.sector?.floorHeight ?? p.z;
          }
        } else {
          p.z = p.sector?.floorHeight ?? p.z;
        }

        p.actor.setPose(p.x, p.y, p.z, p.facingDeg, p.light, dt, animating, viewerAngleDeg);
        if (fogAlphaOf) p.actor.mesh.visible = fogAlphaOf(p.subsector) > 0.5;
      }
      return attacks;
    },
    tryPickup(x: number, y: number, z: number, radius: number, consume: (type: number, dropped: boolean) => boolean): void {
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
        if (consume(p.type, p.dropped)) {
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
      return p ? { id: p.id, x: p.x, y: p.y, z: p.z } : null;
    },
    monstersNear(x: number, y: number, radius: number): { id: number; x: number; y: number; z: number }[] {
      const out: { id: number; x: number; y: number; z: number }[] = [];
      const rSq = radius * radius;
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type)) continue;
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy >= rSq) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z });
      }
      return out;
    },
    monstersInSector(sector: Sector): { id: number; x: number; y: number; z: number }[] {
      const out: { id: number; x: number; y: number; z: number }[] = [];
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type) || p.sector !== sector) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z });
      }
      return out;
    },
    damage(id: number, amount: number): void {
      const p = posed[id];
      if (!p || p.dead || amount <= 0 || !MONSTER_TYPES.has(p.type)) return;
      p.health -= amount;
      if (p.health > 0) {
        const stats = MONSTER_STATS[p.type];
        if (stats) reactToDamage(p, stats);
        return;
      }
      p.dead = true;
      // Matches vanilla's P_KillMobj: gib only if this killing blow overkilled
      // by more than the monster's own max health, and only if it actually has
      // gib art (most don't — see MONSTER_XDEATH_FRAMES's doc).
      const maxHealth = MONSTER_HEALTH[p.type] ?? 0;
      const gibbed = p.health < -maxHealth && MONSTER_XDEATH_FRAMES[p.type];
      const frames = gibbed || MONSTER_DEATH_FRAMES[p.type];
      if (frames) p.actor.die(frames, MONSTER_DEATH_FRAME_SECONDS);
      else p.actor.mesh.visible = false;

      const dropType = MONSTER_DROPS[p.type];
      if (dropType) spawnDrop(p.x, p.y, p.sector, p.facingDeg, dropType);
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
        if (Math.abs(p.z - z) > MONSTER_HIT_HEIGHT) continue;
        const relX = p.x - x;
        const relY = p.y - y;
        const t = relX * dx + relY * dy;
        if (t < 0 || t > maxDist || (nearest && t >= nearest.dist)) continue;
        const perpX = relX - dx * t;
        const perpY = relY - dy * t;
        if (perpX * perpX + perpY * perpY > MONSTER_HIT_RADIUS * MONSTER_HIT_RADIUS) continue;
        nearest = { id: p.id, x: x + dx * t, y: y + dy * t, z: p.z, dist: t };
      }
      return nearest;
    },
  };
}
