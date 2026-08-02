import * as THREE from 'three';
import { Wad } from './wad/wad.ts';
import { loadWadFiles, type WadSource } from './wad/library.ts';
import { GraphicsBank } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap, type DoomMap } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { buildMapMesh, type BuiltMap } from './render/mapmesh.ts';
import { SpriteActor, SpriteMaterialCache, buildThingSprites, type ThingLayer } from './render/sprites.ts';
import { FlatFader, WallFader } from './render/occlusion.ts';
import { TopDownCamera } from './render/camera.ts';
import { World } from './game/world.ts';
import { Player, PLAYER_HEIGHT, PLAYER_RADIUS } from './game/player.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { SpecialsController, computeMovableSectors } from './game/specials.ts';
import { Input } from './game/input.ts';
import { Menu, type Selection } from './ui/menu.ts';
import { Hud } from './ui/hud.ts';
import type { Skill } from './game/skill.ts';
import { applyPickup, createInventory, finishLevel, ITEM_PICKUP_RADIUS, type Inventory } from './game/inventory.ts';
import { DEVMODE } from './constants.ts';

/** Combined radius (map units) within which an item is close enough to pick up. */
const PICKUP_RANGE = PLAYER_RADIUS + ITEM_PICKUP_RADIUS;

const hudEl = document.getElementById('hud')!;

/** Camera-orbit degrees per pixel of right-mouse drag. */
const YAW_SENSITIVITY = 0.15;
/** Degrees per second Q/E rotate the camera — a keyboard alternative to right-drag. */
const KEY_YAW_SPEED = 120;

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
const TFOG_LIFETIME = TFOG_FRAMES.length * TFOG_FRAME_SECONDS;
/** Vanilla spawns the destination fog 20 units ahead of the landing spot, along the direction it faces. */
const TFOG_SPAWN_OFFSET = 20;

interface TeleportFog {
  actor: SpriteActor;
  x: number;
  y: number;
  z: number;
  light: number;
  elapsed: number;
}

/**
 * Renderer, canvas, camera and input live for the whole session — a new level
 * must not cost a new WebGL context.
 */
class Viewport {
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
class Game {
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
  private teleportFogs: TeleportFog[] = [];
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
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 0;

  private view: Viewport;
  private wad: Wad;
  private skill: Skill;
  private hud: Hud;
  private inventory: Inventory = createInventory();
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
    // A fog puff mid-animation when the map changes (e.g. a teleporter onto
    // an exit line) would otherwise leave its plane glued into the new
    // level's scene forever, since nothing else ever removes it.
    for (const f of this.teleportFogs) this.scene.remove(f.actor.mesh);
    this.teleportFogs = [];

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
    this.materials.dispose();
    this.spriteMaterials.dispose();
  }

  private spawnTeleportFog(x: number, y: number, z: number): void {
    const actor = new SpriteActor(this.spriteBank, this.spriteMaterials, 'TFOG', TFOG_FRAMES, TFOG_FRAME_SECONDS);
    const light = this.world.sectorAt(x, y)?.light ?? 128;
    if (!actor.setPose(x, y, z, 0, light)) return;
    this.scene.add(actor.mesh);
    this.teleportFogs.push({ actor, x, y, z, light, elapsed: 0 });
  }

  /** Advances every active teleport-fog puff and drops the ones that finished their one-shot animation. */
  private updateTeleportFogs(dt: number, viewerAngleDeg: number): void {
    if (this.teleportFogs.length === 0) return;
    const remaining: TeleportFog[] = [];
    for (const f of this.teleportFogs) {
      f.elapsed += dt;
      if (f.elapsed >= TFOG_LIFETIME) {
        this.scene.remove(f.actor.mesh);
        continue;
      }
      f.actor.setPose(f.x, f.y, f.z, 0, f.light, dt, true, viewerAngleDeg);
      remaining.push(f);
    }
    this.teleportFogs = remaining;
  }

  private frame = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const { input, camera } = this.view;
    this.handleHotkeys();
    camera.yawDeg -= input.consumeDragYaw() * YAW_SENSITIVITY;
    // Signs match right-drag: E rotates the same way as dragging right, Q as dragging left.
    if (input.held('KeyQ')) camera.yawDeg += KEY_YAW_SPEED * dt;
    if (input.held('KeyE')) camera.yawDeg -= KEY_YAW_SPEED * dt;

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

    const aim = camera.pointerToPlane(input.pointer.x, input.pointer.y, this.player.z + 32);
    this.player.update(dt, input, aim, camera.viewerAngleDeg + 180);
    camera.update(dt, this.player.x, this.player.y, this.player.eyeZ, aim);

    this.things?.tryPickup(this.player.x, this.player.y, this.player.z, PICKUP_RANGE, (type) =>
      applyPickup(this.inventory, type),
    );
    this.hud.update(this.inventory);

    this.fogOfWar.update(dt, this.player.x, this.player.y);
    const fog = this.fogOfWar;
    const fogAlphaOf = (subsector: number) => fog.alphaOf(subsector);
    this.things?.update(camera.viewerAngleDeg, fogAlphaOf);
    this.updateTeleportFogs(dt, camera.viewerAngleDeg);

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
    const walking = Math.hypot(this.player.velX, this.player.velY) > 1;
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
      'WASD move   Shift run   mouse aim   right-drag / Q-E rotate camera   Space use',
      'N/P map   C ceilings   +/- zoom   [ ] tilt   Esc menu',
    ].join('\n');
  }
}

/** A short label naming the WAD set, for the HUD. */
function titleOf(iwad: WadSource, pwads: WadSource[]): string {
  return pwads.length === 0 ? iwad.label : `${iwad.label} + ${pwads.map((p) => p.label).join(' + ')}`;
}

/** `?pos=x,y` — drop the player there instead of at the map's own start. */
function parsePos(raw: string | null): { x: number; y: number } | null {
  if (!raw) return null;
  const [x, y] = raw.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function boot(): Promise<void> {
  const view = new Viewport(document.getElementById('app')!);
  const startPos = parsePos(new URLSearchParams(location.search).get('pos'));
  let game: Game | null = null;

  const startLevel = async (selection: Selection): Promise<void> => {
    menu.setStatus('Loading …');
    try {
      const files = await loadWadFiles(selection.iwad, selection.pwads);
      const wad = new Wad(files);

      game?.dispose();
      game = new Game(view, wad, selection.map, titleOf(selection.iwad, selection.pwads), selection.skill, startPos);

      menu.close();
      game.resume();
    } catch (err) {
      menu.setStatus((err as Error).message, true);
      console.error(err);
    }
  };

  const menu: Menu = new Menu((selection) => void startLevel(selection));

  // Esc toggles between playing and the menu; the level survives the trip.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    if (!menu.isOpen) {
      game?.pause();
      menu.open();
    } else if (game) {
      menu.close();
      game.resume();
    }
  });

  const params = new URLSearchParams(location.search);
  await menu.init({
    iwad: params.get('wad'),
    pwads: (params.get('pwad') ?? '').split(',').filter(Boolean),
    map: params.get('map'),
  });

  // A deep link with ?map= skips the menu; otherwise the menu is the entry point.
  const deepLink = params.get('map');
  if (deepLink && menu.isReady) menu.submit();
  else menu.open();
}

void boot();
