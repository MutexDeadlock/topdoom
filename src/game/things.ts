import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { World } from './world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
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
  commitTarget,
  DI_NODIR,
  MONSTER_FIRE_HEIGHT,
  MONSTER_STATS,
  reactToDamage,
  shouldRetarget,
  stepMonsterAI,
  tryWake,
  type MonsterAttack,
} from './monsters.ts';
import type { ThingBlocker } from './world.ts';
import { SpriteActor, SpriteMaterialCache } from '../render/sprites.ts';

interface PosedThing {
  /** 
   * Index into the `posed` array itself.
   * A stable handle callers (game.ts) can hold onto across frames to target 
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
  attackPause: number;
  burstLeft: number;
  burstTimer: number;
  chargeTimer: number;
  chargeAngle: number;
  painTimer: number;
  movedir: number;
  movecount: number;
  chaseTimer: number;
  moveBlocked: boolean;
  threshold: number;
  justHit: boolean;
  justAttacked: boolean;
  reactionTicks: number;
  refiring: boolean;
  /**
   * Seconds since this monster's last idle look-around. Separate from the AI
   * timers above because it only ticks *before* the monster wakes, and
   * `game/monsters.ts` has no business knowing the throttle exists.
   */
  lookTimer: number;
  /** Position at the end of the previous frame, so `crossLines` can test the segment this monster just walked. */
  prevX: number;
  prevY: number;
  /**
   * Who this monster is currently hunting: `null` for the player, otherwise
   * another `PosedThing`'s id. Set by `damage` when something hurts it (see
   * `shouldRetarget`) — the mechanism behind infighting — and reset to the
   * player once that target dies.
   */
  targetId: number | null;
}

/**
 * A monster's fired attack, plus who fired it and at what — `game.ts` turns a
 * `'ranged'` one into a tracer or projectile and applies `damage` to whatever
 * it actually reaches.
 */
export interface MonsterAttackEvent extends MonsterAttack {
  x: number;
  y: number;
  z: number;
  /** The firing monster's own id and doomednum, so a shot that lands on another monster can be attributed (and species-checked) correctly. */
  sourceId: number;
  sourceType: number;
  /** What it was aimed at: `null` for the player, otherwise another monster's id. */
  targetId: number | null;
}

/**
 * How far around a moving body to look for other bodies it could bump into.
 * Must exceed the largest possible contact reach — two spider masterminds, at
 * 128 units of radius each — with room to spare for a frame's movement.
 */
const BLOCKER_SEARCH_RADIUS = 320;

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
 * than just missing art. A ranged attack's tracer (game.ts) is the actual
 * on-screen "it's firing" cue instead.
 */
const MONSTER_WALK_FRAMES = ['A', 'B', 'C', 'D'];

export interface ThingLayer {
  group: THREE.Group;
  count: number;
  /**
   * Every living monster near (x, y) as a solid body the *player* has to walk
   * around — vanilla's monsters are all `MF_SOLID`, so they block a mover the
   * same way a wall does. Monsters get the equivalent list built for them
   * internally (`blockersFor`); this is the outward-facing half, for
   * `game.ts` to hand to `Player.update`.
   */
  solidBodies(x: number, y: number): ThingBlocker[];
  /**
   * Re-poses every thing at the camera's current viewer angle and, for a
   * living `MONSTER_TYPES` thing, ticks its AI (`game/monsters.ts`): an
   * unalerted monster re-checks line of sight to `player` every
   * `LOOK_INTERVAL`, and once alerted, `stepMonsterAI` moves/faces/attacks it
   * every frame — `groundFloor` and gravity integration mirror
   * `Player.update` exactly, so a chasing monster falls off ledges and steps
   * up onto low platforms the same way the player does, but movement itself
   * is vanilla's real 8-direction `P_NewChaseDir` pathing, not `slideMove`
   * (see `stepMonsterAI`'s own doc for why the player and monsters diverge
   * here). `player` is `null` while the player is dead, which freezes every
   * monster in place (nothing to chase) without touching their
   * pose/animation/fog-visibility, which keep updating normally. Returns
   * every attack fired this frame — the caller (`game.ts`) applies its
   * damage and, for a `'ranged'` one, draws a tracer or spawns a projectile.
   *
   * For anything else (or a dead/not-yet-alerted monster), `z` is refreshed
   * straight from the thing's sector's live `floorHeight`, the same "ride a
   * moving floor for free" trick as before monsters could move — a corpse
   * left on a lift still rides it, same as a pickup always has.
   * `fogAlphaOf`, when given, hides things sitting in a subsector fog of war
   * hasn't revealed yet (game/fogofwar.ts) — a monster or item in an
   * unexplored/secret room would otherwise spoil it despite the room's own
   * geometry being faded out. `crossLines`, when given, is called with the
   * segment each alerted monster just walked so the caller
   * (`SpecialsController.crossMonster`) can fire any walk trigger it crossed
   * (teleports, the handful of doors/lifts vanilla lets a monster open) —
   * see "Crushers and teleporters" in CLAUDE.md.
   */
  update(
    dt: number,
    viewerAngleDeg: number,
    player: { x: number; y: number; z: number } | null,
    fogAlphaOf?: (subsector: number) => number,
    crossLines?: (prevX: number, prevY: number, x: number, y: number) => { x: number; y: number; angle: number } | null,
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
   * null. Backs auto-aim (game.ts): aiming with the cursor over a monster
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
   * damage (game.ts); the caller still has to check line-of-sight itself,
   * since that needs the `World` this layer doesn't otherwise touch.
   */
  monstersNear(x: number, y: number, radius: number): { id: number; x: number; y: number; z: number; type: number }[];
  /** This exact monster's live position and type, or null if the id is stale or it has since died. Lets a shot fired at a monster keep tracking it across frames. */
  monsterById(id: number): { id: number; x: number; y: number; z: number; type: number } | null;
  /** Count of living monsters currently alerted (chasing/attacking, or mid-reaction-delay) — for the debug HUD. */
  awakeMonsterCount(): number;
  /**
   * Positions of the alerted monsters `awakeMonsterCount` counts, narrowed to
   * those actually being *rendered* right now — occlusion fading (game.ts)
   * treats each as an extra sightline target alongside the player, so a
   * wall/floor hiding a chasing monster fades the same way one hiding the
   * player does. Two exclusions, both load-bearing: anything not yet alerted
   * (an unseen sleeping monster is supposed to stay hidden), and anything
   * fog of war is currently hiding (`mesh.visible`, set from `fogAlphaOf` in
   * `update` above) — a monster in a subsector the player has never had
   * sight of isn't drawn at all, so fading the wall in front of it reveals
   * an empty dark room and nothing else. Must be called after `update` has
   * run for the frame, so `mesh.visible` reflects this frame's fog.
   */
  awakeMonsters(): { x: number; y: number; z: number }[];
  /**
   * Living monsters standing in exactly `sector` — a reference-equality check
   * against the same mutable `Sector` object `PosedThing.sector` was seeded
   * from (see that field's doc), not a sector-index lookup this layer has no
   * way to perform on its own. Backs crush damage (game.ts's `onCrush`
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
   *
   * `source`, when given, is who dealt the hit — another monster, not the
   * player (the player has no id in this layer, so its absence means "the
   * player"). This is the whole mechanism behind infighting: the victim
   * re-targets onto `source` if `monsters.ts: shouldRetarget` says it should
   * (not already committed elsewhere, source isn't an arch-vile, ...), the
   * same way vanilla's `P_DamageMobj` sets `target` regardless of who or what
   * caused the damage.
   */
  damage(id: number, amount: number, source?: { id: number; type: number }): void;
  /**
   * Nearest living monster whose body the ray from (x, y, z) along `angleRad`
   * crosses within `maxDist`, or null. Backs a *free* shot (no locked-on
   * target — `game.ts`'s `spawnShot`): a shot fired at a wall with a monster
   * standing in the way should still hit that monster, the way any real
   * hitscan trace would, rather than sailing straight through it to whatever
   * is behind. A locked shot doesn't need this — it already knows its exact
   * target — this is specifically for the "didn't click anything, but
   * something's in the path anyway" case. `MONSTER_HIT_RADIUS`/`_HEIGHT` are a
   * single approximate hitbox rather than each monster's real (and quite
   * varied — 16 to 128 units) vanilla radius, since modelling that accurately
   * would need a whole per-species size table for a check this approximate
   * to begin with.
   *
   * `opts` exists for a *monster's* own hitscan (`game.ts`'s
   * `resolveMonsterHitscan`), which has two needs a player's shot never has:
   * `ignoreId` excludes the shooter itself from its own trace, and
   * `includeHidden` skips the fog-of-war visibility filter, since fog of war
   * is a player-facing conceit — a monster shooting another monster in a room
   * the *player* hasn't seen yet must still connect.
   */
  raycastMonster(
    x: number,
    y: number,
    z: number,
    angleRad: number,
    maxDist: number,
    opts?: { ignoreId?: number; includeHidden?: boolean },
  ): { id: number; x: number; y: number; z: number; dist: number; type: number } | null;
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
      attackPause: 0,
      burstLeft: 0,
      burstTimer: 0,
      chargeTimer: 0,
      chargeAngle: 0,
      painTimer: 0,
      movedir: DI_NODIR,
      movecount: 0,
      chaseTimer: 0,
      moveBlocked: false,
      threshold: 0,
      justHit: false,
      justAttacked: false,
      reactionTicks: 0,
      refiring: false,
      lookTimer: 0,
      prevX: x,
      prevY: y,
      targetId: null,
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
      attackPause: 0,
      burstLeft: 0,
      burstTimer: 0,
      chargeTimer: 0,
      chargeAngle: 0,
      painTimer: 0,
      movedir: DI_NODIR,
      movecount: 0,
      chaseTimer: 0,
      moveBlocked: false,
      threshold: 0,
      justHit: false,
      justAttacked: false,
      reactionTicks: 0,
      refiring: false,
      lookTimer: 0,
      prevX: x,
      prevY: y,
      targetId: null,
    });
  }

  /**
   * Where a monster should currently be heading. `targetId` is non-null only
   * after something other than the player hurt it (`damage` → `shouldRetarget`),
   * and a target that dies hands attention straight back to the player —
   * vanilla's `A_Chase` does the same via `P_LookForPlayers` once
   * `target->health <= 0`, since there is nobody else for a monster to want.
   */
  function resolveTarget(p: PosedThing, player: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    if (p.targetId === null) return player;
    const other = posed[p.targetId];
    if (!other || other.dead) {
      p.targetId = null;
      p.threshold = 0;
      return player;
    }
    return other;
  }

  /**
   * The solid bodies near `p` that it can physically bump into — every other
   * living monster plus the player, matching vanilla, where every monster is
   * `MF_SOLID` and `PIT_CheckThing` stops a mover against it. Filtered by
   * `BLOCKER_SEARCH_RADIUS` so the box test in `circleBlocked` stays short;
   * `p` itself is excluded, since a body always overlaps where it already is.
   */
  function blockersFor(p: PosedThing, player: { x: number; y: number; z: number }): ThingBlocker[] {
    const out: ThingBlocker[] = [{ x: player.x, y: player.y, radius: PLAYER_RADIUS }];
    for (const other of posed) {
      if (other === p || other.dead || !MONSTER_TYPES.has(other.type)) continue;
      if (Math.abs(other.x - p.x) > BLOCKER_SEARCH_RADIUS || Math.abs(other.y - p.y) > BLOCKER_SEARCH_RADIUS) continue;
      out.push({ x: other.x, y: other.y, radius: MONSTER_STATS[other.type]?.radius ?? MONSTER_HIT_RADIUS });
    }
    return out;
  }

  return {
    group,
    count: posed.length,
    solidBodies(x: number, y: number): ThingBlocker[] {
      const out: ThingBlocker[] = [];
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type)) continue;
        if (Math.abs(p.x - x) > BLOCKER_SEARCH_RADIUS || Math.abs(p.y - y) > BLOCKER_SEARCH_RADIUS) continue;
        out.push({ x: p.x, y: p.y, radius: MONSTER_STATS[p.type]?.radius ?? MONSTER_HIT_RADIUS });
      }
      return out;
    },
    update(
      dt: number,
      viewerAngleDeg: number,
      player: { x: number; y: number; z: number } | null,
      fogAlphaOf?: (subsector: number) => number,
      crossLines?: (prevX: number, prevY: number, x: number, y: number) => { x: number; y: number; angle: number } | null,
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
            p.lookTimer += dt;
            if (p.lookTimer >= LOOK_INTERVAL) {
              p.lookTimer = 0;
              tryWake(p, world, p.sector, player.x, player.y, player.z);
            }
          }
          if (p.alerted) {
            const beforeX = p.x;
            const beforeY = p.y;
            const target = resolveTarget(p, player);
            const result = stepMonsterAI(p, stats, dt, world, target, blockersFor(p, player));
            // Walk triggers this monster crossed on the way (teleports,
            // and the handful of doors/lifts vanilla lets a monster open).
            const dest = crossLines?.(p.prevX, p.prevY, p.x, p.y);
            if (dest) {
              p.x = dest.x;
              p.y = dest.y;
              p.angle = (dest.angle * Math.PI) / 180;
              p.velZ = 0;
              // Re-route from scratch: the heading it had is meaningless on
              // the far side of the map.
              p.movedir = DI_NODIR;
              p.movecount = 0;
            }
            p.prevX = p.x;
            p.prevY = p.y;
            p.sector = world.sectorAt(p.x, p.y);
            p.subsector = world.subsectorAt(p.x, p.y);
            if (p.sector) p.light = p.sector.light;
            p.facingDeg = (p.angle * 180) / Math.PI;
            animating = p.x !== beforeX || p.y !== beforeY;
            if (result) {
              attacks.push({
                ...result,
                x: p.x,
                y: p.y,
                z: p.z + MONSTER_FIRE_HEIGHT,
                sourceId: p.id,
                sourceType: p.type,
                targetId: p.targetId,
              });
            }
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
    monstersNear(x: number, y: number, radius: number): { id: number; x: number; y: number; z: number; type: number }[] {
      const out: { id: number; x: number; y: number; z: number; type: number }[] = [];
      const rSq = radius * radius;
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type)) continue;
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy >= rSq) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type });
      }
      return out;
    },
    monsterById(id: number): { id: number; x: number; y: number; z: number; type: number } | null {
      const p = posed[id];
      if (!p || p.dead || !MONSTER_TYPES.has(p.type)) return null;
      return { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type };
    },
    awakeMonsterCount(): number {
      let n = 0;
      for (const p of posed) {
        if (!p.dead && MONSTER_TYPES.has(p.type) && p.alerted) n++;
      }
      return n;
    },
    awakeMonsters(): { x: number; y: number; z: number }[] {
      const out: { x: number; y: number; z: number }[] = [];
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type) || !p.alerted || !p.actor.mesh.visible) continue;
        out.push({ x: p.x, y: p.y, z: p.z });
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
    damage(id: number, amount: number, source?: { id: number; type: number }): void {
      const p = posed[id];
      if (!p || p.dead || amount <= 0 || !MONSTER_TYPES.has(p.type)) return;
      p.health -= amount;
      if (p.health > 0) {
        const stats = MONSTER_STATS[p.type];
        if (stats) reactToDamage(p, stats);
        // Being hurt always wakes a monster, sight or no — vanilla's
        // P_DamageMobj sets the target unconditionally.
        p.alerted = true;
        // ...and re-points it at whoever did it, which is the whole of
        // vanilla's infighting: a monster hit by another monster's stray shot
        // turns on the shooter exactly as it would on the player. `source`
        // absent means the player, who is already the default target.
        if (source && source.id !== p.id && stats && shouldRetarget(p, p.type, source.type)) {
          p.targetId = source.id;
          commitTarget(p);
        }
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
      opts?: { ignoreId?: number; includeHidden?: boolean },
    ): { id: number; x: number; y: number; z: number; dist: number; type: number } | null {
      const dx = Math.cos(angleRad);
      const dy = Math.sin(angleRad);
      let nearest: { id: number; x: number; y: number; z: number; dist: number; type: number } | null = null;
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type)) continue;
        if (p.id === opts?.ignoreId) continue;
        // Fog of war is a *player*-facing conceit; a monster shooting another
        // monster in an unrevealed room must still connect.
        if (!opts?.includeHidden && !p.actor.mesh.visible) continue;
        if (Math.abs(p.z - z) > MONSTER_HIT_HEIGHT) continue;
        const relX = p.x - x;
        const relY = p.y - y;
        const t = relX * dx + relY * dy;
        if (t < 0 || t > maxDist || (nearest && t >= nearest.dist)) continue;
        const perpX = relX - dx * t;
        const perpY = relY - dy * t;
        if (perpX * perpX + perpY * perpY > MONSTER_HIT_RADIUS * MONSTER_HIT_RADIUS) continue;
        nearest = { id: p.id, x: x + dx * t, y: y + dy * t, z: p.z, dist: t, type: p.type };
      }
      return nearest;
    },
  };
}
