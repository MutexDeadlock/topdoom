/**
 * The thing layer's record shapes and the constants tied to them: one live map
 * thing (`PosedThing`), the layer's public surface (`ThingLayer`), and the
 * handful of doomednums/tables that only this layer's own logic reads.
 *
 * Distinct from `things/tables.ts`, which holds the *WAD-derived* tables
 * every thing type is looked up in (sprites, health, drops, frame letters);
 * this file is runtime state and the API around it, the same division
 * `monsters/defs.ts` makes for the AI. See docs/items.md and docs/monster-ai.md.
 */
import * as THREE from 'three';
import type { Sector } from '../../wad/map.ts';
import { BOSS_DEATH_TYPES } from './tables.ts';
import { pristineFrameTables } from '../dehacked/frames.ts';
import { ThingType } from './doomednums.ts';
import type { MonsterAttackEvent, MonsterBody } from '../monsters/defs.ts';
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
   * Each frame's `info.c` tic count, parallel to `frames`. Zero-tic states are dropped: they never
   * draw.
   */
  tics: number[];
}
import { DOOM_TIC, PICKUP_SCALE, PICKUP_SCALE_TYPES } from '../../constants.ts';

/**
 * One live map thing. Extends `MonsterBody` (`monsters/defs.ts`) rather than
 * re-declaring its chase/attack fields: `stepMonsterAI` is handed a
 * `PosedThing` directly, so the two must agree, and inheriting says so where
 * a copied field list only hoped so. Every one of those fields is present and
 * inert on a non-monster thing — see `pushThing`'s zeroed defaults.
 */
export interface PosedThing extends Pos3, MonsterBody {
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
   * Collision radius, resolved once at spawn — a per-query `MONSTER_STATS[type]` is a sparse-key
   * dictionary hash, measured hotter than the collision arithmetic it fed (docs/monster-ai.md
   * § Spatial indexing).
   */
  blockRadius: number;
  /**
   * This body's own `mobjinfo.height`, resolved once at spawn exactly as
   * `blockRadius` is. Every vertical fit test that knows which body it means
   * reads it: whether a crusher has closed far enough to catch this thing,
   * whether it fits through an opening, and how tall a target a shot sees.
   */
  bodyHeight: number;
  /**
   * This type's attack poses per kind (`MONSTER_ATTACK_POSE`) and pain frame letters, resolved once
   * at spawn for the same reason `blockRadius` is. `undefined` for anything without a table entry.
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
   * Feet height (`Pos3.z`). While not an alerted monster: refreshed each frame from
   * `sector.floorHeight` (the "ride a moving floor for free" trick). Once alerted,
   * `stepMonsterAI` owns it via `groundFloor` + gravity, the same physics the player uses.
   */
  z: number;
  /**
   * Its containing sector — the live reference `z` is read from while
   * not an alerted monster; reassigned each frame by `update()` once a monster starts moving.
   */
  sector: Sector | undefined;
  facingDeg: number;
  /**
   * Where this thing came into the world and facing which way — vanilla's `mobj->spawnpoint`,
   * read only by nightmare respawning. Set once by `pushThing`, so for anything that never moved
   * it equals `x`/`y`/`facingDeg` — the condition `snapshotThings` elides it on.
   * docs/monster-ai.md § Respawning monsters.
   */
  spawnX: number;
  spawnY: number;
  spawnAngle: number;
  subsector: number;
  type: number;
  /**
   * Set once a pickup consumes this instance; it then stays permanently hidden (see
   * ThingLayer.update).
   */
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
  /**
   * Frame count of whichever death animation (`MONSTER_DEATH_FRAMES` or the gibbed
   * `MONSTER_XDEATH_FRAMES`) `ThingLayer.damage` actually played — set at time of death, read back
   * by `deadTime`'s "still settling" check above. 0 for anything that never died with real death
   * art (see `damage`'s `hidden` fallback).
   */
  deathFrameCount: number;
  /**
   * Set once a moving plane has crunched this corpse to giblets — `PIT_ChangeSector`'s
   * `P_SetMobjState(thing, S_GIBS)`. Read by `enterDeathPose`, which is what makes the pool the
   * pose a restored save comes back holding. docs/specials.md § Crushed corpses.
   */
  crushed: boolean;
  /**
   * This type's resurrection frames (`MONSTER_RAISE_FRAMES`), resolved once
   * at spawn for the same reason `attackPose`/`painFrames` are — and
   * doubles as the arch-vile's own eligibility test: `undefined` means this
   * type has no vanilla `raisestate` and `findRaisableCorpse` skips it
   * outright, matching vanilla's `raisestate == S_NULL` check.
   */
  raiseFrames: string[] | undefined;
  /**
   * Set once a dead barrel's own `A_Explode` has actually fired
   * (`BARREL_CHAIN.explodeDelaySeconds` after death, not on death itself — see
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
   * True for an item `ThingLayer.damage` spawned itself (`MONSTER_DROPS`) rather than one the map
   * placed — threaded through to `applyPickup`'s own `dropped` param, which halves the ammo it
   * grants.
   */
  dropped: boolean;

  // Monster AI. Everything `MonsterBody` declares is inherited above and inert for a non-monster;
  // these four are the layer's own, which `game/monsters/ai.ts` has no business knowing about.
  /**
   * True once this monster has spotted the player and started chasing (`update`'s throttled wake
   * check, LOOK_INTERVAL).
   */
  alerted: boolean;
  /**
   * The map thing's "ambush"/deaf flag (`game/skill.ts: isAmbush`) .
   * Gates whether a sound-alerted sector alone can wake this monster; see `update`'s wake check.
   */
  ambush: boolean;
  /**
   * Seconds since this monster's last idle look-around. Separate from the AI
   * timers in `MonsterBody` because it only ticks *before* the monster wakes,
   * and `game/monsters/ai.ts` has no business knowing the throttle exists.
   */
  lookTimer: number;
  /**
   * Position at the end of the previous tic, so `crossLines` can test the
   * segment this monster just walked. Mutated in place; never re-allocated.
   * Maintained only on the alerted-with-a-target path, which is the only one
   * that can walk over a line — **not** an interpolation source, which is what
   * `drawPrevX`/`Y`/`Z` are for.
   */
  prev: Pos2;
  /**
   * Where this thing was at the end of the previous tic, for the render layer to
   * interpolate from. Unlike `prev` this is written for *every* thing on *every*
   * tic, since knockback, corpse gravity and a ceiling-hung prop riding a closing
   * door all move a thing that never runs the AI path.
   * docs/frameloop.md § Interpolation.
   */
  drawPrevX: number;
  drawPrevY: number;
  drawPrevZ: number;
  /**
   * Who this monster is currently hunting: `null` for the player, otherwise
   * another `PosedThing`'s ID. Set by `damage` when something hurts it (see
   * `shouldRetarget`) — the mechanism behind infighting — and reset to the
   * player once that target dies.
   */
  targetId: number | null;
}

/**
 * Where a body stands and how tall it is — `z` its feet, `height` its own
 * `mobjinfo.height` (`PosedThing.bodyHeight`), the real per-species 56-110 unit
 * figure rather than one shared band. The least a caller can be handed and still
 * reason about the *whole* of a body rather than a point in it, which is what an
 * occlusion sightline needs (docs/render.md § The target is the billboard) and
 * what `MonsterRef` builds its identity on top of.
 */
export interface StandingBody extends Pos3 {
  height: number;
}

/**
 * One monster as the rest of the engine sees it: the stable `id`
 * `ThingLayer.damage` takes, live position and height, doomednum (for the
 * species checks), and current facing — which `game.ts`'s arch-vile flame
 * tracking needs, since `A_Fire` keys off the *target's* facing.
 */
export interface MonsterRef extends StandingBody {
  id: number;
  type: number;
  angle: number;
  /**
   * This body's own `mobjinfo.radius` (`PosedThing.blockRadius`) — the real
   * per-species 10-128 unit collision half-width, not the one shared
   * approximation. Carried on the ref because every shot-vs-body test needs it:
   * a missile's contact distance is `thing->radius + missile->radius`
   * (`PIT_CheckThing`), so a mancubus really is three times the target an imp
   * is. See docs/combat.md § How a shot deals damage.
   */
  radius: number;
}

/**
 * The monster that walked a segment `crossLines` reports: where it now stands, plus what resolving
 * a teleport landing's telefrag needs (`ThingLayer.telefragAt` for every other body, `game.ts` for
 * the player half, whose obituary wants `type`). `PosedThing` satisfies it structurally, so the
 * callback allocates nothing on the once-per-alerted-monster, once-per-tic path it runs on.
 */
export interface CrossingBody extends Pos2 {
  id: number;
  type: number;
  blockRadius: number;
  /** Current facing, radians — what Boom's silent teleports rotate relative to. */
  angle: number;
}

/**
 * Live kill/item totals for the level, vanilla's own `totalkills`/`killcount` and
 * `totalitems`/`itemcount` — `total*` set once at spawn (`COUNTKILL_TYPES`/`COUNTITEM_TYPES`),
 * `kills`/`items` incremented as the level is played. docs/hud.md § Level stats.
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
   * The arch-vile's `A_VileAttack` launch. Applied inside `damage` because it writes the same
   * `z`/`velZ` fields gravity integration owns.
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
  /** See `LevelKillItemStats`'s own doc. */
  stats: LevelKillItemStats;
  /**
   * Every live thing's mutable state in `posed` order for a savegame — the
   * array index is the ID, which is what keeps saved cross-thing references
   * (`targetId`, a projectile's `sourceId`) valid on restore. The restore half
   * is `ThingLayerOptions.restore`, not a method here: things are rebuilt through `pushThing`,
   * which only exists inside the factory.
   * docs/savegames.md § What is saved and what is deliberately not.
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
   * Re-poses every thing at the camera's viewer angle and, for a living
   * monster, ticks its AI: unalerted ones re-check sight every
   * `LOOK_INTERVAL`, alerted ones run `stepMonsterAI` every frame. Gravity and
   * `groundFloor` mirror `Player.update`, but movement is vanilla's 8-way
   * `P_NewChaseDir` rather than `slideMove` (docs/monster-ai.md § Movement).
   * Returns every attack fired this frame for the caller to apply.
   *
   * `player` is `null` while the player is dead, freezing every monster in
   * place without touching pose/animation/fog-visibility. For anything else,
   * `z` refreshes from the sector's live `floorHeight` — the "ride a moving
   * floor for free" trick, so a corpse left on a lift still rides it.
   *
   * `fogVisible` hides things in an unrevealed subsector, which would
   * otherwise spoil a secret room whose geometry is faded out. `crossLines`
   * gets each alerted monster and where it stepped from, so the caller can
   * fire the walk triggers in between and resolve a teleport landing's
   * telefrag (docs/specials.md § Teleporters). Also ticks barrel death clocks
   * and reports any `A_Explode` due this frame.
   *
   * **Advances the world only — it draws nothing.** `draw` is the other half,
   * and runs on the render clock. docs/frameloop.md § What runs in a tic.
   */
  update(
    dt: number,
    player: Pos3 | null,
    fogVisible?: (subsector: number) => boolean,
    crossLines?: (prev: Pos2, mover: CrossingBody) => TeleportDest | null,
    /**
     * `P_Move`'s `spechit` pass for a monster whose step to `(tryX, tryY)` was refused — the door
     * it walked into, opened (`SpecialsController.useMonster`). Same split as `crossLines`, down
     * to returning a teleport landing for this layer to apply.
     * docs/monster-ai.md § Opening doors.
     */
    useLines?: (mover: CrossingBody, tryX: number, tryY: number) => TeleportDest | null,
    /**
     * This tic's conveyor impulse for a body of this radius standing at `pos`,
     * map units/sec, or null where nothing carries it — `specials/forces.ts:
     * Forces.carryForBody`. A callback rather than a `Forces` reference for the
     * same reason `crossLines` is one: this layer owns bodies, not specials.
     * The return is structural (and not `Pos2`, which is a position) so no
     * import edge into `specials/` forms. `cache` is the body's own
     * `PosedThing.touch`, threaded through so the query can skip its sector
     * walk for a body that hasn't moved.
     */
    carry?: (
      pos: Pos3,
      radius: number,
      cache: SectorTouchCache,
    ) => { readonly x: number; readonly y: number } | null,
  ): ThingUpdateResult;
  /**
   * Fills the sprite batches from the state `update` left, with every position
   * interpolated `alpha` of the way from the previous tic to the current one
   * (`alpha` 1 draws the tic exactly). Presentation only — nothing the
   * simulation reads back. docs/frameloop.md § Interpolation.
   */
  draw(alpha: number, viewAngleDeg: number): void;
  /**
   * Consumes every not-yet-picked thing whose `blockdist` box overlaps either end of the move —
   * `from`, where the collector stands, and `to`, where it was headed — that is within vertical
   * reach of `from.z` and that `consume` accepts, hiding it permanently. Pass the same point twice
   * for a collector that attempted no move. This layer owns only which world instance disappears;
   * `consume` (inventory.ts's `applyPickup`) owns what picking it up means, and its second argument
   * is the instance's `dropped` flag. Why both ends and why a box — docs/items.md § Collecting
   * things.
   */
  tryPickup(
    from: Pos3,
    to: Pos2,
    blockdist: number,
    consume: (type: number, dropped: boolean) => boolean,
  ): void;
  /**
   * The visible monster whose billboard this ray crosses nearest the camera,
   * or null — auto-aim's lock-on (docs/combat.md § Auto-aim). Nothing fog of
   * war hides, nothing already dead. The returned `id` is what `damage` takes,
   * so a shot fired this frame can land on exactly this instance later without
   * re-picking. Barrels are lockable too: `P_AimLineAttack` knows only
   * `MF_SHOOTABLE`, not "monster".
   *
   * `viewerAngleDeg` is the yaw the billboards stand at, and must be the
   * **tic-exact** one (`TopDownCamera.viewerAngleDeg`): tested analytically
   * against this layer's own state, so nothing here reads the render batch and
   * the tic no longer has to re-pose it. docs/frameloop.md § Posing for the
   * aim ray.
   */
  pickMonster(ray: THREE.Ray, viewerAngleDeg: number): MonsterRef | null;
  /**
   * Living monsters within `radius` (2D — matching vanilla's own radius-attack
   * distance test, which ignores height) of (x, y). Candidates for splash
   * damage (game.ts); the caller still has to check line-of-sight itself,
   * since that needs the `World` this layer doesn't otherwise touch.
   */
  monstersNear(pos: Pos2, radius: number): MonsterRef[];
  /**
   * Every living body a projectile could have struck while stepping from
   * `from` to `to` this frame: `reach` (the missile's own radius) is added to
   * each candidate's *own* radius and the pair tested against the swept
   * segment, so both a fat mancubus and a thin imp are hit at their real
   * widths. **Swept, not sampled at the endpoint**, so a point test at each end
   * can't miss a body the step passed straight through.
   * 2D only; the caller applies the height band and line of sight.
   */
  monstersAlongStep(from: Pos3, to: Pos3, reach: number): MonsterRef[];
  /**
   * This exact monster's live position and type, or null if the ID is stale or it has since died.
   * Lets a shot fired at a monster keep tracking it across frames.
   */
  monsterById(id: number): MonsterRef | null;
  /**
   * Whether a shot landing on this thing splashes blood — vanilla's
   * `MF_NOBLOOD`, which in all of stock DOOM exactly one thing carries
   * (`MT_BARREL`; `PTR_ShootTraverse` spawns a puff there instead). Keyed by
   * ID and deliberately blind to whether the thing is already dead, so the
   * killing blow still bleeds no matter which side of `damage` the caller
   * asks from. See docs/combat.md § Blood.
   */
  bleeds(id: number): boolean;
  /**
   * Count of living monsters currently alerted (chasing/attacking, or mid-reaction-delay) — for the
   * debug HUD.
   */
  awakeMonsterCount(): number;
  /**
   * Where the alerted monsters `awakeMonsterCount` counts are standing and how
   * tall each is, narrowed to those actually being rendered — each is an extra
   * occlusion-fade sightline target alongside the player, and the fade aims at
   * the whole body, so its own height comes with it (docs/render.md § The target
   * is the billboard). Excluding the unalerted and the fog-hidden is
   * load-bearing (docs/render.md § Wall occlusion fading). **Must be called
   * after `update` has run**, so `visible` reflects this frame's fog.
   */
  awakeMonsters(): StandingBody[];
  /**
   * Living monsters standing in exactly `sector` — a reference-equality check
   * against the same mutable `Sector` object `PosedThing.sector` was seeded
   * from (see that field's doc), not a sector-index lookup this layer has no
   * way to perform on its own. Backs crush damage
   * (`specials/moverblocking.ts: applyCrushDamage`) and the headroom-blocked check every
   * non-crushing mover uses to stop rather than clip through a monster
   * (`game/specials/moverblocking.ts`'s `headroomBlocked`) — either way, a mover only knows which
   * sector it's squeezing, not who's standing in it.
   */
  monstersInSector(sector: Sector): MonsterRef[];
  /**
   * `monstersInSector` plus any still-standing barrel, over a *set* of sectors. Crush damage
   * (`specials/moverblocking.ts: applyCrushDamage`) is the only user, and asks for the crushing
   * sector *and its neighbors* in one pass; the headroom-blocked check other movers use
   * deliberately stays on `monstersInSector` alone. docs/specials.md § Crushers.
   */
  crushablesInSectors(sectors: ReadonlySet<Sector>): MonsterRef[];
  /**
   * The monster corpses lying in `sectors` that no plane has crunched yet, over the same sector
   * set `crushablesInSectors` takes. `height` is each body's living `mobjinfo.height`; a corpse's
   * own is a quarter of it (`CORPSE_HEIGHT_FRACTION`). docs/specials.md § Crushed corpses.
   */
  corpsesInSectors(sectors: ReadonlySet<Sector>): MonsterRef[];
  /**
   * Crunches the corpse `id` to a pool of blood — `PIT_ChangeSector`'s `S_GIBS` branch. A no-op on
   * a stale or already-crunched id, and on a WAD set carrying no `CORPSE_GIB_SPRITE` art, which
   * would leave the corpse drawing nothing at all. docs/specials.md § Crushed corpses.
   */
  crushCorpse(id: number): void;
  /**
   * Applies `amount` damage to `id`, switching to the death animation at 0 —
   * gibbed or plain per `P_KillMobj`'s overkill rule (docs/death.md § Monster
   * death). A no-op if `id` is stale, already dead, or the amount is
   * non-positive: a projectile can outlive its target, and splash falloff
   * reaches 0 at the blast edge.
   *
   * Everything beyond the amount is `DamageHit`'s business; an omitted `hit` is the unattributed,
   * unpositioned call damage floors and crushers make.
   *
   * A barrel takes this same call but follows none of it except the knockback:
   * no pain state, no retarget, and death switches its sprite to `BEXP`.
   */
  damage(id: number, amount: number, hit?: DamageHit): void;
  /**
   * `P_TeleportMove`'s stomp for a body arriving at `at` with `radius`: every overlapping
   * shootable thing — a monster or a barrel, vanilla's `MF_SHOOTABLE`, so a solid decoration is
   * passed straight through — takes `TELEFRAG_DAMAGE`, unattributed. Returns whether the arrival
   * may go ahead.
   *
   * `stomps` is `PIT_StompThing`'s own `!tmthing->player && gamemap != 30`: the player always
   * stomps, a monster only on MAP30 (`monstersTelefrag`). When it is false the first body in the
   * way ends the call — nothing is damaged and `false` comes back, which is the caller's cue to
   * refuse the teleport outright, exactly as `EV_Teleport` does on a failed `P_TeleportMove`.
   * `moverId` is the arriving body when it is one of this layer's own, so it can't stomp itself.
   *
   * Only the *thing* half happens here: this layer holds no player reference, so the caller tests
   * the player against the same reach itself. 2D and height-blind, matching `PIT_StompThing`,
   * which never looks at `z`. docs/death.md § Telefrag.
   */
  telefragAt(at: Pos2, radius: number, stomps: boolean, moverId?: number): boolean;
  /**
   * Creates a fresh, already-awake monster of `type` at `at` and telefrags
   * whatever was standing there (`TELEFRAG_DAMAGE` to every overlapping body),
   * returning it — or null if the WAD carries no art for that doomednum.
   * Vanilla's `A_SpawnFly` tail; the Icon of Sin's spawn cube (`game/monsters/iconofsin.ts`)
   * is the only caller.
   *
   * Only the *monster* half of the telefrag happens here: this layer has no player reference, so
   * the caller tests the returned position against the player itself. docs/monster-iconofsin.md §
   * The spawn cube.
   */
  spawnMonster(type: number, at: Pos3, angleRad: number): MonsterRef | null;
  /**
   * Nearest living monster the ray crosses within `maxDist`, or null — the
   * "didn't click anything, but something's in the path anyway" case for a
   * free shot. Tested laterally against each body's **own** `MonsterRef.radius`
   * and vertically against its own `MonsterRef.height`, as a slope span at that
   * body's distance rather than a flat height band — docs/combat.md
   * § The vertical test.
   *
   * `opts.slope` is the trace's own fixed slope, `PTR_ShootTraverse`'s
   * `aimslope`; omitting it takes `P_AimLineAttack`'s `±AIM_SLOPE_LIMIT` cone,
   * which is what every caller that would run an aim in vanilla wants.
   *
   * The rest of `opts` serves a *monster's* own hitscan: `ignoreId` excludes the
   * shooter from its own trace, `includeHidden` skips the fog-of-war filter,
   * since fog is a player-facing conceit — two monsters fighting in a room the
   * player hasn't seen must still connect.
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
 * `topslope = 100*FRACUNIT/160` and `bottomslope = -100*FRACUNIT/160`
 * (`p_map.c`). `raycastMonster` takes it as the default span a body's own
 * slope range has to overlap — see docs/combat.md § The vertical test.
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
 * from `BOSS_TYPES` above, which is only about unattenuated sound. Commander Keen (72) and the boss
 * brain (88) are here rather than in `BOSS_DEATH_TYPES` — docs/death.md § Boss death.
 */
export const DEATH_NOTIFY_TYPES: Set<number> = new Set([
  ...Object.values(BOSS_DEATH_TYPES),
  ThingType.commanderKeen,
  ThingType.bossBrain,
]);

/**
 * Vanilla's own `P_TeleportMove` telefrag damage — the literal `10000` it deals to everything
 * standing where a body lands: a teleporter arrival (`telefragAt`) or the Icon of Sin's spawn cube
 * (`spawnMonster`). See docs/death.md § Telefrag.
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
 * `if (stats && player)` branch in `update()`, and these four stand in for the stats that branch
 * would otherwise have read. It is a plain solid, shootable prop that deals splash damage on death.
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
 * - `idleFrames`: `S_BAR1`/`S_BAR2`, a two-frame sway each held 6 tics.
 * - `deathSprite`: a barrel's death art is a genuinely different sprite lump from its own idle
 *   art (`BEXP`, not `BAR1`) — unlike every stock monster, whose death states reuse the same
 *   sprite name. `SpriteAnimator.die`'s optional third argument exists for this.
 * - `deathFrames`: `S_BEXP1`-`S_BEXP5`.
 * - `deathFrameSeconds`: a flat per-frame rate standing in for vanilla's own uneven per-state tics
 *   (5, 5, 5, 10, 10) — the same "one uniform rate" simplification `MONSTER_DEATH_FRAME_SECONDS`
 *   makes elsewhere, matching the real rate of the first three frames. Not derived from a patch.
 * - `explodeDelaySeconds`: vanilla's `A_Explode` sits on `S_BEXP4` — `info.c` and the walker in
 *   `dehacked/frames.ts` agree on the fourth state — so the blast comes `S_BEXP1`-`3`'s
 *   5 + 5 + 5 tics after the barrel actually died, not instantly on death.
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
 * A barrel's `A_Explode` becoming due (`BARREL_CHAIN.explodeDelaySeconds` after
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
 * Whether `type` gets `PICKUP_SCALE` — see `PICKUP_SCALE_TYPES`'s doc for why this is a whitelist,
 * not "everything but monsters/weapons".
 */
export function pickupScaleFor(type: number): number {
  return PICKUP_SCALE_TYPES.has(type) ? PICKUP_SCALE : 1;
}
