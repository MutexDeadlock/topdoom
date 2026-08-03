import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { World } from './world.ts';
import { PLAYER_HEIGHT } from './player.ts';
import {
  MONSTER_DEATH_FRAME_SECONDS,
  MONSTER_DEATH_FRAMES,
  MONSTER_DROPS,
  MONSTER_HEALTH,
  MONSTER_TYPES,
  MONSTER_XDEATH_FRAMES,
  THING_SPRITES,
  WEAPON_TYPES,
} from './thingdefs.ts';
import { isAmbush, isMultiplayerOnly, spawnsAtSkill, type Skill } from './skill.ts';
import {
  MONSTER_FIRE_HEIGHT,
  MONSTER_STATS,
  reactToDamage,
  stepMonsterAI,
  tryWake,
  type MonsterAttack,
} from './monsters.ts';
import { SpriteActor, SpriteMaterialCache } from '../render/sprites.ts';

interface PosedThing {
  /** 
   * Index into the `posed` array itself.
   * A stable handle callers (main.ts) can hold onto across frames to target 
   * this exact instance with `ThingLayer.damage`.
   */
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
  /** 
   * Its containing sector — the live reference `z` is read from while 
   * not an alerted monster; reassigned each frame by `update()` once a monster starts moving. 
   */
  sector: Sector | undefined;
  facingDeg: number;
  light: number;
  subsector: number;
  type: number;
  /** Set once a pickup consumes this instance; it then stays permanently hidden (see ThingLayer.update). */
  picked: boolean;
  /** 
   * Remaining hit points; 
   * only meaningful for a `MONSTER_TYPES` thing (see `MONSTER_HEALTH`).
   * everything else stays at `Infinity` and can never die. 
   */
  health: number;
  /** Set once `health` reaches 0; see `ThingLayer.damage`. */
  dead: boolean;
  /** 
   * True for an item `ThingLayer.damage` spawned itself (`MONSTER_DROPS`) rather than 
   * one the map placed — threaded through to `applyPickup`'s own `dropped` param, which halves the ammo it grants. 
   */
  dropped: boolean;

  // --- Monster AI (game/monsters.ts) — inert defaults for every non-monster PosedThing. ---
  /** True once this monster has spotted the player and started chasing (`update`'s throttled wake check, LOOK_INTERVAL). */
  alerted: boolean;
  /** 
   * The map thing's "ambush"/deaf flag (`game/skill.ts: isAmbush`) .
   * Gates whether a sound-alerted sector alone can wake this monster; see `update`'s wake check. 
   */
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

/** 
 * A monster's fired attack, plus where it fired from — `main.ts` turns a `'ranged'` one 
 * into a tracer and applies `damage` to the player either way.
 */
export interface MonsterAttackEvent extends MonsterAttack {
  x: number;
  y: number;
  z: number;
}

/** 
 * How often an unalerted monster re-checks line of sight to the player — 
 * vanilla's own idle `A_Look` calls run every 10 tics (~0.29s), not every tic. 
 */
const LOOK_INTERVAL = 0.3;

/**
 * DOOM's own walk-cycle convention: every monster's RUN states step through 4
 * frames (A-D), the same convention `PLAY`'s own walk cycle already uses for
 * the player actor. Unlike the death frames (`MONSTER_DEATH_FRAMES`), this
 * isn't rederived from the WAD itself (attack/pain frames aren't
 * structurally distinguishable from walk frames the way the rotation-0-only
 * death tail is) — it's vanilla's well-known `info.c` state layout,
 * cross-checked arithmetically against the WAD-confirmed death-frame start
 * letters (e.g. POSS's death starting at `H`, position 8, matches exactly
 * 4 walk + 2 attack + 1 pain frame before it). Attack/pain get no dedicated
 * pose here for the same reason monster idle animation is deferred
 * elsewhere: guessing unconfirmed letters risks silently wrong art rather
 * than just missing art. A ranged attack's tracer (main.ts) is the actual
 * on-screen "it's firing" cue instead.
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
            // The actual wake decision (FOV/sight/sound/ambush rules) lives in
            // game/monsters.ts's tryWake; this loop only owns the throttle.
            p.stuckTimer += dt;
            if (p.stuckTimer >= LOOK_INTERVAL) {
              p.stuckTimer = 0;
              tryWake(p, world, p.sector, player.x, player.y);
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
