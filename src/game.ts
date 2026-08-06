import * as THREE from 'three';
import type { Wad } from './wad/wad.ts';
import { GraphicsBank } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap, type DoomMap } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { buildMapMesh, doomToWorld, litColor, type BuiltMap } from './render/mapmesh.ts';
import { SpriteActor, SpriteAnimator, SpriteMaterialCache, VIEWER_ANGLE_DEG } from './render/sprites.ts';
import { SpriteBatch } from './render/spritebatch.ts';
import {
  BARREL_SPLASH_DAMAGE,
  BARREL_SPLASH_RADIUS,
  buildThingSprites,
  MONSTER_HIT_HEIGHT,
  type BarrelExplosion,
  type MonsterAttackEvent,
  type ThingLayer,
} from './game/things.ts';
import { MONSTER_FIRE_HEIGHT, MONSTER_STATS, sameSpecies, thrustSpeed } from './game/monsters.ts';
import { FlatFader, type FadeTarget, TextureScroller, WallFader } from './render/occlusion.ts';
import { TopDownCamera } from './render/camera.ts';
import { World, hasLineOfSight, projectileStepBlocker, shotPath } from './game/world.ts';
import { Player, PLAYER_HEIGHT, PLAYER_MASS, PLAYER_RADIUS } from './game/player.ts';
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
import { rollDamage, WeaponSystem, type Shot } from './game/weapons.ts';
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
 * Teleport-fog puff (vanilla's `MT_TFOG`): a one-shot animation, not a real
 * thing, so it lives outside `ThingLayer`. Rotation-0 only, confirmed against
 * DOOM2.WAD's lump names (TFOGA0..TFOGJ0).
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
  /** A bare `SpriteAnimator` drawn through `Game.effectBatch`, no `THREE.Object3D` of its own — same arrangement as `PosedThing`. */
  anim: SpriteAnimator;
  light: number;
  elapsed: number;
  lifetime: number;
  /**
   * Set only for the arch-vile's windup flame (`spawnVileWindupFire`,
   * vanilla's `MT_FIRE`/`A_Fire`): position is re-derived every frame from
   * this target's live position and facing rather than staying fixed. `null`
   * means the player; absent (the common case) skips this. See
   * docs/monsters.md § The arch-vile.
   */
  followTargetId?: number | null;
  /** The arch-vile that spawned this flame — `updateEffects` re-checks sight from it before repositioning (`A_Fire`'s `P_CheckSight` gate). Always set alongside `followTargetId`. */
  vileSourceId?: number;
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
/** Color of a monster's ranged-attack tracer (game/monsters.ts) — a hostile red, distinct from the player's own tracer color above. */
const MONSTER_TRACER_COLOR = 0xff4433;

/**
 * Frame letters an in-flight projectile sprite cycles through. Confirmed
 * against `DOOM2.WAD`'s actual lump names and frame/rotation counts. `MISL`
 * (rocket) is absent deliberately: only its frame A is flight art, B-D are the
 * explosion (see `IMPACT_EFFECTS`). Anything unlisted holds a single frame.
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
 * A projectile's impact explosion, keyed by its flight sprite — from
 * `linuxdoom-1.10`'s `info.c` state tables. `MANF` exploding into the
 * *rocket's* `MISL` frames is a genuine vanilla oddity, not a simplification
 * here (docs/monsters.md § Hitscan vs. projectile).
 *
 * Purely cosmetic: this plays where a shot reached `shotPath`'s distance;
 * what it actually damaged is resolved separately below.
 */
const IMPACT_EFFECTS: Record<string, { sprite: string; frames: string[] }> = {
  MISL: { sprite: 'MISL', frames: ['B', 'C', 'D'] },
  PLSS: { sprite: 'PLSE', frames: ['A', 'B', 'C', 'D', 'E'] },
  // BFE1 is the ball's own impact (above); BFE2 is a *separate* sprite for
  // resolveBfgSpray below — vanilla's MT_EXTRABFG, spawned on every monster a
  // spray ray actually hits, not on the ball's own landing spot.
  BFS1: { sprite: 'BFE1', frames: ['A', 'B', 'C', 'D', 'E', 'F'] },
  BAL1: { sprite: 'BAL1', frames: ['C', 'D', 'E'] },
  BAL2: { sprite: 'BAL2', frames: ['C', 'D', 'E'] },
  BAL7: { sprite: 'BAL7', frames: ['C', 'D', 'E'] },
  MANF: { sprite: 'MISL', frames: ['B', 'C', 'D'] },
  APLS: { sprite: 'APBX', frames: ['A', 'B', 'C', 'D', 'E'] },
  FATB: { sprite: 'FBXP', frames: ['A', 'B', 'C'] },
};

/**
 * Vanilla's `MT_EXTRABFG` (`S_BFGEXP1`-`4`) — the green burst `A_BFGSpray`
 * spawns on every monster a spray ray connects with, distinct from `BFE1`
 * above (the ball's own impact). `BFE2A0`-`D0` confirmed against `DOOM2.WAD`.
 */
const BFG_SPRAY_HIT_FRAMES = ['A', 'B', 'C', 'D'];

/**
 * The arch-vile's flame, vanilla's `MT_FIRE` (`S_FIRE1`-`S_FIRE30`) — its own
 * sprite rather than an impact effect, since `resolveVileBlast` has no flying
 * projectile to key off. `FIREA0`-`FIREH0` confirmed against `DOOM2.WAD`;
 * vanilla's 30-state loop revisits letters to flicker (`A,B,A,B,C,B,C,…`),
 * not worth reproducing exactly for a cosmetic one-shot.
 */
const VILE_FIRE_FRAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Vanilla's own 24-unit offset (`A_VileAttack`'s `FixedMul(24*FRACUNIT, ...)`) — see `resolveVileBlast`'s doc. */
const VILE_FIRE_OFFSET = 24;

/**
 * How long the windup flame tracks its target — read from the arch-vile's own
 * `startDelaySeconds` rather than duplicated, so the flame can't drift away
 * from the moment the real shot lands or fizzles.
 */
const VILE_WINDUP_TRACK_SECONDS = MONSTER_STATS[64].ranged?.startDelaySeconds ?? 0;

/**
 * The revenant missile's turn rate — vanilla's `A_Tracer` turns by `TRACEANGLE`
 * (`0xc000000`, 16.875°) every 4th tic. Converted to a continuous rate, the
 * same conversion `MonsterStats.speed` makes; a missile's turn is a smooth
 * curve either way, unlike the AI clock's cadence, where discreteness gates
 * real probability rolls.
 */
const REVENANT_TRACER_TURN_RATE_RAD = (16.875 * Math.PI) / 180 / (4 / 35);

/** `A_Tracer`'s vertical aim point, `dest->z + 40*FRACUNIT` — chest height, not the target's feet. */
const TRACER_HOMING_Z_OFFSET = 40;

/**
 * The revenant missile's trailing smoke (vanilla's `MT_SMOKE`, spawned inside
 * `A_Tracer`) — the only visible difference between a guided and an unguided
 * shot, so only shots that won the `homingBias` roll trail it. `MT_SMOKE`
 * reuses the `PUFF` sprite; frames B,C,B,C,D (`S_SMOKE1`-`5`) from `info.c`,
 * each held 4 tics, the same cadence `A_Tracer` gates the turn with. See
 * docs/monsters.md § The revenant's homing missile.
 */
const SMOKE_TRAIL_FRAMES = ['B', 'C', 'B', 'C', 'D'];
const SMOKE_TRAIL_FRAME_SECONDS = 4 / 35;
const SMOKE_TRAIL_INTERVAL = 4 / 35;

/**
 * Turns `from` toward `to` (radians) by at most `maxDelta`, the short way
 * around — the continuous equivalent of `A_Tracer`'s own clamped per-call
 * turn (see `REVENANT_TRACER_TURN_RATE_RAD`).
 */
function turnToward(from: number, to: number, maxDelta: number): number {
  const diff = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + Math.max(-maxDelta, Math.min(maxDelta, diff));
}

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

interface Projectile {
  /** Drawn through `Game.effectBatch`, same as `OneShotEffect.anim` — see that field's doc. */
  anim: SpriteAnimator;
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
  splash: { radius: number; damage: number; hitsPlayer: boolean } | null;
  /** The BFG's real A_BFGSpray secondary attack, straight from weapons.ts's WeaponDef.spray — null for every projectile but the player's own BFG ball (monsters never fire one). */
  spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number } | null;
  /** The monster this shot was locked onto *and actually reached* (spawnShot resolves that), or null — a free shot, one that missed a monster it wasn't locked onto, or a locked shot a wall cut short before the target. */
  hitMonsterId: number | null;
  /**
   * The monster that fired this, or `null` for one of the player's own shots.
   * A monster's shot re-tests arrival every frame against live positions
   * instead of resolving hit-or-miss up front the way `spawnShot` does for a
   * player's — docs/monsters.md § Monster projectiles in flight.
   */
  sourceId: number | null;
  /** The firing monster's doomednum, for `sameSpecies` — vanilla's "don't hit same species as originator" rule on projectiles. */
  sourceType: number;
  /**
   * The wall `shotPath` found blocking this flight at launch, or null. Carried
   * through so a shoot-triggered special fires on *arrival*, not on launch —
   * vanilla runs `P_ShootSpecialLine` from `PIT_CheckLine` when the missile
   * reaches the line. Only matters for the flying-sprite case; a hitscan
   * pellet triggers immediately in `spawnShot`. See docs/combat.md §
   * Shoot-triggered specials.
   */
  lineIndex: number | null;
  /**
   * Present only for the revenant's missile (`MT_TRACER`/`A_Tracer`), whose
   * path isn't the fixed origin+angle+distance line every other projectile
   * flies, so it carries its own live position/heading. `targetId` is `null`
   * for the player, matching `MonsterAttackEvent.targetId`. A `homing` object
   * existing at all means this shot won its `homingBias` roll, which is why
   * `smokeTimer` can pace the trail unconditionally. See docs/monsters.md §
   * The revenant's homing missile.
   */
  homing?: { targetId: number | null; x: number; y: number; z: number; headingRad: number; smokeTimer: number };
}

/**
 * Slack added to the player's radius when testing a monster's hitscan bolt,
 * which is fired along a stale facing here — docs/monsters.md § Hitscan vs.
 * projectile.
 */
const MONSTER_BULLET_SLOP = 12;

/** How close a monster projectile has to get to the player's live position before it's treated as a hit — see `Projectile.sourceId`'s doc. */
const MONSTER_PROJECTILE_HIT_RADIUS = PLAYER_RADIUS + 24;
/** Vertical companion to `MONSTER_PROJECTILE_HIT_RADIUS` — the same overhead/underneath tolerance `ThingLayer.tryPickup`'s own gate already uses for picking an item up through a window onto a floor above/below. */
const MONSTER_PROJECTILE_HIT_HEIGHT = 128;

/**
 * How far an awake monster can be and still count as an occlusion-fade target.
 * **Tuned by feel** to roughly a room's length, not converted from vanilla.
 * Deliberately a plain distance cap rather than a `hasLineOfSight` gate, which
 * would make the fade a no-op for the case it exists for — docs/render.md §
 * Wall occlusion fading.
 */
const MONSTER_FADE_RANGE = 768;

/**
 * Most awake monsters that can be fade targets at once, nearest first. Purely
 * a cost bound (`WallFader` cost is quads × targets): past a couple of dozen
 * nearby monsters, every wall any of them stands behind is already faded by a
 * nearer one. See docs/monsters.md § Spatial indexing.
 */
const MAX_FADE_TARGETS = 48;

/**
 * How solid the player sprite draws under partial invisibility. Vanilla's
 * `fuzz` colormap is a software-renderer trick with no equivalent here; plain
 * translucency is the stand-in (docs/items.md § Powerups and the backpack).
 */
const INVISIBILITY_OPACITY = 0.35;

/**
 * `toneMappingExposure` while the light visor is held — a flat multiply, as
 * close as this gets to vanilla forcing the brightest colormap row without
 * rebuilding every surface's baked vertex lighting (docs/items.md § Powerups and the backpack).
 */
const LIGHT_VISOR_EXPOSURE = 2.5;

/**
 * Vanilla's `A_FaceTarget`: aiming at an `MF_SHADOW` thing (here only ever the
 * player under partial invisibility) throws the facing off by
 * `(P_Random()-P_Random())<<21` BAM, ±255/2048 of a full turn. That is the
 * entire blur-sphere mechanic — it never touches sight or waking.
 */
const SHADOW_AIM_SPREAD_DEG = (255 / 2048) * 360;

/**
 * The red damage flash, echoing `ST_doPaletteStuff`'s `damagecount`: raw damage
 * into a counter clamped to 100, ticked down 1/tic. `MAX_DAMAGE` is that clamp
 * and `FADE_SECONDS` is 100 tics over 35. `MAX_ALPHA` has no vanilla analogue
 * (there it's a palette swap, not an overlay) and is **tuned by feel**.
 */
const PAIN_FLASH_MAX_DAMAGE = 100;
const PAIN_FLASH_FADE_SECONDS = 100 / 35;
const PAIN_FLASH_MAX_ALPHA = 0.5;

/**
 * When a timed powerup's screen effect starts blinking as an expiry warning,
 * and how fast. **Tuned by feel** — vanilla blinks a HUD number (`cnt & 8` in
 * `ST_Ticker`), not a screen effect. See docs/items.md § Screen effects.
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
  /**
   * Every non-map-thing sprite this class draws — projectiles in flight,
   * impact explosions, teleport-fog puffs, the revenant's smoke trail, the
   * arch-vile's windup flame — batched into one `InstancedMesh` per lump, the
   * same machinery `game/things.ts` draws map things with. One `SpriteActor`
   * each hits a draw-call wall once homing missiles trail smoke at scale; see
   * docs/combat.md § Effects and their batching.
   *
   * The player is deliberately *not* in here: it's one sprite, and it needs
   * `SpriteActor.setOpacity` (partial invisibility), which has no per-instance
   * equivalent in a batch.
   */
  private effectBatch = new SpriteBatch();
  /** Scratch for `doomToWorld`, reused across every batched sprite — same reason `game/things.ts` keeps one. */
  private batchPos = new THREE.Vector3();
  private weaponSystem = new WeaponSystem();
  private tracers: Tracer[] = [];
  private projectiles: Projectile[] = [];
  /**
   * Set by the exit trigger and consumed right after `specials.update()`
   * returns in `frame` — **never** loaded from inside the callback itself.
   * `handleWalkTriggers` runs partway through that `update()`, and a mover
   * ticked dirty earlier in the same call is only rebuilt afterwards; tearing
   * the scene down synchronously would leave that pending rebuild to `add` the
   * old map's mover mesh to the new map's scene, with nothing to clean it up.
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
    this.scene.add(this.effectBatch.group);

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
    // a teleporter onto an exit line) would otherwise keep animating over the
    // new level. Dropping the list is the whole of it now that these are
    // batched (`effectBatch`) rather than owning a mesh each: nothing is added
    // to the batch for an effect that isn't in one of these lists.
    this.teleportFogs = [];
    this.impacts = [];
    // Same reasoning for a tracer/projectile still in flight when the map changes.
    for (const t of this.tracers) {
      this.scene.remove(t.line);
      t.dispose();
    }
    this.tracers = [];
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
      (sectorIndex, ceilingHeight) => this.blocksCeilingLower(sectorIndex, ceilingHeight),
      (sectorIndex, floorHeight) => this.blocksFloorRise(sectorIndex, floorHeight),
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
    // Both sprite batches' instance buffers and cloned materials are their
    // own; the geometry/textures behind them are spriteMaterials'.
    this.things?.dispose();
    this.effectBatch.dispose();
    this.materials.dispose();
    this.spriteMaterials.dispose();
  }

  /**
   * Spawns a one-shot sprite animation (teleport fog, impact explosion, smoke
   * puff) and returns it, or null if the sprite has no art — checked here,
   * once, by resolving the first frame, so `updateEffects` never has to carry
   * a "this one turned out to have no lump" case through every frame.
   */
  private spawnEffect(sprite: string, frames: string[], frameSeconds: number, at: Pos3): OneShotEffect | null {
    const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, sprite, frames, frameSeconds);
    if (!anim.resolve(0, VIEWER_ANGLE_DEG)) return null;
    const light = this.world.sectorAt(at.x, at.y)?.light ?? 128;
    return { anim, x: at.x, y: at.y, z: at.z, light, elapsed: 0, lifetime: frames.length * frameSeconds };
  }

  /** Queues one already-advanced sprite into `effectBatch` at a DOOM-space point. */
  private batchSprite(anim: SpriteAnimator, at: Pos3, facingDeg: number, light: number, viewerAngleDeg: number): void {
    const cached = anim.resolve(facingDeg, viewerAngleDeg);
    if (!cached) return;
    doomToWorld(at.x, at.y, at.z, this.batchPos);
    this.effectBatch.add(cached, this.batchPos.x, this.batchPos.y, this.batchPos.z, 1, litColor(light), 0);
  }

  /** Advances a one-shot effect list in place and drops the ones that finished, matching every other list's remaining-array pattern here. */
  private updateEffects(list: OneShotEffect[], dt: number, viewerAngleDeg: number): OneShotEffect[] {
    if (list.length === 0) return list;
    const remaining: OneShotEffect[] = [];
    for (const e of list) {
      e.elapsed += dt;
      if (e.elapsed >= e.lifetime) continue;
      if (e.followTargetId !== undefined && e.vileSourceId !== undefined) {
        const vile = this.things?.monsterById(e.vileSourceId);
        const target = e.followTargetId === null ? this.player : this.things?.monsterById(e.followTargetId);
        // Vanilla's own A_Fire: "don't move it if the vile lost sight" — a
        // broken sightline (or a dead/stale vile or target) just leaves the
        // flame exactly where it last was, matching A_Fire's early return,
        // rather than hiding it or popping it early. It's about to expire on
        // its own anyway if the shot fizzles (see spawnVileWindupFire).
        if (vile && target && hasLineOfSight(this.world, vile, target)) {
          const front = this.vileFireFrontOf(target);
          e.x = front.x;
          e.y = front.y;
          e.z = front.z;
        }
      }
      e.anim.advance(dt, true);
      this.batchSprite(e.anim, e, 0, e.light, viewerAngleDeg);
      remaining.push(e);
    }
    return remaining;
  }

  private spawnTeleportFog(at: Pos3): void {
    const effect = this.spawnEffect('TFOG', TFOG_FRAMES, TFOG_FRAME_SECONDS, at);
    if (effect) this.teleportFogs.push(effect);
  }

  /**
   * Turns one fired `Shot` (game/weapons.ts) into a tracer line or a flying
   * projectile sprite. Always starts at the player's own fire height, and
   * slopes toward a locked-on monster's height rather than flying flat past
   * it; `shotPath` resolves where it actually gets to.
   *
   * Hit-or-miss on `targetId` is settled **here**, not on arrival: comparing
   * `shotPath`'s blocked distance against the target's says whether it got
   * there. A hitscan pellet's damage applies immediately; a projectile's
   * carries through to `updateProjectiles` and applies when the sprite
   * arrives. See docs/combat.md § How a shot deals damage.
   */
  private spawnShot(shot: Shot, startZ: number, target: Pos3 | null, targetId: number | null): void {
    const origin: Pos3 = { x: this.player.x, y: this.player.y, z: startZ };

    // A swing never travels, so it skips shotPath entirely — vanilla's
    // A_Punch/A_Saw just trace MELEERANGE along the facing. Aim already points
    // at a hovered monster, so the ray finds a locked-on target with no
    // separate case, and can't reach one past the swing's own range.
    if (shot.kind === 'melee') {
      const swung = this.things?.raycastMonster(origin, shot.angleRad, shot.range) ?? null;
      if (swung) this.things?.damage(swung.id, shot.damage, undefined, undefined, origin.x, origin.y);
      return;
    }

    const path = shotPath(this.world, origin, shot.angleRad, target);

    let hitMonsterId: number | null = null;
    let endX = path.x;
    let endY = path.y;
    let endDist = path.dist;

    if (target !== null && targetId !== null) {
      // A locked shot connects only if nothing stopped it short of the target.
      const wantDist = Math.hypot(target.x - origin.x, target.y - origin.y);
      if (path.dist >= wantDist - 1) hitMonsterId = targetId;
    } else {
      // No locked target: still test the path against every monster's body, so
      // one standing between the player and the wall they're shooting at isn't
      // invisible to the shot. Only ever shortens it, never past `path.dist`.
      const monsterHit = this.things?.raycastMonster(origin, shot.angleRad, path.dist) ?? null;
      if (monsterHit) {
        hitMonsterId = monsterHit.id;
        endX = monsterHit.x;
        endY = monsterHit.y;
        endDist = monsterHit.dist;
      }
    }

    // A shoot-triggered special only fires if the shot reached the wall rather
    // than being absorbed by a monster first. A hitscan pellet resolves this
    // frame so it fires here; a projectile's is deferred to arrival (see
    // `Projectile.lineIndex`).
    if (shot.kind === 'hitscan') {
      if (hitMonsterId !== null) this.things?.damage(hitMonsterId, shot.damage, undefined, undefined, origin.x, origin.y);
      else this.specials?.triggerShot(path.lineIndex, this.inventory.keys);
      const tracer = new Tracer(origin, { x: endX, y: endY, z: path.z }, TRACER_COLOR);
      this.scene.add(tracer.line);
      this.tracers.push(tracer);
      return;
    }

    const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, shot.sprite, PROJECTILE_FRAMES[shot.sprite]);
    const light = this.world.sectorAt(origin.x, origin.y)?.light ?? 128;
    if (!anim.resolve((shot.angleRad * 180) / Math.PI, VIEWER_ANGLE_DEG)) return;
    this.projectiles.push({
      anim,
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
      spray: shot.spray,
      hitMonsterId,
      sourceId: null,
      sourceType: 0,
      lineIndex: hitMonsterId === null ? path.lineIndex : null,
    });
  }

  /**
   * Turns a monster's fired ranged `MonsterAttackEvent` into a flying
   * `Projectile`. `atk.targetId` is the player when `null`, another monster
   * (an infight) otherwise, resolved live rather than trusted from when the
   * attack started — a shot with real flight time shouldn't aim at where its
   * target *used to be*.
   *
   * Launched via `shotPath` like a player's locked-on shot, but with
   * `lockedOn: false`: a monster has no auto-aim leniency to justify its
   * fireball clearing a step it shouldn't. And unlike a player's shot the
   * flight doesn't resolve hit-or-miss up front — see docs/monsters.md §
   * Monster projectiles in flight.
   */
  private spawnMonsterProjectile(atk: MonsterAttackEvent): void {
    if (!atk.projectiles) return;
    const victim = atk.targetId === null ? null : this.things?.monsterById(atk.targetId);
    const target = victim
      ? { x: victim.x, y: victim.y, z: victim.z + MONSTER_FIRE_HEIGHT }
      : { x: this.player.x, y: this.player.y, z: this.player.z + AIM_HEIGHT_OFFSET };
    const light = this.world.sectorAt(atk.x, atk.y)?.light ?? 128;
    // Almost always one entry; the mancubus fires two per volley (see
    // MonsterAttack.projectiles's doc) — each resolved and spawned
    // independently, since a fanned-out fireball flies its own path and can
    // miss on its own.
    for (const proj of atk.projectiles) {
      const path = shotPath(this.world, atk, proj.angleRad, target, false);
      const anim = new SpriteAnimator(this.spriteBank, this.spriteMaterials, proj.sprite, PROJECTILE_FRAMES[proj.sprite]);
      if (!anim.resolve((proj.angleRad * 180) / Math.PI, VIEWER_ANGLE_DEG)) continue;
      this.projectiles.push({
        anim,
        originX: atk.x,
        originY: atk.y,
        startZ: atk.z,
        endZ: path.z,
        angleRad: proj.angleRad,
        speed: proj.speed,
        maxDist: path.dist,
        traveled: 0,
        light,
        sprite: proj.sprite,
        damage: atk.damage,
        splash: proj.splash ? { radius: proj.splash.radius, damage: proj.splash.damage, hitsPlayer: true } : null,
        spray: null,
        hitMonsterId: null,
        sourceId: atk.sourceId,
        sourceType: atk.sourceType,
        lineIndex: path.lineIndex,
        homing: proj.homing
          ? { targetId: atk.targetId, x: atk.x, y: atk.y, z: atk.z, headingRad: proj.angleRad, smokeTimer: 0 }
          : undefined,
      });
    }
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
      this.damagePlayer(atk.damage, atk.x, atk.y);
      this.player.launchUpward(atk.blast.knockUpSpeed);
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
    const offset = this.vileFireOffset(atk, at);
    const fireAt = { x: at.x + offset.x, y: at.y + offset.y, z: at.z };
    this.applyRadiusDamage(fireAt, atk.blast.splashRadius, atk.blast.splashDamage, true, {
      id: atk.sourceId,
      type: atk.sourceType,
    });
    const effect = this.spawnEffect('FIRE', VILE_FIRE_FRAMES, IMPACT_FRAME_SECONDS, fireAt);
    if (effect) this.impacts.push(effect);
  }

  /**
   * The arch-vile's warning flame, spawned when its windup starts — vanilla's
   * `MT_FIRE`, which tracks the target for the whole ~1.9s and is what the
   * player reacts to. Reuses `spawnEffect` but overrides the lifetime to the
   * windup's own length, so `resolveVileBlast`'s burst (or nothing, if the
   * shot fizzles) takes over as this runs out with no explicit hand-off.
   * Positioned up front for the reason `A_VileTarget` calls `A_Fire`
   * immediately after spawning: the raw spawn point is never seen uncorrected.
   */
  private spawnVileWindupFire(atk: MonsterAttackEvent): void {
    const target = atk.targetId === null ? this.player : this.things?.monsterById(atk.targetId);
    if (!target) return;
    const effect = this.spawnEffect('FIRE', VILE_FIRE_FRAMES, IMPACT_FRAME_SECONDS, this.vileFireFrontOf(target));
    if (!effect) return;
    effect.lifetime = VILE_WINDUP_TRACK_SECONDS;
    effect.followTargetId = atk.targetId;
    effect.vileSourceId = atk.sourceId;
    this.impacts.push(effect);
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
    } else if (playerInPath) {
      this.damagePlayer(atk.damage, atk.x, atk.y);
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
   * What a still-flying monster projectile has just run into, or null if it
   * hit nothing this frame. A non-null result always ends the flight; `id` is
   * who takes the direct damage, or **null for a same-species body that stops
   * the missile without being hurt by it** — `PIT_CheckThing`'s "explode, but
   * do no damage", a stop and not a pass-through. Only the direct hit is
   * skipped in that case: `updateProjectiles` applies `p.splash` regardless,
   * as `P_ExplodeMissile` runs the death state either way.
   *
   * Candidates resolve **nearest first**, since with the fizzle case in play
   * that decides between two very different outcomes. See docs/monsters.md §
   * Infighting.
   */
  private monsterStruckBy(p: Projectile, at: Pos3): { id: number | null } | null {
    if (p.sourceId === null) return null;
    let nearest: { id: number | null } | null = null;
    let nearestSq = Infinity;
    for (const m of this.things?.monstersNear(at, MONSTER_PROJECTILE_HIT_RADIUS) ?? []) {
      // Vanilla's `thing == tmthing->target`: a missile never collides with
      // whoever fired it, so it can leave its own shooter's body.
      if (m.id === p.sourceId) continue;
      // Vanilla's own "see if it went over / under" test, which really is a
      // pass-through — the missile is simply at the wrong height.
      if (Math.abs(m.z - at.z) > MONSTER_PROJECTILE_HIT_HEIGHT) continue;
      const dSq = (m.x - at.x) ** 2 + (m.y - at.y) ** 2;
      if (dSq >= nearestSq) continue;
      // Same wall check `reachedPlayer` needs, and for the same reason — see
      // its comment. Traced from the monster for the same `SELF_HIT_MARGIN`
      // reason, and last so it only runs on an already-close candidate.
      if (!hasLineOfSight(this.world, m, at)) continue;
      nearestSq = dSq;
      nearest = { id: sameSpecies(p.sourceType, m.type) ? null : m.id };
    }
    return nearest;
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
   * Advances every in-flight projectile along the fixed straight line
   * `spawnShot` resolved for it — sloped from `startZ` to `endZ` so an
   * auto-aimed shot visibly rises or dips — and, on reaching `maxDist`,
   * removes it and plays its `IMPACT_EFFECTS` explosion in place. Arriving
   * isn't itself a hit (`p.hitMonsterId` carries that answer), but the impact
   * point applies `p.splash` either way, as a rocket bursting on a bare wall
   * does in vanilla.
   *
   * A monster's own shot instead has two live arrival tests re-checked every
   * frame — the player's current position, and any other monster it passes —
   * so stepping behind cover or outrunning a slow fireball works. See
   * docs/monsters.md § Monster projectiles in flight.
   */
  private updateProjectiles(dt: number, viewerAngleDeg: number): void {
    if (this.projectiles.length === 0) return;
    const remaining: Projectile[] = [];
    for (const p of this.projectiles) {
      let at: Pos3;
      if (p.homing) {
        at = this.advanceHomingProjectile(p, dt);
      } else {
        p.traveled += p.speed * dt;
        const clamped = Math.min(p.traveled, p.maxDist);
        const frac = p.maxDist > 0 ? clamped / p.maxDist : 1;
        at = {
          x: p.originX + Math.cos(p.angleRad) * clamped,
          y: p.originY + Math.sin(p.angleRad) * clamped,
          z: p.startZ + (p.endZ - p.startZ) * frac,
        };
      }

      // A monster's shot re-tests what it has reached every frame (see
      // Projectile.sourceId); a player's already knows.
      const fromMonster = p.sourceId !== null;
      const reachedPlayer =
        fromMonster &&
        !this.playerDead &&
        Math.hypot(this.player.x - at.x, this.player.y - at.y) <= MONSTER_PROJECTILE_HIT_RADIUS &&
        Math.abs(this.player.z - at.z) <= MONSTER_PROJECTILE_HIT_HEIGHT &&
        // Proximity alone isn't arrival: the hit radius is a fat 2D disc, so a
        // projectile stopping against a wall (its `maxDist`) would otherwise
        // damage anyone standing within it on the *far* side of that wall,
        // dealing a full direct hit through it. Traced from the player
        // rather than from `at` deliberately: `at` sits essentially *on*
        // the wall by then, and `hasLineOfSight`'s own
        // `SELF_HIT_MARGIN` would skip that crossing as a self-hit and report
        // the wall it just stopped against as clear. Last in the chain so it
        // only ever runs once the (cheap) proximity tests already passed.
        hasLineOfSight(this.world, this.player, at);
      const struck = fromMonster && !reachedPlayer ? this.monsterStruckBy(p, at) : null;

      if (reachedPlayer || struck || p.traveled >= p.maxDist) {
        if (fromMonster) {
          if (reachedPlayer) this.damagePlayer(p.damage, at.x, at.y);
          // `struck.id === null` is the same-species fizzle: the body stopped
          // the missile but takes no damage from it (see monsterStruckBy).
          else if (struck) {
            if (struck.id !== null)
              this.things?.damage(struck.id, p.damage, { id: p.sourceId!, type: p.sourceType }, undefined, at.x, at.y);
          }
          // A clean miss (reached maxDist without hitting a body) means it
          // arrived at whatever wall shotPath found at launch — fire its
          // shoot special now, at actual arrival, not back when it launched.
          else this.specials?.triggerShot(p.lineIndex, this.inventory.keys, true);
        } else if (p.hitMonsterId !== null) {
          this.things?.damage(p.hitMonsterId, p.damage, undefined, undefined, at.x, at.y);
        } else {
          this.specials?.triggerShot(p.lineIndex, this.inventory.keys);
        }
        if (p.splash) {
          // Attributed to the firing monster (if any), the same as a direct
          // hit already is — a cyberdemon's own rocket splash should start
          // an infight exactly like one of its direct hits would.
          this.applyRadiusDamage(
            at,
            p.splash.radius,
            p.splash.damage,
            p.splash.hitsPlayer,
            fromMonster ? { id: p.sourceId!, type: p.sourceType } : undefined,
          );
        }
        // Only ever set for the player's own BFG ball (spawnMonsterProjectile
        // always passes spray: null) — see resolveBfgSpray's doc.
        if (p.spray) this.resolveBfgSpray(p.angleRad, p.spray);
        const impact = IMPACT_EFFECTS[p.sprite];
        if (impact) {
          const effect = this.spawnEffect(impact.sprite, impact.frames, IMPACT_FRAME_SECONDS, at);
          if (effect) this.impacts.push(effect);
        }
        continue;
      }
      // A homing missile's sprite tracks its live, turning heading rather
      // than the fixed launch angle every other projectile keeps.
      const poseAngleRad = p.homing?.headingRad ?? p.angleRad;
      p.anim.advance(dt, true);
      this.batchSprite(p.anim, at, (poseAngleRad * 180) / Math.PI, p.light, viewerAngleDeg);
      remaining.push(p);
    }
    this.projectiles = remaining;
  }

  /**
   * One frame of the revenant's `A_Tracer` homing (`Projectile.homing`): turns
   * `headingRad` toward the target's current bearing by at most
   * `REVENANT_TRACER_TURN_RATE_RAD * dt` and integrates position from the new
   * heading, instead of the fixed straight-line formula every other projectile
   * uses. Height eases toward `TRACER_HOMING_Z_OFFSET` above the target's feet
   * over the remaining distance — the continuous form of vanilla's `momz`
   * spring. A missing or dead target leaves the missile on its last heading,
   * matching `A_Tracer`'s own early return.
   *
   * **A homing missile has no flight-distance budget** — it curves away from
   * the launch ray, so `shotPath`'s `maxDist` says nothing about where it ends
   * up. Each step is checked against the geometry it actually crossed
   * (`projectileStepBlocker`) instead, and forcing `p.traveled` to `p.maxDist`
   * is how this signals arrival to `updateProjectiles` — the only thing that
   * ends a homing flight short of a body. Also spawns the smoke trail every
   * `SMOKE_TRAIL_INTERVAL`. See docs/monsters.md § The revenant's homing
   * missile.
   */
  private advanceHomingProjectile(p: Projectile, dt: number): Pos3 {
    const homing = p.homing!;
    const step = p.speed * dt;
    const target: Pos3 | null =
      homing.targetId === null ? (this.playerDead ? null : this.player) : this.things?.monsterById(homing.targetId) ?? null;
    if (target) {
      const bearing = Math.atan2(target.y - homing.y, target.x - homing.x);
      homing.headingRad = turnToward(homing.headingRad, bearing, REVENANT_TRACER_TURN_RATE_RAD * dt);
      // Paced by the live distance still to cover, not by what's left of a
      // launch-time budget this flight no longer has (see this method's
      // doc) — which is also what vanilla's own `A_Tracer` momz spring uses
      // (`P_AproxDistance(dest - actor) / speed`), so it stays correct for a
      // missile that has curved right past its target and is coming back.
      const remaining = Math.max(Math.hypot(target.x - homing.x, target.y - homing.y), step);
      homing.z += (target.z + TRACER_HOMING_Z_OFFSET - homing.z) * Math.min(1, step / remaining);
    }
    const fromX = homing.x;
    const fromY = homing.y;
    const fromZ = homing.z;
    homing.x += Math.cos(homing.headingRad) * step;
    homing.y += Math.sin(homing.headingRad) * step;
    const wall = projectileStepBlocker(
      this.world,
      { x: fromX, y: fromY, z: fromZ },
      { x: homing.x, y: homing.y, z: homing.z },
    );
    if (wall) {
      homing.x = wall.x;
      homing.y = wall.y;
      homing.z = wall.z;
      p.lineIndex = wall.lineIndex;
      p.traveled = p.maxDist;
      return { x: homing.x, y: homing.y, z: homing.z };
    }
    // One sector lookup rather than floorAt + ceilingAt, which are two
    // wrappers around the same BSP walk — this runs per missile per frame,
    // and a crowded map can have thousands of them in the air.
    const sector = this.world.sectorAt(homing.x, homing.y);
    if (sector && homing.z <= sector.floorHeight) {
      homing.z = sector.floorHeight;
      p.traveled = p.maxDist;
    } else if (sector && homing.z >= sector.ceilHeight) {
      homing.z = sector.ceilHeight;
      p.traveled = p.maxDist;
    }
    // The smoke trail — see SMOKE_TRAIL_INTERVAL's doc for why this only
    // ever runs for a shot that already won the homingBias roll.
    homing.smokeTimer += dt;
    if (homing.smokeTimer >= SMOKE_TRAIL_INTERVAL) {
      homing.smokeTimer -= SMOKE_TRAIL_INTERVAL;
      const puff = this.spawnEffect('PUFF', SMOKE_TRAIL_FRAMES, SMOKE_TRAIL_FRAME_SECONDS, {
        x: homing.x,
        y: homing.y,
        z: homing.z,
      });
      if (puff) this.impacts.push(puff);
    }
    return { x: homing.x, y: homing.y, z: homing.z };
  }

  /**
   * An explosion's blast — vanilla's `P_RadiusAttack`: every living monster
   * within `radius` with an unobstructed line to the impact point takes damage
   * falling off linearly to 0 at the edge. `hitsPlayer` gates self-splash
   * ("rocket jump"). **2D distance only, no height check** — vanilla ignores z
   * entirely here and leans on line-of-sight alone to decide whether a floor
   * above or below the blast is protected.
   *
   * `source`, when given, attributes the hit for `ThingLayer.damage`'s
   * retaliation/infighting rule the same way a direct hit does. See
   * docs/combat.md § Splash and the BFG.
   */
  private applyRadiusDamage(
    at: Pos3,
    radius: number,
    maxDamage: number,
    hitsPlayer: boolean,
    source?: { id: number; type: number },
  ): void {
    for (const m of this.things?.monstersNear(at, radius) ?? []) {
      // Vanilla's PIT_RadiusAttack: the spider mastermind and cyberdemon take
      // no concussion/splash damage at all, direct hits only.
      if (m.type === 7 || m.type === 16) continue;
      const dist = Math.hypot(m.x - at.x, m.y - at.y);
      if (dist >= radius || !hasLineOfSight(this.world, at, m)) continue;
      this.things?.damage(m.id, maxDamage * (1 - dist / radius), source, undefined, at.x, at.y);
    }

    if (!hitsPlayer) return;
    const pdist = Math.hypot(this.player.x - at.x, this.player.y - at.y);
    if (pdist < radius && hasLineOfSight(this.world, at, this.player)) {
      this.damagePlayer(maxDamage * (1 - pdist / radius), at.x, at.y);
    }
  }

  /**
   * A barrel's `A_Explode` — vanilla's literal `P_RadiusAttack(thingy,
   * thingy->target, 128)`, the same shape as the rocket's splash with
   * `exp.source` standing in for `thingy->target`. Barrels are in
   * `monstersNear`, so a second one caught in the blast chains through the
   * ordinary damage path (docs/combat.md § Exploding barrels).
   */
  private applyBarrelExplosion(exp: BarrelExplosion): void {
    this.applyRadiusDamage(exp, BARREL_SPLASH_RADIUS, BARREL_SPLASH_DAMAGE, true, exp.source);
  }

  /**
   * Vanilla's `A_BFGSpray`, fired once when the player's BFG ball arrives.
   * `travelAngleRad` is the ball's fixed flight angle (`mo->angle`), not the
   * aim angle at impact, and the rays trace from the player's **current**
   * position rather than the impact point — that's what `mo->target` is by the
   * time the slow ball lands, and the distinction is load-bearing.
   *
   * Each ray is an independent trace dealing a full, undiminished hit: no
   * falloff, and no dedupe against a body several rays already caught, since
   * `P_DamageMobj` is called once per connecting ray. Each also spawns an
   * `MT_EXTRABFG` burst. No-op once the player is dead. See docs/combat.md §
   * Splash and the BFG.
   */
  private resolveBfgSpray(
    travelAngleRad: number,
    spray: { rays: number; arcDeg: number; range: number; diceRolls: number; diceSides: number },
  ): void {
    if (this.playerDead) return;
    const origin: Pos3 = { x: this.player.x, y: this.player.y, z: this.player.z + AIM_HEIGHT_OFFSET };
    const arcRad = (spray.arcDeg * Math.PI) / 180;
    const startRad = travelAngleRad - arcRad / 2;
    const stepRad = spray.rays > 1 ? arcRad / spray.rays : 0;
    for (let i = 0; i < spray.rays; i++) {
      const hit = this.things?.raycastMonster(origin, startRad + stepRad * i, spray.range) ?? null;
      if (!hit) continue;
      let damage = 0;
      for (let j = 0; j < spray.diceRolls; j++) damage += rollDamage(spray.diceSides, 1);
      // Vanilla's inflictor is the ball itself, by then far from the player;
      // this engine doesn't track where it stopped, so `origin` stands in.
      this.things?.damage(hit.id, damage, undefined, undefined, origin.x, origin.y);
      // MT_EXTRABFG spawns at `linetarget->height>>2`; with no per-species
      // height table, `MONSTER_FIRE_HEIGHT` is the same stand-in used elsewhere.
      const effect = this.spawnEffect('BFE2', BFG_SPRAY_HIT_FRAMES, IMPACT_FRAME_SECONDS, {
        x: hit.x,
        y: hit.y,
        z: hit.z + MONSTER_FIRE_HEIGHT,
      });
      if (effect) this.impacts.push(effect);
    }
  }

  /**
   * Applies armor-mitigated damage (`applyDamage`) to the player, transitioning to the death
   * animation once health hits 0. A no-op once already dead, or once `applyDamage` reports
   * invulnerability blocked the hit outright — no double death, and no pain flash/flinch for a
   * hit that did nothing.
   *
   * `fromX`/`fromY`, when both given, are where the damage physically came from — same meaning
   * and same omitted-for-damage-floors-and-crushers convention as `ThingLayer.damage`'s own
   * params — and drive vanilla's `P_DamageMobj` horizontal knockback (`thrustSpeed`, `PLAYER_MASS`)
   * via `Player.applyKnockback`.
   */
  private damagePlayer(amount: number, fromX?: number, fromY?: number): void {
    if (this.playerDead || amount <= 0 || !applyDamage(this.inventory, amount)) return;
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
   * `SpecialsController`'s `onCrush` callback: it owns the moving geometry but
   * has no idea who's standing in it, so it hands back a sector index. 2D
   * membership only, like `applyRadiusDamage` — see docs/specials.md §
   * Crushers.
   */
  private applyCrushDamage(sectorIndex: number): void {
    if (this.world.sectorIndexAt(this.player.x, this.player.y) === sectorIndex) this.damagePlayer(CRUSH_DAMAGE);
    const sector = this.map.sectors[sectorIndex];
    for (const m of this.things?.monstersInSector(sector) ?? []) this.things?.damage(m.id, CRUSH_DAMAGE);
  }

  /**
   * Whether a `radius`-circle at (x, y) overlaps `sectorIndex` at all, not
   * just whichever sector its bare center point resolves to — a rim-sample
   * ring, the same approximation `FogOfWar` uses. A plain point test misses
   * the player standing half in a doorway; see docs/specials.md § Every other
   * mover stops instead.
   */
  private circleOverlapsSector(x: number, y: number, radius: number, sectorIndex: number): boolean {
    if (this.world.sectorIndexAt(x, y) === sectorIndex) return true;
    const RIM_SAMPLES = 8;
    for (let i = 0; i < RIM_SAMPLES; i++) {
      const angle = (i / RIM_SAMPLES) * Math.PI * 2;
      const sx = x + Math.cos(angle) * radius;
      const sy = y + Math.sin(angle) * radius;
      if (this.world.sectorIndexAt(sx, sy) === sectorIndex) return true;
    }
    return false;
  }

  /**
   * `SpecialsController`'s shared obstruction test, vanilla's
   * `T_MovePlane`/`PIT_ChangeSector` "un-crush" rule: whoever's standing in
   * `sectorIndex` doesn't fit in the vertical gap a mover's next step would
   * leave. A flat headroom test against `PLAYER_HEIGHT`/`MONSTER_HIT_HEIGHT`,
   * this engine having no per-thing floor/ceiling clip to do better with. See
   * docs/specials.md § Every other mover stops instead for why membership goes
   * through `circleOverlapsSector` and why the heights are parameters.
   */
  private headroomBlocked(sectorIndex: number, floorHeight: number, ceilingHeight: number): boolean {
    if (
      this.circleOverlapsSector(this.player.x, this.player.y, PLAYER_RADIUS, sectorIndex) &&
      floorHeight + PLAYER_HEIGHT > ceilingHeight
    ) {
      return true;
    }
    // The gap check doesn't depend on which monster it is (unlike the old
    // per-thing `m.z` version), so one monster in the sector is enough to
    // decide it for all of them — no need to loop.
    if (floorHeight + MONSTER_HIT_HEIGHT <= ceilingHeight) return false;
    const sector = this.map.sectors[sectorIndex];
    return (this.things?.monstersInSector(sector).length ?? 0) > 0;
  }

  /** A closing door or a lowering `CeilingMover` — `SpecialsController.blocksCeilingLower`. The sector's floor doesn't move here, so `headroomBlocked` reads it straight off the map. */
  private blocksCeilingLower(sectorIndex: number, ceilingHeight: number): boolean {
    return this.headroomBlocked(sectorIndex, this.map.sectors[sectorIndex].floorHeight, ceilingHeight);
  }

  /** A rising lift or non-crushing `FloorMover` — `SpecialsController.blocksFloorRise`. The sector's ceiling doesn't move here, so `headroomBlocked` reads it straight off the map. */
  private blocksFloorRise(sectorIndex: number, floorHeight: number): boolean {
    return this.headroomBlocked(sectorIndex, floorHeight, this.map.sectors[sectorIndex].ceilHeight);
  }

  /**
   * Vanilla's `P_PlayerInSpecialSector`, run directly here rather than through
   * `SpecialsController` — a damage floor has no mover, just `sector.special`
   * and the player's position. Player-only, matching vanilla. Gated on
   * `player.z === sector.floorHeight` (vanilla's `mo->z != floorheight`), read
   * off the local sector rather than `World.groundFloor`; see docs/specials.md
   * § Damage floors.
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

  /**
   * Pushes the powerups whose effect is a *view* change out to where they
   * happen: the two screen tints (CSS `#screen-tint`), the light visor's
   * exposure lift, the player sprite's translucency. Driven off inventory
   * state every frame rather than toggled on pickup/expiry, so a level change
   * or restart clearing the powers needs no teardown path of its own.
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
        // (updateProjectiles), not here.
        if (atk.kind === 'ranged' && atk.projectiles) {
          this.spawnMonsterProjectile(atk);
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
      // spawnEffect is needed here the way every other explosion needs one —
      // the barrel's own PosedThing is already drawing its BEXP death
      // animation at exactly this spot.
      for (const exp of thingUpdate.barrelExplosions) this.applyBarrelExplosion(exp);
    });
    this.profiler.time('Effects', () => {
      // One begin/end pair around all four lists, the same per-frame rebuild
      // `game/things.ts` does — and it has to enclose `updateProjectiles`,
      // which pushes this frame's new impact explosions and smoke puffs onto
      // `impacts` for the pass right after it to draw.
      this.effectBatch.begin(camera.viewerAngleDeg);
      this.teleportFogs = this.updateEffects(this.teleportFogs, dt, camera.viewerAngleDeg);
      this.updateTracers(dt);
      this.updateProjectiles(dt, camera.viewerAngleDeg);
      this.impacts = this.updateEffects(this.impacts, dt, camera.viewerAngleDeg);
      this.effectBatch.end();
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
