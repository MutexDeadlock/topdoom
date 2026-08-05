import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { World } from './world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
import {
  MONSTER_ACTION_FRAME_SECONDS,
  MONSTER_ATTACK_FRAMES,
  MONSTER_CORPSE_VANISHES,
  MONSTER_DEATH_FRAME_SECONDS,
  MONSTER_DEATH_FRAMES,
  MONSTER_DROPS,
  MONSTER_HEALTH,
  MONSTER_PAIN_FRAMES,
  MONSTER_RAISE_FRAMES,
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
  type RaiseCandidate,
} from './monsters.ts';
import { circleBlocked, type ThingBlocker } from './world.ts';
import { SpriteAnimator, SpriteMaterialCache, VIEWER_ANGLE_DEG } from '../render/sprites.ts';
import { SpriteBatch } from '../render/spritebatch.ts';
import { doomToWorld, litColor } from '../render/mapmesh.ts';
import type { Placement, Pos2, Pos3 } from '../types.ts';

interface PosedThing extends Pos3 {
  /** 
   * Index into the `posed` array itself.
   * A stable handle callers (game.ts) can hold onto across frames to target 
   * this exact instance with `ThingLayer.damage`.
   */
  id: number;
  /**
   * This thing's animation state and current-lump lookup. Deliberately *not*
   * a `SpriteActor` (which owns a `THREE.Mesh`): every map thing is drawn
   * through the shared `SpriteBatch` instead, so ten thousand of them cost a
   * few dozen draw calls rather than ten thousand — see `SpriteBatch`'s doc.
   */
  anim: SpriteAnimator;
  /** Native-size multiplier (`pickupScaleFor`), handed to the batch each frame. */
  scale: number;
  /**
   * Collision radius, resolved once at spawn. `MONSTER_STATS` is a `Record`
   * with sparse numeric keys, so V8 backs it with a dictionary and every
   * `MONSTER_STATS[type]` is a hash lookup — fine anywhere it happens once,
   * but `blockersFor` was doing one per *candidate* per monster per frame
   * (hundreds of thousands), which cost more than the collision arithmetic it
   * was feeding.
   */
  blockRadius: number;
  /**
   * This type's attack/pain WAD frame letters (`MONSTER_ATTACK_FRAMES`/
   * `MONSTER_PAIN_FRAMES`), resolved once at spawn for the same reason
   * `blockRadius` is: both tables are sparse-numeric-key `Record`s, so a
   * lookup on every attack/pain event is a dictionary hash V8 has to do that
   * a one-time spawn-time resolve avoids. `undefined` for anything without a
   * table entry (every non-monster, and the few monster types missing one).
   */
  attackFrames: string[] | undefined;
  painFrames: string[] | undefined;
  /**
   * Whether this thing is drawn (and so targetable/shootable) right now:
   * fog of war hasn't revealed its subsector, it was picked up, or it died
   * with no death art. Replaces reading `mesh.visible` back off a per-thing
   * mesh, which the batched renderer no longer gives each thing.
   */
  visible: boolean;
  /** Permanently hidden regardless of fog — a consumed pickup, or a corpse with no death animation to play. */
  hidden: boolean;
  /** Scratch dedupe marker for `forEachMonsterAlongRay`, whose stepped cell neighbourhoods overlap. Meaningless between queries. */
  queryStamp: number;
  /**
   * Feet height (`Pos3.z`). For anything that never moves (every non-monster, and a
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
   * Seconds since `dead` was set. Vanilla's `PIT_VileCheck` refuses to raise
   * a corpse whose own death animation is still playing (`tics != -1`,
   * "not lying still yet") — `findRaisableCorpse` compares this against
   * `deathFrameCount * MONSTER_DEATH_FRAME_SECONDS` for the same gate.
   */
  deadTime: number;
  /** Frame count of whichever death animation (`MONSTER_DEATH_FRAMES` or the gibbed `MONSTER_XDEATH_FRAMES`) `ThingLayer.damage` actually played — set at time of death, read back by `deadTime`'s "still settling" check above. 0 for anything that never died with real death art (see `damage`'s `hidden` fallback). */
  deathFrameCount: number;
  /**
   * This type's resurrection frames (`MONSTER_RAISE_FRAMES`), resolved once
   * at spawn for the same reason `attackFrames`/`painFrames` are — and
   * doubles as the arch-vile's own eligibility test: `undefined` means this
   * type has no vanilla `raisestate` and `findRaisableCorpse` skips it
   * outright, matching vanilla's `raisestate == S_NULL` check.
   */
  raiseFrames: string[] | undefined;
  /**
   * Set once a dead barrel's own `A_Explode` has actually fired
   * (`BARREL_EXPLODE_DELAY_SECONDS` after death, not on death itself — see
   * that constant's doc), so `update()`'s per-frame `deadTime` check doesn't
   * re-fire it every subsequent frame. Meaningless for anything else.
   */
  barrelExploded: boolean;
  /**
   * Who dealt a barrel's killing blow, captured at the moment it died and
   * carried forward to its own `A_Explode` — vanilla's `P_RadiusAttack`
   * passes the exploding barrel's own `target` (whoever damaged it) as the
   * new blast's `bombsource`, which is how a chain of barrels keeps
   * attributing every link back to whoever set the first one off rather than
   * to the previous barrel in the chain. `null` means "the player", the same
   * convention `ThingLayer.damage`'s own `source` parameter already uses.
   * Meaningless for anything else.
   */
  explodeSource: { id: number; type: number } | null;
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
  /** Only meaningful for the revenant (see `MonsterBody.homingBias`'s doc); seeded/rerolled below regardless of type, the same as every other inert-elsewhere AI field. */
  homingBias: boolean;
  /**
   * Seconds since this monster's last idle look-around. Separate from the AI
   * timers above because it only ticks *before* the monster wakes, and
   * `game/monsters.ts` has no business knowing the throttle exists.
   */
  lookTimer: number;
  /** Position at the end of the previous frame, so `crossLines` can test the segment this monster just walked. Mutated in place; never re-allocated. */
  prev: Pos2;
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
export interface MonsterAttackEvent extends MonsterAttack, Pos3 {
  /** The firing monster's own id and doomednum, so a shot that lands on another monster can be attributed (and species-checked) correctly. */
  sourceId: number;
  sourceType: number;
  /** What it was aimed at: `null` for the player, otherwise another monster's id. */
  targetId: number | null;
}

/**
 * How far around the *player* to look for bodies they could bump into
 * (`solidBodies`). A fixed worst case is fine here — it must exceed the
 * largest possible contact reach (two spider masterminds, at 128 units of
 * radius each) with room to spare for a frame's movement, and it's paid once
 * per frame for one body. `blockersFor` deliberately does **not** use it: run
 * per monster per frame, a fixed box that assumes the largest monster in the
 * game is exactly the waste that made monster AI the frame's bottleneck.
 */
const BLOCKER_SEARCH_RADIUS = 320;

/**
 * Cell size of the monster lookup grid (`blockerGrid`). Deliberately much
 * smaller than the worst-case search box: the box is sized *per monster* from
 * its own radius (see `blockersFor`), so small cells are what let an ordinary
 * 20-unit-radius monster scan a handful of candidates instead of everything
 * within the largest radius any monster in the game could need.
 */
const BLOCKER_GRID_CELL = 128;

/** `game.ts`'s own per-frame `dt` clamp; the most simulated time one frame can ever represent. */
const MAX_FRAME_DT = 0.05;

/**
 * Slack added to every blocker search, so that tightening the search to the
 * bodies that can actually touch (see `blockersFor`) can't miss one. Two
 * independent sources of position uncertainty, both derived from the stats
 * table rather than hardcoded so they can't drift out of sync with it:
 *
 * - **The probe reaches past the body.** `monsters.ts: tryWalk` tests a
 *   position a full vanilla `P_Move` step away (`speed × chaseInterval`), so a
 *   blocker just outside the body's own radius can still be the thing that
 *   refuses the move.
 * - **The grid is up to a frame stale.** `blockerGrid` buckets each monster by
 *   where it was at `rebuildBlockerGrid` time, but monsters later in the same
 *   update loop have since moved — by at most `speed × MAX_FRAME_DT`.
 *
 * The two maxima are taken **independently and then added**, not maximised as
 * a per-type sum: the monster doing the probing and the monster that drifted
 * are different monsters, so the worst case pairs the game's longest probe
 * step with the fastest *other* monster's drift, and nothing requires those to
 * be the same type.
 */
const BLOCKER_MARGIN =
  Object.values(MONSTER_STATS).reduce((max, s) => Math.max(max, s.speed * s.chaseInterval), 0) +
  Object.values(MONSTER_STATS).reduce((max, s) => Math.max(max, s.speed), 0) * MAX_FRAME_DT;

/** 
 * How often an unalerted monster re-checks line of sight to the player — 
 * vanilla's own idle `A_Look` calls run every 10 tics (~0.29s), not every tic. 
 */
const LOOK_INTERVAL = 0.3;

/**
 * DOOM's own walk-cycle convention: every monster's RUN states step through 4
 * frames (A-D), the same convention `PLAY`'s own walk cycle already uses for
 * the player actor. Unlike the death frames (`MONSTER_DEATH_FRAMES`), this
 * isn't rederived from the WAD itself — vanilla's info.c layout puts the
 * walk cycle first for every monster type, uniformly, so there's no
 * per-type structural signal to check it against the way the rotation-0-only
 * death tail gives death frames. A handful of real monsters deviate from
 * this in vanilla (the lost soul only cycles A-B, the spider mastermind and
 * arachnotron cycle further before repeating), left as a known, accepted
 * gap — see `MONSTER_ATTACK_FRAMES`'s doc (`thingdefs.ts`) for how those
 * type-specific frame letters *are* derived and confirmed despite that
 * limitation.
 */
const MONSTER_WALK_FRAMES = ['A', 'B', 'C', 'D'];

/**
 * One monster as the rest of the engine sees it: the stable `id`
 * `ThingLayer.damage` takes, its live position, its doomednum (for the
 * species checks in `game.ts`), and its current facing — needed by
 * `game.ts`'s arch-vile flame tracking, which (like vanilla's own `A_Fire`)
 * keys off the *target's* facing, not just its position. Every lookup below
 * hands back this same shape rather than each spelling out
 * `{ id, x, y, z, type, angle }` of its own.
 */
export interface MonsterRef extends Pos3 {
  id: number;
  type: number;
  angle: number;
}

export interface ThingLayer {
  group: THREE.Group;
  count: number;
  /** Releases the instanced meshes/materials this layer owns; call when the map is unloaded. Shared geometry and textures belong to `SpriteMaterialCache`, which outlives a level. */
  dispose(): void;
  /**
   * Every living monster near (x, y), plus every still-standing barrel, as a
   * solid body the *player* has to walk around — vanilla's monsters and
   * `MT_BARREL` are both `MF_SOLID`, so either blocks a mover the same way a
   * wall does. Monsters get the equivalent list built for them internally
   * (`blockersFor`); this is the outward-facing half, for `game.ts` to hand
   * to `Player.update`.
   */
  solidBodies(pos: Pos2): ThingBlocker[];
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
   *
   * Also ticks every exploding barrel's own death clock (barrels aren't
   * `MONSTER_TYPES`, so none of the AI above applies to them — see
   * `BARREL_TYPE`'s doc) and reports any `A_Explode` that became due this
   * frame alongside the monster attacks, see `ThingUpdateResult`.
   */
  update(
    dt: number,
    viewerAngleDeg: number,
    player: Pos3 | null,
    fogAlphaOf?: (subsector: number) => number,
    crossLines?: (prev: Pos2, pos: Pos2) => Placement | null,
  ): ThingUpdateResult;
  /**
   * Consumes every not-yet-picked thing within `radius` of (x, y) *and*
   * within reach vertically of `z` whose type `consume` accepts (returning
   * true), hiding it permanently. `consume` is the inventory-side effect
   * (game/inventory.ts's applyPickup) — this layer only owns which world
   * instance disappears, not what picking one up means. `consume`'s second
   * argument is the instance's own `dropped` flag, so a monster's dropped
   * clip/weapon can grant half ammo the way vanilla's own dropped pickups do.
   */
  tryPickup(pos: Pos3, radius: number, consume: (type: number, dropped: boolean) => boolean): void;
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
   *
   * Also willing to lock onto a still-standing barrel — vanilla's own
   * `P_AimLineAttack` has no notion of "monster", only `MF_SHOOTABLE`, so a
   * barrel is exactly as auto-aimable as any monster in real DOOM too.
   */
  pickMonster(raycaster: THREE.Raycaster): MonsterRef | null;
  /**
   * Living monsters within `radius` (2D — matching vanilla's own radius-attack
   * distance test, which ignores height) of (x, y). Candidates for splash
   * damage (game.ts); the caller still has to check line-of-sight itself,
   * since that needs the `World` this layer doesn't otherwise touch.
   */
  monstersNear(pos: Pos2, radius: number): MonsterRef[];
  /** This exact monster's live position and type, or null if the id is stale or it has since died. Lets a shot fired at a monster keep tracking it across frames. */
  monsterById(id: number): MonsterRef | null;
  /** Count of living monsters currently alerted (chasing/attacking, or mid-reaction-delay) — for the debug HUD. */
  awakeMonsterCount(): number;
  /**
   * Positions of the alerted monsters `awakeMonsterCount` counts, narrowed to
   * those actually being *rendered* right now — occlusion fading (game.ts)
   * treats each as an extra sightline target alongside the player, so a
   * wall/floor hiding a chasing monster fades the same way one hiding the
   * player does. Two exclusions, both load-bearing: anything not yet alerted
   * (an unseen sleeping monster is supposed to stay hidden), and anything
   * fog of war is currently hiding (`PosedThing.visible`, set from
   * `fogAlphaOf` in `update` above) — a monster in a subsector the player has
   * never had sight of isn't drawn at all, so fading the wall in front of it
   * reveals an empty dark room and nothing else. Must be called after
   * `update` has run for the frame, so `visible` reflects this frame's fog.
   */
  awakeMonsters(): Pos3[];
  /**
   * Living monsters standing in exactly `sector` — a reference-equality check
   * against the same mutable `Sector` object `PosedThing.sector` was seeded
   * from (see that field's doc), not a sector-index lookup this layer has no
   * way to perform on its own. Backs crush damage (game.ts's `onCrush`
   * callback into `SpecialsController`) and the headroom-blocked check every
   * non-crushing mover uses to stop rather than clip through a monster
   * (`game.ts`'s `headroomBlocked`) — either way, a mover only knows which
   * sector it's squeezing, not who's standing in it.
   */
  monstersInSector(sector: Sector): MonsterRef[];
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
   *
   * `knockUpSpeed`, when given, nudges the victim airborne with that much
   * upward velocity — the arch-vile's real `A_VileAttack` launch
   * (`game.ts: resolveVileBlast`), applied here rather than left to the
   * caller since it's the same `PosedThing.z`/`velZ` fields `stepMonsterAI`'s
   * own gravity integration already owns.
   *
   * A barrel (`id` referring to a `BARREL_TYPE` instance, not a
   * `MONSTER_TYPES` one) takes this same call but follows none of the above:
   * no pain state (vanilla's `MT_BARREL` has no `painstate`/`painchance` at
   * all), no infighting retarget, and death switches its sprite to `BEXP`
   * (not its own idle `BAR1`) rather than picking from `MONSTER_DEATH_FRAMES`
   * — see `BARREL_TYPE`'s doc.
   */
  damage(id: number, amount: number, source?: { id: number; type: number }, knockUpSpeed?: number): void;
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
    origin: Pos3,
    angleRad: number,
    maxDist: number,
    opts?: { ignoreId?: number; includeHidden?: boolean },
  ): (MonsterRef & { dist: number }) | null;
}

/**
 * Single approximate hitbox `ThingLayer.raycastMonster` tests a free shot's
 * ray against — see that method's doc for why this isn't per-species.
 */
const MONSTER_HIT_RADIUS = 24;
export const MONSTER_HIT_HEIGHT = 64;

/** The lost soul's doomednum — what the pain elemental's `A_PainShootSkull` spawns (see `spawnLostSoul`). */
const LOST_SOUL_TYPE = 3006;
/** The pain elemental's own doomednum — `damage()`'s death branch checks this for its `A_PainDie` triple-spawn. */
const PAIN_ELEMENTAL_TYPE = 71;
/** Vanilla's own hard cap on how many lost souls can exist on a level at once — `A_PainShootSkull`'s "count > 20" guard. */
const MAX_SKULLS_ON_LEVEL = 20;

/**
 * The exploding barrel's own doomednum (`THING_SPRITES`'s `BAR1` entry) —
 * vanilla `MT_BARREL`. Unlike every monster, a barrel has no AI at all
 * (`MONSTER_STATS` has no entry for it, so it never enters the
 * `if (stats && player)` branch in `update()` below) — it's just a plain
 * `MF_SOLID|MF_SHOOTABLE` prop that happens to deal splash damage on death.
 */
const BARREL_TYPE = 2035;
/** Vanilla `mobjinfo` spawnhealth for `MT_BARREL`. */
const BARREL_HEALTH = 20;
/**
 * Vanilla `MT_BARREL`'s own `radius` (10 map units) — real and much smaller
 * than `MONSTER_HIT_RADIUS`, the approximate fallback used for a type with no
 * `MONSTER_STATS` entry, which a barrel otherwise is.
 */
const BARREL_RADIUS = 10;
/** `S_BAR1`/`S_BAR2` — a two-frame idle sway, each vanilla frame held 6 tics. */
const BARREL_IDLE_FRAMES = ['A', 'B'];
const BARREL_IDLE_FRAME_SECONDS = 6 / 35;
/**
 * A barrel's death art is a genuinely different sprite lump from its own idle
 * art (`BEXP`, not `BAR1`) — unlike every monster, whose death states reuse
 * the same sprite name as their walk/attack states. `SpriteAnimator.die`'s
 * optional third argument exists specifically for this.
 */
const BARREL_DEATH_SPRITE = 'BEXP';
/** `S_BEXP1`-`S_BEXP5` frame letters. */
const BARREL_DEATH_FRAMES = ['A', 'B', 'C', 'D', 'E'];
/**
 * A flat per-frame rate standing in for vanilla's own uneven per-state tic
 * counts (5, 5, 5, 10, 10) — the same "one uniform rate" simplification
 * `MONSTER_DEATH_FRAME_SECONDS` already makes elsewhere. Matches the real
 * rate of the first three frames, which is the one that actually matters:
 * `BARREL_EXPLODE_DELAY_SECONDS` below is timed off it.
 */
const BARREL_DEATH_FRAME_SECONDS = 5 / 35;
/**
 * Vanilla's own `A_Explode` fires on entering `S_BEXP3` — the death
 * animation's third frame, i.e. two frames after the barrel actually died,
 * not instantly on death. Confirmed against `linuxdoom-1.10/info.c`'s
 * `S_BEXP1`/`S_BEXP2` durations (5 tics each) rather than assumed.
 */
const BARREL_EXPLODE_DELAY_SECONDS = 2 * BARREL_DEATH_FRAME_SECONDS;
/**
 * Vanilla's own literal `A_Explode` call — `P_RadiusAttack(thingy,
 * thingy->target, 128)` — identical radius and damage to the rocket
 * launcher's own splash (`weapons.ts`'s `rocketLauncher.splash`).
 */
export const BARREL_SPLASH_RADIUS = 128;
export const BARREL_SPLASH_DAMAGE = 128;

/**
 * A barrel's `A_Explode` becoming due (`BARREL_EXPLODE_DELAY_SECONDS` after
 * it died, not on death itself), for `game.ts` to turn into
 * `applyRadiusDamage`. `source`, when set, is who dealt the killing blow —
 * see `PosedThing.explodeSource`'s doc for why this is what makes a chain of
 * barrels attribute correctly all the way back to whoever set the first one
 * off.
 */
export interface BarrelExplosion extends Pos3 {
  source?: { id: number; type: number };
}

/** `ThingLayer.update`'s return value — see that method's doc. */
export interface ThingUpdateResult {
  attacks: MonsterAttackEvent[];
  barrelExplosions: BarrelExplosion[];
}

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
  const batch = new SpriteBatch();
  const group = batch.group;
  group.name = 'things';
  const posed: PosedThing[] = [];
  /** Scratch for `doomToWorld`, reused across every sprite — this runs per thing per frame. */
  const worldPos = new THREE.Vector3();

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
    const isBarrel = t.type === BARREL_TYPE;

    const animFrames = isMonster ? MONSTER_WALK_FRAMES : isBarrel ? BARREL_IDLE_FRAMES : ['A'];
    const anim = new SpriteAnimator(bank, materials, spriteName, animFrames, isBarrel ? BARREL_IDLE_FRAME_SECONDS : undefined);
    // Skips a thing whose art the WAD doesn't actually carry, same as before —
    // resolving once here is what the old build-time `setPose` call was for.
    if (!anim.resolve(facingDeg, VIEWER_ANGLE_DEG)) continue;
    posed.push({
      id: posed.length,
      anim,
      scale: pickupScaleFor(t.type),
      blockRadius: isBarrel ? BARREL_RADIUS : MONSTER_STATS[t.type]?.radius ?? MONSTER_HIT_RADIUS,
      attackFrames: MONSTER_ATTACK_FRAMES[t.type],
      painFrames: MONSTER_PAIN_FRAMES[t.type],
      raiseFrames: MONSTER_RAISE_FRAMES[t.type],
      deadTime: 0,
      deathFrameCount: 0,
      barrelExploded: false,
      explodeSource: null,
      visible: true,
      hidden: false,
      queryStamp: 0,
      x,
      y,
      z,
      sector,
      facingDeg,
      light,
      subsector,
      type: t.type,
      picked: false,
      health: isBarrel ? BARREL_HEALTH : MONSTER_HEALTH[t.type] ?? Infinity,
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
      homingBias: Math.random() < 0.5,
      lookTimer: 0,
      prev: { x, y },
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
    const anim = new SpriteAnimator(bank, materials, spriteName);
    if (!anim.resolve(facingDeg, VIEWER_ANGLE_DEG)) return;
    posed.push({
      id: posed.length,
      anim,
      scale: pickupScaleFor(type),
      blockRadius: MONSTER_STATS[type]?.radius ?? MONSTER_HIT_RADIUS,
      attackFrames: MONSTER_ATTACK_FRAMES[type],
      painFrames: MONSTER_PAIN_FRAMES[type],
      raiseFrames: MONSTER_RAISE_FRAMES[type],
      deadTime: 0,
      deathFrameCount: 0,
      barrelExploded: false,
      explodeSource: null,
      visible: true,
      hidden: false,
      queryStamp: 0,
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
      homingBias: Math.random() < 0.5,
      lookTimer: 0,
      prev: { x, y },
      targetId: null,
    });
  }

  /**
   * The pain elemental's `A_PainShootSkull`: spawns a lost soul just in front
   * of `origin` along `angleRad` and immediately launches it at whatever
   * `origin` itself is currently targeting — vanilla's own
   * `newmobj->target = actor->target` followed by `A_SkullAttack(newmobj)`.
   * Called both from `update()`'s live `A_PainAttack` (`AttackStats.spawn`,
   * once per attack) and from `damage()`'s death branch (`A_PainDie`, three
   * of these at once, fanned around the elemental's own facing) — see both
   * call sites for why neither needs the *player's* position on hand: the
   * new skull is simply spawned already alerted and already past its
   * reaction delay, so it makes its own first missile-range roll (and so its
   * own charge decision) on its very next ordinary chase call, the same path
   * every other monster's attack already goes through.
   *
   * Vanilla's own cap ("if there are already 20 skulls on the level, don't
   * spit another one") is a *level-wide* count of `MT_SKULL`, not a
   * per-elemental one, so a room full of pain elementals throttles itself
   * once the level's total skull population fills up rather than each
   * elemental keeping its own tally.
   *
   * If the spawn point has no room, this simply does nothing — vanilla
   * actually spawns the mobj and then kills it outright with 10000 damage
   * when `P_TryMove` refuses it, which looks identical to never having
   * spawned it at all, so skipping the pointless detour through a
   * dead instance changes nothing observable.
   */
  function spawnLostSoul(origin: PosedThing, angleRad: number): void {
    let skullCount = 0;
    for (const p of posed) if (p.type === LOST_SOUL_TYPE && !p.dead) skullCount++;
    if (skullCount > MAX_SKULLS_ON_LEVEL) return;

    const skullRadius = MONSTER_STATS[LOST_SOUL_TYPE].radius;
    const originRadius = MONSTER_STATS[origin.type]?.radius ?? skullRadius;
    // Vanilla's `4*FRACUNIT + 3*(actor->info->radius + skullRadius)/2` — both
    // radii are already plain map units here (not FRACUNIT-scaled), so the
    // shared scaling factor just divides back out.
    const prestep = 4 + 1.5 * (originRadius + skullRadius);
    const x = origin.x + Math.cos(angleRad) * prestep;
    const y = origin.y + Math.sin(angleRad) * prestep;
    const z = origin.z + 8;
    if (circleBlocked(world, x, y, skullRadius, z, true)) return;

    const spriteName = THING_SPRITES[LOST_SOUL_TYPE];
    if (!spriteName) return;
    const sector = world.sectorAt(x, y);
    const subsector = world.subsectorAt(x, y);
    const facingDeg = (angleRad * 180) / Math.PI;
    const anim = new SpriteAnimator(bank, materials, spriteName, MONSTER_WALK_FRAMES);
    if (!anim.resolve(facingDeg, VIEWER_ANGLE_DEG)) return;
    posed.push({
      id: posed.length,
      anim,
      scale: pickupScaleFor(LOST_SOUL_TYPE),
      blockRadius: skullRadius,
      attackFrames: MONSTER_ATTACK_FRAMES[LOST_SOUL_TYPE],
      painFrames: MONSTER_PAIN_FRAMES[LOST_SOUL_TYPE],
      raiseFrames: MONSTER_RAISE_FRAMES[LOST_SOUL_TYPE],
      deadTime: 0,
      deathFrameCount: 0,
      barrelExploded: false,
      explodeSource: null,
      visible: true,
      hidden: false,
      queryStamp: 0,
      x,
      y,
      z,
      sector,
      facingDeg,
      light: sector?.light ?? 128,
      subsector,
      type: LOST_SOUL_TYPE,
      picked: false,
      health: MONSTER_HEALTH[LOST_SOUL_TYPE] ?? Infinity,
      dead: false,
      dropped: false,
      // Already alerted, with reactionTicks/movecount pre-zeroed so its very
      // first chase call is free to roll straight into checkMissileRange
      // (and so straight into its own charge) rather than first walking a
      // step and waiting out a reaction delay it never had in vanilla —
      // there `A_SkullAttack` fires synchronously in the same tic it spawns.
      alerted: true,
      ambush: false,
      velZ: 0,
      angle: angleRad,
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
      homingBias: Math.random() < 0.5,
      lookTimer: 0,
      prev: { x, y },
      targetId: origin.targetId,
    });
  }

  /**
   * Where a monster should currently be heading. `targetId` is non-null only
   * after something other than the player hurt it (`damage` → `shouldRetarget`),
   * and a target that dies hands attention straight back to the player —
   * vanilla's `A_Chase` does the same via `P_LookForPlayers` once
   * `target->health <= 0`, since there is nobody else for a monster to want.
   */
  function resolveTarget(p: PosedThing, player: Pos3): Pos3 {
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
   * Living monsters bucketed by `BLOCKER_GRID_CELL`, rebuilt once per
   * `update()` and read by `blockersFor` below. Vanilla has the same thing for
   * the same reason — its blockmap — and this exists because without it
   * monster-vs-monster collision is O(monsters²) per frame: every alerted
   * monster scanning every other thing on the map. That is fine at a stock
   * level's population and catastrophic beyond it (NUTS.WAD's 10,696 things
   * work out to ~114 million distance checks per frame the moment they all
   * wake up, which on its own is a multi-hundred-millisecond frame).
   *
   * Cells hold `PosedThing`s rather than ids so `blockersFor` needs no second
   * lookup, and their arrays are emptied and refilled rather than reallocated,
   * since this runs every frame.
   */
  const blockerCols = Math.max(1, Math.ceil((map.bounds.maxX - map.bounds.minX) / BLOCKER_GRID_CELL) + 1);
  const blockerRows = Math.max(1, Math.ceil((map.bounds.maxY - map.bounds.minY) / BLOCKER_GRID_CELL) + 1);
  const blockerGrid: PosedThing[][] = new Array(blockerCols * blockerRows);
  /** Indices of the cells that actually have anything in them, so a rebuild clears only those instead of walking the whole grid. */
  const blockerDirty: number[] = [];

  /**
   * Raisable corpses (`dead && raiseFrames`) bucketed the same way as
   * `blockerGrid`, sharing its cell grid — rebuilt in the same `posed` pass
   * as `blockerGrid` rather than a second one. Backs `findRaisableCorpse`,
   * originally a plain linear scan over every posed thing on the reasoning
   * that arch-viles are rare enough for it not to matter — an assumption
   * that was never actually checked against a real map. NUTS.WAD has 1,272
   * of them, and once its whole population is alerted (measured with a
   * synthetic all-monsters-awake pass over real NUTS.WAD data, `ThingLayer`
   * only, no rendering) the linear scan cost **17.5ms/frame avg** just for
   * `things.update()`, dropping to **10.7ms/frame** with this grid — the
   * concrete slowdown reported when waking the vile group in the map's
   * north area. Unlike `blockersFor`, whose O(monsters²) cost was measured
   * and indexed from the start, this one shipped on an unverified assumption.
   */
  const corpseGrid: PosedThing[][] = new Array(blockerCols * blockerRows);
  /** Indices of the cells that actually have anything in them, so a rebuild clears only those instead of walking the whole grid. */
  const corpseDirty: number[] = [];
  /** Largest collision radius among corpses currently in `corpseGrid`, sizing `findRaisableCorpse`'s search box the same way `maxBlockerRadius` sizes `blockersFor`'s. */
  let maxCorpseRadius = 0;
  /** Bumped per `forEachMonsterAlongRay` call; see `PosedThing.queryStamp`. */
  let monsterQueryStamp = 0;
  /**
   * Largest collision radius among the monsters currently in the grid, so
   * `blockersFor` can size its search box to what this map actually contains
   * instead of to the biggest monster in the game. On a map of ordinary
   * 20-unit-radius grunts that is the difference between a box a couple of
   * cells across and one nine cells across.
   */
  let maxBlockerRadius = PLAYER_RADIUS;

  /**
   * Grid key for a map position. DOOM map coordinates are 16-bit signed, so
   * the biased cell indices comfortably fit the 16 bits each this packs them
   * into — one number key rather than a string, which matters at this call rate.
   */
  /**
   * Every living monster in the grid cells covering `radius` around (x, y).
   * The caller still has to apply its own exact distance test — this only
   * narrows the candidates from "every thing on the map" to "the ones nearby".
   *
   * The cell range is padded by `BLOCKER_MARGIN` because the grid buckets each
   * monster by where it stood at `rebuildBlockerGrid` time, and one may have
   * moved since; positions read off the things themselves are always live.
   */
  function forEachMonsterNear(x: number, y: number, radius: number, visit: (p: PosedThing) => void): void {
    const reach = radius + BLOCKER_MARGIN;
    const c0 = blockerCol(x - reach);
    const c1 = blockerCol(x + reach);
    const r0 = blockerRow(y - reach);
    const r1 = blockerRow(y + reach);
    for (let gy = r0; gy <= r1; gy++) {
      const rowBase = gy * blockerCols;
      for (let gx = c0; gx <= c1; gx++) {
        const cell = blockerGrid[rowBase + gx];
        if (cell === undefined) continue;
        for (const p of cell) visit(p);
      }
    }
  }

  /**
   * Every living monster in or beside the grid cells a ray passes through,
   * each visited at most once. Backs `raycastMonster`, which a crowded map
   * calls once per monster hitscan — dozens of times a frame — and which as a
   * scan of every thing measured ~4 ms/frame on NUTS.WAD.
   *
   * Deliberately simpler than `World.forEachLineAlongSegment`'s exact DDA: it
   * steps along the ray by half a cell and sweeps each step's 3×3 cell
   * neighbourhood. Stepping by half a cell means no cell on the path can be
   * skipped, and the 3×3 sweep gives a full cell (128 units) of clearance on
   * either side — far more than the ~24-unit hit radius the caller tests
   * against — so it cannot miss a monster the exact ray would hit. Monsters
   * are stamped rather than deduped through a `Set`, since consecutive steps'
   * neighbourhoods overlap heavily.
   */
  function forEachMonsterAlongRay(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    maxDist: number,
    visit: (p: PosedThing) => void,
  ): void {
    const stamp = ++monsterQueryStamp;
    const stride = BLOCKER_GRID_CELL / 2;
    const steps = Math.ceil(maxDist / stride);
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(s * stride, maxDist);
      const cx = blockerCol(x + dirX * t);
      const cy = blockerRow(y + dirY * t);
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        if (gy < 0 || gy >= blockerRows) continue;
        const rowBase = gy * blockerCols;
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          if (gx < 0 || gx >= blockerCols) continue;
          const cell = blockerGrid[rowBase + gx];
          if (cell === undefined) continue;
          for (const p of cell) {
            if (p.queryStamp === stamp) continue;
            p.queryStamp = stamp;
            visit(p);
          }
        }
      }
    }
  }

  /** Grid column/row for a map coordinate, clamped so a thing outside the map's own bounds still lands in a real cell. */
  function blockerCol(x: number): number {
    const c = Math.floor((x - map.bounds.minX) / BLOCKER_GRID_CELL);
    return c < 0 ? 0 : c >= blockerCols ? blockerCols - 1 : c;
  }

  function blockerRow(y: number): number {
    const r = Math.floor((y - map.bounds.minY) / BLOCKER_GRID_CELL);
    return r < 0 ? 0 : r >= blockerRows ? blockerRows - 1 : r;
  }

  function rebuildBlockerGrid(): void {
    for (const i of blockerDirty) blockerGrid[i].length = 0;
    blockerDirty.length = 0;
    maxBlockerRadius = PLAYER_RADIUS;
    for (const i of corpseDirty) corpseGrid[i].length = 0;
    corpseDirty.length = 0;
    maxCorpseRadius = 0;
    for (const p of posed) {
      if (p.dead) {
        // A hidden corpse (MONSTER_CORPSE_VANISHES — see that doc) no longer
        // exists as far as an arch-vile is concerned, matching vanilla's own
        // P_RemoveMobj: it's simply not there to raise.
        if (!p.raiseFrames || p.hidden) continue;
        if (p.blockRadius > maxCorpseRadius) maxCorpseRadius = p.blockRadius;
        const i = blockerRow(p.y) * blockerCols + blockerCol(p.x);
        let cell = corpseGrid[i];
        if (!cell) corpseGrid[i] = cell = [];
        if (cell.length === 0) corpseDirty.push(i);
        cell.push(p);
        continue;
      }
      // A living barrel is exactly as solid as a monster — vanilla's own
      // MF_SOLID — so it joins the same grid: it blocks the player
      // (`solidBodies`), blocks a monster's own movement (`blockersFor`), and
      // is found by `raycastMonster`/`monstersNear`, all for free through the
      // machinery already built for monsters.
      if (!MONSTER_TYPES.has(p.type) && p.type !== BARREL_TYPE) continue;
      if (p.blockRadius > maxBlockerRadius) maxBlockerRadius = p.blockRadius;
      const i = blockerRow(p.y) * blockerCols + blockerCol(p.x);
      let cell = blockerGrid[i];
      if (!cell) blockerGrid[i] = cell = [];
      if (cell.length === 0) blockerDirty.push(i);
      cell.push(p);
    }
  }

  /**
   * Reused storage for `blockersFor`'s result. `blockerPool` owns the blocker
   * objects and only ever grows; `blockerScratch` is emptied and refilled with
   * references to them on every call, so a steady-state frame allocates
   * nothing here at all.
   *
   * This matters more than it looks: a freshly-built list per call meant
   * roughly half a million short-lived objects per frame on a crowded map
   * (every alerted monster × its ~65 real neighbours), which profiled as **60%
   * of all monster-AI time** — far more than the neighbour search it was
   * feeding. The tradeoff is that `blockersFor`'s return value is only valid
   * until the next call, which is why it's typed `readonly` and why the one
   * caller (`stepMonsterAI`, via `circleBlocked`/`blockedByThings`) consumes it
   * synchronously and never stores it. `solidBodies` below deliberately does
   * *not* share this: it's called once per frame for the player, where a plain
   * allocation costs nothing and an aliased buffer would be a trap.
   */
  const blockerPool: ThingBlocker[] = [];
  const blockerScratch: ThingBlocker[] = [];

  function pushBlocker(x: number, y: number, radius: number): void {
    const i = blockerScratch.length;
    let b = blockerPool[i];
    if (!b) blockerPool[i] = b = { x: 0, y: 0, radius: 0 };
    b.x = x;
    b.y = y;
    b.radius = radius;
    blockerScratch.push(b);
  }

  /**
   * The solid bodies near `p` that it can physically bump into — every other
   * living monster plus the player, matching vanilla, where every monster is
   * `MF_SOLID` and `PIT_CheckThing` stops a mover against it. `p` itself is
   * excluded, since a body always overlaps where it already is.
   *
   * **The returned array is reused** — see `blockerScratch`. Valid only until
   * the next call.
   *
   * The search box is sized from the radii actually involved rather than from
   * a fixed worst case, and only the grid cells it covers are scanned. Both
   * halves matter: `blockedByThings` can never report an overlap outside
   * `r1 + r2`, so anything beyond that (plus `BLOCKER_MARGIN`, which covers
   * the probe reach and the grid's frame of staleness) is guaranteed waste.
   * This is the single hottest thing in monster AI — see `blockerGrid`.
   */
  function blockersFor(p: PosedThing, player: Pos3): readonly ThingBlocker[] {
    blockerScratch.length = 0;
    const ownRadius = p.blockRadius;
    // `blockedByThings` only ever reports an overlap inside `r1 + r2`, so
    // nothing further than the widest possible summed radii (plus the margin)
    // can matter — searching further is pure waste, and it was: a fixed
    // 320-unit box collected ~145 candidates per monster on a map of 20-unit
    // grunts, which profiled as half of all monster-AI time.
    const reach = ownRadius + maxBlockerRadius + BLOCKER_MARGIN;
    const playerReach = ownRadius + PLAYER_RADIUS + BLOCKER_MARGIN;
    if (Math.abs(player.x - p.x) <= playerReach && Math.abs(player.y - p.y) <= playerReach) {
      pushBlocker(player.x, player.y, PLAYER_RADIUS);
    }
    const c0 = blockerCol(p.x - reach);
    const c1 = blockerCol(p.x + reach);
    const r0 = blockerRow(p.y - reach);
    const r1 = blockerRow(p.y + reach);
    for (let gy = r0; gy <= r1; gy++) {
      const rowBase = gy * blockerCols;
      for (let gx = c0; gx <= c1; gx++) {
        const cell = blockerGrid[rowBase + gx];
        if (cell === undefined || cell.length === 0) continue;
        for (const other of cell) {
          // `dead` is re-checked because a monster can be killed (infighting,
          // splash) after the grid was built for this frame.
          if (other === p || other.dead) continue;
          // Tighter than `reach`, which has to assume the map's largest
          // monster: this pair's own summed radii is the real bound. That
          // matters on a map like NUTS.WAD, where 795 spider masterminds
          // (radius 128) would otherwise widen every 20-unit grunt's box too.
          const pairReach = ownRadius + other.blockRadius + BLOCKER_MARGIN;
          if (Math.abs(other.x - p.x) > pairReach || Math.abs(other.y - p.y) > pairReach) continue;
          pushBlocker(other.x, other.y, other.blockRadius);
        }
      }
    }
    return blockerScratch;
  }

  /**
   * Vanilla's `PIT_VileCheck`, called from `monsters.ts`'s `runChaseCall` as
   * the `resurrect` callback: the first corpse near `(x, y)` the arch-vile
   * calling this could raise, or null. Grid-accelerated via `corpseGrid`
   * rather than a linear scan over every posed thing — this runs once per
   * arch-vile per chase call (`chaseInterval`, ~0.057s), and a linear version
   * measured at 17.5ms/frame on NUTS.WAD once its 1,272 arch-viles wake (see
   * `corpseGrid`'s own doc for the full measurement), the concrete slowdown
   * this fixes. Same shape as `blockersFor`: box the
   * search to `vileRadius + maxCorpseRadius + BLOCKER_MARGIN`, only walk the
   * grid cells that box covers, then apply the exact per-pair distance test.
   * Which corpse comes back first when several qualify depends on grid-cell
   * iteration order rather than spawn order — as arbitrary as vanilla's own
   * blockmap order, same acceptable-approximation shape as `donut`'s
   * neighbor search elsewhere in this file.
   *
   * Skips the box-check-only-fit-against-walls half of vanilla's own
   * `P_CheckPosition` re-test against *other* nearby things (vanilla's own
   * corpse height-quadrupling trick) — corpses raise rarely enough, and
   * monsters overlapping a corpse-sized footprint tightly enough for that to
   * matter is rare enough, that reusing `blockersFor`'s own per-point,
   * per-caller machinery here wasn't worth the coupling.
   */
  function findRaisableCorpse(x: number, y: number, vileRadius: number): RaiseCandidate | null {
    const reach = vileRadius + maxCorpseRadius + BLOCKER_MARGIN;
    const c0 = blockerCol(x - reach);
    const c1 = blockerCol(x + reach);
    const r0 = blockerRow(y - reach);
    const r1 = blockerRow(y + reach);
    for (let gy = r0; gy <= r1; gy++) {
      const rowBase = gy * blockerCols;
      for (let gx = c0; gx <= c1; gx++) {
        const cell = corpseGrid[rowBase + gx];
        if (cell === undefined || cell.length === 0) continue;
        for (const c of cell) {
          // A corpse this same frame's earlier vile already resurrected —
          // grid buckets are up to a frame stale, `dead` is read live.
          if (!c.dead) continue;
          // "Not lying still yet" — vanilla's own `thing->tics != -1` gate.
          if (c.deadTime < c.deathFrameCount * MONSTER_DEATH_FRAME_SECONDS) continue;
          const pairReach = c.blockRadius + vileRadius;
          if (Math.abs(c.x - x) > pairReach || Math.abs(c.y - y) > pairReach) continue;
          if (circleBlocked(world, c.x, c.y, c.blockRadius, c.z, true)) continue; // no room to stand back up
          return { id: c.id, x: c.x, y: c.y };
        }
      }
    }
    return null;
  }

  /**
   * Vanilla's `A_VileChase` resurrection branch: restores a corpse to full
   * health and rejoins combat immediately, matching `P_SetMobjState`'s
   * synchronous flag/health reset — there's no separate "coming back to
   * life" delay the way the vile's own `S_VILE_HEAL` hold is. `attackPause`
   * is set to the raise animation's own length (`revive`'s `playOnce` below)
   * so `stepMonsterAI`'s existing "don't walk/attack while attackPause > 0"
   * gate holds it still until the animation actually finishes, the same way
   * it already holds an attacking monster still for its swing.
   */
  function reviveCorpse(p: PosedThing): void {
    p.dead = false;
    p.health = MONSTER_HEALTH[p.type] ?? p.health;
    p.hidden = false;
    p.velZ = 0; // clears any stale knockback velocity from however it died — dead things never integrate it, so it could otherwise sit unused for the rest of the level and then jump on revival
    p.alerted = true; // vanilla's raisestate falls straight through to RUN1 — already chasing, not dormant again
    p.targetId = null; // vanilla's corpsehit->target = NULL; resolveTarget falls back to the player
    p.movedir = DI_NODIR;
    p.movecount = 0;
    p.chaseTimer = 0;
    p.moveBlocked = false;
    p.threshold = 0;
    p.justHit = false;
    p.justAttacked = false;
    p.reactionTicks = 0;
    p.refiring = false;
    p.burstLeft = 0;
    p.burstTimer = 0;
    p.chargeTimer = 0;
    p.painTimer = 0;
    p.attackPause = (p.raiseFrames?.length ?? 0) * MONSTER_DEATH_FRAME_SECONDS;
    p.anim.revive();
    if (p.raiseFrames) p.anim.playOnce(p.raiseFrames, MONSTER_DEATH_FRAME_SECONDS);
  }

  // Seeded once here so a lookup that lands before the first `update` (a
  // splash on the opening frame, say) still finds the monsters that exist.
  rebuildBlockerGrid();

  return {
    group,
    count: posed.length,
    solidBodies(pos: Pos2): ThingBlocker[] {
      const out: ThingBlocker[] = [];
      for (const p of posed) {
        if (p.dead || (!MONSTER_TYPES.has(p.type) && p.type !== BARREL_TYPE)) continue;
        if (Math.abs(p.x - pos.x) > BLOCKER_SEARCH_RADIUS || Math.abs(p.y - pos.y) > BLOCKER_SEARCH_RADIUS) continue;
        out.push({ x: p.x, y: p.y, radius: p.blockRadius });
      }
      return out;
    },
    update(
      dt: number,
      viewerAngleDeg: number,
      player: Pos3 | null,
      fogAlphaOf?: (subsector: number) => number,
      crossLines?: (prev: Pos2, pos: Pos2) => Placement | null,
    ): ThingUpdateResult {
      const attacks: MonsterAttackEvent[] = [];
      const barrelExplosions: BarrelExplosion[] = [];
      // Once per frame, ahead of any blockersFor call below — see its doc for
      // why a frame-granular grid is accurate enough for contact.
      rebuildBlockerGrid();
      batch.begin(viewerAngleDeg);
      for (const p of posed) {
        if (p.hidden) {
          p.visible = false;
          continue;
        }
        if (p.dead) {
          p.deadTime += dt;
          if (p.type === BARREL_TYPE) {
            // Vanilla's own A_Explode, firing partway through the death
            // animation rather than instantly on death — see
            // BARREL_EXPLODE_DELAY_SECONDS's doc.
            if (!p.barrelExploded && p.deadTime >= BARREL_EXPLODE_DELAY_SECONDS) {
              p.barrelExploded = true;
              barrelExplosions.push({ x: p.x, y: p.y, z: p.z, source: p.explodeSource ?? undefined });
            }
            // Vanilla's S_BEXP5 falls through to S_NULL — the debris is
            // removed outright once its explosion animation finishes,
            // matching MONSTER_CORPSE_VANISHES's own reasoning for the lost
            // soul/pain elemental below (a barrel just isn't a MONSTER_TYPES
            // member, so it can't share that table).
            if (p.deadTime >= p.deathFrameCount * BARREL_DEATH_FRAME_SECONDS) {
              p.hidden = true;
              p.visible = false;
              continue;
            }
          } else if (
            // Vanilla removes the mobj outright once these two types' death
            // animation ends (see MONSTER_CORPSE_VANISHES's doc) rather than
            // leaving a permanent corpse the way every other monster's death
            // sequence does — without this, SpriteAnimator.die's ordinary
            // hold-last-frame behavior leaves a lost soul or pain elemental's
            // last death frame floating on screen forever.
            MONSTER_CORPSE_VANISHES.has(p.type) &&
            p.deadTime >= p.deathFrameCount * MONSTER_DEATH_FRAME_SECONDS
          ) {
            p.hidden = true;
            p.visible = false;
            continue;
          }
        }

        let animating = p.type === BARREL_TYPE;
        const stats = !p.dead ? MONSTER_STATS[p.type] : undefined;
        if (stats && player) {
          if (!p.alerted) {
            // Throttled the same way vanilla's own idle A_Look is — see LOOK_INTERVAL.
            // The actual wake decision (FOV/sight/sound/ambush rules) lives in
            // game/monsters.ts's tryWake; this loop only owns the throttle.
            p.lookTimer += dt;
            if (p.lookTimer >= LOOK_INTERVAL) {
              p.lookTimer = 0;
              // Waking is one of the two events that can reshuffle a
              // revenant's guided/unguided personality — see
              // MonsterBody.homingBias's doc. A no-op for every other type.
              if (tryWake(p, world, p.sector, player)) p.homingBias = Math.random() < 0.5;
            }
          }
          if (p.alerted) {
            const beforeX = p.x;
            const beforeY = p.y;
            const target = resolveTarget(p, player);
            const result = stepMonsterAI(p, stats, dt, world, target, blockersFor(p, player), findRaisableCorpse);
            // Walk triggers this monster crossed on the way (teleports,
            // and the handful of doors/lifts vanilla lets a monster open).
            const dest = crossLines?.(p.prev, p);
            if (dest) {
              p.x = dest.x;
              p.y = dest.y;
              p.angle = dest.angle;
              p.velZ = 0;
              // Re-route from scratch: the heading it had is meaningless on
              // the far side of the map.
              p.movedir = DI_NODIR;
              p.movecount = 0;
            }
            p.prev.x = p.x;
            p.prev.y = p.y;
            p.sector = world.sectorAt(p.x, p.y);
            p.subsector = world.subsectorAt(p.x, p.y);
            if (p.sector) p.light = p.sector.light;
            p.facingDeg = (p.angle * 180) / Math.PI;
            animating = p.x !== beforeX || p.y !== beforeY;
            if (result?.kind === 'resurrect') {
              // Applied directly here rather than reported through `attacks`
              // — a resurrection isn't damage for `game.ts` to realize, it's
              // pure AI-state that only `ThingLayer` (which owns the corpse's
              // `PosedThing`) can actually carry out. No attack pose either:
              // the vile has no distinct WAD art for this (see
              // `MONSTER_RAISE_FRAMES`'s doc on vanilla's own S_VILE_HEAL
              // quirk) — its ordinary held idle frame during `attackPause`
              // is the stand-in.
              const corpse = result.resurrectId !== undefined ? posed[result.resurrectId] : undefined;
              if (corpse?.dead) reviveCorpse(corpse);
            } else if (result?.kind === 'spawn') {
              // Same reasoning as 'resurrect' above: spawning a monster is
              // pure AI-state only ThingLayer's own `posed` array can carry
              // out, not damage for `game.ts` to realize, so this never goes
              // through `attacks`. The elemental's own attack pose still
              // plays, unlike 'resurrect' — A_PainAttack has real dedicated
              // art (MONSTER_ATTACK_FRAMES[71]), unlike the vile's raise.
              spawnLostSoul(p, result.angleRad);
              if (p.attackFrames) p.anim.playOnce(p.attackFrames, MONSTER_ACTION_FRAME_SECONDS);
            } else if (result) {
              attacks.push({
                ...result,
                x: p.x,
                y: p.y,
                z: p.z + MONSTER_FIRE_HEIGHT,
                sourceId: p.id,
                sourceType: p.type,
                targetId: p.targetId,
              });
              // The arch-vile's own attack pose starts here, at the windup's
              // *beginning* ('vileWindup', vanilla's real cast timing —
              // MONSTER_ATTACK_FRAMES plays through the whole missilestate
              // chase, not just the instant the flame lands) rather than at
              // the blast actually landing (kind 'ranged' with .blast set) —
              // re-triggering playOnce there would snap the pose back to its
              // first frame right as the explosion hits, instead of letting
              // it finish naturally.
              const alreadyPosedAtWindup = result.kind === 'ranged' && result.blast;
              if (p.attackFrames && !alreadyPosedAtWindup) p.anim.playOnce(p.attackFrames, MONSTER_ACTION_FRAME_SECONDS);
            }
          } else {
            p.z = p.sector?.floorHeight ?? p.z;
          }
        } else {
          p.z = p.sector?.floorHeight ?? p.z;
        }

        p.visible = !fogAlphaOf || fogAlphaOf(p.subsector) > 0.5;
        p.anim.advance(dt, animating);
        // Resolving the lump is only worth doing for something actually being
        // drawn — for a map like NUTS.WAD this skips thousands of SpriteBank
        // lookups a frame while the player has only explored part of it.
        if (!p.visible) continue;
        const cached = p.anim.resolve(p.facingDeg, viewerAngleDeg);
        if (!cached) continue;
        doomToWorld(p.x, p.y, p.z, worldPos);
        batch.add(cached, worldPos.x, worldPos.y, worldPos.z, p.scale, litColor(p.light), p.id);
      }
      batch.end();
      return { attacks, barrelExplosions };
    },
    dispose(): void {
      batch.dispose();
    },
    tryPickup(pos: Pos3, radius: number, consume: (type: number, dropped: boolean) => boolean): void {
      const rSq = radius * radius;
      for (const p of posed) {
        if (p.picked) continue;
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        if (dx * dx + dy * dy > rSq) continue;
        // Matches vanilla's PIT_CheckThing overhead/underneath gate: a thing
        // sitting on a not-yet-lowered pillar is in 2D range but out of
        // physical reach, and must stay uncollected until the pillar drops
        // (e.g. DOOM2 MAP04's blue key). Read live off the sector rather than
        // a cached height for the same reason `update` does.
        if (Math.abs((p.sector?.floorHeight ?? 0) - pos.z) > PLAYER_HEIGHT) continue;
        if (consume(p.type, p.dropped)) {
          p.picked = true;
          p.hidden = true;
          p.visible = false;
        }
      }
    },
    pickMonster(raycaster: THREE.Raycaster): MonsterRef | null {
      // The batch hands back the id of the nearest instance this predicate
      // accepts, skipping (rather than being blocked by) everything else — so
      // a plain decoration standing in front of a monster or barrel still
      // doesn't make it untargetable, exactly as when only monster meshes
      // were raycast at all. Barrels are included alongside MONSTER_TYPES —
      // see pickMonster's own doc for why.
      const id = batch.raycast(raycaster, (owner) => {
        const p = posed[owner];
        return !!p && !p.picked && !p.dead && p.visible && (MONSTER_TYPES.has(p.type) || p.type === BARREL_TYPE);
      });
      if (id === null) return null;
      const p = posed[id];
      return { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle };
    },
    monstersNear(pos: Pos2, radius: number): MonsterRef[] {
      // Grid-backed, not a scan of every thing. This is called once per
      // in-flight projectile per frame (`game.ts`'s `monsterStruckBy`), and a
      // crowded map can have well over a thousand projectiles in the air at
      // once — as a linear scan that alone measured ~138 ms/frame on NUTS.WAD,
      // more than everything else in the frame put together.
      const out: MonsterRef[] = [];
      const rSq = radius * radius;
      forEachMonsterNear(pos.x, pos.y, radius, (p) => {
        if (p.dead) return;
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        if (dx * dx + dy * dy >= rSq) return;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle });
      });
      return out;
    },
    monsterById(id: number): MonsterRef | null {
      const p = posed[id];
      if (!p || p.dead || !MONSTER_TYPES.has(p.type)) return null;
      return { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle };
    },
    awakeMonsterCount(): number {
      let n = 0;
      for (const p of posed) {
        if (!p.dead && MONSTER_TYPES.has(p.type) && p.alerted) n++;
      }
      return n;
    },
    awakeMonsters(): Pos3[] {
      const out: Pos3[] = [];
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type) || !p.alerted || !p.visible) continue;
        out.push({ x: p.x, y: p.y, z: p.z });
      }
      return out;
    },
    monstersInSector(sector: Sector): MonsterRef[] {
      const out: MonsterRef[] = [];
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type) || p.sector !== sector) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle });
      }
      return out;
    },
    damage(id: number, amount: number, source?: { id: number; type: number }, knockUpSpeed?: number): void {
      const p = posed[id];
      const isBarrel = !!p && p.type === BARREL_TYPE;
      if (!p || p.dead || amount <= 0 || !(isBarrel || MONSTER_TYPES.has(p.type))) return;
      p.health -= amount;
      if (knockUpSpeed) {
        p.velZ = knockUpSpeed;
        // Nudges z off the floor so stepMonsterAI's own airborne check
        // (z > groundFloor) engages next frame instead of the ground-snap
        // branch zeroing velZ straight back out before it ever takes effect.
        p.z += 1;
      }
      if (p.health > 0) {
        // Vanilla's MT_BARREL has no painstate/painchance at all — a barrel
        // that survives a hit just sits there, no flinch, no wake, no
        // infighting (it has no AI to alert or retarget in the first place).
        if (isBarrel) return;
        const stats = MONSTER_STATS[p.type];
        if (stats) reactToDamage(p, stats);
        // reactToDamage only actually sets painTimer if the stagger roll
        // (stats.painChance) passed and the monster wasn't mid-charge — a
        // hit that fails the roll alerts/retargets the monster same as any
        // other, but shouldn't flinch it on screen.
        if (p.painFrames && p.painTimer > 0) p.anim.playOnce(p.painFrames, MONSTER_ACTION_FRAME_SECONDS);
        // The other event that can reshuffle a revenant's guided/unguided
        // personality (MonsterBody.homingBias's doc) — a real pain flinch,
        // same gate as the pose line just above. A no-op for every other
        // type, and a hit that failed the stagger roll doesn't reroll it
        // either, matching "if the damage causes a pain state".
        if (p.painTimer > 0) p.homingBias = Math.random() < 0.5;
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
      p.deadTime = 0;
      if (isBarrel) {
        // BEXP, not BAR1 — see BARREL_DEATH_SPRITE's doc. The splash itself
        // fires later, once BARREL_EXPLODE_DELAY_SECONDS elapses (see
        // update()) — `source` is captured now so it can still be attributed
        // correctly then, and propagated to any barrel that blast itself
        // kills (see PosedThing.explodeSource's doc).
        p.barrelExploded = false;
        p.explodeSource = source ?? null;
        p.deathFrameCount = BARREL_DEATH_FRAMES.length;
        p.anim.die(BARREL_DEATH_FRAMES, BARREL_DEATH_FRAME_SECONDS, BARREL_DEATH_SPRITE);
        return;
      }
      // Matches vanilla's P_KillMobj: gib only if this killing blow overkilled
      // by more than the monster's own max health, and only if it actually has
      // gib art (most don't — see MONSTER_XDEATH_FRAMES's doc).
      const maxHealth = MONSTER_HEALTH[p.type] ?? 0;
      const gibbed = p.health < -maxHealth && MONSTER_XDEATH_FRAMES[p.type];
      const frames = gibbed || MONSTER_DEATH_FRAMES[p.type];
      p.deathFrameCount = frames ? frames.length : 0;
      if (frames) p.anim.die(frames, MONSTER_DEATH_FRAME_SECONDS);
      else {
        p.hidden = true;
        p.visible = false;
      }

      const dropType = MONSTER_DROPS[p.type];
      if (dropType) spawnDrop(p.x, p.y, p.sector, p.facingDeg, dropType);

      // A_PainDie: three more lost souls, fanned 90/180/270 degrees around
      // the elemental's own last facing — vanilla's own
      // `A_PainShootSkull(actor, actor->angle+ANG90/180/270)`, fired
      // unconditionally on death regardless of what attack (if any) was
      // under way when it died.
      if (p.type === PAIN_ELEMENTAL_TYPE) {
        spawnLostSoul(p, p.angle + Math.PI / 2);
        spawnLostSoul(p, p.angle + Math.PI);
        spawnLostSoul(p, p.angle + (3 * Math.PI) / 2);
      }
    },
    raycastMonster(
      origin: Pos3,
      angleRad: number,
      maxDist: number,
      opts?: { ignoreId?: number; includeHidden?: boolean },
    ): (MonsterRef & { dist: number }) | null {
      const dx = Math.cos(angleRad);
      const dy = Math.sin(angleRad);
      let nearest: (MonsterRef & { dist: number }) | null = null;
      // Grid-backed rather than a scan of every thing: this runs once per
      // monster hitscan, which a crowded map fires dozens of times a frame.
      forEachMonsterAlongRay(origin.x, origin.y, dx, dy, maxDist, (p) => {
        if (p.dead) return;
        if (p.id === opts?.ignoreId) return;
        // Fog of war is a *player*-facing conceit; a monster shooting another
        // monster in an unrevealed room must still connect.
        if (!opts?.includeHidden && !p.visible) return;
        if (Math.abs(p.z - origin.z) > MONSTER_HIT_HEIGHT) return;
        const relX = p.x - origin.x;
        const relY = p.y - origin.y;
        const t = relX * dx + relY * dy;
        if (t < 0 || t > maxDist || (nearest && t >= nearest.dist)) return;
        const perpX = relX - dx * t;
        const perpY = relY - dy * t;
        if (perpX * perpX + perpY * perpY > MONSTER_HIT_RADIUS * MONSTER_HIT_RADIUS) return;
        nearest = { id: p.id, x: origin.x + dx * t, y: origin.y + dy * t, z: p.z, dist: t, type: p.type, angle: p.angle };
      });
      return nearest;
    },
  };
}
