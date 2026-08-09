import * as THREE from 'three';
import type { Wad } from './wad/wad.ts';
import { wadId } from './wad/checksum.ts';
import { bestTimeKey, recordBestTime, type BestTimeResult } from './game/besttimes.ts';
import { GraphicsBank } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap, type DoomMap } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { AnimatedTextures } from './render/textureanim.ts';
import { buildMapMesh, type BuiltMap } from './render/mapmesh.ts';
import { SpriteActor, SpriteMaterialCache } from './render/sprites.ts';
import type { Viewport } from './render/viewport.ts';
import type { TopDownCamera } from './render/camera.ts';
import type { Input } from './game/input.ts';
import { buildThingSprites, type MonsterRef, type ThingLayer } from './game/things.ts';
import {
  PLAYER_ACTION_FRAME_SECONDS,
  PLAYER_ATTACK_FRAMES,
  PLAYER_DEATH_FRAME_SECONDS,
  PLAYER_DEATH_FRAMES,
  PLAYER_PAIN_FRAMES,
} from './game/thingdefs.ts';
import { thrustSpeed } from './game/monsters/defs.ts';
import { MonsterAttacks } from './game/monsters/attacks.ts';
import { collectFadeTargets, FlatFader, TextureScroller, WallFader } from './render/occlusion.ts';
import { World } from './game/world.ts';
import { AIM_HEIGHT_OFFSET, HARD_LANDING_SPEED, Player, PLAYER_MASS, PLAYER_RADIUS } from './game/player.ts';
import { applyBarrelExplosion, type CombatContext } from './game/combat.ts';
import { SpriteFxLayer } from './game/spritefx.ts';
import { ProjectileLayer } from './game/projectiles.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { SpecialsController } from './game/specials.ts';
import { computeMovableSectors } from './game/specials/mapscan.ts';
import { IconOfSin } from './game/iconofsin.ts';
import { applyCrushDamage, blocksCeilingLower, blocksFloorRise } from './game/moverblocking.ts';
import { SectorEffects } from './game/sectoreffects.ts';
import { Hud, type LevelStats } from './ui/hud.ts';
import { Crosshair } from './ui/crosshair.ts';
import { Intermission } from './ui/intermission.ts';
import { LevelCard } from './ui/levelcard.ts';
import { LevelNames } from './wad/levelnames.ts';
import { CenterMessage, lockedKeyMessage } from './ui/message.ts';
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
import { PLAYER_ORIGIN } from './audio/sfx.ts';
import { SoundBank } from './wad/sound.ts';
import type { Placement, Pos2 } from './types.ts';
import { VIEW_DISTANCE } from './constants.ts';

/** Combined radius (map units) within which an item is close enough to pick up. */
const PICKUP_RANGE = PLAYER_RADIUS + ITEM_PICKUP_RADIUS;

/**
 * Where the distance fog starts hazing, as a fraction of `VIEW_DISTANCE` (fully opaque at 1.0), so
 * moving the one dial keeps the fade band in proportion. Tuned by feel: wide enough that distant
 * geometry dissolves instead of meeting a wall of black, narrow enough that the room the player is
 * actually fighting in stays at full brightness.
 */
const FOG_START_FRACTION = 0.54;

/**
 * Shown center-screen (`ui/message.ts`) with `radio` — vanilla's `DSRADIO`, which it uses for
 * DOOM 2's inter-level radio chatter, not for secrets, so both the message and the sound are this
 * engine's own. Vanilla announces a secret nowhere at all: the status bar's `S` count just ticks
 * up. docs/items.md § Center messages.
 */
const SECRET_MESSAGE = 'You found a secret area';

/**
 * How long the intermission popup ignores the continue key. `Space` both uses the exit switch and
 * dismisses the popup, so without this a mashed switch skips past it before it can be read.
 * **Tuned by feel** — long enough to swallow a double tap, short enough not to feel stuck.
 */
const INTERMISSION_INPUT_DELAY = 0.6;

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
  /**
   * The Icon of Sin's cube spitter, rebuilt per level like `specials` — inert on every map with no
   * `MT_BOSSSPIT` thing, which is all of them but MAP30. See game/iconofsin.ts.
   */
  private icon?: IconOfSin;
  /** Teleport fog, impact explosions, the smoke trail, the vile's flame and hitscan tracers — see game/spritefx.ts. */
  private effects: SpriteFxLayer;
  /** Everything in flight, player's and monsters' alike — see game/projectiles.ts. */
  private projectiles: ProjectileLayer;
  /** Turns the attacks `ThingLayer.update` reports into damage, tracers and effects — see game/monsters/attacks.ts. */
  private monsterAttacks: MonsterAttacks;
  /** The live-level view `projectiles`, `monsterAttacks` and the splash helpers read this class through — see game/combat.ts. */
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
  /**
   * True while the end-of-level popup is up: the level is finished and frozen, and `frame` advances
   * nothing until the player presses the continue key, which is what loads the next map. Not
   * `pause()`, which is the menu's — the popup has to keep reading input.
   */
  private intermissionActive = false;
  /** Seconds the popup has been up, for `INTERMISSION_INPUT_DELAY`. The only thing that still advances while it is. */
  private intermissionTime = 0;
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
  /** Paused, not stopped: the level is frozen but still being drawn — see `stillFrame`. */
  private paused = false;
  private lastStill = 0;

  private view: Viewport;
  private audio: AudioEngine;
  private wad: Wad;
  private skill: Skill;
  private hud: Hud;
  private crosshair: Crosshair;
  /** Center-screen text — currently only the secret-found line (see `SECRET_MESSAGE`). */
  private message: CenterMessage;
  /** The "Entering / <level name>" card every map load raises — see ui/levelcard.ts. */
  private levelCard: LevelCard;
  /** The end-of-level popup — see ui/intermission.ts and `intermissionActive`. */
  private intermission: Intermission;
  /** Names levels for the card: MAPINFO, then the vanilla title table — see wad/levelnames.ts. */
  private levelNames: LevelNames;
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
  /**
   * Whether this session's completions may set best times. A `?pos=` start can drop the player
   * anywhere — next to the exit included — so those runs are excluded (docs/items.md § Best times).
   * Captured up front because `startPos` is nulled out once the first map has consumed it.
   */
  private recordsEligible: boolean;

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
    this.recordsEligible = startPos === null;
    // Primed here, where a one-off scan of each file's bytes disappears into a load that is about
    // to build every mesh in the level, so the exit frame only ever hits the memo.
    for (const file of wad.files) wadId(file);

    this.scene.background = new THREE.Color(0x05050a);
    this.scene.fog = new THREE.Fog(0x05050a, VIEW_DISTANCE * FOG_START_FRACTION, VIEW_DISTANCE);

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
    this.message = new CenterMessage(gfx);
    this.levelCard = new LevelCard(gfx);
    this.intermission = new Intermission(gfx);
    // Session-scoped like the banks above: which titles apply depends on the loaded file set
    // (its MAPINFO lumps and which IWAD it is), not on the current map.
    this.levelNames = new LevelNames(wad);
    this.crosshair = new Crosshair(view.renderer.domElement);
    this.mapNames = wad.mapNames();
    if (this.mapNames.length === 0) throw new Error('no maps in the selected WADs');

    // PLAY's own walk cycle: DOOM has no separate idle art, it just holds
    // frame A (this list's first entry) until the player is actually moving.
    this.playerActor = new SpriteActor(this.spriteBank, this.spriteMaterials, 'PLAY', ['A', 'B', 'C', 'D']);
    this.scene.add(this.playerActor.mesh);
    // The vile-flame resolver is `monsterAttacks`', not the batch's — where the
    // flame belongs depends on live monster/player state. Reached through a
    // closure because `monsterAttacks` needs `effects` to exist first, and is
    // only ever called from a frame, long after both are built.
    this.effects = new SpriteFxLayer(this.scene, this.spriteBank, this.spriteMaterials, audio, (vileId, targetId) =>
      this.monsterAttacks.vileFlameFor(vileId, targetId),
    );
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
    this.monsterAttacks = new MonsterAttacks(this.combat, this.effects, this.projectiles, audio, () =>
      hasPower(this.inventory, 'invisibility'),
    );

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
    this.message.clear();
    this.levelCard.clear();
    this.intermission.clear();
    this.intermissionActive = false;
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
        // The origin puff's position has to be captured before teleportTo
        // overwrites it; the landing `z` only exists after. See
        // SpriteFxLayer.spawnTeleportPair for the pair itself.
        const from = { x: this.player.x, y: this.player.y, z: this.player.z };
        this.player.teleportTo(dest);
        this.effects.spawnTeleportPair(from, dest, this.player.z);
        // Snap the camera to face the same way the player now does, same as
        // the initial spawn — a teleport should reorient the view instantly,
        // not leave it aimed at wherever the old spot happened to be.
        this.view.camera.yawDeg = (dest.angle * 180) / Math.PI - 90;
      },
      (sectorIndex) =>
        applyCrushDamage(this.world, this.map, this.things, this.player, sectorIndex, (amount) =>
          this.damagePlayer(amount),
        ),
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
      // "make sure there is a player alive for victory" check. Fanned out to both owners: the
      // tag-driven actions (including Commander Keen's door) belong to `specials`, the Icon of
      // Sin's own `A_BrainDie` to `icon`; each ignores the doomednums it doesn't handle.
      (type) => {
        if (this.playerDead) return;
        this.specials?.notifyBossDeath(type);
        this.icon?.notifyBossDeath(type);
      },
    );
    this.scene.add(this.things.group);

    // Built after `things`, which its cube spawns and telefrags go through.
    this.icon = new IconOfSin(
      map,
      this.combat,
      this.effects,
      this.spriteBank,
      this.spriteMaterials,
      this.skill,
      () => {
        this.pendingExit = true;
      },
      this.audio,
    );

    // Raised last: this method clears every overlay at its top, so a card shown any earlier than
    // here would be wiped by its own load.
    this.levelCard.show(this.levelNames.nameFor(name), this.levelNames.graphicFor(name));

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
    this.paused = false;
    this.running = true;
    this.lastTime = performance.now();
    this.view.input.reset();
    requestAnimationFrame(this.frame);
  }

  /** Stops both loops. `dispose` uses this rather than `pause` — see `stillFrame`. */
  private stop(): void {
    this.running = false;
    this.paused = false;
    this.audio.suspend();
  }

  pause(): void {
    if (this.paused) return; // a second call would leave two `stillFrame` loops running
    this.stop();
    this.paused = true;
    requestAnimationFrame(this.stillFrame);
  }

  /**
   * Keeps redrawing the frozen level while paused, so the menu can sit over it
   * (see docs/render.md § Pausing). Nothing is advanced here — no dt, no input,
   * no profiling — only `render`, and only every ~50 ms, since a static scene
   * has no reason to cost 60 fps. `dispose` must go through `stop`, never
   * `pause`, or this would keep drawing a scene whose geometry and materials
   * are already released.
   */
  private stillFrame = (now: number) => {
    if (!this.paused) return;
    if (now - this.lastStill >= 50) {
      this.lastStill = now;
      this.view.renderer.render(this.scene, this.view.camera.camera);
    }
    requestAnimationFrame(this.stillFrame);
  };

  dispose(): void {
    this.stop();
    // The engine is session-level and the next Game sets its own bank; this
    // only makes sure nothing from this level is left holding a channel.
    this.audio.stopAll();
    this.screen.reset();
    // Like `screen`, these elements outlive the Game that drove them — without
    // this the menu (and the next level started from it) inherits the line.
    this.message.clear();
    this.levelCard.clear();
    this.intermission.clear();
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
   * Runs the walk triggers a monster crossed this frame
   * (`SpecialsController.crossMonster` — teleports plus the few door/lift
   * types vanilla lets a monster activate). A teleport gets the same `TFOG`
   * puff at both ends the player's own does; vanilla spawns it for any thing
   * that teleports, not just the player.
   */
  private monsterCrossedLines(prev: Pos2, pos: Pos2): Placement | null {
    const dest = this.specials?.crossMonster(prev, pos, this.inventory.keys);
    if (!dest) return null;
    const from = { x: pos.x, y: pos.y, z: this.world.groundFloor(pos.x, pos.y, 0) };
    this.effects.spawnTeleportPair(from, dest, this.world.groundFloor(dest.x, dest.y, 0));
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
      this.player.applyDamageThrust(thrustSpeed(amount, PLAYER_MASS), fromX, fromY);
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
    // The lower clamp is load-bearing, not defensive: `now` can predate the
    // `performance.now()` `resume` stamped into `lastTime`, so without it the
    // first frame of a level can step every system *backwards*. See
    // docs/render.md § The frame delta.
    const rawDt = (now - this.lastTime) / 1000;
    const dt = Math.max(0, Math.min(0.05, rawDt));
    this.lastTime = now;
    this.profiler.beginFrame();

    const { input, camera } = this.view;
    // The level is over and frozen behind the popup: nothing is advanced — not the clock, not the
    // specials, not a monster — only the still scene is redrawn under it. Space/Enter rather than
    // any key, since Escape belongs to the menu (main.ts) and would otherwise both pause and eat
    // the popup in the same press.
    if (this.intermissionActive) {
      this.intermissionTime += dt;
      if (this.intermissionTime >= INTERMISSION_INPUT_DELAY && (input.pressed('Space') || input.pressed('Enter'))) {
        this.loadMapByIndex(this.mapIndex + 1); // clears the popup and the flag, like every other per-level overlay
      } else {
        this.view.renderer.render(this.scene, camera.camera);
      }
      input.endFrame();
      requestAnimationFrame(this.frame);
      return;
    }
    handleHotkeys(input, camera, (delta) => this.loadMapByIndex(this.mapIndex + delta));
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
    // The `oof` a refused keyed line already played is raised inside `specials`; the message that
    // says *which* key it wants is this layer's, since that controller has no HUD. `undefined`
    // (no level loaded) and `null` (nothing refused) are the same non-event here.
    const locked = this.specials?.consumeLockedLine();
    if (locked) this.message.show(...lockedKeyMessage(locked.key, locked.kind));
    // Deferred from the exit trigger's callback — see `pendingExit`'s doc.
    // The old SpecialsController's update() has now fully returned, so it's
    // safe to dispose it and swap in the next map.
    if (this.pendingExit) {
      this.pendingExit = false;
      // The next map isn't loaded here any more: the popup goes up on the level as it stands, and
      // the continue key at the top of `frame` is what loads it.
      this.intermission.show(this.levelStats(), this.recordCompletion());
      this.intermissionActive = true;
      this.intermissionTime = 0;
      input.endFrame();
      requestAnimationFrame(this.frame);
      return;
    }

    // `R` is the only input a corpse still answers; everything else the player
    // drives is skipped below instead of branching here.
    if (this.playerDead && input.pressed('KeyR')) {
      this.restart();
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
    const aim = this.playerDead ? null : this.updateLivingPlayer(dt, input, camera);

    if (!this.playerDead) this.levelTime += dt;
    camera.update(dt, { x: this.player.x, y: this.player.y, z: this.player.eyeZ }, aim);
    this.updateOverlays(dt);

    this.profiler.time('Fog of War', () => this.fogOfWar.update(dt, this.player.x, this.player.y));
    this.updateThings(dt, camera.viewerAngleDeg);
    this.updateEffects(dt, camera.viewerAngleDeg);
    this.updateFading(dt, camera);
    this.posePlayer(dt, camera.viewerAngleDeg);

    this.profiler.time('Render', () => this.view.renderer.render(this.scene, camera.camera));
    this.profiler.endFrame();

    this.debugHud.update(rawDt, this.profiler, (fps) => this.debugLines(fps));

    input.endFrame();
    requestAnimationFrame(this.frame);
  };

  /**
   * Everything a *living* player drives in a frame: powers, aim, movement, firing, pickups and the
   * sector underfoot. Returns the point the camera leads toward — the locked-on monster if the
   * cursor is over one, otherwise where the cursor meets the aim plane.
   */
  private updateLivingPlayer(dt: number, input: Input, camera: TopDownCamera): Pos2 | null {
    // Ticked with the rest of the player's own update and not while dead,
    // matching vanilla: powers age in `P_PlayerThink`, which hands off to
    // `P_DeathThink` and returns before reaching them once health hits 0.
    tickPowers(this.inventory, dt);
    // The cursor hovering over a monster locks aim onto its actual position
    // and height. **On hover, not on click** — `aim` drives `player.angle`
    // and the camera's lead unconditionally, so gating the lock to
    // `mouseDown` makes both jump the instant a click lands. See
    // docs/combat.md § Auto-aim.
    const { monster, aim } = this.profiler.time('Player', () => {
      const m = this.things?.pickMonster(camera.raycasterFor(input.pointer.x, input.pointer.y)) ?? null;
      const at = m ?? camera.pointerToPlane(input.pointer.x, input.pointer.y, this.player.z + AIM_HEIGHT_OFFSET);
      // Monsters are solid: the player walks around them, not through them.
      this.player.update(dt, input, at, camera.viewerAngleDeg + 180, this.things?.solidBodies(this.player));
      return { monster: m, aim: at };
    });

    this.profiler.time('Weapons', () => this.fireWeapons(dt, input, monster));
    this.profiler.time('Player', () => this.collectPickupsAndSectorEffects(dt));

    // Hard landings and the chainsaw's two ambient sounds, both of which
    // belong to a living player only.
    if (this.player.landingSpeed > HARD_LANDING_SPEED) this.audio.play('oof', this.player, PLAYER_ORIGIN);
    this.weaponSystem.updateSounds(dt, input.mouseDown, this.inventory, this.audio, this.player);
    return aim;
  }

  /**
   * Weapon switching and this frame's trigger pull, turning each shot `WeaponSystem.update` returns
   * into a projectile or tracer. `monster` is whatever aim locked onto, which is what lets a shot
   * angle toward its height — see docs/combat.md § Auto-aim.
   */
  private fireWeapons(dt: number, input: Input, monster: MonsterRef | null): void {
    // A shot always *starts* at the player's own fire height — never the
    // target's, or a tracer/projectile would visibly begin mid-air instead
    // of at the player. Handing shotPath the locked-on monster as its
    // target is what makes the shot angle toward *its* height and stop
    // there; see world.ts's shotPath/blocksShot for why a locked shot is
    // allowed to clear the floor steps a free one is stopped by.
    const fireStartZ = this.player.z + AIM_HEIGHT_OFFSET;
    const fireTarget = monster ? { x: monster.x, y: monster.y, z: monster.z + AIM_HEIGHT_OFFSET } : null;

    // Called after player.update so player.angle already reflects this frame's aim.
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
  }

  /**
   * The two things the player picks up by standing somewhere: items in reach, and whatever the
   * sector underfoot does to them (damage floors, secrets, an exit) — see game/sectoreffects.ts.
   */
  private collectPickupsAndSectorEffects(dt: number): void {
    this.things?.tryPickup(this.player, PICKUP_RANGE, (type, dropped) => {
      const taken = applyPickup(this.inventory, type, dropped);
      // The computer area map's whole effect lives outside the inventory
      // struct — see COMPUTER_MAP_TYPE's doc.
      if (taken && type === COMPUTER_MAP_TYPE) this.fogOfWar.revealAll();
      // Unattenuated, as vanilla plays every pickup: you're standing on it.
      if (taken) this.audio.play(pickupSound(type));
      return taken;
    });
    const sectorEffect = this.sectorEffects.update(dt, this.world, this.player, this.inventory, (amount) =>
      this.damagePlayer(amount),
    );
    if (sectorEffect.secretFound) {
      this.message.show(SECRET_MESSAGE);
      // Unattenuated, like a pickup: it's an announcement to the player, not a sound in the world.
      this.audio.play('radio');
    }
    if (sectorEffect.exit) this.pendingExit = true;
  }

  /**
   * The current level's kill/item/secret counts and clock, for the HUD strip every frame and for
   * the intermission on the frame the level ends. Cheap integer reads, assembled fresh rather than
   * cached — see docs/items.md § Level stats.
   */
  private levelStats(): LevelStats {
    return {
      kills: this.things?.stats.kills ?? 0,
      totalKills: this.things?.stats.totalKills ?? 0,
      items: this.things?.stats.items ?? 0,
      totalItems: this.things?.stats.totalItems ?? 0,
      secrets: this.sectorEffects.secretsFound,
      totalSecrets: this.sectorEffects.totalSecrets,
      elapsedSeconds: this.levelTime,
    };
  }

  /**
   * Files the completion that just happened and reports how it compares to the level's best, or
   * null if this run was never eligible for one. The record is keyed to the WAD file that
   * *provides* the map rather than to the loaded set — see docs/items.md § Best times.
   */
  private recordCompletion(): BestTimeResult | null {
    if (!this.recordsEligible) return null;
    const map = this.currentMap;
    const source = this.wad.find(map)?.source;
    if (!source) return null;
    return recordBestTime(bestTimeKey(wadId(source), map, this.skill), this.levelTime, {
      wad: source.name,
      map,
      skill: this.skill,
    });
  }

  /** The 2D layers over the level: status bar, crosshair, center message, level card, and the screen tints. */
  private updateOverlays(dt: number): void {
    this.hud.update(this.inventory, this.levelStats());
    this.crosshair.update(this.inventory.health);
    this.message.update(dt);
    this.levelCard.update(dt);
    this.screen.update(dt, this.inventory);
  }

  /**
   * Ticks the thing layer and realizes what it hands back: the monster attacks fired this frame,
   * and any barrel whose `A_Explode` came due. The player goes in as `null` once dead, matching
   * `P_KillMobj` stripping the player's `MF_SHOOTABLE`/`MF_SOLID` — docs/combat.md § Player death
   * for what that does and doesn't freeze in the AI.
   */
  private updateThings(dt: number, viewerAngleDeg: number): void {
    // Every attack a monster fired this frame comes back for us to apply/render, the same "system
    // returns data, caller realizes it" split as `WeaponSystem.update`.
    const thingUpdate = this.profiler.time(
      'Monsters',
      () =>
        this.things?.update(
          dt,
          viewerAngleDeg,
          this.playerDead ? null : this.player,
          (subsector) => this.fogOfWar.alphaOf(subsector),
          (prev, pos) => this.monsterCrossedLines(prev, pos),
        ) ?? { attacks: [], barrelExplosions: [] },
    );
    this.profiler.time('Monsters', () => {
      this.monsterAttacks.resolve(thingUpdate.attacks);
      // A barrel's own A_Explode, become due this frame (game/things.ts's
      // update() ticks the delay; see applyBarrelExplosion's doc). No visual
      // spawned effect is needed here the way every other explosion needs one —
      // the barrel's own PosedThing is already drawing its BEXP death
      // animation at exactly this spot.
      for (const exp of thingUpdate.barrelExplosions) applyBarrelExplosion(this.combat, exp);
    });
  }

  /** Everything drawn through the sprite-fx batch: teleport fog, tracers, things in flight, the icon's cubes. */
  private updateEffects(dt: number, viewerAngleDeg: number): void {
    this.profiler.time('Effects', () => {
      // One begin/end pair around all four lists, the same per-frame rebuild
      // `game/things.ts` does — and it has to enclose `ProjectileLayer.update`,
      // which both draws through the batch and pushes this frame's new impact
      // explosions and smoke puffs on for `updateImpacts` to draw.
      this.effects.beginFrame(viewerAngleDeg);
      this.effects.updateTeleportFogs(dt);
      this.effects.updateTracers(dt);
      this.projectiles.update(dt);
      // Inside the pair for the same reason as projectiles: a spawn cube draws
      // through the batch, and the fire and explosions it spawns are impacts.
      this.icon?.update(dt);
      this.effects.updateImpacts(dt);
      this.effects.endFrame();
    });
  }

  /** Occlusion fading of walls and flats, plus the two texture animators — see render/occlusion.ts. */
  private updateFading(dt: number, camera: TopDownCamera): void {
    this.profiler.time('Fading', () => {
      const fog = this.fogOfWar;
      const camPos = camera.camera.position;
      const camArgs = [dt, camPos.x, -camPos.z, camPos.y] as const;
      const fadeTargets = collectFadeTargets(this.player, this.things?.awakeMonsters() ?? []);
      const openingOf = (line: number) => this.world.openingOf(line);
      this.wallFader.update(...camArgs, fadeTargets, openingOf);
      this.flatFader.update(...camArgs, fadeTargets);
      // Walls resolve their own subsector inside FogOfWar (see wallAlpha); flats
      // and things already know theirs, so they go through alphaOf directly.
      this.wallFader.commit((i) => fog.wallAlpha(i));
      this.flatFader.commit((i) => fog.alphaOf(i));
      // Independent of camera/player position — a scrolling wall animates
      // whether or not it's currently faded or in view.
      this.textureScroller.update(dt);
      // Same independence, and session-scoped rather than per-map (see its
      // construction in the constructor) — an animated liquid/fire texture keeps
      // cycling across a level transition exactly as it does within one.
      this.animatedTextures.update(dt);
      // Door/lift geometry lives in its own meshes (game/specials.ts), so it
      // carries its own faders rather than the two above.
      this.specials?.updateFading(...camArgs, fadeTargets);
    });
  }

  /** Places the player's own billboard: position, facing, sector light and which animation is due. */
  private posePlayer(dt: number, viewerAngleDeg: number): void {
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
      viewerAngleDeg,
    );
  }

  /** DEVMODE's status text. Only ever called while the panel is shown — see `DebugHud.update`. */
  private debugLines(fps: number): string[] {
    const { camera } = this.view;
    const sector = this.world.sectorIndexAt(this.player.x, this.player.y);
    return [
      `${this.currentMap}   ${this.title}`,
      `${fps} fps   ${this.built?.triangles ?? 0} tris   monsters awake ${this.things?.awakeMonsterCount() ?? 0}`,
      `pos ${this.player.x.toFixed(0)}, ${this.player.y.toFixed(0)}   z ${this.player.z.toFixed(0)}   sector ${sector}`,
      `cam ${camera.distance.toFixed(0)}u ${camera.tiltDeg.toFixed(0)}°tilt ${camera.yawDeg.toFixed(0)}°yaw`,
    ];
  }
}
