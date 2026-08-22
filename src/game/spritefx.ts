/**
 * `SpriteFxLayer`: the transient sprite effects in flight — blood, bullet puffs, explosions,
 * teleport fog, smoke trails, flames — batched like map things, plus hitscan tracer lines.
 * See docs/combat.md § Effects and their batching.
 */
import * as THREE from 'three';
import { SpriteAnimator, VIEWER_ANGLE_DEG, type SpriteMaterialCache } from '../render/sprites.ts';
import { SpriteBatch } from '../render/spritebatch.ts';
import { doomToWorld, litColor } from '../render/mapmesh.ts';
import { Tracer } from '../render/tracer.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { AudioEngine } from '../audio/audio.ts';
import type { ShotPath, World } from './world.ts';
import { transfersOf } from './specials/transfers.ts';
import { triangularDraw } from '../util/random.ts';
import { type OneShotEffect } from './spritefx/defs.ts';
import { FULLBRIGHT_FRAMES } from './things/tables.ts';
import { BLOOD_FRAME_SECONDS, bloodFrames, HIT_Z_JITTER, PUFF_FRAME_SECONDS, PUFF_FRAMES, PUFF_MELEE_FRAMES, PUFF_WALL_OFFSET, TFOG_FRAME_SECONDS, TFOG_FRAMES, TFOG_SPAWN_OFFSET } from './spritefx/tables.ts';
import type { TeleportFogState } from './snapshot.ts';
import type { Placement, Pos3 } from '../types.ts';

/**
 * Where the arch-vile's warning flame should sit this frame, or null if it
 * should stay put — see `SpriteFxLayer.updateImpacts`. Resolved by the caller
 * because it depends on live monster/player state this layer has no reason to
 * know about.
 */
export type VileFlameResolver = (vileId: number, targetId: number | null) => Pos3 | null;

/** Whether a subsector has been revealed — `FogOfWar.isVisible`, handed in so this layer needn't know the fog exists. */
export type FogVisibility = (subsector: number) => boolean;

/**
 * One lifecycle for every transient visual: spawned by some other system, animated for a fixed
 * time, dropped on finish, cleared wholesale on level change. The player is deliberately *not* in
 * the shared batch — it needs `SpriteActor.setOpacity`, which has no per-instance equivalent
 * (docs/combat.md § Effects and their batching). Every effect is animated wherever it was spawned
 * but only *drawn* where the player has already seen (`fogVisible`), the gate `PosedThing.visible`
 * uses. Only the teleport fog is saved —
 * docs/savegames.md § What is saved and what is deliberately not.
 */
export class SpriteFxLayer {
  private scene: THREE.Scene;
  private spriteBank: SpriteBank;
  private spriteMaterials: SpriteMaterialCache;
  private audio: AudioEngine;
  private resolveVileFlame: VileFlameResolver;
  private fogVisible: FogVisibility;
  /** The current level's world, for the sector-light and subsector lookups a spawn does — swapped by `beginLevel`. */
  private world!: World;

  private batch = new SpriteBatch();
  /** Scratch for `doomToWorld`, reused across every batched sprite — same reason `game/things.ts` keeps one. */
  private batchPos = new THREE.Vector3();
  /** `drawList`'s interpolated position, reused per effect so drawing allocates nothing. */
  private drawAt: Pos3 = { x: 0, y: 0, z: 0 };
  private teleportFogs: OneShotEffect[] = [];
  private impacts: OneShotEffect[] = [];
  private tracers: Tracer[] = [];
  /** Fixed by `beginFrame` so the per-sprite calls in between don't each have to be handed it. */
  private viewerAngleDeg = VIEWER_ANGLE_DEG;

  constructor(
    scene: THREE.Scene,
    spriteBank: SpriteBank,
    spriteMaterials: SpriteMaterialCache,
    audio: AudioEngine,
    resolveVileFlame: VileFlameResolver,
    fogVisible: FogVisibility,
  ) {
    this.scene = scene;
    this.spriteBank = spriteBank;
    this.spriteMaterials = spriteMaterials;
    this.audio = audio;
    this.resolveVileFlame = resolveVileFlame;
    this.fogVisible = fogVisible;
    scene.add(this.batch.group);
  }

  /**
   * Points the layer at the newly loaded level and drops everything still
   * alive from the last one — a fog puff or impact explosion mid-animation
   * when the map changes (e.g. a teleporter onto an exit line) would otherwise
   * keep animating over the new level, and a tracer's line would be left in a
   * scene nothing clears it from.
   */
  beginLevel(world: World): void {
    this.world = world;
    // Dropping the lists is the whole of it for the batched sprites: nothing
    // is added to the batch for an effect that isn't in one of them.
    this.teleportFogs = [];
    this.impacts = [];
    for (const t of this.tracers) {
      this.scene.remove(t.line);
      t.dispose();
    }
    this.tracers = [];
  }

  dispose(): void {
    // Tracers own per-instance geometry (unlike sprite actors, whose geometry comes
    // from the shared SpriteMaterialCache); their material is shared and outlives them.
    for (const t of this.tracers) t.dispose();
    // The batch's instance buffers and cloned materials are its own; the
    // geometry/textures behind them are spriteMaterials'.
    this.batch.dispose();
  }

  /**
   * Spawns a one-shot sprite animation and returns it, or null if the sprite
   * has no art — checked here, once, by resolving the first frame, so the
   * update passes never have to carry a "this one turned out to have no lump"
   * case through every frame. The caller decides which list it joins;
   * `spawnImpact` is the common "spawn it and forget it" case.
   */
  spawn(sprite: string, frames: string[], frameSeconds: number, at: Pos3): OneShotEffect | null {
    const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, sprite, frames, frameSeconds);
    if (!anim.resolve(0, VIEWER_ANGLE_DEG)) return null;
    const subsector = this.world.subsectorAt(at.x, at.y);
    const sectorIndex = this.world.sectorIndexOfSubsector(subsector);
    const light =
      this.world.map.sectors[sectorIndex] !== undefined
        ? transfersOf(this.world.map).spriteLight(sectorIndex)
        : 128;
    // drawPrev seeded to the spawn point: a one-shot's first drawn frame must
    // sit where it was spawned, not interpolate in from the world origin.
    return {
      anim,
      x: at.x,
      y: at.y,
      z: at.z,
      drawPrevX: at.x,
      drawPrevY: at.y,
      drawPrevZ: at.z,
      light,
      subsector,
      elapsed: 0,
      lifetime: frames.length * frameSeconds,
    };
  }

  /** Queues an already-spawned effect (one whose fields the caller had to adjust) onto the impact list. */
  addImpact(effect: OneShotEffect): void {
    this.impacts.push(effect);
  }

  /** `spawn` plus `addImpact`, for the callers that just want the explosion drawn. */
  spawnImpact(sprite: string, frames: string[], frameSeconds: number, at: Pos3): void {
    const effect = this.spawn(sprite, frames, frameSeconds, at);
    if (effect) this.impacts.push(effect);
  }

  /**
   * Vanilla's `P_SpawnBlood`: the splash a hitscan or melee hit leaves on a
   * body, scattered ±`HIT_Z_JITTER` vertically and playing fewer frames the
   * weaker the hit was. Silent — `MT_BLOOD` has no sound of its own. The
   * caller owns the `MF_NOBLOOD` question (`ThingLayer.bleeds`); by the time
   * it gets here the hit is known to bleed. See docs/combat.md § Blood.
   */
  spawnBlood(at: Pos3, damage: number): void {
    this.spawnImpact('BLUD', bloodFrames(damage), BLOOD_FRAME_SECONDS, { x: at.x, y: at.y, z: this.jitter(at.z) });
  }

  /**
   * Vanilla's `P_SpawnPuff`: the little cloud a bullet leaves where it stopped
   * — a wall, or a body carrying `MF_NOBLOOD` (only the barrel). `sparkless`
   * is the punch's own case, starting two frames in. Silent, like the blood.
   * The caller places it; nothing here knows what was hit. See docs/combat.md
   * § Bullet puffs.
   */
  spawnPuff(at: Pos3, sparkless = false): void {
    const frames = sparkless ? PUFF_MELEE_FRAMES : PUFF_FRAMES;
    this.spawnImpact('PUFF', frames, PUFF_FRAME_SECONDS, { x: at.x, y: at.y, z: this.jitter(at.z) });
  }

  /**
   * The bullet puff a hitscan shot leaves where it stopped against geometry —
   * `PTR_ShootTraverse`'s `hitline` branch, shared by the player's pellets and
   * a monster's bolt. Nothing is drawn for a shot that simply ran out of range
   * (`lineIndex === null`) or for one that hit sky. See docs/combat.md §
   * Bullet puffs.
   */
  spawnWallPuff(path: ShotPath, angleRad: number): void {
    if (path.lineIndex === null || this.world.hitsSky(path.lineIndex, path.z)) return;
    // Backed off the wall plane it marks, vanilla's own "position a bit closer".
    this.spawnPuff({
      x: path.x - Math.cos(angleRad) * PUFF_WALL_OFFSET,
      y: path.y - Math.sin(angleRad) * PUFF_WALL_OFFSET,
      z: path.z,
    });
  }

  /** `P_SpawnBlood`/`P_SpawnPuff`'s shared opening line — the same triangular draw every other random fuzz in the game uses. */
  private jitter(z: number): number {
    return z + triangularDraw(HIT_Z_JITTER);
  }

  /**
   * The teleport fogs still playing, for a savegame. The only transient this
   * layer saves: at 10 frames of 6 tics it runs ~1.7 s, long enough to save
   * inside, where an impact puff or tracer is gone in a fraction of that.
   * docs/savegames.md § What is saved and what is deliberately not.
   */
  snapshotTeleportFogs(): TeleportFogState[] {
    return this.teleportFogs.map((e) => ({ x: e.x, y: e.y, z: e.z, elapsed: e.elapsed }));
  }

  /**
   * Rebuilds them on the freshly loaded level. Goes through the ordinary
   * `spawn`, so the animator, the sector light and `drawPrev*` are re-derived
   * rather than restored — then the animator is fast-forwarded by `elapsed` in
   * one `advance`, whose own frame loop lands it on the frame the save was
   * taken on. Silent, unlike `spawnTeleportFog`: `telept` played when the
   * teleport happened, and a load is not a second teleport.
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
   * Vanilla `P_Teleport`'s pair: a puff where the thing stood, and another
   * `TFOG_SPAWN_OFFSET` ahead of where it lands along the direction it now
   * faces. Vanilla spawns these for any thing that teleports, so the player's
   * own trip and a monster's go through here alike — `destZ` is the landing
   * floor, which only the caller can resolve (the player's own `z` after
   * `teleportTo`, a `groundFloor` sample for a monster).
   */
  spawnTeleportPair(from: Pos3, dest: Placement, destZ: number): void {
    this.spawnTeleportFog(from);
    this.spawnTeleportFog({
      x: dest.x + Math.cos(dest.angle) * TFOG_SPAWN_OFFSET,
      y: dest.y + Math.sin(dest.angle) * TFOG_SPAWN_OFFSET,
      z: destZ,
    });
  }

  /** `shooterRadius` only sets how far short of the shooter the line starts — see `MUZZLE_GAP` (render/tracer.ts). */
  addTracer(from: Pos3, to: Pos3, color: number, shooterRadius: number): void {
    const tracer = new Tracer(from, to, color, shooterRadius);
    this.scene.add(tracer.line);
    this.tracers.push(tracer);
  }

  /**
   * Starts a frame's batch. Everything drawn through `batchSprite` — including
   * the projectiles game.ts advances between the update calls below — has to
   * sit between this and `endFrame`.
   */
  beginFrame(viewerAngleDeg: number): void {
    this.viewerAngleDeg = viewerAngleDeg;
    this.batch.begin(viewerAngleDeg);
  }

  endFrame(): void {
    this.batch.end();
  }

  /** Queues one already-advanced sprite into the batch at a DOOM-space point. A fullbright frame (every explosion, a fireball in flight) ignores `light`. */
  batchSprite(anim: SpriteAnimator, at: Pos3, facingDeg: number, light: number): void {
    const cached = anim.resolve(facingDeg, this.viewerAngleDeg);
    if (!cached) return;
    doomToWorld(at.x, at.y, at.z, this.batchPos);
    const lit = FULLBRIGHT_FRAMES.has(anim.frameKey) ? 255 : light;
    this.batch.add(cached, this.batchPos.x, this.batchPos.y, this.batchPos.z, 1, litColor(lit));
  }

  updateTeleportFogs(dt: number): void {
    this.teleportFogs = this.advance(this.teleportFogs, dt);
  }

  /**
   * Ticked *after* the projectiles so an explosion or smoke puff spawned by an
   * arrival this frame is already drawn on it, rather than a frame late.
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

  /** Advances a one-shot list in place and drops the ones that finished, matching every other list's remaining-array pattern here. */
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
        // Vanilla's own A_Fire: "don't move it if the vile lost sight" — a
        // broken sightline (or a dead/stale vile or target) just leaves the
        // flame exactly where it last was, matching A_Fire's early return,
        // rather than hiding it or popping it early. It's about to expire on
        // its own anyway if the shot fizzles.
        const front = this.resolveVileFlame(e.vileSourceId, e.followTargetId);
        if (front) {
          e.x = front.x;
          e.y = front.y;
          e.z = front.z;
          e.subsector = this.world.subsectorAt(e.x, e.y);
          const sectorIndex = this.world.sectorIndexOfSubsector(e.subsector);
          if (this.world.map.sectors[sectorIndex] !== undefined) {
            e.light = transfersOf(this.world.map).spriteLight(sectorIndex);
          }
        }
      }
      e.anim.advance(dt, true);
      remaining.push(e);
    }
    return remaining;
  }

  /**
   * Draws both one-shot lists, interpolated `alpha` of the way through the last
   * tic. Runs inside the caller's `beginFrame`/`endFrame` pair alongside
   * `ProjectileLayer.draw`. docs/frameloop.md § Interpolation.
   */
  draw(alpha: number): void {
    this.drawList(this.teleportFogs, alpha);
    // After the fogs and (at the call site) after the projectiles, so an
    // explosion or smoke puff spawned by an arrival this tic is drawn on it
    // rather than a frame late.
    this.drawList(this.impacts, alpha);
  }

  private drawList(list: OneShotEffect[], alpha: number): void {
    for (const e of list) {
      // Skipped, not dropped, so a room revealed mid-animation still shows the
      // rest of it — docs/fogofwar.md § How reveal reaches the geometry.
      if (!this.fogVisible(e.subsector)) continue;
      this.drawAt.x = e.drawPrevX + (e.x - e.drawPrevX) * alpha;
      this.drawAt.y = e.drawPrevY + (e.y - e.drawPrevY) * alpha;
      this.drawAt.z = e.drawPrevZ + (e.z - e.drawPrevZ) * alpha;
      this.batchSprite(e.anim, this.drawAt, 0, e.light);
    }
  }
}
