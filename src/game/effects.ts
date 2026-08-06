import * as THREE from 'three';
import { SpriteAnimator, VIEWER_ANGLE_DEG, type SpriteMaterialCache } from '../render/sprites.ts';
import { SpriteBatch } from '../render/spritebatch.ts';
import { doomToWorld, litColor } from '../render/mapmesh.ts';
import { Tracer } from '../render/tracer.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import type { AudioEngine } from '../audio/audio.ts';
import type { World } from './world.ts';
import { TFOG_FRAMES, TFOG_FRAME_SECONDS, type OneShotEffect } from './effectdefs.ts';
import type { Pos3 } from '../types.ts';

/**
 * Where the arch-vile's warning flame should sit this frame, or null if it
 * should stay put — see `EffectLayer.updateImpacts`. Resolved by the caller
 * because it depends on live monster/player state this layer has no reason to
 * know about.
 */
export type VileFlameResolver = (vileId: number, targetId: number | null) => Pos3 | null;

/**
 * Every transient visual the game spawns and forgets: teleport-fog puffs,
 * impact explosions, the revenant's smoke trail, the arch-vile's flame, and
 * hitscan tracer lines. All of them share one lifecycle — spawned by some
 * other system, animated here for a fixed time, dropped when they finish, and
 * cleared wholesale on a level change.
 *
 * The one-shot sprites are drawn through a single `SpriteBatch` (one
 * `InstancedMesh` per lump); tracers own a `THREE.Line` each. The player is
 * deliberately *not* in the batch: it needs `SpriteActor.setOpacity`, which
 * has no per-instance equivalent. See docs/combat.md § Effects and their
 * batching.
 */
export class EffectLayer {
  private scene: THREE.Scene;
  private spriteBank: SpriteBank;
  private spriteMaterials: SpriteMaterialCache;
  private audio: AudioEngine;
  private resolveVileFlame: VileFlameResolver;
  /** The current level's world, for the sector-light lookup a spawn does — swapped by `beginLevel`. */
  private world!: World;

  private batch = new SpriteBatch();
  /** Scratch for `doomToWorld`, reused across every batched sprite — same reason `game/things.ts` keeps one. */
  private batchPos = new THREE.Vector3();
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
  ) {
    this.scene = scene;
    this.spriteBank = spriteBank;
    this.spriteMaterials = spriteMaterials;
    this.audio = audio;
    this.resolveVileFlame = resolveVileFlame;
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
    // Tracers own per-instance geometry/material (unlike sprite actors, whose
    // geometry/material come from the shared SpriteMaterialCache).
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
    const light = this.world.sectorAt(at.x, at.y)?.light ?? 128;
    return { anim, x: at.x, y: at.y, z: at.z, light, elapsed: 0, lifetime: frames.length * frameSeconds };
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

  spawnTeleportFog(at: Pos3): void {
    // Vanilla starts `telept` on each of the two fog puffs it spawns, so a
    // teleport is heard at both ends — and this is the one place both are
    // created, for the player's own trip and a monster's alike.
    this.audio.play('telept', at);
    const effect = this.spawn('TFOG', TFOG_FRAMES, TFOG_FRAME_SECONDS, at);
    if (effect) this.teleportFogs.push(effect);
  }

  addTracer(from: Pos3, to: Pos3, color: number): void {
    const tracer = new Tracer(from, to, color);
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

  /** Queues one already-advanced sprite into the batch at a DOOM-space point. */
  batchSprite(anim: SpriteAnimator, at: Pos3, facingDeg: number, light: number): void {
    const cached = anim.resolve(facingDeg, this.viewerAngleDeg);
    if (!cached) return;
    doomToWorld(at.x, at.y, at.z, this.batchPos);
    this.batch.add(cached, this.batchPos.x, this.batchPos.y, this.batchPos.z, 1, litColor(light), 0);
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
        }
      }
      e.anim.advance(dt, true);
      this.batchSprite(e.anim, e, 0, e.light);
      remaining.push(e);
    }
    return remaining;
  }
}
