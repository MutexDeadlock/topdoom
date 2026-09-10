/**
 * `ThingLayer`: every live map thing — spawning by skill, pickups, damage and death, waking and
 * stepping monster AI, barrels, corpse raising — drawn through the shared sprite batch. The
 * record shapes and tables live in `things/defs.ts` and `things/tables.ts`. See docs/sprites.md,
 * docs/items.md, docs/monster-ai.md and docs/death.md.
 */
import * as THREE from 'three';
import type { Sector } from '../wad/map.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { PositionCheck, World } from './world.ts';
import {
  clampMomentum,
  GRAVITY,
  MAX_MOMENTUM_SPEED,
  MISSILE_HEIGHT_OFFSET,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
} from './player.ts';
import { pRandom } from '../util/random.ts';
import { DOOM_TIC } from '../constants.ts';
import {
  AIM_SLOPE_LIMIT,
  BARREL_CHAIN,
  BARREL_HEALTH,
  BARREL_MASS,
  BARREL_HEIGHT,
  BARREL_RADIUS,
  bodiesOverlap,
  BOSS_TYPES,
  DEATH_NOTIFY_TYPES,
  MAX_SKULLS_ON_LEVEL,
  pickupScaleFor,
  TELEFRAG_DAMAGE,
  type BarrelExplosion,
  type CarryQuery,
  type CrossingBody,
  type DamageHit,
  type LevelKillItemStats,
  type MonsterRef,
  type PosedThing,
  type StandingBody,
  type ThingLayer,
  type ThingUpdateResult,
  slotOfTarget,
  targetOfSlot,
} from './things/defs.ts';
export {
  // Re-exported so this file stays the thing layer's one public entry point — nothing outside
  // `things/` needs to know which file inside it a type lives in.
  // docs/conventions.md § File names.
  bodiesOverlap,
  monstersTelefrag,
  TELEFRAG_DAMAGE,
  type BarrelExplosion,
  type CarryQuery,
  type CrossingBody,
  type DamageHit,
  type MonsterRef,
  type StandingBody,
  type ThingLayer,
} from './things/defs.ts';
import * as tables from './things/tables.ts';
import { ThingType } from './things/doomednums.ts';
import { fastMonsters, isAmbush, isMultiplayerOnly, respawnMonsters, spawnAngleDeg, spawnsAtSkill, type Skill } from './skill.ts';
import {
  DI_NODIR,
  BODY_HEIGHT_FALLBACK,
  MONSTER_HIT_RADIUS,
  monsterShootZ,
  thrustSpeed,
  type MonsterAttackEvent,
  type MonsterBody,
} from './monsters/defs.ts';
import { INERT_SHOOTABLE, monsterStatsFor } from './monsters/tables.ts';
import { commitTarget, reactToDamage, shouldRetarget, stepMonsterAI, tryWake } from './monsters/ai.ts';
import {
  MONSTER_FIELD_DEFAULTS,
  MONSTER_KEYS_WITH_DEFAULTS,
  MONSTER_SAVE_KEYS,
  copyMonsterField,
  type MonsterFields,
  type ThingsSnapshot,
  type ThingState,
} from './snapshot.ts';
import { createThingGrid } from './things/grid.ts';
import { dropoffRefuses, makeCollider, makePinnedMemo, makePositionCheck, makeTouchCache, mayHitDropoff } from './world.ts';
import { transfersOf } from './specials/transfers.ts';
import { monsterOrigin, randomVariant, SILENT, type SoundEmitter } from '../audio/sfx.ts';
import {
  SpriteAnimator,
  SpriteBatch,
  SpriteMaterialCache,
  VIEWER_ANGLE_DEG,
} from '../render/sprites.ts';
import { doomToWorld, worldToDoom } from '../render/mapmesh.ts';
import { litColor, viewDepthAt } from '../render/sectorlight.ts';
import { skyLitSector } from '../render/skytint.ts';
import type { DynamicLights } from '../render/lights.ts';
import {
  blastDistanceToBox,
  boxReach,
  rayEntersBox,
  segmentEntersBox,
  traceHitsBox,
  vecLength,
} from '../util/geom.ts';
import type { Pos2, Pos3 } from '../types.ts';
import type { TeleportDest } from './specials.ts';
import { thingStatsPatched } from './dehacked/apply.ts';
import { decayOverTics } from '../util/damping.ts';
import { cos, sin } from '../util/fdlibm.ts';

/**
 * Vanilla's per-tic XY friction, `P_XYMovement`'s `FRICTION = 0xE800/0x10000`. `applyKnockback`
 * spreads it over the tics a step covers (`decayOverTics`) — docs/movement.md § Knockback.
 */
const FRICTION = 0.90625;
/** Below this a decaying knockback velocity snaps to 0. docs/movement.md § Knockback. */
const KNOCKBACK_STOP_SPEED = 1;
/**
 * `P_XYMovement`'s `MAXMOVE/2`, the longest single step a momentum move takes before
 * `applyKnockback` halves it — MBF's symmetric check (`comp_moveblock`), where vanilla splits a
 * positive move only. docs/movement.md § Knockback.
 */
const MOMENTUM_SPLIT_STEP = MAX_MOMENTUM_SPEED / 35 / 2;

/**
 * How often an unalerted monster re-checks line of sight to the player — vanilla's idle `A_Look`
 * runs every 10 tics, not every tic. Counted off the level clock for the whole layer rather than
 * accumulated per monster, so a restore re-derives the cadence instead of resetting it to a phase
 * the run was never in (docs/replays.md § Seeking). 11 tics rather than vanilla's 10 is the 0.3 s
 * accumulator this replaced, kept to the tic so no existing recording moves.
 * docs/monster-ai.md § Waking up.
 */
const LOOK_INTERVAL_TICS = 11;

/**
 * How long a corpse has to lie still before a nightmare respawn will even roll for it —
 * `P_MobjThinker`'s `if (mobj->movecount < 12*35) return;`. docs/monster-ai.md § Respawning
 * monsters.
 */
const NIGHTMARE_RESPAWN_DELAY = 12 * 35 * DOOM_TIC;

/**
 * `leveltime & 31` — how often `P_MobjThinker` rolls for a respawn at all, level-wide rather than
 * per corpse.
 */
const RESPAWN_ROLL_INTERVAL_TICS = 32;

/**
 * How far off the floor a monster's death drop is *drawn*, and how far it bobs either side of that
 * over `DROP_BOB_SECONDS`. Render-only: nothing in `tryPickup` reads it. All three tuned by feel;
 * docs/items.md § Making monster drops readable.
 */
const DROP_HOVER = 13;
const DROP_BOB = 3;
const DROP_BOB_SECONDS = 1.8;

/**
 * The two opacities a drop fades between over `DROP_PULSE_SECONDS`. Tuned by feel;
 * docs/items.md § Making monster drops readable.
 */
const DROP_OPACITY_MIN = 0.45;
const DROP_OPACITY_MAX = 1;
const DROP_PULSE_SECONDS = 1.8;

/**
 * Depth-buffer units the drop batch biases itself toward the camera (`SpriteBatch`'s constructor).
 * **Don't raise it** — docs/items.md § Making monster drops readable says what breaks.
 */
const DROP_DEPTH_BIAS = 16;

/**
 * The collider `applyKnockback` probes with, kept and refilled per body rather than rebuilt: it
 * runs for every thing still carrying velocity, every tic. See `makeCollider`.
 */
const knockbackCollider = makeCollider({ radius: 0, z: 0, height: 0, forMonster: true });

/**
 * The two walks `applyKnockback` compares — the step it wants and the position it is taking that
 * step from. Module-level for the same reason the collider above is; `checkPosition`'s own scratch
 * would have the second call clobber the first.
 */
const knockbackDest = makePositionCheck();
const knockbackStanding = makePositionCheck();

/** Everything `buildThingSprites` needs beyond the `World` it populates. */
export interface ThingLayerOptions {
  /** The WAD set's sprite lumps, which decide what a thing can be drawn as at all. */
  bank: SpriteBank;
  /** The shared per-lump material cache every `SpriteAnimator` here resolves through. */
  materials: SpriteMaterialCache;
  /** Which things spawn, how fast the monsters are, and whether corpses come back. */
  skill: Skill;
  sfx?: SoundEmitter;
  /**
   * Fired from `damage()`'s death branch the instant a monster dies leaving none of its own type
   * alive — vanilla's `A_BossDeath` gate, see docs/death.md § Boss death. Just the doomednum:
   * whether/how it matters is entirely `SpecialsController`'s per-map table to decide.
   */
  onBossDeath?: (type: number) => void;
  /**
   * A savegame's saved thing list. When present the map's own spawn loop is skipped entirely and
   * every thing is rebuilt from the save in order — restore lives here rather than as a
   * `ThingLayer` method because things can only be built through `pushThing`, which exists only
   * inside this closure. docs/savegames.md § Apply order.
   */
  restore?: ThingsSnapshot;
  /**
   * The two teleport fogs a nightmare respawn leaves behind, at the corpse's spot and at the spawn
   * point it returns to — `P_NightmareRespawn`'s own pair of `MT_TFOG`s, each with its `telept`.
   * A callback because the fog layer belongs to `game.ts`, exactly as `onBossDeath` above is.
   */
  onRespawn?: (from: Pos3, to: Pos3) => void;
  /**
   * The frame's dynamic lights, if any (docs/lights.md). Every drawn thing offers its frame key
   * here — a torch and a firing monster are emitters — and samples the light reaching it back as
   * a tint. A session with lights off passes none and no light code runs at all.
   */
  lights?: DynamicLights;
}

/** One static upright plane per map THING whose type is a known, visible sprite. */
export function buildThingSprites(world: World, options: ThingLayerOptions): ThingLayer {
  const { bank, materials, skill, sfx = SILENT, onBossDeath, restore, onRespawn, lights } = options;
  // Taken off `World`, never passed beside it — docs/conventions.md § Named arguments.
  const map = world.map;

  /**
   * The stat table this level runs on, resolved once rather than per lookup: every site below
   * reads it instead of naming `MONSTER_STATS`. docs/monster-ai.md § Fast monsters.
   */
  const monsterStats = monsterStatsFor(fastMonsters(skill));
  /** Whether killed monsters come back at all — nightmare only, see `respawnCorpse`. */
  const respawns = respawnMonsters(skill);
  const batch = new SpriteBatch();
  /**
   * Monster death drops draw through their own batch, which is what lets them carry
   * `DROP_DEPTH_BIAS` and a batch-wide opacity pulse the rest of the map's things must not get.
   * docs/items.md § Making monster drops readable.
   */
  const dropBatch = new SpriteBatch({ depthBias: DROP_DEPTH_BIAS, translucent: true });
  /**
   * The spectre and nothing else (`FUZZ_TYPES`): the demon's art drawn through vanilla's
   * `MF_SHADOW` fuzz. docs/sprites.md § The spectre's fuzz.
   */
  const fuzzBatch = new SpriteBatch({ fuzz: true });
  const group = new THREE.Group();
  group.name = 'things';
  group.add(batch.group, dropBatch.group, fuzzBatch.group);
  /** Level time in seconds, driving the drop bob/pulse (`DROP_HOVER`) and the fuzz shimmer. */
  let clock = 0;
  const posed: PosedThing[] = [];
  const stats: LevelKillItemStats = { totalKills: 0, kills: 0, totalItems: 0, items: 0 };
  /** Scratch for `doomToWorld`, reused across every sprite — this runs per thing per frame. */
  const worldPos = new THREE.Vector3();
  // A sprite's light is the sector's, which a Boom transfer can source from another sector
  // entirely — docs/specials-transfers.md § Transferred lighting.
  const transfers = transfersOf(map);

  /**
   * Doomednums this WAD *set* has no art for, so `pushThing` dropped them. Reported at level load
   * rather than left to vanish silently; the sprite name is in there because that is what to grep
   * the WAD for. docs/wad.md § Art a WAD set doesn't have.
   */
  const missingArt = new Set<string>();

  /** Reused by `crossAfterPush`, which runs for every pushed thing every tic. */
  const pushedFrom: Pos2 = { x: 0, y: 0 };

  /**
   * Every thing as the map spawned it — what `snapshotThings` elides against and what a restore's
   * missing entries stand for. Assigned once the spawn loop below has run, which is every level: a
   * restore is read *over* the map, never instead of it.
   */
  let spawnBaseline: ThingState[] = [];

  {
    for (const t of map.things) {
      if (!tables.THING_SPRITES[t.type]) continue;
      if (isMultiplayerOnly(t.flags)) continue;
      if (!spawnsAtSkill(t.flags, skill)) continue;

      // MF_SPAWNCEILING things (ceiling-hung gore, Commander Keen) measure z down from the ceiling
      // instead of up from the floor — see CEILING_HUNG_HEIGHT's doc.
      const sector = world.sectorAt(t.x, t.y);
      const hangHeight = tables.CEILING_HUNG_HEIGHT[t.type];
      const z = hangHeight !== undefined ? (sector?.ceilHeight ?? 0) - hangHeight : (sector?.floorHeight ?? 0);
      if (!pushThing(t.type, { x: t.x, y: t.y, z }, spawnAngleDeg(t.angle), { ambush: isAmbush(t.flags) })) {
        missingArt.add(`${t.type} (${tables.THING_SPRITES[t.type]})`);
        continue;
      }
      // `P_SpawnMapThing`'s own totals, raised only for a thing that actually spawned — past
      // every filter above, art included. docs/hud.md § Level stats.
      if (tables.COUNTKILL_TYPES.has(t.type)) stats.totalKills++;
      else if (tables.COUNTITEM_TYPES.has(t.type)) stats.totalItems++;
    }
    // Before anything a restore changes: this is the state a thing left out of `changed` stands
    // for, in both directions — what `snapshotThings` elides against and what `restoreThings`
    // keeps.
    spawnBaseline = posed.map(thingStateOf);
    if (restore) restoreThings(restore);
  }

  /**
   * The blocker/corpse spatial index — see things/grid.ts. Built here, after the spawn loop above,
   * so its first bucketing already holds every thing the map placed.
   */
  const grid = createThingGrid(world, posed);

  function snapshotThings(): ThingsSnapshot {
    // Only the things the run has moved on from; the restore re-spawns the map and reads these
    // over it. docs/savegames.md § The format and its version.
    const changed: [number, ThingState][] = [];
    for (const [i, p] of posed.entries()) {
      const s = thingStateOf(p);
      const asSpawned = i < spawnBaseline.length && sameThingState(s, spawnBaseline[i]);
      if (!asSpawned) changed.push([i, s]);
    }
    return { clock, stats: { ...stats }, changed };
  }

  /** One live thing as it is stored — the sparse rules are in `ThingState`'s own doc. */
  function thingStateOf(p: PosedThing): ThingState {
    const s: ThingState = { type: p.type, x: p.x, y: p.y, z: p.z, facingDeg: p.facingDeg };
    // Present only when true — see ThingState's doc.
    if (p.picked) s.picked = true;
    if (p.hidden) s.hidden = true;
    if (p.dropped) s.dropped = true;
    if (p.ambush) s.ambush = true;
    const killable = Number.isFinite(p.health) || p.dead;
    if (killable && !isPristine(p)) {
      // Sparse: a field still at its spawn default is omitted and the restore's own
      // `pushThing` re-supplies it. The six keys with no constant default are decided here
      // instead. docs/savegames.md § What is saved and what is deliberately not.
      const block: Partial<MonsterFields> = {
        homingBias: p.homingBias,
      };
      // Written unconditionally once a patch has moved `MONSTER_HEALTH`, since the elision
      // is against a table value. docs/dehacked.md § Savegames and patched tables.
      if (thingStatsPatched() || p.health !== spawnHealthFor(p.type, p.dropped)) {
        block.health = p.health;
      }
      if (p.angle !== (p.facingDeg * Math.PI) / 180) block.angle = p.angle;
      if (p.spawnX !== p.x) block.spawnX = p.spawnX;
      if (p.spawnY !== p.y) block.spawnY = p.spawnY;
      if (p.spawnAngle !== p.facingDeg) block.spawnAngle = p.spawnAngle;
      for (const key of MONSTER_KEYS_WITH_DEFAULTS) {
        if (p[key] !== MONSTER_FIELD_DEFAULTS[key]) copyMonsterField(block, p, key);
      }
      s.monster = block;
    }
    return s;
  }

  function update(
    dt: number,
    players: readonly (Pos3 | null)[],
    fogVisible?: (subsector: number) => boolean,
    crossLines?: (prev: Pos2, mover: CrossingBody) => TeleportDest | null,
    useLines?: (mover: CrossingBody, tryX: number, tryY: number) => TeleportDest | null,
    carry?: CarryQuery,
  ): ThingUpdateResult {
    const attacks: MonsterAttackEvent[] = [];
    const barrelExplosions: BarrelExplosion[] = [];
    // Built once per tic rather than per monster: `stepMonsterAI` hands back the very record it
    // was given, which is always one of `posed`, so the wrapper needs no capture of its own.
    const useBlockingLines = useLines
      ? (body: MonsterBody, tryX: number, tryY: number) => {
          const thing = body as PosedThing;
          const dest = useLines(thing, tryX, tryY);
          if (dest) arriveAt(thing, dest);
        }
      : undefined;
    // Same shape, for the bodies a step can bump into — resolved inside the step, on first probe.
    const blockersNear = (body: MonsterBody, probeReach: number) =>
      grid.blockersFor(body as PosedThing, players, probeReach);
    // Once per tic, ahead of any `blockersFor` call below — docs/monster-ai.md § Spatial indexing
    // on why a tic-granular grid is accurate enough for contact.
    // `carry` is absent on a level with no conveyor — see `Forces.carriesAnything`.
    grid.rebuild(carry !== undefined);
    clock += dt;
    // One respawn attempt every 32 tics for the whole level, not per corpse: `P_MobjThinker`
    // reads the global `leveltime`, and `clock` is that clock in seconds. Rounded rather than
    // floored — the simulation advances whole tics, so this is an exact tic index up to float
    // noise. docs/monster-ai.md § Respawning monsters.
    const tic = Math.round(clock / DOOM_TIC);
    const respawnTic = respawns && tic % RESPAWN_ROLL_INTERVAL_TICS === 0;
    // The idle look-around, on the same clock and for the same reason: one cadence for the level,
    // which a restore gets back with `clock` itself. docs/monster-ai.md § Waking up.
    const lookTic = tic % LOOK_INTERVAL_TICS === 0;
    // The wake check's player: the first slot still alive, until the vanilla rotation over every
    // slot arrives with coop (docs/multiplayer.md § Player slots). One BSP descent for the whole
    // sweep — a player moves once a tic rather than once per monster.
    const player = firstLiving(players);
    const playerSubsector = player ? world.subsectorAt(player.x, player.y) : -1;
    for (const p of posed) {
      // Every thing, every tic, before anything below can move it: `prev` is no substitute (see
      // its doc), and a thing that skips a tic via a `continue` below still needs an
      // interpolation source. docs/frameloop.md § The accumulator (`game.ts: frame`).
      p.drawPrevX = p.x;
      p.drawPrevY = p.y;
      p.drawPrevZ = p.z;
      if (p.hidden) {
        p.visible = false;
        continue;
      }
      if (p.dead) {
        p.deadTime += dt;
        // `P_KillMobj` strips `MF_NOGRAVITY` from everything but the lost soul, so a corpse left
        // hanging in the air drops. Gated on the thing's own cached sector floor, so a corpse
        // already resting on it costs no query.
        if (p.type !== ThingType.lostSoul && p.z > (p.sector?.floorHeight ?? p.z)) {
          const restZ = world.groundFloor(p.x, p.y, p.blockRadius, true, p.z);
          p.velZ -= GRAVITY * dt;
          p.z = Math.max(restZ, p.z + p.velZ * dt);
          if (p.z === restZ) p.velZ = 0;
        }
        if (p.type === ThingType.barrel) {
          // `A_Explode` fires partway through the death animation, not on death itself — see
          // `BARREL_CHAIN.explodeDelaySeconds`'s doc.
          if (!p.barrelExploded && p.deadTime >= BARREL_CHAIN.explodeDelaySeconds) {
            p.barrelExploded = true;
            barrelExplosions.push({ x: p.x, y: p.y, z: p.z, source: p.explodeSource ?? undefined });
          }
          // The debris is removed once its explosion animation finishes, not left as a corpse:
          // vanilla's `S_BEXP5` falls through to `S_NULL`. Same rule as `MONSTER_CORPSE_VANISHES`
          // below, which a barrel can't share — it is not a `MONSTER_TYPES` member.
          if (p.deadTime >= p.deathFrameCount * BARREL_CHAIN.deathFrameSeconds) {
            p.hidden = true;
            p.visible = false;
            continue;
          }
        } else if (
          // These two types leave no corpse at all — see `MONSTER_CORPSE_VANISHES`'s doc. Without
          // it `SpriteAnimator.die`'s hold-last-frame leaves their last death frame on screen.
          tables.MONSTER_CORPSE_VANISHES.has(p.type) &&
          p.deadTime >= p.deathFrameCount * tables.MONSTER_DEATH_FRAME_SECONDS
        ) {
          p.hidden = true;
          p.visible = false;
          continue;
        }
        // `P_MobjThinker`'s respawn branch in its own order: `MF_COUNTKILL` only, then 12 seconds
        // face down, then the level-wide gate above, then a 5-in-256 roll. The corpse-removal
        // branches above already `continue`, so nothing vanilla removes outright reaches this.
        if (respawnTic && p.deadTime >= NIGHTMARE_RESPAWN_DELAY && tables.COUNTKILL_TYPES.has(p.type) && pRandom() <= 4) {
          // No `continue` on success: the monster is alive as of this line and falls through to
          // the live path below, looking around in the same tic.
          respawnCorpse(p, players);
        }
      }

      // Every non-monster always cycles — vanilla's idle art loops unconditionally rather than
      // tracking motion the way a monster's walk cycle does. A monster starts false, and only the
      // stats branch below turns it on, off whether it stepped this frame.
      let animating = !p.isMonster;
      const stats = !p.dead ? p.stats : undefined;
      // A conveyor feeds the same momentum channel a hit's knockback does, so the integration
      // below carries it for free. Only fliers are exempt (`MF_NOGRAVITY`); a corpse is not, since
      // `P_KillMobj` strips that flag. docs/specials-forces.md § Scrollers and conveyors.
      if (carry && !stats?.flies) {
        const impulse = carry(p, p.blockRadius, p.touch);
        if (impulse) {
          p.velX += impulse.x;
          p.velY += impulse.y;
        }
      }
      if (stats) {
        // Only the wake check needs a living player: `P_LookForPlayers` skips
        // `player->health <= 0`, so a dead player rouses nobody new. An alerted monster keeps
        // stepping either way — it may be mid-infight, and `resolveTarget` decides that.
        if (lookTic && !p.alerted && player) {
          // This loop owns only the throttle (`LOOK_INTERVAL_TICS`); the wake decision itself is
          // `monsters/ai.ts`'s `tryWake`. docs/monster-ai.md § Waking up.
          // One of the two events that reshuffle a revenant's guided/unguided personality —
          // see `MonsterBody.homingBias`'s doc. A no-op for every other type.
          if (tryWake(p, world, p.sector, player, playerSubsector)) {
            p.homingBias = (pRandom() & 1) !== 0;
            // `A_Look`'s sight sound, randomized within its family and unattenuated for the
            // two bosses.
            const see = stats.sounds.see;
            if (see) sfx.play(randomVariant(see), BOSS_TYPES.has(p.type) ? null : p, monsterOrigin(p.id));
          }
        }
        if (p.alerted) {
          const target = resolveTarget(p, players);
          if (!target) {
            // Nobody left to want, so the monster gives up and idles exactly like one that never
            // woke — `A_Chase` sends a target-less actor to its spawnstate. Only `damage`'s
            // unconditional re-alert gets it going again.
            p.alerted = false;
            p.movedir = DI_NODIR;
            p.movecount = 0;
            // A flier keeps the height it drifted to: `MF_NOGRAVITY` outlives losing a target,
            // and dropping it here would pop a hovering cacodemon down the instant the player
            // dies.
            if (!stats.flies) p.z = p.sector?.floorHeight ?? p.z;
          } else {
            const beforeX = p.x;
            const beforeY = p.y;
            // The melee gate's `pl->info->radius`/height. A player target takes the player's;
            // anything else is another `PosedThing`, already carrying its own resolved figures.
            // docs/monster-ai.md § Melee reach.
            const victim = p.targetId < 0 ? null : (posed[p.targetId] ?? null);
            const targetRadius = victim ? victim.blockRadius : PLAYER_RADIUS;
            const targetHeight = victim ? victim.bodyHeight : PLAYER_HEIGHT;
            const result = stepMonsterAI(p, stats, world, {
              dt,
              target,
              targetRadius,
              targetHeight,
              blockersFor: blockersNear,
              resurrect: grid.findRaisableCorpse,
              useLines: useBlockingLines,
              sfx,
            });
            // Additive on top of the AI walk step above, as `P_XYMovement` is on `A_Chase`'s —
            // see `applyKnockback`'s doc.
            if (p.velX !== 0 || p.velY !== 0) {
              applyKnockback(p, dt);
            }
            // Walk triggers this monster crossed on the way — teleports, and the handful of
            // doors/lifts vanilla lets a monster open. docs/death.md § Telefrag.
            const dest = crossLines?.(p.prev, p);
            if (dest) arriveAt(p, dest);
            p.prev.x = p.x;
            p.prev.y = p.y;
            refreshSector(p);
            p.facingDeg = (p.angle * 180) / Math.PI;
            animating = p.x !== beforeX || p.y !== beforeY;
            if (result?.kind === 'resurrect') {
              // Carried out here rather than reported through `attacks`: a resurrection is
              // AI-state over a `PosedThing` only this layer holds, not damage for `game.ts` to
              // realize. No attack pose either — see `MONSTER_RAISE_FRAMES`'s doc.
              const corpse = result.resurrectId !== undefined ? posed[result.resurrectId] : undefined;
              if (corpse?.dead) reviveCorpse(corpse);
            } else if (result?.kind === 'spawn') {
              // Same reasoning as 'resurrect' above, and never through `attacks`. The
              // elemental's own pose does play, unlike the vile's raise: `A_PainAttack` has
              // dedicated art. docs/monster-ai.md § The pain elemental: spawning a lost soul.
              spawnLostSoul(p, result.angleRad);
            } else if (result) {
              attacks.push({
                ...result,
                x: p.x,
                y: p.y,
                z: p.z + (result.projectiles ? MISSILE_HEIGHT_OFFSET : monsterShootZ(p.bodyHeight)),
                sourceId: p.id,
                sourceType: p.type,
                sourceRadius: p.blockRadius,
                targetId: p.targetId,
              });
            }
            // The pose belongs to the attack, not to the shot: it starts on whichever tic
            // `attackPause` was set, and `posing` keeps a volley's later shots from snapping it
            // back to frame one. docs/sprites.md § Pain, and attack/pain poses.
            if (p.attackPause > 0 && !p.anim.posing) {
              // `p.swinging` names the kind on the tic a melee attack *starts*: the claw is a
              // windup away, so `result` is null and only the flag says which chain to pose off.
              enterAttackPose(p, result?.kind === 'melee' || p.swinging ? 'melee' : 'ranged', p.attackPause);
            }
          }
        } else {
          // A flier keeps the height it hovered to, so a dormant cacodemon must not pop down to
          // the floor. A *rising* floor still pushes it up, which is all `P_ZMovement` does for a
          // no-gravity body on contact. docs/monster-ai.md § Floating monsters.
          const floorZ = p.sector?.floorHeight ?? p.z;
          p.z = stats.flies ? Math.max(p.z, floorZ) : floorZ;
          // A not-yet-alerted monster can still be knocked back: `damage` always sets velX/velY,
          // and it alerts in the same call, so this mostly guards the same-frame ordering.
          if (p.velX !== 0 || p.velY !== 0) {
            pushAndSettle(p, dt, crossLines);
          }
        }
      } else {
        // Ceiling-hung gore rides a moving ceiling (crusher, closing door) the same way
        // everything else here rides a moving floor — see CEILING_HUNG_HEIGHT's doc.
        // A corpse still falling (the dead branch above) is the one exception: it owns its own
        // `z` until it lands, and only then rejoins the ride.
        const hangHeight = p.hangHeight;
        if (hangHeight !== undefined) {
          p.z = (p.sector?.ceilHeight ?? p.z + hangHeight) - hangHeight;
        } else if (!p.dead || p.z <= (p.sector?.floorHeight ?? p.z)) {
          p.z = p.sector?.floorHeight ?? p.z;
        }
        // Barrels have no AI movement, so this is their only source of horizontal motion; a
        // corpse lands here too, finishing whatever knockback it died with and riding whatever
        // conveyor it fell onto. docs/movement.md § Knockback.
        if (p.velX !== 0 || p.velY !== 0) {
          pushAndSettle(p, dt, crossLines);
        }
      }

      // Whether this thing can be seen — and so shot, and so auto-aimed at. Keyed to fog's crisp
      // `explored` flag, never its damped alpha. docs/fogofwar.md § What gameplay reads.
      p.visible = !fogVisible || fogVisible(p.subsector);
      p.anim.advance(dt, animating);
    }
    return { attacks, barrelExplosions };
  }

  function draw(alpha: number, viewAngleDeg: number): void {
    batch.begin(viewAngleDeg);
    dropBatch.begin(viewAngleDeg);
    fuzzBatch.begin(viewAngleDeg);
    fuzzBatch.setFuzzTime(clock);
    const pulse = sin((clock / DROP_PULSE_SECONDS) * Math.PI * 2) * 0.5 + 0.5;
    dropBatch.setOpacity(DROP_OPACITY_MIN + (DROP_OPACITY_MAX - DROP_OPACITY_MIN) * pulse);
    for (const p of posed) {
      // Resolving the lump is only worth doing for something actually drawn: on a map like
      // NUTS.WAD this skips thousands of `SpriteBank` lookups a frame.
      if (!p.visible) continue;
      const cached = p.anim.resolve(p.facingDeg, viewAngleDeg);
      if (!cached) continue;
      const x = p.drawPrevX + (p.x - p.drawPrevX) * alpha;
      const y = p.drawPrevY + (p.y - p.drawPrevY) * alpha;
      const z = p.drawPrevZ + (p.z - p.drawPrevZ) * alpha;
      doomToWorld(x, y, z, worldPos);
      // Read live off the sector rather than cached on the thing — docs/render-lighting.md § Sector
      // lighting on why every sprite must. A fullbright frame ignores the sector outright, and
      // its `startmap` is row 0, which no depth can move, so it skips the depth too
      // (docs/render-lighting.md § Distance lighting).
      const bright = tables.FULLBRIGHT_FRAMES.has(p.anim.frameKey);
      const light = bright
        ? litColor(255)
        : litColor(
            p.sector ? transfers.spriteLight(world.sectorIndexOfSubsector(p.subsector)) : 128,
            0,
            viewDepthAt(worldPos.x, worldPos.y, worldPos.z),
          );
      // Standing under sky takes the level's outdoor tint, as the floor it stands on does.
      // docs/render-lighting.md § Outdoor sky tint.
      const sky = !bright && skyLitSector(p.sector);
      // A drawn sprite is both a possible emitter and a receiver. `p.visible` above already
      // gated on fog of war, so an unrevealed room lights nothing. docs/lights.md § What emits.
      const tint = lights?.offerAndTint(p.anim.frameKey, x, y, z, p.id, p.subsector);
      if (!p.dropped) {
        // A fuzzed thing (`FUZZ_TYPES`) differs only in which batch draws it; everything above
        // is the pose an ordinary thing gets.
        const into = tables.FUZZ_TYPES.has(p.type) ? fuzzBatch : batch;
        into.add(cached, worldPos.x, worldPos.y, worldPos.z, p.scale, light, tint, sky);
        continue;
      }
      // Phase-shifted per instance, so two drops side by side ripple instead of bobbing in
      // unison. docs/items.md § Making monster drops readable.
      const bob = sin((clock / DROP_BOB_SECONDS + p.id * 0.7) * Math.PI * 2) * DROP_BOB;
      doomToWorld(x, y, z + DROP_HOVER + bob, worldPos);
      dropBatch.add(cached, worldPos.x, worldPos.y, worldPos.z, p.scale, light, tint, sky);
    }
    batch.end();
    dropBatch.end();
    fuzzBatch.end();
  }

  function dispose(): void {
    batch.dispose();
    dropBatch.dispose();
    fuzzBatch.dispose();
  }

  function tryPickup(
    from: Pos3,
    to: Pos2,
    blockdist: number,
    consume: (type: number, dropped: boolean, at: Pos3) => boolean,
  ): void {
    for (const p of posed) {
      if (p.picked) continue;
      // `PIT_CheckThing`'s box at both ends of the move, because vanilla picks items up at the
      // destination before rejecting the move. docs/items.md § Collecting things.
      const settled = bodiesOverlap(from, p, blockdist);
      if (!settled && !bodiesOverlap(to, p, blockdist)) continue;
      // `PIT_CheckThing`'s overhead/underneath gate: a thing on a not-yet-lowered pillar is in
      // 2D range but out of reach (DOOM2 MAP04's blue key). docs/items.md § Collecting things.
      if (Math.abs((p.sector?.floorHeight ?? 0) - from.z) > PLAYER_HEIGHT) continue;
      // The attempted end alone reaches a whole tic past where the collector stands, so unlike
      // vanilla's own stepping it can land deep inside sealed geometry. Only that end is gated —
      // the settled box is vanilla's, walls and all. docs/items.md § Collecting things.
      if (!settled && world.sealedBetween(from, p)) continue;
      if (consume(p.type, p.dropped, p)) {
        p.picked = true;
        p.hidden = true;
        p.visible = false;
        // `P_TouchSpecialThing`'s `if (special->flags & MF_COUNTITEM) player->itemcount++`. A
        // monster drop never matches, so no `dropped` guard is needed.
        if (tables.COUNTITEM_TYPES.has(p.type)) stats.items++;
      }
    }
  }

  function pickMonster(ray: THREE.Ray, aimAt: Pos3): MonsterRef | null {
    // DOOM space throughout, for the reason `pickShootAim` states: every candidate is map-space
    // state and the ray is the only thing arriving in three.js space.
    const o = worldToDoom(ray.origin.x, ray.origin.y, ray.origin.z);
    const d = worldToDoom(ray.direction.x, ray.direction.y, ray.direction.z);
    let best: PosedThing | null = null;
    // Bounded where the ray enters the ground past the aim point, and by nothing else —
    // docs/combat.md § Auto-aim.
    let bestDist = world.groundReach(o, aimAt);
    for (const p of posed) {
      // A rejected thing is skipped, not treated as a blocker: a decoration in front of a monster
      // must not make it untargetable. `lockable` is the type half of that, settled at spawn.
      if (!p.lockable || !p.visible || p.dead || p.picked) continue;
      // Tic state only — the position `update` left, and this body's own `mobjinfo` box. Neither
      // the drawn sprite nor anything interpolated reaches this, which is what keeps auto-aim
      // independent of both the frame rate and the loaded WAD's art. docs/combat.md § Auto-aim.
      const dist = rayEntersBox(o.x, o.y, o.z, d.x, d.y, d.z, p.x, p.y, p.blockRadius, p.z, p.z + p.bodyHeight);
      if (dist === null || dist >= bestDist) continue;
      bestDist = dist;
      best = p;
    }
    if (!best) return null;
    return monsterRef(best);
  }

  function monstersNear(pos: Pos2, radius: number): MonsterRef[] {
    // Grid-backed rather than a scan of every thing, and **don't make it one** —
    // docs/monster-ai.md § Spatial indexing.
    const out: MonsterRef[] = [];
    // Range is measured to each body's *edge* (`blastDistanceToBox`), so the box has to reach a
    // full body-width past the blast or the widest monsters would never be considered.
    grid.forEachMonsterNear(pos.x, pos.y, radius + grid.maxBodyRadius(), radius, (p) => {
      // The grid holds solid decorations too, and those block movement but not shots —
      // docs/monster-ai.md § Spatial indexing.
      if (p.dead || p.isDecoration) return;
      if (blastDistanceToBox(pos.x, pos.y, p.x, p.y, p.blockRadius) >= radius) return;
      out.push(monsterRef(p));
    });
    return out;
  }

  function monstersAlongStep(from: Pos3, to: Pos3, reach: number): MonsterRef[] {
    const out: MonsterRef[] = [];
    // One grid query over the whole step, sized from the map's own largest body rather than the
    // largest in the game — docs/monster-ai.md § Spatial indexing.
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const half = vecLength(to.x - from.x, to.y - from.y) / 2;
    grid.forEachMonsterNear(midX, midY, half + boxReach(reach + grid.maxBodyRadius()), half + reach, (p) => {
      // The grid holds solid decorations too, and those block movement but not shots —
      // docs/monster-ai.md § Spatial indexing.
      if (p.dead || p.isDecoration) return;
      if (segmentEntersBox(from.x, from.y, to.x, to.y, p.x, p.y, p.blockRadius + reach) === null) return;
      out.push(monsterRef(p));
    });
    return out;
  }

  function monsterById(id: number): MonsterRef | null {
    const p = posed[id];
    if (!p || p.dead || !p.isMonster) return null;
    return monsterRef(p);
  }

  function drawnFrameKey(id: number): string {
    return posed[id]?.anim.frameKey ?? '';
  }

  function bleeds(id: number): boolean {
    const p = posed[id];
    return !!p && p.type !== ThingType.barrel;
  }

  function awakeMonsterCount(): number {
    let n = 0;
    for (const p of posed) {
      if (!p.dead && p.isMonster && p.alerted) {
        n++;
      }
    }
    return n;
  }

  function awakeMonsters(): StandingBody[] {
    const out: StandingBody[] = [];
    for (const p of posed) {
      if (p.dead || !p.isMonster || !p.alerted || !p.visible) continue;
      out.push({ x: p.x, y: p.y, z: p.z, height: p.bodyHeight });
    }
    return out;
  }

  /**
   * The one `posed` walk the three sector queries below share: every body standing in one of
   * `where` that is `dead` and that `accept` keeps. The predicates are the module-level constants
   * beside `monsterRef`, so a call allocates no closure and `accept` stays one of three stable
   * targets.
   *
   * `dead` is a parameter rather than part of `accept` because it is the one test cheap and
   * selective enough to be worth making before the sector lookup: most of a level's bodies are on
   * the wrong side of it, and rejecting them costs one boolean compare instead of a `Set` probe.
   */
  function refsIn(
    where: ReadonlySet<Sector>,
    dead: boolean,
    accept: (p: PosedThing) => boolean,
  ): MonsterRef[] {
    const out: MonsterRef[] = [];
    for (const p of posed) {
      if (p.dead !== dead) continue;
      const sector = p.sector;
      if (!sector || !where.has(sector)) continue;
      if (!accept(p)) continue;
      out.push(monsterRef(p));
    }
    return out;
  }

  function monstersInSectors(sectors: ReadonlySet<Sector>): MonsterRef[] {
    return refsIn(sectors, false, isMonsterType);
  }

  function crushablesInSectors(sectors: ReadonlySet<Sector>): MonsterRef[] {
    return refsIn(sectors, false, isCrushableType);
  }

  function corpsesInSectors(sectors: ReadonlySet<Sector>): MonsterRef[] {
    return refsIn(sectors, true, isSquashableCorpse);
  }

  function crushCorpse(id: number): void {
    const p = posed[id];
    if (!p || p.crushed) return;
    // A set without the pool's own art would draw nothing where the corpse was, so the corpse is
    // left as it is — the same "no art, don't pose it" rule `pushThing` applies at spawn.
    if (!tables.CORPSE_GIB.frames.length || !bank.lookup(tables.CORPSE_GIB.sprite, tables.CORPSE_GIB.frames[0], 1)) return;
    p.crushed = true;
    // `deadTime` deliberately keeps running: the corpse has been lying there just as long, which
    // is what the arch-vile's settle gate and the nightmare respawn delay both measure.
    enterDeathPose(p);
  }

  function damage(id: number, amount: number, hit?: DamageHit): void {
    const p = posed[id];
    if (p) damageThing(p, amount, hit);
  }

  /**
   * `P_TeleportMove`'s stomp — contract at `ThingLayer.telefragAt`, rules in docs/death.md §
   * Telefrag.
   */
  function telefragAt(at: Pos2, radius: number, stomps: boolean, moverId?: number): boolean {
    for (const q of posed) {
      if (q.id === moverId || q.dead || q.hidden) continue;
      if (!q.isMonster && q.type !== ThingType.barrel) continue;
      if (!bodiesOverlap(at, q, radius + q.blockRadius)) continue;
      if (!stomps) return false;
      // Deliberately unattributed: a telefrag is the teleport's doing, not an attack, and
      // naming the arriving body would start an infight it never picked.
      damageThing(q, TELEFRAG_DAMAGE);
    }
    return true;
  }

  /**
   * `A_SpawnFly`'s monster creation: drops a fresh, already-awake `type` at `at` and telefrags
   * whatever stood there. The Icon of Sin's spawn cube is the only caller;
   * `game/monsters/iconofsin.ts` owns the rest of that sequence. A spawn spot is lethal rather
   * than blocked, which is why there is no `positionBlocked` guard here unlike `spawnLostSoul`.
   * docs/monster-iconofsin.md § The spawn cube.
   */
  function spawnMonster(type: number, at: Pos3, angleRad: number): MonsterRef | null {
    const spawned = pushThing(type, at, (angleRad * 180) / Math.PI, { alerted: true });
    if (!spawned) return null;
    telefragAt(spawned, spawned.blockRadius, true, spawned.id);
    return monsterRef(spawned);
  }

  function raycastMonster(
    origin: Pos3,
    angleRad: number,
    maxDist: number,
    opts?: { ignoreId?: number; includeHidden?: boolean; slope?: number },
  ): (MonsterRef & { dist: number }) | null {
    const dx = cos(angleRad);
    const dy = sin(angleRad);
    // The span this trace reaches vertically: one slope for a shot that already has one,
    // `P_AimLineAttack`'s cone for a trace that is an aim. docs/combat.md § The vertical test.
    const topSlope = opts?.slope ?? AIM_SLOPE_LIMIT;
    const bottomSlope = opts?.slope ?? -AIM_SLOPE_LIMIT;
    let nearest: (MonsterRef & { dist: number }) | null = null;
    // Grid-backed rather than a scan of every thing, and sized to clear the widest body this map
    // holds — docs/monster-ai.md § Spatial indexing.
    const clearance = boxReach(grid.maxBodyRadius());
    grid.forEachMonsterAlongRay({ from: origin, dirX: dx, dirY: dy, maxDist, clearance, ownReach: 0 }, (p) => {
      // The grid holds solid decorations too, and those block movement but not shots —
      // docs/monster-ai.md § Spatial indexing.
      if (p.dead || p.isDecoration) return;
      if (p.id === opts?.ignoreId) return;
      // Fog of war is a *player*-facing conceit; a monster shooting another monster in an
      // unrevealed room must still connect.
      if (!opts?.includeHidden && !p.visible) return;
      // This body's own width, not one shared hitbox — `PIT_AddThingIntercepts` tests each
      // thing's real bounding box. docs/combat.md § How a shot deals damage.
      const t = traceHitsBox(origin.x, origin.y, dx, dy, p.x, p.y, p.blockRadius);
      if (t === null || t > maxDist || (nearest && t >= nearest.dist)) return;
      // `PTR_AimTraverse`'s vertical test: the slopes reaching this body's feet and top have to
      // overlap the span above. Guarded against a zero distance, where both run to infinity.
      const dist = Math.max(t, 1e-6);
      if ((p.z + p.bodyHeight - origin.z) / dist < bottomSlope) return; // over it
      if ((p.z - origin.z) / dist > topSlope) return; // under it
      nearest = {
        id: p.id,
        x: origin.x + dx * t,
        y: origin.y + dy * t,
        z: p.z,
        dist: t,
        type: p.type,
        height: p.bodyHeight,
        angle: p.angle,
        radius: p.blockRadius,
      };
    });
    return nearest;
  }

  /**
   * Builds and appends one `PosedThing` — the single place that ~60-field literal is written, and
   * the only way a thing is ever created. Only the fields the four spawn paths disagree on are
   * parameters; the rest is fixed for a fresh thing or derivable from `type` and the position.
   *
   * Returns null when the WAD set carries no art for the type. Deliberately does **not** touch
   * `stats.totalKills`/`totalItems` — docs/hud.md § Level stats.
   */
  function pushThing(
    type: number,
    at: Pos3,
    facingDeg: number,
    opts?: { ambush?: boolean; dropped?: boolean; alerted?: boolean; targetId?: number },
  ): PosedThing | null {
    const spriteName = tables.THING_SPRITES[type];
    if (!spriteName) return null;
    const isBarrel = type === ThingType.barrel;
    const itemAnim = tables.THING_ANIM_FRAMES[type];
    // A monster walks, a barrel sways, an item blinks — and the two AI-less monsters hold a
    // spawnstate frame of their own (see `MONSTER_IDLE_FRAMES`).
    const animFrames = tables.MONSTER_TYPES.has(type)
      ? (tables.MONSTER_IDLE_FRAMES[type] ?? tables.MONSTER_WALK_FRAMES_OVERRIDE[type] ?? tables.MONSTER_WALK_FRAMES)
      : isBarrel
        ? BARREL_CHAIN.idleFrames
        : itemAnim
          ? itemAnim.frames
          : ['A'];
    const frameSeconds = isBarrel ? BARREL_CHAIN.idleFrameSeconds : itemAnim ? itemAnim.frameSeconds : undefined;
    const anim = new SpriteAnimator(bank, materials, spriteName, animFrames, frameSeconds);
    // Resolved once, here: a thing whose art this WAD set lacks is skipped rather than spawned
    // pointing at a missing lump.
    if (!anim.resolve(facingDeg, VIEWER_ANGLE_DEG)) return null;
    const { x, y, z } = at;
    const isMonster = tables.MONSTER_TYPES.has(type);
    const isDecoration = tables.SOLID_DECORATION_TYPES.has(type);
    const thing: PosedThing = {
      id: posed.length,
      anim,
      scale: pickupScaleFor(type),
      // Everything the pointer can lock onto, and nothing else. Why barrels join `MONSTER_TYPES`
      // is `ThingLayer.pickMonster`'s doc.
      lockable: !tables.NO_AUTO_AIM_TYPES.has(type) && (isMonster || isBarrel),
      blockRadius: isBarrel
        ? BARREL_RADIUS
        : isDecoration
          ? (tables.SOLID_DECORATION_RADIUS_OVERRIDE[type] ?? tables.SOLID_DECORATION_RADIUS)
          : // `INERT_SHOOTABLE` before the fallback: Keen and the brain have a real `mobjinfo`
            // radius, they just have no `MONSTER_STATS` to carry it.
            monsterStats[type]?.radius ?? INERT_SHOOTABLE[type]?.radius ?? MONSTER_HIT_RADIUS,
      // Same resolution order and the same reason as `blockRadius` above.
      bodyHeight: isBarrel
        ? BARREL_HEIGHT
        : (monsterStats[type]?.height ?? INERT_SHOOTABLE[type]?.height ?? BODY_HEIGHT_FALLBACK),
      stats: monsterStats[type],
      isMonster,
      isSolid: isMonster || isBarrel || isDecoration,
      isDecoration,
      hangHeight: tables.CEILING_HUNG_HEIGHT[type],
      attackPose: tables.MONSTER_ATTACK_POSE[type],
      painFrames: tables.MONSTER_PAIN_FRAMES[type],
      raiseFrames: tables.MONSTER_RAISE_FRAMES[type],
      // Every AI/damage field the save can elide, straight from the table the snapshot compares
      // against: one definition of "spawn state", so the two can't drift (see
      // `MONSTER_FIELD_DEFAULTS`). The `opts`-driven and per-type ones below override it.
      ...MONSTER_FIELD_DEFAULTS,
      deathFrameCount: 0,
      visible: true,
      hidden: false,
      queryStamp: 0,
      gridCell: 0,
      gridSlot: -1,
      moveBound: 0,
      touch: makeTouchCache(),
      pinned: makePinnedMemo(),
      x,
      y,
      z,
      // A fresh thing has nowhere to interpolate from but where it is, so its first drawn frame
      // sits still instead of sliding in from the origin.
      drawPrevX: x,
      drawPrevY: y,
      drawPrevZ: z,
      sector: world.sectorAt(x, y),
      facingDeg,
      // `mobj->spawnpoint`, fixed here for the rest of this thing's life — see its doc.
      spawnX: x,
      spawnY: y,
      spawnAngle: facingDeg,
      subsector: world.subsectorAt(x, y),
      sectorX: x,
      sectorY: y,
      type,
      picked: false,
      health: spawnHealthFor(type, opts?.dropped ?? false),
      dead: false,
      dropped: opts?.dropped ?? false,
      alerted: opts?.alerted ?? false,
      ambush: opts?.ambush ?? false,
      angle: (facingDeg * Math.PI) / 180,
      homingBias: (pRandom() & 1) !== 0,
      prev: { x, y },
      targetId: opts?.targetId ?? targetOfSlot(0),
    };
    posed.push(thing);
    return thing;
  }

  /**
   * Rebuilds every saved thing in order through `pushThing`, then overwrites the fields the
   * simulation had mutated. IDs are positional, so missing art is a hard error here rather than
   * the spawn loop's skip: skipping would shift every later ID and desync the saved cross-thing
   * references. docs/savegames.md § What is saved and what is deliberately not.
   */
  /**
   * Read *over* the map's own spawn loop, which has already run: only the things that are no longer
   * as it left them are in the save, and everything it leaves out was just spawned as it should be.
   * An id past the spawn count is a thing the run itself created (a dropped weapon, a nightmare
   * respawn, one of the Icon's); the pairs are in ascending id, so pushing those in the order they
   * come keeps the index the id. docs/savegames.md § The format and its version.
   */
  function restoreThings(saved: ThingsSnapshot): void {
    const spawned = posed.length;
    restoreCounts(saved);
    for (const [id, s] of saved.changed) {
      applyThingState(id < spawned ? posed[id] : pushSaved(s), s);
    }
  }

  /** The level-wide totals a restore brings with it, over whatever the spawn loop counted. */
  function restoreCounts(saved: ThingsSnapshot): void {
    clock = saved.clock;
    stats.totalKills = saved.stats.totalKills;
    stats.kills = saved.stats.kills;
    stats.totalItems = saved.stats.totalItems;
    stats.items = saved.stats.items;
  }

  /** A saved thing pushed as a fresh one; refuses rather than shifting every id after it. */
  function pushSaved(s: ThingState): PosedThing {
    const p = pushThing(s.type, { x: s.x, y: s.y, z: s.z }, s.facingDeg, {
      ambush: s.ambush === true,
      dropped: s.dropped === true,
    });
    if (!p) {
      throw new Error(`this WAD set has no art for thing ${s.type} (${tables.THING_SPRITES[s.type] ?? '?'}) the save needs`);
    }
    return p;
  }

  /** `s` over a thing that already carries its type's spawn defaults. */
  function applyThingState(p: PosedThing, s: ThingState): void {
    p.x = s.x;
    p.y = s.y;
    p.z = s.z;
    // Where the crossing test starts from, which `pushThing` seeded at the *map's* spawn point:
    // left there, the first tic after a load tests a segment running all the way from the spawn to
    // here, and a walk line beside the monster that segment happens to pass through fires without
    // it having walked over anything.
    // docs/savegames.md § What is saved and what is deliberately not.
    p.prev.x = s.x;
    p.prev.y = s.y;
    // The save holds a position, never the sector under it, and a thing that existed at spawn
    // still caches its *spawn* sector here. A corpse never moves again, so nothing else would ever
    // re-derive it — and the floor ride below then snaps it to the wrong sector's floor every tic:
    // GoingDown MAP07's terraces, 27 corpses lifted to 88.
    // docs/savegames.md § What is saved and what is deliberately not.
    refreshSector(p);
    p.facingDeg = s.facingDeg;
    // The heading follows the facing it was elided against — the spawn angle underneath is the
    // map's, not this save's, and a monster whose block omits `angle` means "the two agree".
    p.angle = (s.facingDeg * Math.PI) / 180;
    p.ambush = s.ambush === true;
    p.dropped = s.dropped === true;
    p.picked = s.picked === true;
    p.hidden = s.hidden === true;
    p.visible = !p.hidden;
    const m = s.monster;
    if (!m) return;
    // The block is sparse: a key it lacks keeps the spawn default `pushThing` just applied
    // (`copyMonsterField` skips it) — see `MONSTER_FIELD_DEFAULTS`.
    for (const key of MONSTER_SAVE_KEYS) copyMonsterField(p, m, key);
    // `dead` is derived, not saved: every death site sets it exactly when health drops to <= 0.
    // docs/savegames.md § The format and its version.
    p.dead = p.health <= 0;
    // Re-enter the death pose `damageThing` played, on whichever frame `deadTime` says the
    // corpse is holding. `health` keeps its negative overkill in the save precisely so the gib
    // rule inside recomputes the way it did at the time of death.
    if (p.dead) enterDeathPose(p, p.deadTime);
    else restoreAttackPose(p);
  }

  /**
   * Re-enters the pose of an attack still mid-chain when the save was taken, fast-forwarded by how
   * much had already run — `enterDeathPose`'s `deadTime` treatment, for the one transient pose
   * long enough to be worth it. `burstLeft > 0` identifies it and `swinging` says which kind.
   * docs/savegames.md § What is saved and what is deliberately not.
   */
  function restoreAttackPose(p: PosedThing): void {
    if (p.burstLeft <= 0) return;
    const kind = p.swinging ? 'melee' : 'ranged';
    const duration = p.stats?.[kind]?.duration ?? 0;
    // No span to spread the frames over means no way to say where in the pose this save sat, so
    // it keeps the idle frame rather than guessing a rate.
    if (duration <= 0) return;
    enterAttackPose(p, kind, duration, duration - p.attackPause);
  }

  /**
   * Spawns a monster's death drop (`MONSTER_DROPS`) at its own position. Always `dropped: true`,
   * so `tryPickup` grants it at vanilla's halved rate — docs/items.md § Inventory.
   */
  function spawnDrop(at: Pos2, sector: Sector | undefined, facingDeg: number, type: number): void {
    pushThing(type, { x: at.x, y: at.y, z: sector?.floorHeight ?? 0 }, facingDeg, { dropped: true });
  }

  /**
   * The pain elemental's `A_PainShootSkull`: spawns a lost soul in front of `origin` and launches
   * it at whatever `origin` is targeting. Called from `update`'s live `A_PainAttack` and from
   * `damageThing`'s death branch (`A_PainDie`, three at once). The skull cap is **level-wide**,
   * as in vanilla, not per-elemental.
   * docs/monster-ai.md § The pain elemental: spawning a lost soul.
   */
  function spawnLostSoul(origin: PosedThing, angleRad: number): void {
    let skullCount = 0;
    for (const p of posed) if (p.type === ThingType.lostSoul && !p.dead) skullCount++;
    if (skullCount > MAX_SKULLS_ON_LEVEL) return;

    const skullStats = monsterStats[ThingType.lostSoul];
    const skullRadius = skullStats.radius;
    const originRadius = monsterStats[origin.type]?.radius ?? skullRadius;
    // How far in front the skull appears, `A_PainShootSkull`'s
    // `4*FRACUNIT + 3*(actor->info->radius + skullRadius)/2`. Both radii are plain map units
    // here, so the shared scaling factor divides back out.
    const prestep = 4 + 1.5 * (originRadius + skullRadius);
    const x = origin.x + cos(angleRad) * prestep;
    const y = origin.y + sin(angleRad) * prestep;
    const z = origin.z + 8;
    const at = makeCollider({ radius: skullRadius, z, height: skullStats.height, forMonster: true });
    if (world.positionBlocked(x, y, at)) return;

    // Already alerted, with `reactionTicks`/`movecount` pre-zeroed (`pushThing`'s own defaults),
    // so its first chase call rolls straight into its charge — `A_SkullAttack` fires in the same
    // tic it spawns.
    pushThing(ThingType.lostSoul, { x, y, z }, (angleRad * 180) / Math.PI, {
      alerted: true,
      targetId: origin.targetId,
    });
  }

  /**
   * `P_DamageMobj`/`P_KillMobj` for one body — the whole of `ThingLayer.damage`, whose doc has the
   * parameters. Split out from it so `telefragAt` can kill through the same path rather than
   * reaching for an ID it would have to look back up.
   */
  function damageThing(p: PosedThing, amount: number, hit?: DamageHit): void {
    const source = hit?.source;
    const knockUpSpeed = hit?.knockUpSpeed;
    const fromX = hit?.from?.x;
    const fromY = hit?.from?.y;
    const isBarrel = p.type === ThingType.barrel;
    if (p.dead || amount <= 0 || !(isBarrel || p.isMonster)) return;
    // The two AI-less shootables: no stats to roll pain against and no target to retarget, so
    // they take the health subtraction and their own `A_Pain`/`A_Scream` and skip the rest.
    const inert = INERT_SHOOTABLE[p.type];
    p.health -= amount;
    if (inert) {
      if (p.health > 0) {
        // Unconditional, unlike every other monster's: vanilla's painchance here is 256 (Keen)
        // and 255 (the brain).
        if (p.painFrames) p.anim.playOnce(p.painFrames, tables.MONSTER_ACTION_FRAME_SECONDS);
        sfx.play(inert.painSound, inert.unattenuated ? null : p, monsterOrigin(p.id));
        return;
      }
      p.dead = true;
      p.deadTime = 0;
      if (tables.COUNTKILL_TYPES.has(p.type)) stats.kills++;
      const deathFrames = tables.MONSTER_DEATH_FRAMES[p.type];
      p.deathFrameCount = deathFrames ? deathFrames.length : 0;
      sfx.play(inert.deathSound, inert.unattenuated ? null : p, monsterOrigin(p.id));
      if (deathFrames) p.anim.die(deathFrames, tables.MONSTER_DEATH_FRAME_SECONDS);
      // `A_KeenDie`'s tag-666 door and `A_BrainDie`'s level exit both hang off the same
      // all-of-this-type-are-dead scan the ordinary death branch ends with.
      if (DEATH_NOTIFY_TYPES.has(p.type) && posed.every((q) => q.type !== p.type || q.dead)) {
        onBossDeath?.(p.type);
      }
      return;
    }

    if (knockUpSpeed) {
      p.velZ = knockUpSpeed;
      // Nudges z off the floor so `stepMonsterAI`'s airborne check engages next frame, instead
      // of the ground-snap branch zeroing `velZ` before it ever takes effect.
      p.z += 1;
    }
    if (fromX !== undefined && fromY !== undefined) {
      // `P_DamageMobj`'s horizontal thrust — see `thrustSpeed`'s doc.
      const mass = isBarrel ? BARREL_MASS : p.stats?.mass ?? 100;
      const speed = thrustSpeed(amount, mass);
      let dx = p.x - fromX;
      let dy = p.y - fromY;
      const dist = vecLength(dx, dy);
      if (dist < 1) {
        // Attacker and victim essentially coincide (point-blank melee), so there is no direction
        // to push along; vanilla's `R_PointToAngle2(0,0,0,0)` falls back to angle 0 for the same
        // reason. docs/movement.md § Knockback.
        dx = cos(p.angle);
        dy = sin(p.angle);
      } else {
        dx /= dist;
        dy /= dist;
      }
      p.velX += dx * speed;
      p.velY += dy * speed;
    }
    if (p.health > 0) {
      // `MT_BARREL` has no painstate or painchance at all, so a barrel that survives a hit just
      // sits there — no flinch, no wake, no infighting.
      if (isBarrel) return;
      const stats = p.stats;
      if (stats) reactToDamage(p, stats);
      // `reactToDamage` only sets `painTimer` when the stagger roll passed, so a hit that fails
      // it still alerts and retargets but doesn't flinch on screen.
      if (p.painFrames && p.painTimer > 0) {
        p.anim.playOnce(p.painFrames, tables.MONSTER_ACTION_FRAME_SECONDS);
      }
      // `A_Pain` sits on the painstate itself, so the yelp is gated on the same stagger roll as
      // the flinch pose above, not on merely being hit.
      if (p.painTimer > 0 && stats?.sounds.pain) {
        sfx.play(stats.sounds.pain, p, monsterOrigin(p.id));
      }
      // The other event that reshuffles a revenant's guided/unguided personality (see
      // `MonsterBody.homingBias`) — a real pain flinch, same gate as the pose line above.
      if (p.painTimer > 0) p.homingBias = (pRandom() & 1) !== 0;
      // Being hurt always wakes a monster, sight or no — `P_DamageMobj` sets the target
      // unconditionally.
      p.alerted = true;
      // ...and re-points it at whoever did it, which is the whole of infighting. No `source`
      // means the player, who is already the default target. docs/monster-ai.md § Infighting.
      if (source && source.id !== p.id && stats && shouldRetarget(p, p.type, source.type)) {
        p.targetId = source.id;
        commitTarget(p);
      }
      return;
    }
    p.dead = true;
    p.deadTime = 0;
    // `P_KillMobj`'s unconditional `if (target->flags & MF_COUNTKILL) killcount++`, with no
    // "already counted" guard. Barrels never match, so this sits before the barrel branch without
    // needing one of its own. docs/hud.md § Level stats.
    if (tables.COUNTKILL_TYPES.has(p.type)) stats.kills++;
    if (isBarrel) {
      // The splash fires later, once `BARREL_CHAIN.explodeDelaySeconds` elapses in `update`, so
      // `source` is captured now to stay attributable then — see `PosedThing.explodeSource`.
      p.barrelExploded = false;
      p.explodeSource = source ?? null;
      enterDeathPose(p);
      // `MT_BARREL`'s own deathsound. Deliberately on death rather than on `S_BEXP2` where
      // vanilla's `A_Scream` sits: a fifth of a second of silent fireball reads as a bug.
      sfx.play('barexp', p, monsterOrigin(p.id));
      return;
    }
    const gibbed = enterDeathPose(p);
    // `A_Scream`'s death cry, randomized within its family and unattenuated for the two bosses —
    // or `A_XScream`'s wet `slop` for a gib, which the xdeathstate chain plays *instead*.
    const death = gibbed ? 'slop' : p.stats?.sounds.death;
    if (death) {
      sfx.play(randomVariant(death), BOSS_TYPES.has(p.type) ? null : p, monsterOrigin(p.id));
    }

    const dropType = tables.MONSTER_DROPS[p.type];
    if (dropType) spawnDrop(p, p.sector, p.facingDeg, dropType);

    // `A_PainDie`: three more lost souls fanned around the elemental's last facing, fired
    // unconditionally on death whatever attack was under way.
    if (p.type === ThingType.painElemental) {
      spawnLostSoul(p, p.angle + Math.PI / 2);
      spawnLostSoul(p, p.angle + Math.PI);
      spawnLostSoul(p, p.angle + (3 * Math.PI) / 2);
    }

    // `A_BossDeath`'s thinker scan: if any other of this type is still alive, do nothing. Only
    // worth walking `posed` for the types a map's trigger table could care about.
    // docs/death.md § Boss death.
    if (DEATH_NOTIFY_TYPES.has(p.type) && posed.every((q) => q.type !== p.type || q.dead)) {
      onBossDeath?.(p.type);
    }
  }

  /**
   * Integrates one tic of a knocked-back thing's momentum, additive with this tic's AI movement
   * as `P_XYMovement` is with `A_Chase`'s: each axis held to `MAX_MOMENTUM_SPEED`, the move
   * halved until no step exceeds `MOMENTUM_SPLIT_STEP`, and a refused step **stopping dead**
   * rather than sliding. The `blockersFor` thing check is deliberately skipped.
   *
   * A step is refused on geometry *and* on the dropoff rule, because `P_XYMovement` reaches the
   * world through the same `P_TryMove` a monster's walk step does — without that half, a hit
   * shoves a body out over a ledge its own AI would never step onto and `groundFloor` leaves it
   * standing on air. docs/movement.md § Knockback.
   */
  function applyKnockback(p: PosedThing, dt: number): void {
    // This exact state already proved blocked and nothing stamped nearby has changed, so replay
    // the outcome without re-deriving it. A belt-pinned closet monster hits this every tic.
    // docs/movement.md § Pinned-body memo.
    if (world.pinMatches(p.pinned, p.x, p.y, p.z, p.velX, p.velY)) {
      p.velX = 0;
      p.velY = 0;
      return;
    }
    p.velX = clampMomentum(p.velX);
    p.velY = clampMomentum(p.velY);
    const startX = p.x;
    const startY = p.y;
    let moveX = p.velX * dt;
    let moveY = p.velY * dt;
    knockbackCollider.radius = p.blockRadius;
    knockbackCollider.z = p.z;
    knockbackCollider.height = p.bodyHeight;
    // Vanilla's two exemptions from the dropoff rule: `MF_FLOAT`, and the `MF_DROPOFF` `P_KillMobj`
    // hands every corpse (`p_inter.c`) so a gibbed body still slides off whatever it died on.
    const holdsLedge = !p.dead && !p.stats?.flies;
    do {
      let stepX = moveX;
      let stepY = moveY;
      if (Math.abs(moveX) > MOMENTUM_SPLIT_STEP || Math.abs(moveY) > MOMENTUM_SPLIT_STEP) {
        stepX /= 2;
        stepY /= 2;
      }
      moveX -= stepX;
      moveY -= stepY;
      // `stopOnBlock`: a refused walk leaves the heights half-accumulated, which is exactly the
      // case that never reads them.
      const dest = world.checkPosition(p.x + stepX, p.y + stepY, knockbackCollider, true, knockbackDest);
      if (dest.blocked || (holdsLedge && overDropoff(p, dest))) {
        // The memo replays "nothing moved", which is only what happened when the first step
        // was the one refused.
        if (p.x === startX && p.y === startY) {
          world.capturePin(p.pinned, p.x, p.y, p.z, p.velX, p.velY, p.blockRadius, dt);
        } else {
          p.pinned.active = false;
        }
        p.velX = 0;
        p.velY = 0;
        return;
      }
      p.x += stepX;
      p.y += stepY;
    } while (moveX !== 0 || moveY !== 0);
    p.pinned.active = false;
    const decay = decayOverTics(FRICTION, dt);
    p.velX *= decay;
    p.velY *= decay;
    if (Math.abs(p.velX) < KNOCKBACK_STOP_SPEED) p.velX = 0;
    if (Math.abs(p.velY) < KNOCKBACK_STOP_SPEED) p.velY = 0;
  }

  /**
   * Whether the dropoff rule refuses the momentum step `dest` describes, against where `p` stands
   * now. The gate is what keeps the standing walk off every shove that isn't near a ledge — both
   * halves are `world.ts`'s, shared with the monster walk step.
   */
  function overDropoff(p: PosedThing, dest: PositionCheck): boolean {
    if (!mayHitDropoff(p.z, dest)) return false;
    return dropoffRefuses(world.checkPosition(p.x, p.y, knockbackCollider, false, knockbackStanding), dest);
  }

  /**
   * Puts a thing down where a walk-line teleport sent it, height included: the arrival floor for a
   * loud teleport, the departure height above the floor for a silent one. Momentum follows the two
   * arrivals — zeroed outright, or rotated by the angle the body turned (`TeleportDest.rotateBy`).
   * docs/specials-teleporters.md § Silent and line-to-line teleporters.
   */
  function arriveAt(p: PosedThing, dest: TeleportDest): void {
    // Read before the move and reapplied after: a silent arrival preserves the height above the
    // floor, and this layer is the only place it can be measured (`TeleportDest.silent`).
    const aboveFloor = dest.silent ? p.z - world.groundFloor(p.x, p.y, p.blockRadius, true) : 0;
    grid.markDisplaced(p);
    p.x = dest.x;
    p.y = dest.y;
    p.angle = dest.angle;
    // `EV_Teleport`'s own `thing->z = thing->floorz` — the *arrival* floor. Without it a body
    // keeps the departure height and falls the difference, which reads as a monster closet
    // dropping its monsters out of the sky.
    p.z = world.groundFloor(p.x, p.y, p.blockRadius, true) + aboveFloor;
    if (dest.rotateBy === undefined) {
      p.velX = 0;
      p.velY = 0;
      p.velZ = 0;
    } else {
      const turnCos = cos(dest.rotateBy);
      const turnSin = sin(dest.rotateBy);
      const vx = p.velX;
      const vy = p.velY;
      p.velX = vx * turnCos - vy * turnSin;
      p.velY = vx * turnSin + vy * turnCos;
    }
    // Collapse the interpolation window onto the arrival point, or the thing is drawn gliding
    // across the whole map over one tic. docs/frameloop.md § Interpolation.
    p.drawPrevX = p.x;
    p.drawPrevY = p.y;
    p.drawPrevZ = p.z;
    // Re-route from scratch: the heading it had is meaningless on the far side of the map.
    p.movedir = DI_NODIR;
    p.movecount = 0;
  }

  /**
   * The walk lines a thing crossed while the *world* moved it — a conveyor's carry, or a
   * knockback — as opposed to walking there itself. `P_CrossSpecialLine` fires for **every**
   * non-player mobj that moves, so a barrel riding a conveyor over a line teleporter really does
   * teleport. docs/specials-forces.md § Scrollers and conveyors.
   */
  function crossAfterPush(
    p: PosedThing,
    fromX: number,
    fromY: number,
    cross: ((prev: Pos2, mover: CrossingBody) => TeleportDest | null) | undefined,
  ): void {
    if (!cross || (p.x === fromX && p.y === fromY)) return;
    pushedFrom.x = fromX;
    pushedFrom.y = fromY;
    const dest = cross(pushedFrom, p);
    if (dest) arriveAt(p, dest);
  }

  /**
   * `applyKnockback` plus its aftermath, for a body with no AI walk of its own: fire whatever
   * lines the push crossed, then re-derive the sector — but only when the body actually went
   * somewhere, since a blocked push moved nothing and the BSP descent would answer what
   * `p.sector` already says.
   */
  function pushAndSettle(
    p: PosedThing,
    dt: number,
    cross: ((prev: Pos2, mover: CrossingBody) => TeleportDest | null) | undefined,
  ): void {
    const fromX = p.x;
    const fromY = p.y;
    applyKnockback(p, dt);
    crossAfterPush(p, fromX, fromY, cross);
    if (p.x !== fromX || p.y !== fromY) {
      refreshSector(p);
    }
  }

  /**
   * Re-derives the sector fields a thing that moved is now standing in. One BSP descent for both:
   * `sectorAt` would walk the tree again to reach the sector this subsector already names.
   */
  function refreshSector(p: PosedThing): void {
    // A chase step already resolved the leaf it landed on (`adoptStanding`); only a body that
    // reached this position some other way — knockback, a teleport — still descends.
    if (p.sectorX !== p.x || p.sectorY !== p.y) {
      p.subsector = world.subsectorAt(p.x, p.y);
      p.sectorX = p.x;
      p.sectorY = p.y;
    }
    p.sector = world.sectorOfSubsector(p.subsector);
  }

  /**
   * Where a monster should currently be heading, or `null` if it has nobody left to want.
   * `targetId` names a monster only after something other than a player hurt it
   * (`damageThing` → `shouldRetarget`), and a target that dies hands attention straight back to
   * player 1, as `A_Chase` does via `P_LookForPlayers`. A dead player is a null slot, so a monster
   * with no *other* target finds nobody. docs/monster-ai.md § Infighting.
   */
  function resolveTarget(p: PosedThing, players: readonly (Pos3 | null)[]): Pos3 | null {
    if (p.targetId < 0) return players[slotOfTarget(p.targetId)] ?? null;
    const other = posed[p.targetId];
    if (!other || other.dead) {
      p.targetId = targetOfSlot(0);
      p.threshold = 0;
      return players[0] ?? null;
    }
    return other;
  }

  /**
   * `A_VileChase`'s resurrection branch: restores a corpse to full health and rejoins combat
   * immediately, with no "coming back to life" delay. `attackPause` is set to the raise
   * animation's length, so `stepMonsterAI`'s existing "don't walk or attack while `attackPause`
   * runs" gate holds the monster still until it finishes.
   * docs/monster-archvile.md § Resurrection.
   */
  function reviveCorpse(p: PosedThing): void {
    // Deliberate deviation: a raised monster adds one to the level's kill *total*, following
    // ZDoom's `AActor::Revive` ("[RH] If it's a monster, it gets to count as another kill",
    // `p_mobj.cpp`) rather than vanilla, which adjusts neither counter and reads over 100%.
    // docs/hud.md § Level stats.
    if (tables.COUNTKILL_TYPES.has(p.type)) stats.totalKills++;
    p.dead = false;
    p.health = tables.MONSTER_HEALTH[p.type] ?? p.health;
    p.hidden = false;
    // A crunched corpse is raisable in vanilla too, and comes back at its own full size here —
    // vanilla's own raise leaves it at the zeroed radius/height `PIT_ChangeSector` wrote, which is
    // where its ghost monsters come from. docs/specials-crushers.md § Crushed corpses.
    p.crushed = false;
    // Clears any stale knockback velocity from however it died: it would otherwise sit unread
    // for the rest of the level and then jump on revival.
    p.velX = 0;
    p.velY = 0;
    p.velZ = 0;
    p.alerted = true; // the raisestate falls straight through to RUN1 — chasing, not dormant
    p.targetId = targetOfSlot(0); // vanilla's `corpsehit->target = NULL`; `resolveTarget` falls back
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
    p.swinging = false;
    p.chargeTimer = 0;
    p.painTimer = 0;
    p.inFloat = false;
    p.attackPause = (p.raiseFrames?.length ?? 0) * tables.MONSTER_DEATH_FRAME_SECONDS;
    // `A_VileChase` plays `slop` on the corpse as it comes back up — the same sound a gib death
    // makes, which is why a resurrection sounds like one played backwards.
    sfx.play('slop', p, monsterOrigin(p.id));
    p.anim.revive();
    if (p.raiseFrames) p.anim.playOnce(p.raiseFrames, tables.MONSTER_DEATH_FRAME_SECONDS);
  }

  /**
   * `P_NightmareRespawn` (`p_mobj.c`): puts a corpse back at its own spawn point as a fresh,
   * dormant monster, with a teleport fog at both ends. Returns false and changes nothing when
   * something already occupies the spawn point. The corpse is *reused* rather than removed and
   * replaced, so its `id` — and every saved `targetId` pointing at it — survives.
   * docs/monster-ai.md § Respawning monsters.
   */
  function respawnCorpse(p: PosedThing, players: readonly (Pos3 | null)[]): boolean {
    const sector = world.sectorAt(p.spawnX, p.spawnY);
    // The same ceiling-hung measurement the spawn loop makes, and for the same reason; vanilla
    // splits it as `ONCEILINGZ`/`ONFLOORZ` right here in `P_NightmareRespawn`.
    const hangHeight = p.hangHeight;
    const z = hangHeight !== undefined ? (sector?.ceilHeight ?? 0) - hangHeight : (sector?.floorHeight ?? 0);

    // `solidBodies` skips the dead, so the corpse itself never blocks its own return; the players
    // aren't in `posed` at all and have to be added by hand.
    const blockers = grid.solidBodies({ x: p.spawnX, y: p.spawnY });
    for (const player of players) {
      if (player) blockers.push({ x: player.x, y: player.y, z: player.z, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
    }
    const at = makeCollider({ radius: p.blockRadius, z, height: p.bodyHeight, forMonster: true, blockers });
    if (world.positionBlocked(p.spawnX, p.spawnY, at)) return false;

    onRespawn?.({ x: p.x, y: p.y, z: p.sector?.floorHeight ?? p.z }, { x: p.spawnX, y: p.spawnY, z });

    p.x = p.spawnX;
    p.y = p.spawnY;
    p.z = z;
    // Across the map in one tic, so the interpolation window collapses onto the arrival — the
    // same reason `arriveAt` does it. docs/frameloop.md § Interpolation.
    p.drawPrevX = p.x;
    p.drawPrevY = p.y;
    p.drawPrevZ = p.z;
    p.sector = sector;
    p.subsector = world.subsectorAt(p.x, p.y);
    p.facingDeg = p.spawnAngle;
    p.angle = (p.spawnAngle * Math.PI) / 180;

    p.dead = false;
    p.deadTime = 0;
    p.health = tables.MONSTER_HEALTH[p.type] ?? p.health;
    p.hidden = false;
    p.crushed = false;
    p.velX = 0;
    p.velY = 0;
    p.velZ = 0;
    // Dormant again, unlike an arch-vile's raise: the monster respawns into its *spawnstate* and
    // has to catch sight of the player all over again, `isAmbush` included.
    p.alerted = false;
    p.targetId = targetOfSlot(0);
    p.movedir = DI_NODIR;
    p.movecount = 0;
    p.chaseTimer = 0;
    p.moveBlocked = false;
    p.threshold = 0;
    p.justHit = false;
    p.justAttacked = false;
    p.refiring = false;
    p.burstLeft = 0;
    p.burstTimer = 0;
    p.swinging = false;
    p.chargeTimer = 0;
    p.painTimer = 0;
    p.attackPause = 0;
    p.inFloat = false;
    // Deliberately not vanilla's additional `reactiontime = 18`: the hesitation is seeded when a
    // monster *wakes* (`tryWake`'s `REACTION_CHASES`) rather than when it spawns, so anything
    // written here is overwritten the moment this one notices anyone.
    p.reactionTicks = 0;
    p.anim.revive();
    return true;
  }

  /**
   * Whether a killable thing is still in its exact spawn state, in which case the save needs no
   * `MonsterFields` block at all: the restore's own `pushThing` recreates those defaults. Alerted,
   * damaged, moving or dead all disqualify; `homingBias` is deliberately ignored.
   * docs/savegames.md § Storage, and docs/dehacked.md § Savegames and patched tables for why
   * reading `spawnHealthFor` here stays safe under a patch.
   */
  function isPristine(p: PosedThing): boolean {
    return (
      !p.dead &&
      !p.alerted &&
      p.health === spawnHealthFor(p.type, p.dropped) &&
      p.targetId === targetOfSlot(0) &&
      p.velX === 0 &&
      p.velY === 0 &&
      p.velZ === 0
    );
  }

  return {
    group,
    count: posed.length,
    missingArt: [...missingArt],
    stats,
    snapshot: snapshotThings,
    solidBodies: grid.solidBodies,
    telefragAt,
    update,
    draw,
    dispose,
    tryPickup,
    pickMonster,
    monstersNear,
    monstersAlongStep,
    monsterById,
    drawnFrameKey,
    bleeds,
    awakeMonsterCount,
    awakeMonsters,
    monstersInSectors,
    crushablesInSectors,
    corpsesInSectors,
    crushCorpse,
    damage,
    spawnMonster,
    raycastMonster,
  };
}

/**
 * A fresh thing's hit points: `MT_BARREL`'s own spawnhealth, this type's `MONSTER_HEALTH`, or
 * `Infinity` for anything that can never be killed. Shared by `pushThing`, which seeds it, and
 * `isPristine`, which asks whether a thing is still sitting on it.
 */
function spawnHealthFor(type: number, dropped: boolean): number {
  if (type === ThingType.barrel) return BARREL_HEALTH;
  return dropped ? Infinity : tables.MONSTER_HEALTH[type] ?? Infinity;
}

/**
 * Whether a thing is exactly as its spawn record holds it, field by field — what the sparse
 * snapshot elides on. The monster block is the rare case (a wounded or dead thing) and compares
 * serialized; everything else is a scalar.
 */
function sameThingState(a: ThingState, b: ThingState): boolean {
  if (a.type !== b.type || a.x !== b.x || a.y !== b.y || a.z !== b.z || a.facingDeg !== b.facingDeg) return false;
  if (a.picked !== b.picked || a.hidden !== b.hidden || a.dropped !== b.dropped || a.ambush !== b.ambush) return false;
  if (a.monster === undefined || b.monster === undefined) return a.monster === b.monster;
  return JSON.stringify(a.monster) === JSON.stringify(b.monster);
}

/**
 * Puts `p` into the death pose it should be holding: the barrel's `BEXP` chain, otherwise
 * `P_KillMobj`'s overkill-gib rule off its already-negative `health`, or permanent hiding when the
 * WAD set carries no death art. Sets `deathFrameCount` and returns whether the gib chain played,
 * which is what picks the death sound; `deadTime` fast-forwards a corpse restored from a save.
 *
 * The single owner of that gib rule — `damageThing` and `restoreThings` both come through here, so
 * a corpse can't look different after a load than before it. docs/death.md § Monster death.
 */
function enterDeathPose(p: PosedThing, deadTime = 0): boolean {
  if (p.type === ThingType.barrel) {
    p.deathFrameCount = BARREL_CHAIN.deathFrames.length;
    p.anim.die(BARREL_CHAIN.deathFrames, BARREL_CHAIN.deathFrameSeconds, BARREL_CHAIN.deathSprite);
    if (deadTime > 0) p.anim.advance(deadTime, false);
    return false;
  }
  if (p.crushed) {
    // Whatever it died of, a plane has since crunched it flat — one held `S_GIBS` frame, and the
    // pose a save restores to. docs/specials-crushers.md § Crushed corpses.
    p.deathFrameCount = tables.CORPSE_GIB.frames.length;
    p.anim.die(tables.CORPSE_GIB.frames, tables.MONSTER_DEATH_FRAME_SECONDS, tables.CORPSE_GIB.sprite);
    return false;
  }
  const maxHealth = tables.MONSTER_HEALTH[p.type] ?? 0;
  const gibbed = p.health < -maxHealth && tables.MONSTER_XDEATH_FRAMES[p.type];
  const frames = gibbed || tables.MONSTER_DEATH_FRAMES[p.type];
  p.deathFrameCount = frames ? frames.length : 0;
  if (frames) {
    // A patched death chain may borrow another type's sprite (docs/dehacked.md § Frames); the
    // stock roster has no entry here and dies in its own.
    const sprite = tables.MONSTER_DEATH_SPRITE_OVERRIDE[p.type];
    p.anim.die(frames, tables.MONSTER_DEATH_FRAME_SECONDS, gibbed ? sprite?.xdeath : sprite?.death);
    if (deadTime > 0) p.anim.advance(deadTime, false);
  } else {
    p.hidden = true;
    p.visible = false;
  }
  return Boolean(gibbed);
}

/**
 * Puts a monster into the pose for `kind`, spanning `spanSeconds` and optionally fast-forwarded
 * onto the frame `elapsed` seconds in, which is how a savegame taken mid-attack resumes.
 * `enterDeathPose`'s single-owner property too: the live trigger and the restore path must not
 * derive the same pose two ways.
 *
 * Entered when the attack *starts*, never when its shot lands.
 * docs/sprites.md § Pain, and attack/pain poses.
 */
function enterAttackPose(p: PosedThing, kind: 'melee' | 'ranged', spanSeconds: number, elapsed = 0): void {
  // A type with only the other kind of pose lends it: the cacodemon bites from its missile chain.
  const pose = p.attackPose?.[kind] ?? p.attackPose?.[kind === 'melee' ? 'ranged' : 'melee'];
  if (!pose) return;
  p.anim.playOnce(pose.frames, tables.attackPoseFrameSeconds(pose, spanSeconds));
  if (elapsed > 0) p.anim.advance(elapsed, false);
}

/**
 * The first of the three `refsIn` predicates: a monster — what a lowering ceiling measures itself
 * against, over `refsIn`'s living bodies. All three are module-level so a query allocates no
 * closure, and separate because each says something different about what its caller is asking for.
 */
const isMonsterType = (p: PosedThing): boolean => p.isMonster;

/**
 * Anything a crusher can damage: a living monster or a still-standing barrel, matching
 * `PIT_ChangeSector` treating any shootable mobj alike. docs/specials-crushers.md § Crushers.
 */
const isCrushableType = (p: PosedThing): boolean => p.isMonster || p.type === ThingType.barrel;

/**
 * A corpse a plane could still crunch. `hidden` is checked here and in neither predicate above: a
 * corpse that died with no death art is drawn as nothing, so there is nothing to turn into a pool.
 * The only *living* things `hidden` marks are consumed pickups, which both live predicates already
 * exclude by type. docs/specials-crushers.md § Crushed corpses.
 */
const isSquashableCorpse = (p: PosedThing): boolean => !p.crushed && !p.hidden && p.isMonster;

/**
 * The `MonsterRef` view of `p` — what every query on `ThingLayer` hands back instead of the
 * `PosedThing` itself, so nothing outside this file can mutate a body it merely looked up.
 */
function monsterRef(p: PosedThing): MonsterRef {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    z: p.z,
    type: p.type,
    angle: p.angle,
    radius: p.blockRadius,
    height: p.bodyHeight,
  };
}

/** The first slot whose player is still alive, or null with none — `update`'s wake-check player. */
function firstLiving(players: readonly (Pos3 | null)[]): Pos3 | null {
  for (const player of players) if (player) return player;
  return null;
}
