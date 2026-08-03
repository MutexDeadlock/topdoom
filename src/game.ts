import * as THREE from 'three';
import type { Wad } from './wad/wad.ts';
import { GraphicsBank } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap, type DoomMap } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { buildMapMesh, type BuiltMap } from './render/mapmesh.ts';
import { SpriteActor, SpriteMaterialCache, buildThingSprites, type ThingLayer } from './render/sprites.ts';
import { FlatFader, WallFader } from './render/occlusion.ts';
import { TopDownCamera } from './render/camera.ts';
import { World, hasLineOfSight, shotPath } from './game/world.ts';
import { Player, PLAYER_HEIGHT, PLAYER_RADIUS } from './game/player.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { SpecialsController, computeMovableSectors } from './game/specials.ts';
import { CRUSH_DAMAGE } from './wad/specials.ts';
import { Input } from './game/input.ts';
import { Hud } from './ui/hud.ts';
import type { Skill } from './game/skill.ts';
import {
  applyDamage,
  applyPickup,
  createInventory,
  finishLevel,
  ITEM_PICKUP_RADIUS,
  type Inventory,
} from './game/inventory.ts';
import { WeaponSystem, type Shot } from './game/weapons.ts';
import { Tracer } from './render/tracer.ts';
import { DEVMODE } from './constants.ts';

/** Combined radius (map units) within which an item is close enough to pick up. */
const PICKUP_RANGE = PLAYER_RADIUS + ITEM_PICKUP_RADIUS;

const hudEl = document.getElementById('hud')!;

/** Camera-orbit degrees per pixel of right-mouse drag. */
const YAW_SENSITIVITY = 0.15;
/** Degrees Q/E snap the camera per press — a keyboard alternative to right-drag. */
const KEY_YAW_STEP = 45;
/** Seconds between auto-repeated Q/E steps while the key stays held, after the initial tap. */
const KEY_YAW_REPEAT_INTERVAL = 0.26;

/**
 * Teleport-fog puff (vanilla's MT_TFOG): a one-shot animation, not a real
 * thing, so it lives outside `ThingLayer` — no pickup/fog-of-war/skill
 * filtering applies, it just plays through its frames once and disappears.
 * `TFOG` has only rotation-0 (omnidirectional) art, confirmed against
 * DOOM2.WAD's lump names (TFOGA0..TFOGJ0, no per-angle variants), matching
 * how blood/explosion-style effect sprites are drawn in vanilla regardless of
 * viewing angle.
 */
const TFOG_FRAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const TFOG_FRAME_SECONDS = 6 / 35; // vanilla's S_TFOG* states hold each frame 6 tics
/** Vanilla spawns the destination fog 20 units ahead of the landing spot, along the direction it faces. */
const TFOG_SPAWN_OFFSET = 20;

/**
 * A transient, one-shot sprite animation: plays through `frames` once at a
 * fixed spot and then removes itself. Used for both the teleport-fog puff
 * and a projectile's impact explosion below — neither is a real map `Thing`,
 * so neither goes through `ThingLayer`.
 */
interface OneShotEffect {
  actor: SpriteActor;
  x: number;
  y: number;
  z: number;
  light: number;
  elapsed: number;
  lifetime: number;
}

/**
 * Height above the feet a weapon fires from, and the plane the mouse cursor
 * is projected onto for aiming (`camera.pointerToPlane` below) — the two
 * have to match, or a tracer/projectile would visibly start from a different
 * height than where the crosshair appears to be.
 */
const AIM_HEIGHT_OFFSET = 32;

/** Color of a hitscan tracer line (render/tracer.ts) — a hot yellow-white, like a vanilla muzzle flash. */
const TRACER_COLOR = 0xfff2a8;
/** Color of a BFG spray tracer (WeaponDef.splash's `tracers`) — the same green as the BFG's own ball/explosion sprites, distinguishing it from a hitscan's muzzle-flash yellow. */
const BFG_TRACER_COLOR = 0x66ff33;
/** Color of a monster's ranged-attack tracer (game/monsters.ts) — a hostile red, distinct from either of the player's own tracer colors above. */
const MONSTER_TRACER_COLOR = 0xff4433;

/**
 * Frame letters an in-flight projectile sprite cycles through while flying.
 * `MISL` (rocket) only has directional flight art on frame A — B-D are its
 * explosion frames, played separately (see IMPACT_EFFECTS) once it lands —
 * while `PLSS`/`BFS1` (plasma bolt, BFG ball) are each a 2-frame
 * omnidirectional pulse. Falls back to a single held frame for anything not
 * listed.
 */
const PROJECTILE_FRAMES: Record<string, string[]> = {
  PLSS: ['A', 'B'],
  BFS1: ['A', 'B'],
};

/** Vanilla's own explosion states run at 4 tics/frame. */
const IMPACT_FRAME_SECONDS = 4 / 35;

/**
 * A projectile's impact explosion, keyed by its flight sprite: vanilla's
 * `MISL` reuses its own sprite name for the rocket's explosion (frames B-D,
 * omnidirectional), while the plasma bolt and BFG ball explode into their
 * own dedicated sprites. Purely cosmetic — it plays where a shot reached
 * shotPath's distance; whether (and what) it actually damaged is resolved
 * separately, in `spawnShot`/`updateProjectiles`/`applyRadiusDamage` below.
 */
const IMPACT_EFFECTS: Record<string, { sprite: string; frames: string[] }> = {
  MISL: { sprite: 'MISL', frames: ['B', 'C', 'D'] },
  PLSS: { sprite: 'PLSE', frames: ['A', 'B', 'C', 'D', 'E'] },
  BFS1: { sprite: 'BFE1', frames: ['A', 'B', 'C', 'D', 'E', 'F'] },
};

/**
 * Player death animation frame letters, confirmed against the actual `PLAY`
 * lump names in DOOM.WAD/DOOM2.WAD the same way game/thingdefs.ts's
 * MONSTER_DEATH_FRAMES were: PLAY's rotation-0-only tail runs H through W
 * (16 letters), split as DIE1-7 (H-N, this sequence) then XDIE1-9 (O-W, the
 * gib variant this engine doesn't model — see MONSTER_DEATH_FRAMES's doc).
 */
const PLAYER_DEATH_FRAMES = ['H', 'I', 'J', 'K', 'L', 'M', 'N'];
const PLAYER_DEATH_FRAME_SECONDS = 6 / 35;

interface Projectile {
  actor: SpriteActor;
  originX: number;
  originY: number;
  /** Fire height at launch (the player's) — see spawnShot's doc for why this is never the target's own height. */
  startZ: number;
  /** shotPath's actual stopping height — the target's height if unobstructed, or wherever it got blocked short of that. */
  endZ: number;
  angleRad: number;
  speed: number;
  /** Distance (map units) to where shotPath says this shot's flight ends. */
  maxDist: number;
  traveled: number;
  light: number;
  /** SpriteBank name (PROJECTILE_FRAMES's key), so the impact explosion can look it up in IMPACT_EFFECTS. */
  sprite: string;
  /** Direct-hit damage, applied to `hitMonsterId` (if any) on arrival. */
  damage: number;
  /** Splash to apply at the impact point regardless of what was targeted, or null for a non-explosive projectile — see weapons.ts's WeaponDef.splash. */
  splash: { radius: number; damage: number; hitsPlayer: boolean; tracers: boolean } | null;
  /** The monster this shot was locked onto *and actually reached* (spawnShot resolves that), or null — a free shot, one that missed a monster it wasn't locked onto, or a locked shot a wall cut short before the target. */
  hitMonsterId: number | null;
}

/**
 * Renderer, canvas, camera and input live for the whole session — a new level
 * must not cost a new WebGL context.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: TopDownCamera;
  readonly input: Input;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new TopDownCamera(window.innerWidth / window.innerHeight);
    this.input = new Input(this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.setAspect(window.innerWidth / window.innerHeight);
    });
  }
}

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
  private fogOfWar!: FogOfWar;
  private specials?: SpecialsController;
  private teleportFogs: OneShotEffect[] = [];
  private impacts: OneShotEffect[] = [];
  private weaponSystem = new WeaponSystem();
  private tracers: Tracer[] = [];
  private projectiles: Projectile[] = [];
  /**
   * Set by the exit trigger and consumed right after `specials.update()`
   * returns in `frame` — never loaded from inside the callback itself. The
   * exit line is found by `SpecialsController.handleWalkTriggers`, partway
   * through its own `update()`; a mover ticked dirty earlier that same call
   * (e.g. a lift mid-move) is only rebuilt afterwards, by `rebuildAround`.
   * Tearing down the scene synchronously inside the callback would run that
   * still-pending rebuild on an already-disposed, orphaned `SpecialsController`
   * — it would rebuild the old map's mover mesh from stale data and `add` it
   * to the *new* map's scene, with nothing left to ever clean it up.
   */
  private pendingExit = false;

  private renderCeilings = false;
  private running = false;
  private lastTime = 0;
  /** Seconds Q/E has been continuously held, for auto-repeat — see `frame`. */
  private qHoldTime = 0;
  private eHoldTime = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 0;

  private view: Viewport;
  private wad: Wad;
  private skill: Skill;
  private hud: Hud;
  private inventory: Inventory = createInventory();
  private deathOverlay = document.getElementById('death-overlay')!;
  /** True once the player's health has hit 0 — freezes movement/aim/firing/pickups (see `frame`) until `restart`. */
  private playerDead = false;
  readonly title: string;

  /** `?pos=x,y` override for the player start, consumed by the first map load. */
  private startPos: { x: number; y: number } | null;

  constructor(
    view: Viewport,
    wad: Wad,
    startMap: string,
    title: string,
    skill: Skill,
    startPos: { x: number; y: number } | null = null,
  ) {
    this.view = view;
    this.wad = wad;
    this.title = title;
    this.skill = skill;
    this.startPos = startPos;

    this.scene.background = new THREE.Color(0x05050a);
    this.scene.fog = new THREE.Fog(0x05050a, 2100, 3900);

    const gfx = new GraphicsBank(wad);
    this.materials = new MaterialBank(gfx, view.renderer);
    this.spriteBank = new SpriteBank(wad);
    this.spriteMaterials = new SpriteMaterialCache(gfx, view.renderer);
    this.hud = new Hud(gfx);
    this.mapNames = wad.mapNames();
    if (this.mapNames.length === 0) throw new Error('no maps in the selected WADs');

    // PLAY's own walk cycle: DOOM has no separate idle art, it just holds
    // frame A (this list's first entry) until the player is actually moving.
    this.playerActor = new SpriteActor(this.spriteBank, this.spriteMaterials, 'PLAY', ['A', 'B', 'C', 'D']);
    this.scene.add(this.playerActor.mesh);

    const wanted = this.mapNames.indexOf(startMap.toUpperCase());
    this.loadMapByIndex(wanted >= 0 ? wanted : 0);
  }

  get currentMap(): string {
    return this.mapNames[this.mapIndex];
  }

  private loadMapByIndex(index: number): void {
    // Keys don't survive a level transition in vanilla DOOM; health/armor/ammo do.
    finishLevel(this.inventory);
    // A fresh map always starts with a living player — covers both a normal
    // level transition (which can't happen while dead; movement is frozen)
    // and `restart`'s "reload the same map" call, defensively in one place
    // rather than duplicated at each caller.
    this.playerDead = false;
    this.deathOverlay.classList.add('hidden');
    this.playerActor.revive();
    this.mapIndex = (index + this.mapNames.length) % this.mapNames.length;
    const name = this.mapNames[this.mapIndex];

    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
    }
    if (this.things) this.scene.remove(this.things.group);
    this.specials?.dispose();
    // A fog puff or impact explosion mid-animation when the map changes (e.g.
    // a teleporter onto an exit line) would otherwise leave its plane glued
    // into the new level's scene forever, since nothing else ever removes it.
    for (const f of this.teleportFogs) this.scene.remove(f.actor.mesh);
    this.teleportFogs = [];
    for (const e of this.impacts) this.scene.remove(e.actor.mesh);
    this.impacts = [];
    // Same reasoning for a tracer/projectile still in flight when the map changes.
    for (const t of this.tracers) {
      this.scene.remove(t.line);
      t.dispose();
    }
    this.tracers = [];
    for (const p of this.projectiles) this.scene.remove(p.actor.mesh);
    this.projectiles = [];

    const t0 = performance.now();
    const map = loadMap(this.wad, name);
    this.map = map;
    this.world = new World(map);
    // Sectors a door/lift/floor mover will drive are pulled out of the static
    // batches up front — SpecialsController owns their geometry instead (see
    // render/mapmesh.ts's MapMeshOptions doc for why).
    const movableSectors = computeMovableSectors(map);
    this.built = buildMapMesh(map, this.materials, { renderCeilings: this.renderCeilings, movableSectors });
    this.scene.add(this.built.group);
    this.wallFader = new WallFader(this.built.occluders, this.built.wallMeshes);
    this.flatFader = new FlatFader(this.built.flatSurfaces, this.built.flatMeshes);
    this.player = new Player(this.world);
    // Applied before fog of war is seeded, so an explicit start position reveals
    // exactly what is visible from there and nothing from the map's real spawn.
    if (this.startPos) {
      this.player.moveTo(this.startPos.x, this.startPos.y);
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
      { renderCeilings: this.renderCeilings },
      () => {
        this.pendingExit = true;
      },
      (x, y, angle) => {
        // Matches vanilla P_Teleport: a fog puff where the player stood, and
        // another just ahead of the landing spot along the direction it
        // faces — captured before/after teleportTo moves the player.
        this.spawnTeleportFog(this.player.x, this.player.y, this.player.z);
        this.player.teleportTo(x, y, angle);
        this.spawnTeleportFog(
          this.player.x + Math.cos(angle) * TFOG_SPAWN_OFFSET,
          this.player.y + Math.sin(angle) * TFOG_SPAWN_OFFSET,
          this.player.z,
        );
        // Snap the camera to face the same way the player now does, same as
        // the initial spawn — a teleport should reorient the view instantly,
        // not leave it aimed at wherever the old spot happened to be.
        this.view.camera.yawDeg = (angle * 180) / Math.PI - 90;
      },
      (sectorIndex) => this.applyCrushDamage(sectorIndex),
      this.player.x,
      this.player.y,
    );

    this.things = buildThingSprites(map, this.world, this.spriteBank, this.spriteMaterials, this.skill);
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

  /**
   * `renderCeilings` only changes which flats get built — it doesn't touch the
   * player, world, fog of war or specials state — so rebuilding via
   * `loadMapByIndex` (which resets all of that, including mover positions and
   * picked-up items) would make the toggle look like the level restarting.
   * Rebuild just the static map mesh and hand the movable-sector code a fresh
   * `BuiltMap` to draw its own ceilings from instead.
   */
  private toggleCeilings(): void {
    this.renderCeilings = !this.renderCeilings;
    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
    }
    const movableSectors = computeMovableSectors(this.map);
    this.built = buildMapMesh(this.map, this.materials, { renderCeilings: this.renderCeilings, movableSectors });
    this.scene.add(this.built.group);
    this.wallFader = new WallFader(this.built.occluders, this.built.wallMeshes);
    this.flatFader = new FlatFader(this.built.flatSurfaces, this.built.flatMeshes);
    this.specials?.setBuilt(this.built, { renderCeilings: this.renderCeilings });
  }

  resume(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.view.input.reset();
    requestAnimationFrame(this.frame);
  }

  pause(): void {
    this.running = false;
  }

  dispose(): void {
    this.pause();
    this.specials?.dispose();
    this.built?.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    // Tracers own per-instance geometry/material (unlike sprite actors, whose
    // geometry/material come from the shared, disposed-below SpriteMaterialCache).
    for (const t of this.tracers) t.dispose();
    this.materials.dispose();
    this.spriteMaterials.dispose();
  }

  /** Spawns a one-shot sprite animation (teleport fog, impact explosion) and returns it, or null if the sprite has no art. */
  private spawnEffect(sprite: string, frames: string[], frameSeconds: number, x: number, y: number, z: number): OneShotEffect | null {
    const actor = new SpriteActor(this.spriteBank, this.spriteMaterials, sprite, frames, frameSeconds);
    const light = this.world.sectorAt(x, y)?.light ?? 128;
    if (!actor.setPose(x, y, z, 0, light)) return null;
    this.scene.add(actor.mesh);
    return { actor, x, y, z, light, elapsed: 0, lifetime: frames.length * frameSeconds };
  }

  /** Advances a one-shot effect list in place and drops the ones that finished, matching every other list's remaining-array pattern here. */
  private updateEffects(list: OneShotEffect[], dt: number, viewerAngleDeg: number): OneShotEffect[] {
    if (list.length === 0) return list;
    const remaining: OneShotEffect[] = [];
    for (const e of list) {
      e.elapsed += dt;
      if (e.elapsed >= e.lifetime) {
        this.scene.remove(e.actor.mesh);
        continue;
      }
      e.actor.setPose(e.x, e.y, e.z, 0, e.light, dt, true, viewerAngleDeg);
      remaining.push(e);
    }
    return remaining;
  }

  private spawnTeleportFog(x: number, y: number, z: number): void {
    const effect = this.spawnEffect('TFOG', TFOG_FRAMES, TFOG_FRAME_SECONDS, x, y, z);
    if (effect) this.teleportFogs.push(effect);
  }

  /**
   * Turns one fired Shot (game/weapons.ts) into a tracer line or a flying
   * projectile sprite. Always starts at the player's own fire height
   * (`startZ`) — never mid-air — and, when `target` is auto-aim's locked-on
   * monster, slopes toward that monster's height by the time it arrives
   * instead of flying flat past it. `shotPath` resolves where it actually
   * gets to (short of the target if a wall is in the way), which is what both
   * the tracer/projectile's endpoint and — once it lands — its impact
   * explosion use.
   *
   * Whether this shot actually *lands* on `targetId` is resolved here too:
   * `shotPath` returns wherever it got blocked, so comparing that distance
   * against the target's own distance is how "did it get there" is known. A
   * hitscan pellet's damage applies immediately (it's an instant line, same
   * as its tracer); a projectile's carries through to `updateProjectiles`,
   * applied once the sprite visually arrives rather than the instant it's
   * fired — monster positions never change mid-flight, so resolving hit/miss
   * now and only *applying* it later is safe.
   */
  private spawnShot(
    shot: Shot,
    startZ: number,
    target: { x: number; y: number; z: number } | null,
    targetId: number | null,
  ): void {
    const originX = this.player.x;
    const originY = this.player.y;
    const path = shotPath(this.world, originX, originY, startZ, shot.angleRad, target);

    let hitMonsterId: number | null = null;
    let endX = path.x;
    let endY = path.y;
    let endDist = path.dist;

    if (target !== null && targetId !== null) {
      // A locked shot only actually connects if nothing stopped it short of
      // the target — shotPath returns wherever it got blocked, so comparing
      // that distance against the target's own is how "did this land" is known.
      const wantDist = Math.hypot(target.x - originX, target.y - originY);
      if (path.dist >= wantDist - 1) hitMonsterId = targetId;
    } else {
      // No locked target: still test the straight path itself against every
      // monster's body (`ThingLayer.raycastMonster`), the way any real
      // hitscan/projectile trace would — a monster standing between the
      // player and a wall they're shooting at shouldn't be invisible to the
      // shot just because it wasn't clicked. Only ever shortens the shot
      // (never past `path.dist`, the wall/step it would have hit anyway).
      const monsterHit = this.things?.raycastMonster(originX, originY, startZ, shot.angleRad, path.dist) ?? null;
      if (monsterHit) {
        hitMonsterId = monsterHit.id;
        endX = monsterHit.x;
        endY = monsterHit.y;
        endDist = monsterHit.dist;
      }
    }

    if (shot.kind === 'hitscan') {
      if (hitMonsterId !== null) this.things?.damage(hitMonsterId, shot.damage);
      const tracer = new Tracer(originX, originY, startZ, endX, endY, path.z, TRACER_COLOR);
      this.scene.add(tracer.line);
      this.tracers.push(tracer);
      return;
    }

    const actor = new SpriteActor(this.spriteBank, this.spriteMaterials, shot.sprite, PROJECTILE_FRAMES[shot.sprite]);
    const light = this.world.sectorAt(originX, originY)?.light ?? 128;
    if (!actor.setPose(originX, originY, startZ, (shot.angleRad * 180) / Math.PI, light)) return;
    this.scene.add(actor.mesh);
    this.projectiles.push({
      actor,
      originX,
      originY,
      startZ,
      endZ: path.z,
      angleRad: shot.angleRad,
      speed: shot.speed,
      maxDist: endDist,
      traveled: 0,
      light,
      sprite: shot.sprite,
      damage: shot.damage,
      splash: shot.splash,
      hitMonsterId,
    });
  }

  /** Advances every active hitscan tracer and drops the ones whose flash finished. */
  private updateTracers(dt: number): void {
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
   * Advances every in-flight projectile along its fixed straight line —
   * sloped from `startZ` to `endZ` (see spawnShot's doc) rather than flat,
   * so an auto-aimed shot visibly rises or dips toward its target instead of
   * the sprite floating at a constant height mismatched with the line it's
   * travelling along — and, once one reaches `maxDist` (the same
   * wall-stopping distance a hitscan tracer would have ended at,
   * shotPath, computed once at launch in spawnShot rather than
   * re-raycast every frame), removes it and plays its impact explosion
   * (IMPACT_EFFECTS) at `endZ` in its place. "Reached its target" doesn't by
   * itself mean it hit anything — `p.hitMonsterId` is only set when this shot
   * was locked onto a monster it actually got to (spawnShot resolves that up
   * front) — but the impact point always applies splash (`p.splash`)
   * regardless, the same as a rocket exploding against a bare wall still
   * hurts anyone standing nearby in vanilla.
   */
  private updateProjectiles(dt: number, viewerAngleDeg: number): void {
    if (this.projectiles.length === 0) return;
    const remaining: Projectile[] = [];
    for (const p of this.projectiles) {
      p.traveled += p.speed * dt;
      if (p.traveled >= p.maxDist) {
        this.scene.remove(p.actor.mesh);
        const x = p.originX + Math.cos(p.angleRad) * p.maxDist;
        const y = p.originY + Math.sin(p.angleRad) * p.maxDist;
        if (p.hitMonsterId !== null) this.things?.damage(p.hitMonsterId, p.damage);
        if (p.splash) {
          this.applyRadiusDamage(x, y, p.endZ, p.splash.radius, p.splash.damage, p.splash.hitsPlayer, p.splash.tracers);
        }
        const impact = IMPACT_EFFECTS[p.sprite];
        if (impact) {
          const effect = this.spawnEffect(impact.sprite, impact.frames, IMPACT_FRAME_SECONDS, x, y, p.endZ);
          if (effect) this.impacts.push(effect);
        }
        continue;
      }
      const x = p.originX + Math.cos(p.angleRad) * p.traveled;
      const y = p.originY + Math.sin(p.angleRad) * p.traveled;
      const frac = p.maxDist > 0 ? p.traveled / p.maxDist : 1;
      const z = p.startZ + (p.endZ - p.startZ) * frac;
      p.actor.setPose(x, y, z, (p.angleRad * 180) / Math.PI, p.light, dt, true, viewerAngleDeg);
      remaining.push(p);
    }
    this.projectiles = remaining;
  }

  /**
   * An explosion's blast: every living monster within `radius` of the impact
   * point that has an unobstructed line to it (`hasLineOfSight`) takes
   * damage falling off linearly to 0 at the radius edge, matching vanilla's
   * own `P_RadiusAttack` falloff. `hitsPlayer` gates whether the player is
   * even a candidate — true for the rocket, matching vanilla's own
   * self-splash ("rocket jump") behavior, but false for the BFG, whose real
   * vanilla damage never reaches the shooter (see `WeaponDef.splash`'s doc);
   * without this a BFG shot that merely killed a monster *near* the player
   * also splashed the player itself, which isn't how the original ever
   * behaves. Self-splash is otherwise the only path through which the player
   * can currently take damage at all, since there's no monster AI to attack
   * back. 2D distance only, no height check — matching vanilla's own
   * `P_RadiusAttack`, which ignores z entirely and relies on line-of-sight
   * alone to decide whether a floor above/below the blast is protected;
   * `z` is only carried along for `tracers`' visuals, never the falloff math.
   * `tracers`, when set, draws a `BFG_TRACER_COLOR` line from the impact to
   * every monster the blast actually damaged — see `WeaponDef.splash`'s doc
   * on why only the BFG sets it.
   */
  private applyRadiusDamage(
    x: number,
    y: number,
    z: number,
    radius: number,
    maxDamage: number,
    hitsPlayer: boolean,
    tracers: boolean,
  ): void {
    for (const m of this.things?.monstersNear(x, y, radius) ?? []) {
      const dist = Math.hypot(m.x - x, m.y - y);
      if (dist >= radius || !hasLineOfSight(this.world, x, y, m.x, m.y)) continue;
      this.things?.damage(m.id, maxDamage * (1 - dist / radius));
      if (tracers) {
        const tracer = new Tracer(x, y, z, m.x, m.y, m.z, BFG_TRACER_COLOR);
        this.scene.add(tracer.line);
        this.tracers.push(tracer);
      }
    }

    if (!hitsPlayer) return;
    const pdist = Math.hypot(this.player.x - x, this.player.y - y);
    if (pdist < radius && hasLineOfSight(this.world, x, y, this.player.x, this.player.y)) {
      this.damagePlayer(maxDamage * (1 - pdist / radius));
    }
  }

  /** Applies armor-mitigated damage (`applyDamage`) to the player, transitioning to the death animation once health hits 0. A no-op once already dead — no double death. */
  private damagePlayer(amount: number): void {
    if (this.playerDead || amount <= 0) return;
    applyDamage(this.inventory, amount);
    if (this.inventory.health > 0) return;
    this.playerDead = true;
    this.playerActor.die(PLAYER_DEATH_FRAMES, PLAYER_DEATH_FRAME_SECONDS);
    this.deathOverlay.classList.remove('hidden');
  }

  /**
   * `SpecialsController`'s `onCrush` callback: it owns the moving geometry
   * but has no idea who's standing in it, so it hands back just the sector
   * index and leaves finding out to us. 2D sector membership only — matching
   * `applyRadiusDamage`'s own choice to ignore z, and this engine doesn't
   * model a mover actually blocking on contact anyway (see `SpecialsController`'s
   * class doc), so there's no finer "did it actually reach you" test to make.
   */
  private applyCrushDamage(sectorIndex: number): void {
    if (this.world.sectorIndexAt(this.player.x, this.player.y) === sectorIndex) this.damagePlayer(CRUSH_DAMAGE);
    const sector = this.map.sectors[sectorIndex];
    for (const m of this.things?.monstersInSector(sector) ?? []) this.things?.damage(m.id, CRUSH_DAMAGE);
  }

  /** `R`, while dead: a fresh inventory and a reload of the current map — `loadMapByIndex` resets the player/world/specials/fog and, via the doc on its own top, `playerDead`/the death overlay/`playerActor` too. */
  private restart(): void {
    this.inventory = createInventory();
    this.loadMapByIndex(this.mapIndex);
  }

  private frame = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const { input, camera } = this.view;
    this.handleHotkeys();
    // Guarded on a nonzero delta: a plain `yawDeg` assignment (even a no-op
    // "-= 0" one) goes through the setter, which snaps `targetYawDeg` back to
    // the current value — running it unconditionally every frame would cancel
    // a Q/E stepYaw animation after just one frame of smoothing.
    const dragYaw = input.consumeDragYaw();
    if (dragYaw !== 0) camera.yawDeg -= dragYaw * YAW_SENSITIVITY;
    // Signs match right-drag: E rotates the same way as dragging right, Q as dragging left.
    // stepYaw (not a plain assignment) is what makes this animate smoothly instead of
    // snapping. Holding the key auto-repeats the same step every KEY_YAW_REPEAT_INTERVAL,
    // roughly how long one step's smoothing takes to settle, so a hold reads as continuous
    // rotation made of chained 45° steps rather than a single tap.
    this.qHoldTime = input.held('KeyQ') ? this.qHoldTime + dt : 0;
    this.eHoldTime = input.held('KeyE') ? this.eHoldTime + dt : 0;
    if (input.pressed('KeyQ') || this.qHoldTime >= KEY_YAW_REPEAT_INTERVAL) {
      camera.stepYaw(KEY_YAW_STEP);
      this.qHoldTime = 0;
    }
    if (input.pressed('KeyE') || this.eHoldTime >= KEY_YAW_REPEAT_INTERVAL) {
      camera.stepYaw(-KEY_YAW_STEP);
      this.eHoldTime = 0;
    }

    // Runs before player.update so a lift/door the player is standing on has
    // already moved this frame by the time groundFloor is sampled below.
    this.specials?.update(dt, this.player.x, this.player.y, this.player.angle, input, this.inventory.keys);
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
    let aim: { x: number; y: number } | null = null;
    if (!this.playerDead) {
      // The cursor hovering over a monster locks aim onto its actual
      // position — and height — instead of wherever the mouse's flat
      // floor-plane projection lands underneath the cursor. This has to
      // apply on hover, the same as regular mouse-aim always has
      // (player.angle is set from `aim` unconditionally below, click or
      // no), not just while the trigger is held: gating the lock to
      // mouseDown made both the player's facing and the camera's aim-lead
      // below jump the instant a click landed — which read as the camera
      // lurching backward right as you fired.
      const monster = this.things?.pickMonster(camera.raycasterFor(input.pointer.x, input.pointer.y)) ?? null;
      aim = monster ?? camera.pointerToPlane(input.pointer.x, input.pointer.y, this.player.z + AIM_HEIGHT_OFFSET);
      this.player.update(dt, input, aim, camera.viewerAngleDeg + 180);

      // A shot always *starts* at the player's own fire height — never the
      // target's, or a tracer/projectile would visibly begin mid-air instead
      // of at the player. Handing shotPath the locked-on monster as its
      // target is what makes the shot angle toward *its* height and stop
      // there; see world.ts's shotPath/blocksShot for why a locked shot is
      // allowed to clear the floor steps a free one is stopped by.
      const fireStartZ = this.player.z + AIM_HEIGHT_OFFSET;
      const fireTarget = monster ? { x: monster.x, y: monster.y, z: monster.z + AIM_HEIGHT_OFFSET } : null;

      // After player.update so player.angle already reflects this frame's aim.
      this.weaponSystem.handleSwitching(input, this.inventory, input.consumeWheel());
      const shots = this.weaponSystem.update(dt, input.mouseDown, this.inventory, this.player.angle);
      // Vanilla's P_FireWeapon calls P_NoiseAlert every time a shot is actually
      // fired (ammo/cooldown allowed it) — this is what lets a monster with no
      // line of sight to the player still wake up on gunfire (World.noiseAlert,
      // game/world.ts). Melee weapons (fist/chainsaw) fire vanilla's own noise
      // alert too, but don't yet deal damage at all (see weapons.ts), so this
      // only covers hitscan/projectile shots for now.
      if (shots.length > 0) this.world.noiseAlert(this.player.x, this.player.y);
      for (const shot of shots) {
        this.spawnShot(shot, fireStartZ, fireTarget, monster ? monster.id : null);
      }

      this.things?.tryPickup(this.player.x, this.player.y, this.player.z, PICKUP_RANGE, (type, dropped) =>
        applyPickup(this.inventory, type, dropped),
      );
    } else if (input.pressed('KeyR')) {
      this.restart();
      input.endFrame();
      requestAnimationFrame(this.frame);
      return;
    }
    camera.update(dt, this.player.x, this.player.y, this.player.eyeZ, aim);
    this.hud.update(this.inventory);

    this.fogOfWar.update(dt, this.player.x, this.player.y);
    const fog = this.fogOfWar;
    const fogAlphaOf = (subsector: number) => fog.alphaOf(subsector);
    // Monsters freeze in place while the player is dead (nothing to chase) —
    // passing null skips their AI entirely without touching pose/animation/fog
    // visibility, which keep updating normally. Every attack a still-living
    // monster fired this frame comes back for us to actually apply/render,
    // the same "system returns data, caller realizes it" split as
    // WeaponSystem.update's Shot[].
    const monsterAttacks = this.things?.update(
      dt,
      camera.viewerAngleDeg,
      this.playerDead ? null : { x: this.player.x, y: this.player.y, z: this.player.z },
      fogAlphaOf,
    ) ?? [];
    for (const atk of monsterAttacks) {
      this.damagePlayer(atk.damage);
      if (atk.kind === 'ranged') {
        const tracer = new Tracer(atk.x, atk.y, atk.z, this.player.x, this.player.y, this.player.z + AIM_HEIGHT_OFFSET, MONSTER_TRACER_COLOR);
        this.scene.add(tracer.line);
        this.tracers.push(tracer);
      }
    }
    this.teleportFogs = this.updateEffects(this.teleportFogs, dt, camera.viewerAngleDeg);
    this.updateTracers(dt);
    this.updateProjectiles(dt, camera.viewerAngleDeg);
    this.impacts = this.updateEffects(this.impacts, dt, camera.viewerAngleDeg);

    const camPos = camera.camera.position;
    const camPlayerArgs = [
      dt,
      camPos.x,
      -camPos.z,
      camPos.y,
      this.player.x,
      this.player.y,
      this.player.z + PLAYER_HEIGHT / 2,
    ] as const;
    this.wallFader.update(...camPlayerArgs);
    this.flatFader.update(...camPlayerArgs);
    // Walls resolve their own subsector inside FogOfWar (see wallAlpha); flats
    // and things already know theirs, so they go through alphaOf directly.
    this.wallFader.commit((i) => fog.wallAlpha(i));
    this.flatFader.commit(fogAlphaOf);
    // Door/lift geometry lives in its own meshes (game/specials.ts), so it
    // carries its own faders rather than the two above.
    this.specials?.updateFading(...camPlayerArgs);

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

    this.view.renderer.render(this.scene, camera.camera);

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    this.updateHud();

    input.endFrame();
    requestAnimationFrame(this.frame);
  };

  private handleHotkeys(): void {
    const { input, camera } = this.view;
    if (input.pressed('KeyC')) this.toggleCeilings();
    // Level switching, zoom and tilt are dev/debug conveniences, gated the
    // same as the debug HUD below (see DEVMODE).
    if (!DEVMODE) return;
    if (input.pressed('KeyN')) this.loadMapByIndex(this.mapIndex + 1);
    if (input.pressed('KeyP')) this.loadMapByIndex(this.mapIndex - 1);
    if (input.held('Equal', 'NumpadAdd')) camera.distance = Math.max(200, camera.distance - 8);
    if (input.held('Minus', 'NumpadSubtract')) camera.distance = Math.min(2400, camera.distance + 8);
    if (input.held('BracketLeft')) camera.tiltDeg = Math.max(0, camera.tiltDeg - 0.5);
    if (input.held('BracketRight')) camera.tiltDeg = Math.min(70, camera.tiltDeg + 0.5);
  }

  private updateHud(): void {
    if (!DEVMODE) {
      hudEl.textContent = `${this.fps} fps`;
      return;
    }
    const { camera } = this.view;
    const sector = this.world.sectorIndexAt(this.player.x, this.player.y);
    hudEl.textContent = [
      `${this.currentMap}   ${this.title}`,
      `${this.fps} fps   ${this.built?.triangles ?? 0} tris`,
      `pos ${this.player.x.toFixed(0)}, ${this.player.y.toFixed(0)}   z ${this.player.z.toFixed(0)}   sector ${sector}`,
      `cam ${camera.distance.toFixed(0)} u / ${camera.tiltDeg.toFixed(0)}° tilt / ${camera.yawDeg.toFixed(0)}° yaw   ceilings ${this.renderCeilings ? 'on' : 'off'}`,
      '',
      'WASD move   Shift run   mouse aim/fire   1-7 / wheel weapon   right-drag / Q-E rotate camera   Space use',
      'N/P map   C ceilings   +/- zoom   [ ] tilt   R restart (when dead)   Esc menu',
    ].join('\n');
  }
}
