import * as THREE from 'three';
import { Wad } from './wad/wad.ts';
import { loadWadFiles, type WadSource } from './wad/library.ts';
import { GraphicsBank } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { buildMapMesh, type BuiltMap } from './render/mapmesh.ts';
import { SpriteActor, SpriteMaterialCache, buildThingSprites, type ThingLayer } from './render/sprites.ts';
import { FlatFader, WallFader } from './render/occlusion.ts';
import { TopDownCamera } from './render/camera.ts';
import { PLAYER_HEIGHT, World } from './game/world.ts';
import { Player } from './game/player.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { Input } from './game/input.ts';
import { Menu, type Selection } from './ui/menu.ts';
import type { Skill } from './game/skill.ts';

const hudEl = document.getElementById('hud')!;

/** Camera-orbit degrees per pixel of right-mouse drag. */
const YAW_SENSITIVITY = 0.15;

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

  private world!: World;
  private player!: Player;
  private built: BuiltMap | null = null;
  private things: ThingLayer | null = null;
  private playerActor: SpriteActor;
  private wallFader!: WallFader;
  private flatFader!: FlatFader;
  private fogOfWar!: FogOfWar;

  private renderCeilings = false;
  private running = false;
  private lastTime = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 0;

  private view: Viewport;
  private wad: Wad;
  private skill: Skill;
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
    this.scene.fog = new THREE.Fog(0x05050a, 1400, 2600);

    const gfx = new GraphicsBank(wad);
    this.materials = new MaterialBank(gfx, view.renderer);
    this.spriteBank = new SpriteBank(wad);
    this.spriteMaterials = new SpriteMaterialCache(gfx, view.renderer);
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
    this.mapIndex = (index + this.mapNames.length) % this.mapNames.length;
    const name = this.mapNames[this.mapIndex];

    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
    }
    if (this.things) this.scene.remove(this.things.group);

    const t0 = performance.now();
    const map = loadMap(this.wad, name);
    this.world = new World(map);
    this.built = buildMapMesh(map, this.materials, { renderCeilings: this.renderCeilings });
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
    this.built?.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.materials.dispose();
    this.spriteMaterials.dispose();
  }

  private frame = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const { input, camera } = this.view;
    this.handleHotkeys();
    camera.yawDeg -= input.consumeDragYaw() * YAW_SENSITIVITY;

    const aim = camera.pointerToPlane(input.pointer.x, input.pointer.y, this.player.z + 32);
    this.player.update(dt, input, aim, camera.viewerAngleDeg + 180);
    camera.update(dt, this.player.x, this.player.y, this.player.eyeZ, aim);

    this.fogOfWar.update(dt, this.player.x, this.player.y);
    const fog = this.fogOfWar;
    const fogAlphaOf = (subsector: number) => fog.alphaOf(subsector);
    this.things?.update(camera.viewerAngleDeg, fogAlphaOf);

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
    if (input.pressed('KeyC')) {
      this.renderCeilings = !this.renderCeilings;
      this.loadMapByIndex(this.mapIndex);
    }
    if (input.pressed('KeyN')) this.loadMapByIndex(this.mapIndex + 1);
    if (input.pressed('KeyP')) this.loadMapByIndex(this.mapIndex - 1);
    if (input.held('Equal', 'NumpadAdd')) camera.distance = Math.max(200, camera.distance - 8);
    if (input.held('Minus', 'NumpadSubtract')) camera.distance = Math.min(2400, camera.distance + 8);
    if (input.held('BracketLeft')) camera.tiltDeg = Math.max(0, camera.tiltDeg - 0.5);
    if (input.held('BracketRight')) camera.tiltDeg = Math.min(70, camera.tiltDeg + 0.5);
  }

  private updateHud(): void {
    const { camera } = this.view;
    const sector = this.world.sectorIndexAt(this.player.x, this.player.y);
    hudEl.textContent = [
      `${this.currentMap}   ${this.title}`,
      `${this.fps} fps   ${this.built?.triangles ?? 0} tris`,
      `pos ${this.player.x.toFixed(0)}, ${this.player.y.toFixed(0)}   z ${this.player.z.toFixed(0)}   sector ${sector}`,
      `cam ${camera.distance.toFixed(0)} u / ${camera.tiltDeg.toFixed(0)}° tilt / ${camera.yawDeg.toFixed(0)}° yaw   ceilings ${this.renderCeilings ? 'on' : 'off'}`,
      '',
      'WASD move   Shift run   mouse aim   right-drag rotate camera',
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
