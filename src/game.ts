import * as THREE from 'three';
import type { Wad } from './wad/wad.ts';
import { GraphicsBank } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap, type DoomMap } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { buildMapMesh, type BuiltMap } from './render/mapmesh.ts';
import { SpriteActor, SpriteMaterialCache } from './render/sprites.ts';
import { buildThingSprites, type MonsterAttackEvent, type ThingLayer } from './game/things.ts';
import { MONSTER_FIRE_HEIGHT, sameSpecies } from './game/monsters.ts';
import { FlatFader, type FadeTarget, TextureScroller, WallFader } from './render/occlusion.ts';
import { TopDownCamera } from './render/camera.ts';
import { World, hasLineOfSight, shotPath } from './game/world.ts';
import { Player, PLAYER_HEIGHT, PLAYER_RADIUS } from './game/player.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { SpecialsController, computeMovableSectors } from './game/specials.ts';
import {
  CRUSH_DAMAGE,
  DAMAGE_FLOOR_INTERVAL,
  SECTOR_DAMAGE_SPECIALS,
  SUIT_LEAK_CHANCE,
  type DamageFloorEffect,
} from './wad/specials.ts';
import { Input } from './game/input.ts';
import { Hud } from './ui/hud.ts';
import { ProfilerHud } from './ui/profilerhud.ts';
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
  tickPowers,
  type Inventory,
} from './game/inventory.ts';
import { WeaponSystem, type Shot } from './game/weapons.ts';
import { Tracer } from './render/tracer.ts';
import type { Placement, Pos2, Pos3 } from './types.ts';
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
interface OneShotEffect extends Pos3 {
  actor: SpriteActor;
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
 * `MISL` (rocket, also the cyberdemon's own rocket — see game/monsters.ts's
 * `MONSTER_STATS`) only has directional flight art on frame A — B-D are its
 * explosion frames, played separately (see IMPACT_EFFECTS) once it lands —
 * while every other entry here is a 2-frame pulse (omnidirectional for
 * `PLSS`/`BFS1`/`BAL1`/`BAL2`/`MANF`/`APLS`, directional for `BAL7`/`FATB`),
 * confirmed against the actual lump names and frame/rotation counts in
 * `DOOM2.WAD` — dumped directly from the IWAD rather than assumed, the same
 * rigor as `MONSTER_DEATH_FRAMES`. Falls back to a single held frame for
 * anything not listed.
 */
const PROJECTILE_FRAMES: Record<string, string[]> = {
  PLSS: ['A', 'B'],
  BFS1: ['A', 'B'],
  BAL1: ['A', 'B'], // imp fireball
  BAL2: ['A', 'B'], // cacodemon fireball
  BAL7: ['A', 'B'], // baron/hell knight fireball
  MANF: ['A', 'B'], // mancubus fireball
  APLS: ['A', 'B'], // arachnotron plasma ball
  FATB: ['A', 'B'], // revenant missile
};

/** Vanilla's own explosion states run at 4 tics/frame. */
const IMPACT_FRAME_SECONDS = 4 / 35;

/**
 * A projectile's impact explosion, keyed by its flight sprite. Confirmed
 * against the real `linuxdoom-1.10` `info.c` mobjinfo/state tables (not
 * assumed): most fireballs explode into their own trailing frames on the
 * *same* sprite (`BAL1`/`BAL2`/`BAL7`'s own `C`-`E`, `APLS`'s dedicated
 * `APBX`, `FATB`'s dedicated `FBXP`) the same way `MISL` reuses its own
 * `B`-`D` for the rocket's blast — except the mancubus's `MANF`, which has
 * no explosion frames of its own at all and explodes using the *rocket's*
 * `MISL` frames instead, a genuine vanilla oddity rather than a
 * simplification made here. Purely cosmetic — it plays where a shot reached
 * shotPath's distance; whether (and what) it actually damaged is resolved
 * separately, in `spawnShot`/`spawnMonsterProjectile`/`updateProjectiles`/
 * `applyRadiusDamage` below.
 */
const IMPACT_EFFECTS: Record<string, { sprite: string; frames: string[] }> = {
  MISL: { sprite: 'MISL', frames: ['B', 'C', 'D'] },
  PLSS: { sprite: 'PLSE', frames: ['A', 'B', 'C', 'D', 'E'] },
  BFS1: { sprite: 'BFE1', frames: ['A', 'B', 'C', 'D', 'E', 'F'] },
  BAL1: { sprite: 'BAL1', frames: ['C', 'D', 'E'] },
  BAL2: { sprite: 'BAL2', frames: ['C', 'D', 'E'] },
  BAL7: { sprite: 'BAL7', frames: ['C', 'D', 'E'] },
  MANF: { sprite: 'MISL', frames: ['B', 'C', 'D'] },
  APLS: { sprite: 'APBX', frames: ['A', 'B', 'C', 'D', 'E'] },
  FATB: { sprite: 'FBXP', frames: ['A', 'B', 'C'] },
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

/**
 * Player attack/pain sprite frame letters — derived and WAD-cross-checked
 * the same way `game/thingdefs.ts`'s `MONSTER_ATTACK_FRAMES`/
 * `MONSTER_PAIN_FRAMES` are (see that doc): vanilla's `info.c` puts
 * `S_PLAY_ATK1`/`ATK2` at `E`/`F` and `S_PLAY_PAIN`/`PAIN2` at `G`, right
 * before the confirmed `PLAYER_DEATH_FRAMES` tail starts at `H` — 4 walk +
 * 2 attack + 1 pain, exactly accounting for the gap. Played via
 * `SpriteAnimator.playOnce`, not `die`: unlike death, both hand back to the
 * ordinary walk/idle cycle once they finish.
 */
const PLAYER_ATTACK_FRAMES = ['E', 'F'];
const PLAYER_PAIN_FRAMES = ['G'];
const PLAYER_ACTION_FRAME_SECONDS = 3 / 35;

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
  /**
   * The monster that fired this, or `null` for one of the player's own shots.
   *
   * A monster's projectile resolves its hit completely differently from a
   * player's. A player shot's target (a monster) doesn't move meaningfully
   * mid-flight, so `spawnShot` settles hit-or-miss up front and this only
   * carries the answer (`hitMonsterId`). A monster's shot has to keep asking:
   * every frame it re-tests proximity against the player's *live* position
   * and against every living monster it passes, so stepping behind cover or
   * just outrunning a slow fireball actually works — and so a fireball aimed
   * at the player that clips a demon on the way hits the demon, which is what
   * starts most infights.
   */
  sourceId: number | null;
  /** The firing monster's doomednum, for `sameSpecies` — vanilla's "don't hit same species as originator" rule on projectiles. */
  sourceType: number;
  /**
   * The wall `shotPath` found blocking this projectile's flight at launch
   * (null if it flew unobstructed to `target`/`WEAPON_RANGE`), carried
   * through to `updateProjectiles` so a shoot-triggered special (24/46/47)
   * fires at actual arrival rather than the instant the shot is launched —
   * vanilla's `P_ShootSpecialLine` for a missile runs from `PIT_CheckLine`
   * when the projectile's own movement reaches the line, not when it's
   * fired. A hitscan pellet has no such delay (it's resolved and gone in the
   * same frame), so its trigger fires immediately in `spawnShot` instead —
   * this field only matters for the flying-sprite case.
   */
  lineIndex: number | null;
}

/**
 * Slack added to the player's own radius when testing whether a monster's
 * hitscan bolt passes through them. Vanilla resolves this against the
 * player's real 16-unit box with an aim that was computed against their exact
 * position the same tic; here the bolt is fired along the angle the monster
 * faced when its attack *started*, up to a whole attack-state earlier, so
 * without a little tolerance a strafing player would be missed by shots that
 * vanilla would land.
 */
const MONSTER_BULLET_SLOP = 12;

/** How close a monster projectile has to get to the player's live position before it's treated as a hit — see `Projectile.sourceId`'s doc. */
const MONSTER_PROJECTILE_HIT_RADIUS = PLAYER_RADIUS + 24;
/** Vertical companion to `MONSTER_PROJECTILE_HIT_RADIUS` — the same overhead/underneath tolerance `ThingLayer.tryPickup`'s own gate already uses for picking an item up through a window onto a floor above/below. */
const MONSTER_PROJECTILE_HIT_HEIGHT = 128;

/**
 * How far (2D, from the player) an awake monster can be and still count as an
 * occlusion-fade target (see the `fadeTargets` build below). Deliberately a
 * plain distance cap rather than requiring unobstructed `hasLineOfSight`: the
 * whole point of fading is to reveal a monster a wall is currently hiding, so
 * gating on "already has line of sight" made the fade a no-op for exactly the
 * case it exists for — an earlier version did this and a zombieman one wall
 * away in a corridor stopped fading the wall in front of it. A distance cap
 * still bounds the original concern (an alerted monster dead-reckoning from
 * clear across the level shouldn't fade every wall along that long a
 * straight line) without reintroducing that contradiction. Tuned by feel to
 * roughly a room-or-corridor's length, not converted from anything vanilla.
 */
const MONSTER_FADE_RANGE = 768;

/**
 * Most awake monsters that can act as occlusion-fade targets at once, nearest
 * first. `WallFader`/`FlatFader` cost is quads × targets, so an unbounded list
 * turns into a real per-frame cost on a map that can have hundreds of monsters
 * awake inside `MONSTER_FADE_RANGE` at the same time (NUTS.WAD's arena being
 * the extreme case). Purely a cost bound, not a behavior choice: past a couple
 * of dozen nearby monsters, every wall any of them stands behind is already
 * being faded by one of the nearer ones, so the ones dropped here have nothing
 * left to reveal.
 */
const MAX_FADE_TARGETS = 48;

/**
 * How solid the player sprite draws while partial invisibility is held
 * (`game/inventory.ts`'s `PINS` powerup). Vanilla draws a shadowed thing
 * through its own `fuzz` colormap — a per-column smear of the pixels behind
 * it, which is a software-renderer trick with no direct equivalent here.
 * Plain translucency is the honest stand-in: it reads as "hard to see"
 * without leaving the player unable to find themselves on screen, which
 * matters more here than in vanilla (there the invisible thing is *you*,
 * seen from your own eyes; here it's a sprite you have to keep track of).
 */
const INVISIBILITY_OPACITY = 0.35;

/**
 * `WebGLRenderer.toneMappingExposure` while the light amplification visor is
 * held — a flat multiply over the whole frame (`LinearToneMapping`, see
 * `Viewport`), which is as close as this engine gets to vanilla's own visor
 * without rebuilding every surface's baked vertex lighting. Vanilla forces
 * the *brightest* colormap row everywhere, i.e. full bright regardless of
 * sector light; a multiply keeps some of the level's own shading while
 * lifting a dark room to plainly readable, and lets already-bright rooms
 * saturate out the way vanilla's does.
 */
const LIGHT_VISOR_EXPOSURE = 2.5;

/**
 * Vanilla's `A_FaceTarget`: a monster aiming at something carrying
 * `MF_SHADOW` — which, in this engine, only ever means the player under
 * partial invisibility — throws its facing off by
 * `(P_Random()-P_Random())<<21` BAM, i.e. up to ±255/2048 of a full turn.
 * That is the *entire* mechanic behind the blur sphere in vanilla: it doesn't
 * touch sight, waking, or a monster's willingness to attack at all, it just
 * makes them shoot wide.
 */
const SHADOW_AIM_SPREAD_DEG = (255 / 2048) * 360;

/**
 * The red screen flash on taking damage, echoing vanilla's own palette shift
 * (`ST_doPaletteStuff`'s `damagecount`): vanilla adds the raw damage taken to
 * a counter clamped to 100 and ticks it down by 1 every tic (35/sec), so a
 * big hit flashes hard and a level's steady chip damage keeps a faint red
 * edge lit rather than ever fully clearing. `PAIN_FLASH_MAX_DAMAGE` is that
 * same 100-point clamp and `PAIN_FLASH_FADE_SECONDS` is 100 tics over 35 —
 * vanilla's own full-to-zero decay time. `PAIN_FLASH_MAX_ALPHA` has no
 * vanilla analogue (there it's a straight palette swap, not a translucent
 * overlay) and is tuned by feel, same honesty as `BRIGHTNESS_LIFT`.
 */
const PAIN_FLASH_MAX_DAMAGE = 100;
const PAIN_FLASH_FADE_SECONDS = 100 / 35;
const PAIN_FLASH_MAX_ALPHA = 0.5;

/**
 * How long before a timed powerup expires that its screen effect starts
 * blinking on/off as a warning, and how fast — there's no direct vanilla
 * analogue for a *screen effect* blinking (vanilla's own low-on-something
 * blink, `cnt & 8` in `ST_Ticker`, flickers a HUD number instead), so this
 * borrows just the idea: an unmissable "about to wear off" cue for every
 * timed powerup with a screen effect to blink — invulnerability, the suit
 * and invisibility all matter to play right up to the moment they expire
 * (walking back into a hazard, or back into plain sight, a second early is
 * costly), unlike the light visor, which has no screen effect of its own to
 * blink (a flickering `toneMappingExposure` would just look broken).
 */
const POWER_BLINK_WARNING_SECONDS = 3;
const POWER_BLINK_HZ = 4;

/**
 * Whether a powerup's screen effect should currently show, given its
 * remaining seconds (`Inventory.powers[id]`). Once inside the warning
 * window, `floor(secs * Hz) % 2` alternates every `1/Hz` seconds as `secs`
 * counts down — a plain on/off square wave ending exactly at 0, no separate
 * blink-phase timer to track.
 */
function powerBlinkVisible(secondsLeft: number): boolean {
  return (
    secondsLeft > 0 &&
    (secondsLeft > POWER_BLINK_WARNING_SECONDS || Math.floor(secondsLeft * POWER_BLINK_HZ) % 2 === 0)
  );
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
    // Set once, here, rather than switched on and off with the light visor:
    // changing `toneMapping` itself recompiles every material's shader, while
    // `toneMappingExposure` is a plain uniform. `LinearToneMapping` at the
    // default exposure of 1 is `saturate(color)` — bit-identical to
    // `NoToneMapping` for anything already in range, so this costs nothing
    // until `LIGHT_VISOR_EXPOSURE` actually turns it up.
    this.renderer.toneMapping = THREE.LinearToneMapping;
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
  private textureScroller!: TextureScroller;
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
  /** Counts down to the next damage-floor tick while the player stands on one — see `updateDamageFloor`. Reset (not merely paused) whenever they aren't, so re-entering a hazard always gives the same brief grace period rather than resuming mid-countdown from a stale visit. */
  private damageFloorTimer = DAMAGE_FLOOR_INTERVAL;

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
  /**
   * DEVMODE's per-category timing breakdown (top-right overlay). Measurement
   * itself always runs — `performance.now()` calls are cheap enough not to
   * bother gating, matching how `fps` below is always computed regardless of
   * DEVMODE — only the DOM panel's visibility (toggled once, in the
   * constructor) and `updateHud`'s decision to push samples to it are gated.
   */
  private profiler = new FrameProfiler();
  private profilerHud = new ProfilerHud();
  private inventory: Inventory = createInventory();
  private deathOverlay = document.getElementById('death-overlay')!;
  /** Full-screen colour overlay for the powerups that recolour the view — see `updatePowerEffects`. */
  private screenTint = document.getElementById('screen-tint')!;
  /** Full-screen red damage flash, separate from `screenTint` — see `PAIN_FLASH_MAX_DAMAGE`'s doc. */
  private painFlashEl = document.getElementById('pain-flash')!;
  /** Current intensity of the damage flash, 0-1, bumped in `damagePlayer` and decayed in `updatePainFlash`. */
  private painFlash = 0;
  /** True once the player's health has hit 0 — freezes movement/aim/firing/pickups (see `frame`) until `restart`. */
  private playerDead = false;
  readonly title: string;

  /** `?pos=x,y` override for the player start, consumed by the first map load. */
  private startPos: Pos2 | null;

  constructor(
    view: Viewport,
    wad: Wad,
    startMap: string,
    title: string,
    skill: Skill,
    startPos: Pos2 | null = null,
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

    // DEVMODE never changes at runtime, so this is set once rather than every frame.
    document.getElementById('profiler-hud')!.classList.toggle('visible', DEVMODE);

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
    this.painFlash = 0;
    this.painFlashEl.style.opacity = '0';
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
    this.built = buildMapMesh(map, this.materials, { movableSectors });
    this.scene.add(this.built.group);
    this.wallFader = new WallFader(this.built.occluders, this.built.wallMeshes);
    this.flatFader = new FlatFader(this.built.flatSurfaces, this.built.flatMeshes);
    this.textureScroller = new TextureScroller(map, this.built.occluders, this.built.wallMeshes, this.materials);
    this.damageFloorTimer = DAMAGE_FLOOR_INTERVAL;
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
        this.spawnTeleportFog(this.player);
        this.player.teleportTo(dest);
        this.spawnTeleportFog({
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
    // The Viewport (renderer) and the overlay elements outlive this Game, so
    // anything updatePowerEffects turned on has to be turned back off here —
    // otherwise the menu, and the next level started from it, inherit whatever
    // powerup happened to be running when this one ended.
    this.screenTint.classList.remove('invulnerable', 'suited');
    this.painFlashEl.style.opacity = '0';
    this.view.renderer.toneMappingExposure = 1;
    this.playerActor.dispose();
    this.specials?.dispose();
    this.built?.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    // Tracers own per-instance geometry/material (unlike sprite actors, whose
    // geometry/material come from the shared, disposed-below SpriteMaterialCache).
    for (const t of this.tracers) t.dispose();
    // The sprite batches' instance buffers and cloned materials are the things
    // layer's own; the geometry/textures behind them are spriteMaterials'.
    this.things?.dispose();
    this.materials.dispose();
    this.spriteMaterials.dispose();
  }

  /** Spawns a one-shot sprite animation (teleport fog, impact explosion) and returns it, or null if the sprite has no art. */
  private spawnEffect(sprite: string, frames: string[], frameSeconds: number, at: Pos3): OneShotEffect | null {
    const actor = new SpriteActor(this.spriteBank, this.spriteMaterials, sprite, frames, frameSeconds);
    const light = this.world.sectorAt(at.x, at.y)?.light ?? 128;
    if (!actor.setPose(at.x, at.y, at.z, 0, light)) return null;
    this.scene.add(actor.mesh);
    return { actor, x: at.x, y: at.y, z: at.z, light, elapsed: 0, lifetime: frames.length * frameSeconds };
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

  private spawnTeleportFog(at: Pos3): void {
    const effect = this.spawnEffect('TFOG', TFOG_FRAMES, TFOG_FRAME_SECONDS, at);
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
  private spawnShot(shot: Shot, startZ: number, target: Pos3 | null, targetId: number | null): void {
    const origin: Pos3 = { x: this.player.x, y: this.player.y, z: startZ };

    // A swing never travels, so it needs none of shotPath's wall/step
    // blocking: vanilla's A_Punch/A_Saw just trace MELEERANGE along the
    // player's facing and damage the first thing there. Aim is already
    // pointing at a hovered monster (player.angle is set from the same `aim`
    // the lock-on uses), so the ray finds a locked-on target without a
    // separate case for it — it simply can't reach one further off than the
    // swing's own range, the same as vanilla.
    if (shot.kind === 'melee') {
      const swung = this.things?.raycastMonster(origin, shot.angleRad, shot.range) ?? null;
      if (swung) this.things?.damage(swung.id, shot.damage);
      return;
    }

    const path = shotPath(this.world, origin, shot.angleRad, target);

    let hitMonsterId: number | null = null;
    let endX = path.x;
    let endY = path.y;
    let endDist = path.dist;

    if (target !== null && targetId !== null) {
      // A locked shot only actually connects if nothing stopped it short of
      // the target — shotPath returns wherever it got blocked, so comparing
      // that distance against the target's own is how "did this land" is known.
      const wantDist = Math.hypot(target.x - origin.x, target.y - origin.y);
      if (path.dist >= wantDist - 1) hitMonsterId = targetId;
    } else {
      // No locked target: still test the straight path itself against every
      // monster's body (`ThingLayer.raycastMonster`), the way any real
      // hitscan/projectile trace would — a monster standing between the
      // player and a wall they're shooting at shouldn't be invisible to the
      // shot just because it wasn't clicked. Only ever shortens the shot
      // (never past `path.dist`, the wall/step it would have hit anyway).
      const monsterHit = this.things?.raycastMonster(origin, shot.angleRad, path.dist) ?? null;
      if (monsterHit) {
        hitMonsterId = monsterHit.id;
        endX = monsterHit.x;
        endY = monsterHit.y;
        endDist = monsterHit.dist;
      }
    }

    // A shoot-triggered special (24/46/47) only fires if the shot actually
    // reached the wall it's mounted on rather than being absorbed by a
    // monster body first — a `hitMonsterId` (something closer stopped it)
    // means this shot never got there. A hitscan pellet is resolved and gone
    // this same frame, so it fires immediately here, same as vanilla's
    // instant `PTR_ShootTraverse`; a projectile's is deferred to actual
    // arrival in `updateProjectiles` (see `Projectile.lineIndex`'s doc).
    if (shot.kind === 'hitscan') {
      if (hitMonsterId !== null) this.things?.damage(hitMonsterId, shot.damage);
      else this.specials?.triggerShot(path.lineIndex, this.inventory.keys);
      const tracer = new Tracer(origin, { x: endX, y: endY, z: path.z }, TRACER_COLOR);
      this.scene.add(tracer.line);
      this.tracers.push(tracer);
      return;
    }

    const actor = new SpriteActor(this.spriteBank, this.spriteMaterials, shot.sprite, PROJECTILE_FRAMES[shot.sprite]);
    const light = this.world.sectorAt(origin.x, origin.y)?.light ?? 128;
    if (!actor.setPose(origin.x, origin.y, startZ, (shot.angleRad * 180) / Math.PI, light)) return;
    this.scene.add(actor.mesh);
    this.projectiles.push({
      actor,
      originX: origin.x,
      originY: origin.y,
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
      sourceId: null,
      sourceType: 0,
      lineIndex: hitMonsterId === null ? path.lineIndex : null,
    });
  }

  /**
   * Turns a monster's fired ranged `MonsterAttackEvent` (`game/monsters.ts`,
   * via `game/things.ts`'s `ThingLayer.update`) into a flying `Projectile`,
   * for the monster types whose `AttackStats.ranged.projectile` is
   * configured — the caller (`frame`) only reaches here after already
   * checking that field is set. `atk.targetId` says what it was actually
   * aimed at — the player when `null`, another monster (an infight)
   * otherwise — resolved live via `ThingLayer.monsterById` rather than
   * trusted from whenever the attack started, since a projectile with real
   * flight time shouldn't aim at where its target *used to be*. Reuses
   * `shotPath` similarly to a player's own locked-on shot (`spawnShot`'s
   * doc): a straight line from the monster to its target's position *at the
   * moment it fired*, angled from the monster's own height to the target's,
   * stopped early only by a real wall or shut door — explicitly passing
   * `skipHeightTest: false`, unlike a player's own locked shot, since the
   * player has no "auto-aim" leniency to justify a monster's fireball
   * clearing a low or high step it shouldn't (see `shotPath`'s doc). Unlike a
   * player's shot, though, the flight doesn't resolve hit-or-miss up front —
   * its target can keep moving after the shot leaves, so `updateProjectiles`
   * re-tests proximity to live positions every frame instead (the player's
   * always; other monsters' only if this shot is `sourceId`-tagged as
   * someone's own — see `Projectile.sourceId`'s doc and `monsterStruckBy`).
   */
  private spawnMonsterProjectile(atk: MonsterAttackEvent): void {
    if (!atk.projectile) return;
    const victim = atk.targetId === null ? null : this.things?.monsterById(atk.targetId);
    const target = victim
      ? { x: victim.x, y: victim.y, z: victim.z + MONSTER_FIRE_HEIGHT }
      : { x: this.player.x, y: this.player.y, z: this.player.z + AIM_HEIGHT_OFFSET };
    const path = shotPath(this.world, atk, atk.projectile.angleRad, target, false);
    const actor = new SpriteActor(this.spriteBank, this.spriteMaterials, atk.projectile.sprite, PROJECTILE_FRAMES[atk.projectile.sprite]);
    const light = this.world.sectorAt(atk.x, atk.y)?.light ?? 128;
    if (!actor.setPose(atk.x, atk.y, atk.z, (atk.projectile.angleRad * 180) / Math.PI, light)) return;
    this.scene.add(actor.mesh);
    this.projectiles.push({
      actor,
      originX: atk.x,
      originY: atk.y,
      startZ: atk.z,
      endZ: path.z,
      angleRad: atk.projectile.angleRad,
      speed: atk.projectile.speed,
      maxDist: path.dist,
      traveled: 0,
      light,
      sprite: atk.projectile.sprite,
      damage: atk.damage,
      splash: null,
      hitMonsterId: null,
      sourceId: atk.sourceId,
      sourceType: atk.sourceType,
      lineIndex: path.lineIndex,
    });
  }

  /**
   * Applies a monster's damage to whatever it landed on — the player when
   * `targetId` is null, otherwise another monster, tagged with who did it so
   * `ThingLayer.damage` can run vanilla's retaliation rule and start an
   * infight.
   */
  private damageFromMonster(targetId: number | null, damage: number, sourceId: number, sourceType: number): void {
    if (targetId === null) this.damagePlayer(damage);
    else this.things?.damage(targetId, damage, { id: sourceId, type: sourceType });
  }

  /**
   * Traces a monster's hitscan bolt and damages the first thing it actually
   * reaches. Three things can stop it and the nearest wins: a wall
   * (`shotPath`), another monster standing in the line of fire
   * (`raycastMonster`, minus the shooter itself), or the player. Vanilla's
   * `P_LineAttack` works exactly this way — it damages whatever the trace
   * first runs into, with no notion of an intended target and no species
   * check, which is why a zombieman firing past another zombieman starts a
   * fight.
   *
   * The tracer is drawn to wherever the bolt stopped rather than to the
   * target, so a shot that hits an unintended body visibly ends there.
   */
  private resolveMonsterHitscan(atk: MonsterAttackEvent): void {
    // Aimed at whatever it was shooting at, sloped from the monster's own fire
    // height to the target's — vanilla's P_AimLineAttack works out that slope
    // before P_LineAttack traces it, which is what lets a zombieman on a ledge
    // shoot down at you. shotPath caps the flight at the target's distance and
    // shortens it further if a wall gets in the way first.
    const victim = atk.targetId === null ? null : this.things?.monsterById(atk.targetId);
    const aim = victim
      ? { x: victim.x, y: victim.y, z: victim.z + MONSTER_FIRE_HEIGHT }
      : { x: this.player.x, y: this.player.y, z: this.player.z + AIM_HEIGHT_OFFSET };
    const path = shotPath(this.world, atk, atk.angleRad, aim, false);

    // Whatever the shot was aimed at, the trace damages the first body it
    // reaches — vanilla's PTR_ShootTraverse has no notion of an intended
    // target and no species check at all, which is why one zombieman firing
    // past another starts a fight.
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
      this.things?.damage(blocker.id, atk.damage, { id: atk.sourceId, type: atk.sourceType });
      endX = blocker.x;
      endY = blocker.y;
      endZ = blocker.z + MONSTER_FIRE_HEIGHT;
    } else if (playerInPath) {
      this.damagePlayer(atk.damage);
      endX = this.player.x;
      endY = this.player.y;
      endZ = this.player.z + AIM_HEIGHT_OFFSET;
    } else {
      // Nothing living stopped it — whatever's left is a wall, the only thing
      // `shotPath` itself could have blocked it on. `triggerShot`'s
      // `byMonster` gate reproduces vanilla's own hardcoded exception: this
      // can only actually do anything for a 46 line, never 24/47.
      this.specials?.triggerShot(path.lineIndex, this.inventory.keys, true);
    }
    const tracer = new Tracer(atk, { x: endX, y: endY, z: endZ }, MONSTER_TRACER_COLOR);
    this.scene.add(tracer.line);
    this.tracers.push(tracer);
  }

  /**
   * The monster a still-flying monster projectile has just run into, or null.
   * Skips the shooter itself and anything `sameSpecies` says the shot passes
   * harmlessly through — vanilla's `PIT_CheckThing` "don't hit same species as
   * originator" rule, which is why a pack of imps can throw fireballs across
   * each other all day without ever starting a fight amongst themselves, while
   * one imp fireball landing on a demon absolutely does.
   */
  private monsterStruckBy(p: Projectile, at: Pos3): number | null {
    if (p.sourceId === null) return null;
    for (const m of this.things?.monstersNear(at, MONSTER_PROJECTILE_HIT_RADIUS) ?? []) {
      if (m.id === p.sourceId) continue;
      if (sameSpecies(p.sourceType, m.type)) continue;
      if (Math.abs(m.z - at.z) > MONSTER_PROJECTILE_HIT_HEIGHT) continue;
      return m.id;
    }
    return null;
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
    this.spawnTeleportFog({ x: pos.x, y: pos.y, z: this.world.groundFloor(pos.x, pos.y, 0) });
    this.spawnTeleportFog({
      x: dest.x + Math.cos(dest.angle) * TFOG_SPAWN_OFFSET,
      y: dest.y + Math.sin(dest.angle) * TFOG_SPAWN_OFFSET,
      z: this.world.groundFloor(dest.x, dest.y, 0),
    });
    return dest;
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
   *
   * A monster's own shot (`p.sourceId !== null`, `spawnMonsterProjectile`)
   * has two earlier ways to arrive, checked every frame instead of resolved
   * once at launch: proximity to the player's *live* position
   * (`MONSTER_PROJECTILE_HIT_RADIUS`/`_HEIGHT`, `reachedPlayer`), and — since
   * a monster can just as well be shooting at another monster, or clip one
   * on the way to its actual target — proximity to any other living monster
   * along the way (`monsterStruckBy`, gated by `sameSpecies` the same way
   * `PIT_CheckThing` gates missile-vs-missile-originator collisions). A
   * player shot's target (a monster) never moves mid-flight, so resolving
   * that one up front is safe (see spawnShot's doc), but anything a monster
   * fires at can, and should be able to step behind cover or just outrun a
   * slower fireball after it's already been fired rather than always eating
   * the hit once the projectile reaches wherever its target used to be.
   * Reaching the wall-stop distance without having gotten close to either is
   * a clean miss for a monster's shot — no damage, just the impact
   * sprite/splash as usual.
   */
  private updateProjectiles(dt: number, viewerAngleDeg: number): void {
    if (this.projectiles.length === 0) return;
    const remaining: Projectile[] = [];
    for (const p of this.projectiles) {
      p.traveled += p.speed * dt;
      const clamped = Math.min(p.traveled, p.maxDist);
      const frac = p.maxDist > 0 ? clamped / p.maxDist : 1;
      const at: Pos3 = {
        x: p.originX + Math.cos(p.angleRad) * clamped,
        y: p.originY + Math.sin(p.angleRad) * clamped,
        z: p.startZ + (p.endZ - p.startZ) * frac,
      };

      // A monster's shot re-tests what it has reached every frame (see
      // Projectile.sourceId); a player's already knows.
      const fromMonster = p.sourceId !== null;
      const reachedPlayer =
        fromMonster &&
        !this.playerDead &&
        Math.hypot(this.player.x - at.x, this.player.y - at.y) <= MONSTER_PROJECTILE_HIT_RADIUS &&
        Math.abs(this.player.z - at.z) <= MONSTER_PROJECTILE_HIT_HEIGHT;
      const struck = fromMonster && !reachedPlayer ? this.monsterStruckBy(p, at) : null;

      if (reachedPlayer || struck || p.traveled >= p.maxDist) {
        this.scene.remove(p.actor.mesh);
        if (fromMonster) {
          if (reachedPlayer) this.damagePlayer(p.damage);
          else if (struck !== null) this.things?.damage(struck, p.damage, { id: p.sourceId!, type: p.sourceType });
          // A clean miss (reached maxDist without hitting a body) means it
          // arrived at whatever wall shotPath found at launch — fire its
          // shoot special now, at actual arrival, not back when it launched.
          else this.specials?.triggerShot(p.lineIndex, this.inventory.keys, true);
        } else if (p.hitMonsterId !== null) {
          this.things?.damage(p.hitMonsterId, p.damage);
        } else {
          this.specials?.triggerShot(p.lineIndex, this.inventory.keys);
        }
        if (p.splash) {
          this.applyRadiusDamage(at, p.splash.radius, p.splash.damage, p.splash.hitsPlayer, p.splash.tracers);
        }
        const impact = IMPACT_EFFECTS[p.sprite];
        if (impact) {
          const effect = this.spawnEffect(impact.sprite, impact.frames, IMPACT_FRAME_SECONDS, at);
          if (effect) this.impacts.push(effect);
        }
        continue;
      }
      p.actor.setPose(at.x, at.y, at.z, (p.angleRad * 180) / Math.PI, p.light, dt, true, viewerAngleDeg);
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
   * `at.z` is only carried along for `tracers`' visuals, never the falloff math.
   * `tracers`, when set, draws a `BFG_TRACER_COLOR` line from the impact to
   * every monster the blast actually damaged — see `WeaponDef.splash`'s doc
   * on why only the BFG sets it.
   */
  private applyRadiusDamage(at: Pos3, radius: number, maxDamage: number, hitsPlayer: boolean, tracers: boolean): void {
    for (const m of this.things?.monstersNear(at, radius) ?? []) {
      const dist = Math.hypot(m.x - at.x, m.y - at.y);
      if (dist >= radius || !hasLineOfSight(this.world, at, m)) continue;
      this.things?.damage(m.id, maxDamage * (1 - dist / radius));
      if (tracers) {
        const tracer = new Tracer(at, m, BFG_TRACER_COLOR);
        this.scene.add(tracer.line);
        this.tracers.push(tracer);
      }
    }

    if (!hitsPlayer) return;
    const pdist = Math.hypot(this.player.x - at.x, this.player.y - at.y);
    if (pdist < radius && hasLineOfSight(this.world, at, this.player)) {
      this.damagePlayer(maxDamage * (1 - pdist / radius));
    }
  }

  /** Applies armor-mitigated damage (`applyDamage`) to the player, transitioning to the death animation once health hits 0. A no-op once already dead, or once `applyDamage` reports invulnerability blocked the hit outright — no double death, and no pain flash/flinch for a hit that did nothing. */
  private damagePlayer(amount: number): void {
    if (this.playerDead || amount <= 0 || !applyDamage(this.inventory, amount)) return;
    this.painFlash = Math.min(1, this.painFlash + amount / PAIN_FLASH_MAX_DAMAGE);
    if (this.inventory.health <= 0) {
      this.playerDead = true;
      this.playerActor.die(PLAYER_DEATH_FRAMES, PLAYER_DEATH_FRAME_SECONDS);
      this.deathOverlay.classList.remove('hidden');
      return;
    }
    this.playerActor.playOnce(PLAYER_PAIN_FRAMES, PLAYER_ACTION_FRAME_SECONDS);
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

  /**
   * Vanilla's `P_PlayerInSpecialSector`, run directly here rather than
   * through `SpecialsController` — a damage floor isn't driven by any mover,
   * just `sector.special` plus the player's own position, none of which
   * needs `SpecialsController`'s machinery (see `SECTOR_DAMAGE_SPECIALS`'s
   * doc). Player-only, matching vanilla, which never damages monsters this
   * way. Gated on `player.z === sector.floorHeight` — vanilla's own
   * `mo->z != sector->floorheight` check, skipping a player still falling
   * into the sector rather than actually resting on its floor; comparing
   * against the *local* 2D-position sector's own floor height (not
   * `World.groundFloor`, which can read a straddled ledge's higher side) is
   * what keeps this from firing early while still up on an adjacent ledge.
   */
  private updateDamageFloor(dt: number): void {
    const sector = this.world.sectorAt(this.player.x, this.player.y);
    const effect = sector ? SECTOR_DAMAGE_SPECIALS[sector.special] : undefined;
    if (!sector || !effect || this.player.z !== sector.floorHeight) {
      this.damageFloorTimer = DAMAGE_FLOOR_INTERVAL;
      return;
    }
    this.damageFloorTimer -= dt;
    if (this.damageFloorTimer > 0) return;
    // The interval keeps running even when a suit blocks the hit, matching
    // vanilla's own global `leveltime&0x1f` clock: the suit skips the damage,
    // it doesn't bank it up for the moment it expires.
    this.damageFloorTimer += DAMAGE_FLOOR_INTERVAL;
    if (this.suitBlocks(effect)) return;
    this.damagePlayer(effect.amount);
    if (effect.exitBelowHealth !== undefined && this.inventory.health > 0 && this.inventory.health <= effect.exitBelowHealth) {
      this.pendingExit = true;
    }
  }

  /** Whether a worn radiation suit stops this damage floor's hit — see `DamageFloorEffect.suit` for why the three types differ. */
  private suitBlocks(effect: DamageFloorEffect): boolean {
    if (effect.suit === 'ignored' || !hasPower(this.inventory, 'radiationSuit')) return false;
    return effect.suit === 'blocks' || Math.random() >= SUIT_LEAK_CHANCE;
  }

  /**
   * Throws a monster's ranged shot off-aim while the player holds partial
   * invisibility — vanilla's `A_FaceTarget` fuzz (see `SHADOW_AIM_SPREAD_DEG`),
   * applied per shot, so each bullet of a chaingunner's burst goes its own way
   * rather than the whole burst sharing one offset. Deliberately only for a
   * shot aimed at the *player* (`targetId === null`): nothing else in this
   * engine ever carries `MF_SHADOW`, and an infight between two monsters
   * shouldn't suddenly go wide because the player drank something.
   *
   * Ranged only, matching vanilla: a melee swing lands on a range check
   * (`P_CheckMeleeRange`), never on the fuzzed angle, so a demon still bites
   * an invisible player just fine.
   */
  private applyShadowAim(atk: MonsterAttackEvent): void {
    if (atk.kind !== 'ranged' || atk.targetId !== null || !hasPower(this.inventory, 'invisibility')) return;
    // Vanilla's own P_Random-P_Random shape: a triangular spread centred on
    // the true aim, the same trick weapons.ts uses for pellet spread.
    const off = ((Math.random() - Math.random()) * SHADOW_AIM_SPREAD_DEG * Math.PI) / 180;
    atk.angleRad += off;
    if (atk.projectile) atk.projectile.angleRad += off;
  }

  /**
   * Pushes the three powerups whose effect is a *view* change rather than a
   * rule change out to where they actually happen: the invulnerability and
   * radiation-suit screen tints (CSS, `#screen-tint` — see menu.css for why
   * they're done on the composited frame instead of in the lighting), the
   * light visor's exposure lift, and the player sprite's own translucency
   * under partial invisibility. Driven off inventory state every frame rather
   * than toggled on pickup/expiry, so a level change or a restart clearing the
   * powers takes effect without needing its own teardown path.
   */
  private updatePowerEffects(): void {
    const inv = this.inventory;
    this.screenTint.classList.toggle('invulnerable', powerBlinkVisible(inv.powers.invulnerability));
    this.screenTint.classList.toggle('suited', powerBlinkVisible(inv.powers.radiationSuit));
    this.view.renderer.toneMappingExposure = hasPower(inv, 'lightVisor') ? LIGHT_VISOR_EXPOSURE : 1;
    this.playerActor.setOpacity(powerBlinkVisible(inv.powers.invisibility) ? INVISIBILITY_OPACITY : 1);
  }

  /** Decays `painFlash` (bumped in `damagePlayer`) and writes it to `painFlashEl`'s opacity — see `PAIN_FLASH_MAX_DAMAGE`'s doc for the vanilla numbers behind the fade rate. */
  private updatePainFlash(dt: number): void {
    this.painFlash = Math.max(0, this.painFlash - dt / PAIN_FLASH_FADE_SECONDS);
    this.painFlashEl.style.opacity = String(this.painFlash * PAIN_FLASH_MAX_ALPHA);
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
    // load). The fps counter below must use rawDt, not dt — using the
    // clamped value made a genuine slideshow (e.g. real frame times of
    // ~500ms, a true 2fps) under-detect itself as ~20fps, since 10 frames'
    // worth of clamped 0.05s deltas hits the accumulator's 0.5s threshold
    // long before 10 * 500ms of real time actually has.
    const rawDt = (now - this.lastTime) / 1000;
    const dt = Math.min(0.05, rawDt);
    this.lastTime = now;
    this.profiler.beginFrame();

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
      // The cursor hovering over a monster locks aim onto its actual
      // position — and height — instead of wherever the mouse's flat
      // floor-plane projection lands underneath the cursor. This has to
      // apply on hover, the same as regular mouse-aim always has
      // (player.angle is set from `aim` unconditionally below, click or
      // no), not just while the trigger is held: gating the lock to
      // mouseDown made both the player's facing and the camera's aim-lead
      // below jump the instant a click landed — which read as the camera
      // lurching backward right as you fired.
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
        }
        for (const shot of shots) {
          this.spawnShot(shot, fireStartZ, fireTarget, monster ? monster.id : null);
        }
      });

      this.profiler.time('Player', () => {
        this.things?.tryPickup(this.player, PICKUP_RANGE, (type, dropped) => {
          const taken = applyPickup(this.inventory, type, dropped);
          // The computer area map's whole effect lives outside the inventory
          // struct — see COMPUTER_MAP_TYPE's doc.
          if (taken && type === COMPUTER_MAP_TYPE) this.fogOfWar.revealAll();
          return taken;
        });
        this.updateDamageFloor(dt);
      });
    } else if (input.pressed('KeyR')) {
      this.restart();
      input.endFrame();
      requestAnimationFrame(this.frame);
      return;
    }
    camera.update(dt, { x: this.player.x, y: this.player.y, z: this.player.eyeZ }, aim);
    this.hud.update(this.inventory);
    this.updatePowerEffects();
    this.updatePainFlash(dt);

    this.profiler.time('Fog of War', () => this.fogOfWar.update(dt, this.player.x, this.player.y));
    const fog = this.fogOfWar;
    const fogAlphaOf = (subsector: number) => fog.alphaOf(subsector);
    // Monsters freeze in place while the player is dead (nothing to chase) —
    // passing null skips their AI entirely without touching pose/animation/fog
    // visibility, which keep updating normally. Every attack a still-living
    // monster fired this frame comes back for us to actually apply/render,
    // the same "system returns data, caller realizes it" split as
    // WeaponSystem.update's Shot[].
    const monsterAttacks = this.profiler.time(
      'Monsters',
      () =>
        this.things?.update(
          dt,
          camera.viewerAngleDeg,
          this.playerDead ? null : this.player,
          fogAlphaOf,
          (prev, pos) => this.monsterCrossedLines(prev, pos),
        ) ?? [],
    );
    this.profiler.time('Monsters', () => {
      for (const atk of monsterAttacks) {
        // Applied here rather than inside game/monsters.ts because whether the
        // player is currently shadowed is inventory state, which the AI has no
        // reason to know about — the same "systems report, game.ts realizes"
        // split every other attack effect on this loop follows.
        this.applyShadowAim(atk);
        // A monster with a real flying projectile (game/monsters.ts's
        // MONSTER_STATS, e.g. the imp's fireball) launches one instead of
        // resolving as an instant hit — damage lands later, on arrival
        // (updateProjectiles), not here.
        if (atk.kind === 'ranged' && atk.projectile) {
          this.spawnMonsterProjectile(atk);
        } else if (atk.kind === 'ranged') {
          // A hitscan bolt (the human gunners, the spider mastermind) traces
          // its actual flight and damages the first thing in the way, which
          // need not be what it aimed at — vanilla's P_LineAttack has no
          // species check whatsoever, so monsters really do gun each other
          // down when one walks through another's line of fire.
          this.resolveMonsterHitscan(atk);
        } else {
          // Melee lands on whatever it swung at, no trace involved.
          this.damageFromMonster(atk.targetId, atk.damage, atk.sourceId, atk.sourceType);
        }
      }
    });
    this.profiler.time('Effects', () => {
      this.teleportFogs = this.updateEffects(this.teleportFogs, dt, camera.viewerAngleDeg);
      this.updateTracers(dt);
      this.updateProjectiles(dt, camera.viewerAngleDeg);
      this.impacts = this.updateEffects(this.impacts, dt, camera.viewerAngleDeg);
    });

    this.profiler.time('Fading', () => {
      const camPos = camera.camera.position;
      const camArgs = [dt, camPos.x, -camPos.z, camPos.y] as const;
      // A wall/floor hiding a monster only fades once that monster is actually
      // alerted (ThingLayer.awakeMonsters) — an unseen sleeping monster is
      // supposed to stay hidden, same as before this list existed — and within
      // MONSTER_FADE_RANGE (see its doc for why that's a distance cap and not
      // a `hasLineOfSight` check). Monsters reuse PLAYER_HEIGHT/2 for their own
      // target height, same as hasLineOfSight does, since there's no
      // per-species height table.
      const nearby = (this.things?.awakeMonsters() ?? [])
        .map((m) => ({ m, d: Math.hypot(m.x - this.player.x, m.y - this.player.y) }))
        .filter((e) => e.d <= MONSTER_FADE_RANGE);
      // Nearest first, then capped — see MAX_FADE_TARGETS for why dropping the
      // rest costs nothing visually.
      nearby.sort((a, b) => a.d - b.d);
      const fadeTargets: FadeTarget[] = [
        { x: this.player.x, y: this.player.y, z: this.player.z + PLAYER_HEIGHT / 2 },
        ...nearby
          .slice(0, MAX_FADE_TARGETS)
          .map((e) => ({ x: e.m.x, y: e.m.y, z: e.m.z + PLAYER_HEIGHT / 2 })),
      ];
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

    this.fpsAccum += rawDt;
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
      `${this.fps} fps   ${this.built?.triangles ?? 0} tris   monsters awake ${this.things?.awakeMonsterCount() ?? 0}`,
      `pos ${this.player.x.toFixed(0)}, ${this.player.y.toFixed(0)}   z ${this.player.z.toFixed(0)}   sector ${sector}`,
      `cam ${camera.distance.toFixed(0)}u ${camera.tiltDeg.toFixed(0)}°tilt ${camera.yawDeg.toFixed(0)}°yaw`,
      '',
      'WASD move  Shift run  mouse aim/fire  1-7/wheel weapon  Q-E/drag cam  Space use',
      'N/P map  +/- zoom  [/] tilt  R restart  Esc menu',
    ].join('\n');
    this.profilerHud.update(this.profiler.samples(), this.profiler.totalMs);
  }
}
