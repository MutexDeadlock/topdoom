import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { World } from './world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
import {
  BOSS_DEATH_TYPES,
  CEILING_HUNG_HEIGHT,
  COUNTITEM_TYPES,
  COUNTKILL_TYPES,
  MONSTER_ACTION_FRAME_SECONDS,
  MONSTER_ATTACK_FRAMES,
  MONSTER_CORPSE_VANISHES,
  MONSTER_DEATH_FRAME_SECONDS,
  MONSTER_DEATH_FRAMES,
  MONSTER_DROPS,
  MONSTER_HEALTH,
  MONSTER_IDLE_FRAMES,
  MONSTER_PAIN_FRAMES,
  MONSTER_RAISE_FRAMES,
  MONSTER_TYPES,
  MONSTER_XDEATH_FRAMES,
  NO_AUTO_AIM_TYPES,
  PICKUP_SCALE_TYPES,
  SOLID_DECORATION_RADIUS,
  SOLID_DECORATION_RADIUS_OVERRIDE,
  SOLID_DECORATION_TYPES,
  THING_ANIM_FRAMES,
  THING_SPRITES,
} from './thingdefs.ts';
import { isAmbush, isMultiplayerOnly, spawnsAtSkill, type Skill } from './skill.ts';
import {
  commitTarget,
  DI_NODIR,
  INERT_SHOOTABLE,
  MONSTER_FIRE_HEIGHT,
  MONSTER_HIT_HEIGHT,
  MONSTER_HIT_RADIUS,
  MONSTER_STATS,
  reactToDamage,
  shouldRetarget,
  stepMonsterAI,
  thrustSpeed,
  tryWake,
  type MonsterAttackEvent,
  type RaiseCandidate,
} from './monsters.ts';
import { circleBlocked, type ThingBlocker } from './world.ts';
import { monsterOrigin, randomVariant, SILENT, type SoundEmitter } from '../audio/sfx.ts';
import { SpriteAnimator, SpriteMaterialCache, VIEWER_ANGLE_DEG } from '../render/sprites.ts';
import { SpriteBatch } from '../render/spritebatch.ts';
import { doomToWorld, litColor } from '../render/mapmesh.ts';
import type { Placement, Pos2, Pos3 } from '../types.ts';
import { DOOM_TIC, PICKUP_SCALE } from '../constants.ts';

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
   * Vanilla's `P_DamageMobj` horizontal knockback (`momx`/`momy`), map
   * units/sec — an impulse `damage` adds to in `ThingLayer.damage` (via
   * `thrustSpeed`), then `applyKnockback` integrates and decays every frame
   * on top of whatever movement (AI-driven, for a monster) already happened
   * this frame, exactly as vanilla's own `P_XYMovement` momentum displaces a
   * mobj independently of, and before, `A_Chase`'s own walk step in the same
   * tic. Meaningless for anything `ThingLayer.damage` never touches (every
   * non-monster, non-barrel thing) — always 0 there.
   */
  velX: number;
  velY: number;
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
  /** Footstep pacing — only the three heavy monsters have any (`MonsterSounds.walk`); inert for everything else, like the AI fields above. */
  walkSoundTimer: number;
  walkSoundStep: number;
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
 * Vanilla's own per-tic XY friction, `FRICTION = 0xE800/0x10000` — applied as
 * a straight multiplicative decay every tic in `P_XYMovement`. `applyKnockback`
 * raises this to the `dt*35` power rather than converting it to a continuous
 * rate first, which reproduces the exact discrete per-tic recurrence at any
 * frame rate (the same "survives conversion out of tics intact" reasoning
 * `MonsterStats.speed` already relies on) rather than approximating it.
 */
const FRICTION = 0.90625;
/**
 * Below this, a decaying knockback velocity is snapped to exactly 0 rather
 * than crawling on forever — the same "a pure exponential decay never
 * actually reaches its target" reasoning `WallFader`'s own fade snap
 * (`render/occlusion.ts`) already documents.
 */
const KNOCKBACK_STOP_SPEED = 1;

/**
 * Slack added to every blocker search so narrowing it to the bodies that can
 * actually touch can't miss one — the longest probe step (`tryWalk` reaches a
 * full `P_Move` ahead) plus the worst one-frame grid staleness. Derived from
 * `MONSTER_STATS` rather than hardcoded so it can't drift out of sync.
 *
 * The two maxima are taken **independently and added**, not maximised as a
 * per-type sum: the monster probing and the monster that drifted are different
 * monsters, so nothing requires them to be the same type. See
 * docs/monsters.md § Spatial indexing.
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
 * DOOM's RUN-state convention: 4 frames (A-D) for every monster, the same
 * cycle `PLAY` uses. The one frame table that isn't rederived per type, with a
 * few known vanilla deviations — docs/monsters.md § Pain, and attack/pain
 * poses.
 */
const MONSTER_WALK_FRAMES = ['A', 'B', 'C', 'D'];

/**
 * One monster as the rest of the engine sees it: the stable `id`
 * `ThingLayer.damage` takes, live position, doomednum (for the species
 * checks), and current facing — which `game.ts`'s arch-vile flame tracking
 * needs, since `A_Fire` keys off the *target's* facing.
 */
export interface MonsterRef extends Pos3 {
  id: number;
  type: number;
  angle: number;
}

/**
 * Live kill/item totals for the level, vanilla's own `totalkills`/`killcount` and
 * `totalitems`/`itemcount` — `total*` set once at spawn (`COUNTKILL_TYPES`/`COUNTITEM_TYPES`),
 * `kills`/`items` incremented as the level is played. docs/items.md § Level stats.
 */
export interface LevelKillItemStats {
  totalKills: number;
  kills: number;
  totalItems: number;
  items: number;
}

export interface ThingLayer {
  group: THREE.Group;
  count: number;
  /** See `LevelKillItemStats`'s own doc. */
  stats: LevelKillItemStats;
  /** Releases the instanced meshes/materials this layer owns; call when the map is unloaded. Shared geometry and textures belong to `SpriteMaterialCache`, which outlives a level. */
  dispose(): void;
  /** Every living monster, still-standing barrel, and solid decoration near (x, y) as a solid body the *player* walks around — all `MF_SOLID` in vanilla. Monsters get `blockersFor` instead. */
  solidBodies(pos: Pos2): ThingBlocker[];
  /**
   * Re-poses every thing at the camera's viewer angle and, for a living
   * monster, ticks its AI: unalerted ones re-check sight every
   * `LOOK_INTERVAL`, alerted ones run `stepMonsterAI` every frame. Gravity and
   * `groundFloor` mirror `Player.update`, but movement is vanilla's 8-way
   * `P_NewChaseDir` rather than `slideMove` (docs/monsters.md § Movement).
   * Returns every attack fired this frame for the caller to apply.
   *
   * `player` is `null` while the player is dead, freezing every monster in
   * place without touching pose/animation/fog-visibility. For anything else,
   * `z` refreshes from the sector's live `floorHeight` — the "ride a moving
   * floor for free" trick, so a corpse left on a lift still rides it.
   *
   * `fogAlphaOf` hides things in an unrevealed subsector, which would
   * otherwise spoil a secret room whose geometry is faded out. `crossLines`
   * gets the segment each alerted monster walked, so the caller can fire walk
   * triggers (docs/specials.md § Teleporters). Also ticks barrel death clocks
   * and reports any `A_Explode` due this frame.
   */
  update(
    dt: number,
    viewerAngleDeg: number,
    player: Pos3 | null,
    fogAlphaOf?: (subsector: number) => number,
    crossLines?: (prev: Pos2, pos: Pos2) => Placement | null,
  ): ThingUpdateResult;
  /**
   * Consumes every not-yet-picked thing within `radius` and vertical reach of
   * `z` that `consume` accepts, hiding it permanently. This layer owns only
   * which world instance disappears; `consume` (inventory.ts's `applyPickup`)
   * owns what picking it up means. Its second argument is the instance's
   * `dropped` flag. docs/items.md § Collecting things.
   */
  tryPickup(pos: Pos3, radius: number, consume: (type: number, dropped: boolean) => boolean): void;
  /**
   * The visible monster this ray hits first, or null — auto-aim's lock-on
   * (docs/combat.md § Auto-aim). Nothing fog of war hides, nothing already
   * dead. The returned `id` is what `damage` takes, so a shot fired this frame
   * can land on exactly this instance later without re-picking. Barrels are
   * lockable too: `P_AimLineAttack` knows only `MF_SHOOTABLE`, not "monster".
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
  /**
   * Whether a shot landing on this thing splashes blood — vanilla's
   * `MF_NOBLOOD`, which in all of stock DOOM exactly one thing carries
   * (`MT_BARREL`; `PTR_ShootTraverse` spawns a puff there instead). Keyed by
   * id and deliberately blind to whether the thing is already dead, so the
   * killing blow still bleeds no matter which side of `damage` the caller
   * asks from. See docs/combat.md § Blood.
   */
  bleeds(id: number): boolean;
  /** Count of living monsters currently alerted (chasing/attacking, or mid-reaction-delay) — for the debug HUD. */
  awakeMonsterCount(): number;
  /**
   * Positions of the alerted monsters `awakeMonsterCount` counts, narrowed to
   * those actually being rendered — each is an extra occlusion-fade sightline
   * target alongside the player. Excluding the unalerted and the fog-hidden is
   * load-bearing (docs/render.md § Wall occlusion fading). **Must be called
   * after `update` has run**, so `visible` reflects this frame's fog.
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
   * `monstersInSector` plus any still-standing barrel in `sector` — vanilla's
   * `PIT_ChangeSector` treats a barrel exactly like a monster for crushing
   * (any `MF_SHOOTABLE` mobj with health left takes the same periodic
   * damage), so a barrel under a crusher dies and, after its usual
   * `BARREL_EXPLODE_DELAY_SECONDS`, explodes the same as if it'd been shot.
   * Crush damage's own caller (`game.ts`'s `applyCrushDamage`) is the only
   * user — the headroom-blocked check other movers use deliberately stays on
   * `monstersInSector` alone, unrelated to this task.
   */
  crushablesInSector(sector: Sector): MonsterRef[];
  /**
   * Applies `amount` damage to `id`, switching to the death animation at 0 —
   * gibbed or plain per `P_KillMobj`'s overkill rule (docs/combat.md § Monster
   * death). A no-op if `id` is stale, already dead, or the amount is
   * non-positive: a projectile can outlive its target, and splash falloff
   * reaches 0 at the blast edge.
   *
   * - `source` — who dealt the hit, absent meaning the player. Drives the
   *   infighting retarget via `shouldRetarget` (docs/monsters.md § Infighting).
   * - `knockUpSpeed` — the arch-vile's `A_VileAttack` launch. Applied here
   *   because it writes the same `z`/`velZ` fields gravity integration owns.
   * - `fromX`/`fromY` — the inflictor position, driving `thrustSpeed`'s
   *   horizontal knockback. Omitted by damage floors and crushers, matching
   *   vanilla's null-inflictor call (docs/movement.md § Knockback).
   *
   * A barrel takes this same call but follows none of it except the knockback:
   * no pain state, no retarget, and death switches its sprite to `BEXP`.
   */
  damage(
    id: number,
    amount: number,
    source?: { id: number; type: number },
    knockUpSpeed?: number,
    fromX?: number,
    fromY?: number,
  ): void;
  /**
   * Creates a fresh, already-awake monster of `type` at `at` and telefrags
   * whatever was standing there (`TELEFRAG_DAMAGE` to every overlapping body),
   * returning it — or null if the WAD carries no art for that doomednum.
   * Vanilla's `A_SpawnFly` tail; the Icon of Sin's spawn cube (`game/icon.ts`)
   * is the only caller.
   *
   * Only the *monster* half of the telefrag happens here: this layer has no
   * player reference, so the caller tests the returned position against the
   * player itself. The new monster counts toward `stats.kills` when killed but
   * never toward `totalKills`, matching vanilla's fixed `P_SpawnMapThing`
   * total — kills can legitimately exceed 100% on MAP30. docs/monsters.md §
   * The spawn cube.
   */
  spawnMonster(type: number, at: Pos3, angleRad: number): MonsterRef | null;
  /**
   * Nearest living monster the ray crosses within `maxDist`, or null — the
   * "didn't click anything, but something's in the path anyway" case for a
   * free shot, tested against `monsters.ts`'s `MONSTER_HIT_RADIUS`/`_HEIGHT`.
   *
   * `opts` serves a *monster's* own hitscan: `ignoreId` excludes the shooter
   * from its own trace, `includeHidden` skips the fog-of-war filter, since fog
   * is a player-facing conceit — two monsters fighting in a room the player
   * hasn't seen must still connect.
   */
  raycastMonster(
    origin: Pos3,
    angleRad: number,
    maxDist: number,
    opts?: { ignoreId?: number; includeHidden?: boolean },
  ): (MonsterRef & { dist: number }) | null;
}


/**
 * The two types whose sight and death sounds vanilla plays **unattenuated**,
 * from nowhere in particular (`A_Look`/`A_Scream`'s own
 * `if (actor->type==MT_SPIDER || actor->type == MT_CYBORG) S_StartSound(NULL, …)`)
 * — you hear a cyberdemon wake up anywhere on the map. Nothing else about their
 * sounds is special: their pain, footsteps and shots all attenuate normally.
 */
const BOSS_TYPES = new Set([7, 16]);

/**
 * Every type whose death can drive level logic, and so the set `damageThing`'s death branch checks
 * before it's worth scanning `posed` for "any others of this type still alive" at all. Distinct
 * from `BOSS_TYPES` above, which is only about unattenuated sound.
 *
 * `BOSS_DEATH_TYPES` is `A_BossDeath`'s own five candidates; Commander Keen (72, `A_KeenDie`) and
 * the boss brain (88, `A_BrainDie`) are added *here* rather than to that table because vanilla
 * reaches them through their own separate action functions. In particular neither is gated on
 * `gamemap`, and `bossDeathTriggersFor`'s `default` branch maps over `BOSS_DEATH_TYPES` to make
 * every member exit on an unlisted episode's map 8 — which must not apply to these two. See
 * docs/specials.md § Boss death.
 */
const DEATH_NOTIFY_TYPES: Set<number> = new Set([...Object.values(BOSS_DEATH_TYPES), 72, 88]);

/**
 * Vanilla's own `P_TeleportMove` telefrag damage — the literal `10000` it deals to everything
 * standing where a body lands. Only `spawnMonster` (the Icon of Sin's spawn cube) reaches it here;
 * this engine has no player teleport that can land on an occupied spot. See docs/combat.md §
 * Telefrag.
 */
export const TELEFRAG_DAMAGE = 10000;

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
/** Vanilla `MT_BARREL`'s own `mass` — confirmed against `linuxdoom-1.10/info.c`, feeds `thrustSpeed`. */
const BARREL_MASS = 100;
/** `S_BAR1`/`S_BAR2` — a two-frame idle sway, each vanilla frame held 6 tics. */
const BARREL_IDLE_FRAMES = ['A', 'B'];
const BARREL_IDLE_FRAME_SECONDS = 6 * DOOM_TIC;
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
const BARREL_DEATH_FRAME_SECONDS = 5 * DOOM_TIC;
/**
 * Vanilla's own `A_Explode` fires on entering `S_BEXP3` — the death
 * animation's third frame, i.e. two frames after the barrel actually died,
 * not instantly on death. Confirmed against `linuxdoom-1.10/info.c`'s
 * `S_BEXP1`/`S_BEXP2` durations (5 tics each) rather than assumed.
 */
const BARREL_EXPLODE_DELAY_SECONDS = 2 * BARREL_DEATH_FRAME_SECONDS;

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

/** Whether `type` gets `PICKUP_SCALE` — see `PICKUP_SCALE_TYPES`'s doc for why this is a whitelist, not "everything but monsters/weapons". */
function pickupScaleFor(type: number): number {
  return PICKUP_SCALE_TYPES.has(type) ? PICKUP_SCALE : 1;
}

/**
 * How far off the floor a monster's death drop is *drawn* (map units), and how
 * far it bobs either side of that over `DROP_BOB_SECONDS`. Purely cosmetic —
 * nothing in `tryPickup` reads the drawn height — and it applies to drops
 * alone because they're the only items that land on top of something else: a
 * drop spawns at exactly the corpse's own position, so at floor level the two
 * sprite planes are coplanar and the item is buried in the corpse art.
 * Lifting it clears the corpse's silhouette, which is mostly ground-hugging.
 * All three tuned by feel; docs/items.md § Making monster drops readable.
 */
const DROP_HOVER = 13;
const DROP_BOB = 3;
const DROP_BOB_SECONDS = 1.8;

/**
 * A drop also fades in and out between these two opacities over
 * `DROP_PULSE_SECONDS`, so what catches the eye is the *change* rather than
 * any added brightness. Tuned by feel; the low end stays well clear of
 * invisible, since a drop that blinks out entirely reads as a rendering fault
 * rather than a highlight.
 */
const DROP_OPACITY_MIN = 0.45;
const DROP_OPACITY_MAX = 1;
const DROP_PULSE_SECONDS = 1.8;

/**
 * Depth-buffer units the drop batch biases itself toward the camera — see
 * `SpriteBatch`'s constructor. Enough to settle a coplanar tie against the
 * corpse underneath, far too little to reach through real geometry.
 */
const DROP_DEPTH_BIAS = 16;

/** One static upright plane per map THING whose type is a known, visible sprite. */
export function buildThingSprites(
  map: DoomMap,
  world: World,
  bank: SpriteBank,
  materials: SpriteMaterialCache,
  skill: Skill,
  sfx: SoundEmitter = SILENT,
  /**
   * Fired from `damage()`'s death branch the instant a monster dies leaving none of its own type
   * alive — vanilla's `A_BossDeath` gate, see docs/specials.md § Boss death. Just the doomednum:
   * whether/how it matters is entirely `SpecialsController`'s per-map table to decide.
   */
  onBossDeath?: (type: number) => void,
): ThingLayer {
  const batch = new SpriteBatch();
  /**
   * Monster death drops draw through their own batch, which is what lets them
   * carry `DROP_DEPTH_BIAS` and a pulsing batch-wide opacity that the rest of
   * the map's things must not get. No extra draw calls: batching is per-lump
   * anyway and a drop never shares a lump with a monster. Not raycast
   * (`pickMonster` wants monsters).
   */
  const dropBatch = new SpriteBatch({ depthBias: DROP_DEPTH_BIAS, translucent: true });
  const group = new THREE.Group();
  group.name = 'things';
  group.add(batch.group, dropBatch.group);
  /** Level time in seconds, driving the drop bob/pulse — see `DROP_HOVER`. */
  let clock = 0;
  const posed: PosedThing[] = [];
  const stats: LevelKillItemStats = { totalKills: 0, kills: 0, totalItems: 0, items: 0 };
  /** Scratch for `doomToWorld`, reused across every sprite — this runs per thing per frame. */
  const worldPos = new THREE.Vector3();

  /**
   * Builds and appends one `PosedThing`, returning it — the single place that
   * ~60-field literal is written. Every spawn path goes through here: the
   * map-load loop below, `spawnDrop`, `spawnLostSoul` and `spawnMonster`. Only
   * the handful of fields those four genuinely disagree on are parameters;
   * everything else is either fixed for a fresh thing (all the `MonsterBody`
   * state, zeroed) or derivable from `type` and the position.
   *
   * Returns null when the WAD carries no art for the type, which is the
   * "silently don't spawn" every caller already wanted. Deliberately does
   * **not** touch `stats.totalKills`/`totalItems`: those are
   * `P_SpawnMapThing`'s own level totals, so only the map-load loop increments
   * them (docs/items.md § Level stats).
   */
  function pushThing(
    type: number,
    at: Pos3,
    facingDeg: number,
    opts?: { ambush?: boolean; dropped?: boolean; alerted?: boolean; targetId?: number | null },
  ): PosedThing | null {
    const spriteName = THING_SPRITES[type];
    if (!spriteName) return null;
    const isBarrel = type === BARREL_TYPE;
    const itemAnim = THING_ANIM_FRAMES[type];
    // A monster walks, a barrel sways, an item blinks — and the two AI-less
    // monsters hold a spawnstate frame of their own (see MONSTER_IDLE_FRAMES).
    const animFrames = MONSTER_TYPES.has(type)
      ? (MONSTER_IDLE_FRAMES[type] ?? MONSTER_WALK_FRAMES)
      : isBarrel
        ? BARREL_IDLE_FRAMES
        : itemAnim
          ? itemAnim.frames
          : ['A'];
    const frameSeconds = isBarrel ? BARREL_IDLE_FRAME_SECONDS : itemAnim ? itemAnim.frameSeconds : undefined;
    const anim = new SpriteAnimator(bank, materials, spriteName, animFrames, frameSeconds);
    // Skips a thing whose art the WAD doesn't actually carry, same as before —
    // resolving once here is what the old build-time `setPose` call was for.
    if (!anim.resolve(facingDeg, VIEWER_ANGLE_DEG)) return null;
    const { x, y, z } = at;
    const thing: PosedThing = {
      id: posed.length,
      anim,
      scale: pickupScaleFor(type),
      blockRadius: isBarrel
        ? BARREL_RADIUS
        : SOLID_DECORATION_TYPES.has(type)
          ? (SOLID_DECORATION_RADIUS_OVERRIDE[type] ?? SOLID_DECORATION_RADIUS)
          : // INERT_SHOOTABLE before the fallback: Keen and the brain have a real
            // mobjinfo radius of 16, they just have no MONSTER_STATS to carry it.
            MONSTER_STATS[type]?.radius ?? INERT_SHOOTABLE[type]?.radius ?? MONSTER_HIT_RADIUS,
      attackFrames: MONSTER_ATTACK_FRAMES[type],
      painFrames: MONSTER_PAIN_FRAMES[type],
      raiseFrames: MONSTER_RAISE_FRAMES[type],
      deadTime: 0,
      deathFrameCount: 0,
      barrelExploded: false,
      explodeSource: null,
      velX: 0,
      velY: 0,
      visible: true,
      hidden: false,
      queryStamp: 0,
      x,
      y,
      z,
      sector: world.sectorAt(x, y),
      facingDeg,
      subsector: world.subsectorAt(x, y),
      type,
      picked: false,
      health: isBarrel ? BARREL_HEALTH : opts?.dropped ? Infinity : MONSTER_HEALTH[type] ?? Infinity,
      dead: false,
      dropped: opts?.dropped ?? false,
      alerted: opts?.alerted ?? false,
      ambush: opts?.ambush ?? false,
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
      walkSoundTimer: 0,
      walkSoundStep: 0,
      lookTimer: 0,
      prev: { x, y },
      targetId: opts?.targetId ?? null,
    };
    posed.push(thing);
    return thing;
  }

  for (const t of map.things) {
    if (!THING_SPRITES[t.type]) continue;
    if (isMultiplayerOnly(t.flags)) continue;
    if (!spawnsAtSkill(t.flags, skill)) continue;

    // MF_SPAWNCEILING things (ceiling-hung gore, Commander Keen) measure z down from the ceiling
    // instead of up from the floor — see CEILING_HUNG_HEIGHT's doc.
    const sector = world.sectorAt(t.x, t.y);
    const hangHeight = CEILING_HUNG_HEIGHT[t.type];
    const z = hangHeight !== undefined ? (sector?.ceilHeight ?? 0) - hangHeight : (sector?.floorHeight ?? 0);
    if (!pushThing(t.type, { x: t.x, y: t.y, z }, t.angle, { ambush: isAmbush(t.flags) })) continue;
    // Vanilla's own `P_SpawnMapThing` totals — incremented only for a thing that actually spawns
    // (past every filter above, art included), matching `if (mobj->flags & MF_COUNTKILL)
    // totalkills++` / `MF_COUNTITEM` in `info.c`. Fixed for the level: only the runtime kill/pickup
    // counters change after this, which is why a cube-spawned monster (`spawnMonster`) can push
    // the kill count past 100%.
    if (COUNTKILL_TYPES.has(t.type)) stats.totalKills++;
    else if (COUNTITEM_TYPES.has(t.type)) stats.totalItems++;
  }

  /**
   * Spawns a monster's death drop (`MONSTER_DROPS`) at its own position —
   * called from `damageThing` below. Always marked `dropped: true` (see
   * `PosedThing`'s doc) so `tryPickup` grants it at vanilla's halved
   * dropped-item rate rather than a map-placed one's.
   */
  function spawnDrop(at: Pos2, sector: Sector | undefined, facingDeg: number, type: number): void {
    pushThing(type, { x: at.x, y: at.y, z: sector?.floorHeight ?? 0 }, facingDeg, { dropped: true });
  }

  /**
   * The pain elemental's `A_PainShootSkull`: spawns a lost soul in front of
   * `origin` and launches it at whatever `origin` is targeting. Called from
   * `update()`'s live `A_PainAttack` and from `damage()`'s death branch
   * (`A_PainDie`, three at once). The new skull spawns already alerted and past
   * its reaction delay, so it makes its own first missile-range roll on its
   * next ordinary chase call.
   *
   * The 20-skull cap is **level-wide**, as in vanilla, not per-elemental. If
   * the spawn point has no room this does nothing — vanilla spawns the mobj and
   * immediately kills it with 10000 damage, which is observably identical.
   * docs/monsters.md § The pain elemental: spawning a lost soul.
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

    // Already alerted, with reactionTicks/movecount pre-zeroed (pushThing's own
    // defaults) so its very first chase call is free to roll straight into
    // checkMissileRange — and so straight into its own charge — rather than
    // first walking a step and waiting out a reaction delay it never had in
    // vanilla, where `A_SkullAttack` fires in the same tic it spawns.
    pushThing(LOST_SOUL_TYPE, { x, y, z }, (angleRad * 180) / Math.PI, {
      alerted: true,
      targetId: origin.targetId,
    });
  }

  /**
   * `A_SpawnFly`'s own monster creation: drops a fresh, already-awake `type` at
   * `at` and telefrags whatever was standing there, returning the new body (or
   * null if the WAD has no art for it). The Icon of Sin's spawn cube is the
   * only caller — `game/icon.ts` owns the rest of that sequence, including the
   * fire puff, the `telept` sound and the *player* half of the telefrag, which
   * this layer holds no reference to.
   *
   * Vanilla ends `A_SpawnFly` with `P_TeleportMove`, which is what makes a
   * spawn spot lethal to stand on: everything overlapping the new body takes
   * `TELEFRAG_DAMAGE` rather than the spawn being blocked or skipped. That is
   * also why there's no `circleBlocked` guard here, unlike `spawnLostSoul`.
   * docs/monsters.md § The spawn cube.
   */
  function spawnMonster(type: number, at: Pos3, angleRad: number): PosedThing | null {
    const spawned = pushThing(type, at, (angleRad * 180) / Math.PI, { alerted: true });
    if (!spawned) return null;
    for (const q of posed) {
      if (q === spawned || q.dead || q.hidden) continue;
      if (!MONSTER_TYPES.has(q.type) && q.type !== BARREL_TYPE) continue;
      const reach = spawned.blockRadius + q.blockRadius;
      if ((q.x - spawned.x) ** 2 + (q.y - spawned.y) ** 2 > reach * reach) continue;
      // Deliberately unattributed: a telefrag is `P_TeleportMove`'s doing, not
      // an attack, and naming the spawned body as the source would start an
      // infight it never picked.
      damageThing(q, TELEFRAG_DAMAGE);
    }
    return spawned;
  }

  /**
   * `P_DamageMobj`/`P_KillMobj` for one body — the whole of `ThingLayer.damage`
   * (see that method's doc for the parameters and the caller-facing contract).
   * Split out from it so `spawnMonster`'s telefrag above can kill through the
   * same path rather than reaching for an id it would have to look back up.
   */
  function damageThing(
    p: PosedThing,
    amount: number,
    source?: { id: number; type: number },
    knockUpSpeed?: number,
    fromX?: number,
    fromY?: number,
  ): void {
    const isBarrel = p.type === BARREL_TYPE;
    if (p.dead || amount <= 0 || !(isBarrel || MONSTER_TYPES.has(p.type))) return;
    // The two AI-less shootables: no stats to roll pain against, no target to
    // retarget, and nothing that reacts to knockback — so they take the health
    // subtraction and their own A_Pain/A_Scream, and skip everything else.
    const inert = INERT_SHOOTABLE[p.type];
    p.health -= amount;
    if (inert) {
      if (p.health > 0) {
        // Unconditional, unlike every other monster's: vanilla's painchance is
        // 256 (Keen) and 255 (the brain), i.e. always or all but always.
        if (p.painFrames) p.anim.playOnce(p.painFrames, MONSTER_ACTION_FRAME_SECONDS);
        sfx.play(inert.painSound, inert.unattenuated ? null : p, monsterOrigin(p.id));
        return;
      }
      p.dead = true;
      p.deadTime = 0;
      if (COUNTKILL_TYPES.has(p.type)) stats.kills++;
      const deathFrames = MONSTER_DEATH_FRAMES[p.type];
      p.deathFrameCount = deathFrames ? deathFrames.length : 0;
      sfx.play(inert.deathSound, inert.unattenuated ? null : p, monsterOrigin(p.id));
      if (deathFrames) p.anim.die(deathFrames, MONSTER_DEATH_FRAME_SECONDS);
      // A_KeenDie's tag-666 door and A_BrainDie's level exit both hang off the
      // same all-of-this-type-are-dead scan the ordinary death branch ends with.
      if (DEATH_NOTIFY_TYPES.has(p.type) && posed.every((q) => q.type !== p.type || q.dead)) {
        onBossDeath?.(p.type);
      }
      return;
    }

    if (knockUpSpeed) {
      p.velZ = knockUpSpeed;
      // Nudges z off the floor so stepMonsterAI's own airborne check
      // (z > groundFloor) engages next frame instead of the ground-snap
      // branch zeroing velZ straight back out before it ever takes effect.
      p.z += 1;
    }
    if (fromX !== undefined && fromY !== undefined) {
      // Vanilla's P_DamageMobj horizontal thrust — see thrustSpeed's doc.
      const mass = isBarrel ? BARREL_MASS : MONSTER_STATS[p.type]?.mass ?? 100;
      const speed = thrustSpeed(amount, mass);
      let dx = p.x - fromX;
      let dy = p.y - fromY;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) {
        // Degenerate same-position case (attacker and victim essentially
        // coincide, e.g. point-blank melee) — vanilla's own
        // R_PointToAngle2(0,0,0,0) falls back to angle 0 here rather than
        // an undefined direction; pushing along the victim's current
        // facing reads more sensibly than always due east.
        dx = Math.cos(p.angle);
        dy = Math.sin(p.angle);
      } else {
        dx /= dist;
        dy /= dist;
      }
      p.velX += dx * speed;
      p.velY += dy * speed;
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
      // A_Pain sits on the painstate itself, so the yelp is gated on the same
      // stagger roll as the flinch pose above, not on merely being hit.
      if (p.painTimer > 0 && stats?.sounds.pain) sfx.play(stats.sounds.pain, p, monsterOrigin(p.id));
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
    // Vanilla P_KillMobj's unconditional `if (target->flags & MF_COUNTKILL) ... killcount++` —
    // no "already counted" guard, so an arch-vile-resurrected monster killed again legitimately
    // counts twice, matching vanilla's own >100%-kills quirk. Barrels never match (not in
    // COUNTKILL_TYPES), so this sits before the barrel branch without needing its own guard.
    if (COUNTKILL_TYPES.has(p.type)) stats.kills++;
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
      // MT_BARREL's own deathsound. Vanilla's A_Scream sits on S_BEXP2, one
      // 5-tic frame into the explosion rather than on death itself; played
      // here on death, since a fifth of a second of silent fireball reads as
      // a bug and the blast (BARREL_EXPLODE_DELAY_SECONDS) is later still.
      sfx.play('barexp', p, monsterOrigin(p.id));
      return;
    }
    // Matches vanilla's P_KillMobj: gib only if this killing blow overkilled
    // by more than the monster's own max health, and only if it actually has
    // gib art (most don't — see MONSTER_XDEATH_FRAMES's doc).
    const maxHealth = MONSTER_HEALTH[p.type] ?? 0;
    const gibbed = p.health < -maxHealth && MONSTER_XDEATH_FRAMES[p.type];
    const frames = gibbed || MONSTER_DEATH_FRAMES[p.type];
    p.deathFrameCount = frames ? frames.length : 0;
    // A_Scream's own death cry — randomized within its family, unattenuated
    // for the two bosses — or A_XScream's wet `slop` for a gib, which the
    // xdeathstate chain plays *instead*, not on top.
    // `MONSTER_STATS` re-read rather than reused: the `stats` above is scoped
    // to the survived-the-hit branch this one is the alternative to.
    const death = gibbed ? 'slop' : MONSTER_STATS[p.type]?.sounds.death;
    if (death) {
      sfx.play(randomVariant(death), BOSS_TYPES.has(p.type) ? null : p, monsterOrigin(p.id));
    }
    if (frames) p.anim.die(frames, MONSTER_DEATH_FRAME_SECONDS);
    else {
      p.hidden = true;
      p.visible = false;
    }

    const dropType = MONSTER_DROPS[p.type];
    if (dropType) spawnDrop(p, p.sector, p.facingDeg, dropType);

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

    // A_BossDeath's own thinker scan: "if any other of this type is still alive, do nothing."
    // Only worth walking `posed` at all for the types a map's own trigger table could possibly
    // care about — see docs/specials.md § Boss death.
    if (DEATH_NOTIFY_TYPES.has(p.type) && posed.every((q) => q.type !== p.type || q.dead)) {
      onBossDeath?.(p.type);
    }
  }

  /**
   * Integrates one frame of a knocked-back thing's momentum — `P_XYMovement`
   * applied to `damage`'s thrust, additive with this frame's AI movement the
   * way vanilla's own ordering is. A blocked monster or barrel **stops dead**
   * rather than sliding, matching `P_XYMovement` zeroing `momx`/`momy` for a
   * blocked non-player mobj; only the player gets `P_SlideMove`.
   *
   * Deliberately skips the `blockersFor` thing check — a knockback nudge is
   * small and rare enough that two shoved bodies briefly overlapping isn't
   * worth the query. docs/movement.md § Knockback.
   */
  function applyKnockback(p: PosedThing, dt: number): void {
    const nx = p.x + p.velX * dt;
    const ny = p.y + p.velY * dt;
    if (circleBlocked(world, nx, ny, p.blockRadius, p.z, true)) {
      p.velX = 0;
      p.velY = 0;
      return;
    }
    p.x = nx;
    p.y = ny;
    const decay = Math.pow(FRICTION, dt * 35);
    p.velX *= decay;
    p.velY *= decay;
    if (Math.abs(p.velX) < KNOCKBACK_STOP_SPEED) p.velX = 0;
    if (Math.abs(p.velY) < KNOCKBACK_STOP_SPEED) p.velY = 0;
  }

  /**
   * Where a monster should currently be heading, or `null` if it has nobody
   * left to want. `targetId` is non-null only after something other than the
   * player hurt it (`damage` → `shouldRetarget`), and a target that dies hands
   * attention straight back to the player — vanilla's `A_Chase` does the same
   * via `P_LookForPlayers` once `target->health <= 0`. `player` is itself
   * `null` once the player is dead (`ThingLayer.update`'s caller), matching
   * `P_LookForPlayers`'s own `player->health <= 0` skip — vanilla's
   * `P_KillMobj` also strips the player's `MF_SHOOTABLE`, so a monster with no
   * *other* target finds nobody and reports `null` here the same as if
   * `P_LookForPlayers` had failed.
   */
  function resolveTarget(p: PosedThing, player: Pos3 | null): Pos3 | null {
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
   * Raisable corpses bucketed into `blockerGrid`'s cell grid, filled in the
   * same `posed` pass. Backs `findRaisableCorpse`, which was a linear scan on
   * the unverified assumption that arch-viles are rare — they aren't on every
   * map, and it cost most of a frame there. docs/monsters.md § Spatial
   * indexing.
   */
  const corpseGrid: PosedThing[][] = new Array(blockerCols * blockerRows);
  /** Indices of the cells that actually have anything in them, so a rebuild clears only those instead of walking the whole grid. */
  const corpseDirty: number[] = [];
  /** Largest collision radius among corpses currently in `corpseGrid`, sizing `findRaisableCorpse`'s search box the same way `maxBlockerRadius` sizes `blockersFor`'s. */
  let maxCorpseRadius = 0;
  /** Bumped per `forEachMonsterAlongRay` call; see `PosedThing.queryStamp`. */
  let monsterQueryStamp = 0;
  /** Largest collision radius currently in the grid, so `blockersFor` sizes its box to what this map contains rather than to the biggest monster in the game. */
  let maxBlockerRadius = PLAYER_RADIUS;

  /**
   * Every living monster in the grid cells covering `radius` around (x, y).
   * The caller still applies its own exact distance test; this only narrows
   * the candidates. Padded by `BLOCKER_MARGIN` since the grid buckets each
   * monster by where it stood at rebuild time.
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
   * Every living monster in or beside the cells a ray passes through, each
   * visited at most once — backs `raycastMonster`, called dozens of times a
   * frame on a crowded map.
   *
   * Deliberately simpler than `forEachLineAlongSegment`'s exact DDA: half-cell
   * steps with a 3×3 sweep each. Half-cell steps skip no cell on the path, and
   * the 3×3 sweep clears a full 128 units either side — far more than the ~24
   * unit hit radius — so it cannot miss a monster the exact ray would hit.
   * Stamped rather than `Set`-deduped, since consecutive neighbourhoods
   * overlap heavily. docs/monsters.md § Spatial indexing.
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
      // A living barrel, and any `SOLID_DECORATION_TYPES` prop, is exactly as
      // solid as a monster — vanilla's own MF_SOLID — so both join the same
      // grid: they block the player (`solidBodies`) and a monster's own
      // movement (`blockersFor`) for free through the machinery already built
      // for monsters. Unlike the barrel, a plain decoration isn't
      // `MF_SHOOTABLE` — `raycastMonster`/`monstersNear` explicitly filter
      // `SOLID_DECORATION_TYPES` back out below, so it still doesn't stop a
      // shot.
      if (!MONSTER_TYPES.has(p.type) && p.type !== BARREL_TYPE && !SOLID_DECORATION_TYPES.has(p.type)) continue;
      if (p.blockRadius > maxBlockerRadius) maxBlockerRadius = p.blockRadius;
      const i = blockerRow(p.y) * blockerCols + blockerCol(p.x);
      let cell = blockerGrid[i];
      if (!cell) blockerGrid[i] = cell = [];
      if (cell.length === 0) blockerDirty.push(i);
      cell.push(p);
    }
  }

  /**
   * Reused storage for `blockersFor`'s result — `blockerPool` owns the objects
   * and only grows, `blockerScratch` is refilled with references, so a
   * steady-state frame allocates nothing. Allocating fresh per call profiled as
   * the majority of all monster-AI time on a crowded map (docs/monsters.md §
   * Spatial indexing).
   *
   * **The tradeoff: the result is valid only until the next call** — hence
   * `readonly`, and hence its one caller consuming it synchronously.
   * `solidBodies` deliberately does *not* share this: once per frame for the
   * player, a plain allocation costs nothing and an aliased buffer is a trap.
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
   * The solid bodies near `p` it can bump into — every other living monster,
   * the player, and any solid decoration/barrel, all `MF_SOLID` in vanilla.
   * `p` itself is excluded.
   *
   * **The returned array is reused** — see `blockerScratch`.
   *
   * The box is sized from the radii actually involved, not a fixed worst case,
   * and only the cells it covers are scanned. The single hottest thing in
   * monster AI; see docs/monsters.md § Spatial indexing.
   */
  function blockersFor(p: PosedThing, player: Pos3 | null): readonly ThingBlocker[] {
    blockerScratch.length = 0;
    const ownRadius = p.blockRadius;
    // `blockedByThings` only ever reports an overlap inside `r1 + r2`, so
    // nothing further than the widest possible summed radii (plus the margin)
    // can matter — searching further is pure waste, and it was: a fixed
    // 320-unit box collected ~145 candidates per monster on a map of 20-unit
    // grunts, which profiled as half of all monster-AI time.
    const reach = ownRadius + maxBlockerRadius + BLOCKER_MARGIN;
    // `null` once the player is dead — vanilla's `P_KillMobj` clears the
    // player's `MF_SOLID` right alongside `MF_SHOOTABLE`, so a corpse is no
    // more an obstacle than it is a target.
    if (player) {
      const playerReach = ownRadius + PLAYER_RADIUS + BLOCKER_MARGIN;
      if (Math.abs(player.x - p.x) <= playerReach && Math.abs(player.y - p.y) <= playerReach) {
        pushBlocker(player.x, player.y, PLAYER_RADIUS);
      }
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
   * Vanilla's `PIT_VileCheck`, the `resurrect` callback `runChaseCall` takes:
   * the first corpse near (x, y) this arch-vile could raise, or null.
   * Grid-accelerated the same shape as `blockersFor` — box, cells, exact
   * per-pair test. Which corpse wins when several qualify follows grid
   * iteration order, as arbitrary as vanilla's own blockmap order.
   *
   * Skips vanilla's `P_CheckPosition` re-test against other nearby things (the
   * corpse height-quadrupling trick) — raises are rare enough that reusing
   * `blockersFor`'s per-caller machinery here wasn't worth the coupling.
   * docs/monsters.md § The arch-vile.
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
    // Clears any stale knockback velocity from however it died — dead things
    // never integrate velX/velY/velZ, so it could otherwise sit unused for
    // the rest of the level and then jump (or slide) on revival.
    p.velX = 0;
    p.velY = 0;
    p.velZ = 0;
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
    // Vanilla's A_VileChase plays `slop` on the corpse as it comes back up —
    // the same sound a gib death makes, which is why a resurrection sounds
    // like one played backwards.
    sfx.play('slop', p, monsterOrigin(p.id));
    p.anim.revive();
    if (p.raiseFrames) p.anim.playOnce(p.raiseFrames, MONSTER_DEATH_FRAME_SECONDS);
  }

  // Seeded once here so a lookup that lands before the first `update` (a
  // splash on the opening frame, say) still finds the monsters that exist.
  rebuildBlockerGrid();

  return {
    group,
    count: posed.length,
    stats,
    solidBodies(pos: Pos2): ThingBlocker[] {
      const out: ThingBlocker[] = [];
      for (const p of posed) {
        if (p.dead || (!MONSTER_TYPES.has(p.type) && p.type !== BARREL_TYPE && !SOLID_DECORATION_TYPES.has(p.type))) continue;
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
      clock += dt;
      batch.begin(viewerAngleDeg);
      dropBatch.begin(viewerAngleDeg);
      const pulse = Math.sin((clock / DROP_PULSE_SECONDS) * Math.PI * 2) * 0.5 + 0.5;
      dropBatch.setOpacity(DROP_OPACITY_MIN + (DROP_OPACITY_MAX - DROP_OPACITY_MIN) * pulse);
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

        // Every non-monster (barrel sway, decoration flicker, item/key/powerup
        // blink) always cycles — vanilla's idle art loops unconditionally, it's
        // not tied to motion the way a monster's walk cycle is. A monster
        // starts false and only the stats branch below turns it on, based on
        // whether it actually stepped this frame.
        let animating = !MONSTER_TYPES.has(p.type);
        const stats = !p.dead ? MONSTER_STATS[p.type] : undefined;
        if (stats) {
          // Only the wake check itself needs a living player — vanilla's
          // `P_LookForPlayers` (which `A_Look`/idle monsters call) explicitly
          // skips `player->health <= 0`, so a dead player can't rouse anyone
          // new. An already-alerted monster's own stepping keeps running
          // either way: it may be mid-infight with another monster, and
          // resolveTarget below is what actually decides whether *it* still
          // has anyone to want.
          if (!p.alerted && player) {
            // Throttled the same way vanilla's own idle A_Look is — see LOOK_INTERVAL.
            // The actual wake decision (FOV/sight/sound/ambush rules) lives in
            // game/monsters.ts's tryWake; this loop only owns the throttle.
            p.lookTimer += dt;
            if (p.lookTimer >= LOOK_INTERVAL) {
              p.lookTimer = 0;
              // Waking is one of the two events that can reshuffle a
              // revenant's guided/unguided personality — see
              // MonsterBody.homingBias's doc. A no-op for every other type.
              if (tryWake(p, world, p.sector, player)) {
                p.homingBias = Math.random() < 0.5;
                // A_Look's sight sound, randomized within its family (the
                // zombieman/imp groups) and unattenuated for the two bosses.
                const see = stats.sounds.see;
                if (see) sfx.play(randomVariant(see), BOSS_TYPES.has(p.type) ? null : p, monsterOrigin(p.id));
              }
            }
          }
          if (p.alerted) {
            const target = resolveTarget(p, player);
            if (!target) {
              // vanilla's own `A_Chase`: `!(actor->target->flags&MF_SHOOTABLE)`
              // (the player's flag `P_KillMobj` strips on death) with nobody
              // else to fall back on sends the monster straight to
              // `P_SetMobjState(actor->info->spawnstate)` — it gives up and
              // idles, exactly like a monster that never woke. It only gets
              // going again via `damage`'s own unconditional re-alert (infight
              // splash, friendly fire), same as any other dormant monster.
              p.alerted = false;
              p.movedir = DI_NODIR;
              p.movecount = 0;
              p.z = p.sector?.floorHeight ?? p.z;
            } else {
              const beforeX = p.x;
              const beforeY = p.y;
              // The melee gate's `pl->info->radius`/height. The target is the
              // player exactly when `resolveTarget` fell back to it; anything
              // else is another `PosedThing`, whose `blockRadius` is already
              // this type's own resolved radius (see that field's doc), sized
              // vertically by the one approximate monster box.
              const victim = target === player ? null : (posed[p.targetId!] ?? null);
              const targetRadius = victim ? victim.blockRadius : PLAYER_RADIUS;
              const targetHeight = victim ? MONSTER_HIT_HEIGHT : PLAYER_HEIGHT;
              const result = stepMonsterAI(
                p,
                stats,
                dt,
                world,
                target,
                targetRadius,
                targetHeight,
                blockersFor(p, player),
                findRaisableCorpse,
                sfx,
              );
              // Vanilla's own momentum-driven displacement, additive on top of
              // the AI walk step just above — see applyKnockback's doc.
              if (p.velX !== 0 || p.velY !== 0) applyKnockback(p, dt);
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
            }
          } else {
            p.z = p.sector?.floorHeight ?? p.z;
            // A not-yet-alerted monster can still be knocked back — a hit
            // always sets velX/velY in `damage`, though in practice it also
            // always alerts the monster in that same call, so this mostly
            // guards the same-frame ordering rather than a state that lingers.
            if (p.velX !== 0 || p.velY !== 0) applyKnockback(p, dt);
          }
        } else {
          // Ceiling-hung gore rides a moving ceiling (crusher, closing door) the same way
          // everything else here rides a moving floor — see CEILING_HUNG_HEIGHT's doc.
          const hangHeight = CEILING_HUNG_HEIGHT[p.type];
          p.z = hangHeight !== undefined ? (p.sector?.ceilHeight ?? p.z + hangHeight) - hangHeight : (p.sector?.floorHeight ?? p.z);
          // Barrels have no AI movement of their own, so this is their only
          // source of horizontal motion; a freshly-dead monster (stats
          // undefined above) lands here too, finishing off whatever knockback
          // it had at the moment it died.
          if (!p.dead && (p.velX !== 0 || p.velY !== 0)) applyKnockback(p, dt);
        }

        p.visible = !fogAlphaOf || fogAlphaOf(p.subsector) > 0.5;
        p.anim.advance(dt, animating);
        // Resolving the lump is only worth doing for something actually being
        // drawn — for a map like NUTS.WAD this skips thousands of SpriteBank
        // lookups a frame while the player has only explored part of it.
        if (!p.visible) continue;
        const cached = p.anim.resolve(p.facingDeg, viewerAngleDeg);
        if (!cached) continue;
        // Everything the map itself placed draws plainly, at its own height:
        // only a drop lands on top of a corpse, and only a drop is worth
        // singling out (docs/items.md § Making monster drops readable).
        // Read live off the sector rather than caching a `light` field on the
        // thing — see docs/render.md § Sector lighting on why every sprite must.
        const light = litColor(p.sector?.light ?? 128);
        if (!p.dropped) {
          doomToWorld(p.x, p.y, p.z, worldPos);
          batch.add(cached, worldPos.x, worldPos.y, worldPos.z, p.scale, light, p.id);
          continue;
        }
        // Phase-shifted per instance (`p.id`), so two drops side by side
        // ripple instead of bobbing in unison. The opacity pulse can't do the
        // same — it's batch-wide, see `SpriteBatch.setOpacity`.
        const bob = Math.sin((clock / DROP_BOB_SECONDS + p.id * 0.7) * Math.PI * 2) * DROP_BOB;
        doomToWorld(p.x, p.y, p.z + DROP_HOVER + bob, worldPos);
        dropBatch.add(cached, worldPos.x, worldPos.y, worldPos.z, p.scale, light, p.id);
      }
      batch.end();
      dropBatch.end();
      return { attacks, barrelExplosions };
    },
    dispose(): void {
      batch.dispose();
      dropBatch.dispose();
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
          // Vanilla P_TouchSpecialThing's `if (special->flags & MF_COUNTITEM) player->itemcount++`.
          // A monster drop never matches (ammo/weapons aren't COUNTITEM), so no `dropped` guard needed.
          if (COUNTITEM_TYPES.has(p.type)) stats.items++;
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
        if (!p || p.picked || p.dead || !p.visible) return false;
        if (NO_AUTO_AIM_TYPES.has(p.type)) return false;
        return MONSTER_TYPES.has(p.type) || p.type === BARREL_TYPE;
      });
      if (id === null) return null;
      const p = posed[id];
      return { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle };
    },
    monstersNear(pos: Pos2, radius: number): MonsterRef[] {
      // Grid-backed, not a scan of every thing. This is called once per
      // in-flight projectile per frame (`game/projectiles.ts`'s `monsterStruckBy`), and a
      // crowded map can have well over a thousand projectiles in the air at
      // once — as a linear scan that alone measured ~138 ms/frame on NUTS.WAD,
      // more than everything else in the frame put together.
      const out: MonsterRef[] = [];
      const rSq = radius * radius;
      forEachMonsterNear(pos.x, pos.y, radius, (p) => {
        // blockerGrid also carries SOLID_DECORATION_TYPES now (movement only) — not MF_SHOOTABLE
        // in vanilla, so a projectile must not strike one.
        if (p.dead || SOLID_DECORATION_TYPES.has(p.type)) return;
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
    bleeds(id: number): boolean {
      const p = posed[id];
      return !!p && p.type !== BARREL_TYPE;
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
    crushablesInSector(sector: Sector): MonsterRef[] {
      const out: MonsterRef[] = [];
      for (const p of posed) {
        if (p.dead || p.sector !== sector) continue;
        if (!MONSTER_TYPES.has(p.type) && p.type !== BARREL_TYPE) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle });
      }
      return out;
    },
    damage(
      id: number,
      amount: number,
      source?: { id: number; type: number },
      knockUpSpeed?: number,
      fromX?: number,
      fromY?: number,
    ): void {
      const p = posed[id];
      if (p) damageThing(p, amount, source, knockUpSpeed, fromX, fromY);
    },
    spawnMonster(type: number, at: Pos3, angleRad: number): MonsterRef | null {
      const p = spawnMonster(type, at, angleRad);
      return p ? { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle } : null;
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
        // blockerGrid also carries SOLID_DECORATION_TYPES now (movement only) — not MF_SHOOTABLE
        // in vanilla, so a hitscan must pass through one rather than stopping on it.
        if (p.dead || SOLID_DECORATION_TYPES.has(p.type)) return;
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
