import * as THREE from 'three';
import type { DoomMap, Sector } from '../wad/map.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { World } from './world.ts';
import { GRAVITY, PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
import {
  BARREL_DEATH_FRAME_SECONDS,
  BARREL_DEATH_FRAMES,
  BARREL_DEATH_SPRITE,
  BARREL_EXPLODE_DELAY_SECONDS,
  BARREL_HEALTH,
  BARREL_IDLE_FRAME_SECONDS,
  BARREL_IDLE_FRAMES,
  BARREL_MASS,
  BARREL_RADIUS,
  BOSS_TYPES,
  DEATH_NOTIFY_TYPES,
  MAX_SKULLS_ON_LEVEL,
  pickupScaleFor,
  TELEFRAG_DAMAGE,
  type BarrelExplosion,
  type LevelKillItemStats,
  type MonsterRef,
  type PosedThing,
  type ThingLayer,
  type ThingUpdateResult,
} from './things/defs.ts';
export {
  // Re-exported so `./things.ts` stays the thing layer's one public entry
  // point for the rest of the engine — `game.ts` and `combat.ts` have no
  // reason to know which file inside `things/` a type happens to live in.
  TELEFRAG_DAMAGE,
  type BarrelExplosion,
  type MonsterRef,
  type ThingLayer,
} from './things/defs.ts';
import {
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
} from './thingdefs.ts';
import { ThingType } from './thingtypes.ts';
import { isAmbush, isMultiplayerOnly, spawnAngleDeg, spawnsAtSkill, type Skill } from './skill.ts';
import {
  DI_NODIR,
  INERT_SHOOTABLE,
  MONSTER_FIRE_HEIGHT,
  MONSTER_HIT_HEIGHT,
  MONSTER_HIT_RADIUS,
  MONSTER_STATS,
  thrustSpeed,
  type MonsterAttackEvent,
} from './monsters/defs.ts';
import { commitTarget, reactToDamage, shouldRetarget, stepMonsterAI, tryWake } from './monsters/ai.ts';
import { createThingGrid } from './things/grid.ts';
import { circleBlocked } from './world.ts';
import { monsterOrigin, randomVariant, SILENT, type SoundEmitter } from '../audio/sfx.ts';
import { SpriteAnimator, SpriteMaterialCache, VIEWER_ANGLE_DEG } from '../render/sprites.ts';
import { SpriteBatch } from '../render/spritebatch.ts';
import { doomToWorld, litColor } from '../render/mapmesh.ts';
import { boxToCircleRadius, distSqToSegment } from '../util/geom.ts';
import type { Placement, Pos2, Pos3 } from '../types.ts';

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
   * alive — vanilla's `A_BossDeath` gate, see docs/death.md § Boss death. Just the doomednum:
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
   * them (docs/hud.md § Level stats).
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
      inFloat: false,
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
   * docs/monster-ai.md § The pain elemental: spawning a lost soul.
   */
  function spawnLostSoul(origin: PosedThing, angleRad: number): void {
    let skullCount = 0;
    for (const p of posed) if (p.type === ThingType.lostSoul && !p.dead) skullCount++;
    if (skullCount > MAX_SKULLS_ON_LEVEL) return;

    const skullRadius = MONSTER_STATS[ThingType.lostSoul].radius;
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
    pushThing(ThingType.lostSoul, { x, y, z }, (angleRad * 180) / Math.PI, {
      alerted: true,
      targetId: origin.targetId,
    });
  }

  /**
   * `A_SpawnFly`'s own monster creation: drops a fresh, already-awake `type` at
   * `at` and telefrags whatever was standing there, returning the new body (or
   * null if the WAD has no art for it). The Icon of Sin's spawn cube is the
   * only caller — `game/iconofsin.ts` owns the rest of that sequence, including the
   * fire puff, the `telept` sound and the *player* half of the telefrag, which
   * this layer holds no reference to.
   *
   * Vanilla ends `A_SpawnFly` with `P_TeleportMove`, which is what makes a
   * spawn spot lethal to stand on: everything overlapping the new body takes
   * `TELEFRAG_DAMAGE` rather than the spawn being blocked or skipped. That is
   * also why there's no `circleBlocked` guard here, unlike `spawnLostSoul`.
   * docs/monster-iconofsin.md § The spawn cube.
   */
  function spawnMonster(type: number, at: Pos3, angleRad: number): PosedThing | null {
    const spawned = pushThing(type, at, (angleRad * 180) / Math.PI, { alerted: true });
    if (!spawned) return null;
    for (const q of posed) {
      if (q === spawned || q.dead || q.hidden) continue;
      if (!MONSTER_TYPES.has(q.type) && q.type !== ThingType.barrel) continue;
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
    p.inFloat = false;
    p.attackPause = (p.raiseFrames?.length ?? 0) * MONSTER_DEATH_FRAME_SECONDS;
    // Vanilla's A_VileChase plays `slop` on the corpse as it comes back up —
    // the same sound a gib death makes, which is why a resurrection sounds
    // like one played backwards.
    sfx.play('slop', p, monsterOrigin(p.id));
    p.anim.revive();
    if (p.raiseFrames) p.anim.playOnce(p.raiseFrames, MONSTER_DEATH_FRAME_SECONDS);
  }

  return {
    group,
    count: posed.length,
    missingArt: [...missingArt],
    stats,
    solidBodies: grid.solidBodies,
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
      grid.rebuild();
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
            // game/monsters/ai.ts's tryWake; this loop only owns the throttle.
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
              // A flier keeps whatever height it drifted to: `MF_NOGRAVITY`
              // outlives losing a target, and dropping it to the floor here
              // would pop a hovering cacodemon down the instant the player dies.
              if (!stats.flies) p.z = p.sector?.floorHeight ?? p.z;
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
                grid.blockersFor(p, player),
                grid.findRaisableCorpse,
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
            if (p.velX !== 0 || p.velY !== 0) applyKnockback(p, dt);
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
        return MONSTER_TYPES.has(p.type) || p.type === ThingType.barrel;
      });
      if (id === null) return null;
      const p = posed[id];
      return { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius };
    },
    monstersNear(pos: Pos2, radius: number): MonsterRef[] {
      // Grid-backed, not a scan of every thing. Splash queries alone would be
      // survivable; `monstersAlongStep` below shares the same index and runs
      // once per in-flight projectile per frame, and a crowded map can have
      // well over a thousand projectiles in the air at once — as a linear scan
      // that alone measured ~138 ms/frame on NUTS.WAD, more than everything
      // else in the frame put together.
      const out: MonsterRef[] = [];
      const rSq = radius * radius;
      grid.forEachMonsterNear(pos.x, pos.y, radius, (p) => {
        // blockerGrid also carries SOLID_DECORATION_TYPES now (movement only) — not MF_SHOOTABLE
        // in vanilla, so a projectile must not strike one.
        if (p.dead || SOLID_DECORATION_TYPES.has(p.type)) return;
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        if (dx * dx + dy * dy >= rSq) return;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius });
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
      grid.forEachMonsterNear(midX, midY, half + boxToCircleRadius(reach + grid.maxBodyRadius()), (p) => {
        // blockerGrid also carries SOLID_DECORATION_TYPES now (movement only) — not MF_SHOOTABLE
        // in vanilla, so a projectile must not strike one.
        if (p.dead || SOLID_DECORATION_TYPES.has(p.type)) return;
        const hit = boxToCircleRadius(p.blockRadius + reach);
        if (distSqToSegment(p.x, p.y, from.x, from.y, to.x, to.y) >= hit * hit) return;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius });
      });
      return out;
    },
    monsterById(id: number): MonsterRef | null {
      const p = posed[id];
      if (!p || p.dead || !MONSTER_TYPES.has(p.type)) return null;
      return { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius };
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
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius });
      }
      return out;
    },
    crushablesInSector(sector: Sector): MonsterRef[] {
      const out: MonsterRef[] = [];
      for (const p of posed) {
        if (p.dead || p.sector !== sector) continue;
        if (!MONSTER_TYPES.has(p.type) && p.type !== ThingType.barrel) continue;
        out.push({ id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius });
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
      return p ? { id: p.id, x: p.x, y: p.y, z: p.z, type: p.type, angle: p.angle, radius: p.blockRadius } : null;
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
      // The sweep has to clear the widest body this map holds, since each is
      // now tested at its own radius rather than one shared 24 units.
      const clearance = boxToCircleRadius(grid.maxBodyRadius());
      grid.forEachMonsterAlongRay(origin.x, origin.y, dx, dy, maxDist, clearance, (p) => {
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
        // This body's own width, not one shared hitbox: `PIT_AddThingIntercepts`
        // tests the trace against each thing's real bounding box, and the
        // 10-128 unit spread across types is the difference between a bullet
        // threading past a mancubus and stopping in it.
        const hit = boxToCircleRadius(p.blockRadius);
        if (perpX * perpX + perpY * perpY > hit * hit) return;
        nearest = {
          id: p.id,
          x: origin.x + dx * t,
          y: origin.y + dy * t,
          z: p.z,
          dist: t,
          type: p.type,
          angle: p.angle,
          radius: p.blockRadius,
        };
      });
      return nearest;
    },
  };
}
