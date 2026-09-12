/**
 * {@link SpriteFxLayer}: the transient sprite effects in flight — blood, bullet puffs, explosions,
 * teleport fog, smoke trails, flames — batched like map things, plus hitscan tracer lines.
 * See docs/combat.md § Effects and their batching.
 */
import * as THREE from 'three';
import { SpriteAnimator, SpriteBatch, VIEWER_ANGLE_DEG, type SpriteMaterialCache } from '../render/sprites.ts';
import { doomToWorld } from '../render/mapmesh.ts';
import { litColor, viewDepthAt } from '../render/sectorlight.ts';
import { skyLitSector } from '../render/skytint.ts';
import { Tracer } from '../render/tracer.ts';
import { effectEmitterId, type DynamicLights, type Tint } from '../render/lights.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { SoundEmitter } from '../audio/sfx.ts';
import type { ShotPath, World } from './world.ts';
import { GRAVITY } from './player.ts';
import { transfersOf, type Transfers } from './specials/transfers.ts';
import { triangularDraw } from '../util/random.ts';
import { type OneShotEffect } from './spritefx/defs.ts';
import { FULLBRIGHT_FRAMES } from './things/tables.ts';
import { BLOOD_FRAME_SECONDS, BLOOD_FRAMES, bloodFrames, CRUSH_BLOOD_SPEED, HIT_Z_JITTER, IFOG_FRAME_SECONDS, IFOG_FRAMES, PICKUP_FOG_FRAME_SECONDS, PICKUP_FOG_FRAMES, PICKUP_FOG_LIGHT, PICKUP_FOG_OPACITY, PICKUP_FOG_SCALE, PUFF_FRAME_SECONDS, PUFF_FRAMES, PUFF_MELEE_FRAMES, PUFF_WALL_OFFSET, TFOG_FRAME_SECONDS, TFOG_FRAMES, TFOG_SPAWN_OFFSET } from './spritefx/tables.ts';
import type { TeleportFogState } from './snapshot.ts';
import type { Placement, Pos3 } from '../types.ts';
import { cos, sin } from '../util/fdlibm.ts';
import { readStorage, writeStorage } from '../util/storage.ts';

const STORAGE_KEY = 'pickupPuff';

/** Whether a collected item leaves its puff. On by default; docs/items.md § The pickup puff. */
let pickupPuffEnabled = readStorage(STORAGE_KEY, true);

export function getPickupPuff(): boolean {
  return pickupPuffEnabled;
}

export function setPickupPuff(on: boolean): void {
  pickupPuffEnabled = on;
  writeStorage(STORAGE_KEY, on);
}

/**
 * Where the arch-vile's warning flame should sit this frame, or null to leave it where it is. The
 * caller resolves it, holding the live monster and player state — docs/monster-archvile.md § The
 * windup flame.
 */
export type VileFlameResolver = (vileId: number, targetId: number) => Pos3 | null;

/**
 * Whether a subsector is drawn — `FogOfWar.isDrawn`, handed in so this layer needn't know the fog
 * exists.
 */
export type FogVisibility = (subsector: number) => boolean;

/**
 * How one list is drawn: which batch it lands in, at what draw scale, and how far the frames' own
 * GLDEFS lights are dimmed with it. Per **list**, not per effect — every puff in a list carries the
 * same three. docs/items.md § The pickup puff.
 */
interface DrawStyle {
  batch: SpriteBatch;
  scale: number;
  lightScale: number;
}

/** What the layer is built with: the banks it draws through, and the two questions above. */
export interface SpriteFxLayerOptions {
  spriteBank: SpriteBank;
  spriteMaterials: SpriteMaterialCache;
  audio: SoundEmitter;
  resolveVileFlame: VileFlameResolver;
  fogVisible: FogVisibility;
  lights?: DynamicLights;
}

/**
 * One lifecycle for every transient visual: spawned by some other system, animated for a fixed
 * time, dropped on finish, cleared wholesale on level change. Every effect is animated wherever it
 * was spawned but only *drawn* where the player has already seen
 * ({@link SpriteFxLayer.fogVisible}). The player itself is deliberately not in this batch —
 * docs/combat.md § Effects and their batching. Only the teleport fog is saved — docs/savegames.md
 * § What is saved and what is deliberately not.
 */
export class SpriteFxLayer {
  private scene: THREE.Scene;
  private spriteBank: SpriteBank;
  private spriteMaterials: SpriteMaterialCache;
  private audio: SoundEmitter;
  private resolveVileFlame: VileFlameResolver;
  private fogVisible: FogVisibility;
  /**
   * The current level's world, for the sector-light and subsector lookups a spawn does — swapped by
   * {@link SpriteFxLayer.beginLevel}.
   */
  private world!: World;
  /** The level's render transfers, resolved once per level rather than per effect per tic. */
  private transfers!: Transfers;

  private batch = new SpriteBatch();
  /**
   * The pickup puffs' own batch, for the one thing a {@link SpriteBatch} can only do batch-wide:
   * draw translucent ({@link SpriteBatch.setOpacity}, see there). Same arrangement as
   * `ThingLayer`'s drop batch. docs/items.md § The pickup puff.
   */
  private pickupBatch = new SpriteBatch({ translucent: true });
  /** The two styles this layer draws in, built once rather than per list per frame. */
  private plain: DrawStyle = { batch: this.batch, scale: 1, lightScale: 1 };
  private pickupStyle: DrawStyle = {
    batch: this.pickupBatch,
    scale: PICKUP_FOG_SCALE,
    lightScale: PICKUP_FOG_LIGHT,
  };
  /**
   * Scratch for {@link doomToWorld}, reused across every batched sprite — same reason
   * `game/things.ts` keeps one.
   */
  private batchPos = new THREE.Vector3();
  /**
   * {@link SpriteFxLayer.drawList}'s interpolated position, reused per effect so drawing allocates
   * nothing.
   */
  private drawAt: Pos3 = { x: 0, y: 0, z: 0 };
  private teleportFogs: OneShotEffect[] = [];
  private pickupFogs: OneShotEffect[] = [];
  private impacts: OneShotEffect[] = [];
  private tracers: Tracer[] = [];
  /**
   * Fixed by {@link SpriteFxLayer.beginFrame} so the per-sprite calls in between don't each have to
   * be handed it.
   */
  private viewerAngleDeg = VIEWER_ANGLE_DEG;

  /** The frame's dynamic lights, or null when the session runs without them (docs/lights.md). */
  private lights: DynamicLights | null = null;
  /**
   * A stable emitter ID per drawn effect, for the light's flicker phase and its `dontlightself`.
   * Keyed on the {@link SpriteAnimator} rather than stored on the effect: an animator is owned by
   * exactly one effect/projectile/cube for its whole life, so this needs no field on any of those
   * record shapes — and so nothing here reaches a savegame. IDs are negative to stay clear of
   * `PosedThing.id`, which is a plain array index.
   */
  private emitterIds = new WeakMap<SpriteAnimator, number>();
  private nextEmitterId = 1;

  constructor(scene: THREE.Scene, options: SpriteFxLayerOptions) {
    this.scene = scene;
    this.spriteBank = options.spriteBank;
    this.spriteMaterials = options.spriteMaterials;
    this.audio = options.audio;
    this.resolveVileFlame = options.resolveVileFlame;
    this.fogVisible = options.fogVisible;
    this.lights = options.lights ?? null;
    scene.add(this.batch.group);
    // Set once: a material built later takes the batch's current opacity too (`applyBatchLook`).
    this.pickupBatch.setOpacity(PICKUP_FOG_OPACITY);
    scene.add(this.pickupBatch.group);
  }

  /**
   * Points the layer at the newly loaded level and drops everything still alive from the last one:
   * an effect mid-animation when the map changes would otherwise keep playing over the new level,
   * and a tracer's line would be left in a scene nothing clears it from.
   */
  beginLevel(world: World): void {
    this.world = world;
    this.transfers = transfersOf(world.map);
    // Dropping the lists is the whole of it for the batched sprites: nothing
    // is added to the batch for an effect that isn't in one of them.
    this.teleportFogs = [];
    this.pickupFogs = [];
    this.impacts = [];
    for (const t of this.tracers) {
      this.scene.remove(t.line);
      t.dispose();
    }
    this.tracers = [];
  }

  dispose(): void {
    // A tracer owns its geometry; its material is shared and outlives it.
    for (const t of this.tracers) t.dispose();
    // A batch owns its instance buffers and cloned materials, not the textures behind them.
    this.batch.dispose();
    this.pickupBatch.dispose();
  }

  /**
   * Spawns a one-shot sprite animation and returns it, or null if the sprite has no art — resolved
   * once here so no update pass has to carry a missing-lump case per frame. The caller decides
   * which list it joins; {@link SpriteFxLayer.spawnImpact} is the spawn-and-forget case.
   */
  spawn(sprite: string, frames: string[], frameSeconds: number, at: Pos3): OneShotEffect | null {
    const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, sprite, frames, frameSeconds);
    if (!anim.resolve(0, VIEWER_ANGLE_DEG)) return null;
    // drawPrev seeded to the spawn point: a one-shot's first drawn frame must
    // sit where it was spawned, not interpolate in from the world origin.
    const effect: OneShotEffect = {
      anim,
      x: at.x,
      y: at.y,
      z: at.z,
      drawPrevX: at.x,
      drawPrevY: at.y,
      drawPrevZ: at.z,
      // `resettle` fills both in; 128 is the fallback it leaves standing for a point in no sector.
      light: 128,
      subsector: 0,
      elapsed: 0,
      lifetime: frames.length * frameSeconds,
    };
    this.resettle(effect);
    return effect;
  }

  /**
   * Queues an already-spawned effect (one whose fields the caller had to adjust) onto the impact
   * list.
   */
  addImpact(effect: OneShotEffect): void {
    this.impacts.push(effect);
  }

  /**
   * {@link SpriteFxLayer.spawn} plus {@link SpriteFxLayer.addImpact}, for the callers that just
   * want the explosion drawn.
   */
  spawnImpact(sprite: string, frames: string[], frameSeconds: number, at: Pos3): void {
    const effect = this.spawn(sprite, frames, frameSeconds, at);
    if (effect) this.impacts.push(effect);
  }

  /**
   * Vanilla's `P_SpawnBlood`: the splash a hitscan or melee hit leaves on a body. Silent, and the
   * hit is known to bleed by the time it arrives — the caller owns that question. See
   * docs/combat.md § Blood.
   */
  spawnBlood(at: Pos3, damage: number): void {
    this.spawnImpact('BLUD', bloodFrames(damage), BLOOD_FRAME_SECONDS, { x: at.x, y: at.y, z: this.jitter(at.z) });
  }

  /**
   * The spray a crushing mover wrings out of a body every damage pulse — thrown rather than placed,
   * and starting at `S_BLOOD1` whatever the damage. See docs/specials-crushers.md § Crushers.
   *
   * @param at  the body's middle, which the spray is thrown from
   */
  spawnCrushBlood(at: Pos3): void {
    const effect = this.spawn('BLUD', BLOOD_FRAMES, BLOOD_FRAME_SECONDS, at);
    // Drawn before the bail, not after: vanilla's `P_SpawnMobj` cannot fail, so both pairs move
    // the cursor whether or not this set can resolve `BLUD` — a WAD's art never decides what a
    // tic does (CLAUDE.md).
    const velX = triangularDraw(CRUSH_BLOOD_SPEED);
    const velY = triangularDraw(CRUSH_BLOOD_SPEED);
    if (!effect) return;
    effect.motion = { velX, velY, velZ: 0 };
    this.addImpact(effect);
  }

  /**
   * Vanilla's `P_SpawnPuff`: the little cloud a bullet leaves where it stopped. Silent, and the
   * caller places it — nothing here knows what was hit. See docs/combat.md § Bullet puffs.
   *
   * @param sparkless  the punch's own case, starting two frames in
   */
  spawnPuff(at: Pos3, sparkless = false): void {
    const frames = sparkless ? PUFF_MELEE_FRAMES : PUFF_FRAMES;
    this.spawnImpact('PUFF', frames, PUFF_FRAME_SECONDS, { x: at.x, y: at.y, z: this.jitter(at.z) });
  }

  /**
   * The bullet puff a hitscan shot leaves against geometry — `PTR_ShootTraverse`'s `hitline`
   * branch. Nothing is drawn for a shot that ran out of range or hit sky. See docs/combat.md
   * § Bullet puffs.
   */
  spawnWallPuff(path: ShotPath, angleRad: number): void {
    if (path.lineIndex === null || this.world.hitsSky(path.lineIndex, path.z)) return;
    // Backed off the wall plane it marks, vanilla's own "position a bit closer".
    this.spawnPuff({
      x: path.x - cos(angleRad) * PUFF_WALL_OFFSET,
      y: path.y - sin(angleRad) * PUFF_WALL_OFFSET,
      z: path.z,
    });
  }

  /**
   * The teleport fogs still playing, for a savegame — the only transient here long-lived enough to
   * be worth saving. docs/savegames.md § What is saved and what is deliberately not.
   */
  snapshotTeleportFogs(): TeleportFogState[] {
    return this.teleportFogs.map((e) => ({ x: e.x, y: e.y, z: e.z, elapsed: e.elapsed }));
  }

  /**
   * Rebuilds them on the freshly loaded level through the ordinary {@link SpriteFxLayer.spawn}, so
   * everything but {@link OneShotEffect.elapsed} is re-derived rather than restored, then
   * fast-forwards the animator to it. Silent, unlike {@link SpriteFxLayer.spawnTeleportFog}: a load
   * is not a second teleport.
   */
  restoreTeleportFogs(states: TeleportFogState[]): void {
    for (const s of states) {
      const effect = this.spawn('TFOG', TFOG_FRAMES, TFOG_FRAME_SECONDS, s);
      if (!effect) continue;
      effect.elapsed = s.elapsed;
      effect.anim.advance(s.elapsed, true);
      this.teleportFogs.push(effect);
    }
  }

  spawnTeleportFog(at: Pos3): void {
    // Vanilla starts `telept` on each of the two fog puffs it spawns, so a
    // teleport is heard at both ends — and this is the one place both are
    // created, for the player's own trip and a monster's alike.
    this.audio.play('telept', at);
    const effect = this.spawn('TFOG', TFOG_FRAMES, TFOG_FRAME_SECONDS, at);
    if (effect) this.teleportFogs.push(effect);
  }

  /**
   * Vanilla `P_Teleport`'s pair, for anything that teleports: a puff where the thing stood and
   * another ahead of where it lands. See docs/specials-teleporters.md § Teleporters.
   *
   * @param destZ  the landing floor, which only the caller can resolve
   */
  spawnTeleportPair(from: Pos3, dest: Placement, destZ: number): void {
    this.spawnTeleportFog(from);
    this.spawnArrivalFog(dest, destZ);
  }

  /**
   * The pair's landing half alone, ahead of `dest` along its facing — also `G_CheckSpot`'s fog for
   * a coop respawn (docs/multiplayer-coop.md § Respawn).
   *
   * @param z  the landing floor
   */
  spawnArrivalFog(dest: Placement, z: number): void {
    this.spawnTeleportFog({
      x: dest.x + cos(dest.angle) * TFOG_SPAWN_OFFSET,
      y: dest.y + sin(dest.angle) * TFOG_SPAWN_OFFSET,
      z,
    });
  }

  /**
   * The fog an item comes back in — `P_RespawnSpecials`' `MT_IFOG` at the spawn point with
   * `itmbk` on it (`p_mobj.c`). docs/multiplayer-deathmatch.md § Item respawn.
   */
  spawnItemFog(at: Pos3): void {
    this.audio.play('itmbk', at);
    this.spawnImpact('IFOG', IFOG_FRAMES, IFOG_FRAME_SECONDS, at);
  }

  /**
   * The puff left where a collected item stood. Silent — the caller has just played the pickup's
   * own sound. See docs/items.md § The pickup puff.
   */
  spawnPickupFog(at: Pos3): void {
    if (!pickupPuffEnabled) return;
    const effect = this.spawn('TFOG', PICKUP_FOG_FRAMES, PICKUP_FOG_FRAME_SECONDS, at);
    if (effect) this.pickupFogs.push(effect);
  }

  /**
   * @param shooterRadius  only how far short of the shooter the line starts — see `MUZZLE_GAP`
   *                       (render/tracer.ts)
   */
  addTracer(from: Pos3, to: Pos3, color: number, shooterRadius: number): void {
    const tracer = new Tracer(from, to, color, shooterRadius);
    this.scene.add(tracer.line);
    this.tracers.push(tracer);
  }

  /**
   * Starts a frame's batch. Everything drawn through {@link SpriteFxLayer.batchSprite} — including
   * the projectiles game.ts advances between the update calls below — has to sit between this and
   * {@link SpriteFxLayer.endFrame}.
   */
  beginFrame(viewerAngleDeg: number): void {
    this.viewerAngleDeg = viewerAngleDeg;
    this.batch.begin(viewerAngleDeg);
    this.pickupBatch.begin(viewerAngleDeg);
  }

  endFrame(): void {
    this.batch.end();
    this.pickupBatch.end();
  }

  /**
   * Queues one already-advanced sprite into the batch at a DOOM-space point.
   *
   * **Everything drawn here hangs from its patch's own offset** (`CachedSprite.bottomOffset`), the
   * placement vanilla gives it: what this layer draws is in mid-air and belongs straddling its
   * point rather than standing on it. Only the floor-resting art `ThingLayer` and `SpriteActor`
   * draw keeps this engine's own bottom anchor. The light below is offered at the *unshifted*
   * point: where the thing is, not where its art hangs.
   * docs/sprites.md § Why upright planes, not `THREE.Sprite`.
   *
   * @param light      ignored by a fullbright frame
   * @param subsector  the sprite's own leaf where the caller has one, so a dynamic light behind a
   *                   wall can be told from one in the room; -1 leaves {@link DynamicLights} to
   *                   resolve it
   */
  batchSprite(anim: SpriteAnimator, at: Pos3, facingDeg: number, light: number, subsector = -1): void {
    this.queue(this.plain, anim, at, facingDeg, light, subsector);
  }

  updateTeleportFogs(dt: number): void {
    this.teleportFogs = this.advance(this.teleportFogs, dt);
  }

  updatePickupFogs(dt: number): void {
    this.pickupFogs = this.advance(this.pickupFogs, dt);
  }

  /**
   * Ticked *after* the projectiles so an explosion or smoke puff spawned by an arrival this frame
   * is already drawn on it, rather than a frame late.
   */
  updateImpacts(dt: number): void {
    this.impacts = this.advance(this.impacts, dt);
  }

  /** Advances every active hitscan tracer and drops the ones whose flash finished. */
  updateTracers(dt: number): void {
    if (this.tracers.length === 0) return;
    const remaining: Tracer[] = [];
    for (const t of this.tracers) {
      if (t.update(dt)) {
        remaining.push(t);
      } else {
        this.scene.remove(t.line);
        t.dispose();
      }
    }
    this.tracers = remaining;
  }

  /**
   * Draws every one-shot list. Runs inside the caller's
   * {@link SpriteFxLayer.beginFrame}/{@link SpriteFxLayer.endFrame} pair alongside
   * `ProjectileLayer.draw`. docs/frameloop.md § Interpolation.
   *
   * @param alpha  how far of the way through the last tic the effects are interpolated
   */
  draw(alpha: number): void {
    this.drawList(this.teleportFogs, alpha, this.plain);
    this.drawList(this.pickupFogs, alpha, this.pickupStyle);
    // Last, so an explosion spawned by an arrival this tic is drawn on it rather than a frame late.
    this.drawList(this.impacts, alpha, this.plain);
  }

  /**
   * {@link SpriteFxLayer.batchSprite} in a given {@link DrawStyle} — see there for everything else
   * this does.
   */
  private queue(
    style: DrawStyle,
    anim: SpriteAnimator,
    at: Pos3,
    facingDeg: number,
    light: number,
    subsector: number,
  ): void {
    const cached = anim.resolve(facingDeg, this.viewerAngleDeg);
    if (!cached) return;
    doomToWorld(at.x, at.y, at.z + cached.bottomOffset, this.batchPos);
    const bright = FULLBRIGHT_FRAMES.has(anim.frameKey);
    const lit = bright ? 255 : light;
    // What flies over a courtyard takes the outdoor tint too, off the leaf it was offered at.
    // docs/render-lighting.md § Outdoor sky tint.
    const sky = !bright && subsector >= 0 && skyLitSector(this.world.sectorOfSubsector(subsector));
    // This is the single funnel for projectiles in flight, every one-shot effect and the Icon of
    // Sin's cubes — so one hook here covers every moving light the game has (docs/lights.md).
    let tint: Tint | undefined;
    if (this.lights) {
      let id = this.emitterIds.get(anim);
      if (id === undefined) {
        id = effectEmitterId(this.nextEmitterId++);
        this.emitterIds.set(anim, id);
      }
      tint = this.lights.offerAndTint(anim.frameKey, at.x, at.y, at.z, id, subsector, style.lightScale);
    }
    const p = this.batchPos;
    const c = litColor(lit, 0, viewDepthAt(p.x, p.y, p.z));
    style.batch.add(cached, p.x, p.y, p.z, style.scale, c, tint, sky);
  }

  /**
   * `P_SpawnBlood`/`P_SpawnPuff`'s shared opening line — the same triangular draw every other
   * random fuzz in the game uses.
   */
  private jitter(z: number): number {
    return z + triangularDraw(HIT_Z_JITTER);
  }

  /**
   * Re-reads where a moved effect now is: the leaf its fog gate reads and the sector light it
   * draws at.
   *
   * @returns that sector's floor height, which is what a falling effect lands on — one BSP descent
   *          answering both; null where the point resolved to no real sector at all
   */
  private resettle(e: OneShotEffect): number | null {
    e.subsector = this.world.subsectorAt(e.x, e.y);
    const sectorIndex = this.world.sectorIndexOfSubsector(e.subsector);
    const sector = this.world.map.sectors[sectorIndex];
    if (sector === undefined) return null;
    e.light = this.transfers.spriteLight(sectorIndex);
    return sector.floorHeight;
  }

  /**
   * One tic of an effect thrown with momentum — the crusher's blood. Flies at its own speed, falls
   * under {@link GRAVITY}, and sticks where it lands rather than sliding on.
   * docs/specials-crushers.md § Crushers.
   */
  private fly(e: OneShotEffect, dt: number): void {
    const motion = e.motion;
    if (!motion) return;
    e.x += motion.velX * dt;
    e.y += motion.velY * dt;
    e.z += motion.velZ * dt;
    motion.velZ -= GRAVITY * dt;
    const floor = this.resettle(e);
    if (floor === null || e.z > floor) return;
    e.z = floor;
    e.motion = undefined;
  }

  /**
   * Advances a one-shot list in place and drops the ones that finished, matching every other list's
   * remaining-array pattern here.
   */
  private advance(list: OneShotEffect[], dt: number): OneShotEffect[] {
    if (list.length === 0) return list;
    const remaining: OneShotEffect[] = [];
    for (const e of list) {
      e.elapsed += dt;
      if (e.elapsed >= e.lifetime) continue;
      e.drawPrevX = e.x;
      e.drawPrevY = e.y;
      e.drawPrevZ = e.z;
      if (e.followTargetId !== undefined && e.vileSourceId !== undefined) {
        // A resolver that answers null leaves the flame where it last was, matching `A_Fire`'s
        // early return — docs/monster-archvile.md § The windup flame.
        const front = this.resolveVileFlame(e.vileSourceId, e.followTargetId);
        if (front) {
          e.x = front.x;
          e.y = front.y;
          e.z = front.z;
          this.resettle(e);
        }
      } else if (e.motion) {
        this.fly(e, dt);
      }
      e.anim.advance(dt, true);
      remaining.push(e);
    }
    return remaining;
  }

  private drawList(list: OneShotEffect[], alpha: number, style: DrawStyle): void {
    for (const e of list) {
      // Skipped, not dropped: a room revealed mid-animation still shows the rest of it —
      // docs/fogofwar.md § How reveal reaches the geometry.
      if (!this.fogVisible(e.subsector)) continue;
      this.drawAt.x = e.drawPrevX + (e.x - e.drawPrevX) * alpha;
      this.drawAt.y = e.drawPrevY + (e.y - e.drawPrevY) * alpha;
      this.drawAt.z = e.drawPrevZ + (e.z - e.drawPrevZ) * alpha;
      this.queue(style, e.anim, this.drawAt, 0, e.light, e.subsector);
    }
  }
}
