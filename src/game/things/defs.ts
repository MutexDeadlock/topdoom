/**
 * The thing layer's record shapes and the constants tied to them: one live map thing
 * ({@link PosedThing}), the layer's public surface ({@link ThingLayer}), and the handful of
 * doomednums/tables that only this layer's own logic reads.
 *
 * Distinct from `things/tables.ts`, which holds the *WAD-derived* tables every thing type is
 * looked up in (sprites, health, drops, frame letters); this file is runtime state and the API
 * around it, the same division `monsters/defs.ts` makes for the AI. See docs/items.md and
 * docs/monster-ai.md.
 */
import * as THREE from 'three';
import type { Sector } from '../../wad/map.ts';
import { BOSS_DEATH_TYPES } from './tables.ts';
import { pristineFrameTables } from '../dehacked/frames.ts';
import { ThingType } from './doomednums.ts';
import type { MonsterAttackEvent, MonsterBody, MonsterStats } from '../monsters/defs.ts';
import type { ThingsSnapshot } from '../snapshot.ts';
import type { PinnedMemo, SectorTouchCache, ThingBlocker } from '../world.ts';
import type { SpriteAnimator } from '../../render/sprites.ts';
import type { Pos2, Pos3 } from '../../types.ts';
import type { TeleportDest } from '../specials.ts';


/** One attack's pose: vanilla's own state frames, with the tics each is held for. */
export interface AttackPose {
  /**
   * Frame letters in chain order, **repeats kept** — unlike the walk and death tables, where a
   * repeated frame is a no-op against a flat rate. Here each frame carries its own length, so
   * vanilla's `E,F,E` (wind up, fire, recover) is three frames and not two.
   */
  frames: string[];
  /**
   * Each frame's `info.c` tic count, parallel to {@link AttackPose.frames}. Zero-tic states are
   * dropped: they never draw.
   */
  tics: number[];
}
import { DOOM_TIC, PICKUP_SCALE } from '../../constants.ts';

/**
 * One live map thing. Extends {@link MonsterBody} (`monsters/defs.ts`) rather than re-declaring
 * its chase/attack fields: `stepMonsterAI` is handed a {@link PosedThing} directly, so the two must
 * agree, and inheriting says so where a copied field list only hoped so. Every one of those fields
 * is present and inert on a non-monster thing — see `pushThing`'s zeroed defaults.
 */
export interface PosedThing extends Pos3, MonsterBody {
  /**
   * Index into the `posed` array itself. A stable handle callers (game.ts) can hold onto across
   * frames to target this exact instance with {@link ThingLayer.damage}.
   */
  id: number;
  /** `WakeCheckBody.lastlook` — drawn for every thing, read only for a monster. */
  lastlook: number;
  /**
   * This thing's animation state and current-lump lookup. Deliberately *not*
   * a `SpriteActor` (which owns a `THREE.Mesh`): every map thing is drawn
   * through the shared `SpriteBatch` instead, so ten thousand of them cost a
   * few dozen draw calls rather than ten thousand — see `SpriteBatch`'s doc.
   */
  anim: SpriteAnimator;
  /** Native-size multiplier ({@link pickupScaleFor}), handed to the batch each frame. */
  scale: number;
  /**
   * Whether auto-aim's pointer may lock onto this thing at all — a monster or a barrel, and not
   * one of `NO_AUTO_AIM_TYPES`. Resolved once at spawn for the same reason
   * {@link PosedThing.blockRadius} is: the answer is fixed by {@link PosedThing.type}, and
   * {@link ThingLayer.pickMonster} walks every thing on the map each tic, where two sparse-key
   * `Set` probes per thing measured most of the pick's cost on NUTS.WAD. docs/combat.md § Auto-aim.
   */
  lockable: boolean;
  /**
   * Collision radius, resolved once at spawn — a per-query `MONSTER_STATS[type]` is a sparse-key
   * dictionary hash, measured hotter than the collision arithmetic it fed (docs/monster-ai.md
   * § Spatial indexing).
   */
  blockRadius: number;
  /**
   * This body's own `mobjinfo.height`, resolved once at spawn exactly as
   * {@link PosedThing.blockRadius} is. Every vertical fit test that knows which body it means reads
   * it: whether a crusher has closed far enough to catch this thing, whether it fits through an
   * opening, and how tall a target a shot sees.
   */
  bodyHeight: number;
  /**
   * This type's stats entry, `undefined` for anything without one, and the two type facts
   * {@link ThingLayer.update} asks per thing per tic — all resolved once at spawn for the reason
   * {@link PosedThing.blockRadius} is.
   */
  stats: MonsterStats | undefined;
  isMonster: boolean;
  hangHeight: number | undefined;
  /**
   * `MF_SOLID`: a monster, a barrel or a `SOLID_DECORATION_TYPES` prop — what the thing grid files
   * and what the player walks around. Resolved once at spawn for the reason
   * {@link PosedThing.blockRadius} is.
   */
  isSolid: boolean;
  /**
   * A `SOLID_DECORATION_TYPES` prop: filed by the grid because it blocks movement, but skipped by
   * every shot query because it stops none. Resolved once at spawn for the reason
   * {@link PosedThing.blockRadius} is.
   */
  isDecoration: boolean;
  /**
   * This type's attack poses per kind (`MONSTER_ATTACK_POSE`) and pain frame letters, resolved once
   * at spawn for the same reason {@link PosedThing.blockRadius} is. `undefined` for anything
   * without a table entry.
   */
  attackPose: { melee?: AttackPose; ranged?: AttackPose } | undefined;
  painFrames: string[] | undefined;
  /**
   * Whether this thing is drawn (and so targetable/shootable) right now:
   * fog of war hasn't revealed its subsector, it was picked up, or it died
   * with no death art. A batched thing has no mesh of its own for a caller to
   * read `visible` off, so this field is where that answer lives.
   */
  visible: boolean;
  /**
   * Permanently hidden regardless of fog — a consumed pickup, or a corpse with no death animation
   * to play.
   */
  hidden: boolean;
  /**
   * Scratch dedupe marker for `forEachMonsterAlongRay`, whose stepped cell neighbourhoods overlap.
   * Meaningless between queries.
   */
  queryStamp: number;
  /**
   * The thing grid cell and slot `rebuild` filed this body in — where `ThingGrid.markDisplaced`
   * reaches to widen its move bound when a teleport moves it further than any bound covers.
   */
  gridCell: number;
  gridSlot: number;
  /**
   * The furthest this body can stand, per axis, from where the grid's `rebuild` filed it by the
   * time a query runs in the same tic — see `ThingGrid.rebuild`. Written there.
   *
   * A field on the body rather than a parallel array or a second `moveBoundOf` call, both of which
   * measured slower than this on every thing count tried — the fill pass would pay them per solid
   * body per tic. CLAUDE.md § Hot paths are measured, not reasoned about.
   */
  moveBound: number;
  /**
   * This body's cached touched-sector list for the per-tic conveyor query
   * (`World.sectorsTouchingCached`). Derived state, never saved.
   */
  touch: SectorTouchCache;
  /**
   * The pinned-body memo for `applyKnockback` (`World.capturePin`): this exact
   * position, feet height and velocity produced a blocked, velocity-zeroing
   * outcome, valid until any stamped nearby sector height changes — a
   * belt-pinned closet monster skips its `positionBlocked` re-check every tic
   * on this. Derived state, never saved. docs/movement.md § Pinned-body memo.
   */
  pinned: PinnedMemo;
  /**
   * Feet height ({@link Pos3.z}). While not an alerted monster: refreshed each frame from
   * `sector.floorHeight` (the "ride a moving floor for free" trick). Once alerted, `stepMonsterAI`
   * owns it via `groundFloor` + gravity, the same physics the player uses.
   */
  z: number;
  /**
   * Its containing sector — the live reference {@link PosedThing.z} is read from while not an
   * alerted monster; reassigned each frame by {@link ThingLayer.update} once a monster starts
   * moving.
   */
  sector: Sector | undefined;
  facingDeg: number;
  /**
   * Where this thing came into the world and facing which way — vanilla's `mobj->spawnpoint`,
   * read only by nightmare respawning. Set once by `pushThing`, so for anything that never moved
   * it equals {@link PosedThing.x}/{@link PosedThing.y}/{@link PosedThing.facingDeg} — the
   * condition `snapshotThings` elides it on. docs/monster-ai.md § Respawning monsters.
   */
  spawnX: number;
  spawnY: number;
  spawnAngle: number;
  subsector: number;
  type: number;
  /**
   * Set once a pickup consumes this instance; it then stays permanently hidden (see
   * {@link ThingLayer.update}).
   */
  picked: boolean;
  /**
   * Remaining hit points;
   * only meaningful for a `MONSTER_TYPES` thing (see `MONSTER_HEALTH`).
   * everything else stays at `Infinity` and can never die.
   */
  health: number;
  /** Set once {@link PosedThing.health} reaches 0; see {@link ThingLayer.damage}. */
  dead: boolean;
  /**
   * Seconds since {@link PosedThing.dead} was set. Vanilla's `PIT_VileCheck` refuses to raise a
   * corpse whose own death animation is still playing (`tics != -1`, "not lying still yet") —
   * `findRaisableCorpse` compares this against `deathFrameCount * MONSTER_DEATH_FRAME_SECONDS` for
   * the same gate.
   */
  deadTime: number;
  /**
   * Frame count of whichever death animation (`MONSTER_DEATH_FRAMES` or the gibbed
   * `MONSTER_XDEATH_FRAMES`) {@link ThingLayer.damage} actually played — set at time of death,
   * read back by {@link PosedThing.deadTime}'s "still settling" check above. 0 for anything that
   * never died with real death art (see {@link ThingLayer.damage}'s {@link PosedThing.hidden}
   * fallback).
   */
  deathFrameCount: number;
  /**
   * Set once a moving plane has crunched this corpse to giblets — `PIT_ChangeSector`'s
   * `P_SetMobjState(thing, S_GIBS)`. Read by `enterDeathPose`, which is what makes the pool the
   * pose a restored save comes back holding. docs/specials-crushers.md § Crushed corpses.
   */
  crushed: boolean;
  /**
   * This type's resurrection frames (`MONSTER_RAISE_FRAMES`), resolved once at spawn for the same
   * reason {@link PosedThing.attackPose}/{@link PosedThing.painFrames} are — and doubles as the
   * arch-vile's own eligibility test: `undefined` means this type has no vanilla `raisestate` and
   * `findRaisableCorpse` skips it outright, matching vanilla's `raisestate == S_NULL` check.
   */
  raiseFrames: string[] | undefined;
  /**
   * Set once a dead barrel's own `A_Explode` has actually fired
   * ({@link BARREL_CHAIN.explodeDelaySeconds} after death, not on death itself — see that
   * constant's doc), so {@link ThingLayer.update}'s per-frame {@link PosedThing.deadTime} check
   * doesn't re-fire it every subsequent frame. Meaningless for anything else.
   */
  barrelExploded: boolean;
  /**
   * Who dealt a barrel's killing blow, captured at the moment it died and carried forward to its
   * own `A_Explode` — vanilla's `P_RadiusAttack` passes the exploding barrel's own `target`
   * (whoever damaged it) as the new blast's `bombsource`, which is how a chain of barrels keeps
   * attributing every link back to whoever set the first one off rather than to the previous
   * barrel in the chain. Held as a projectile holds its shooter (`sourceId`/`sourceType`): a
   * player as its slot's {@link targetOfSlot} with type 0, so every kill down a chain a player set
   * off counts as theirs, and {@link hitBy} splits it back. `null` is nobody's — a crusher, a
   * telefrag. Meaningless for anything else. docs/death.md § Exploding barrels.
   */
  explodeSource: { id: number; type: number } | null;
  /**
   * Vanilla's `P_DamageMobj` horizontal knockback (`momx`/`momy`), map units/sec — an impulse
   * `damage` adds to in {@link ThingLayer.damage} (via `thrustSpeed`), then `applyKnockback`
   * integrates and decays every frame on top of whatever movement (AI-driven, for a monster)
   * already happened this frame, exactly as vanilla's own `P_XYMovement` momentum displaces a mobj
   * independently of, and before, `A_Chase`'s own walk step in the same tic. Meaningless for
   * anything {@link ThingLayer.damage} never touches (every non-monster, non-barrel thing) —
   * always 0 there.
   */
  velX: number;
  velY: number;
  /**
   * True for an item {@link ThingLayer.damage} spawned itself (`MONSTER_DROPS`) rather than one the
   * map placed — threaded through to `applyPickup`'s own `dropped` param, which halves the ammo it
   * grants.
   */
  dropped: boolean;

  // Monster AI. Everything `MonsterBody` declares is inherited above and inert for a non-monster;
  // these four are the layer's own, which `game/monsters/ai.ts` has no business knowing about.
  /**
   * True once this monster has spotted the player and started chasing
   * ({@link ThingLayer.update}'s throttled wake check, LOOK_INTERVAL).
   */
  alerted: boolean;
  /**
   * The map thing's "ambush"/deaf flag (`game/skill.ts: isAmbush`). Gates whether a
   * sound-alerted sector alone can wake this monster; see {@link ThingLayer.update}'s wake check.
   */
  ambush: boolean;
  /**
   * Position at the end of the previous tic, so `crossLines` can test the segment this monster
   * just walked. Mutated in place; never re-allocated. Maintained only on the alerted-with-a-target
   * path, which is the only one that can walk over a line — **not** an interpolation source, which
   * is what {@link PosedThing.drawPrevX}/{@link PosedThing.drawPrevY}/{@link PosedThing.drawPrevZ}
   * are for.
   */
  prev: Pos2;
  /**
   * Where this thing was at the end of the previous tic, for the render layer to interpolate from.
   * Unlike {@link PosedThing.prev} this is written for *every* thing on *every* tic, since
   * knockback, corpse gravity and a ceiling-hung prop riding a closing door all move a thing that
   * never runs the AI path. docs/frameloop.md § Interpolation.
   */
  drawPrevX: number;
  drawPrevY: number;
  drawPrevZ: number;
  /**
   * Who this monster is currently hunting: another {@link PosedThing}'s ID, or a player slot as
   * {@link targetOfSlot} encodes one. Set by {@link ThingLayer.damage} when something hurts it
   * (see `shouldRetarget`) — the mechanism behind infighting — and reset to player 1 once that
   * target dies. docs/multiplayer.md § Slot addressing.
   */
  targetId: number;
}

/**
 * A player slot as a {@link PosedThing.targetId}: `-1` for slot 0, `-2` for slot 1, and so on —
 * below every {@link PosedThing.id}, so one integer compare tells a player from a monster and the
 * field stays a small integer. {@link slotOfTarget} reads it back; only meaningful where
 * `targetId < 0`. docs/multiplayer.md § Slot addressing.
 */
export function targetOfSlot(slot: number): number {
  return -1 - slot;
}

export function slotOfTarget(targetId: number): number {
  return -1 - targetId;
}

/**
 * The attribution of a {@link DamageHit} for an attacker held as a target ID and a type — a
 * projectile's `sourceId`/`sourceType`, a barrel's {@link PosedThing.explodeSource}.
 * docs/multiplayer.md § Slot addressing.
 *
 * @returns a monster as the hit's {@link DamageHit.source}, a player as its {@link DamageHit.slot}
 */
export function hitBy(id: number, type: number): Pick<DamageHit, 'source' | 'slot'> {
  return id < 0 ? { slot: slotOfTarget(id) } : { source: { id, type } };
}

/**
 * Where a body stands and how tall it is — {@link StandingBody.z} its feet,
 * {@link StandingBody.height} its own `mobjinfo.height` ({@link PosedThing.bodyHeight}), the real
 * per-species 56-110 unit figure rather than one shared band. The least a caller can be handed and
 * still reason about the *whole* of a body rather than a point in it, which is what an occlusion
 * sightline needs (docs/render-occlusion.md § The target is the billboard) and what
 * {@link MonsterRef} builds its identity on top of.
 */
export interface StandingBody extends Pos3 {
  height: number;
}

/**
 * One monster as the rest of the engine sees it: the stable {@link MonsterRef.id}
 * {@link ThingLayer.damage} takes, live position and height, doomednum (for the species checks),
 * and current facing — which `game.ts`'s arch-vile flame tracking needs, since `A_Fire` keys off
 * the *target's* facing.
 */
export interface MonsterRef extends StandingBody {
  id: number;
  type: number;
  angle: number;
  /**
   * This body's own `mobjinfo.radius` ({@link PosedThing.blockRadius}) — the real per-species
   * 10-128 unit collision half-width, not the one shared approximation. Carried on the ref because
   * every shot-vs-body test needs it: a missile's contact distance is
   * `thing->radius + missile->radius` (`PIT_CheckThing`), so a mancubus really is three times the
   * target an imp is. See docs/combat.md § How a shot deals damage.
   */
  radius: number;
}

/**
 * The monster that walked a segment `crossLines` reports: where it now stands, plus what resolving
 * a teleport landing's telefrag needs ({@link ThingLayer.telefragAt} for every other body,
 * `game.ts` for the player half, whose obituary wants {@link CrossingBody.type}).
 * {@link PosedThing} satisfies it structurally, so the callback allocates nothing on the
 * once-per-alerted-monster, once-per-tic path it runs on.
 */
export interface CrossingBody extends Pos2 {
  id: number;
  type: number;
  blockRadius: number;
  /** Current facing, radians — what Boom's silent teleports rotate relative to. */
  angle: number;
}

/**
 * This tic's conveyor impulse for a body of this radius standing at `pos`, map units/sec, or null
 * where nothing carries it — `specials/forces.ts: Forces.carryForBody`. Named here rather than
 * spelled out at each end so {@link ThingLayer.update}'s parameter and the field `game.ts` binds
 * it to cannot drift apart. The return is structural (and not {@link Pos2}, which is a position,
 * nor `forces.ts`'s own `Vec2`) so no import edge into `specials/` forms.
 */
export type CarryQuery = (
  pos: Pos3,
  radius: number,
  cache: SectorTouchCache,
) => { readonly x: number; readonly y: number } | null;

/**
 * Live kill/item totals for the level, vanilla's own `totalkills`/`killcount` and
 * `totalitems`/`itemcount` — {@link LevelKillItemStats.totalKills}/
 * {@link LevelKillItemStats.totalItems} set once at spawn (`COUNTKILL_TYPES`/`COUNTITEM_TYPES`),
 * {@link LevelKillItemStats.kills}/{@link LevelKillItemStats.items} incremented as the level is
 * played. docs/hud.md § Level stats.
 */
export interface LevelKillItemStats {
  totalKills: number;
  kills: number;
  totalItems: number;
  items: number;
}

/** Everything about a hit except how hard it lands. Every field is optional; so is the record. */
export interface DamageHit {
  /**
   * Who dealt it, absent meaning the player. Drives the infighting retarget via `shouldRetarget`
   * (docs/monster-ai.md § Infighting).
   */
  source?: { id: number; type: number };
  /**
   * The player whose hit it was, where a player's: re-points a monster already hunting a player at
   * this one (docs/multiplayer-coop.md § Target choice).
   */
  slot?: number;
  /**
   * The arch-vile's `A_VileAttack` launch. Applied inside {@link ThingLayer.damage} because it
   * writes the same {@link PosedThing.z}/{@link PosedThing.velZ} fields gravity integration owns.
   */
  knockUpSpeed?: number;
  /**
   * The inflictor's position, driving `thrustSpeed`'s horizontal knockback. Omitted by damage
   * floors and crushers, matching vanilla's null-inflictor call (docs/movement.md § Knockback).
   */
  from?: Pos2;
}

export interface ThingLayer {
  group: THREE.Group;
  count: number;
  /**
   * `"<doomednum> (<sprite>)"` for every thing type the map places that the
   * WAD set carries no art for, so it was skipped — `game.ts` warns about these
   * at level load the way it warns about missing textures. Empty for a matched
   * IWAD/PWAD pair; the case that fills it is a PWAD placing a monster its base
   * WAD never had (a cacodemon on shareware `DOOM1.WAD`, which has no `HEAD`
   * lumps).
   */
  missingArt: readonly string[];
  /** See {@link LevelKillItemStats}'s own doc. */
  stats: LevelKillItemStats;
  /**
   * Every thing the run has moved on from — the things still exactly as the map spawned it are
   * left out, since a restore re-spawns them. docs/savegames.md § The format and its version.
   *
   * A thing's `posed` index is its ID, which is what keeps saved cross-thing references
   * ({@link PosedThing.targetId}, a projectile's `sourceId`) valid on restore. The restore half is
   * `ThingLayerOptions.restore`, not a method here: things are rebuilt through `pushThing`, which
   * only exists inside the factory. docs/savegames.md § What is saved and what is deliberately not.
   */
  snapshot(): ThingsSnapshot;
  /**
   * Releases the instanced meshes/materials this layer owns; call when the map is unloaded. Shared
   * geometry and textures belong to `SpriteMaterialCache`, which outlives a level.
   */
  dispose(): void;
  /**
   * Every living monster, still-standing barrel, and solid decoration near (x, y) as a solid body
   * the *player* walks around — all `MF_SOLID` in vanilla. Monsters get `blockersFor` instead.
   */
  solidBodies(pos: Pos2): ThingBlocker[];
  /**
   * Re-poses every thing at the camera's viewer angle and, for a living monster, ticks its AI:
   * unalerted ones re-check sight every `LOOK_INTERVAL`, alerted ones run `stepMonsterAI` every
   * frame, moving on vanilla's 8-way `P_NewChaseDir` rather than `slideMove`
   * (docs/monster-ai.md § Movement). Also ticks barrel death clocks, and returns every attack and
   * `A_Explode` due this frame for the caller to apply.
   *
   * **Advances the world only — it draws nothing.** {@link ThingLayer.draw} is the other half, and
   * runs on the render clock. docs/frameloop.md § What runs in a tic.
   *
   * @param players  every player slot's body by index, `null` where that player is dead — with
   *                 none alive every monster freezes in place; otherwise {@link PosedThing.z}
   *                 refreshes from the sector's live height, the "ride a mover" trick
   *                 (docs/movement.md § Solid decorations)
   * @param fogVisible  hides things in an unrevealed subsector
   * @param crossLines  gets each alerted monster and where it stepped from, so the caller can fire
   *                    the walk triggers in between and resolve a teleport landing's telefrag
   *                    (docs/specials-teleporters.md § Teleporters)
   * @param useLines  `P_Move`'s `spechit` pass for a monster whose step to `(tryX, tryY)` was
   *                  refused — the door it walked into, opened (`SpecialsController.useMonster`).
   *                  Same split as `crossLines`, down to returning a teleport landing for this
   *                  layer to apply. docs/monster-ai.md § Opening doors.
   * @param carry  this tic's conveyor impulse for each body — {@link CarryQuery}. A callback rather
   *               than a `Forces` reference for the same reason `crossLines` is one: this layer
   *               owns bodies, not specials. `cache` is the body's own {@link PosedThing.touch},
   *               threaded through so the query can skip its sector walk for a body that hasn't
   *               moved. **Absent means the level has no conveyor at all**
   *               (`Forces.carriesAnything`), not merely that this caller declines the query:
   *               `ThingGrid.rebuild` reads its presence as `mayCarry` and widens every still
   *               body's move bound by a tic of conveyor push on the strength of it. Passing
   *               `undefined` on a level that does carry makes the grid's cell skip unsound — a
   *               body moves further than its bound and a query silently misses it.
   *               docs/monster-ai.md § Spatial indexing.
   */
  update(
    dt: number,
    players: readonly (Pos3 | null)[],
    fogVisible?: (subsector: number) => boolean,
    crossLines?: (prev: Pos2, mover: CrossingBody) => TeleportDest | null,
    useLines?: (mover: CrossingBody, tryX: number, tryY: number) => TeleportDest | null,
    carry?: CarryQuery,
  ): ThingUpdateResult;
  /**
   * Fills the sprite batches from the state {@link ThingLayer.update} left, with every position
   * interpolated from the previous tic to the current one. Presentation only — nothing the
   * simulation reads back. docs/frameloop.md § Interpolation.
   *
   * @param alpha     how far of the way from the previous tic to the current one; 1 draws the tic
   *                  exactly
   * @param fogDrawn  whether a subsector is drawn (`FogOfWar.isDrawn`), on top of the tic's own
   *                  gate; absent draws everything the tic left visible. docs/fogofwar.md § Islands
   */
  draw(alpha: number, viewAngleDeg: number, fogDrawn?: (subsector: number) => boolean): void;
  /**
   * Consumes every not-yet-picked thing whose `blockdist` box overlaps either end of the move, that
   * is within vertical reach of `from.z` and that `consume` accepts, hiding it permanently. This
   * layer owns only which world instance disappears. Why both ends and why a box —
   * docs/items.md § Collecting things.
   *
   * @param from  where the collector stands
   * @param to  where it was headed; the same point as `from` for a collector that attempted no move
   * @param consume  what picking it up means (inventory.ts's `applyPickup`); its second argument is
   *                 the instance's {@link PosedThing.dropped} flag and its third is where it stood,
   *                 for whatever the caller marks that spot with (docs/items.md § The pickup puff)
   */
  tryPickup(
    from: Pos3,
    to: Pos2,
    blockdist: number,
    consume: (type: number, dropped: boolean, at: Pos3) => boolean,
  ): void;
  /**
   * The monster whose body this ray crosses nearest the camera, or null — auto-aim's lock-on, over
   * the `mobjinfo` box a shot collides with and never the drawn sprite. Nothing fog of war hides,
   * nothing already dead; barrels lock on too. The returned {@link MonsterRef.id} is what
   * {@link ThingLayer.damage} takes, so a shot fired this frame lands on exactly this instance
   * without re-picking. docs/combat.md § Auto-aim.
   *
   * @param aimAt  the point on the aim plane the ray was cast toward; `World.groundReach` bounds
   *               how far past it a body may still be picked
   * @param reach  that bound, where the caller has already traced it
   */
  pickMonster(ray: THREE.Ray, aimAt: Pos3, reach?: number): (MonsterRef & { dist: number }) | null;
  /**
   * Living monsters within `radius` of (x, y). Candidates for splash damage (game.ts); the caller
   * still has to check line-of-sight itself, since that needs the `World` this layer doesn't
   * otherwise touch.
   *
   * @param radius  2D — matching vanilla's own radius-attack distance test, which ignores height
   */
  monstersNear(pos: Pos2, radius: number): MonsterRef[];
  /**
   * Every living body a projectile could have struck while stepping from `from` to `to` this
   * frame. **Swept, not sampled at the endpoint**, so a point test at each end can't miss a body
   * the step passed straight through. 2D only; the caller applies the height band and line of
   * sight.
   *
   * @param reach  the missile's own radius, added to each candidate's *own* radius and the pair
   *               tested against the swept segment, so both a fat mancubus and a thin imp are hit
   *               at their real widths
   */
  monstersAlongStep(from: Pos3, to: Pos3, reach: number): MonsterRef[];
  /**
   * This exact monster's live position and type, or null if the ID is stale or it has since died.
   * Lets a shot fired at a monster keep tracking it across frames.
   */
  monsterById(id: number): MonsterRef | null;
  /**
   * The `SPRITE+LETTER` this thing was last *drawn* on ({@link SpriteAnimator.frameKey}), or '' for
   * a stale ID. Art, not simulation — deliberately off {@link MonsterRef} so no tic can read a pose
   * by accident (CLAUDE.md § A WAD's art never decides what a tic does). The regression tests that
   * assert a pose are its readers: the animator asks its bank nothing while a frame holds, so a
   * recording bank sees a pose change rather than the pose each draw stands in
   * (docs/sprites.md § Batching).
   */
  drawnFrameKey(id: number): string;
  /**
   * Whether a shot landing on this thing splashes blood — vanilla's `MF_NOBLOOD`, which in all of
   * stock DOOM exactly one thing carries (`MT_BARREL`; `PTR_ShootTraverse` spawns a puff there
   * instead). Keyed by ID and deliberately blind to whether the thing is already dead, so the
   * killing blow still bleeds no matter which side of {@link ThingLayer.damage} the caller asks
   * from. See docs/combat.md § Blood.
   */
  bleeds(id: number): boolean;
  /**
   * Count of living monsters currently alerted (chasing/attacking, or mid-reaction-delay) — for the
   * debug HUD.
   */
  awakeMonsterCount(): number;
  /**
   * Where the alerted monsters {@link ThingLayer.awakeMonsterCount} counts are standing and how
   * tall each is, narrowed to those actually being rendered — each is an extra occlusion-fade
   * sightline target alongside the player, and the fade aims at the whole body, so its own height
   * comes with it (docs/render-occlusion.md § The target is the billboard). Excluding the unalerted
   * and the fog-hidden is load-bearing (docs/render-occlusion.md). **Must be called after
   * {@link ThingLayer.update} has run**, so {@link PosedThing.visible} reflects this frame's fog.
   */
  awakeMonsters(): StandingBody[];
  /**
   * Living monsters standing in one of `sectors` — a reference-equality check against the same
   * mutable {@link Sector} objects {@link PosedThing.sector} was seeded from (see that field's
   * doc), not a sector-index lookup this layer has no way to perform on its own. Backs the two
   * obstruction checks every non-crushing mover uses to stop rather than clip through a monster
   * (`game/specials/moverblocking.ts`), which ask for the moving sector *and its neighbors* — a
   * body's centre can stand next door while its box reaches into the mover.
   * docs/specials-movers.md § Every other mover stops instead.
   */
  monstersInSectors(sectors: ReadonlySet<Sector>): MonsterRef[];
  /**
   * {@link ThingLayer.monstersInSectors} plus any still-standing barrel. Crush damage
   * (`specials/moverblocking.ts: applyCrushDamage`) is the only user; whether a barrel should also
   * stall a closing door is a separate question. docs/specials-crushers.md § Crushers.
   */
  crushablesInSectors(sectors: ReadonlySet<Sector>): MonsterRef[];
  /**
   * The monster corpses lying in `sectors` that no plane has crunched yet, over the same sector set
   * {@link ThingLayer.crushablesInSectors} takes. docs/specials-crushers.md § Crushed corpses.
   *
   * @returns each body with {@link MonsterRef.height} its living `mobjinfo.height`; a corpse's own
   *          is a quarter of it (`CORPSE_HEIGHT_FRACTION`)
   */
  corpsesInSectors(sectors: ReadonlySet<Sector>): MonsterRef[];
  /**
   * Crunches the corpse `id` to a pool of blood — `PIT_ChangeSector`'s `S_GIBS` branch. A no-op on
   * a stale or already-crunched id, and on a WAD set carrying no `CORPSE_GIB` art, which
   * would leave the corpse drawing nothing at all. docs/specials-crushers.md § Crushed corpses.
   */
  crushCorpse(id: number): void;
  /**
   * Applies `amount` damage to `id`, switching to the death animation at 0 — gibbed or plain per
   * `P_KillMobj`'s overkill rule (docs/death.md § Monster death). A no-op if `id` is stale, already
   * dead, or the amount is non-positive: a projectile can outlive its target, and splash falloff
   * reaches 0 at the blast edge.
   *
   * A barrel takes this same call but follows none of it except the knockback:
   * no pain state, no retarget, and death switches its sprite to `BEXP`.
   *
   * @param hit  everything beyond the amount, {@link DamageHit}'s business; omitted, the
   *             unattributed, unpositioned call damage floors and crushers make
   */
  damage(id: number, amount: number, hit?: DamageHit): void;
  /**
   * `P_TeleportMove`'s stomp for a body arriving at `at` with `radius`: every overlapping shootable
   * thing takes {@link TELEFRAG_DAMAGE} with no {@link DamageHit.source}, so a solid decoration
   * passes straight through. Only the *thing* half happens here: this layer holds no player
   * reference, so the caller tests the player against the same reach itself. 2D and height-blind,
   * matching `PIT_StompThing`. docs/death.md § Telefrag.
   *
   * @param stomps  false ends the call at the first body in the way, damaging nothing
   * @param arriving  the arriving body as a target ID ({@link targetOfSlot} for a player): one of
   *                  this layer's own can't stomp itself, and a player's stomp counts as its kills
   * @returns whether the arrival may go ahead — false is the caller's cue to refuse the teleport
   *          outright
   */
  telefragAt(at: Pos2, radius: number, stomps: boolean, arriving?: number): boolean;
  /**
   * Creates a fresh, already-awake monster of `type` at `at` and telefrags whatever was standing
   * there ({@link TELEFRAG_DAMAGE} to every overlapping body). Vanilla's `A_SpawnFly` tail; the
   * Icon of Sin's spawn cube (`game/monsters/iconofsin.ts`) is the only caller.
   *
   * Only the *monster* half of the telefrag happens here: this layer has no player reference, so
   * the caller tests the returned position against the player itself.
   * docs/monster-iconofsin.md § The spawn cube.
   *
   * @returns the monster, or null if the WAD carries no art for that doomednum
   */
  spawnMonster(type: number, at: Pos3, angleRad: number): MonsterRef | null;
  /**
   * Nearest living monster the ray crosses within `maxDist`, or null — the "didn't click anything,
   * but something's in the path anyway" case for a free shot. Tested against each body's own
   * {@link MonsterRef.radius} and {@link MonsterRef.height}, as a slope span at that body's
   * distance rather than a flat height band (docs/combat.md § The vertical test).
   *
   * @param opts  `slope` is the trace's own fixed slope, `PTR_ShootTraverse`'s `aimslope`; omitting
   *              it takes `P_AimLineAttack`'s ±{@link AIM_SLOPE_LIMIT} cone. The rest serves a
   *              *monster's* own hitscan: `ignoreId` excludes the shooter, and `includeHidden`
   *              skips the fog-of-war filter, since two monsters fighting in a room the player
   *              hasn't seen must still connect.
   */
  raycastMonster(
    origin: Pos3,
    angleRad: number,
    maxDist: number,
    opts?: { ignoreId?: number; includeHidden?: boolean; slope?: number },
  ): (MonsterRef & { dist: number }) | null;
}

/**
 * The vertical half-angle `P_AimLineAttack` searches, as a slope: its
 * `topslope = 100*FRACUNIT/160` and `bottomslope = -100*FRACUNIT/160` (`p_map.c`).
 * {@link ThingLayer.raycastMonster} takes it as the default span a body's own slope range has to
 * overlap — see docs/combat.md § The vertical test.
 */
export const AIM_SLOPE_LIMIT = 100 / 160;

/**
 * The two types whose sight and death sounds vanilla plays **unattenuated**,
 * from nowhere in particular (`A_Look`/`A_Scream`'s own
 * `if (actor->type==MT_SPIDER || actor->type == MT_CYBORG) S_StartSound(NULL, …)`)
 * — you hear a cyberdemon wake up anywhere on the map. Nothing else about their
 * sounds is special: their pain, footsteps and shots all attenuate normally.
 */
export const BOSS_TYPES: Set<number> = new Set([ThingType.spiderMastermind, ThingType.cyberdemon]);

/**
 * Every type whose death can drive level logic, and so the set `damageThing`'s death branch checks
 * before it's worth scanning `posed` for "any others of this type still alive" at all. Distinct
 * from {@link BOSS_TYPES} above, which is only about unattenuated sound. Commander Keen (72) and
 * the boss brain (88) are here rather than in {@link BOSS_DEATH_TYPES} —
 * docs/death.md § Boss death.
 */
export const DEATH_NOTIFY_TYPES: Set<number> = new Set([
  ...Object.values(BOSS_DEATH_TYPES),
  ThingType.commanderKeen,
  ThingType.bossBrain,
]);

/**
 * `ITEMQUESIZE` (`p_local.h`): how many taken items a deathmatch remembers to put back —
 * `P_RemoveMobj`'s ring, which drops its oldest entry when full.
 * docs/multiplayer-deathmatch.md § Item respawn.
 */
export const ITEM_RESPAWN_QUEUE = 128;

/**
 * `P_RespawnSpecials`' `if (leveltime - itemrespawntime[iquetail] < 30*35) return;` (`p_mobj.c`):
 * the tics a taken item lies gone before it comes back.
 */
export const ITEM_RESPAWN_TICS = 30 * 35;

/**
 * Vanilla's own `P_TeleportMove` telefrag damage — the literal `10000` it deals to everything
 * standing where a body lands: a teleporter arrival ({@link ThingLayer.telefragAt}) or the Icon of
 * Sin's spawn cube ({@link ThingLayer.spawnMonster}). See docs/death.md § Telefrag.
 */
export const TELEFRAG_DAMAGE = 10000;

/**
 * Whether a body arriving at `at` overlaps the one of `reach` at `body` — the summed-radii box
 * `PIT_StompThing` and `PIT_CheckThing` share, and the shape every body-vs-body test in this
 * engine uses (docs/movement.md § Collision). A box and not a circle: it misses only when
 * `abs(dx) >= reach || abs(dy) >= reach`, so the corners reach furthest. Shared so both halves of
 * a landing, the things and the player, agree on where the pad reaches (docs/death.md § Telefrag),
 * and so a pickup's reach is the same box (docs/items.md § Collecting things).
 */
export function bodiesOverlap(at: Pos2, body: Pos2, reach: number): boolean {
  return Math.abs(body.x - at.x) < reach && Math.abs(body.y - at.y) < reach;
}

/**
 * `PIT_StompThing`'s `gamemap != 30`: a *monster* arriving on a teleport pad only stomps what is
 * standing on it on map 30 — anywhere else the body in the way blocks its teleport instead. The
 * player is never gated this way. Vanilla reads the raw map number whichever game is running, but
 * `wad.ts`'s own `MAP_MARKER` only ever admits `MAPnn` and `ExMy`, so no episodic name can reach
 * 30. See docs/death.md § Telefrag.
 */
export function monstersTelefrag(mapName: string): boolean {
  return mapName === 'MAP30';
}

/**
 * Vanilla's own hard cap on how many lost souls can exist on a level at once — `A_PainShootSkull`'s
 * "count > 20" guard.
 */
export const MAX_SKULLS_ON_LEVEL = 20;

/**
 * Health a barrel spawns with — `MT_BARREL`'s `spawnhealth`, and the first of the four `BARREL_*`
 * stats. A barrel has no AI at all: `MONSTER_STATS` has no entry for it, so it never enters the
 * `if (stats && player)` branch in {@link ThingLayer.update}, and these four stand in for the
 * stats that branch would otherwise have read. It is a plain solid, shootable prop that deals
 * splash damage on death.
 */
export const BARREL_HEALTH = 20;
/**
 * Vanilla `MT_BARREL`'s own `radius` (10 map units) — real and much smaller
 * than `MONSTER_HIT_RADIUS`, the approximate fallback used for a type with no
 * `MONSTER_STATS` entry, which a barrel otherwise is.
 */
export const BARREL_RADIUS = 10;
/**
 * Vanilla `MT_BARREL`'s own `height` (42), shorter than anything else that can
 * be crushed — a descending ceiling reaches a monster well before it reaches a
 * barrel standing beside it.
 */
export const BARREL_HEIGHT = 42;
/**
 * Vanilla `MT_BARREL`'s own `mass` — confirmed against `linuxdoom-1.10/info.c`, feeds
 * `thrustSpeed`.
 */
export const BARREL_MASS = 100;
/**
 * `MT_BARREL`'s frame chains, **walked out of vanilla's own state table** rather than transcribed
 * (docs/dehacked.md § Frames) — one mutable record because a DEHACKED patch re-derives them from
 * the barrel's patched states, and `dehacked/apply.ts` snapshots and restores it like any other
 * table.
 *
 * - {@link BARREL_CHAIN.idleFrames}: `S_BAR1`/`S_BAR2`, a two-frame sway each held 6 tics.
 * - {@link BARREL_CHAIN.deathSprite}: a barrel's death art is a genuinely different sprite lump
 *   from its own idle art (`BEXP`, not `BAR1`) — unlike every stock monster, whose death states
 *   reuse the same sprite name. {@link SpriteAnimator.die}'s optional third argument exists for
 *   this.
 * - {@link BARREL_CHAIN.deathFrames}: `S_BEXP1`-`S_BEXP5`.
 * - {@link BARREL_CHAIN.deathFrameSeconds}: a flat per-frame rate standing in for vanilla's own
 *   uneven per-state tics (5, 5, 5, 10, 10) — the same "one uniform rate" simplification
 *   `MONSTER_DEATH_FRAME_SECONDS` makes elsewhere, matching the real rate of the first three
 *   frames. Not derived from a patch.
 * - {@link BARREL_CHAIN.explodeDelaySeconds}: vanilla's `A_Explode` sits on `S_BEXP4` — `info.c`
 *   and the walker in `dehacked/frames.ts` agree on the fourth state — so the blast comes
 *   `S_BEXP1`-`3`'s 5 + 5 + 5 tics after the barrel actually died, not instantly on death.
 */
export const BARREL_CHAIN = {
  ...barrelFromStates(),
  // The one field the walker does not derive: a flat rate, per the bullet above.
  deathFrameSeconds: 5 * DOOM_TIC,
};

/** `MT_BARREL`'s derived chains, off vanilla's own state table. */
function barrelFromStates(): {
  idleFrames: string[];
  idleFrameSeconds: number;
  deathSprite: string;
  deathFrames: string[];
  explodeDelaySeconds: number;
} {
  const barrel = pristineFrameTables().barrel!;
  return {
    idleFrames: barrel.idleFrames,
    idleFrameSeconds: barrel.idleFrameSeconds,
    deathSprite: barrel.deathSprite!,
    deathFrames: barrel.deathFrames,
    explodeDelaySeconds: barrel.explodeDelaySeconds!,
  };
}

/**
 * A barrel's `A_Explode` becoming due ({@link BARREL_CHAIN.explodeDelaySeconds} after it died, not
 * on death itself), for `game.ts` to turn into `applyRadiusDamage`. {@link BarrelExplosion.source},
 * when set, is who dealt the killing blow, and {@link BarrelExplosion.slot} the player who did —
 * see {@link PosedThing.explodeSource}'s doc for why this is what makes a chain of barrels
 * attribute correctly all the way back to whoever set the first one off.
 */
export interface BarrelExplosion extends Pos3 {
  source?: { id: number; type: number };
  slot?: number;
}

/** {@link ThingLayer.update}'s return value — see that method's doc. */
export interface ThingUpdateResult {
  attacks: MonsterAttackEvent[];
  barrelExplosions: BarrelExplosion[];
}

/**
 * The native-size multiplier `type` draws at — its {@link PICKUP_SCALE} entry, or 1 for a type the
 * table doesn't list (docs/sprites.md § Pickup scale says why it is a whitelist).
 *
 * @param type the thing's doomednum
 * @returns the factor {@link PosedThing.scale} carries
 */
export function pickupScaleFor(type: number): number {
  return PICKUP_SCALE[type] ?? 1;
}
