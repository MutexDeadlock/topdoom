/**
 * `Game`: one running level — builds the scene from the WAD, owns the frame/tic loop, and wires
 * every subsystem (world, things, specials, weapons, projectiles, effects, fog of war, HUD, audio)
 * into the simulation order. See docs/frameloop.md.
 */
import * as THREE from 'three';
import type { Wad } from './wad/wad.ts';
import { mapProvider, wadId, wadSetId } from './wad/checksum.ts';
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
import {
  buildThingSprites,
  monstersTelefrag,
  TELEFRAG_DAMAGE,
  telefragReaches,
  type CrossingBody,
  type MonsterRef,
  type ThingLayer,
} from './game/things.ts';
import {
  PLAYER_ACTION_FRAME_SECONDS,
  PLAYER_ATTACK_FRAMES,
  PLAYER_DEATH_FRAME_SECONDS,
  PLAYER_DEATH_FRAMES,
  PLAYER_PAIN_FRAMES,
  obituary,
} from './game/things/tables.ts';
import { thrustSpeed } from './game/monsters/defs.ts';
import { MonsterAttacks } from './game/monsters/attacks.ts';
import { collectFadeTargets, FlatFader, SurfaceScroller, WallFader } from './render/occlusion.ts';
import { makeTouchCache, sectorLines, World, type SectorTouchCache } from './game/world.ts';
import { AIM_HEIGHT_OFFSET, EYE_HEIGHT, HARD_LANDING_SPEED, Player, PLAYER_MASS, PLAYER_RADIUS } from './game/player.ts';
import { applyBarrelExplosion, type CombatContext, type DamageCause } from './game/combat.ts';
import { SpriteFxLayer } from './game/spritefx.ts';
import { ProjectileLayer } from './game/projectiles.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { AutoCamera, getCameraMode } from './game/autocamera.ts';
import {
  applyCrushDamage,
  blocksCeilingLower,
  blocksFloorRise,
  SectorEffects,
  SpecialsController,
  type TeleportDest,
} from './game/specials.ts';
import { computeMovableSectors } from './game/specials/mapscan.ts';
import { Forces } from './game/specials/forces.ts';
import { transfersOf, type Transfers } from './game/specials/transfers.ts';
import { colormapTint, type ColorTint } from './wad/colormaps.ts';
import { VoodooDolls } from './game/voodoo.ts';
import { readAnimated } from './wad/animated.ts';
import { readSwitches, switchPairs, type SwitchPairLookup } from './wad/switches.ts';
import { switchPairTexture } from './game/specials/defs.ts';
import { IconOfSin } from './game/monsters/iconofsin.ts';
import { Hud, type LevelStats } from './ui/hud/hud.ts';
import { Crosshair } from './ui/hud/crosshair.ts';
import { Intermission, INTERMISSION_INPUT_DELAY } from './ui/hud/intermission.ts';
import { EndCard, type EndScope } from './ui/hud/endcard.ts';
import { LevelCard } from './ui/hud/levelcard.ts';
import { LevelNames } from './wad/campaign/names.ts';
import { LevelProgression } from './wad/campaign/progression.ts';
import { CenterMessage, lockedLineMessage, SECRET_MESSAGE } from './ui/hud/message.ts';
import { DebugHud, handleHotkeys } from './ui/devmode/debughud.ts';
import { ScreenEffects } from './ui/hud/screeneffects.ts';
import { DeathOverlay } from './ui/hud/deathoverlay.ts';
import { FrameProfiler } from './util/profiler.ts';
import { clearRandom, getRandomCursors, setRandomCursors } from './util/random.ts';
import {
  applySectors,
  deserializeInventory,
  sectorBaseline,
  serializeInventory,
  snapshotSectors,
  type GameSnapshot,
  type SectorSnapshot,
} from './game/snapshot.ts';
import { wadSetRefusal, type CheckpointStore, type SaveCapture, type SaveGame } from './game/savegames.ts';
import { playerDamageAtSkill, type Skill } from './game/skill.ts';
import {
  applyDamage,
  applyPickup,
  createInventory,
  finishLevel,
  getPistolStart,
  hasPower,
  pickupSound,
  PICKUP_RANGE,
  tickPowers,
  type Inventory,
} from './game/inventory.ts';
import { ThingType } from './game/things/doomednums.ts';
import { WEAPONS, WeaponSystem } from './game/weapons.ts';
import type { AudioEngine } from './audio/audio.ts';
import { PLAYER_ORIGIN } from './audio/sfx.ts';
import { SoundBank } from './wad/sound.ts';
import { MusicBank } from './wad/music.ts';
import { MapInfo } from './wad/campaign/mapinfo.ts';
import { LevelMusic } from './audio/music.ts';
import type { Pos2 } from './types.ts';
import { DOOM_TIC, FOG_START_FRACTION, VIEW_DISTANCE } from './constants.ts';

/**
 * The simulation's fixed step. Every gameplay system advances by exactly this
 * and never by a frame delta, which is what makes a run independent of the
 * display it is drawn on. It is `DOOM_TIC` because vanilla's own 35 Hz clock is
 * what every duration in the engine is already quoted in.
 * docs/frameloop.md § The accumulator.
 */
const TIC_SECONDS = DOOM_TIC;

/**
 * Most tics one frame may run before the rest of the banked time is dropped.
 * Bounds both the catch-up burst after a stall and the worst-case cost of a
 * single frame; without it a backgrounded tab returns owing minutes of
 * simulation and spends them all in one frame. Five is ~143ms of debt, a little
 * over what the old `dt` clamp allowed to pass in one step.
 */
const MAX_TICS_PER_FRAME = 5;

const FPS_CAP_STORAGE_KEY = 'topdoom.fpsCap';

/** The frame rates the menu offers; `0` is no cap, and the default. */
const FPS_CAPS = [0, 30, 60, 120] as const;
export type FpsCap = (typeof FPS_CAPS)[number];

/**
 * How many frames a second the loop is allowed to run at, `0` for as many as the
 * display offers. Lives here because `frame` is the only thing it changes; the
 * menu just wires its select to these two. See docs/frameloop.md § The FPS cap.
 */
let fpsCap: FpsCap = readStoredFpsCap();

function readStoredFpsCap(): FpsCap {
  const stored = Number(globalThis.localStorage?.getItem(FPS_CAP_STORAGE_KEY));
  return FPS_CAPS.find((c) => c === stored) ?? 0;
}

export function getFpsCap(): FpsCap {
  return fpsCap;
}

export function setFpsCap(cap: FpsCap): void {
  fpsCap = cap;
  globalThis.localStorage?.setItem(FPS_CAP_STORAGE_KEY, String(cap));
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
  /** Whether a *monster* arriving on a teleport pad telefrags rather than being turned back by what stands there — `monstersTelefrag`, resolved per level. */
  private monsterStomps = false;
  /**
   * The current level's sectors as the WAD authored them, taken before anything
   * has touched them — what a capture diffs against so only sectors a special
   * has actually changed are saved (`snapshotSectors`).
   */
  private sectorBaseline: SectorSnapshot[] = [];
  private world!: World;
  private player!: Player;
  private built: BuiltMap | null = null;
  private things: ThingLayer | null = null;
  private playerActor: SpriteActor;
  private wallFader!: WallFader;
  private flatFader!: FlatFader;
  private surfaceScroller!: SurfaceScroller;
  /** The level's always-on parameter lines — scrollers and conveyors (game/specials/forces.ts). */
  private forces!: Forces;
  /** The level's Boom render transfers (game/specials/transfers.ts) — read per frame for the view colormap. */
  private transfers!: Transfers;
  /**
   * The colour cast of each 242 control sector's colormaps, resolved once per
   * level: `R_SetupFrame` picks one of them per frame, and a WAD lookup per
   * frame to answer that would be pure waste. Empty on the maps with none. The
   * third, underwater colormap is not kept — `viewColormap` never applies it.
   */
  private colormapTints = new Map<number, { mid: ColorTint | null; top: ColorTint | null }>();
  /**
   * The player's cached touched-sector list for the three per-tic force
   * queries — one body, one cache (`World.sectorsTouchingCached`), so
   * carry/push/friction share one sector walk per tic instead of three.
   * Reset per level: the positions it was keyed on are the old map's.
   */
  private playerTouch: SectorTouchCache = makeTouchCache();
  /** The level's voodoo dolls, if it places any (game/voodoo.ts). */
  private voodoo!: VoodooDolls;
  private animatedTextures!: AnimatedTextures;
  /** How a switch texture resolves to its opposite state — see the constructor. */
  private switchPairs: SwitchPairLookup;
  private fogOfWar!: FogOfWar;
  private autoCamera!: AutoCamera;
  private specials?: SpecialsController;
  /**
   * The Icon of Sin's cube spitter, rebuilt per level like `specials` — inert on every map with no
   * `MT_BOSSSPIT` thing, which is all of them but MAP30. See game/monsters/iconofsin.ts.
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
   *
   * Which of the two exits fired is carried along: it decides where the level leads, and only
   * here, since by the time the popup is up the choice has already been made into `nextMapIndex`.
   */
  private pendingExit: 'normal' | 'secret' | null = null;
  /**
   * The map the continue key loads, or -1 when nothing follows the exit just taken. Resolved the
   * moment the popup goes up rather than when it is dismissed — that is the last moment
   * `currentMap` is still the level just finished. docs/wad.md § Level progression.
   */
  private nextMapIndex = 0;
  /**
   * What the exit just taken ended, or null when it merely led somewhere. Resolved with
   * `nextMapIndex`, and for the same reason: both are answers about the level being left. Outlives
   * the popups — it is also what makes the transition off the card a rebirth rather than an
   * ordinary level change (`enterLevel`'s `reborn`). docs/hud.md § End card.
   */
  private pendingEnd: EndScope | null = null;
  /**
   * Which end-of-level popup is up, or null while the level is running. The level is finished and
   * frozen behind either: `frame` advances nothing until the player presses the continue key. Not
   * `pause()`, which is the menu's — a popup has to keep reading input. One field rather than a
   * flag each, so "both at once" isn't a state that can be reached. docs/hud.md § Intermission.
   */
  private popup: 'intermission' | 'endcard' | null = null;
  /**
   * Seconds the popup has been up, for `INTERMISSION_INPUT_DELAY`. The only thing that still
   * advances while it is. Shared by both popups, and restarted when the card takes over so one
   * press can't dismiss them both.
   */
  private intermissionTime = 0;
  /** Damage floors and the secret counter for the current map — see game/specials/sectoreffects.ts. */
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
  /**
   * Real time banked but not yet spent on a tic, always under `TIC_SECONDS` once
   * `frame` has drained it. Doubles as the interpolation alpha's numerator — see
   * docs/frameloop.md § The accumulator.
   */
  private accumulator = 0;
  /** Timestamp of the previous rendering opportunity, skipped ones included — the display's own period. See `dueThisFrame`. */
  private lastRaf = 0;
  /** When the next frame is due under the FPS cap; ignored while uncapped. See `dueThisFrame`. */
  private nextFrameAt = 0;
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
  /** The "Entering / <level name>" card every map load raises — see ui/hud/levelcard.ts. */
  private levelCard: LevelCard;
  /** The end-of-level popup — see ui/hud/intermission.ts and `popup`. */
  private intermission: Intermission;
  /** The campaign-over card the popup hands over to — see ui/hud/endcard.ts and `popup`. */
  private endCard: EndCard;
  /** Names levels for the card: MAPINFO, then the vanilla title table — see wad/campaign/names.ts. */
  private levelNames: LevelNames;
  /** The WAD set's `D_*` lumps, and the MAPINFO overrides of which one a level plays. */
  private levelMusic: LevelMusic;
  /** Where each exit leads: MAPINFO, then vanilla's own tables — see wad/campaign/progression.ts. */
  private progression: LevelProgression;
  /**
   * Measurement itself always runs — `performance.now()` calls are cheap enough
   * not to bother gating; only `DebugHud`'s decision to render the samples is
   * DEVMODE-gated.
   */
  private profiler = new FrameProfiler();
  private debugHud = new DebugHud();
  private screenEffects: ScreenEffects;
  private deathOverlay = new DeathOverlay();
  private inventory: Inventory = createInventory();
  /** True once the player's health has hit 0 — freezes movement/aim/firing/pickups (see `frame`) until `restart`. */
  private playerDead = false;
  readonly title: string;

  /**
   * Where the level-entry checkpoint is kept, or null when nothing is offering
   * one (the tests, mainly). docs/savegames.md § The checkpoint.
   */
  private checkpoint: CheckpointStore | null;
  /** What the last exit of the last level calls — see the constructor parameter. */
  private onCampaignEnd: (() => void) | null;
  /**
   * Whether *this session* has written a checkpoint, i.e. has advanced a level
   * at least once. What stops `restart` from restoring a checkpoint left in the
   * store by an earlier run — that save would be a level start with a different
   * run's inventory, which is not what "restart this level" means.
   */
  private hasCheckpoint = false;
  /**
   * The savegame this level is currently playing out of, if any: the one it was
   * loaded from, and every manual save taken since. It is what `R` goes back to,
   * ahead of the checkpoint — in memory, so no store read and no session match
   * (docs/death.md § Player death). Dropped by `enterLevel`, which is the only
   * way out of a level.
   */
  private savedState: GameSnapshot | null;
  /** Guards the two async gaps in `restart`: a held-down `R`, and a `Game` torn down mid-read. */
  private restarting = false;
  private disposed = false;

  /** `?pos=x,y` override for the player start, consumed by the first map load. */
  private startPos: Pos2 | null;
  /**
   * Whether this session's completions may set best times. A `?pos=` start can drop the player
   * anywhere — next to the exit included — so those runs are excluded (docs/hud.md § Best times).
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
    /** A savegame's state payload: the level is built normally, then overwritten step by step — docs/savegames.md § Apply order. */
    restore: GameSnapshot | null = null,
    /** The checkpoint store, taken as a port so this class still knows nothing about IndexedDB. */
    checkpoint: CheckpointStore | null = null,
    /**
     * Called when the campaign is over and nothing follows: the session layer's cue to tear this
     * `Game` down and put the menu back up (docs/menu.md § Session lifecycle). A port like
     * `checkpoint` — this class knows nothing about the menu.
     */
    onCampaignEnd: (() => void) | null = null,
  ) {
    this.view = view;
    this.audio = audio;
    this.wad = wad;
    this.title = title;
    this.skill = skill;
    this.startPos = startPos;
    this.checkpoint = checkpoint;
    this.onCampaignEnd = onCampaignEnd;
    this.savedState = restore;
    // From the save when restoring: a `?pos=` run must not become eligible for
    // best times by being saved and loaded back (docs/hud.md § Best times).
    this.recordsEligible = restore ? restore.recordsEligible : startPos === null;
    // Primed here, where a one-off scan of each file's bytes disappears into a load that is about
    // to build every mesh in the level, so the exit frame only ever hits the memo.
    for (const file of wad.files) wadId(file);

    this.scene.background = new THREE.Color(0x05050a);
    this.scene.fog = new THREE.Fog(0x05050a, VIEW_DISTANCE * FOG_START_FRACTION, VIEW_DISTANCE);

    // The WAD set's own sound lumps, for as long as this Game owns the level.
    // The engine itself (and its AudioContext) outlives us — see AudioEngine.
    audio.setBank(new SoundBank(wad));
    // What the set's own MAPINFO lumps say about its levels, parsed once here and projected by
    // the three consumers below — titles, exits, music (docs/wad.md § Level names).
    const mapInfo = new MapInfo(wad);
    // Same for its music, plus whatever its MAPINFO says about which track goes
    // with which map (docs/music.md § Which track a level plays).
    const musicBank = new MusicBank(wad);
    this.levelMusic = new LevelMusic(musicBank, mapInfo.music());
    audio.music.setBank(musicBank);

    const gfx = new GraphicsBank(wad);
    this.materials = new MaterialBank(gfx, view.renderer);
    // Boom's two table lumps, both session-scoped like the banks around them:
    // each replaces a built-in table outright when present, and neither
    // depends on which map is loaded. docs/wad.md § ANIMATED and SWITCHES.
    const animated = readAnimated(wad);
    const switches = readSwitches(wad);
    this.switchPairs = switches ? switchPairs(switches, (name) => gfx.hasTexture(name)) : switchPairTexture;
    // Session-scoped, same as `materials` above — depends only on the WAD
    // set's own graphics, not on which map is currently loaded.
    this.animatedTextures = new AnimatedTextures(gfx, this.materials, animated ?? undefined);
    this.spriteBank = new SpriteBank(wad);
    this.spriteMaterials = new SpriteMaterialCache(gfx, view.renderer);
    this.hud = new Hud(gfx);
    this.message = new CenterMessage(gfx);
    this.levelCard = new LevelCard(gfx);
    this.intermission = new Intermission(gfx);
    this.endCard = new EndCard(gfx);
    // Session-scoped like the banks above: which titles apply depends on the loaded file set
    // (its MAPINFO lumps and which IWAD it is), not on the current map.
    this.levelNames = new LevelNames(wad, mapInfo);
    this.crosshair = new Crosshair(view.renderer.domElement);
    this.mapNames = wad.mapNames();
    if (this.mapNames.length === 0) throw new Error('no maps in the selected WADs');
    // After `mapNames`: a progression may only name a level the loaded set actually provides.
    this.progression = new LevelProgression(mapInfo, this.mapNames);

    // PLAY's own walk cycle: DOOM has no separate idle art, it just holds
    // frame A (this list's first entry) until the player is actually moving.
    this.playerActor = new SpriteActor(this.spriteBank, this.spriteMaterials, 'PLAY', ['A', 'B', 'C', 'D']);
    this.scene.add(this.playerActor.mesh);
    // The vile-flame resolver is `monsterAttacks`', not the batch's — where the
    // flame belongs depends on live monster/player state. Both callbacks are
    // reached through a closure because `monsterAttacks` and `fogOfWar` are both
    // built after `effects` (the fog on every level load), and neither is called
    // before a frame runs, long after all three exist.
    this.effects = new SpriteFxLayer(
      this.scene,
      this.spriteBank,
      this.spriteMaterials,
      audio,
      (vileId, targetId) => this.monsterAttacks.vileFlameFor(vileId, targetId),
      (subsector) => this.fogOfWar.isVisible(subsector),
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
      damagePlayer: (amount, fromX, fromY, cause) => this.damagePlayer(amount, fromX, fromY, cause),
      triggerShot: (lineIndex, byMonster) => this.specials?.triggerShot(lineIndex, this.inventory.keys, byMonster),
    };
    this.projectiles = new ProjectileLayer(this.combat, this.effects, this.spriteBank, this.spriteMaterials, audio);
    this.monsterAttacks = new MonsterAttacks(this.combat, this.effects, this.projectiles, audio, () =>
      hasPower(this.inventory, 'invisibility'),
    );

    // Bound once rather than per frame: `playerActor` is never reassigned.
    this.screenEffects = new ScreenEffects(view.renderer, (opacity) =>
      this.playerActor.setOpacity(opacity),
    );

    const wanted = this.mapNames.indexOf(startMap.toUpperCase());
    // The first-map fallback is fine for a fresh start, but a restore's things
    // and sectors only make sense on the exact map they were saved on.
    if (restore && wanted < 0) throw new Error(`the selected WADs have no map ${startMap.toUpperCase()}`);
    this.loadMapByIndex(wanted >= 0 ? wanted : 0, restore);
  }

  get currentMap(): string {
    return this.mapNames[this.mapIndex];
  }

  /**
   * Whether this level is already on its way out and nothing can stop it: an exit queued for the
   * next tic, or the Icon of Sin's death cascade, which runs for `BRAIN_DEATH_TO_EXIT` before it
   * calls `onExit`. A death inside that window raises no overlay and answers no `R` — the level is
   * over, it just hasn't finished saying so. docs/death.md § Dying on the way out.
   */
  private get levelEnding(): boolean {
    return this.pendingExit !== null || this.icon?.exiting === true;
  }

  /**
   * Takes the death overlay down when the level starts ending under a corpse — the intermission is
   * what the player should be looking at. Idempotent and self-guarded, so every place the level can
   * start ending calls it unconditionally. docs/death.md § Dying on the way out.
   */
  private endingOverCorpse(): void {
    if (!this.playerDead || !this.levelEnding) return;
    this.deathOverlay.clear();
    this.screenEffects.clearPain();
  }

  /**
   * Why this moment can't be saved, or null when it can. Death, a pending exit
   * and the intermission are refused — excluding those three from the save
   * format entirely is far cheaper than restoring them correctly
   * (docs/savegames.md § What is saved and what is deliberately not). The
   * reason is a sentence rather than a flag because it is what the player is
   * told — `captureSave` throws it, and the menu also asks *before* the fact to
   * disable Save/Overwrite and name the reason (docs/menu.md § Save and Load tabs).
   *
   * Deliberately narrower than `levelEnding`: the Icon of Sin's death cascade stays saveable,
   * since `IconSnapshot` carries `exitTimer` and a mid-cascade save restores mid-cascade.
   */
  saveRefusal(): string | null {
    if (this.playerDead) return "you can't save while dead";
    if (this.popup === 'intermission') return "you can't save during the intermission";
    if (this.popup === 'endcard') return "you can't save once the campaign is over";
    if (this.pendingExit) return "you can't save while the level is exiting";
    return null;
  }

  /**
   * Saves this moment through the caller's writer — the menu's Save and
   * Overwrite, whose store call is all that differs between them, handed in the
   * same `(capture) => Promise` shape `CheckpointStore.write` already uses. The
   * capture, the write and `savedState` stay together here for the reason
   * `writeCheckpoint` keeps its own trio together: what a save *is* and what a
   * successful one makes `R` reload are both this class's, and only a write that
   * actually stored the bytes may move `savedState` (docs/death.md § Player death).
   *
   * Refuses by *throwing*, from `captureSave` below or from the writer itself —
   * the same shape either way, which is what lets the menu turn any of it into
   * one status line (docs/menu.md § Save and Load tabs).
   */
  async saveVia(write: (capture: SaveCapture) => Promise<unknown>): Promise<void> {
    const capture = this.captureSave();
    await write(capture);
    this.savedState = capture.state;
  }

  /**
   * The full state of this moment plus a thumbnail, ready for the store.
   * Refuses by *throwing* the reason, the same convention the store's own
   * writers use, so the whole save path has one refusal shape and the player is
   * told which condition actually applies (docs/menu.md § Save and Load tabs).
   * Only the store's own bookkeeping (id, name, date) is the caller's to add: a
   * capture identifies its WAD set by content, so this class needs to know
   * nothing about the library it was picked from.
   */
  private captureSave(thumbnail = true): SaveCapture {
    const refusal = this.saveRefusal();
    if (refusal) throw new Error(refusal);
    return {
      map: this.currentMap,
      skill: this.skill,
      wads: wadSetId(this.wad),
      // A level is running, so the map has a provider; `''` would only mean the
      // save asks for its whole set back, which is the safe way to be wrong.
      mapWad: mapProvider(this.wad, this.currentMap)?.id ?? '',
      levelTime: this.levelTime,
      // The checkpoint passes `false`: it is never listed, so nothing would ever
      // draw its thumbnail, and taking one costs a full extra render.
      thumb: thumbnail ? this.captureThumbnail() : '',
      state: {
        levelTime: this.levelTime,
        cameraYawDeg: this.view.camera.yawDeg,
        recordsEligible: this.recordsEligible,
        player: this.player.snapshot(),
        inventory: serializeInventory(this.inventory),
        weapons: this.weaponSystem.snapshot(),
        sectors: snapshotSectors(this.map, this.sectorBaseline),
        // Non-null: all three are built by every `loadMapByIndex` pass, and
        // `captureSave` is only reachable with a level loaded.
        specials: this.specials!.snapshot(),
        sectorEffects: this.sectorEffects.snapshot(),
        fog: this.fogOfWar.snapshotExplored(),
        soundAlerted: this.world.snapshotSoundAlerted(),
        things: this.things!.snapshot(),
        icon: this.icon!.snapshot(),
        projectiles: this.projectiles.snapshot(),
        teleportFogs: this.effects.snapshotTeleportFogs(),
        voodoo: this.voodoo.snapshot(),
        scrollers: this.forces.snapshot(),
        rng: getRandomCursors(),
      },
    };
  }

  /**
   * A small JPEG of the moment being saved. The renderer runs without
   * `preserveDrawingBuffer`, so the pixels are only readable in the same task
   * as a `render` call — hence the fresh synchronous render here rather than
   * trusting whatever `stillFrame` last composited.
   */
  private captureThumbnail(): string {
    this.view.renderer.render(this.scene, this.view.camera.camera);
    const src = this.view.renderer.domElement;
    const w = 320;
    const h = Math.max(1, Math.round((src.height / Math.max(1, src.width)) * w));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(src, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  private loadMapByIndex(index: number, restore: GameSnapshot | null = null): void {
    // `M_ClearRandom`, from vanilla's own `G_InitNew` — this is the one place
    // every level start funnels through. docs/random.md § What this does not buy.
    clearRandom();
    // A slow load is not simulation time, same as a pause — see `resume`.
    this.accumulator = 0;
    // Keys don't survive a level transition in vanilla DOOM; health/armor/ammo do.
    finishLevel(this.inventory);
    // Whatever was still ringing belongs to the level being torn down — a door
    // closing, a monster's death cry — and its origins are about to be reused.
    this.audio.stopAll();
    this.weaponSystem.beginLevel(this.inventory);
    // A fresh map always starts with a living player — covers both a normal
    // level transition (a level can end over a corpse, and `enterLevel` has
    // just reborn the inventory for it) and `restart`'s "reload the same map"
    // call, defensively in one place rather than duplicated at each caller.
    this.playerDead = false;
    this.deathOverlay.clear();
    this.screenEffects.clearPain();
    this.message.clear();
    this.levelCard.clear();
    this.intermission.clear();
    this.endCard.clear();
    this.popup = null;
    this.pendingEnd = null;
    this.playerActor.revive();
    this.mapIndex = (index + this.mapNames.length) % this.mapNames.length;
    const name = this.mapNames[this.mapIndex];
    // Before the map is built rather than after: the track outlives the load,
    // and `play` is a no-op when the level being entered wants the same one.
    this.audio.music.play(this.levelMusic.trackFor(name));

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
    // Resolved once here rather than per teleport, the way the boss-death table is
    // (`bossDeathTriggersFor`): a map-identity gate can't change while a level runs.
    this.monsterStomps = monstersTelefrag(map.name);
    // Straight out of `loadMap`, ahead of the restore below and of everything
    // that mutates a sector — this is the state a later load starts from, so it
    // is what a capture may leave out (docs/savegames.md § Apply order).
    this.sectorBaseline = sectorBaseline(map);
    // Boom's render transfers, resolved here rather than where they are first
    // read below: the two scans in `Transfers`' constructor compare sector
    // heights (`markFakeFloors`, `markPools`), and those have to be the map's
    // authored ones — after the restore below, a saved mover's sector reads at
    // the height it had stopped at. docs/savegames.md § Apply order.
    transfersOf(map, (name) => this.wad.find(name)?.size ?? null);
    // Before the sector snapshot below, so `totalSecrets` counts the map's
    // authored secrets — a found secret zeroes its sector's `special`.
    this.sectorEffects = new SectorEffects(map);
    // The sector snapshot is applied to the *map* here, ahead of everything
    // built from it, so meshes/world/fog all bake restored geometry and no
    // rebuild pass is needed — docs/savegames.md § Apply order.
    if (restore) {
      applySectors(map, restore.sectors);
      this.sectorEffects.restore(restore.sectorEffects);
    }
    this.levelTime = restore ? restore.levelTime : 0;
    this.world = new World(map);
    // A fresh world invalidates every cached sector walk — see `playerTouch`.
    this.playerTouch = makeTouchCache();
    // Both drop whatever was still in flight or mid-animation in the level
    // being torn down, which would otherwise carry over into the new one.
    this.effects.beginLevel(this.world);
    // After `beginLevel` (which clears the layer) and after `applySectors`
    // above, so a fog re-samples its sector's *restored* light.
    if (restore?.teleportFogs) this.effects.restoreTeleportFogs(restore.teleportFogs);
    this.projectiles.beginLevel();
    // Sectors a door/lift/floor mover will drive are pulled out of the static
    // batches up front — SpecialsController owns their geometry instead (see
    // render/mapmesh.ts's MapMeshOptions doc for why).
    // The same memoized table the pre-restore call above built: the mesh takes
    // its transferred lighting and water planes from here, as does the
    // movable-sector scan. docs/specials.md § Render transfers.
    const transfers = transfersOf(map, (name) => this.wad.find(name)?.size ?? null);
    this.transfers = transfers;
    this.colormapTints.clear();
    for (const { control } of transfers.waterSectors()) {
      const names = transfers.colormapsOf(control);
      if (!names || this.colormapTints.has(control)) continue;
      this.colormapTints.set(control, {
        mid: colormapTint(this.wad, names.mid),
        top: colormapTint(this.wad, names.top),
      });
    }
    const movableSectors = computeMovableSectors(map, this.switchPairs);
    // A saved mid-motion mover's sector may have had its authored special
    // consumed, dropping it from the scan above — union it back in so its
    // geometry stays mover-owned (docs/savegames.md § Apply order).
    if (restore) {
      const saved = [...restore.specials.movers, ...(restore.specials.ceilingMovers ?? [])];
      for (const [sectorIndex] of saved) movableSectors.add(sectorIndex);
    }
    this.built = buildMapMesh(map, this.materials, { movableSectors, transfers, linesOf: (s) => sectorLines(map, s) });
    this.scene.add(this.built.group);
    this.wallFader = new WallFader(this.built.occluders, this.built.wallMeshes);
    this.flatFader = new FlatFader(this.built.flatSurfaces, this.built.flatMeshes);
    this.forces = new Forces(map, this.world);
    // Constructed after `applySectors` on purpose, so a displacement scroller
    // spawns watching the restored control-sector height rather than the
    // authored one — `Forces.restore` covers what that ordering can't.
    this.forces.restore(restore?.scrollers);
    this.voodoo = new VoodooDolls(this.world);
    // Absent in a save from before dolls existed, which leaves them on their own
    // player starts — the same state a fresh load gives them.
    this.voodoo.restore(restore?.voodoo);
    this.surfaceScroller = new SurfaceScroller(
      this.forces,
      this.built.occluders,
      this.built.wallMeshes,
      this.built.flatSurfaces,
      this.built.flatMeshes,
      this.materials,
    );
    this.player = new Player(this.world);
    if (restore) {
      // The saved position and camera replace both the map's own start and any
      // `?pos=` override, which stays queued for the next fresh level.
      this.player.restore(restore.player);
      this.view.camera.yawDeg = restore.cameraYawDeg;
    } else {
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
    }
    // After both branches, and after the yaw each sets: the camera belongs to
    // the session, not the level, so its smoothed follow point still holds the
    // outgoing level's — a load would open with the camera flying to the
    // player. docs/render.md § The camera is simulation state.
    this.autoCamera = new AutoCamera(this.world);
    // Seeded before snapTo, which poses the camera — so a level opens already
    // framed rather than mid-zoom. docs/render.md § Auto camera.
    this.autoCamera.seed(this.player, this.view.camera);
    this.view.camera.snapTo({ x: this.player.x, y: this.player.y, z: this.player.eyeZ });
    this.fogOfWar = new FogOfWar(this.world, this.built.occluders, this.player.x, this.player.y, movableSectors);
    if (restore) this.fogOfWar.restoreExplored(restore.fog);
    this.specials = new SpecialsController(
      map,
      this.world,
      this.materials,
      this.scene,
      this.fogOfWar,
      this.built.polys,
      this.built,
      { transfers },
      (secret) => {
        this.pendingExit = secret ? 'secret' : 'normal';
      },
      (dest) => {
        // `P_TeleportMove` stomps whatever is standing on the landing pad; the
        // player always stomps, so this arrival is never refused — docs/death.md § Telefrag.
        this.things?.telefragAt(dest, PLAYER_RADIUS, true);
        // The origin puff's position has to be captured before teleportTo
        // overwrites it; the landing `z` only exists after. See
        // SpriteFxLayer.spawnTeleportPair for the pair itself.
        const from = { x: this.player.x, y: this.player.y, z: this.player.z };
        this.player.teleportTo(dest);
        // Boom's silent family spawns neither puff and plays no `telept` —
        // docs/specials.md § Silent and line-to-line teleporters.
        if (!dest.silent) this.effects.spawnTeleportPair(from, dest, this.player.z);
        // The camera's follow point always snaps — a teleport should cut, not
        // fly across the map to catch up (docs/render.md § The camera is
        // simulation state). The *yaw* differs by kind, and `yawDeg` is an
        // orbit the player owns with Q/E rather than anything slaved to their
        // facing:
        //
        // - A vanilla teleport reorients it to the landing angle, same as the
        //   initial spawn. It is a cut; the arrival has an authored facing.
        // - **A silent one turns it by the same angle the body turned**, so a
        //   pair authored as one continuous doorway (`rotateBy` 0) leaves the
        //   view completely still, and whatever orbit the player had chosen
        //   survives. Reorienting it absolutely would inject that orbit offset
        //   as a visible spin on every silent arrival, which is the opposite
        //   of the point. docs/specials.md § Silent and line-to-line teleporters.
        //
        // Yaw first either way: `snapTo` poses the camera with it.
        const camera = this.view.camera;
        camera.yawDeg =
          dest.rotateBy === undefined
            ? (dest.angle * 180) / Math.PI - 90
            : camera.yawDeg + (dest.rotateBy * 180) / Math.PI;
        camera.snapTo({ x: this.player.x, y: this.player.y, z: this.player.eyeZ });
      },
      (sectorIndex, dealDamage) =>
        applyCrushDamage(
          this.world,
          this.map,
          this.things,
          this.player,
          sectorIndex,
          // The cause is fixed per wiring site, so the callbacks these two
          // helpers take stay `(amount) => void` and bind it here instead.
          (amount) => this.damagePlayer(amount, undefined, undefined, 'crush'),
          dealDamage,
          // A crusher over a voodoo doll kills the player it stands for.
          this.voodoo.dolls,
        ),
      (sectorIndex, ceilingHeight) =>
        blocksCeilingLower(this.world, this.map, this.things, this.player, sectorIndex, ceilingHeight),
      (sectorIndex, floorHeight) =>
        blocksFloorRise(this.world, this.map, this.things, this.player, sectorIndex, floorHeight),
      this.player.x,
      this.player.y,
      movableSectors,
      this.audio,
      this.switchPairs,
    );
    if (restore) {
      this.specials.restore(restore.specials);
      this.world.restoreSoundAlerted(restore.soundAlerted);
    }

    this.things = buildThingSprites(
      map,
      this.world,
      this.spriteBank,
      this.spriteMaterials,
      this.skill,
      this.audio,
      // A_BossDeath — see docs/death.md § Boss death. Fanned out to both owners: the tag-driven
      // actions (including Commander Keen's door) belong to `specials`, the Icon of Sin's own
      // `A_BrainDie` to `icon`; each ignores the doomednums it doesn't handle. The player-alive
      // gate is `A_BossDeath`'s alone and travels with it — `A_BrainDie` has none, so the icon
      // is notified over a corpse too. docs/death.md § Dying on the way out.
      (type) => {
        this.specials?.notifyBossDeath(type, !this.playerDead);
        this.icon?.notifyBossDeath(type);
        this.endingOverCorpse();
      },
      restore?.things,
      // `P_NightmareRespawn`'s two `MT_TFOG`s, at the corpse and at the spawn point it returns to.
      // `spawnTeleportFog` plays the `telept` that goes with each, exactly as a teleport does.
      (from, to) => {
        this.effects.spawnTeleportFog(from);
        this.effects.spawnTeleportFog(to);
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
        // `A_BrainDie` is a plain `G_ExitLevel` — MAP30 has no secret exit to take.
        this.pendingExit = 'normal';
      },
      this.audio,
    );
    if (restore) {
      this.icon.restore(restore.icon);
      this.projectiles.restore(restore.projectiles);
      this.inventory = deserializeInventory(restore.inventory);
      // After the line above: `restore` derives `weaponLastFrame` off the
      // inventory it is handed, and `beginLevel` only saw the outgoing one.
      this.weaponSystem.restore(restore.weapons, this.inventory);
    }

    // Raised last: this method clears every overlay at its top, so a card shown any earlier than
    // here would be wiped by its own load. A restore shows none — "Entering …" announces arriving
    // at a level, and loading a save resumes one already under way — the level-entry checkpoint
    // `restart` reloads included, which is a load like any other.
    if (!restore) this.levelCard.show(this.levelNames.nameFor(name), this.levelNames.graphicFor(name));

    // Dead last, after every construction-time pRandom draw above (light-state
    // seeds, pushThing's homingBias) has happened and been overwritten: the
    // first simulation draw after a load is exactly the one the save would
    // have made next — docs/savegames.md § Apply order.
    if (restore) setRandomCursors(restore.rng);

    const provider = this.wad.providerOf(name)?.name ?? '?';
    console.info(
      `${name} (${provider}): ${map.sectors.length} sectors, ${map.linedefs.length} linedefs, ` +
        `${map.things.length} things (${this.things.count} rendered), ` +
        `${this.built.triangles} tris in ${Math.round(performance.now() - t0)} ms`,
    );
    if (this.built.missingTextures.length > 0) {
      console.warn('missing textures:', this.built.missingTextures.join(', '));
    }
    if (this.things.missingArt.length > 0) {
      console.warn('things skipped, no sprite in this WAD set:', this.things.missingArt.join(', '));
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
    this.lastRaf = this.lastTime;
    // Time spent paused is not simulation time: without this the level would
    // run a catch-up burst of tics the moment the menu closes.
    this.accumulator = 0;
    // Zero, not `lastTime + interval`: the first frame back is always due, and
    // `dueThisFrame` resyncs the deadline off its own timestamp.
    this.nextFrameAt = 0;
    // Music kept playing behind the menu, and no frame was there to report what
    // it cost; charging all of it to the first frame back would spike the
    // profiler's `Music` bar for seconds. Discarded like the accumulator above.
    this.audio.music.takeRenderMs();
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
   * (see docs/frameloop.md § Pausing). Nothing is advanced here — no dt, no input,
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
    // Read by `resumeFromCheckpoint`, whose store read can still be in flight.
    this.disposed = true;
    this.stop();
    // The engine is session-level and the next Game sets its own bank; this
    // only makes sure nothing from this level is left holding a channel.
    this.audio.stopAll();
    // The music would otherwise keep playing over the menu once this level is gone.
    this.audio.music.stop();
    this.screenEffects.reset();
    // Like `screenEffects`, these elements outlive the Game that drove them — without
    // this the menu (and the next level started from it) inherits the line.
    this.deathOverlay.clear();
    this.message.clear();
    this.levelCard.clear();
    this.intermission.clear();
    this.endCard.clear();
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
   * Runs the walk triggers **any non-player thing** crossed this tic
   * (`SpecialsController.crossMonster` — teleports plus the few door/lift types
   * vanilla lets one activate). Usually that is a monster walking, but a barrel
   * or a decoration a conveyor carried counts too: `P_CrossSpecialLine` excludes
   * only projectiles, and its "monster only" numbers mean "not the player"
   * (docs/specials.md § Scrollers and conveyors). A teleport gets the same
   * `TFOG` puff at both ends the player's own does; vanilla spawns it for any
   * thing that teleports, not just the player.
   *
   * Returning null after a teleport *did* fire is `P_TeleportMove` refusing the
   * landing, which leaves the thing where it stood — docs/death.md § Telefrag.
   */
  private thingCrossedLines(prev: Pos2, mover: CrossingBody): TeleportDest | null {
    const dest = this.specials?.crossMonster(prev, mover, this.inventory.keys);
    if (!dest) return null;
    if (!this.things?.telefragAt(dest, mover.blockRadius, this.monsterStomps, mover.id)) return null;
    // The player half of the stomp: `telefragAt` covered every other body, but the
    // thing layer holds no player reference (same split as the spawn cube's).
    if (!this.playerDead && telefragReaches(dest, this.player, mover.blockRadius + PLAYER_RADIUS)) {
      if (!this.monsterStomps) return null;
      this.damagePlayer(TELEFRAG_DAMAGE, dest.x, dest.y, mover.type);
    }
    // Boom's silent numbers puff at neither end (docs/specials.md § Silent and
    // line-to-line teleporters). A fog puff has no body, so the plain sector
    // floor is the whole answer — `groundFloor` at radius 0 would walk the
    // lines to arrive at the same number.
    if (!dest.silent) {
      const from = { x: mover.x, y: mover.y, z: this.world.floorAt(mover.x, mover.y) };
      this.effects.spawnTeleportPair(from, dest, this.world.floorAt(dest.x, dest.y));
    }
    return dest;
  }

  /**
   * Applies armor-mitigated damage (`applyDamage`) to the player, transitioning to the death
   * animation once health hits 0. `fromX`/`fromY`, when both given, are where the damage
   * physically came from — same omitted-for-damage-floors-and-crushers convention as
   * `ThingLayer.damage`'s own params — and drive vanilla's `P_DamageMobj` knockback.
   * `cause` is only read by the killing hit, which names it on the overlay.
   *
   * Returns whether the hit actually landed; `false` covers both a no-op corpse hit and
   * invulnerability blocking it outright, so a caller with a follow-up effect (e.g.
   * `resolveVileBlast`'s knockup) can gate on it. See docs/death.md § Player death.
   */
  private damagePlayer(rawAmount: number, fromX?: number, fromY?: number, cause?: DamageCause): boolean {
    if (this.playerDead || rawAmount <= 0) return false;
    // Before anything reads it — knockback and the pain flash included, exactly as in vanilla.
    const amount = playerDamageAtSkill(rawAmount, this.skill);
    const healthBefore = this.inventory.health;
    if (!applyDamage(this.inventory, amount)) return false;
    if (fromX !== undefined && fromY !== undefined) {
      this.player.applyDamageThrust(thrustSpeed(amount, PLAYER_MASS), fromX, fromY);
    }
    this.screenEffects.addPain(amount);
    if (this.inventory.health <= 0) {
      this.playerDead = true;
      // Dying on an `exitBelowHealth` floor ends the level whatever killed the player, not only
      // when that floor's own damage did it — E1M8's pit is the ending, and a baron finishing the
      // job there must not leave the episode unwon. Set before the overlay below, which `levelEnding`
      // then keeps from being armed at all. docs/specials.md § Damage floors.
      if (this.sectorEffects.exitsOnDeath(this.world, this.player)) this.pendingExit = 'normal';
      // `player.update` stops running from here on, so it never writes `prev*`
      // again: leaving the window open would have every frame lerp the corpse
      // somewhere else between the last two live tics. docs/frameloop.md §
      // Interpolation.
      this.player.syncInterpolation();
      // A_PlayerScream: the drawn-out `pdiehi` for a death that overkilled by
      // more than 50, the ordinary `pldeth` otherwise. Vanilla tests the
      // *post-hit* health, which goes negative there; `applyDamage` clamps it at
      // 0, so the overkill is reconstructed from the hit instead — off by
      // however much armor absorbed, which only shifts a few borderline deaths
      // between the two cries.
      this.audio.play(amount > healthBefore + 50 ? 'pdiehi' : 'pldeth', this.player, PLAYER_ORIGIN);
      this.playerActor.die(PLAYER_DEATH_FRAMES, PLAYER_DEATH_FRAME_SECONDS);
      // The hint depends on what `R` will actually do — a savegame to reload is
      // known here and now, where a checkpoint is only a store read away
      // (docs/death.md § Player death).
      if (!this.levelEnding) this.deathOverlay.show(obituary(cause), this.savedState !== null);
      return true;
    }
    this.audio.play('plpain', this.player, PLAYER_ORIGIN);
    this.playerActor.playOnce(PLAYER_PAIN_FRAMES, PLAYER_ACTION_FRAME_SECONDS);
    return true;
  }

  /**
   * Advancing into another level: the exit the player just took, or the DEVMODE
   * `N`/`P` jump, which arrives at a level the same way. The checkpoint is
   * written *after* the load, not before — `captureSave` refuses while the
   * intermission is up, and what a death on the new level should return to is
   * that level at tic 0, which is exactly the state now built.
   *
   * Advancing while dead is `G_DoLoadLevel`'s `PST_DEAD` → `PST_REBORN`, and is read off player
   * state here for the same reason vanilla reads it at load rather than queueing it at the exit.
   * `restart` does not come through here — it restores a checkpoint instead (docs/death.md §
   * Player death).
   *
   * `reborn` forces the same fresh `Inventory` on a living player: crossing into a new episode is
   * vanilla's `G_DeferedInitNew`, not a level transition, and starts on the pistol
   * (docs/hud.md § End card). The pistol-start setting makes *every* transition do that
   * (docs/items.md § Pistol start) — read here, so toggling it applies to the run in progress.
   */
  private enterLevel(index: number, reborn = false): void {
    // Before the load, which hands this very object to `weaponSystem.beginLevel`.
    if (this.playerDead || reborn || getPistolStart()) this.inventory = createInventory();
    // A savegame belongs to the level it was taken on; the checkpoint written
    // below is what `R` reloads from here on (docs/death.md § Player death).
    this.savedState = null;
    this.loadMapByIndex(index);
    this.writeCheckpoint();
  }

  /**
   * Where the exit just taken leads, into `nextMapIndex` and `pendingEnd`. `LevelProgression`
   * answers for the WAD set's own MAPINFO and for vanilla's tables; where neither knows one — a
   * PWAD map set naming its levels its own way — the next map in load order stands in, which is
   * what every exit did before there was a progression at all.
   *
   * An exit vanilla ends the game on is the case that is *not* that fallback: it raises the end
   * card, and only then loads the next episode's first map if the set has one.
   * docs/wad.md § Level progression, docs/hud.md § End card.
   */
  private resolveExit(secret: boolean): void {
    const next = this.progression.nextMap(this.currentMap, secret);
    // `indexOf` is non-negative for every name given: `LevelProgression` only ever names a map it
    // was built from this very list. -1 is "nothing follows", which only an ending produces.
    if (next.kind === 'end') {
      this.pendingEnd = next.scope;
      this.nextMapIndex = next.next ? this.mapNames.indexOf(next.next) : -1;
      return;
    }
    this.pendingEnd = null;
    this.nextMapIndex = next.kind === 'map' ? this.mapNames.indexOf(next.name) : this.mapIndex + 1;
  }

  /**
   * Swaps the intermission for the campaign-over card, on the same frozen level and the same
   * continue key — `intermissionTime` restarts so the press that dismissed the popup can't carry
   * straight through this one. docs/hud.md § End card.
   */
  private showEndCard(scope: EndScope): void {
    this.intermission.clear();
    this.endCard.show({
      scope,
      // Still the level just finished — `enterLevel` is what moves on, and it hasn't run yet.
      episodeGraphic: this.levelNames.episodeGraphicFor(this.currentMap),
      subtitle: this.title,
      continues: this.nextMapIndex >= 0,
    });
    this.popup = 'endcard';
    this.intermissionTime = 0;
    // `F_StartFinale`'s own music change, over the intermission track that is playing by now.
    const finale = this.levelMusic.finaleTrackFor(this.currentMap);
    if (finale) this.audio.music.play(finale);
  }

  /**
   * Stores the state the player should come back to when they die on the level
   * being entered. Fire-and-forget: a refused write (a full storage quota) must
   * not take the level change down with it, and the flag only goes up once the
   * bytes are actually in the store — a checkpoint that was never written must
   * not be read back. docs/savegames.md § The checkpoint.
   */
  private writeCheckpoint(): void {
    if (!this.checkpoint) return;
    let capture: SaveCapture;
    try {
      // Nothing here should throw — the refusals `captureSave` checks are all
      // false on a level just loaded — but this runs inside the frame loop,
      // where an exception would take the running game down with it.
      capture = this.captureSave(false);
    } catch (err) {
      console.warn('checkpoint not captured:', err);
      return;
    }
    void this.checkpoint
      .write(capture)
      .then(() => {
        this.hasCheckpoint = true;
      })
      .catch((err: unknown) => console.warn('checkpoint not saved:', err));
  }

  /**
   * `R`, while dead. Reloads the level's savegame where there is one, and
   * otherwise dispatches the checkpoint read below; stays `void` because `tic`
   * calls it, and re-entrant while a read is in flight is the same press twice.
   */
  private restart(): void {
    if (this.restarting) return;
    // The savegame path is synchronous — the snapshot is already in memory, and
    // it came from this very session, so there is nothing to match against
    // (docs/death.md § Player death).
    if (this.savedState) {
      this.loadMapByIndex(this.mapIndex, this.savedState);
      return;
    }
    this.restarting = true;
    void this.resumeFromCheckpoint().finally(() => {
      this.restarting = false;
    });
  }

  /**
   * The level again from its checkpoint, or — with none written this session,
   * one that no longer matches, or a store that refused the read — a fresh
   * inventory and a plain reload, which is what `R` has always done.
   * `loadMapByIndex` resets the player/world/specials/fog and, via the doc on
   * its own top, `playerDead`/the death overlay/`playerActor` too; on the
   * restore path the inventory comes out of the snapshot instead.
   */
  private async resumeFromCheckpoint(): Promise<void> {
    const save = this.hasCheckpoint && this.checkpoint ? await this.checkpoint.read() : null;
    // The read is async, so the session may have moved on underneath it: the
    // menu can have started another level (and disposed this Game) meanwhile.
    if (this.disposed || !this.playerDead) return;
    if (save && this.matchesSession(save)) {
      this.loadMapByIndex(this.mapIndex, save.state);
      return;
    }
    this.inventory = createInventory();
    this.loadMapByIndex(this.mapIndex);
  }

  /**
   * Whether a checkpoint is one this level can be reloaded from: the same map,
   * the same skill (which decides which things exist at all), and a WAD set
   * `wadSetRefusal` accepts — the same gate a manual load goes through, so a
   * checkpoint can't refuse where a load would work
   * (docs/savegames.md § WAD-set identity).
   */
  private matchesSession(save: SaveGame): boolean {
    if (save.map !== this.currentMap || save.skill !== this.skill) return false;
    return wadSetRefusal(save, wadSetId(this.wad), mapProvider(this.wad, save.map)) === null;
  }

  /**
   * The FPS cap (`getFpsCap`): whether this rendering opportunity is the one to
   * use, or one to skip because the next frame isn't due yet. Skipping is the
   * whole frame — nothing is advanced, so the input `frame` would have consumed
   * simply arrives on the next one. Read live rather than cached, so a change in
   * the menu applies to the level already running.
   *
   * See docs/frameloop.md § The FPS cap for why the deadline is compared with half a
   * display period of slack and why it advances by whole intervals.
   */
  private dueThisFrame(now: number): boolean {
    const period = now - this.lastRaf;
    this.lastRaf = now;
    const cap = getFpsCap();
    if (cap === 0) return true;
    const interval = 1000 / cap;
    if (now + period / 2 < this.nextFrameAt) return false;
    this.nextFrameAt = this.nextFrameAt + interval < now ? now + interval : this.nextFrameAt + interval;
    return true;
  }

  private frame = (now: number) => {
    if (!this.running) return;
    if (!this.dueThisFrame(now)) {
      requestAnimationFrame(this.frame);
      return;
    }
    // `rawDt` is the real elapsed wall-clock time, and it is banked rather than
    // consumed: the simulation only ever advances in whole `TIC_SECONDS` steps
    // (`tic`), and whatever is left over becomes the interpolation alpha the
    // draw below poses everything at. `DebugHud` gets `rawDt` because it is
    // measuring real frames, not tics.
    //
    // The lower clamp is load-bearing, not defensive: `now` can predate the
    // `performance.now()` `resume` stamped into `lastTime`, so a level's first
    // frame really can compute a negative delta. It is clamped **here**, at
    // the source, rather than at the accumulator alone — a negative
    // wall-clock delta is meaningless to every consumer `rawDt` reaches, and
    // one of them (`AnimatedTextures`) indexes an array by its own running
    // total of it. See docs/frameloop.md § The accumulator.
    const rawDt = Math.max(0, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.accumulator += rawDt;
    // A stall (backgrounded tab, a slow map load) must not be paid back as a
    // burst of catch-up tics — drop the debt instead, the same "never take a
    // giant step" the old 0.05s dt clamp bought.
    if (this.accumulator > MAX_TICS_PER_FRAME * TIC_SECONDS) this.accumulator = MAX_TICS_PER_FRAME * TIC_SECONDS;
    this.profiler.beginFrame();

    const { input, camera } = this.view;
    let ran = 0;
    while (this.accumulator >= TIC_SECONDS && ran < MAX_TICS_PER_FRAME) {
      this.accumulator -= TIC_SECONDS;
      ran++;
      // A tic that swapped the level (an exit, a restart) invalidates
      // everything the rest of this frame would touch — stop and let the next
      // frame start clean on the new map.
      if (this.tic(input, camera)) {
        requestAnimationFrame(this.frame);
        return;
      }
    }

    // A frozen simulation is drawn at the tic-exact pose, not at the leftover
    // accumulator: with no further tic coming, the last two tics stay apart
    // forever while `alpha` keeps changing every frame, so the still scene
    // shakes between them. docs/frameloop.md § Interpolation.
    this.draw(this.popup ? 1 : this.accumulator / TIC_SECONDS, rawDt);
    requestAnimationFrame(this.frame);
  };

  /**
   * One fixed `TIC_SECONDS` step of the whole simulation, and the only place
   * input is consumed. Returns true if it loaded a different level, which makes
   * every reference the caller holds stale.
   *
   * The call order here is the old per-frame order verbatim, and parts of it are
   * load-bearing — specials before `player.update` so a lift underfoot has
   * already moved when `groundFloor` samples it, the aim ray before
   * `player.update` so `player.angle` is this tic's.
   * docs/frameloop.md § What runs in a tic.
   */
  private tic(input: Input, camera: TopDownCamera): boolean {
    // The level is over and frozen behind the popup: nothing is advanced — not the clock, not the
    // specials, not a monster — only the still scene is redrawn under it. Space/Enter rather than
    // any key, since Escape belongs to the menu (main.ts) and would otherwise both pause and eat
    // the popup in the same press.
    if (this.popup) {
      this.intermissionTime += TIC_SECONDS;
      const go = input.pressed('Space') || input.pressed('Enter');
      input.endTic();
      if (this.intermissionTime < INTERMISSION_INPUT_DELAY || !go) return false;
      // The campaign's last exit shows the card *after* the level's own stats, so the intermission
      // hands over to it here instead of loading anything. docs/hud.md § End card.
      if (this.popup === 'intermission' && this.pendingEnd) {
        this.showEndCard(this.pendingEnd);
        return false;
      }
      // Nothing follows the card on the last level of a set: the session is over, and the callback
      // (main.ts) tears this `Game` down and reopens the menu.
      if (this.nextMapIndex < 0) {
        this.onCampaignEnd?.();
        return true;
      }
      // Crossing into a new episode is a new game in vanilla, so it pistol-starts where an ordinary
      // exit carries health, armor and weapons over — read off what the *exit* ended rather than
      // off which popup is up, since both continues land here. docs/hud.md § End card.
      this.enterLevel(this.nextMapIndex, this.pendingEnd !== null); // clears both popups, like every other per-level overlay
      return true;
    }
    handleHotkeys(input, camera, (delta) => this.enterLevel(this.mapIndex + delta));
    // Set before any system runs, since specials/monsters/weapons all raise
    // sounds during the update below. The camera's yaw is last tic's (it
    // settles in `camera.tick`, at the end) — a tic of smoothing lag on the
    // pan axis, which is inaudible.
    this.audio.setListener(this.player, camera.viewerAngleDeg + 180);
    camera.applyYawInput(input, TIC_SECONDS);

    // Runs before player.update so a lift/door the player is standing on has
    // already moved this tic by the time groundFloor is sampled below.
    this.profiler.time('Specials', () => {
      this.specials?.update(TIC_SECONDS, this.player.x, this.player.y, this.player.angle, input, this.inventory.keys);
      // After the movers, not before: a displacement scroller's rate is the
      // height change its control sector just made this tic.
      this.forces.tick();
      // And the dolls after the forces that carry them, so a conveyor's
      // impulse and the walk lines it pushes a doll across land in one tic.
      if (!this.voodoo.empty) {
        this.voodoo.update(TIC_SECONDS, this.forces, (prev, doll) =>
          this.specials?.crossVoodoo(prev, doll, this.inventory.keys) ?? null,
        );
      }
    });
    // The `oof` a refused keyed line already played is raised inside `specials`; the message that
    // says *which* key it wants is this layer's, since that controller has no HUD. `undefined`
    // (no level loaded) and `null` (nothing refused) are the same non-event here.
    const locked = this.specials?.consumeLockedLine();
    if (locked) this.message.show(...lockedLineMessage(locked.lock, locked.kind));
    // Deferred from the exit trigger's callback — see `pendingExit`'s doc.
    // The old SpecialsController's update() has now fully returned, so it's
    // safe to dispose it and swap in the next map.
    if (this.pendingExit) {
      this.resolveExit(this.pendingExit === 'secret');
      // Before `pendingExit` is cleared, which is half of what `levelEnding` reads. Catches a
      // death that beat the exit here rather than at the boss-death fan-out: an exit-line
      // walk-over is queued and consumed with nothing in between, but a crusher can kill between.
      this.endingOverCorpse();
      this.pendingExit = null;
      // The next map isn't loaded here any more: the popup goes up on the level as it stands, and
      // the continue key at the top of `tic` is what loads it.
      this.intermission.show(this.levelStats(), this.recordCompletion());
      // Vanilla's own `S_ChangeMusic(mus_inter)` at the intermission, keeping
      // the level's track when the set has no intermission lump.
      const between = this.levelMusic.intermissionTrackFor(this.currentMap);
      if (between) this.audio.music.play(between);
      this.popup = 'intermission';
      this.intermissionTime = 0;
      input.endTic();
      return false;
    }

    // `R` is the only input a corpse still answers; everything else the player
    // drives is skipped below instead of branching here.
    if (this.playerDead && !this.levelEnding && input.pressed('KeyR')) {
      input.endTic();
      this.restart();
      return true;
    }

    // Auto-aim, movement, firing and pickups all freeze once the player is
    // dead — there's nothing to aim/move/fire/collect with a corpse — but
    // fog of war, things and effects below keep ticking normally, so a
    // still-flying rocket the player fired right before dying finishes its
    // flight and can still deal splash damage (including, in a
    // grim-but-correct edge case, to the player's own corpse — damagePlayer
    // is a no-op once already dead, so this can't double-kill).
    // The aim ray is cast through the live `THREE` camera, which the last
    // rendered frame left at an *interpolated* pose — a function of frame
    // timing. Re-posing it at alpha 1 puts it back on the previous tic's exact
    // state, which is what keeps what auto-aim can lock onto (and so
    // `player.angle`, and so every shot) independent of framerate. It has to
    // happen immediately before the ray: `draw` overwrites the pose afterwards.
    // docs/frameloop.md § Posing for the aim ray.
    if (!this.playerDead) camera.applyToCamera(1);
    const cursor = this.playerDead ? null : this.updateLivingPlayer(TIC_SECONDS, input, camera);

    if (!this.playerDead) this.levelTime += TIC_SECONDS;
    // After movement (the probe runs from this tic's position) and before
    // camera.tick, whose damping advances toward the fresh target.
    // docs/render.md § Auto camera.
    this.profiler.time('Camera', () => this.autoCamera.tick(this.player, camera));
    camera.tick(TIC_SECONDS, { x: this.player.x, y: this.player.y, z: this.player.eyeZ }, cursor);

    this.profiler.time('Fog of War', () => this.fogOfWar.tick(this.player.x, this.player.y));
    this.updateThings(TIC_SECONDS);
    this.updateEffects(TIC_SECONDS);

    input.endTic();
    return false;
  }

  /**
   * One rendered frame: poses everything `alpha` of the way from the last tic to
   * the current one, runs the presentation-only animators, and draws. Advances
   * no gameplay state whatsoever. docs/frameloop.md § What runs in a frame.
   */
  private draw(alpha: number, rawDt: number): void {
    const camera = this.view.camera;
    camera.applyToCamera(alpha);
    this.updateOverlays(rawDt);
    this.fogOfWar.updateFade(rawDt);
    this.profiler.time('Sprites', () => this.things?.draw(alpha, camera.viewAngleDeg));
    this.drawEffects(alpha, camera.viewAngleDeg);
    this.updateFading(rawDt, camera);
    this.posePlayer(alpha, rawDt, camera.viewAngleDeg);

    this.profiler.time('Render', () => this.view.renderer.render(this.scene, camera.camera));
    // The music synth runs off its own timer, in the gaps between frames, so it
    // reports what it spent instead of being timed here (docs/music.md
    // § Getting it to the speakers).
    this.profiler.offFrame('Music', this.audio.music.takeRenderMs());
    this.profiler.endFrame();

    this.debugHud.update(rawDt, this.profiler, (fps) => this.debugLines(fps));
  }

  /**
   * Everything a *living* player drives in a frame: powers, aim, movement, firing, pickups and the
   * sector underfoot. Returns the point the camera leads toward, which is always where the cursor
   * meets the aim plane — never the locked-on monster.
   */
  private updateLivingPlayer(dt: number, input: Input, camera: TopDownCamera): Pos2 | null {
    // Ticked with the rest of the player's own update and not while dead,
    // matching vanilla: powers age in `P_PlayerThink`, which hands off to
    // `P_DeathThink` and returns before reaching them once health hits 0.
    tickPowers(this.inventory, dt);
    // The cursor hovering over a monster locks aim onto its actual position
    // and height — **on hover, not on click** (docs/combat.md § Auto-aim). The
    // camera leads on `cursor` and never sees the lock, which is
    // docs/render.md § Aim lead's rule and the reason the two are returned
    // separately at all.
    const { monster, cursor } = this.profiler.time('Player', () => {
      // The tic-exact viewer angle, not the interpolated `viewAngleDeg` the
      // billboards are drawn at, for the same framerate-independence reason
      // the camera was posed at alpha 1 above.
      const ray = camera.rayFor(input.pointer.x, input.pointer.y);
      const m = this.things?.pickMonster(ray, camera.viewerAngleDeg) ?? null;
      // The aim plane hangs off the camera's own follow height, not the
      // player's live `z`: identical once the follow smoother has caught up,
      // but during a fall — into a Boom water pool, off any ledge — a plane
      // that drops while the camera lags swings the cursor's world point and
      // turns the player with it. docs/render.md § Aim lead.
      const aimPlaneZ = camera.followHeight - EYE_HEIGHT + AIM_HEIGHT_OFFSET;
      const onPlane = camera.pointerToPlane(input.pointer.x, input.pointer.y, aimPlaneZ);
      const at = m ?? onPlane;
      // Whatever the world is pushing the player with this tic — a conveyor
      // underfoot — onto the same momentum channel a hit's knockback uses.
      // Applied before the move, as `T_Scroll` runs before `P_PlayerThink`.
      const carry = this.forces.carryForBody(this.player, PLAYER_RADIUS, this.playerTouch);
      if (carry) this.player.applyForce(carry.x, carry.y);
      // Wind, current and point pushers, which unlike a conveyor reach the
      // player alone (`Forces.pushForBody`). "On the ground" is vanilla's
      // `thing->z > thing->floorz` test, which `groundFloor` answers here — a
      // full `checkPosition`, so it is only asked for where a pusher exists.
      if (this.forces.pusherCount > 0) {
        const onGround = this.player.z <= this.world.groundFloor(this.player.x, this.player.y, PLAYER_RADIUS);
        const push = this.forces.pushForBody(this.player, PLAYER_RADIUS, onGround, this.playerTouch);
        if (push) this.player.applyForce(push.x, push.y);
      }
      // What the floor underfoot does to the player's own movement — ice, mud,
      // or (on every map with no 223 line) nothing at all.
      const ground = this.forces.frictionUnder(
        this.player,
        PLAYER_RADIUS,
        Math.hypot(this.player.velX, this.player.velY),
        this.playerTouch,
      );
      // Monsters are solid: the player walks around them, not through them.
      this.player.update(
        dt,
        input,
        at,
        camera.viewerAngleDeg + 180,
        this.things?.solidBodies(this.player),
        ground,
      );
      return { monster: m, cursor: onPlane };
    });

    this.profiler.time('Weapons', () => this.fireWeapons(input, monster));
    this.profiler.time('Player', () => this.collectPickupsAndSectorEffects(dt));

    // Hard landings, and the weapon bookkeeping that has to run after every
    // switch source (`fireWeapons`' `handleSwitching`, a pickup) has had its
    // say — both belong to a living player only.
    if (this.player.landingSpeed > HARD_LANDING_SPEED) this.audio.play('oof', this.player, PLAYER_ORIGIN);
    this.weaponSystem.update(dt, input.mouseDown, this.inventory, this.audio, this.player);
    return cursor;
  }

  /**
   * Weapon switching and this tic's trigger pull, turning each shot `WeaponSystem.fire` returns
   * into a projectile or tracer. `monster` is whatever aim locked onto, which is what lets a shot
   * angle toward its height — see docs/combat.md § Auto-aim.
   */
  private fireWeapons(input: Input, monster: MonsterRef | null): void {
    // A shot always *starts* at the player's own fire height — never the
    // target's, or a tracer/projectile would visibly begin mid-air instead
    // of at the player. The locked-on monster travels with it as the body to
    // aim at; see world.ts's shotPath/blocksShot for why a locked shot is
    // allowed to clear the floor steps a free one is stopped by.
    const fireStartZ = this.player.z + AIM_HEIGHT_OFFSET;

    // Called after player.update so player.angle already reflects this frame's aim.
    this.weaponSystem.handleSwitching(input, this.inventory, input.consumeWheel());
    const shots = this.weaponSystem.fire(input.mouseDown, this.inventory, this.player.angle);
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
      this.projectiles.spawnPlayerShot(shot, fireStartZ, monster);
    }
  }

  /**
   * The two things the player picks up by standing somewhere: items in reach, and whatever the
   * sector underfoot does to them (damage floors, secrets, an exit) — see game/specials/sectoreffects.ts.
   */
  private collectPickupsAndSectorEffects(dt: number): void {
    this.things?.tryPickup(this.player, PICKUP_RANGE, (type, dropped) => {
      const taken = applyPickup(this.inventory, type, dropped, this.skill);
      // The computer area map is the one pickup whose whole effect lives outside the `Inventory`
      // struct: it reveals the level's own geometry. Watched for here rather than handled in
      // `applyPickup` — the same "state there, world effect at the caller" split `tryPickup`
      // already makes for removing the item itself.
      if (taken && type === ThingType.computerMap) this.fogOfWar.revealAll();
      // Unattenuated, as vanilla plays every pickup: you're standing on it.
      if (taken) this.audio.play(pickupSound(type));
      return taken;
    });
    const sectorEffect = this.sectorEffects.update(
      dt,
      this.world,
      this.player,
      this.inventory,
      (amount) => this.damagePlayer(amount, undefined, undefined, 'slime'),
      // A doll standing on a damage floor bleeds the real player.
      this.voodoo.dolls,
    );
    if (sectorEffect.secretFound) {
      this.message.show(SECRET_MESSAGE);
      // Unattenuated, like a pickup: it's an announcement to the player, not a sound in the world.
      this.audio.playAsset('secret');
    }
    // Vanilla's sector type 11 calls `G_ExitLevel`, not `G_SecretExitLevel` — a damage floor that
    // ends the level never leads to the secret one.
    if (sectorEffect.exit) this.pendingExit = 'normal';
  }

  /**
   * The current level's kill/item/secret counts and clock, for the HUD strip every frame and for
   * the intermission on the frame the level ends. Cheap integer reads, assembled fresh rather than
   * cached — see docs/hud.md § Level stats.
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
   * *provides* the map rather than to the loaded set — see docs/hud.md § Best times.
   */
  private recordCompletion(): BestTimeResult | null {
    if (!this.recordsEligible) return null;
    const map = this.currentMap;
    const source = mapProvider(this.wad, map);
    if (!source) return null;
    return recordBestTime(bestTimeKey(source.id, map, this.skill), this.levelTime, {
      wad: source.name,
      map,
      skill: this.skill,
    });
  }

  /**
   * The 2D layers over the level: status bar, crosshair, center message, level card,
   * the screen tints and the death overlay.
   */
  private updateOverlays(dt: number): void {
    this.hud.update(this.inventory, this.levelStats());
    this.crosshair.update(this.inventory.health);
    this.message.update(dt);
    this.levelCard.update(dt);
    this.screenEffects.update(dt, this.inventory);
    this.screenEffects.setColormapTint(this.viewColormap());
    this.deathOverlay.update(dt);
  }

  /**
   * The colour cast the whole view draws under, or null for none: the colormap
   * of the 242 control sector the player is standing in, chosen by eye height
   * against that sector's floor and ceiling as `R_SetupFrame` does — except
   * that the underwater (bottom) colormap is deliberately not applied here.
   * docs/specials.md § Deep water.
   */
  private viewColormap(): ColorTint | null {
    if (this.colormapTints.size === 0) return null;
    const control = this.transfers.heightSec(this.world.sectorIndexAt(this.player.x, this.player.y));
    const tints = control < 0 ? undefined : this.colormapTints.get(control);
    if (!tints) return null;
    const sector = this.world.map.sectors[control];
    const eye = this.player.eyeZ;
    // Below the surface vanilla would cast the whole view through the control
    // sector's bottom colormap; this camera stays above the water while the
    // player sinks, so that blue would recolour a view that is mostly still
    // dry land. docs/specials.md § Deep water.
    if (eye < sector.floorHeight) return null;
    return eye > sector.ceilHeight ? tints.top : tints.mid;
  }

  /**
   * Ticks the thing layer and realizes what it hands back: the monster attacks fired this frame,
   * and any barrel whose `A_Explode` came due. The player goes in as `null` once dead, matching
   * `P_KillMobj` stripping the player's `MF_SHOOTABLE`/`MF_SOLID` — docs/death.md § Player death
   * for what that does and doesn't freeze in the AI.
   */
  private updateThings(dt: number): void {
    // Every attack a monster fired this tic comes back for us to apply/render, the same "system
    // returns data, caller realizes it" split as `WeaponSystem.fire`.
    const thingUpdate = this.profiler.time(
      'Monsters',
      () =>
        this.things?.update(
          dt,
          this.playerDead ? null : this.player,
          (subsector) => this.fogOfWar.isVisible(subsector),
          (prev, mover) => this.thingCrossedLines(prev, mover),
          (pos, radius, cache) => this.forces.carryForBody(pos, radius, cache),
        ) ?? { attacks: [], barrelExplosions: [] },
    );
    this.profiler.time('Monsters', () => {
      this.monsterAttacks.resolve(thingUpdate.attacks);
      // A barrel's own A_Explode, become due this tic (game/things.ts's
      // update() ticks the delay; see applyBarrelExplosion's doc). No visual
      // spawned effect is needed here the way every other explosion needs one —
      // the barrel's own PosedThing is already drawing its BEXP death
      // animation at exactly this spot.
      for (const exp of thingUpdate.barrelExplosions) applyBarrelExplosion(this.combat, exp);
    });
  }

  /**
   * One tic of everything transient: teleport fog, tracers, things in flight, the icon's cubes.
   * Draws nothing — `drawEffects` is the other half.
   *
   * The order is load-bearing and unchanged: projectiles advance before impacts,
   * so an explosion or smoke puff spawned by an arrival this tic is drawn on the
   * very next frame rather than one late.
   */
  private updateEffects(dt: number): void {
    this.profiler.time('Effects', () => {
      this.effects.updateTeleportFogs(dt);
      this.effects.updateTracers(dt);
      this.projectiles.update(dt);
      this.icon?.update(dt);
      this.effects.updateImpacts(dt);
    });
  }

  /** The draw half of `updateEffects`: one begin/end pair around every list that batches a sprite. */
  private drawEffects(alpha: number, viewAngleDeg: number): void {
    this.profiler.time('Effects', () => {
      this.effects.beginFrame(viewAngleDeg);
      this.projectiles.draw(alpha);
      this.icon?.draw(alpha);
      this.effects.draw(alpha);
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
      // whether or not it's currently faded or in view. The offsets advance on
      // the frame clock (`Forces.advanceOffsets`) rather than the tic, so this
      // stays as smooth as the rest of the presentation layer.
      if (this.forces.hasScrollers) {
        this.forces.advanceOffsets(dt);
        this.surfaceScroller.update(this.forces);
      }
      // Same independence, and session-scoped rather than per-map (see its
      // construction in the constructor) — an animated liquid/fire texture keeps
      // cycling across a level transition exactly as it does within one.
      this.animatedTextures.update(dt);
      // Door/lift geometry lives in its own meshes (game/specials.ts), so it
      // carries its own faders rather than the two above.
      this.specials?.updateFading(...camArgs, fadeTargets);
    });
  }

  /**
   * Places the player's own billboard: position, facing, sector light and which
   * animation is due. Positions are interpolated `alpha` through the last tic;
   * the animation still advances on `rawDt`, since it is presentation and its
   * own frame chain is what times it.
   */
  private posePlayer(alpha: number, rawDt: number, viewAngleDeg: number): void {
    const p = this.player;
    const x = p.prevX + (p.x - p.prevX) * alpha;
    const y = p.prevY + (p.y - p.prevY) * alpha;
    const z = p.prevZ + (p.z - p.prevZ) * alpha;
    // Shortest-arc, so a shot fired across the -pi/pi seam doesn't spin the
    // billboard the long way round between two tics.
    let dAngle = p.angle - p.prevAngle;
    dAngle = Math.atan2(Math.sin(dAngle), Math.cos(dAngle));
    const facingDeg = ((p.prevAngle + dAngle * alpha) * 180) / Math.PI;
    const sector = this.world.sectorAt(x, y);
    // player.update (and with it, velX/velY) stops running once dead, so
    // this must not read possibly-stale velocity from the moment of death —
    // not that it would matter anyway, since setPose ignores `animating`
    // entirely once `die()` has been called (see SpriteActor's doc).
    const walking = !this.playerDead && Math.hypot(this.player.velX, this.player.velY) > 1;
    const light = sector ? transfersOf(this.world.map).spriteLight(this.world.sectorIndexAt(x, y)) : 128;
    this.playerActor.setPose(x, y, z, facingDeg, light, rawDt, walking, viewAngleDeg);
  }

  /** DEVMODE's status text. Only ever called while the panel is shown — see `DebugHud.update`. */
  private debugLines(fps: number): string[] {
    const { camera } = this.view;
    const sector = this.world.sectorIndexAt(this.player.x, this.player.y);
    return [
      `${this.currentMap}   ${this.title}`,
      `${fps} fps   ${this.built?.triangles ?? 0} tris   monsters awake ${this.things?.awakeMonsterCount() ?? 0}`,
      `pos ${this.player.x.toFixed(0)}, ${this.player.y.toFixed(0)}   z ${this.player.z.toFixed(0)}   sector ${sector}`,
      `cam ${camera.distance.toFixed(0)}u ${camera.tiltDeg.toFixed(0)}°tilt ${camera.yawDeg.toFixed(0)}°yaw ${
        getCameraMode() === 'auto'
          ? `auto spread ${this.autoCamera.spread.toFixed(2)} ahead ${this.autoCamera.ahead.toFixed(2)}`
          : 'manual'
      }`,
    ];
  }
}
