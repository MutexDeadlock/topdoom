/**
 * `ThingLayer`: every live map thing — spawning by skill, pickups, damage and death, waking and
 * stepping monster AI, barrels, corpse raising — drawn through the shared sprite batch. The
 * record shapes and tables live in `things/defs.ts` and `things/tables.ts`. See docs/sprites.md,
 * docs/items.md, docs/monster-ai.md and docs/death.md.
 */
import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { SectorTouchCache, World } from './world.ts';
import { GRAVITY, PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
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
  type CrossingBody,
  type LevelKillItemStats,
  type MonsterRef,
  type PosedThing,
  type StandingBody,
  type ThingLayer,
  type ThingUpdateResult,
} from './things/defs.ts';
export {
  // Re-exported so `./things.ts` stays the thing layer's one public entry
  // point for the rest of the engine — `game.ts` and `combat.ts` have no
  // reason to know which file inside `things/` a type happens to live in.
  bodiesOverlap,
  monstersTelefrag,
  TELEFRAG_DAMAGE,
  type BarrelExplosion,
  type CrossingBody,
  type MonsterRef,
  type StandingBody,
  type ThingLayer,
} from './things/defs.ts';
import {
  attackPoseFrameSeconds,
  CEILING_HUNG_HEIGHT,
  COUNTITEM_TYPES,
  COUNTKILL_TYPES,
  FULLBRIGHT_FRAMES,
  FUZZ_TYPES,
  MONSTER_ACTION_FRAME_SECONDS,
  MONSTER_ATTACK_POSE,
  MONSTER_CORPSE_VANISHES,
  MONSTER_DEATH_FRAME_SECONDS,
  MONSTER_DEATH_FRAMES,
  MONSTER_DEATH_SPRITE_OVERRIDE,
  MONSTER_DROPS,
  MONSTER_HEALTH,
  MONSTER_IDLE_FRAMES,
  MONSTER_PAIN_FRAMES,
  MONSTER_WALK_FRAMES,
  MONSTER_WALK_FRAMES_OVERRIDE,
  MONSTER_RAISE_FRAMES,
  MONSTER_TYPES,
  MONSTER_XDEATH_FRAMES,
  NO_AUTO_AIM_TYPES,
  SOLID_DECORATION_RADIUS,
  SOLID_DECORATION_RADIUS_OVERRIDE,
  SOLID_DECORATION_TYPES,
  THING_ANIM_FRAMES,
  THING_SPRITES,
} from './things/tables.ts';
import { ThingType } from './things/doomednums.ts';
import { fastMonsters, isAmbush, isMultiplayerOnly, respawnMonsters, spawnAngleDeg, spawnsAtSkill, type Skill } from './skill.ts';
import {
  DI_NODIR,
  MONSTER_FIRE_HEIGHT,
  BODY_HEIGHT_FALLBACK,
  MONSTER_HIT_RADIUS,
  thrustSpeed,
  type MonsterAttackEvent,
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
import { makePinnedMemo, makeTouchCache } from './world.ts';
import { transfersOf } from './specials/transfers.ts';
import { monsterOrigin, randomVariant, SILENT, type SoundEmitter } from '../audio/sfx.ts';
import {
  BILLBOARD_MAX_REACH,
  intersectBillboard,
  SpriteAnimator,
  SpriteMaterialCache,
  VIEWER_ANGLE_DEG,
} from '../render/sprites.ts';
import { SpriteBatch } from '../render/spritebatch.ts';
import { doomToWorld, litColor } from '../render/mapmesh.ts';
import type { DynamicLights } from '../render/lights.ts';
import { blastDistanceToBox, boxReach, segmentEntersBox, traceHitsBox } from '../util/geom.ts';
import type { Pos2, Pos3 } from '../types.ts';
import type { TeleportDest } from './specials.ts';
import { thingStatsPatched } from './dehacked/apply.ts';

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
 * How often an unalerted monster re-checks line of sight to the player —
 * vanilla's own idle `A_Look` calls run every 10 tics (~0.29s), not every tic.
 */
const LOOK_INTERVAL = 0.3;

/**
 * How long a corpse has to lie still before a nightmare respawn will even roll for it —
 * `P_MobjThinker`'s `if (mobj->movecount < 12*35) return;`, i.e. 12 seconds. The roll itself is
 * only reached every 32nd tic and then passes 5 times in 256, so the wait in practice is closer to
 * a minute. docs/monster-ai.md § Respawning monsters.
 */
const NIGHTMARE_RESPAWN_DELAY = 12 * 35 * DOOM_TIC;

/** `leveltime & 31` — how often `P_MobjThinker` rolls for a respawn at all, level-wide rather than per corpse. */
const RESPAWN_ROLL_INTERVAL_TICS = 32;

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

/**
 * A fresh thing's hit points: `MT_BARREL`'s own spawnhealth, this type's
 * `MONSTER_HEALTH`, or `Infinity` for anything that can never be killed —
 * a monster's own dropped item included. Shared by `pushThing`, which seeds it,
 * and `isPristine`, which asks whether a thing is still sitting on it.
 */
function spawnHealthFor(type: number, dropped: boolean): number {
  if (type === ThingType.barrel) return BARREL_HEALTH;
  return dropped ? Infinity : MONSTER_HEALTH[type] ?? Infinity;
}

/**
 * Puts `p` into the death pose it should be holding: the barrel's own `BEXP`
 * chain, otherwise `P_KillMobj`'s overkill-gib rule off its (already negative)
 * `health`, and permanent hiding for a type the WAD set has no death art for.
 * Sets `deathFrameCount` and returns whether the gib chain was the one played,
 * which is what picks the death sound. `deadTime` fast-forwards the animation,
 * for a corpse being restored from a savegame that died some time ago.
 *
 * The single owner of that gib rule — `damageThing` and `restoreThings` both
 * come through here, so a corpse can't look different after a load than it did
 * before it. docs/death.md § Monster death.
 */
function enterDeathPose(p: PosedThing, deadTime = 0): boolean {
  if (p.type === ThingType.barrel) {
    p.deathFrameCount = BARREL_CHAIN.deathFrames.length;
    p.anim.die(BARREL_CHAIN.deathFrames, BARREL_CHAIN.deathFrameSeconds, BARREL_CHAIN.deathSprite);
    if (deadTime > 0) p.anim.advance(deadTime, false);
    return false;
  }
  const maxHealth = MONSTER_HEALTH[p.type] ?? 0;
  const gibbed = p.health < -maxHealth && MONSTER_XDEATH_FRAMES[p.type];
  const frames = gibbed || MONSTER_DEATH_FRAMES[p.type];
  p.deathFrameCount = frames ? frames.length : 0;
  if (frames) {
    // A patched death chain may borrow another type's sprite (docs/dehacked.md § Frames); the
    // stock roster has no entry here and dies in its own.
    const sprite = MONSTER_DEATH_SPRITE_OVERRIDE[p.type];
    p.anim.die(frames, MONSTER_DEATH_FRAME_SECONDS, gibbed ? sprite?.xdeath : sprite?.death);
    if (deadTime > 0) p.anim.advance(deadTime, false);
  } else {
    p.hidden = true;
    p.visible = false;
  }
  return Boolean(gibbed);
}

/**
 * Puts a monster into the pose for `kind`, spanning `spanSeconds` — the length of the attack it
 * poses for — and optionally fast-forwarded onto the frame `elapsed` seconds in, which is how a
 * savegame taken mid-attack resumes. `enterDeathPose`'s shape and, more importantly, its
 * single-owner property: the live trigger and the restore path must not derive the same pose two
 * ways.
 *
 * Entered when the attack *starts*, never when its shot lands: with a real windup
 * (`AttackStats.startDelaySeconds`) the firing frame is mid-pose, so a pose started at the shot
 * would show the wind-up frame under the bullet. The caller's `anim.posing` guard is what keeps a
 * volley's later shots inside the pose they are already in — where vanilla's own proportions
 * (`attackPoseFrameSeconds`) put each of them on its firing frame.
 * docs/sprites.md § Pain, and attack/pain poses.
 */
function enterAttackPose(p: PosedThing, kind: 'melee' | 'ranged', spanSeconds: number, elapsed = 0): void {
  // A type with only the other kind of pose lends it: the cacodemon bites from its missile chain.
  const pose = p.attackPose?.[kind] ?? p.attackPose?.[kind === 'melee' ? 'ranged' : 'melee'];
  if (!pose) return;
  p.anim.playOnce(pose.frames, attackPoseFrameSeconds(pose, spanSeconds));
  if (elapsed > 0) p.anim.advance(elapsed, false);
}

/** `litColor(255)`, hoisted: the tint every `FULLBRIGHT_FRAMES` sprite draws at, whatever its sector. */
const LIT_FULL = litColor(255);

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
   * alive — vanilla's `A_BossDeath` gate, see docs/death.md § Boss death. Just the doomednum:
   * whether/how it matters is entirely `SpecialsController`'s per-map table to decide.
   */
  onBossDeath?: (type: number) => void,
  /**
   * A savegame's saved thing list. When present the map's own spawn loop is
   * skipped entirely and every thing is rebuilt from the save in order —
   * restore lives here as a parameter rather than a `ThingLayer` method
   * because things can only be built through `pushThing`, which exists only
   * inside this closure. docs/savegames.md § Apply order.
   */
  restore?: ThingsSnapshot,
  /**
   * The two teleport fogs a nightmare respawn leaves behind, at the corpse's spot and at the spawn
   * point it returns to — `P_NightmareRespawn`'s own pair of `MT_TFOG`s, each with its `telept`.
   * A callback because the fog layer belongs to `game.ts`, exactly as `onBossDeath` above is.
   */
  onRespawn?: (from: Pos3, to: Pos3) => void,
  /**
   * The frame's dynamic lights, if any (docs/lights.md). Every drawn thing offers its frame key
   * here — a torch and a firing monster are emitters — and samples the light reaching it back as
   * a tint. A session with lights off passes none and nothing below runs.
   */
  lights?: DynamicLights,
): ThingLayer {
  /**
   * The stat table this level runs on: nightmare swaps in the fast-monster one, which vanilla
   * produces by editing its global tables at `G_InitNew`. Resolved once here rather than per
   * lookup, and read by every site below that would otherwise name `MONSTER_STATS` directly.
   * docs/monster-ai.md § Fast monsters.
   */
  const monsterStats = monsterStatsFor(fastMonsters(skill));
  /** Whether killed monsters come back at all — nightmare only, see `respawnCorpse`. */
  const respawns = respawnMonsters(skill);
  const batch = new SpriteBatch();
  /**
   * Monster death drops draw through their own batch, which is what lets them
   * carry `DROP_DEPTH_BIAS` and a pulsing batch-wide opacity that the rest of
   * the map's things must not get. No extra draw calls: batching is per-lump
   * anyway and a drop never shares a lump with a monster.
   */
  const dropBatch = new SpriteBatch({ depthBias: DROP_DEPTH_BIAS, translucent: true });
  /**
   * The spectre and nothing else (`FUZZ_TYPES`): same art as the demon, drawn
   * through vanilla's `MF_SHADOW` fuzz instead of plainly.
   * docs/sprites.md § The spectre's fuzz.
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
  // Sprite light is the average of the sector's drawn floor and ceiling light
  // (`R_AddSprites`), which a Boom transfer can source from another sector
  // entirely — docs/specials.md § Transferred lighting.
  const transfers = transfersOf(map);

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
   * `P_SpawnMapThing`'s own level totals, raised only by the map-load loop and
   * — by deliberate deviation — by `reviveCorpse` (docs/hud.md § Level stats).
   */
  function pushThing(
    type: number,
    at: Pos3,
    facingDeg: number,
    opts?: { ambush?: boolean; dropped?: boolean; alerted?: boolean; targetId?: number | null },
  ): PosedThing | null {
    const spriteName = THING_SPRITES[type];
    if (!spriteName) return null;
    const isBarrel = type === ThingType.barrel;
    const itemAnim = THING_ANIM_FRAMES[type];
    // A monster walks, a barrel sways, an item blinks — and the two AI-less
    // monsters hold a spawnstate frame of their own (see MONSTER_IDLE_FRAMES).
    const animFrames = MONSTER_TYPES.has(type)
      ? (MONSTER_IDLE_FRAMES[type] ?? MONSTER_WALK_FRAMES_OVERRIDE[type] ?? MONSTER_WALK_FRAMES)
      : isBarrel
        ? BARREL_CHAIN.idleFrames
        : itemAnim
          ? itemAnim.frames
          : ['A'];
    const frameSeconds = isBarrel ? BARREL_CHAIN.idleFrameSeconds : itemAnim ? itemAnim.frameSeconds : undefined;
    const anim = new SpriteAnimator(bank, materials, spriteName, animFrames, frameSeconds);
    // Resolved once, here: a thing whose art this WAD set doesn't carry is
    // skipped rather than spawned pointing at a missing lump.
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
            monsterStats[type]?.radius ?? INERT_SHOOTABLE[type]?.radius ?? MONSTER_HIT_RADIUS,
      // Same resolution order and the same reason as `blockRadius` above.
      bodyHeight: isBarrel
        ? BARREL_HEIGHT
        : (monsterStats[type]?.height ?? INERT_SHOOTABLE[type]?.height ?? BODY_HEIGHT_FALLBACK),
      attackPose: MONSTER_ATTACK_POSE[type],
      painFrames: MONSTER_PAIN_FRAMES[type],
      raiseFrames: MONSTER_RAISE_FRAMES[type],
      // Every AI/damage field the save can elide, straight from the table the
      // snapshot compares against — one definition of "spawn state", so the two
      // can't drift (see MONSTER_FIELD_DEFAULTS). The `opts`-driven and
      // per-type ones below override it.
      ...MONSTER_FIELD_DEFAULTS,
      deathFrameCount: 0,
      visible: true,
      hidden: false,
      queryStamp: 0,
      touch: makeTouchCache(),
      pinned: makePinnedMemo(),
      x,
      y,
      z,
      // A fresh thing has nowhere to interpolate from but where it is, so its
      // first drawn frame sits still instead of sliding in from the origin.
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
      targetId: opts?.targetId ?? null,
    };
    posed.push(thing);
    return thing;
  }

  /**
   * Doomednums the map places that this WAD *set* has no art for, so
   * `pushThing` dropped them — reported once at level load beside the missing
   * textures. Silently vanishing is the right behavior (vanilla `I_Error`s at
   * startup instead, which is worse), but a monster that simply isn't there
   * with nothing said is unexplainable from the outside: shareware `DOOM1.WAD`
   * carries no `HEAD` lumps at all, so a PWAD placing a cacodemon on it loses
   * it. Sprite name included because that is what to grep the WAD for.
   */
  const missingArt = new Set<string>();

  /**
   * Rebuilds every saved thing in order through `pushThing`, then overwrites
   * the fields the simulation had mutated. Ids are positional, so a type whose
   * art this WAD set lacks is a hard error — silently skipping it (the spawn
   * loop's behavior) would shift every later id and desync all saved
   * cross-thing references. A dead thing's death pose is replayed and
   * fast-forwarded by its own `deadTime`; a transient pain/attack pose is not
   * (docs/savegames.md § What is saved and what is deliberately not).
   */
  function restoreThings(saved: ThingsSnapshot): void {
    clock = saved.clock;
    stats.totalKills = saved.stats.totalKills;
    stats.kills = saved.stats.kills;
    stats.totalItems = saved.stats.totalItems;
    stats.items = saved.stats.items;
    for (const s of saved.things) {
      const p = pushThing(s.type, { x: s.x, y: s.y, z: s.z }, s.facingDeg, {
        ambush: s.ambush === true,
        dropped: s.dropped === true,
      });
      if (!p) {
        throw new Error(`this WAD set has no art for thing ${s.type} (${THING_SPRITES[s.type] ?? '?'}) the save needs`);
      }
      p.picked = s.picked === true;
      p.hidden = s.hidden === true;
      p.visible = !p.hidden;
      const m = s.monster;
      if (!m) continue;
      // The block is sparse: a key it lacks keeps the spawn default `pushThing`
      // just applied (`copyMonsterField` skips it) — see MONSTER_FIELD_DEFAULTS.
      for (const key of MONSTER_SAVE_KEYS) copyMonsterField(p, m, key);
      // `dead` is derived, not saved: every death site sets it exactly when
      // health drops to <= 0, and `reviveCorpse` restores positive health when
      // clearing it (docs/savegames.md § The format and its version).
      p.dead = p.health <= 0;
      // Re-enter the death pose `damageThing` played, fast-forwarded onto
      // whichever frame `deadTime` says the corpse is holding. `health` keeps
      // its negative overkill in the save precisely so the gib rule inside
      // recomputes the same way it did at the time of death (it also re-derives
      // `deathFrameCount`, the other field the save leaves out).
      if (p.dead) enterDeathPose(p, p.deadTime);
      else restoreAttackPose(p);
    }
  }

  /**
   * Re-enters the attack pose of an attack that was still mid-state-chain
   * when the save was taken, fast-forwarded by how much of it had already run —
   * `enterDeathPose`'s `deadTime` treatment, for the one transient pose long
   * enough to be worth it. `burstLeft > 0` is what identifies it: something
   * pending only ever means an attack under way, never its tail or the
   * arch-vile's poseless `S_VILE_HEAL` hold, and `swinging` says which of the
   * two kinds. Without it the arch-vile — 94 tics of cast, most of it after
   * the warning flame appears — loads standing in its idle frame while the
   * flame burns on the player.
   * docs/savegames.md § What is saved and what is deliberately not.
   */
  function restoreAttackPose(p: PosedThing): void {
    if (p.burstLeft <= 0) return;
    const kind = p.swinging ? 'melee' : 'ranged';
    const duration = monsterStats[p.type]?.[kind]?.duration ?? 0;
    // No span to spread the frames over means no way to say where in the pose
    // this save sat, so it keeps the idle frame rather than guessing a rate.
    if (duration <= 0) return;
    enterAttackPose(p, kind, duration, duration - p.attackPause);
  }

  if (restore) {
    restoreThings(restore);
  } else {
    for (const t of map.things) {
      if (!THING_SPRITES[t.type]) continue;
      if (isMultiplayerOnly(t.flags)) continue;
      if (!spawnsAtSkill(t.flags, skill)) continue;

      // MF_SPAWNCEILING things (ceiling-hung gore, Commander Keen) measure z down from the ceiling
      // instead of up from the floor — see CEILING_HUNG_HEIGHT's doc.
      const sector = world.sectorAt(t.x, t.y);
      const hangHeight = CEILING_HUNG_HEIGHT[t.type];
      const z = hangHeight !== undefined ? (sector?.ceilHeight ?? 0) - hangHeight : (sector?.floorHeight ?? 0);
      if (!pushThing(t.type, { x: t.x, y: t.y, z }, spawnAngleDeg(t.angle), { ambush: isAmbush(t.flags) })) {
        missingArt.add(`${t.type} (${THING_SPRITES[t.type]})`);
        continue;
      }
      // Vanilla's own `P_SpawnMapThing` totals — incremented only for a thing that actually spawns
      // (past every filter above, art included), matching `if (mobj->flags & MF_COUNTKILL)
      // totalkills++` / `MF_COUNTITEM` in `info.c`. Nothing but a resurrection (`reviveCorpse`, a
      // documented deviation) moves them afterwards, which is why a cube-spawned monster
      // (`spawnMonster`) can push the kill count past 100%.
      if (COUNTKILL_TYPES.has(t.type)) stats.totalKills++;
      else if (COUNTITEM_TYPES.has(t.type)) stats.totalItems++;
    }
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
   * docs/monster-ai.md § The pain elemental: spawning a lost soul.
   */
  function spawnLostSoul(origin: PosedThing, angleRad: number): void {
    let skullCount = 0;
    for (const p of posed) if (p.type === ThingType.lostSoul && !p.dead) skullCount++;
    if (skullCount > MAX_SKULLS_ON_LEVEL) return;

    const skullStats = monsterStats[ThingType.lostSoul];
    const skullRadius = skullStats.radius;
    const originRadius = monsterStats[origin.type]?.radius ?? skullRadius;
    // Vanilla's `4*FRACUNIT + 3*(actor->info->radius + skullRadius)/2` — both
    // radii are already plain map units here (not FRACUNIT-scaled), so the
    // shared scaling factor just divides back out.
    const prestep = 4 + 1.5 * (originRadius + skullRadius);
    const x = origin.x + Math.cos(angleRad) * prestep;
    const y = origin.y + Math.sin(angleRad) * prestep;
    const z = origin.z + 8;
    if (world.positionBlocked(x, y, skullRadius, z, skullStats.height, true)) return;

    // Already alerted, with reactionTicks/movecount pre-zeroed (pushThing's own
    // defaults) so its very first chase call is free to roll straight into
    // checkMissileRange — and so straight into its own charge — rather than
    // first walking a step and waiting out a reaction delay it never had in
    // vanilla, where `A_SkullAttack` fires in the same tic it spawns.
    pushThing(ThingType.lostSoul, { x, y, z }, (angleRad * 180) / Math.PI, {
      alerted: true,
      targetId: origin.targetId,
    });
  }

  /** `P_TeleportMove`'s stomp — contract at `ThingLayer.telefragAt`, rules in docs/death.md § Telefrag. */
  function telefragAt(at: Pos2, radius: number, stomps: boolean, moverId?: number): boolean {
    for (const q of posed) {
      if (q.id === moverId || q.dead || q.hidden) continue;
      if (!MONSTER_TYPES.has(q.type) && q.type !== ThingType.barrel) continue;
      if (!bodiesOverlap(at, q, radius + q.blockRadius)) continue;
      if (!stomps) return false;
      // Deliberately unattributed: a telefrag is `P_TeleportMove`'s doing, not
      // an attack, and naming the arriving body as the source would start an
      // infight it never picked.
      damageThing(q, TELEFRAG_DAMAGE);
    }
    return true;
  }

  /**
   * `A_SpawnFly`'s own monster creation: drops a fresh, already-awake `type` at
   * `at` and telefrags whatever was standing there, returning the new body (or
   * null if the WAD has no art for it). The Icon of Sin's spawn cube is the
   * only caller — `game/monsters/iconofsin.ts` owns the rest of that sequence, including the
   * fire puff, the `telept` sound and the *player* half of the telefrag, which
   * this layer holds no reference to.
   *
   * Vanilla ends `A_SpawnFly` with `P_TeleportMove`, which is what makes a
   * spawn spot lethal to stand on: everything overlapping the new body takes
   * `TELEFRAG_DAMAGE` rather than the spawn being blocked or skipped. That is
   * also why there's no `positionBlocked` guard here, unlike `spawnLostSoul`.
   * The stomp is unconditional because the cube only ever flies on the one map
   * where `PIT_StompThing` lets a monster stomp anyway.
   * docs/monster-iconofsin.md § The spawn cube.
   */
  function spawnMonster(type: number, at: Pos3, angleRad: number): PosedThing | null {
    const spawned = pushThing(type, at, (angleRad * 180) / Math.PI, { alerted: true });
    if (!spawned) return null;
    telefragAt(spawned, spawned.blockRadius, true, spawned.id);
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
    const isBarrel = p.type === ThingType.barrel;
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
      const mass = isBarrel ? BARREL_MASS : monsterStats[p.type]?.mass ?? 100;
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
      const stats = monsterStats[p.type];
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
      if (p.painTimer > 0) p.homingBias = (pRandom() & 1) !== 0;
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
    // no "already counted" guard, so an arch-vile-resurrected monster killed again counts twice;
    // `reviveCorpse` raises the *total* to match rather than vanilla's >100% (docs/hud.md §
    // Level stats). Barrels never match (not in COUNTKILL_TYPES), so this sits before the barrel
    // branch without needing its own guard.
    if (COUNTKILL_TYPES.has(p.type)) stats.kills++;
    if (isBarrel) {
      // BEXP, not BAR1 — see `BARREL_CHAIN.deathSprite`'s doc. The splash itself
      // fires later, once `BARREL_CHAIN.explodeDelaySeconds` elapses (see
      // update()) — `source` is captured now so it can still be attributed
      // correctly then, and propagated to any barrel that blast itself
      // kills (see PosedThing.explodeSource's doc).
      p.barrelExploded = false;
      p.explodeSource = source ?? null;
      enterDeathPose(p);
      // MT_BARREL's own deathsound. Vanilla's A_Scream sits on S_BEXP2, one
      // 5-tic frame into the explosion rather than on death itself; played
      // here on death, since a fifth of a second of silent fireball reads as
      // a bug and the blast (`BARREL_CHAIN.explodeDelaySeconds`) is later still.
      sfx.play('barexp', p, monsterOrigin(p.id));
      return;
    }
    const gibbed = enterDeathPose(p);
    // A_Scream's own death cry — randomized within its family, unattenuated
    // for the two bosses — or A_XScream's wet `slop` for a gib, which the
    // xdeathstate chain plays *instead*, not on top.
    // `MONSTER_STATS` re-read rather than reused: the `stats` above is scoped
    // to the survived-the-hit branch this one is the alternative to.
    const death = gibbed ? 'slop' : monsterStats[p.type]?.sounds.death;
    if (death) {
      sfx.play(randomVariant(death), BOSS_TYPES.has(p.type) ? null : p, monsterOrigin(p.id));
    }

    const dropType = MONSTER_DROPS[p.type];
    if (dropType) spawnDrop(p, p.sector, p.facingDeg, dropType);

    // A_PainDie: three more lost souls, fanned 90/180/270 degrees around
    // the elemental's own last facing — vanilla's own
    // `A_PainShootSkull(actor, actor->angle+ANG90/180/270)`, fired
    // unconditionally on death regardless of what attack (if any) was
    // under way when it died.
    if (p.type === ThingType.painElemental) {
      spawnLostSoul(p, p.angle + Math.PI / 2);
      spawnLostSoul(p, p.angle + Math.PI);
      spawnLostSoul(p, p.angle + (3 * Math.PI) / 2);
    }

    // A_BossDeath's own thinker scan: "if any other of this type is still alive, do nothing."
    // Only worth walking `posed` at all for the types a map's own trigger table could possibly
    // care about — see docs/death.md § Boss death.
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
    // The pinned-body memo: this exact state already proved blocked, and no
    // stamped nearby height has changed since, so replay the outcome without
    // re-deriving it. A belt-pinned closet monster hits this every tic; any
    // hit's knockback or the belt's own rate changing misses on the velocity
    // compare, a door opening in reach misses on the stamp.
    // docs/movement.md § Pinned-body memo.
    if (world.pinMatches(p.pinned, p.x, p.y, p.z, p.velX, p.velY)) {
      p.velX = 0;
      p.velY = 0;
      return;
    }
    const nx = p.x + p.velX * dt;
    const ny = p.y + p.velY * dt;
    if (world.positionBlocked(nx, ny, p.blockRadius, p.z, p.bodyHeight, true)) {
      world.capturePin(p.pinned, p.x, p.y, p.z, p.velX, p.velY, p.blockRadius, dt);
      p.velX = 0;
      p.velY = 0;
      return;
    }
    p.pinned.active = false;
    p.x = nx;
    p.y = ny;
    const decay = Math.pow(FRICTION, dt * 35);
    p.velX *= decay;
    p.velY *= decay;
    if (Math.abs(p.velX) < KNOCKBACK_STOP_SPEED) p.velX = 0;
    if (Math.abs(p.velY) < KNOCKBACK_STOP_SPEED) p.velY = 0;
  }

  /**
   * Puts a thing down where a walk-line teleport sent it — including its
   * height, which is the arrival floor for a loud teleport and the departure
   * height above the floor for a silent one. Momentum follows vanilla's two
   * arrivals: `P_Teleport` zeroes it outright, while a silent one rotates it by
   * the same angle the body turned (`TeleportDest.rotateBy`) — the difference
   * between a conveyor's cargo stopping dead on arrival and coming out of the
   * far end still moving. docs/specials.md § Silent and line-to-line
   * teleporters.
   */
  function arriveAt(p: PosedThing, dest: TeleportDest): void {
    // Read before the move, reapplied after: a silent arrival preserves the
    // height above the floor, and this layer is the only place it can be
    // measured (`TeleportDest.silent`).
    const aboveFloor = dest.silent ? p.z - world.groundFloor(p.x, p.y, p.blockRadius, true) : 0;
    p.x = dest.x;
    p.y = dest.y;
    p.angle = dest.angle;
    // `EV_Teleport`'s own `thing->z = thing->floorz` — the *arrival* floor.
    // Without it a body keeps the departure sector's height and falls the
    // difference under gravity, which is what makes a monster closet above the
    // arena read as monsters dropping out of the sky.
    p.z = world.groundFloor(p.x, p.y, p.blockRadius, true) + aboveFloor;
    if (dest.rotateBy === undefined) {
      p.velX = 0;
      p.velY = 0;
      p.velZ = 0;
    } else {
      const cos = Math.cos(dest.rotateBy);
      const sin = Math.sin(dest.rotateBy);
      const vx = p.velX;
      const vy = p.velY;
      p.velX = vx * cos - vy * sin;
      p.velY = vx * sin + vy * cos;
    }
    // Collapse the interpolation window onto the arrival point, or the render
    // layer draws the thing gliding across the whole map over one tic instead
    // of appearing at the far end. docs/frameloop.md § Interpolation.
    p.drawPrevX = p.x;
    p.drawPrevY = p.y;
    p.drawPrevZ = p.z;
    // Re-route from scratch: the heading it had is meaningless on the far side
    // of the map. Inert for anything without AI.
    p.movedir = DI_NODIR;
    p.movecount = 0;
  }

  /** Reused by `crossAfterPush`, which runs for every pushed thing every tic. */
  const pushedFrom: Pos2 = { x: 0, y: 0 };

  /**
   * The walk lines a thing crossed while the *world* moved it — a conveyor's
   * carry, or a knockback — as opposed to walking there itself.
   *
   * `P_CrossSpecialLine` fires for **every** non-player mobj that moves, not
   * just monsters: its only exclusions are the six projectile types (which are
   * not `PosedThing`s here at all — game/projectiles.ts owns those), and the
   * "monster only" numbers mean "not the player" rather than "monsters only".
   * So a barrel or a decoration riding a Boom conveyor over a line teleporter
   * really does teleport, which is exactly what BOOMEDIT's 252/253 and 216/217
   * belts are built to demonstrate. docs/specials.md § Scrollers and conveyors.
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
   * `applyKnockback` plus its aftermath, for a body with no AI walk of its own
   * (a dormant monster, a barrel, a corpse): fire whatever lines the push
   * crossed, then re-derive the sector — but only when the body actually went
   * somewhere, since a blocked (pinned) push moved nothing and the BSP descent
   * would answer what `p.sector` already says.
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
    if (p.x !== fromX || p.y !== fromY) refreshSector(p);
  }

  /**
   * Re-derives the sector fields a thing that moved is now standing in. One BSP
   * descent for both: `sectorAt` would walk the tree a second time to reach the
   * sector this subsector already names.
   */
  function refreshSector(p: PosedThing): void {
    p.subsector = world.subsectorAt(p.x, p.y);
    p.sector = world.sectorOfSubsector(p.subsector);
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
   * The blocker/corpse spatial index — see things/grid.ts. Built here, after
   * the map-load spawn loop above, so its first bucketing already holds every
   * thing the map placed.
   */
  const grid = createThingGrid(map, world, posed);

  /**
   * Vanilla's `A_VileChase` resurrection branch: restores a corpse to full
   * health and rejoins combat immediately, matching `P_SetMobjState`'s
   * synchronous flag/health reset — there's no separate "coming back to
   * life" delay the way the vile's own `S_VILE_HEAL` hold is. `attackPause`
   * is set to the raise animation's own length (`revive`'s `playOnce` below)
   * so `stepMonsterAI`'s existing "don't walk/attack while attackPause > 0"
   * gate holds it still until the animation actually finishes, the same way
   * it already holds an attacking monster still for its swing.
   *
   * The one deliberate deviation is the kill total — see the `totalKills` line
   * below and docs/hud.md § Level stats.
   */
  function reviveCorpse(p: PosedThing): void {
    // Deliberate deviation from vanilla, following ZDoom's `AActor::Revive`
    // ("[RH] If it's a monster, it gets to count as another kill",
    // `p_mobj.cpp`): a raised monster adds one to the level's kill *total*.
    // Vanilla adjusts neither counter here, so its `kills` — incremented per
    // death with no already-counted guard, which this engine keeps — reads
    // over the total after any resurrection. Counting the raise instead keeps
    // "cleared the level" at exactly 100%. docs/hud.md § Level stats.
    if (COUNTKILL_TYPES.has(p.type)) stats.totalKills++;
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
    p.swinging = false;
    p.chargeTimer = 0;
    p.painTimer = 0;
    p.inFloat = false;
    p.attackPause = (p.raiseFrames?.length ?? 0) * MONSTER_DEATH_FRAME_SECONDS;
    // Vanilla's A_VileChase plays `slop` on the corpse as it comes back up —
    // the same sound a gib death makes, which is why a resurrection sounds
    // like one played backwards.
    sfx.play('slop', p, monsterOrigin(p.id));
    p.anim.revive();
    if (p.raiseFrames) p.anim.playOnce(p.raiseFrames, MONSTER_DEATH_FRAME_SECONDS);
  }

  /**
   * Vanilla's `P_NightmareRespawn` (`p_mobj.c`): puts a corpse back at its own spawn point as a
   * fresh, dormant monster, with a teleport fog and `telept` at both the spot it left and the spot
   * it arrives at. Called only on nightmare, and only once the roll in `update` has passed.
   *
   * Returns false and changes nothing when something already occupies the spawn point —
   * vanilla's `if (!P_CheckPosition(mobj, x, y)) return;`, which is why a corpse in a doorway the
   * player is standing in stays down until they move. The corpse is *reused* rather than removed
   * and replaced (vanilla's `P_RemoveMobj` + `P_SpawnMobj`), so its `id` — and every saved
   * `targetId` pointing at it — survives. docs/monster-ai.md § Respawning monsters.
   */
  function respawnCorpse(p: PosedThing, player: Pos3 | null): boolean {
    const sector = world.sectorAt(p.spawnX, p.spawnY);
    // The same ceiling-hung measurement the map's own spawn loop makes, for the same reason;
    // vanilla splits it as `ONCEILINGZ`/`ONFLOORZ` right here in `P_NightmareRespawn`.
    const hangHeight = CEILING_HUNG_HEIGHT[p.type];
    const z = hangHeight !== undefined ? (sector?.ceilHeight ?? 0) - hangHeight : (sector?.floorHeight ?? 0);

    // `solidBodies` skips the dead, so the corpse itself never blocks its own return; the player
    // isn't in `posed` at all and has to be added by hand.
    const blockers = grid.solidBodies({ x: p.spawnX, y: p.spawnY });
    if (player) blockers.push({ x: player.x, y: player.y, z: player.z, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
    if (world.positionBlocked(p.spawnX, p.spawnY, p.blockRadius, z, p.bodyHeight, true, blockers)) return false;

    onRespawn?.({ x: p.x, y: p.y, z: p.sector?.floorHeight ?? p.z }, { x: p.spawnX, y: p.spawnY, z });

    p.x = p.spawnX;
    p.y = p.spawnY;
    p.z = z;
    // Across the map in one tic: without this the render layer would lerp the monster from where
    // its corpse lay to where it reappeared, drawing a body sliding through walls.
    p.drawPrevX = p.x;
    p.drawPrevY = p.y;
    p.drawPrevZ = p.z;
    p.sector = sector;
    p.subsector = world.subsectorAt(p.x, p.y);
    p.facingDeg = p.spawnAngle;
    p.angle = (p.spawnAngle * Math.PI) / 180;

    p.dead = false;
    p.deadTime = 0;
    p.health = MONSTER_HEALTH[p.type] ?? p.health;
    p.hidden = false;
    p.velX = 0;
    p.velY = 0;
    p.velZ = 0;
    // Dormant again, unlike an arch-vile's raise: vanilla respawns the monster into its
    // *spawnstate*, so it has to catch sight of the player all over again — and `isAmbush` still
    // holds, since `P_NightmareRespawn` re-applies `MTF_AMBUSH` from the spawn point it kept.
    p.alerted = false;
    p.targetId = null;
    p.lookTimer = 0;
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
    // Vanilla additionally sets `reactiontime = 18`, a longer hesitation than any monster's own
    // `mobjinfo` value. It isn't reproduced: this engine seeds the hesitation when a monster
    // *wakes* (`tryWake`'s `REACTION_CHASES`) rather than when it spawns, so anything written here
    // is overwritten the moment the respawned monster notices anyone.
    p.reactionTicks = 0;
    p.anim.revive();
    return true;
  }

  /**
   * A killable thing still in its exact spawn state needs no `MonsterFields`
   * block at all — the restore's own `pushThing` recreates those defaults.
   * Alerted, damaged, moving or dead all disqualify; `lookTimer` and
   * `homingBias` are deliberately ignored, so a never-disturbed monster costs
   * nothing beyond its `ThingState`, which together with the sparse block is
   * what keeps a 10k-monster map's save inside the localStorage quota
   * (docs/savegames.md § Storage).
   *
   * `spawnHealthFor` reads a table a DEHACKED patch can move, which stays safe because a save
   * made with one requires that file back (`patchWads`) — so the baseline on restore is the same
   * one this comparison used. docs/dehacked.md § Savegames and patched tables.
   */
  function isPristine(p: PosedThing): boolean {
    return (
      !p.dead &&
      !p.alerted &&
      p.health === spawnHealthFor(p.type, p.dropped) &&
      p.targetId === null &&
      p.velX === 0 &&
      p.velY === 0 &&
      p.velZ === 0
    );
  }

  function snapshotThings(): ThingsSnapshot {
    return {
      clock,
      stats: { ...stats },
      things: posed.map((p) => {
        const s: ThingState = { type: p.type, x: p.x, y: p.y, z: p.z, facingDeg: p.facingDeg };
        // Present only when true — see ThingState's doc.
        if (p.picked) s.picked = true;
        if (p.hidden) s.hidden = true;
        if (p.dropped) s.dropped = true;
        if (p.ambush) s.ambush = true;
        const killable = Number.isFinite(p.health) || p.dead;
        if (killable && !isPristine(p)) {
          // Sparse: a field still at its spawn default is omitted and the
          // restore's own `pushThing` re-supplies it. Six keys have no
          // constant default and are decided here instead: spawn health is per
          // type, spawn angle is `facingDeg` (which every ThingState carries)
          // in radians, `homingBias` spawns as a random draw, so it is
          // always saved, and the three `spawn*` fields default to wherever
          // this thing is — true of everything that never moved, which on a
          // typical map is most of it.
          const block: Partial<MonsterFields> = {
            homingBias: p.homingBias,
          };
          // Written unconditionally once a DEHACKED patch has moved `MONSTER_HEALTH`: the
          // elision below is against a table value, and a patched baseline would restore
          // differently. docs/dehacked.md § Savegames and patched tables.
          if (thingStatsPatched() || p.health !== spawnHealthFor(p.type, p.dropped)) block.health = p.health;
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
      }),
    };
  }

  return {
    group,
    count: posed.length,
    missingArt: [...missingArt],
    stats,
    snapshot: snapshotThings,
    solidBodies: grid.solidBodies,
    update(
      dt: number,
      player: Pos3 | null,
      fogVisible?: (subsector: number) => boolean,
      crossLines?: (prev: Pos2, mover: CrossingBody) => TeleportDest | null,
      carry?: (
        pos: Pos3,
        radius: number,
        cache: SectorTouchCache,
      ) => { readonly x: number; readonly y: number } | null,
    ): ThingUpdateResult {
      const attacks: MonsterAttackEvent[] = [];
      const barrelExplosions: BarrelExplosion[] = [];
      // Once per tic, ahead of any blockersFor call below — see its doc for
      // why a tic-granular grid is accurate enough for contact.
      grid.rebuild();
      clock += dt;
      // One respawn attempt every 32 tics for the whole level, not per corpse: `P_MobjThinker`
      // reads the global `leveltime`, and `clock` is that same clock kept in seconds. Rounded
      // rather than floored — the simulation only ever advances whole tics, so this is an exact
      // tic index up to float noise.
      const respawnTic = respawns && Math.round(clock / DOOM_TIC) % RESPAWN_ROLL_INTERVAL_TICS === 0;
      // One BSP descent for the whole sweep: the wake check's REJECT test wants the player's
      // subsector, and the player moves once a frame rather than once per monster.
      const playerSubsector = player ? world.subsectorAt(player.x, player.y) : -1;
      for (const p of posed) {
        // Every thing, every tic, before anything below can move it — `prev` is
        // no substitute (see its doc), and a thing that skips a tic via one of
        // the `continue`s below must still have a sane interpolation source.
        p.drawPrevX = p.x;
        p.drawPrevY = p.y;
        p.drawPrevZ = p.z;
        if (p.hidden) {
          p.visible = false;
          continue;
        }
        if (p.dead) {
          p.deadTime += dt;
          // `P_KillMobj` strips `MF_NOGRAVITY` from everything but the lost
          // soul, so a corpse left hanging in the air — a cacodemon shot off
          // its hover, anything killed mid-launch by an arch-vile — drops.
          // Gated on the thing's own cached sector floor so the overwhelming
          // majority of corpses (already resting on it) cost no query at all.
          if (p.type !== ThingType.lostSoul && p.z > (p.sector?.floorHeight ?? p.z)) {
            const restZ = world.groundFloor(p.x, p.y, p.blockRadius, true);
            p.velZ -= GRAVITY * dt;
            p.z = Math.max(restZ, p.z + p.velZ * dt);
            if (p.z === restZ) p.velZ = 0;
          }
          if (p.type === ThingType.barrel) {
            // Vanilla's own A_Explode, firing partway through the death
            // animation rather than instantly on death — see
            // `BARREL_CHAIN.explodeDelaySeconds`'s doc.
            if (!p.barrelExploded && p.deadTime >= BARREL_CHAIN.explodeDelaySeconds) {
              p.barrelExploded = true;
              barrelExplosions.push({ x: p.x, y: p.y, z: p.z, source: p.explodeSource ?? undefined });
            }
            // Vanilla's S_BEXP5 falls through to S_NULL — the debris is
            // removed outright once its explosion animation finishes,
            // matching MONSTER_CORPSE_VANISHES's own reasoning for the lost
            // soul/pain elemental below (a barrel just isn't a MONSTER_TYPES
            // member, so it can't share that table).
            if (p.deadTime >= p.deathFrameCount * BARREL_CHAIN.deathFrameSeconds) {
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
          // `P_MobjThinker`'s respawn branch, in its own order: `MF_COUNTKILL` only, then 12
          // seconds face down, then the level-wide 32-tic gate above, then a 5-in-256 roll. The
          // two corpse-removal branches above already `continue`, so a lost soul or an exploded
          // barrel can never reach this — vanilla removes those mobjs outright, and a removed
          // mobj has no thinker left to respawn it.
          if (respawnTic && p.deadTime >= NIGHTMARE_RESPAWN_DELAY && COUNTKILL_TYPES.has(p.type) && pRandom() <= 4) {
            // No `continue` on success: the monster is alive as of this line, so it falls through
            // to the ordinary live path below and starts looking around in the same tic.
            respawnCorpse(p, player);
          }
        }

        // Every non-monster (barrel sway, decoration flicker, item/key/powerup
        // blink) always cycles — vanilla's idle art loops unconditionally, it's
        // not tied to motion the way a monster's walk cycle is. A monster
        // starts false and only the stats branch below turns it on, based on
        // whether it actually stepped this frame.
        let animating = !MONSTER_TYPES.has(p.type);
        const stats = !p.dead ? monsterStats[p.type] : undefined;
        // A conveyor under this thing feeds the same momentum channel a hit's
        // knockback does, so the integration below carries it for free —
        // `T_Scroll`'s `sc_carry` moves every mobj standing on the belt, not
        // just the player. Only fliers are exempt (`MF_NOGRAVITY`); a corpse is
        // not, since `P_KillMobj` strips that flag from everything it kills.
        // A body still falling isn't carried either, but that gate belongs to
        // the sector's own floor height and lives in `carryForBody`.
        if (carry && !stats?.flies) {
          const impulse = carry(p, p.blockRadius, p.touch);
          if (impulse) {
            p.velX += impulse.x;
            p.velY += impulse.y;
          }
        }
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
            // game/monsters/ai.ts's tryWake; this loop only owns the throttle.
            p.lookTimer += dt;
            if (p.lookTimer >= LOOK_INTERVAL) {
              p.lookTimer = 0;
              // Waking is one of the two events that can reshuffle a
              // revenant's guided/unguided personality — see
              // MonsterBody.homingBias's doc. A no-op for every other type.
              if (tryWake(p, world, p.sector, player, playerSubsector)) {
                p.homingBias = (pRandom() & 1) !== 0;
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
              // A flier keeps whatever height it drifted to: `MF_NOGRAVITY`
              // outlives losing a target, and dropping it to the floor here
              // would pop a hovering cacodemon down the instant the player dies.
              if (!stats.flies) p.z = p.sector?.floorHeight ?? p.z;
            } else {
              const beforeX = p.x;
              const beforeY = p.y;
              // The melee gate's `pl->info->radius`/height. The target is the
              // player exactly when `resolveTarget` fell back to it; anything
              // else is another `PosedThing`, whose `blockRadius`/`bodyHeight`
              // are already this type's own resolved figures (see those fields).
              const victim = target === player ? null : (posed[p.targetId!] ?? null);
              const targetRadius = victim ? victim.blockRadius : PLAYER_RADIUS;
              const targetHeight = victim ? victim.bodyHeight : PLAYER_HEIGHT;
              const result = stepMonsterAI(
                p,
                stats,
                dt,
                world,
                target,
                targetRadius,
                targetHeight,
                grid.blockersFor(p, player),
                grid.findRaisableCorpse,
                sfx,
              );
              // Vanilla's own momentum-driven displacement, additive on top of
              // the AI walk step just above — see applyKnockback's doc.
              if (p.velX !== 0 || p.velY !== 0) applyKnockback(p, dt);
              // Walk triggers this monster crossed on the way (teleports,
              // and the handful of doors/lifts vanilla lets a monster open).
              // A teleport can still come back empty-handed — docs/death.md § Telefrag.
              const dest = crossLines?.(p.prev, p);
              if (dest) arriveAt(p, dest);
              p.prev.x = p.x;
              p.prev.y = p.y;
              refreshSector(p);
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
                // art (MONSTER_ATTACK_POSE[71]), unlike the vile's raise.
                spawnLostSoul(p, result.angleRad);
              } else if (result) {
                attacks.push({
                  ...result,
                  x: p.x,
                  y: p.y,
                  z: p.z + MONSTER_FIRE_HEIGHT,
                  sourceId: p.id,
                  sourceType: p.type,
                  sourceRadius: p.blockRadius,
                  targetId: p.targetId,
                });
              }
              // The pose belongs to the attack, not to the shot: it starts on whichever tic
              // `attackPause` was set — which for a windup is tics before anything is returned —
              // and `posing` keeps a volley's later shots, and the arch-vile's blast 66 tics into
              // its cast, from snapping it back to frame one. `attackPause` is the span it covers,
              // full here because `stepMonsterAI` decrements it before the call that set it.
              if (p.attackPause > 0 && !p.anim.posing) {
                // `p.swinging` is what names the kind on the tic a melee attack
                // *starts*: its claw is still a windup away, so `result` is null
                // there and only the flag says which chain to pose off. Only the
                // revenant has two distinct ones, and it is the type that shows it.
                enterAttackPose(p, result?.kind === 'melee' || p.swinging ? 'melee' : 'ranged', p.attackPause);
              }
            }
          } else {
            // A flier keeps whatever height it hovered to — `MF_NOGRAVITY`
            // outlives losing a target, so a dormant cacodemon must not pop
            // down to the floor. A *rising* floor still pushes it up, which is
            // all `P_ZMovement` does for a no-gravity body on contact.
            const floorZ = p.sector?.floorHeight ?? p.z;
            p.z = stats.flies ? Math.max(p.z, floorZ) : floorZ;
            // A not-yet-alerted monster can still be knocked back — a hit
            // always sets velX/velY in `damage`, though in practice it also
            // always alerts the monster in that same call, so this mostly
            // guards the same-frame ordering rather than a state that lingers.
            // Unlike the alerted branch, nothing below re-derives the sector it
            // was shoved into, and the wake check answers from `subsector`.
            if (p.velX !== 0 || p.velY !== 0) pushAndSettle(p, dt, crossLines);
          }
        } else {
          // Ceiling-hung gore rides a moving ceiling (crusher, closing door) the same way
          // everything else here rides a moving floor — see CEILING_HUNG_HEIGHT's doc.
          // A corpse still falling (the dead branch above) is the one exception:
          // it owns its own `z` until it lands, and only then rejoins the ride.
          const hangHeight = CEILING_HUNG_HEIGHT[p.type];
          if (hangHeight !== undefined) {
            p.z = (p.sector?.ceilHeight ?? p.z + hangHeight) - hangHeight;
          } else if (!p.dead || p.z <= (p.sector?.floorHeight ?? p.z)) {
            p.z = p.sector?.floorHeight ?? p.z;
          }
          // Barrels have no AI movement of their own, so this is their only
          // source of horizontal motion; a corpse (stats undefined above) lands
          // here too, finishing off whatever knockback it had at the moment it
          // died and riding whatever conveyor it fell onto —
          // docs/movement.md § Knockback.
          if (p.velX !== 0 || p.velY !== 0) pushAndSettle(p, dt, crossLines);
        }

        // Whether this thing can be seen — and so shot, and so auto-aimed at.
        // Keyed to fog's crisp `explored` flag rather than its damped alpha:
        // alpha is a render-clock fade, and gating a gameplay decision on it
        // would make what is shootable depend on framerate.
        // docs/fogofwar.md § What gameplay reads.
        p.visible = !fogVisible || fogVisible(p.subsector);
        p.anim.advance(dt, animating);
      }
      return { attacks, barrelExplosions };
    },
    draw(alpha: number, viewAngleDeg: number): void {
      batch.begin(viewAngleDeg);
      dropBatch.begin(viewAngleDeg);
      fuzzBatch.begin(viewAngleDeg);
      fuzzBatch.setFuzzTime(clock);
      const pulse = Math.sin((clock / DROP_PULSE_SECONDS) * Math.PI * 2) * 0.5 + 0.5;
      dropBatch.setOpacity(DROP_OPACITY_MIN + (DROP_OPACITY_MAX - DROP_OPACITY_MIN) * pulse);
      for (const p of posed) {
        // Resolving the lump is only worth doing for something actually being
        // drawn — for a map like NUTS.WAD this skips thousands of SpriteBank
        // lookups a frame while the player has only explored part of it.
        if (!p.visible) continue;
        const cached = p.anim.resolve(p.facingDeg, viewAngleDeg);
        if (!cached) continue;
        const x = p.drawPrevX + (p.x - p.drawPrevX) * alpha;
        const y = p.drawPrevY + (p.y - p.drawPrevY) * alpha;
        const z = p.drawPrevZ + (p.z - p.drawPrevZ) * alpha;
        // Everything the map itself placed draws plainly, at its own height:
        // only a drop lands on top of a corpse, and only a drop is worth
        // singling out (docs/items.md § Making monster drops readable).
        // Read live off the sector rather than caching a `light` field on the
        // thing — see docs/render.md § Sector lighting on why every sprite must.
        // A fullbright frame (a torch, a firing pose) ignores the sector outright.
        const light = FULLBRIGHT_FRAMES.has(p.anim.frameKey)
          ? LIT_FULL
          : litColor(p.sector ? transfers.spriteLight(world.sectorIndexOfSubsector(p.subsector)) : 128);
        // A drawn sprite is both a possible emitter (the torch, the muzzle flash) and a
        // receiver. `p.visible` above already gated on fog of war, so an unrevealed room lights
        // nothing — docs/lights.md § What emits.
        const tint = lights?.offerAndTint(p.anim.frameKey, x, y, z, p.id, p.subsector);
        if (!p.dropped) {
          doomToWorld(x, y, z, worldPos);
          // A fuzzed thing (the spectre, alive or a corpse — `FUZZ_TYPES`)
          // differs only in which batch draws it; everything above is the same
          // pose an ordinary thing gets.
          const into = FUZZ_TYPES.has(p.type) ? fuzzBatch : batch;
          into.add(cached, worldPos.x, worldPos.y, worldPos.z, p.scale, light, tint);
          continue;
        }
        // Phase-shifted per instance (`p.id`), so two drops side by side
        // ripple instead of bobbing in unison. The opacity pulse can't do the
        // same — it's batch-wide, see `SpriteBatch.setOpacity`.
        const bob = Math.sin((clock / DROP_BOB_SECONDS + p.id * 0.7) * Math.PI * 2) * DROP_BOB;
        doomToWorld(x, y, z + DROP_HOVER + bob, worldPos);
        dropBatch.add(cached, worldPos.x, worldPos.y, worldPos.z, p.scale, light, tint);
      }
      batch.end();
      dropBatch.end();
      fuzzBatch.end();
    },
    dispose(): void {
      batch.dispose();
      dropBatch.dispose();
      fuzzBatch.dispose();
    },
    tryPickup(
      from: Pos3,
      to: Pos2,
      blockdist: number,
      consume: (type: number, dropped: boolean) => boolean,
    ): void {
      for (const p of posed) {
        if (p.picked) continue;
        // `PIT_CheckThing`'s box at both ends of the move, because vanilla picks
        // items up at the destination before rejecting the move.
        // docs/items.md § Collecting things.
        if (!bodiesOverlap(from, p, blockdist) && !bodiesOverlap(to, p, blockdist)) continue;
        // Matches vanilla's PIT_CheckThing overhead/underneath gate: a thing
        // sitting on a not-yet-lowered pillar is in 2D range but out of
        // physical reach, and must stay uncollected until the pillar drops
        // (e.g. DOOM2 MAP04's blue key). Read live off the sector rather than
        // a cached height for the same reason `update` does.
        if (Math.abs((p.sector?.floorHeight ?? 0) - from.z) > PLAYER_HEIGHT) continue;
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
    pickMonster(ray: THREE.Ray, viewerAngleDeg: number): MonsterRef | null {
      // The yaw every billboard stands at, computed once here exactly as
      // `SpriteBatch.begin` does per batch.
      const rad = ((viewerAngleDeg - VIEWER_ANGLE_DEG) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      let best: PosedThing | null = null;
      let bestDist = Infinity;
      for (const p of posed) {
        if (!p.visible || p.dead || p.picked) continue;
        // Broad phase before anything that costs a lookup: reject on the
        // ray's distance to a sphere around the thing's anchor, sized so no
        // billboard can escape it (BILLBOARD_MAX_REACH). This is what keeps a
        // 10,000-thing map from paying a `SpriteBank` resolve per thing per
        // tic — the whole point of picking analytically rather than through
        // the render batch.
        doomToWorld(p.x, p.y, p.z, worldPos);
        const dx = worldPos.x - ray.origin.x;
        const dy = worldPos.y - ray.origin.y;
        const dz = worldPos.z - ray.origin.z;
        const along = dx * ray.direction.x + dy * ray.direction.y + dz * ray.direction.z;
        const reach = BILLBOARD_MAX_REACH * p.scale;
        // Behind the camera by more than it could ever reach forward.
        if (along < -reach) continue;
        const offSq = dx * dx + dy * dy + dz * dz - along * along;
        if (offSq > reach * reach) continue;
        // Nothing this far out can beat a hit already found, whichever part
        // of its quad the ray crosses.
        if (along - reach > bestDist) continue;
        // Everything the pointer can lock onto, and nothing else. Anything
        // rejected here is simply skipped rather than treated as a blocker —
        // a plain decoration standing in front of a monster must not make it
        // untargetable. Barrels join MONSTER_TYPES; see the doc on
        // `ThingLayer.pickMonster` for why.
        if (NO_AUTO_AIM_TYPES.has(p.type)) continue;
        if (!MONSTER_TYPES.has(p.type) && p.type !== ThingType.barrel) continue;
        // Tic state throughout: this thing's own position, its `facingDeg`
        // and animation frame as `update` left them, and the tic-exact viewer
        // angle. Nothing interpolated reaches this, which is what makes what
        // auto-aim locks onto independent of framerate.
        const cached = p.anim.resolve(p.facingDeg, viewerAngleDeg);
        if (!cached) continue;
        const dist = intersectBillboard(ray, cached, worldPos, p.scale, cos, sin);
        if (dist < 0 || dist >= bestDist) continue;
        bestDist = dist;
        best = p;
      }
      if (!best) return null;
      const { id, x, y, z, type, angle, blockRadius, bodyHeight } = best;
      return { id, x, y, z, type, angle, radius: blockRadius, height: bodyHeight };
    },
    monstersNear(pos: Pos2, radius: number): MonsterRef[] {
      // Grid-backed, not a scan of every thing. Splash queries alone would be
      // survivable; `monstersAlongStep` below shares the same index and runs
      // once per in-flight projectile per frame, and a crowded map can have
      // well over a thousand projectiles in the air at once — as a linear scan
      // that alone measured ~138 ms/frame on NUTS.WAD, more than everything
      // else in the frame put together.
      const out: MonsterRef[] = [];
      // Range is measured to each body's *edge* (`blastDistanceToBox`), so the
      // grid box has to reach a full body-width further than the blast itself
      // or the widest monsters — the ones the subtraction matters most for —
      // would never be considered.
      grid.forEachMonsterNear(pos.x, pos.y, radius + grid.maxBodyRadius(), (p) => {
        // The grid this walks holds solid decorations too, and those block
        // movement but not shots — docs/monster-ai.md § Spatial indexing.
        if (p.dead || SOLID_DECORATION_TYPES.has(p.type)) return;
        if (blastDistanceToBox(pos.x, pos.y, p.x, p.y, p.blockRadius) >= radius) return;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius, height: p.bodyHeight });
      });
      return out;
    },
    monstersAlongStep(from: Pos3, to: Pos3, reach: number): MonsterRef[] {
      const out: MonsterRef[] = [];
      // One grid query over the whole step, sized from the map's own largest
      // body rather than the largest in the game — the same adaptive box
      // `blockersFor` uses, and the reason a map of 20-unit grunts doesn't pay
      // for the spider mastermind it doesn't contain.
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      const half = Math.hypot(to.x - from.x, to.y - from.y) / 2;
      grid.forEachMonsterNear(midX, midY, half + boxReach(reach + grid.maxBodyRadius()), (p) => {
        // The grid this walks holds solid decorations too, and those block
        // movement but not shots — docs/monster-ai.md § Spatial indexing.
        if (p.dead || SOLID_DECORATION_TYPES.has(p.type)) return;
        if (segmentEntersBox(from.x, from.y, to.x, to.y, p.x, p.y, p.blockRadius + reach) === null) return;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius, height: p.bodyHeight });
      });
      return out;
    },
    monsterById(id: number): MonsterRef | null {
      const p = posed[id];
      if (!p || p.dead || !MONSTER_TYPES.has(p.type)) return null;
      return { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius, height: p.bodyHeight };
    },
    bleeds(id: number): boolean {
      const p = posed[id];
      return !!p && p.type !== ThingType.barrel;
    },
    awakeMonsterCount(): number {
      let n = 0;
      for (const p of posed) {
        if (!p.dead && MONSTER_TYPES.has(p.type) && p.alerted) n++;
      }
      return n;
    },
    awakeMonsters(): StandingBody[] {
      const out: StandingBody[] = [];
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type) || !p.alerted || !p.visible) continue;
        out.push({ x: p.x, y: p.y, z: p.z, height: p.bodyHeight });
      }
      return out;
    },
    monstersInSector(sector: Sector): MonsterRef[] {
      const out: MonsterRef[] = [];
      for (const p of posed) {
        if (p.dead || !MONSTER_TYPES.has(p.type) || p.sector !== sector) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius, height: p.bodyHeight });
      }
      return out;
    },
    crushablesInSectors(sectors: ReadonlySet<Sector>): MonsterRef[] {
      const out: MonsterRef[] = [];
      for (const p of posed) {
        if (p.dead || !p.sector || !sectors.has(p.sector)) continue;
        if (!MONSTER_TYPES.has(p.type) && p.type !== ThingType.barrel) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius, height: p.bodyHeight });
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
    telefragAt,
    spawnMonster(type: number, at: Pos3, angleRad: number): MonsterRef | null {
      const p = spawnMonster(type, at, angleRad);
      return p ? { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius, height: p.bodyHeight } : null;
    },
    raycastMonster(
      origin: Pos3,
      angleRad: number,
      maxDist: number,
      opts?: { ignoreId?: number; includeHidden?: boolean; slope?: number },
    ): (MonsterRef & { dist: number }) | null {
      const dx = Math.cos(angleRad);
      const dy = Math.sin(angleRad);
      // The span this trace can reach vertically: one slope for a shot that
      // already has one, `P_AimLineAttack`'s cone for a trace that is an aim.
      const topSlope = opts?.slope ?? AIM_SLOPE_LIMIT;
      const bottomSlope = opts?.slope ?? -AIM_SLOPE_LIMIT;
      let nearest: (MonsterRef & { dist: number }) | null = null;
      // Grid-backed rather than a scan of every thing: this runs once per
      // monster hitscan, which a crowded map fires dozens of times a frame.
      // The sweep has to clear the widest body this map holds, since each is
      // now tested at its own radius rather than one shared 24 units.
      const clearance = boxReach(grid.maxBodyRadius());
      grid.forEachMonsterAlongRay(origin.x, origin.y, dx, dy, maxDist, clearance, (p) => {
        // The grid this walks holds solid decorations too, and those block
        // movement but not shots — docs/monster-ai.md § Spatial indexing.
        if (p.dead || SOLID_DECORATION_TYPES.has(p.type)) return;
        if (p.id === opts?.ignoreId) return;
        // Fog of war is a *player*-facing conceit; a monster shooting another
        // monster in an unrevealed room must still connect.
        if (!opts?.includeHidden && !p.visible) return;
        // This body's own width, not one shared hitbox: `PIT_AddThingIntercepts`
        // tests the trace against a diagonal of each thing's real bounding box,
        // and the 10-128 unit spread across types is the difference between a
        // bullet threading past a mancubus and stopping in it.
        const t = traceHitsBox(origin.x, origin.y, dx, dy, p.x, p.y, p.blockRadius);
        if (t === null || t > maxDist || (nearest && t >= nearest.dist)) return;
        // `PTR_AimTraverse`'s vertical test, this body's own height over its own
        // distance: the slopes reaching its feet and its top have to overlap the
        // span above. Guarded against a zero distance, where both slopes run off
        // to infinity around a body the trace starts inside of.
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
    },
  };
}
