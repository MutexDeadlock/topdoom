import * as THREE from 'three';
import type { Wad } from './wad/wad.ts';
import { GraphicsBank } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap, type DoomMap } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { AnimatedTextures } from './render/textureanim.ts';
import { buildMapMesh, type BuiltMap } from './render/mapmesh.ts';
import { SpriteActor, SpriteMaterialCache } from './render/sprites.ts';
import type { Viewport } from './render/viewport.ts';
import { buildThingSprites, MONSTER_HIT_HEIGHT, type MonsterAttackEvent, type ThingLayer } from './game/things.ts';
import { MONSTER_FIRE_HEIGHT, thrustSpeed } from './game/monsters.ts';
import { collectFadeTargets, FlatFader, TextureScroller, WallFader } from './render/occlusion.ts';
import { World, hasLineOfSight, shotPath } from './game/world.ts';
import { AIM_HEIGHT_OFFSET, GRAVITY, Player, PLAYER_HEIGHT, PLAYER_MASS, PLAYER_RADIUS } from './game/player.ts';
import { applyBarrelExplosion, applyRadiusDamage, type CombatContext } from './game/combat.ts';
import { EffectLayer } from './game/effects.ts';
import { ProjectileLayer, spawnWallPuff } from './game/projectiles.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { SpecialsController, computeMovableSectors } from './game/specials.ts';
import { blocksCeilingLower, blocksFloorRise } from './game/moverblocking.ts';
import { SectorEffects } from './game/sectoreffects.ts';
import {
  IMPACT_FRAME_SECONDS,
  MONSTER_TRACER_COLOR,
  TFOG_SPAWN_OFFSET,
  VILE_FIRE_FRAMES,
  VILE_FIRE_OFFSET,
  VILE_WINDUP_TRACK_SECONDS,
} from './game/effectdefs.ts';
import { CRUSH_DAMAGE } from './wad/specials.ts';
import { Hud } from './ui/hud.ts';
import { Crosshair } from './ui/crosshair.ts';
import { DebugHud, handleHotkeys } from './ui/debughud.ts';
import { ScreenEffects } from './ui/screeneffects.ts';
import { FrameProfiler } from './util/profiler.ts';
import type { Skill } from './game/skill.ts';
import {
  applyDamage,
  applyPickup,
  COMPUTER_MAP_TYPE,
  createInventory,
  finishLevel,
  hasPower,
  ITEM_PICKUP_RADIUS,
  pickupSound,
  tickPowers,
  type Inventory,
} from './game/inventory.ts';
import { WEAPONS, WeaponSystem } from './game/weapons.ts';
import type { AudioEngine } from './audio/audio.ts';
import { PLAYER_ORIGIN, monsterOrigin } from './audio/sfx.ts';
import { SoundBank } from './wad/sound.ts';
import type { Placement, Pos2, Pos3 } from './types.ts';

/** Combined radius (map units) within which an item is close enough to pick up. */
const PICKUP_RANGE = PLAYER_RADIUS + ITEM_PICKUP_RADIUS;

/**
 * Player death frames, confirmed against `PLAY`'s lump names: its
 * rotation-0-only tail runs H-W, split as DIE1-7 (H-N, this sequence) then
 * XDIE1-9 (O-W, the gib variant this engine doesn't model).
 */
const PLAYER_DEATH_FRAMES = ['H', 'I', 'J', 'K', 'L', 'M', 'N'];
const PLAYER_DEATH_FRAME_SECONDS = 6 / 35;

/**
 * Player attack/pain frames — `info.c` puts `S_PLAY_ATK1`/`ATK2` at `E`/`F`
 * and `S_PLAY_PAIN`/`PAIN2` at `G`, right before `PLAYER_DEATH_FRAMES` starts
 * at `H`. Played via `SpriteAnimator.playOnce`, not `die`: both hand back to
 * the walk/idle cycle when they finish.
 */
const PLAYER_ATTACK_FRAMES = ['E', 'F'];
const PLAYER_PAIN_FRAMES = ['G'];
const PLAYER_ACTION_FRAME_SECONDS = 3 / 35;

/**
 * How fast a fall has to end to knock the wind out of the player. Vanilla's
 * `P_ZMovement` grunts below `momz < -8` units/tic, which under *its* gravity of
 * 1 unit/tic² is reached by a drop of 32 units — so the threshold is derived
 * from that drop height under this engine's own (feel-tuned, stronger)
 * `GRAVITY` rather than copying the speed. Matching the speed instead would
 * make shallower ledges grunt than vanilla's do, and 24 units — DOOM's most
 * common step height — sits right at that boundary.
 */
const HARD_LANDING_SPEED = Math.sqrt(2 * GRAVITY * 32);

/**
 * Slack added to the player's radius when testing a monster's hitscan bolt,
 * which is fired along a stale facing here — docs/monsters.md § Hitscan vs.
 * projectile.
 */
const MONSTER_BULLET_SLOP = 12;

/**
 * Vanilla's `A_FaceTarget`: aiming at an `MF_SHADOW` thing (here only ever the
 * player under partial invisibility) throws the facing off by
 * `(P_Random()-P_Random())<<21` BAM, ±255/2048 of a full turn. That is the
 * entire blur-sphere mechanic — it never touches sight or waking.
 */
const SHADOW_AIM_SPREAD_DEG = (255 / 2048) * 360;

/** One loaded WAD set, playing one level at a time. */
export class Game {
  private scene = new THREE.Scene();
  private materials: MaterialBank;
  private spriteBank: SpriteBank;
  private spriteMaterials: SpriteMaterialCache;
  private mapNames: string[];
  private mapIndex = 0;

  private map!: DoomMap;
  private world!: World;
  private player!: Player;
  private built: BuiltMap | null = null;
  private things: ThingLayer | null = null;
  private playerActor: SpriteActor;
  private wallFader!: WallFader;
  private flatFader!: FlatFader;
  private textureScroller!: TextureScroller;
  private animatedTextures!: AnimatedTextures;
  private fogOfWar!: FogOfWar;
  private specials?: SpecialsController;
  /** Teleport fog, impact explosions, the smoke trail, the vile's flame and hitscan tracers — see game/effects.ts. */
  private effects: EffectLayer;
  /** Everything in flight, player's and monsters' alike — see game/projectiles.ts. */
  private projectiles: ProjectileLayer;
  /** The live-level view `projectiles` and the splash helpers read this class through — see game/combat.ts. */
  private combat: CombatContext;
  private weaponSystem = new WeaponSystem();
  /**
   * Set by the exit trigger and consumed right after `specials.update()`
   * returns in `frame` — **never** loaded from inside the callback itself.
   * `handleWalkTriggers` runs partway through that `update()`, and a mover
   * ticked dirty earlier in the same call is only rebuilt afterwards; tearing
   * the scene down synchronously would leave that pending rebuild to `add` the
   * old map's mover mesh to the new map's scene, with nothing to clean it up.
   */
  private pendingExit = false;
  /** Damage floors and the secret counter for the current map — see game/sectoreffects.ts. */
  private sectorEffects!: SectorEffects;
  /**
   * Seconds spent in the current level, shown on the HUD as hh:mm:ss. Advanced below in `frame`,
   * gated the same way `tickPowers` is: frozen once `playerDead`. Never advances on the frame a
   * level-exit trigger fires either, without any extra check here — that frame already returns
   * early (see `pendingExit`'s doc) before reaching the increment.
   */
  private levelTime = 0;

  private running = false;
  private lastTime = 0;

  private view: Viewport;
  private audio: AudioEngine;
  private wad: Wad;
  private skill: Skill;
  private hud: Hud;
  private crosshair: Crosshair;
  /**
   * Measurement itself always runs — `performance.now()` calls are cheap enough
   * not to bother gating; only `DebugHud`'s decision to render the samples is
   * DEVMODE-gated.
   */
  private profiler = new FrameProfiler();
  private debugHud = new DebugHud();
  private screen: ScreenEffects;
  private inventory: Inventory = createInventory();
  /** True once the player's health has hit 0 — freezes movement/aim/firing/pickups (see `frame`) until `restart`. */
  private playerDead = false;
  readonly title: string;

  /** `?pos=x,y` override for the player start, consumed by the first map load. */
  private startPos: Pos2 | null;

  constructor(
    view: Viewport,
    audio: AudioEngine,
    wad: Wad,
    startMap: string,
    title: string,
    skill: Skill,
    startPos: Pos2 | null = null,
  ) {
    this.view = view;
    this.audio = audio;
    this.wad = wad;
    this.title = title;
    this.skill = skill;
    this.startPos = startPos;

    this.scene.background = new THREE.Color(0x05050a);
    this.scene.fog = new THREE.Fog(0x05050a, 2100, 3900);

    // The WAD set's own sound lumps, for as long as this Game owns the level.
    // The engine itself (and its AudioContext) outlives us — see AudioEngine.
    audio.setBank(new SoundBank(wad));

    const gfx = new GraphicsBank(wad);
    this.materials = new MaterialBank(gfx, view.renderer);
    // Session-scoped, same as `materials` above — depends only on the WAD
    // set's own graphics, not on which map is currently loaded.
    this.animatedTextures = new AnimatedTextures(gfx, this.materials);
    this.spriteBank = new SpriteBank(wad);
    this.spriteMaterials = new SpriteMaterialCache(gfx, view.renderer);
    this.hud = new Hud(gfx);
    this.crosshair = new Crosshair(view.renderer.domElement);
    this.mapNames = wad.mapNames();
    if (this.mapNames.length === 0) throw new Error('no maps in the selected WADs');

    // PLAY's own walk cycle: DOOM has no separate idle art, it just holds
    // frame A (this list's first entry) until the player is actually moving.
    this.playerActor = new SpriteActor(this.spriteBank, this.spriteMaterials, 'PLAY', ['A', 'B', 'C', 'D']);
    this.scene.add(this.playerActor.mesh);
    // The vile-flame resolver stays here rather than in EffectLayer: where the
    // flame belongs depends on live monster/player state (and on A_Fire's
    // sightline rule), which is this class's business, not the batch's.
    this.effects = new EffectLayer(this.scene, this.spriteBank, this.spriteMaterials, audio, (vileId, targetId) => {
      const vile = this.things?.monsterById(vileId);
      const target = targetId === null ? this.player : this.things?.monsterById(targetId);
      if (!vile || !target || !hasLineOfSight(this.world, vile, target)) return null;
      return this.vileFireFrontOf(target);
    });
    // `world`/`things`/`player`/`inventory` are all replaced on a map load (and
    // `inventory` again on restart), so the context reads them back off this
    // instance every time rather than capturing them — hence the getters, and
    // the alias, since an object literal's own `this` is the literal.
    const game = this;
    this.combat = {
      get world() {
        return game.world;
      },
      get things() {
        return game.things;
      },
      get player() {
        return game.player;
      },
      get playerDead() {
        return game.playerDead;
      },
      damagePlayer: (amount, fromX, fromY) => this.damagePlayer(amount, fromX, fromY),
      triggerShot: (lineIndex, byMonster) => this.specials?.triggerShot(lineIndex, this.inventory.keys, byMonster),
    };
    this.projectiles = new ProjectileLayer(this.combat, this.effects, this.spriteBank, this.spriteMaterials, audio);

    // Bound once rather than per frame: `playerActor` is never reassigned.
    this.screen = new ScreenEffects(view.renderer, (opacity) => this.playerActor.setOpacity(opacity));

    const wanted = this.mapNames.indexOf(startMap.toUpperCase());
    this.loadMapByIndex(wanted >= 0 ? wanted : 0);
  }

  get currentMap(): string {
    return this.mapNames[this.mapIndex];
  }

  private loadMapByIndex(index: number): void {
    // Keys don't survive a level transition in vanilla DOOM; health/armor/ammo do.
    finishLevel(this.inventory);
    // Whatever was still ringing belongs to the level being torn down — a door
    // closing, a monster's death cry — and its origins are about to be reused.
    this.audio.stopAll();
    this.weaponSystem.beginLevel(this.inventory);
    // A fresh map always starts with a living player — covers both a normal
    // level transition (which can't happen while dead; movement is frozen)
    // and `restart`'s "reload the same map" call, defensively in one place
    // rather than duplicated at each caller.
    this.playerDead = false;
    this.screen.clearDeath();
    this.playerActor.revive();
    this.mapIndex = (index + this.mapNames.length) % this.mapNames.length;
    const name = this.mapNames[this.mapIndex];

    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
    }
    if (this.things) {
      this.scene.remove(this.things.group);
      // The batched sprite meshes/materials are per-level; the geometry and
      // textures behind them belong to spriteMaterials, which outlives a map.
      this.things.dispose();
    }
    this.specials?.dispose();

    const t0 = performance.now();
    const map = loadMap(this.wad, name);
    this.map = map;
    this.sectorEffects = new SectorEffects(map);
    this.levelTime = 0;
    this.world = new World(map);
    // Both drop whatever was still in flight or mid-animation in the level
    // being torn down, which would otherwise carry over into the new one.
    this.effects.beginLevel(this.world);
    this.projectiles.beginLevel();
    // Sectors a door/lift/floor mover will drive are pulled out of the static
    // batches up front — SpecialsController owns their geometry instead (see
    // render/mapmesh.ts's MapMeshOptions doc for why).
    const movableSectors = computeMovableSectors(map);
    this.built = buildMapMesh(map, this.materials, { movableSectors });
    this.scene.add(this.built.group);
    this.wallFader = new WallFader(this.built.occluders, this.built.wallMeshes);
    this.flatFader = new FlatFader(this.built.flatSurfaces, this.built.flatMeshes);
    this.textureScroller = new TextureScroller(map, this.built.occluders, this.built.wallMeshes, this.materials);
    this.player = new Player(this.world);
    // Applied before fog of war is seeded, so an explicit start position reveals
    // exactly what is visible from there and nothing from the map's real spawn.
    if (this.startPos) {
      this.player.moveTo(this.startPos);
      this.startPos = null;
    }
    // Every level (re)load starts the camera facing the same way the player
    // spawns facing, instead of always defaulting to due-north regardless of
    // the map's own player-start angle.
    this.view.camera.yawDeg = (this.player.angle * 180) / Math.PI - 90;
    this.fogOfWar = new FogOfWar(this.world, this.built.occluders, this.player.x, this.player.y);
    this.specials = new SpecialsController(
      map,
      this.world,
      this.materials,
      this.scene,
      this.fogOfWar,
      this.built.polys,
      this.built,
      {},
      () => {
        this.pendingExit = true;
      },
      (dest) => {
        // Matches vanilla P_Teleport: a fog puff where the player stood, and
        // another just ahead of the landing spot along the direction it
        // faces — captured before/after teleportTo moves the player.
        this.effects.spawnTeleportFog(this.player);
        this.player.teleportTo(dest);
        this.effects.spawnTeleportFog({
          x: this.player.x + Math.cos(dest.angle) * TFOG_SPAWN_OFFSET,
          y: this.player.y + Math.sin(dest.angle) * TFOG_SPAWN_OFFSET,
          z: this.player.z,
        });
        // Snap the camera to face the same way the player now does, same as
        // the initial spawn — a teleport should reorient the view instantly,
        // not leave it aimed at wherever the old spot happened to be.
        this.view.camera.yawDeg = (dest.angle * 180) / Math.PI - 90;
      },
      (sectorIndex) => this.applyCrushDamage(sectorIndex),
      (sectorIndex, ceilingHeight) =>
        blocksCeilingLower(this.world, this.map, this.things, this.player, sectorIndex, ceilingHeight),
      (sectorIndex, floorHeight) =>
        blocksFloorRise(this.world, this.map, this.things, this.player, sectorIndex, floorHeight),
      this.player.x,
      this.player.y,
      this.audio,
    );

    this.things = buildThingSprites(
      map,
      this.world,
      this.spriteBank,
      this.spriteMaterials,
      this.skill,
      this.audio,
      // A_BossDeath — see docs/specials.md § Boss death. Player-alive gate is vanilla's own
      // "make sure there is a player alive for victory" check.
      (type) => {
        if (!this.playerDead) this.specials?.notifyBossDeath(type);
      },
    );
    this.scene.add(this.things.group);

    const provider = this.wad.providerOf(name)?.name ?? '?';
    console.info(
      `${name} (${provider}): ${map.sectors.length} sectors, ${map.linedefs.length} linedefs, ` +
        `${map.things.length} things (${this.things.count} rendered), ` +
        `${this.built.triangles} tris in ${Math.round(performance.now() - t0)} ms`,
    );
    if (this.built.missingTextures.length > 0) {
      console.warn('missing textures:', this.built.missingTextures.join(', '));
    }
  }

  resume(): void {
    if (this.running) return;
    // Reached from the Start button or Esc, i.e. from a real user gesture —
    // which is the only way a browser lets an AudioContext start.
    this.audio.resume();
    this.running = true;
    this.lastTime = performance.now();
    this.view.input.reset();
    requestAnimationFrame(this.frame);
  }

  pause(): void {
    this.running = false;
    this.audio.suspend();
  }

  dispose(): void {
    this.pause();
    // The engine is session-level and the next Game sets its own bank; this
    // only makes sure nothing from this level is left holding a channel.
    this.audio.stopAll();
    this.screen.reset();
    this.playerActor.dispose();
    this.specials?.dispose();
    this.built?.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    // Both sprite batches' instance buffers and cloned materials are their
    // own; the geometry/textures behind them are spriteMaterials'.
    this.things?.dispose();
    this.effects.dispose();
    this.materials.dispose();
    this.spriteMaterials.dispose();
  }

  /**
   * Applies a monster's damage to whatever it landed on — the player when
   * `targetId` is null, otherwise another monster, tagged with who did it so
   * `ThingLayer.damage` can run vanilla's retaliation rule and start an
   * infight. `fromX`/`fromY` are the attacking monster's own position, for
   * the knockback thrust both `damagePlayer` and `ThingLayer.damage` derive.
   */
  private damageFromMonster(
    targetId: number | null,
    damage: number,
    sourceId: number,
    sourceType: number,
    fromX: number,
    fromY: number,
  ): void {
    if (targetId === null) this.damagePlayer(damage, fromX, fromY);
    else this.things?.damage(targetId, damage, { id: sourceId, type: sourceType }, undefined, fromX, fromY);
  }

  /**
   * The arch-vile's `A_VileAttack` (`atk.blast`): not a traced bolt at all —
   * vanilla damages `actor->target` directly (guaranteed, nothing to miss
   * along), launches it upward, then blasts a radius. No tracer or projectile
   * sprite; the `FIRE` spawned here is `MT_FIRE`'s final burst, taking over
   * from `spawnVileWindupFire`'s. See docs/monsters.md § The arch-vile.
   */
  private resolveVileBlast(atk: MonsterAttackEvent): void {
    if (!atk.blast) return;
    const victim = atk.targetId === null ? null : this.things?.monsterById(atk.targetId);
    const at = victim ? { x: victim.x, y: victim.y, z: victim.z } : { x: this.player.x, y: this.player.y, z: this.player.z };
    if (atk.targetId === null) {
      // A no-op hit (already dead, or invulnerable) reports false — see
      // damagePlayer's doc — and skips the knockup along with it.
      if (this.damagePlayer(atk.damage, atk.x, atk.y)) this.player.launchUpward(atk.blast.knockUpSpeed);
    } else {
      this.things?.damage(
        atk.targetId,
        atk.damage,
        { id: atk.sourceId, type: atk.sourceType },
        atk.blast.knockUpSpeed,
        atk.x,
        atk.y,
      );
    }
    // A_VileAttack's own sound is the barrel/rocket explosion, played on the
    // vile rather than on the flame it just placed.
    this.audio.play('barexp', atk, monsterOrigin(atk.sourceId));
    const offset = this.vileFireOffset(atk, at);
    const fireAt = { x: at.x + offset.x, y: at.y + offset.y, z: at.z };
    applyRadiusDamage(this.combat, fireAt, atk.blast.splashRadius, atk.blast.splashDamage, true, {
      id: atk.sourceId,
      type: atk.sourceType,
    });
    this.effects.spawnImpact('FIRE', VILE_FIRE_FRAMES, IMPACT_FRAME_SECONDS, fireAt);
  }

  /**
   * The arch-vile's warning flame, spawned when its windup starts — vanilla's
   * `MT_FIRE`. Reuses `EffectLayer.spawn` but overrides the lifetime to the windup's
   * own length, so `resolveVileBlast`'s burst (or nothing, if the shot
   * fizzles) takes over with no explicit hand-off. Positioned up front, as
   * `A_VileTarget` calls `A_Fire` immediately after spawning. See
   * docs/monsters.md § The arch-vile.
   */
  private spawnVileWindupFire(atk: MonsterAttackEvent): void {
    const target = atk.targetId === null ? this.player : this.things?.monsterById(atk.targetId);
    if (!target) return;
    const front = this.vileFireFrontOf(target);
    // A_StartFire, on the flame itself (`vilatk` comes from the vile at the same
    // moment, via MonsterSounds.windup) — the two together are the warning.
    this.audio.play('flamst', front);
    const effect = this.effects.spawn('FIRE', VILE_FIRE_FRAMES, IMPACT_FRAME_SECONDS, front);
    if (!effect) return;
    effect.lifetime = VILE_WINDUP_TRACK_SECONDS;
    effect.followTargetId = atk.targetId;
    effect.vileSourceId = atk.sourceId;
    this.effects.addImpact(effect);
  }

  /**
   * Vanilla's `A_Fire`: 24 units in front of wherever the target is *currently
   * facing*, not toward the vile — contrast `vileFireOffset`, which is
   * `A_VileAttack`'s genuinely different final reposition.
   */
  private vileFireFrontOf(target: Pos3 & { angle: number }): Pos3 {
    return {
      x: target.x + Math.cos(target.angle) * VILE_FIRE_OFFSET,
      y: target.y + Math.sin(target.angle) * VILE_FIRE_OFFSET,
      z: target.z,
    };
  }

  /**
   * `resolveVileBlast`'s one-time final reposition — `A_VileAttack` moves the
   * fire 24 units from the target back toward the shooter, a genuinely
   * different formula from the windup's target-facing one, not an
   * inconsistency here. The offset also keeps the flame from spawning at the
   * target's exact x/y/z, where two anchored billboards hide each other.
   */
  private vileFireOffset(atk: MonsterAttackEvent, targetPos: Pos2): Pos2 {
    const towardVile = Math.atan2(atk.y - targetPos.y, atk.x - targetPos.x);
    return { x: Math.cos(towardVile) * VILE_FIRE_OFFSET, y: Math.sin(towardVile) * VILE_FIRE_OFFSET };
  }

  /**
   * Traces a monster's hitscan bolt and damages the first thing it reaches —
   * nearest of a wall, another monster in the line of fire, or the player
   * wins. `P_LineAttack` has no notion of an intended target and no species
   * check, which is why one zombieman firing past another starts a fight. The
   * tracer is drawn to where the bolt stopped, not to the target.
   */
  private resolveMonsterHitscan(atk: MonsterAttackEvent): void {
    // Sloped from the monster's fire height to the target's, the way
    // P_AimLineAttack works out a slope before P_LineAttack traces it — what
    // lets a zombieman on a ledge shoot down at you.
    const victim = atk.targetId === null ? null : this.things?.monsterById(atk.targetId);
    const aim = victim
      ? { x: victim.x, y: victim.y, z: victim.z + MONSTER_FIRE_HEIGHT }
      : { x: this.player.x, y: this.player.y, z: this.player.z + AIM_HEIGHT_OFFSET };
    const path = shotPath(this.world, atk, atk.angleRad, aim, false);

    // The trace damages the first body it reaches, whatever it was aimed at.
    const blocker = this.things?.raycastMonster(atk, atk.angleRad, path.dist, {
      ignoreId: atk.sourceId,
      includeHidden: true,
    });
    const dirX = Math.cos(atk.angleRad);
    const dirY = Math.sin(atk.angleRad);
    const relX = this.player.x - atk.x;
    const relY = this.player.y - atk.y;
    const playerAlong = relX * dirX + relY * dirY;
    const perpX = relX - dirX * playerAlong;
    const perpY = relY - dirY * playerAlong;
    const playerInPath =
      !this.playerDead &&
      playerAlong >= 0 &&
      playerAlong <= path.dist &&
      Math.hypot(perpX, perpY) <= PLAYER_RADIUS + MONSTER_BULLET_SLOP;

    let endX = atk.x + dirX * path.dist;
    let endY = atk.y + dirY * path.dist;
    let endZ = path.z;
    if (blocker && (!playerInPath || blocker.dist <= playerAlong)) {
      this.things?.damage(blocker.id, atk.damage, { id: atk.sourceId, type: atk.sourceType }, undefined, atk.x, atk.y);
      endX = blocker.x;
      endY = blocker.y;
      endZ = blocker.z + MONSTER_FIRE_HEIGHT;
      const hitAt = { x: endX, y: endY, z: endZ };
      if (this.things?.bleeds(blocker.id)) this.effects.spawnBlood(hitAt, atk.damage);
      else this.effects.spawnPuff(hitAt);
    } else if (playerInPath) {
      this.damagePlayer(atk.damage, atk.x, atk.y);
      endX = this.player.x;
      endY = this.player.y;
      endZ = this.player.z + AIM_HEIGHT_OFFSET;
      // The player carries no MF_NOBLOOD either, so a bolt that reaches them
      // splashes exactly as one landing on a monster does — and unlike the
      // pain flash this isn't gated on the damage actually landing, matching
      // `PTR_ShootTraverse` spawning blood before it calls `P_DamageMobj`.
      this.effects.spawnBlood({ x: endX, y: endY, z: endZ }, atk.damage);
    } else {
      // Nothing living stopped it — whatever's left is a wall, the only thing
      // `shotPath` itself could have blocked it on. `triggerShot`'s
      // `byMonster` gate reproduces vanilla's own hardcoded exception: this
      // can only actually do anything for a 46 line, never 24/47.
      this.specials?.triggerShot(path.lineIndex, this.inventory.keys, true);
      spawnWallPuff(this.effects, this.world, path, atk.angleRad);
    }
    this.effects.addTracer(atk, { x: endX, y: endY, z: endZ }, MONSTER_TRACER_COLOR);
  }

  /**
   * Runs the walk triggers a monster crossed this frame
   * (`SpecialsController.crossMonster` — teleports plus the few door/lift
   * types vanilla lets a monster activate). A teleport gets the same `TFOG`
   * puff at both ends the player's own does; vanilla spawns it for any thing
   * that teleports, not just the player.
   */
  private monsterCrossedLines(prev: Pos2, pos: Pos2): Placement | null {
    const dest = this.specials?.crossMonster(prev, pos, this.inventory.keys);
    if (!dest) return null;
    this.effects.spawnTeleportFog({ x: pos.x, y: pos.y, z: this.world.groundFloor(pos.x, pos.y, 0) });
    this.effects.spawnTeleportFog({
      x: dest.x + Math.cos(dest.angle) * TFOG_SPAWN_OFFSET,
      y: dest.y + Math.sin(dest.angle) * TFOG_SPAWN_OFFSET,
      z: this.world.groundFloor(dest.x, dest.y, 0),
    });
    return dest;
  }

  /**
   * Applies armor-mitigated damage (`applyDamage`) to the player, transitioning to the death
   * animation once health hits 0. `fromX`/`fromY`, when both given, are where the damage
   * physically came from — same omitted-for-damage-floors-and-crushers convention as
   * `ThingLayer.damage`'s own params — and drive vanilla's `P_DamageMobj` knockback.
   *
   * Returns whether the hit actually landed; `false` covers both a no-op corpse hit and
   * invulnerability blocking it outright, so a caller with a follow-up effect (e.g.
   * `resolveVileBlast`'s knockup) can gate on it. See docs/combat.md § Player death.
   */
  private damagePlayer(amount: number, fromX?: number, fromY?: number): boolean {
    if (this.playerDead || amount <= 0) return false;
    const healthBefore = this.inventory.health;
    if (!applyDamage(this.inventory, amount)) return false;
    if (fromX !== undefined && fromY !== undefined) {
      let dx = this.player.x - fromX;
      let dy = this.player.y - fromY;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) {
        // Same degenerate-same-position fallback as ThingLayer.damage.
        dx = Math.cos(this.player.angle);
        dy = Math.sin(this.player.angle);
      } else {
        dx /= dist;
        dy /= dist;
      }
      const speed = thrustSpeed(amount, PLAYER_MASS);
      this.player.applyKnockback(dx * speed, dy * speed);
    }
    this.screen.addPain(amount);
    if (this.inventory.health <= 0) {
      this.playerDead = true;
      // A_PlayerScream: the drawn-out `pdiehi` for a death that overkilled by
      // more than 50, the ordinary `pldeth` otherwise. Vanilla tests the
      // *post-hit* health, which goes negative there; `applyDamage` clamps it at
      // 0, so the overkill is reconstructed from the hit instead — off by
      // however much armor absorbed, which only shifts a few borderline deaths
      // between the two cries.
      this.audio.play(amount > healthBefore + 50 ? 'pdiehi' : 'pldeth', this.player, PLAYER_ORIGIN);
      this.playerActor.die(PLAYER_DEATH_FRAMES, PLAYER_DEATH_FRAME_SECONDS);
      this.screen.showDeath();
      return true;
    }
    this.audio.play('plpain', this.player, PLAYER_ORIGIN);
    this.playerActor.playOnce(PLAYER_PAIN_FRAMES, PLAYER_ACTION_FRAME_SECONDS);
    return true;
  }

  /**
   * `SpecialsController`'s `onCrush` callback: it owns the moving geometry but
   * has no idea who's standing in it, so it hands back a sector index. 2D
   * membership only, like `applyRadiusDamage` — see docs/specials.md §
   * Crushers. Gated on `PIT_ChangeSector`'s actual "doesn't fit" test (the
   * sector's current headroom against `PLAYER_HEIGHT`/`MONSTER_HIT_HEIGHT`),
   * not merely standing in the sector — a crusher parked at the top of its
   * travel, or one that hasn't reached someone yet, must not deal damage.
   * Monsters and barrels share one loop (`crushablesInSector`): vanilla's
   * `PIT_ChangeSector` treats any shootable mobj the same way, so a barrel
   * dies and explodes exactly like it would from gunfire.
   */
  private applyCrushDamage(sectorIndex: number): void {
    const sector = this.map.sectors[sectorIndex];
    const gap = sector.ceilHeight - sector.floorHeight;
    if (gap < PLAYER_HEIGHT && this.world.sectorIndexAt(this.player.x, this.player.y) === sectorIndex) {
      this.damagePlayer(CRUSH_DAMAGE);
    }
    if (gap < MONSTER_HIT_HEIGHT) {
      for (const m of this.things?.crushablesInSector(sector) ?? []) this.things?.damage(m.id, CRUSH_DAMAGE);
    }
  }

  /**
   * Throws a monster's ranged shot off-aim while the player holds partial
   * invisibility — `A_FaceTarget`'s fuzz, applied per shot so each bullet of a
   * burst goes its own way. Player-aimed shots only (nothing else carries
   * `MF_SHADOW`), and ranged only: a melee swing lands on `P_CheckMeleeRange`,
   * never on the fuzzed angle. See docs/items.md § Powerups and the backpack.
   */
  private applyShadowAim(atk: MonsterAttackEvent): void {
    if (atk.kind !== 'ranged' || atk.targetId !== null || !hasPower(this.inventory, 'invisibility')) return;
    // Vanilla's own P_Random-P_Random shape: a triangular spread centred on
    // the true aim, the same trick weapons.ts uses for pellet spread.
    const off = ((Math.random() - Math.random()) * SHADOW_AIM_SPREAD_DEG * Math.PI) / 180;
    atk.angleRad += off;
    if (atk.projectiles) for (const proj of atk.projectiles) proj.angleRad += off;
  }

  /** `R`, while dead: a fresh inventory and a reload of the current map — `loadMapByIndex` resets the player/world/specials/fog and, via the doc on its own top, `playerDead`/the death overlay/`playerActor` too. */
  private restart(): void {
    this.inventory = createInventory();
    this.loadMapByIndex(this.mapIndex);
  }

  private frame = (now: number) => {
    if (!this.running) return;
    // rawDt is the real elapsed wall-clock time; dt clamps it so physics/AI
    // never take a giant step after a stall (tab backgrounded, a slow map
    // load). `DebugHud` gets rawDt, not dt — a clamped delta makes a genuine
    // slideshow under-detect itself, since ten clamped 0.05s steps reach the
    // fps accumulator's 0.5s threshold long before ten real frames have.
    const rawDt = (now - this.lastTime) / 1000;
    const dt = Math.min(0.05, rawDt);
    this.lastTime = now;
    this.profiler.beginFrame();

    const { input, camera } = this.view;
    handleHotkeys(input, camera, this.audio, (delta) => this.loadMapByIndex(this.mapIndex + delta));
    // Set before any system runs, since specials/monsters/weapons all raise
    // sounds during the update below. The camera's yaw is last frame's (it
    // settles in `camera.update`, at the end) — a frame of smoothing lag on the
    // pan axis, which is inaudible.
    this.audio.setListener(this.player, camera.viewerAngleDeg + 180);
    camera.applyYawInput(input, dt);

    // Runs before player.update so a lift/door the player is standing on has
    // already moved this frame by the time groundFloor is sampled below.
    this.profiler.time('Specials', () =>
      this.specials?.update(dt, this.player.x, this.player.y, this.player.angle, input, this.inventory.keys),
    );
    // Deferred from the exit trigger's callback — see `pendingExit`'s doc.
    // The old SpecialsController's update() has now fully returned, so it's
    // safe to dispose it and swap in the next map.
    if (this.pendingExit) {
      this.pendingExit = false;
      this.loadMapByIndex(this.mapIndex + 1);
      input.endFrame();
      requestAnimationFrame(this.frame);
      return;
    }

    // Auto-aim, movement, firing and pickups all freeze once the player is
    // dead — there's nothing to aim/move/fire/collect with a corpse — but
    // fog of war, things, effects, faders and rendering below keep ticking
    // normally, so a still-flying rocket the player fired right before dying
    // finishes its flight and can still deal splash damage (including, in a
    // grim-but-correct edge case, to the player's own corpse — damagePlayer
    // is a no-op once already dead, so this can't double-kill).
    let aim: Pos2 | null = null;
    if (!this.playerDead) {
      // Ticked with the rest of the player's own update and not while dead,
      // matching vanilla: powers age in `P_PlayerThink`, which hands off to
      // `P_DeathThink` and returns before reaching them once health hits 0.
      tickPowers(this.inventory, dt);
      // The cursor hovering over a monster locks aim onto its actual position
      // and height. **On hover, not on click** — `aim` drives `player.angle`
      // and the camera's lead unconditionally, so gating the lock to
      // `mouseDown` makes both jump the instant a click lands. See
      // docs/combat.md § Auto-aim.
      const monster = this.profiler.time('Player', () => {
        const m = this.things?.pickMonster(camera.raycasterFor(input.pointer.x, input.pointer.y)) ?? null;
        aim = m ?? camera.pointerToPlane(input.pointer.x, input.pointer.y, this.player.z + AIM_HEIGHT_OFFSET);
        // Monsters are solid: the player walks around them, not through them.
        this.player.update(dt, input, aim, camera.viewerAngleDeg + 180, this.things?.solidBodies(this.player));
        return m;
      });

      // A shot always *starts* at the player's own fire height — never the
      // target's, or a tracer/projectile would visibly begin mid-air instead
      // of at the player. Handing shotPath the locked-on monster as its
      // target is what makes the shot angle toward *its* height and stop
      // there; see world.ts's shotPath/blocksShot for why a locked shot is
      // allowed to clear the floor steps a free one is stopped by.
      const fireStartZ = this.player.z + AIM_HEIGHT_OFFSET;
      const fireTarget = monster ? { x: monster.x, y: monster.y, z: monster.z + AIM_HEIGHT_OFFSET } : null;

      this.profiler.time('Weapons', () => {
        // After player.update so player.angle already reflects this frame's aim.
        this.weaponSystem.handleSwitching(input, this.inventory, input.consumeWheel());
        const shots = this.weaponSystem.update(dt, input.mouseDown, this.inventory, this.player.angle);
        // Vanilla's P_FireWeapon calls P_NoiseAlert every time a shot is actually
        // fired (ammo/cooldown allowed it) — this is what lets a monster with no
        // line of sight to the player still wake up on gunfire (World.noiseAlert,
        // game/world.ts). Melee swings count: P_FireWeapon is the same entry
        // point for every weapon, so swinging a fist in an empty room wakes the
        // neighbours the same as firing a pistol would.
        if (shots.length > 0) {
          this.world.noiseAlert(this.player.x, this.player.y);
          this.playerActor.playOnce(PLAYER_ATTACK_FRAMES, PLAYER_ACTION_FRAME_SECONDS);
          // One shot sound per trigger pull, not per pellet (see
          // `WeaponDef.fireSound`), on the player's own origin — so a held
          // chaingun trigger keeps cutting itself off instead of stacking up.
          // A melee swing's own sound comes later, from `spawnPlayerShot`, which is
          // the only place that knows whether it connected.
          const fire = WEAPONS[this.inventory.currentWeapon].fireSound;
          if (fire) this.audio.play(fire, this.player, PLAYER_ORIGIN);
        }
        for (const shot of shots) {
          this.projectiles.spawnPlayerShot(shot, fireStartZ, fireTarget, monster ? monster.id : null);
        }
      });

      this.profiler.time('Player', () => {
        this.things?.tryPickup(this.player, PICKUP_RANGE, (type, dropped) => {
          const taken = applyPickup(this.inventory, type, dropped);
          // The computer area map's whole effect lives outside the inventory
          // struct — see COMPUTER_MAP_TYPE's doc.
          if (taken && type === COMPUTER_MAP_TYPE) this.fogOfWar.revealAll();
          // Unattenuated, as vanilla plays every pickup: you're standing on it.
          if (taken) this.audio.play(pickupSound(type));
          return taken;
        });
        const exit = this.sectorEffects.update(dt, this.world, this.player, this.inventory, (amount) =>
          this.damagePlayer(amount),
        );
        if (exit) this.pendingExit = true;
      });

      // Hard landings and the chainsaw's two ambient sounds, both of which
      // belong to a living player only.
      if (this.player.landingSpeed > HARD_LANDING_SPEED) this.audio.play('oof', this.player, PLAYER_ORIGIN);
      this.weaponSystem.updateSounds(dt, input.mouseDown, this.inventory, this.audio, this.player);
    } else if (input.pressed('KeyR')) {
      this.restart();
      input.endFrame();
      requestAnimationFrame(this.frame);
      return;
    }
    if (!this.playerDead) this.levelTime += dt;
    camera.update(dt, { x: this.player.x, y: this.player.y, z: this.player.eyeZ }, aim);
    this.hud.update(this.inventory, {
      kills: this.things?.stats.kills ?? 0,
      totalKills: this.things?.stats.totalKills ?? 0,
      items: this.things?.stats.items ?? 0,
      totalItems: this.things?.stats.totalItems ?? 0,
      secrets: this.sectorEffects.secretsFound,
      totalSecrets: this.sectorEffects.totalSecrets,
      elapsedSeconds: this.levelTime,
    });
    this.crosshair.update(this.inventory.health);
    this.screen.update(dt, this.inventory);

    this.profiler.time('Fog of War', () => this.fogOfWar.update(dt, this.player.x, this.player.y));
    const fog = this.fogOfWar;
    const fogAlphaOf = (subsector: number) => fog.alphaOf(subsector);
    // `null` once the player is dead, matching `P_KillMobj` stripping the
    // player's `MF_SHOOTABLE`/`MF_SOLID` — docs/combat.md § Player death for
    // what that does and doesn't freeze in the AI. Every attack a monster
    // fired this frame comes back for us to apply/render, the same "system
    // returns data, caller realizes it" split as `WeaponSystem.update`.
    const thingUpdate = this.profiler.time(
      'Monsters',
      () =>
        this.things?.update(
          dt,
          camera.viewerAngleDeg,
          this.playerDead ? null : this.player,
          fogAlphaOf,
          (prev, pos) => this.monsterCrossedLines(prev, pos),
        ) ?? { attacks: [], barrelExplosions: [] },
    );
    const monsterAttacks = thingUpdate.attacks;
    this.profiler.time('Monsters', () => {
      for (const atk of monsterAttacks) {
        // Applied here rather than inside game/monsters.ts because whether the
        // player is currently shadowed is inventory state, which the AI has no
        // reason to know about — the same "systems report, game.ts realizes"
        // split every other attack effect on this loop follows.
        this.applyShadowAim(atk);
        // The arch-vile's windup warning — see spawnVileWindupFire's doc.
        // Purely cosmetic (no damage, no trace), so it's handled before
        // (and separately from) every other kind below.
        if (atk.kind === 'vileWindup') {
          this.spawnVileWindupFire(atk);
          continue;
        }
        // A monster with a real flying projectile (game/monsters.ts's
        // MONSTER_STATS, e.g. the imp's fireball) launches one instead of
        // resolving as an instant hit — damage lands later, on arrival
        // (ProjectileLayer.update), not here.
        if (atk.kind === 'ranged' && atk.projectiles) {
          this.projectiles.spawnMonsterShot(atk);
        } else if (atk.kind === 'ranged' && atk.blast) {
          // The arch-vile's real attack — guaranteed damage plus knockback
          // and a radius blast, not a traced hitscan bolt. See
          // resolveVileBlast's doc for why this needs its own path.
          this.resolveVileBlast(atk);
        } else if (atk.kind === 'ranged') {
          // A hitscan bolt (the human gunners, the spider mastermind) traces
          // its actual flight and damages the first thing in the way, which
          // need not be what it aimed at — vanilla's P_LineAttack has no
          // species check whatsoever, so monsters really do gun each other
          // down when one walks through another's line of fire.
          this.resolveMonsterHitscan(atk);
        } else {
          // Melee lands on whatever it swung at, no trace involved.
          this.damageFromMonster(atk.targetId, atk.damage, atk.sourceId, atk.sourceType, atk.x, atk.y);
        }
      }
      // A barrel's own A_Explode, become due this frame (game/things.ts's
      // update() ticks the delay; see applyBarrelExplosion's doc). No visual
      // spawned effect is needed here the way every other explosion needs one —
      // the barrel's own PosedThing is already drawing its BEXP death
      // animation at exactly this spot.
      for (const exp of thingUpdate.barrelExplosions) applyBarrelExplosion(this.combat, exp);
    });
    this.profiler.time('Effects', () => {
      // One begin/end pair around all four lists, the same per-frame rebuild
      // `game/things.ts` does — and it has to enclose `ProjectileLayer.update`,
      // which both draws through the batch and pushes this frame's new impact
      // explosions and smoke puffs on for `updateImpacts` to draw.
      this.effects.beginFrame(camera.viewerAngleDeg);
      this.effects.updateTeleportFogs(dt);
      this.effects.updateTracers(dt);
      this.projectiles.update(dt);
      this.effects.updateImpacts(dt);
      this.effects.endFrame();
    });

    this.profiler.time('Fading', () => {
      const camPos = camera.camera.position;
      const camArgs = [dt, camPos.x, -camPos.z, camPos.y] as const;
      const fadeTargets = collectFadeTargets(this.player, this.things?.awakeMonsters() ?? []);
      const openingOf = (line: number) => this.world.openingOf(line);
      this.wallFader.update(...camArgs, fadeTargets, openingOf);
      this.flatFader.update(...camArgs, fadeTargets);
      // Walls resolve their own subsector inside FogOfWar (see wallAlpha); flats
      // and things already know theirs, so they go through alphaOf directly.
      this.wallFader.commit((i) => fog.wallAlpha(i));
      this.flatFader.commit(fogAlphaOf);
      // Independent of camera/player position — a scrolling wall animates
      // whether or not it's currently faded or in view.
      this.textureScroller.update(dt);
      // Same independence, and session-scoped rather than per-map (see its
      // construction above) — an animated liquid/fire texture keeps cycling
      // across a level transition exactly as it does within one.
      this.animatedTextures.update(dt);
      // Door/lift geometry lives in its own meshes (game/specials.ts), so it
      // carries its own faders rather than the two above.
      this.specials?.updateFading(...camArgs, fadeTargets);
    });

    const facingDeg = (this.player.angle * 180) / Math.PI;
    const sector = this.world.sectorAt(this.player.x, this.player.y);
    // player.update (and with it, velX/velY) stops running once dead, so
    // this must not read possibly-stale velocity from the moment of death —
    // not that it would matter anyway, since setPose ignores `animating`
    // entirely once `die()` has been called (see SpriteActor's doc).
    const walking = !this.playerDead && Math.hypot(this.player.velX, this.player.velY) > 1;
    this.playerActor.setPose(
      this.player.x,
      this.player.y,
      this.player.z,
      facingDeg,
      sector?.light ?? 128,
      dt,
      walking,
      camera.viewerAngleDeg,
    );

    this.profiler.time('Render', () => this.view.renderer.render(this.scene, camera.camera));
    this.profiler.endFrame();

    this.debugHud.update(rawDt, this.profiler, (fps) => this.debugLines(fps));

    input.endFrame();
    requestAnimationFrame(this.frame);
  };

  /** DEVMODE's status text. Only ever called while the panel is shown — see `DebugHud.update`. */
  private debugLines(fps: number): string[] {
    const { camera } = this.view;
    const sector = this.world.sectorIndexAt(this.player.x, this.player.y);
    return [
      `${this.currentMap}   ${this.title}`,
      `${fps} fps   ${this.built?.triangles ?? 0} tris   monsters awake ${this.things?.awakeMonsterCount() ?? 0}`,
      `pos ${this.player.x.toFixed(0)}, ${this.player.y.toFixed(0)}   z ${this.player.z.toFixed(0)}   sector ${sector}`,
      `cam ${camera.distance.toFixed(0)}u ${camera.tiltDeg.toFixed(0)}°tilt ${camera.yawDeg.toFixed(0)}°yaw`,
      '',
      'WASD move  Shift run  mouse aim/fire  1-7/wheel weapon  Q-E/drag cam  Space use',
      'N/P map  +/- zoom  [/] tilt  R restart  M mute  Esc menu',
    ];
  }
}
