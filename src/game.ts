/**
 * `Game`: one running level — builds the scene from the WAD, owns the frame/tic loop, and wires
 * every subsystem (world, things, specials, weapons, projectiles, effects, fog of war, HUD, audio)
 * into the simulation order. See docs/frameloop.md.
 */
import * as THREE from 'three';
import type { Wad, WadFile } from './wad/wad.ts';
import { mapProvider, wadId, wadSetId } from './wad/checksum.ts';
import { bestTimeKey, recordBestTime, type BestTimeResult } from './game/besttimes.ts';
import { GraphicsBank, type Bitmap } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap, mapLinedefBytes, type DoomMap } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { DynamicLights, PLAYER_EMITTER_ID } from './render/lights.ts';
import { gldefsFromWad, parseGldefs } from './wad/gldefs.ts';
import { setDrawsOwnPlayer } from './wad/playerskin.ts';
import { AnimatedTextures } from './render/textureanim.ts';
import { buildMapMesh, type BuiltMap } from './render/mapmesh.ts';
import { islandCount } from './render/bsp.ts';
import { PlayerShadow } from './render/playershadow.ts';
import { VoidFloor } from './render/voidfloor.ts';
import { setLevelSky, skyLitSector } from './render/skytint.ts';
import { beginViewDepth } from './render/sectorlight.ts';
import { levelSkyArt } from './wad/campaign/sky.ts';
import { LightVisibility } from './render/lights.ts';
import { SpriteActor, SpriteMaterialCache } from './render/sprites.ts';
import { PlayerSkins } from './render/playerskin.ts';
import type { LoadingScreen } from './ui/loading.ts';
import type { Viewport } from './render/viewport.ts';
import { TopDownCamera } from './render/camera.ts';
import type { TicInput } from './game/input.ts';
import {
  bodiesOverlap,
  buildThingSprites,
  monstersTelefrag,
  TELEFRAG_DAMAGE,
  type CarryQuery,
  type CrossingBody,
  type MonsterRef,
  type ThingLayer,
} from './game/things.ts';
import {
  FULLBRIGHT_FRAMES,
  PLAYER_ACTION_FRAME_SECONDS,
  PLAYER_ATTACK_FRAMES,
  PLAYER_DEATH_FRAME_SECONDS,
  PLAYER_DEATH_FRAMES,
  PLAYER_PAIN_FRAMES,
  obituary,
} from './game/things/tables.ts';
import { thrustSpeed } from './game/monsters/defs.ts';
import { MonsterAttacks } from './game/monsters/attacks.ts';
import { collectFadeTargets, FadePass, FlatFader, WallFader } from './render/occlusion.ts';
import { SurfaceScroller } from './render/scroller.ts';
import { makeTouchCache, World, type Opening, type SectorTouchCache } from './game/world.ts';
import { AIM_HEIGHT_OFFSET, EYE_HEIGHT, HARD_LANDING_SPEED, Player, PLAYER_MASS, PLAYER_RADIUS } from './game/player.ts';
import { applyBarrelExplosion, type CombatContext, type DamageCause } from './game/combat.ts';
import { SpriteFxLayer } from './game/spritefx.ts';
import { ProjectileLayer } from './game/projectiles.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { AutoCamera, getCameraMode } from './game/autocamera.ts';
import { SectorEffects, SpecialsController, type TeleportDest } from './game/specials.ts';
import { addBlockMates, scanSectors } from './game/specials/mapscan.ts';
import type { ShootAim } from './game/specials/shootaim.ts';
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
import { ReplayBar } from './ui/hud/replaybar.ts';
import { Intermission, INTERMISSION_INPUT_DELAY } from './ui/hud/intermission.ts';
import { EndCard, type EndScope } from './ui/hud/endcard.ts';
import { LevelCard } from './ui/hud/levelcard.ts';
import { LevelNames, titleLookupFor } from './wad/campaign/names.ts';
import { parSecondsFor } from './wad/campaign/pars.ts';
import { readDehacked, describeDehacked, type LoadedDehacked } from './game/dehacked.ts';
import { applyDehacked, resetDehacked } from './game/dehacked/apply.ts';
import { LevelProgression } from './wad/campaign/progression.ts';
import {
  CenterMessage,
  lockedLineMessage,
  missingArtMessage,
  SECRET_MESSAGE,
} from './ui/hud/message.ts';
import { DebugHud, handleHotkeys } from './ui/devmode/debughud.ts';
import { getProfilerVisible, ProfilerHud } from './ui/hud/profiler.ts';
import { ScreenEffects } from './ui/hud/screeneffects.ts';
import { DeathOverlay, type DeathHint } from './ui/hud/deathoverlay.ts';
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
import {
  wadSetRefusal,
  type CheckpointStore,
  type SaveCapture,
  type SaveGame,
} from './game/savegames.ts';
import {
  ReplayPlayback,
  ReplayRecorder,
  applySimSettings,
  captureSimSettings,
  quantizePose,
  releaseSimSettings,
  // Ours, not the DOM's animation type of the same name — game.ts sees both.
  type Keyframe,
  type Replay,
  type ReplayCapture,
} from './game/replay.ts';
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
import { Cheats } from './game/cheats.ts';
import { ThingType } from './game/things/doomednums.ts';
import { WEAPONS, WeaponSystem } from './game/weapons.ts';
import type { AudioEngine } from './audio/audio.ts';
import { PLAYER_ORIGIN } from './audio/sfx.ts';
import { SoundBank } from './wad/sound.ts';
import { MusicBank } from './wad/music.ts';
import { MapInfo } from './wad/campaign/mapinfo.ts';
import { LevelMusic } from './audio/music.ts';
import type { Pos2 } from './types.ts';
import { DEVMODE, DOOM_TIC, FOG_START_FRACTION, VIEW_DISTANCE } from './constants.ts';
import { vecLength } from './util/geom.ts';
import { readStorage, writeStorage } from './util/storage.ts';
import { atan2, cos, sin } from './util/fdlibm.ts';

/**
 * Most tics one frame may run before the rest of the banked time is dropped.
 * Bounds both the catch-up burst after a stall and the worst-case cost of a
 * single frame; without it a backgrounded tab returns owing minutes of
 * simulation and spends them all in one frame. Five is ~143ms of debt.
 * docs/frameloop.md § The accumulator.
 */
const MAX_TICS_PER_FRAME = 5;

/**
 * How long one frame may spend running a replay's seek forward. Long enough that a minute of
 * recording catches up in a handful of frames, short enough that the page still answers a click
 * or an ESC between slices — tuned by feel, and it buys more tics than it looks like: the frame
 * it runs in draws nothing. docs/replays.md § Seeking.
 */
const SEEK_BUDGET_MS = 60;

/** `replayAimNdc`'s projection scratch, so the per-frame reticle placement allocates nothing. */
const AIM_SCRATCH = new THREE.Vector3();

/**
 * What a level build costs per KB of `LINEDEFS`, and only the seed for `buildMsPerKb`, which
 * re-measures from every build this session. **Tuned by feel** in that sense: it has to be right
 * enough to put the first level of a session on the correct side of `SLOW_LOAD_MS`, and the
 * measurements it came from are in the commit that added it.
 */
const BUILD_MS_PER_KB = 1.1;

/**
 * How slow a level load has to be predicted to be before it gets the loading screen rather than
 * just happening. **Tuned by feel**: below this the overlay is up for fewer frames than it takes to
 * read, which is a flicker rather than feedback. docs/menu.md § The loading screen.
 */
const SLOW_LOAD_MS = 200;

const FPS_CAP_STORAGE_KEY = 'fpsCap';

/** The frame rates the menu offers; `0` is no cap, `60` the default. */
const FPS_CAPS = [0, 30, 60, 120] as const;
export type FpsCap = (typeof FPS_CAPS)[number];

/**
 * What a player who has never touched the setting runs at. **Tuned by feel**: the simulation is
 * 35 Hz either way (docs/frameloop.md § The FPS cap), so frames past 60 buy little here and cost a
 * laptop its fans; a player who wants them says so in the menu.
 */
const DEFAULT_FPS_CAP: FpsCap = 60;

/**
 * How many frames a second the loop is allowed to run at, `0` for as many as the
 * display offers. Lives here because `frame` is the only thing it changes; the
 * menu just wires its select to these two. See docs/frameloop.md § The FPS cap.
 */
let fpsCap: FpsCap = readStoredFpsCap();

export function getFpsCap(): FpsCap {
  return fpsCap;
}

export function setFpsCap(cap: FpsCap): void {
  fpsCap = cap;
  writeStorage(FPS_CAP_STORAGE_KEY, cap);
}

/**
 * What a `Game` is being asked to play, beside the three handles it is given. Named rather than
 * positional because `startMap` and `title` are both strings and a swap would typecheck.
 */
export interface GameOptions {
  /**
   * Map lump to start on; the set's first map when it holds no such lump and nothing is
   * restored.
   */
  startMap: string;
  /** A short label naming the WAD set, for the HUD. */
  title: string;
  skill: Skill;
  /**
   * `?pos=` — where to drop the player instead of the map's own start
   * (docs/menu.md § URL parameters).
   */
  startPos?: Pos2 | null;
  /**
   * A savegame's state payload: the level is built normally, then overwritten step by step —
   * docs/savegames.md § Apply order.
   */
  restore?: GameSnapshot | null;
  /** The checkpoint store, taken as a port so this class still knows nothing about IndexedDB. */
  checkpoint?: CheckpointStore | null;
  /**
   * Called when the campaign is over and nothing follows: the session layer's cue to tear this
   * `Game` down and put the menu back up (docs/menu.md § Session lifecycle). A port like
   * `checkpoint` — this class knows nothing about the menu.
   */
  onCampaignEnd?: (() => void) | null;
  /**
   * The stock GLDEFS text (`assets/gldefs.txt`, via the shipped WAD), fetched by the session layer
   * alongside the WAD files. A loaded set's own GLDEFS lumps layer over it; an empty string means
   * no lights at all. docs/lights.md.
   */
  gldefsText?: string;
  /**
   * The shipped weapon-matching player art (`assets/playerskins.wad`, via the shipped WAD), fetched
   * by the session layer alongside the WAD files and deliberately **never** added to `wad` — see
   * `buildPlayerSkins`. Null when the fetch failed, which draws the set's own `PLAY` art.
   * docs/sprites.md § Weapon-matching player sprites.
   */
  playerSkins?: WadFile | null;
  /**
   * The session's loading screen, so a level too big to build between two frames can put it up
   * first. A port like `checkpoint`: absent means the load simply happens inline.
   * docs/menu.md § The loading screen.
   */
  loading?: LoadingScreen | null;
  /**
   * A replay to play instead of taking live input: `restore` is then its first snapshot, and the
   * level starts under its recorded camera and settings. A constructor option rather than a
   * method because a playback always begins with a load. docs/replays.md § Playback.
   */
  playback?: Replay | null;
  /**
   * Stores the current moment as a savegame — the session layer's store call around `saveVia`.
   * Taking a replay over calls it, so the level the player is handed is one they can come back to.
   * Absent means taking over stores nothing.
   */
  autoSave?: (() => Promise<unknown>) | null;
}

/** One loaded WAD set, playing one level at a time. */
export class Game {
  private scene = new THREE.Scene();
  private materials: MaterialBank;
  /** The set's own graphics — held for the sky each level reads its outdoor tint from. */
  private gfx: GraphicsBank;
  /** Which sky each level names for itself, where the set's MAPINFO says — docs/wad.md § The sky texture. */
  private mapInfoSkies: Map<string, string>;
  /**
   * The frame's dynamic lights. Session-scoped, like the banks around it: the GLDEFS table comes
   * from the loaded WAD set, not from which map is up. docs/lights.md.
   */
  private lights: DynamicLights;
  private spriteBank: SpriteBank;
  private spriteMaterials: SpriteMaterialCache;
  /** The shipped weapon-matching art, or null where the file never arrived (render/playerskin.ts). */
  private playerSkins: PlayerSkins | null = null;
  /** Whether the loaded set draws the player its own way — resolved once, per `setDrawsOwnPlayer`. */
  private setDrawsPlayer = false;
  private mapNames: string[];
  private mapIndex = 0;

  private map!: DoomMap;
  /**
   * Whether a *monster* arriving on a teleport pad telefrags rather than being turned back by what
   * stands there — `monstersTelefrag`, resolved per level.
   */
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
  /**
   * The disc under the player's feet. Session-scoped like `playerActor`: it is placed from the
   * frame's own interpolated position and owns nothing per-level. docs/render.md § The player's
   * shadow.
   */
  private playerShadow = new PlayerShadow();

  /** The ground the level stands in, rebuilt per map. docs/render.md § The void floor. */
  private voidFloor: VoidFloor | null = null;
  /**
   * The level's static wall/flat faders and the bags every fader on the map
   * files into — see `FadePass`, which owns the order the frame runs them in.
   */
  private fadePass!: FadePass;
  /**
   * The fade's opening lookup. A field so the frame allocates none; it reads `world` per call, so a
   * level change needs no rebind.
   */
  private readonly openingInto = (line: number, out: Opening) => this.world.openingInto(line, out);
  private surfaceScroller!: SurfaceScroller;
  /** The level's always-on parameter lines — scrollers and conveyors (game/specials/forces.ts). */
  private forces!: Forces;
  /**
   * `Forces.carryForBody` bound once rather than per tic: `ThingLayer.update` takes it or
   * `undefined`, and building the closure at the call site allocated one every frame.
   */
  private carryForBody: CarryQuery = (pos, radius, cache) => this.forces.carryForBody(pos, radius, cache);
  /**
   * The level's Boom render transfers (game/specials/transfers.ts) — read per frame for the view
   * colormap.
   */
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
  /**
   * Teleport fog, impact explosions, the smoke trail, the vile's flame and hitscan tracers — see
   * game/spritefx.ts.
   */
  private effects: SpriteFxLayer;
  /** Everything in flight, player's and monsters' alike — see game/projectiles.ts. */
  private projectiles: ProjectileLayer;
  /**
   * Turns the attacks `ThingLayer.update` reports into damage, tracers and effects — see
   * game/monsters/attacks.ts.
   */
  private monsterAttacks: MonsterAttacks;
  /**
   * The live-level view `projectiles`, `monsterAttacks` and the splash helpers read this class
   * through — see game/combat.ts.
   */
  private combat: CombatContext;
  private weaponSystem = new WeaponSystem();
  /**
   * Set by the exit trigger and consumed right after `specials.update()` returns — **never** loaded
   * from inside the callback itself, or a mover rebuild still pending from that same `update()`
   * would add the old map's mesh to the new map's scene. Which of the two exits fired is carried
   * along, since it decides where the level leads.
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
  /**
   * Damage floors and the secret counter for the current map — see game/specials/sectoreffects.ts.
   */
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
   * Real time banked but not yet spent on a tic, always under `DOOM_TIC` once
   * `frame` has drained it. Doubles as the interpolation alpha's numerator — see
   * docs/frameloop.md § The accumulator.
   */
  private accumulator = 0;
  /**
   * A level load parked for the next frame with the loading screen up, as the thunk that performs
   * it — every caller's own body differs, and only `loadLevel` decides whether to park one.
   * docs/frameloop.md § A parked level load.
   */
  private pendingLoad: (() => void) | null = null;
  /**
   * `BUILD_MS_PER_KB` re-measured from the builds this session, so the prediction is *this*
   * machine's speed rather than the reference machine's after the first level.
   */
  private buildMsPerKb = BUILD_MS_PER_KB;
  /**
   * Timestamp of the previous rendering opportunity, skipped ones included — the display's own
   * period. See `dueThisFrame`.
   */
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
  /** The playback bar; hidden outside a replay. docs/replays.md § Playback. */
  private replayBar: ReplayBar;
  /** The session's savegame writer, called when a replay is taken over — see `GameOptions`. */
  private autoSave: (() => Promise<unknown>) | null;
  /**
   * The camera the **simulation** reads — normally the viewport's own, and during a playback a
   * private one that evolves from the record alone, so that looking around cannot change what the
   * run does. docs/replays.md § Playback.
   */
  private simCamera: TopDownCamera;
  /** Center-screen text — currently only the secret-found line (see `SECRET_MESSAGE`). */
  private message: CenterMessage;
  /** The "Entering / <level name>" card every map load raises — see ui/hud/levelcard.ts. */
  private levelCard: LevelCard;
  /** The end-of-level popup — see ui/hud/intermission.ts and `popup`. */
  private intermission: Intermission;
  /** The campaign-over card the popup hands over to — see ui/hud/endcard.ts and `popup`. */
  private endCard: EndCard;
  /**
   * The set's DEHACKED/BEX patch, or null for a set with none. Read once per `Game` like the banks
   * beside it: which patch applies depends on the file set, not on the current map.
   * docs/dehacked.md.
   */
  private dehacked: LoadedDehacked | null;
  /**
   * Names levels for the card: MAPINFO, then the vanilla title table — see wad/campaign/names.ts.
   */
  private levelNames: LevelNames;
  /** The WAD set's `D_*` lumps, and the MAPINFO overrides of which one a level plays. */
  private levelMusic: LevelMusic;
  /**
   * Where each exit leads: MAPINFO, then vanilla's own tables — see wad/campaign/progression.ts.
   */
  private progression: LevelProgression;
  /**
   * Measurement itself always runs — `performance.now()` calls are cheap enough
   * not to bother gating; only what `ProfilerHud` draws of it follows the
   * overlay's setting.
   */
  private profiler = new FrameProfiler();
  private profilerHud = new ProfilerHud();
  private debugHud = new DebugHud();
  private screenEffects: ScreenEffects;
  private deathOverlay: DeathOverlay;
  /**
   * Built in the constructor body rather than here: a field initializer runs *before* it, and the
   * starting health and bullets come off `LIMITS`, which a `Misc` patch has not yet moved at that
   * point. docs/dehacked.md § Applying: reset, then patch.
   */
  private inventory: Inventory;
  /**
   * True once the player's health has hit 0 — freezes movement/aim/firing/pickups (see `frame`)
   * until `restart`.
   */
  private playerDead = false;
  readonly title: string;

  /**
   * Where the level-entry checkpoint is kept, or null when nothing is offering
   * one (the tests, mainly). docs/savegames.md § The checkpoint.
   */
  private checkpoint: CheckpointStore | null;
  /** What the last exit of the last level calls — see the constructor parameter. */
  private onCampaignEnd: (() => void) | null;
  /** The session's loading screen, or null where nothing offers one (the tests). */
  private loading: LoadingScreen | null;
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
   * Whether *this level's* completion is disqualified from best times. A `?pos=` start can drop the
   * player anywhere — next to the exit included — and a taken-over replay was someone else's run up
   * to that point, so neither may set a record; the next level entered through an exit is the
   * player's own again. A cheat outlives the level, through `Cheats.used`
   * (docs/hud.md § Best times). Decided up front because `startPos` is nulled out once the first
   * map has consumed it.
   */
  private cheated: boolean;
  /**
   * The typed cheat codes and the two toggles they leave on. Owned by the session, not the level:
   * an exit carries them into the next map the way vanilla's `player_t.cheats` does.
   * docs/cheats.md.
   */
  private cheats = new Cheats();
  /**
   * What the tic reads its input through instead of the live `Input` while a replay is being
   * recorded or played — see the two getters below it. docs/replays.md.
   */
  private replay: ReplayRecorder | ReplayPlayback | null = null;
  /**
   * The keyframe a jump in progress still has to restore, and whether the bar's marker has had a
   * frame to itself yet. Null once it is restored, and for a jump that needs no anchor at all.
   * docs/replays.md § Seeking.
   */
  private seekAnchor: { frame: Keyframe; announced: boolean } | null = null;

  constructor(view: Viewport, audio: AudioEngine, wad: Wad, options: GameOptions) {
    const {
      startMap,
      title,
      skill,
      startPos = null,
      restore = null,
      checkpoint = null,
      onCampaignEnd = null,
      gldefsText = '',
      playerSkins = null,
      loading = null,
      playback = null,
      autoSave = null,
    } = options;
    this.view = view;
    this.simCamera = view.camera;
    this.audio = audio;
    this.wad = wad;
    this.title = title;
    this.skill = skill;
    this.startPos = startPos;
    this.checkpoint = checkpoint;
    this.onCampaignEnd = onCampaignEnd;
    this.loading = loading;
    this.savedState = restore;
    // From the save when restoring: a `?pos=` run must not shed the flag by being saved and loaded
    // back (docs/hud.md § Best times). A playback inherits the recording's own verdict with its
    // first snapshot, so the intermission reports what the recording player did rather than the
    // fact of being a replay; whether a best time may actually be *written* is
    // `recordCompletion`'s separate question.
    this.cheated = restore ? restore.cheated : startPos !== null;
    // Primed here, where a one-off scan of each file's bytes disappears into a load that is about
    // to build every mesh in the level, so the exit frame only ever hits the memo.
    for (const file of wad.files) wadId(file);

    this.scene.background = new THREE.Color(0x05050a);
    this.scene.fog = new THREE.Fog(0x05050a, VIEW_DISTANCE * FOG_START_FRACTION, VIEW_DISTANCE);

    // Ahead of every bank below and of `buildThingSprites`: a patch's sound and thing edits have
    // to be in place before anything reads a table — `SoundBank` pre-decodes on construction, so
    // a `[SOUNDS]` redirect applied after it could never reach the cache.
    // docs/dehacked.md § Applying: reset, then patch.
    this.dehacked = readDehacked(wad, titleLookupFor());
    // Reset first, then patch, so a session reads the same tables whatever the previous one
    // loaded. `readDehacked` ahead of both is deliberate: parsing reads nothing mutable.
    resetDehacked();
    if (this.dehacked) {
      applyDehacked(this.dehacked);
      const { applied, skipped } = describeDehacked(this.dehacked);
      if (applied) console.info(applied);
      if (skipped) console.warn(skipped);
    }
    // After the patch, never as a field initializer: `Misc`'s `Initial Health`/`Initial Bullets`
    // are read here (see the field's own note).
    this.inventory = createInventory();
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
    this.mapInfoSkies = mapInfo.skies();
    audio.music.setBank(musicBank);

    const gfx = new GraphicsBank(wad);
    this.gfx = gfx;
    // Built before the materials: every one of them is patched against these uniform objects as it
    // is compiled, and the set holds for the whole session (docs/lights.md § Two lighting paths).
    this.lights = new DynamicLights(gldefsFromWad(wad, parseGldefs(gldefsText)));
    this.materials = new MaterialBank(gfx, view.renderer, this.lights.uniforms);
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
    this.spriteMaterials = new SpriteMaterialCache(gfx, view.renderer, this.spriteBank.lumpNames);
    // After `applyDehacked`, which both the bank and the predicate read: a patch may have pointed
    // `PLAY` somewhere else.
    this.setDrawsPlayer = setDrawsOwnPlayer(wad);
    if (playerSkins) this.playerSkins = new PlayerSkins(playerSkins, gfx.palette, view.renderer);
    this.hud = new Hud(gfx);
    this.message = new CenterMessage(gfx);
    this.levelCard = new LevelCard(gfx);
    this.intermission = new Intermission(gfx);
    this.endCard = new EndCard(gfx);
    this.deathOverlay = new DeathOverlay(gfx);
    // Session-scoped like the banks above: which titles apply depends on the loaded file set
    // (its MAPINFO lumps and which IWAD it is), not on the current map.
    this.levelNames = new LevelNames(wad, mapInfo, this.dehacked);
    this.crosshair = new Crosshair(view.renderer.domElement);
    this.autoSave = autoSave;
    this.replayBar = new ReplayBar({ takeOver: () => this.takeOver(), seek: (tic) => this.seekTo(tic) });
    this.mapNames = wad.mapNames();
    if (this.mapNames.length === 0) throw new Error('no maps in the selected WADs');
    // After `mapNames`: a progression may only name a level the loaded set actually provides.
    this.progression = new LevelProgression(mapInfo, this.mapNames);

    // PLAY's own walk cycle: DOOM has no separate idle art, it just holds
    // frame A (this list's first entry) until the player is actually moving.
    // `FULLBRIGHT_FRAMES` lights the muzzle frame (`PLAY F`) the way vanilla does.
    this.playerActor = new SpriteActor(this.spriteBank, this.spriteMaterials, {
      spriteName: 'PLAY',
      animFrames: ['A', 'B', 'C', 'D'],
      brightFrames: FULLBRIGHT_FRAMES,
    });
    this.scene.add(this.playerActor.mesh);
    this.scene.add(this.playerShadow.mesh);
    // The vile-flame resolver is `monsterAttacks`', not the batch's — where the
    // flame belongs depends on live monster/player state. Both callbacks are
    // reached through a closure because `monsterAttacks` and `fogOfWar` are both
    // built after `effects` (the fog on every level load), and neither is called
    // before a frame runs, long after all three exist.
    this.effects = new SpriteFxLayer(this.scene, {
      spriteBank: this.spriteBank,
      spriteMaterials: this.spriteMaterials,
      audio,
      resolveVileFlame: (vileId, targetId) => this.monsterAttacks.vileFlameFor(vileId, targetId),
      fogVisible: (subsector) => this.fogOfWar.isVisible(subsector),
      lights: this.lights,
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
      damagePlayer: (amount, fromX, fromY, cause) => this.damagePlayer(amount, fromX, fromY, cause),
      triggerShot: (lineIndex, byMonster) => this.specials?.triggerShot(lineIndex, this.inventory.keys, byMonster),
      triggerShotPath: (from, to, blocker, byMonster) =>
        this.specials?.triggerShotPath(from, to, blocker, this.inventory.keys, byMonster),
    };
    this.projectiles = new ProjectileLayer(this.combat, {
      effects: this.effects,
      spriteBank: this.spriteBank,
      spriteMaterials: this.spriteMaterials,
      audio,
    });
    this.monsterAttacks = new MonsterAttacks(this.combat, this.effects, this.projectiles, audio, () =>
      hasPower(this.inventory, 'invisibility'),
    );

    // Bound once rather than per frame: neither the billboard nor the disc under it is ever
    // reassigned.
    this.screenEffects = new ScreenEffects(view.renderer, (opacity) => {
      this.playerActor.setOpacity(opacity);
      this.playerShadow.setOpacityScale(opacity);
    });

    const wanted = this.mapNames.indexOf(startMap.toUpperCase());
    // The first-map fallback is fine for a fresh start, but a restore's things
    // and sectors only make sense on the exact map they were saved on.
    if (restore && wanted < 0) throw new Error(`the selected WADs have no map ${startMap.toUpperCase()}`);
    this.loadMapByIndex(wanted >= 0 ? wanted : 0, restore);
    // After the load, which snapped the camera the way a save restore does: the recording's camera
    // was mid-glide, and its settings are the run's. docs/replays.md § Camera state.
    if (playback) {
      this.replay = new ReplayPlayback(playback);
      // A camera of its own, so the viewer's can be moved without moving the ray the picks are
      // cast along — `syncViewCamera` is what the drawn one follows.
      this.simCamera = new TopDownCamera(view.camera.camera.aspect);
      // The record's own first pose, on both cameras: the level load left them framed on the
      // player start, which is not where the recording was looking from.
      const start = this.replay.poseAt(0);
      if (start) {
        this.simCamera.snapPose(start);
        view.camera.snapPose(start);
      }
      applySimSettings(playback.data.settings);
      this.crosshair.detach(true);
    }
  }

  /** The recorder in charge, if a replay is being recorded. Routed through a getter — see CLAUDE.md. */
  private get recorder(): ReplayRecorder | null {
    return this.replay instanceof ReplayRecorder ? this.replay : null;
  }

  private get playback(): ReplayPlayback | null {
    return this.replay instanceof ReplayPlayback ? this.replay : null;
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  /**
   * Why a recording can't start now, or null: a replay playing, one already recording, a cheat
   * code half typed (the buffer is in no snapshot), or any moment a save would be refused —
   * a recording starts by capturing one. Said in the recording's own words, since a player who
   * pressed Record is not being told about saving. docs/replays.md § Recording.
   */
  recordingRefusal(): string | null {
    if (this.playback) return "you can't record while a replay is playing";
    if (this.recorder) return 'already recording';
    if (this.cheats.typing) return 'finish typing the cheat code first';
    const moment = this.blockedMoment();
    return moment === null ? null : `you can't start recording ${moment}`;
  }

  /**
   * Starts recording from this moment. The level is **reloaded from the capture** first, so the
   * run being recorded is exactly what a playback restores, transients and all — and the camera
   * is put back mid-glide afterwards, since the reload snapped it. Throws `recordingRefusal`.
   * docs/replays.md § Recording.
   */
  startRecording(): void {
    const refusal = this.recordingRefusal();
    if (refusal) throw new Error(refusal);
    const camera = this.simCamera.snapshot();
    const auto = this.autoCamera.snapshot();
    // Elided: this is a replay's snapshot 0, and the reload below re-spawns the things it leaves
    // out — docs/replays.md § The record.
    const capture = this.captureSave({ thumbnail: false });
    const entering = this.levelTime === 0;
    this.loadMapByIndex(this.mapIndex, capture.state);
    this.simCamera.restore(camera);
    this.autoCamera.restore(auto);
    // A reload shows no card, but a recording that begins as the level does still is arriving.
    if (entering) this.levelCard.show(this.levelNames.nameFor(this.currentMap), this.levelNames.graphicFor(this.currentMap));
    this.replay = new ReplayRecorder(this.view.input, {
      capture,
      pose: quantizePose(this.simCamera.pose()),
      settings: captureSimSettings(),
      devmode: DEVMODE,
    });
  }

  /** Ends the recording and hands it over for the store; null when none was running. */
  finishRecording(): ReplayCapture | null {
    const recorder = this.recorder;
    if (!recorder) return null;
    this.replay = null;
    return recorder.finish();
  }

  /**
   * Hands a replay's level to the player right here: live input from the next tic, settings back
   * to the stored ones. `cheated` stays set — the run up to here was not theirs.
   * docs/replays.md § Playback.
   */
  takeOver(): void {
    if (!this.playback) return;
    releaseSimSettings();
    this.replay = null;
    // The viewport's camera takes the simulation back over, at the pose it is being drawn at, so
    // taking over in the manual view keeps the view the player is looking at.
    this.simCamera = this.view.camera;
    // The auto camera stood still through the playback (the pose came from the record), so it is
    // seeded here rather than left to glide in from wherever the last level load left it.
    this.autoCamera.seed(this.player, this.simCamera);
    this.view.input.reset();
    this.crosshair.detach(false);
    // The run up to here was the recording's, so nothing from it may set a best time.
    this.cheated = true;
    // Taking over mid-death or on the intermission hands those keys back to the viewer, and the
    // popup on screen was drawn without their hint. docs/replays.md § Playback.
    this.deathOverlay.setHint(this.deathHint());
    this.intermission.setContinueHint(this.viewerContinues);
    this.endCard.setContinueHint(this.viewerContinues);
    void this.saveTakeOver();
  }

  /**
   * The savegame taking over writes, so the handed-over level is one the player can come back to —
   * and, through `saveVia`, what `R` reloads from here on. Reported in the center message rather
   * than on the bar, which is gone by the time it lands; a refused moment (an intermission, a
   * corpse) says so there and takes nothing else down with it. docs/replays.md § Playback.
   */
  private async saveTakeOver(): Promise<void> {
    if (!this.autoSave) return;
    try {
      await this.autoSave();
      this.message.show('game saved');
    } catch (err) {
      this.message.show((err as Error).message);
    }
  }

  /**
   * Jumps the playback to `tic`. The state comes from the last keyframe at or before it and the
   * tics from there to the target are then run, which `runSeek` does over the frames that follow —
   * a jump that stays ahead of the current position and passes no keyframe needs no restore and
   * runs on from here. docs/replays.md § Seeking.
   */
  seekTo(tic: number): void {
    const playback = this.playback;
    if (!playback) return;
    const target = Math.max(0, Math.min(playback.ticCount, Math.round(tic)));
    const anchor = playback.keyframeAt(target);
    playback.seekBack = target < playback.cursor;
    // Restored by `runSeek` rather than here: the level build it costs blocks the page for as long
    // as any map load, and the bar's marker is meant to be up before it does.
    const needed = target < playback.cursor || anchor.tic > playback.cursor;
    this.seekAnchor = needed ? { frame: anchor, announced: false } : null;
    playback.seekTarget = target;
  }

  /**
   * One frame of a jump in progress: the marker alone on the first, then the keyframe restore, then
   * the catch-up tics. The level's picture stands untouched throughout and is only drawn again once
   * the target lands — running the tics on screen would play the level at speed under a camera that
   * moves only at the end. docs/replays.md § Seeking.
   */
  private runSeek(playback: ReplayPlayback, rawDt: number): void {
    const pending = this.seekAnchor;
    if (pending !== null && !pending.announced) {
      pending.announced = true;
      this.replayBar.update(playback, null, this.inventory.health);
      return;
    }
    if (pending !== null) {
      this.seekAnchor = null;
      this.applyKeyframe(pending.frame, playback);
    }
    const swapped = this.advanceSeek(playback);
    // The target landed: draw it. A tic that swapped the level leaves the next frame to do it.
    if (playback.seekTarget === null && !swapped) {
      this.profiler.beginFrame();
      this.draw(1, rawDt, false);
    } else {
      this.replayBar.update(playback, null, this.inventory.health);
    }
  }

  /** The world as `frame` held it at that anchor, cameras and pinned settings included. */
  private applyKeyframe(frame: Keyframe, playback: ReplayPlayback): void {
    const state = playback.replay.data.snapshots[frame.snapshot];
    const index = this.mapNames.indexOf(frame.map);
    this.audio.stopAll();
    this.loadMapByIndex(index >= 0 ? index : this.mapIndex, state);
    // Not part of what `loadMapByIndex` restores — it is the session's, and only a load that
    // starts a session (the constructor) reads it from a snapshot. A seek past a cheat the
    // recording typed has to arrive with the recording's own verdict on the run.
    this.cheated = state.cheated;
    playback.seek(frame.tic);
    // The pose of the tic being landed on, snapped rather than glided into: the camera was
    // somewhere else entirely a moment ago. docs/replays.md § Camera state.
    const pose = playback.poseAt(frame.tic);
    if (pose) this.forEachCamera((camera) => camera.snapPose(pose));
    applySimSettings(playback.settings);
    // The state is the record's own again, so whatever had drifted before this point is gone.
    playback.desyncedAt = null;
  }

  /**
   * One frame's share of a seek's catch-up: tics run as fast as they will inside `SEEK_BUDGET_MS`,
   * with sound off. True when a tic swapped the level, which ends the slice and the frame with it —
   * everything the draw would touch has just been rebuilt. docs/replays.md § Seeking.
   */
  private advanceSeek(playback: ReplayPlayback): boolean {
    const target = playback.seekTarget;
    if (target === null) return false;
    const until = performance.now() + SEEK_BUDGET_MS;
    let swapped = false;
    this.audio.setSilent(true);
    try {
      while (!swapped && playback.cursor < target && playback.hasTic) {
        this.replayBeginTic();
        swapped = this.tic(playback, this.simCamera);
        // The timed overlays' clocks run on frames, and a catch-up draws none: without this a
        // secret found at 0:10 is still announced on a landing at 0:30. Ticked in sim time, so
        // what the landing tic would show when watched is what it shows. docs/replays.md § Seeking.
        this.message.update(DOOM_TIC);
        this.levelCard.update(DOOM_TIC);
        this.deathOverlay.update(DOOM_TIC);
        if (performance.now() >= until) break;
      }
    } finally {
      this.audio.setSilent(false);
    }
    if (playback.cursor < target && playback.hasTic) return swapped;
    playback.seekTarget = null;
    this.syncViewCamera(DOOM_TIC);
    // Every hit the catch-up ran through added to the damage flash, none of which the viewer saw —
    // undropped, the frame the jump lands on opens red over a fight that is already over. The
    // sound's own answer to the same problem is `setSilent` above. docs/replays.md § Seeking.
    this.screenEffects.clearPain();
    // The catch-up took real time no tic is owed for, and the frame it ends on draws the target.
    this.resyncClock();
    return swapped;
  }

  get currentMap(): string {
    return this.mapNames[this.mapIndex];
  }

  /**
   * Why this moment can't be saved, or null when it can — death, a pending exit and the
   * intermission are refused. A sentence rather than a flag because it is what the player is told.
   * docs/savegames.md § What is saved and what is deliberately not.
   */
  saveRefusal(): string | null {
    const moment = this.blockedMoment();
    return moment === null ? null : `you can't save ${moment}`;
  }

  /**
   * The moment a state capture is refused at, as the clause both refusals end in, or null. One
   * list, two verbs: what stops a save stops a recording from starting, and each says so in its
   * own words. Deliberately narrower than `levelEnding`: the Icon of Sin's death cascade stays
   * saveable, since `IconSnapshot` carries `exitTimer`.
   */
  private blockedMoment(): string | null {
    if (this.playerDead) return 'while dead';
    if (this.popup === 'intermission') return 'during the intermission';
    if (this.popup === 'endcard') return 'once the campaign is over';
    if (this.pendingExit) return 'while the level is exiting';
    return null;
  }

  /**
   * Saves this moment through the caller's writer — the menu's Save and Overwrite, whose store call
   * is all that differs. The capture, the write and `savedState` stay together because only a write
   * that actually stored the bytes may move what `R` reloads (docs/death.md § Player death).
   * Refuses by *throwing*, the save path's one refusal convention (docs/savegames.md § What is
   * saved and what is deliberately not).
   */
  async saveVia(write: (capture: SaveCapture) => Promise<unknown>): Promise<void> {
    const capture = this.captureSave();
    await write(capture);
    this.savedState = capture.state;
  }

  /**
   * Starts the frame clock over: whatever real time just passed — paused behind the menu, or spent
   * building a level — is not simulation time, and running it back as a catch-up burst of tics is
   * exactly what `accumulator` must not carry. `nextFrameAt` is zeroed rather than advanced, since
   * the first frame after is always due and `dueThisFrame` resyncs off its own timestamp.
   * docs/frameloop.md § The accumulator.
   */
  private resyncClock(): void {
    this.lastTime = performance.now();
    this.lastRaf = this.lastTime;
    this.accumulator = 0;
    this.nextFrameAt = 0;
  }

  resume(): void {
    if (this.running) return;
    // The bar's `Space` is the viewer's again, now that the menu is not reading keys.
    this.replayBar.setKeysActive(true);
    // Reached from the Start button or ESC, i.e. from a real user gesture —
    // which is the only way a browser lets an AudioContext start.
    this.audio.resume();
    this.paused = false;
    this.running = true;
    this.resyncClock();
    // Music kept playing behind the menu, and no frame was there to report what
    // it cost; charging all of it to the first frame back would spike the
    // profiler's `Music` bar for seconds. Discarded like the accumulator above.
    this.audio.music.takeRenderMs();
    this.view.input.reset();
    requestAnimationFrame(this.frame);
  }

  pause(): void {
    if (this.paused) return; // a second call would leave two `stillFrame` loops running
    this.replayBar.setKeysActive(false);
    this.stop();
    this.paused = true;
    // ESC landing in the one frame a parked load waits out: the pause screen is about to show the
    // level behind it, so build that level now rather than leaving the overlay covering the menu.
    this.flushPendingLoad();
    requestAnimationFrame(this.stillFrame);
  }

  dispose(): void {
    // Read by `resumeFromCheckpoint`, whose store read can still be in flight.
    this.disposed = true;
    this.stop();
    // A recording is finished by the session layer before this; a playback's pins come off here.
    if (this.playback) releaseSimSettings();
    this.replay = null;
    this.crosshair.detach(false);
    this.replayBar.dispose();
    // The engine is session-level and the next Game sets its own bank; this
    // only makes sure nothing from this level is left holding a channel.
    this.audio.stopAll();
    // The music would otherwise keep playing over the menu once this level is gone.
    this.audio.music.stop();
    this.screenEffects.reset();
    // Like `screenEffects`, these elements outlive the Game that drove them — without
    // this the menu (and the next level started from it) inherits the line.
    this.clearOverlays();
    this.playerActor.dispose();
    this.playerShadow.dispose();
    this.disposeLevelGeometry();
    this.effects.dispose();
    this.materials.dispose();
    this.spriteMaterials.dispose();
    this.playerSkins?.dispose();
  }

  /** Clears the per-level 2D overlays, shared by `dispose` and every map load. */
  private clearOverlays(): void {
    this.deathOverlay.clear();
    this.message.clear();
    this.levelCard.clear();
    this.intermission.clear();
    this.endCard.clear();
  }

  /**
   * Releases the current level's scene content: the mover-owned meshes (`specials`), the static
   * batches, the thing sprites and the void floor. The batched sprite meshes/materials are
   * per-level; the
   * geometry and textures behind them belong to `spriteMaterials`, which outlives a map.
   */
  private disposeLevelGeometry(): void {
    this.specials?.dispose();
    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
    }
    if (this.things) {
      this.scene.remove(this.things.group);
      this.things.dispose();
    }
    if (this.voidFloor) {
      this.scene.remove(this.voidFloor.mesh);
      this.voidFloor.dispose();
      this.voidFloor = null;
    }
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
   * The full state of this moment plus a thumbnail, ready for the store; throws `saveRefusal`'s
   * reason when there is one. Only the store's own bookkeeping (ID, name, date) is the caller's to
   * add — a capture identifies its WAD set by content, so this class knows nothing about the
   * library it was picked from.
   */
  private captureSave(options: { thumbnail?: boolean } = {}): SaveCapture {
    const { thumbnail = true } = options;
    const refusal = this.saveRefusal();
    if (refusal) throw new Error(refusal);
    return {
      map: this.currentMap,
      skill: this.skill,
      wads: wadSetId(this.wad),
      // A level is running, so the map has a provider; `''` would only mean the
      // save asks for its whole set back, which is the safe way to be wrong.
      mapWad: mapProvider(this.wad, this.currentMap)?.id ?? '',
      // Only when a patch was actually applied: an empty list would read the same as absent, and
      // absent is what an unpatched save means. docs/dehacked.md § Savegames and patched tables.
      ...(this.dehacked ? { patchWads: this.dehacked.sources.map((f) => wadId(f)) } : {}),
      levelTime: this.levelTime,
      // The checkpoint passes `false`: it is never listed, so nothing would ever
      // draw its thumbnail, and taking one costs a full extra render.
      thumb: thumbnail ? this.captureThumbnail() : '',
      state: {
        levelTime: this.levelTime,
        cameraYawDeg: this.simCamera.yawDeg,
        cheated: this.cheated,
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
        // Only while one is actually on: an honest run's save carries nothing, which is what a
        // save from before cheats existed also carries. docs/cheats.md § Saves and best times.
        ...(this.cheats.used ? { cheats: this.cheats.snapshot() } : {}),
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
    this.view.present(this.scene, this.view.camera.camera);
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
    this.clearOverlays();
    this.screenEffects.clearPain();
    this.popup = null;
    this.pendingEnd = null;
    this.playerActor.revive();
    this.mapIndex = this.wrapIndex(index);
    const name = this.mapNames[this.mapIndex];
    this.recorder?.levelLoaded(name);
    // Before the map is built rather than after: the track outlives the load,
    // and `play` is a no-op when the level being entered wants the same one.
    this.audio.music.play(this.levelMusic.trackFor(name));

    this.disposeLevelGeometry();

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
    // One scan, two sets: everything that must leave the static batch, and the
    // subset of it that actually moves a vertex — see `MapMeshOptions.movingSectors`.
    const { moving: movingSectors, movable: movableSectors } = scanSectors(map, this.switchPairs);
    // A saved mid-motion mover's sector may have had its authored special
    // consumed, dropping it from the scan above — union it back in so its
    // geometry stays mover-owned (docs/savegames.md § Apply order). It is
    // moving by definition, so it goes into both.
    if (restore) {
      const saved = [...restore.specials.movers, ...(restore.specials.ceilingMovers ?? [])];
      for (const [sectorIndex] of saved) {
        movableSectors.add(sectorIndex);
        movingSectors.add(sectorIndex);
      }
      // The scan's own block rule again, over a sector it never saw.
      addBlockMates(map, movableSectors);
    }
    // Shared with the mover meshes below, so a door's walls carry the same leaf attribute the
    // static ones do — without it a mover would be the one surface a light shone through.
    const subsectorAt = (x: number, y: number) => this.world.subsectorAt(x, y);
    this.built = buildMapMesh(map, this.materials, {
      movableSectors,
      movingSectors,
      transfers,
      subsectorAt,
    });
    this.scene.add(this.built.group);
    // The colour this level's sky lends every surface under it, resolved once: the sky is fixed for
    // the whole of a level (docs/render-lighting.md § Outdoor sky tint). What the set's MAPINFO
    // names for this map wins, and only where the WAD actually carries it — docs/wad.md § The sky
    // texture.
    setLevelSky(levelSkyArt(map.name, this.mapInfoSkies.get(map.name.toUpperCase()), (name) => this.skyArt(name)));
    this.voidFloor = new VoidFloor(map);
    this.scene.add(this.voidFloor.mesh);
    // The leaf graph the lights flood through, over the polygons the mesh just built — so a torch
    // stops at its wall. docs/lights.md § Light stops at walls.
    this.lights.bindLevel(new LightVisibility(map, this.built.polys, this.world));
    this.fadePass = new FadePass(
      new WallFader(this.built.occluders, this.built.wallMeshes),
      new FlatFader(this.built.flatSurfaces, this.built.flatMeshes),
    );
    this.forces = new Forces(map, this.world);
    // Constructed after `applySectors` on purpose, so a displacement scroller
    // spawns watching the restored control-sector height rather than the
    // authored one — `Forces.restore` covers what that ordering can't.
    this.forces.restore(restore?.scrollers);
    this.voodoo = new VoodooDolls(this.world);
    // Absent in a save from before dolls existed, which leaves them on their own
    // player starts — the same state a fresh load gives them.
    this.voodoo.restore(restore?.voodoo);
    this.surfaceScroller = new SurfaceScroller(this.forces, this.built, this.materials);
    this.player = new Player(this.world);
    if (restore) {
      // The saved position and camera replace both the map's own start and any
      // `?pos=` override, which stays queued for the next fresh level.
      this.player.restore(restore.player);
      this.forEachCamera((camera) => (camera.yawDeg = restore.cameraYawDeg));
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
      this.forEachCamera((camera) => (camera.yawDeg = (this.player.angle * 180) / Math.PI - 90));
    }
    // After both branches, and after the yaw each sets: the camera belongs to
    // the session, not the level, so its smoothed follow point still holds the
    // outgoing level's — a load would open with the camera flying to the
    // player. docs/camera.md § The camera is simulation state.
    this.autoCamera = new AutoCamera(this.world, this.transfers);
    // Seeded before snapTo, which poses the camera — so a level opens already
    // framed rather than mid-zoom. docs/camera.md § Auto camera.
    this.autoCamera.seed(this.player, this.simCamera);
    this.simCamera.snapTo({ x: this.player.x, y: this.player.y, z: this.player.eyeZ });
    // A level change re-seeds the viewer's own camera from the simulation's: it is a hard reset of
    // the framing, and gliding in from the outgoing level is exactly what `snapTo` exists to stop.
    if (this.view.camera !== this.simCamera) this.view.camera.copyFrom(this.simCamera);
    this.fogOfWar = new FogOfWar(this.world, this.built.occluders, this.player, movableSectors);
    if (restore) this.fogOfWar.restoreExplored(restore.fog);
    this.specials = new SpecialsController(this.world, {
      bank: this.materials,
      scene: this.scene,
      fog: this.fogOfWar,
      built: this.built,
      meshOptions: { transfers, subsectorAt, movingSectors },
      onExit: (secret) => {
        this.pendingExit = secret ? 'secret' : 'normal';
      },
      onTeleport: (dest) => {
        // Whatever stands on the landing pad is stomped (`P_TeleportMove`); the
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
        // The follow point always snaps; the yaw is reoriented by a vanilla teleport and turned
        // *relatively* by a silent one, which is what preserves the player's own Q/E orbit —
        // `turnYaw`, not an assignment, so a step still animating survives the trip
        // (docs/specials.md § Silent and line-to-line teleporters). Yaw first either way: `snapTo`
        // poses the camera with it.
        // Both cameras: a replay's viewer must not be left gliding across the map either, and
        // the operations are applied rather than the state copied, so a manual view keeps its zoom.
        this.forEachCamera((camera) => {
          if (dest.rotateBy === undefined) camera.yawDeg = (dest.angle * 180) / Math.PI - 90;
          else camera.turnYaw((dest.rotateBy * 180) / Math.PI);
          camera.snapTo({ x: this.player.x, y: this.player.y, z: this.player.eyeZ });
        });
      },
      // Who a mover can catch. The tests over them are the specials layer's own; this hands over
      // the bodies and nothing else — `things` as a getter because it is built further down.
      occupants: {
        things: () => this.things,
        player: this.player,
        // A crusher over a voodoo doll kills the player it stands for.
        dolls: this.voodoo.dolls,
        damagePlayer: (amount) => this.damagePlayer(amount, undefined, undefined, 'crush'),
        sprayBlood: (at) => this.effects.spawnCrushBlood(at),
      },
      playerAt: this.player,
      movableSectors,
      sfx: this.audio,
      switchPairs: this.switchPairs,
    });
    if (restore) {
      this.specials.restore(restore.specials);
      this.world.restoreSoundAlerted(restore.soundAlerted);
    }

    this.things = buildThingSprites(this.world, {
      bank: this.spriteBank,
      materials: this.spriteMaterials,
      skill: this.skill,
      sfx: this.audio,
      // Fanned out to both owners: the tag-driven actions (including Commander Keen's door)
      // belong to `specials`, the Icon of Sin's own `A_BrainDie` to `icon`; each ignores the
      // doomednums it doesn't handle. The player-alive gate is `A_BossDeath`'s alone and travels
      // with it — `A_BrainDie` has none, so the icon is notified over a corpse too.
      // docs/death.md § Dying on the way out.
      onBossDeath: (type) => {
        this.specials?.notifyBossDeath(type, !this.playerDead);
        this.icon?.notifyBossDeath(type);
        this.endingOverCorpse();
      },
      restore: restore?.things,
      // `spawnTeleportFog` plays the `telept` that goes with each, exactly as a teleport does.
      onRespawn: (from, to) => {
        this.effects.spawnTeleportFog(from);
        this.effects.spawnTeleportFog(to);
      },
      lights: this.lights,
    });
    this.scene.add(this.things.group);

    // Built after `things`, which its cube spawns and telefrags go through.
    this.icon = new IconOfSin(map, {
      ctx: this.combat,
      effects: this.effects,
      spriteBank: this.spriteBank,
      spriteMaterials: this.spriteMaterials,
      skill: this.skill,
      onExit: () => {
        // `A_BrainDie` is a plain `G_ExitLevel` — MAP30 has no secret exit to take.
        this.pendingExit = 'normal';
      },
      sfx: this.audio,
    });
    if (restore) {
      this.icon.restore(restore.icon);
      this.projectiles.restore(restore.projectiles);
      this.cheats.restore(restore.cheats);
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

    // What the next `estimatedBuildMs` predicts from — this machine's own speed, from the map it
    // just built. Guarded against a map with no linedefs, which would divide the ratio away.
    const buildMs = performance.now() - t0;
    const linedefKb = mapLinedefBytes(this.wad, name) / 1024;
    if (linedefKb > 0) this.buildMsPerKb = buildMs / linedefKb;

    const provider = this.wad.providerOf(name)?.name ?? '?';
    // Memoised on the map by the fog grid's own build, so this reads rather than partitions.
    const islands = islandCount(map);
    console.info(
      `${name} (${provider}): ${map.sectors.length} sectors, ${map.linedefs.length} linedefs, ` +
        `${map.things.length} things (${this.things.count} rendered), ` +
        `${this.built.triangles} tris, ` +
        `${this.built.trimmedUppers + (this.specials?.trimmedUppers ?? 0)} ceiling trims, ` +
        `${islands} island${islands === 1 ? '' : 's'} in ${Math.round(buildMs)} ms`,
    );
    if (this.built.missingTextures.length > 0) {
      console.warn('missing textures:', this.built.missingTextures.join(', '));
    }
    if (this.things.missingArt.length > 0) {
      console.warn('things skipped, no sprite in this WAD set:', this.things.missingArt.join(', '));
      // Said on screen too, not only in the console: a skipped thing is simply absent from the
      // level, and nothing else explains why. Survives this load because `clearOverlays` runs
      // ahead of the build, and sits clear of the level card's own band
      // (docs/hud.md § Center messages).
      this.message.show(missingArtMessage(this.things.missingArt.length));
    }
  }

  /** Stops both loops. `dispose` uses this rather than `pause` — see `stillFrame`. */
  private stop(): void {
    this.running = false;
    this.paused = false;
    this.audio.suspend();
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
      this.view.present(this.scene, this.view.camera.camera);
    }
    requestAnimationFrame(this.stillFrame);
  };

  /**
   * Runs the walk triggers **any non-player thing** crossed this tic
   * (`SpecialsController.crossMonster` — teleports plus the few door/lift types
   * vanilla lets one activate). Usually that is a monster walking, but a barrel or a decoration a
   * conveyor carried counts too — docs/specials.md § Scrollers and conveyors. A teleport gets the
   * same `TFOG` puff at both ends the player's own does; vanilla spawns it for any thing that
   * teleports, not just the player.
   */
  private thingCrossedLines(prev: Pos2, mover: CrossingBody): TeleportDest | null {
    return this.realizeThingTeleport(this.specials?.crossMonster(prev, mover, this.inventory.keys), mover);
  }

  /**
   * The other half of the same pair: `P_Move`'s `spechit` pass for a monster whose step to
   * `(tryX, tryY)` was refused (`SpecialsController.useMonster`), which is what opens a door for a
   * chasing monster. A teleport-switch landing is realized exactly as a crossed one is.
   * docs/monster-ai.md § Opening doors.
   */
  private thingUsedLines(mover: CrossingBody, tryX: number, tryY: number): TeleportDest | null {
    return this.realizeThingTeleport(this.specials?.useMonster(mover, tryX, tryY, this.inventory.keys), mover);
  }

  /**
   * The landing a monster's teleport asked for, stomped and puffed — shared by the two paths
   * above, since a teleport means the same thing however the line was activated.
   *
   * Returning null after a teleport *did* fire is `P_TeleportMove` refusing the
   * landing, which leaves the thing where it stood — docs/death.md § Telefrag.
   */
  private realizeThingTeleport(dest: TeleportDest | null | undefined, mover: CrossingBody): TeleportDest | null {
    if (!dest) return null;
    if (!this.things?.telefragAt(dest, mover.blockRadius, this.monsterStomps, mover.id)) return null;
    // The player half of the stomp: `telefragAt` covered every other body, but the
    // thing layer holds no player reference (same split as the spawn cube's).
    if (!this.playerDead && bodiesOverlap(dest, this.player, mover.blockRadius + PLAYER_RADIUS)) {
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
    if (!applyDamage(this.inventory, amount, this.cheats.god)) return false;
    if (fromX !== undefined && fromY !== undefined) {
      this.player.applyDamageThrust(thrustSpeed(amount, PLAYER_MASS), fromX, fromY);
    }
    this.screenEffects.addPain(amount);
    if (this.inventory.health <= 0) {
      this.playerDead = true;
      // Dying on an `exitBelowHealth` floor ends the level whatever killed the player, not only
      // when that floor's own damage did it — E1M8's pit is the ending, and a baron finishing the
      // job there must not leave the episode unwon. Set before the overlay below, which
      // `levelEnding` then keeps from being armed at all. docs/specials.md § Damage floors.
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
      // known here and now, where a checkpoint is only a store read away, and under a playback `R`
      // is the record's rather than the viewer's, so there is nothing to offer
      // (docs/death.md § Player death).
      if (!this.levelEnding) this.deathOverlay.show(obituary(cause), this.deathHint());
      return true;
    }
    this.audio.play('plpain', this.player, PLAYER_ORIGIN);
    this.playerActor.playOnce(PLAYER_PAIN_FRAMES, PLAYER_ACTION_FRAME_SECONDS);
    return true;
  }

  /**
   * Whether the key that dismisses the intermission and the end card is the viewer's to press. It
   * is the record's under a playback, so neither popup offers it (docs/replays.md § Playback).
   */
  private get viewerContinues(): boolean {
    return this.playback === null;
  }

  /** Which line the death overlay offers — nothing under a playback, where `R` is the record's. */
  private deathHint(): DeathHint {
    if (this.playback) return 'none';
    return this.savedState !== null ? 'reload-save' : 'restart';
  }

  /**
   * Whatever was typed this tic, and the one response a completed code prints. Returns whether
   * those characters belonged to a cheat — completed one or are partway into one — which is what
   * keeps the same keypress from also firing a bound key.
   *
   * A cheat also ends this run's claim on a best time, the same way a `?pos=` start does — it
   * travels in the save with `cheated`. docs/cheats.md § Saves and best times.
   */
  private applyCheats(input: TicInput): boolean {
    const typed = input.typed();
    if (!typed) return false;
    const response = this.cheats.type(typed, this.inventory);
    if (response) {
      this.message.show(response);
      this.cheated = true;
    }
    // A code half typed counts too: the hotkey has to be swallowed on the way *into* the match,
    // not only on the tic that completes it.
    return response !== null || this.cheats.typing;
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
    this.loadLevel(index, () => this.runEnterLevel(index, reborn));
  }

  /**
   * Every level load that happens while the loop is running goes through here: `run` at once, or
   * parked for the next frame with the loading screen up when the map is big enough that building
   * it would freeze visibly. The constructor's own first load does not — there is no frame to defer
   * to yet, and nothing on screen to freeze. docs/menu.md § The loading screen.
   */
  private loadLevel(index: number, run: () => void): void {
    if (this.loading && this.estimatedBuildMs(index) > SLOW_LOAD_MS) {
      this.loading.show(`Loading ${this.mapNameAt(index)}`);
      this.pendingLoad = run;
      return;
    }
    run();
  }

  /** Performs a parked load and takes the loading screen back down. */
  private flushPendingLoad(): void {
    const run = this.pendingLoad;
    this.pendingLoad = null;
    run?.();
    this.loading?.hide();
  }

  /** Indices wrap, so `N` past the last map lands on the first — `mapIndex` is always this. */
  private wrapIndex(index: number): number {
    return (index + this.mapNames.length) % this.mapNames.length;
  }

  private mapNameAt(index: number): string {
    return this.mapNames[this.wrapIndex(index)];
  }

  /**
   * What building the map at `index` is predicted to cost, from its `LINEDEFS` size and what the
   * builds so far actually took. Only ever consulted to decide whether the loading screen is worth
   * putting up, so being wrong costs a flicker or a silent freeze, never correctness.
   */
  private estimatedBuildMs(index: number): number {
    return (mapLinedefBytes(this.wad, this.mapNameAt(index)) / 1024) * this.buildMsPerKb;
  }

  /** `enterLevel`'s body, run either at once or on the frame after the overlay is up. */
  private runEnterLevel(index: number, reborn: boolean): void {
    // A level entered through an exit is the player's own run again, whatever disqualified the last
    // one — a `?pos=` start, a replay taken over. A cheat is the exception: it is the session's,
    // like the toggles it leaves (docs/hud.md § Best times).
    this.cheated = this.cheats.used;
    // Before the load, which hands this very object to `weaponSystem.beginLevel`.
    if (this.playerDead || reborn || getPistolStart()) {
      this.inventory = createInventory();
    }
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
      canContinue: this.viewerContinues,
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
      capture = this.captureSave({ thumbnail: false });
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
    // A replay restarts where its recording did: the restore event, not the key
    // (docs/replays.md § Restore events).
    if (this.playback) return;
    if (this.restarting) return;
    // The savegame path is synchronous — the snapshot is already in memory, and
    // it came from this very session, so there is nothing to match against
    // (docs/death.md § Player death).
    if (this.savedState) {
      const state = this.savedState;
      this.loadLevel(this.mapIndex, () => this.reloadLevel(state));
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
   * restore path the inventory comes out of the snapshot instead. Both reloads go through
   * `loadLevel`, so `R` on a map slow enough to freeze gets the loading screen an exit would.
   */
  private async resumeFromCheckpoint(): Promise<void> {
    const save = this.hasCheckpoint && this.checkpoint ? await this.checkpoint.read() : null;
    // The read is async, so the session may have moved on underneath it: the
    // menu can have started another level (and disposed this Game) meanwhile.
    if (this.disposed || !this.playerDead) return;
    if (save && this.matchesSession(save)) {
      const state = save.state;
      this.loadLevel(this.mapIndex, () => this.reloadLevel(state));
      return;
    }
    this.loadLevel(this.mapIndex, () => this.reloadLevel(null));
  }

  /**
   * The level again, from `state` or (null) fresh with a fresh inventory — every way `R` reloads
   * ends here, which is what lets a recording write the reload down as one event at the tic it
   * lands on. docs/replays.md § Restore events.
   */
  private reloadLevel(state: GameSnapshot | null): void {
    if (!state) this.inventory = createInventory();
    this.recorder?.restore(this.currentMap, state);
    this.loadMapByIndex(this.mapIndex, state);
  }

  /**
   * Applies `apply` to every camera there is: the simulation's, and the viewport's own where a
   * playback has separated the two. For the discontinuities both must take — a level load, a
   * teleport — since neither may be left gliding in from where the last one was.
   */
  private forEachCamera(apply: (camera: TopDownCamera) => void): void {
    apply(this.simCamera);
    if (this.view.camera !== this.simCamera) apply(this.view.camera);
  }

  /**
   * Brings the drawn camera up to the simulation's, once per tic of a playback: mirrored outright
   * in the recording view, and in the manual one driven by the viewer's own orbit and framing keys
   * around the same follow point. Nothing here reaches the simulation.
   * docs/replays.md § Playback.
   */
  private syncViewCamera(dt: number): void {
    const playback = this.playback;
    const view = this.view.camera;
    if (!playback || view === this.simCamera) return;
    if (playback.cameraView === 'recording') {
      view.copyFrom(this.simCamera);
      return;
    }
    const input = this.view.input;
    view.applyYawInput(input, dt);
    view.applyFramingKeys(input);
    view.tick(dt, { x: this.player.x, y: this.player.y, z: this.player.eyeZ }, playback.lastAim);
    // The live input is read by nothing else while a replay plays, and its edges have to be
    // cleared by someone or a press would latch for the rest of the playback.
    input.endTic();
  }

  /**
   * What a replay puts between two tics: the recorder's settings diff and desync sample, or the
   * playback's due events (a reload lands here, synchronously — never parked), its settings pinned
   * again, and its sample compared. docs/replays.md § Restore events.
   */
  private replayBeginTic(): void {
    const recorder = this.recorder;
    if (recorder) {
      // Before the tic the anchor is stamped for, and only where the moment allows a capture at
      // all: a keyframe taken mid-cheat or over a corpse would restore what `captureSave` refuses
      // to write. A refused one waits for the next tic. docs/replays.md § Seeking.
      if (recorder.keyframeDue && !this.cheats.typing && this.saveRefusal() === null) {
        const state = this.captureSave({ thumbnail: false }).state;
        recorder.keyframe(this.currentMap, state);
      }
      // Snapped onto the record's lattice *before* the tic reads the camera, so what ran is what
      // is stored — the aim point's own rule. `roundPose`, not `setPose`: the orbit and the framing
      // are heading somewhere and that is not part of a pose. docs/replays.md § Camera state.
      const pose = quantizePose(this.simCamera.pose());
      this.simCamera.roundPose(pose);
      recorder.beginTic(this.player.x, this.player.y, captureSimSettings(), pose);
      return;
    }
    const playback = this.playback;
    if (!playback) return;
    // The camera is an input here, not a computation: the tic runs at the pose the recording ran
    // at, whatever this build's camera code would have picked. docs/replays.md § Camera state.
    const pose = playback.poseAt(playback.cursor);
    if (pose) this.simCamera.setPose(pose);
    for (const event of playback.eventsAt(playback.cursor)) {
      if (event.kind !== 'restore') continue;
      this.reloadLevel(event.snapshot === null ? null : playback.replay.data.snapshots[event.snapshot]);
    }
    applySimSettings(playback.settings);
    playback.check(this.player.x, this.player.y);
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
    return wadSetRefusal(save, wadSetId(this.wad), (map) => mapProvider(this.wad, map)) === null;
  }

  /**
   * The FPS cap (`getFpsCap`): whether this rendering opportunity is the one to use. Skipping is
   * the whole frame, so the input it would have consumed arrives on the next one; read live rather
   * than cached, so a change in the menu applies to the level already running.
   * docs/frameloop.md § The FPS cap.
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
    // Ahead of the FPS cap, and resynced after — both load-bearing, docs/frameloop.md § A parked
    // level load.
    if (this.pendingLoad) {
      this.flushPendingLoad();
      this.resyncClock();
      requestAnimationFrame(this.frame);
      return;
    }
    if (!this.dueThisFrame(now)) {
      requestAnimationFrame(this.frame);
      return;
    }
    // Real elapsed time, banked rather than consumed: the simulation advances in whole `DOOM_TIC`
    // steps and the remainder becomes the draw's interpolation alpha. The lower clamp is
    // load-bearing, and belongs at the source rather than on the accumulator alone — `rawDt`
    // reaches consumers that would misread a negative one. docs/frameloop.md § The accumulator.
    const rawDt = Math.max(0, (now - this.lastTime) / 1000);
    this.lastTime = now;
    // A seek owns the frame it runs in: `runSeek` banks no time and draws nothing until it lands.
    if (this.playback?.seekTarget != null) {
      this.runSeek(this.playback, rawDt);
      requestAnimationFrame(this.frame);
      return;
    }
    // A playback banks time at its own speed, and none while paused or spent — the bar's pause
    // is not the menu's, the frame keeps running (docs/replays.md § Playback).
    const playback = this.playback;
    const held = playback !== null && (playback.paused || playback.ended);
    this.accumulator += held ? 0 : rawDt * (playback?.speed ?? 1);
    // A stall (backgrounded tab, a slow map load) must not be paid back as a
    // burst of catch-up tics — drop the debt instead: never take a giant step.
    if (this.accumulator > MAX_TICS_PER_FRAME * DOOM_TIC) this.accumulator = MAX_TICS_PER_FRAME * DOOM_TIC;
    this.profiler.beginFrame();

    const camera = this.simCamera;
    const input: TicInput = this.replay ?? this.view.input;
    let ran = 0;
    while (this.accumulator >= DOOM_TIC && ran < MAX_TICS_PER_FRAME) {
      if (playback && !playback.hasTic) {
        this.accumulator = 0;
        break;
      }
      this.accumulator -= DOOM_TIC;
      ran++;
      this.replayBeginTic();
      // A tic that swapped the level (an exit, a restart) invalidates
      // everything the rest of this frame would touch — stop and let the next
      // frame start clean on the new map.
      if (this.tic(input, camera)) {
        requestAnimationFrame(this.frame);
        return;
      }
      this.syncViewCamera(DOOM_TIC);
    }
    // A playback that ran no tic — paused, or spent — still lets the viewer look around.
    if (held) this.syncViewCamera(DOOM_TIC);

    // A frozen simulation is drawn at the tic-exact pose, not at the leftover
    // accumulator: with no further tic coming, the last two tics stay apart
    // forever while `alpha` keeps changing every frame, so the still scene
    // shakes between them. docs/frameloop.md § Interpolation.
    const still = this.popup !== null || (playback !== null && (playback.paused || playback.ended));
    this.draw(still ? 1 : this.accumulator / DOOM_TIC, rawDt, still);
    requestAnimationFrame(this.frame);
  };

  /**
   * One fixed `DOOM_TIC` step of the whole simulation, and the only place
   * input is consumed. Returns true if it loaded a different level, which makes
   * every reference the caller holds stale.
   *
   * Parts of the call order here are load-bearing — specials before
   * `player.update` so a lift underfoot has already moved when `groundFloor`
   * samples it, the aim ray before `player.update` so `player.angle` is this
   * tic's. docs/frameloop.md § What runs in a tic.
   */
  private tic(input: TicInput, camera: TopDownCamera): boolean {
    // The level is over and frozen behind the popup: nothing is advanced — not the clock, not the
    // specials, not a monster — only the still scene is redrawn under it. Space/Enter rather than
    // any key, since Escape belongs to the menu (main.ts) and would otherwise both pause and eat
    // the popup in the same press.
    if (this.popup) {
      this.intermissionTime += DOOM_TIC;
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
    // Ahead of every system a cheat changes, and only while there is a live player to change:
    // a corpse answers `R` and nothing else. docs/cheats.md § Typing a code.
    const cheating = !this.playerDead && this.applyCheats(input);
    // Set here rather than at the toggle, since a `Player` is rebuilt by every level load and the
    // cheat outlives it — and here rather than in the player block below, so that every system
    // this tic reads one `noclip`, not last tic's. docs/cheats.md § IDCLIP.
    this.player.noclip = this.cheats.noclip;
    // A letter of a code must not also work its bound key: DEVMODE's map jump `P` sits inside
    // `idclip`, and jumping level mid-code would eat the cheat. Only that callback is withheld —
    // the camera keys aren't letters and can't collide. docs/cheats.md § Typing a code.
    handleHotkeys(
      input,
      camera,
      cheating ? null : (delta) => this.enterLevel(this.mapIndex + delta),
      this.playback?.replay.data.devmode ?? DEVMODE,
    );
    // Set before any system runs, since specials/monsters/weapons all raise
    // sounds during the update below. The camera's yaw is last tic's (it
    // settles in `camera.tick`, at the end) — a tic of smoothing lag on the
    // pan axis, which is inaudible.
    this.audio.setListener(this.player, camera.viewerAngleDeg + 180);
    if (!this.playback) camera.applyYawInput(input, DOOM_TIC);

    // Runs before player.update so a lift/door the player is standing on has
    // already moved this tic by the time groundFloor is sampled below.
    this.profiler.time('Specials', () => {
      this.specials?.update(DOOM_TIC, this.player, input, this.inventory.keys, this.player.noclip);
      // After the movers, not before: a displacement scroller's rate is the
      // height change its control sector just made this tic.
      this.forces.tick();
      // And the dolls after the forces that carry them, so a conveyor's
      // impulse and the walk lines it pushes a doll across land in one tic.
      if (!this.voodoo.empty) {
        this.voodoo.update(
          DOOM_TIC,
          this.forces,
          (prev, doll) => this.specials?.crossVoodoo(prev, doll, this.inventory.keys) ?? null,
          // A doll is a player mobj carrying `MF_PICKUP`, so what it runs over lands in the real
          // player's inventory — the same "on the player's behalf" the damage floors below use.
          // Gated on a living player, standing in for vanilla's `toucher->health` check.
          (doll, attempted) => {
            if (!this.playerDead) this.things?.tryPickup(doll, attempted, PICKUP_RANGE, this.consumePickup);
          },
        );
      }
    });
    // The `oof` a refused keyed line already played is raised inside `specials`; the message that
    // says *which* key it wants is this layer's, since that controller has no HUD. `undefined`
    // (no level loaded) and `null` (nothing refused) are the same non-event here.
    const locked = this.specials?.consumeLockedLine();
    if (locked) this.message.show(...lockedLineMessage(locked.lock, locked.kind));
    // Deferred from the exit trigger's callback — see `pendingExit`'s doc.
    // The outgoing SpecialsController's update() has fully returned by here, so
    // it is safe to dispose it and swap in the next map.
    if (this.pendingExit) {
      this.resolveExit(this.pendingExit === 'secret');
      // Before `pendingExit` is cleared, which is half of what `levelEnding` reads. Catches a
      // death that beat the exit here rather than at the boss-death fan-out: an exit-line
      // walk-over is queued and consumed with nothing in between, but a crusher can kill between.
      this.endingOverCorpse();
      this.pendingExit = null;
      // The next map isn't loaded here any more: the popup goes up on the level as it stands, and
      // the continue key at the top of `tic` is what loads it.
      // The cheated popup reads the *same* flag that already refuses a best time — a run that
      // can't set one has nothing worth stating (docs/cheats.md § Saves and best times).
      this.intermission.setContinueHint(this.viewerContinues);
      this.intermission.show(this.levelStats(), this.recordCompletion(), this.parFor(), this.cheated);
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

    // Auto-aim, movement, firing and pickups freeze once the player is dead; fog of war, things
    // and effects below keep ticking, so a rocket fired just before dying finishes its flight.
    // Re-posed at alpha 1 so the ray is cast through the previous tic's exact camera rather than
    // the last frame's interpolated one, which is what keeps aim framerate-independent. Must sit
    // immediately before the ray — `draw` overwrites the pose. docs/frameloop.md § Posing for the
    // aim ray.
    if (!this.playerDead) camera.applyToCamera(1);
    const cursor = this.playerDead ? null : this.updateLivingPlayer(DOOM_TIC, input, camera);

    if (!this.playerDead) this.levelTime += DOOM_TIC;
    // After movement (the probe runs from this tic's position) and before
    // camera.tick, whose damping advances toward the fresh target.
    // docs/camera.md § Auto camera.
    // Skipped under a playback: the camera came from the record at the top of the tic, and
    // advancing it here would leave the next tic interpolating out of a pose nothing saw.
    if (!this.playback) {
      this.profiler.time('Camera', () => this.autoCamera.tick(this.player, camera));
      camera.tick(DOOM_TIC, { x: this.player.x, y: this.player.y, z: this.player.eyeZ }, cursor);
    }

    this.profiler.time('Fog of War', () => this.fogOfWar.tick(this.player.x, this.player.y));
    this.updateThings(DOOM_TIC);
    this.updateEffects(DOOM_TIC);

    input.endTic();
    return false;
  }

  /**
   * One rendered frame: poses everything `alpha` of the way from the last tic to
   * the current one, runs the presentation-only animators, and draws. Advances
   * no gameplay state whatsoever. docs/frameloop.md § What runs in a frame.
   */
  private draw(alpha: number, rawDt: number, still: boolean): void {
    const camera = this.view.camera;
    // Every sprite the CPU lights reads its depth from this, and the camera was posed on the line
    // above. docs/render-lighting.md § Distance lighting.
    camera.applyToCamera(alpha);
    beginViewDepth(camera.camera);
    this.updateOverlays(rawDt, alpha);
    this.fogOfWar.updateFade(rawDt);
    // Opened before anything draws: each draw pass below offers its sprites as emitters as it goes,
    // and `commit` closes the set once they all have (docs/lights.md § What reaches the shader).
    this.lights.beginFrame(rawDt, camera.followX, camera.followY, camera.viewFrustum);
    this.profiler.time('Sprites', () => this.things?.draw(alpha, camera.viewAngleDeg));
    this.drawEffects(alpha, camera.viewAngleDeg);
    // Moving planes are drawn `alpha` through the last tic like everything else. Must land before
    // the fade pass below: the refresh rewrites the mover buffers its commits write into.
    this.profiler.time('Movers', () => this.specials?.drawMovers(alpha));
    this.updatePresentation(rawDt, camera);
    // A still frame gives the player's own clock nothing: the sprite holds the frame it is on
    // rather than walking on the spot behind a paused replay or an intermission. Everything else
    // here is presentation the frozen scene still wants (the bar, the HUD, fading).
    this.posePlayer(alpha, still ? 0 : rawDt, camera.viewAngleDeg);
    this.profiler.time('Lights', () => this.lights.commit());

    // Measured only while the overlay is up: a timer query is cheap but not free, and nothing
    // reads the answer otherwise. docs/menu.md § Profiling overlay.
    const gpu = getProfilerVisible() ? this.view.gpuTimer : null;
    this.profiler.time('Render', () => {
      gpu?.begin();
      this.view.present(this.scene, camera.camera);
      gpu?.end();
    });
    // The music synth runs off its own timer, in the gaps between frames, so it
    // reports what it spent instead of being timed here (docs/music.md
    // § Getting it to the speakers).
    this.profiler.offFrame('Music', this.audio.music.takeRenderMs());
    this.profiler.endFrame();

    this.profilerHud.update(this.profiler, gpu?.ms ?? null);
    this.debugHud.update(rawDt, (fps) => this.debugLines(fps));
  }

  /**
   * Everything a *living* player drives in a frame: powers, aim, movement, firing, pickups and the
   * sector underfoot. Returns the point the camera leads toward, which is always where the cursor
   * meets the aim plane — never the locked-on monster.
   */
  private updateLivingPlayer(dt: number, input: TicInput, camera: TopDownCamera): Pos2 | null {
    // Ticked with the rest of the player's own update and not while dead,
    // matching vanilla: powers age in `P_PlayerThink`, which hands off to
    // `P_DeathThink` and returns before reaching them once health hits 0.
    tickPowers(this.inventory, dt);
    // The cursor hovering over a monster — or over a switch a shot triggers —
    // locks aim onto it, **on hover, not on click** (docs/combat.md § Auto-aim).
    // The camera leads on `cursor` and never sees either lock, which is
    // docs/camera.md § Aim lead's rule and the reason they are returned
    // separately at all.
    const { monster, shootLine, cursor } = this.profiler.time('Player', () => {
      // The aim plane hangs off the camera's own follow height, not the
      // player's live `z`: identical once the follow smoother has caught up,
      // but during a fall — into a Boom water pool, off any ledge — a plane
      // that drops while the camera lags swings the cursor's world point and
      // turns the player with it. docs/camera.md § Aim lead.
      const aimPlaneZ = camera.followHeight - EYE_HEIGHT + AIM_HEIGHT_OFFSET;
      // The one read of where the player aims, and the ray the picks below use is cast *toward*
      // that point rather than through the pointer — so a replay, which records the point, casts
      // the same ray. No point (pointer above the horizon) picks nothing.
      // docs/replays.md § The TicInput seam.
      const onPlane = input.aim(camera, aimPlaneZ);
      const ray = onPlane ? camera.rayToward(onPlane.x, onPlane.y, aimPlaneZ) : null;
      // That same point in three dimensions — where both picks' ground bound starts
      // (`World.groundReach`, docs/combat.md § Auto-aim).
      const aimAt = onPlane ? { x: onPlane.x, y: onPlane.y, z: aimPlaneZ } : null;
      const m = ray && aimAt ? (this.things?.pickMonster(ray, aimAt) ?? null) : null;
      // A monster in front of the switch wins: the pointer is over its body,
      // and a shot would be absorbed by it long before reaching the wall.
      const line =
        m || !ray || !aimAt
          ? null
          : (this.specials?.pickShootTarget(ray, aimAt, this.player.z + AIM_HEIGHT_OFFSET) ?? null);
      const at = m ?? line ?? onPlane;
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
      const ground = this.forces.frictionUnder(this.player, {
        radius: PLAYER_RADIUS,
        speed: vecLength(this.player.velX, this.player.velY),
        cache: this.playerTouch,
      });
      // Monsters are solid: the player walks around them, not through them.
      this.player.update(
        dt,
        input,
        at,
        camera.viewerAngleDeg + 180,
        this.things?.solidBodies(this.player),
        ground,
      );
      return { monster: m, shootLine: line, cursor: onPlane };
    });

    this.profiler.time('Weapons', () => this.fireWeapons(input, monster, shootLine));
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
   * into a projectile or tracer. `monster` and `shootLine` are whatever aim locked onto — a body
   * or a shoot-triggered wall — which is what lets a shot angle toward its height; see
   * docs/combat.md § Auto-aim.
   */
  private fireWeapons(input: TicInput, monster: MonsterRef | null, shootLine: ShootAim | null): void {
    // Called after player.update so player.angle already reflects this frame's aim.
    this.weaponSystem.handleSwitching(input, this.inventory, input.consumeWheel());
    const shots = this.weaponSystem.fire(input.mouseDown, this.inventory, this.player.angle);
    // Every shot actually fired (ammo/cooldown allowed it) raises a noise
    // alert, which is what lets a monster with no line of sight to the player
    // still wake up on gunfire (World.noiseAlert, game/world.ts; vanilla's
    // P_FireWeapon calls P_NoiseAlert). Melee swings count: it is the same
    // entry point for every weapon, so swinging a fist in an empty room wakes
    // the neighbours the same as firing a pistol would.
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
      // The fire height is `spawnPlayerShot`'s own to pick. The locked-on monster travels with the
      // shot as the body to aim at; see world.ts's shotPath/blocksShot for why a locked shot is
      // allowed to clear the floor steps a free one is stopped by.
      this.projectiles.spawnPlayerShot(shot, monster, shootLine);
    }
  }

  /**
   * What picking one item up means, for whichever player mobj reached it — the real player or a
   * voodoo doll collecting on their behalf (docs/items.md § Collecting things). An arrow field
   * rather than a method because both `tryPickup` call sites hand it straight over.
   */
  private consumePickup = (type: number, dropped: boolean): boolean => {
    const taken = applyPickup(this.inventory, type, dropped, this.skill);
    // The computer area map is the one pickup whose whole effect lives outside the `Inventory`
    // struct: it reveals the level's own geometry. Watched for here rather than handled in
    // `applyPickup` — the same "state there, world effect at the caller" split `tryPickup`
    // already makes for removing the item itself.
    if (taken && type === ThingType.computerMap) {
      this.fogOfWar.revealAll();
    }
    // Unattenuated, as vanilla plays every pickup: you're standing on it.
    if (taken) this.audio.play(pickupSound(type));
    return taken;
  };

  /**
   * The two things the player picks up by standing somewhere: items in reach, and whatever the
   * sector underfoot does to them (damage floors, secrets, an exit) — see
   * game/specials/sectoreffects.ts.
   */
  private collectPickupsAndSectorEffects(dt: number): void {
    this.things?.tryPickup(this.player, this.player.attempted, PICKUP_RANGE, this.consumePickup);
    const sectorEffect = this.sectorEffects.update(
      dt,
      this.world,
      this.player,
      this.inventory,
      (amount) => this.damagePlayer(amount, undefined, undefined, 'slime'),
    );
    if (sectorEffect.secretFound) {
      this.message.show(SECRET_MESSAGE);
      // Unattenuated, like a pickup: it's an announcement to the player, not a sound in the world.
      this.audio.playAsset('secret');
    }
    // A damage floor that ends the level never leads to the secret exit
    // (vanilla's sector type 11 calls `G_ExitLevel`, not `G_SecretExitLevel`).
    if (sectorEffect.exit) this.pendingExit = 'normal';
  }

  /**
   * This level's par time in seconds, or null when nothing knows one — the intermission omits the
   * row then. docs/wad.md § Par times.
   */
  private parFor(): number | null {
    const opts = { mission: this.levelNames.levelMission, dehPars: this.dehacked?.pars };
    return parSecondsFor(this.currentMap, opts) ?? null;
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
   * null if this level's run may claim none. The record is keyed to the WAD file that
   * *provides* the map rather than to the loaded set — see docs/hud.md § Best times.
   */
  private recordCompletion(): BestTimeResult | null {
    // A replay is watched, not run: it reports the recording player's time and claims nothing,
    // whoever holds the record. docs/replays.md § Playback.
    if (this.playback) return null;
    if (this.cheated) return null;
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
  private updateOverlays(dt: number, alpha: number): void {
    this.hud.update(this.inventory, this.levelStats(), this.recording);
    this.crosshair.update(this.inventory.health);
    this.replayBar.update(this.playback, this.replayAimNdc(alpha), this.inventory.health);
    this.message.update(dt);
    this.levelCard.update(dt);
    this.screenEffects.update(dt, this.inventory);
    this.screenEffects.setColormapTint(this.viewColormap());
    this.deathOverlay.update(dt);
  }

  /**
   * Where the recording's aim point falls on screen this frame, in NDC: the aim interpolated
   * `alpha` into the tic being drawn, through the pose `draw` just set from the same `alpha` — what
   * the replay reticle is placed at. Null with no playback, no aim, or a dead player (nothing aims
   * then).
   */
  private replayAimNdc(alpha: number): Pos2 | null {
    const aim = this.playback?.aimAt(alpha);
    if (!aim || this.playerDead) return null;
    const projected = AIM_SCRATCH.set(aim.x, aim.z, -aim.y).project(this.view.camera.camera);
    return { x: projected.x, y: projected.y };
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
          (mover, tryX, tryY) => this.thingUsedLines(mover, tryX, tryY),
          this.forces.carriesAnything() ? this.carryForBody : undefined,
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

  /**
   * The draw half of `updateEffects`: one begin/end pair around every list that batches a sprite.
   */
  private drawEffects(alpha: number, viewAngleDeg: number): void {
    this.profiler.time('Effects', () => {
      this.effects.beginFrame(viewAngleDeg);
      this.projectiles.draw(alpha);
      this.icon?.draw(alpha);
      this.effects.draw(alpha);
      this.effects.endFrame();
    });
  }

  /**
   * Everything riding the frame clock rather than the tic: occlusion fading of walls and flats,
   * the scrollers, the texture animators and the void floor's drift. See render/occlusion.ts.
   */
  private updatePresentation(dt: number, camera: TopDownCamera): void {
    this.profiler.time('Fading', () => {
      const camPos = camera.camera.position;
      // Door/lift geometry lives in its own meshes (game/specials.ts) and so
      // carries its own faders; the pass runs them alongside the static batches
      // over one pair of bags, which is what lets a hole opened in a wall
      // dissolve a door standing in it.
      this.fadePass.run(
        {
          dt,
          // The camera in DOOM (x, y, height), not three.js space.
          camX: camPos.x,
          camY: -camPos.z,
          camZ: camPos.y,
          targets: collectFadeTargets(this.player, this.things?.awakeMonsters() ?? []),
          openingInto: this.openingInto,
        },
        this.fogOfWar,
        this.specials?.fadeParticipant,
      );
      // Independent of camera/player position — a scrolling wall animates
      // whether or not it's currently faded or in view. The offsets advance on
      // the frame clock (`Forces.advanceOffsets`) rather than the tic, so this
      // stays as smooth as the rest of the presentation layer.
      if (this.forces.hasScrollers) {
        this.forces.advanceOffsets(dt);
        this.surfaceScroller.update();
      }
      // Same independence, and session-scoped rather than per-map (see its
      // construction in the constructor) — an animated liquid/fire texture keeps
      // cycling across a level transition exactly as it does within one.
      this.animatedTextures.update(dt);
      // Same frame clock, same reason. docs/render.md § The void floor.
      this.voidFloor?.update(dt);
    });
  }

  /**
   * Places the player's own billboard: position, facing, sector light and which
   * animation is due. Positions are interpolated `alpha` through the last tic;
   * the animation advances on `dt`, since it is presentation and its own frame
   * chain is what times it — which is why `draw` hands it 0 on a still frame,
   * where the real one would walk the sprite on the spot (docs/frameloop.md
   * § Pausing).
   */
  private posePlayer(alpha: number, dt: number, viewAngleDeg: number): void {
    // Chosen before the pose that reads it. The setting is read per frame rather than captured, so
    // the menu applies it to the level already running.
    this.playerActor.setSkin(this.playerSkins?.skinFor(this.inventory.currentWeapon, this.setDrawsPlayer) ?? null);
    const p = this.player;
    const x = p.prevX + (p.x - p.prevX) * alpha;
    const y = p.prevY + (p.y - p.prevY) * alpha;
    const z = p.prevZ + (p.z - p.prevZ) * alpha;
    // Cast on the ground under them, not on their feet — this tic's own `groundFloor` answer, kept
    // by `Player` rather than asked again here. docs/render.md § The player's shadow.
    this.playerShadow.update(x, y, p.groundZ, z);
    // Shortest-arc, so a shot fired across the -pi/pi seam doesn't spin the
    // billboard the long way round between two tics.
    let dAngle = p.angle - p.prevAngle;
    dAngle = atan2(sin(dAngle), cos(dAngle));
    const facingDeg = ((p.prevAngle + dAngle * alpha) * 180) / Math.PI;
    const sectorIndex = this.world.sectorIndexAt(x, y);
    // player.update (and with it, velX/velY) stops running once dead, so
    // this must not read possibly-stale velocity from the moment of death —
    // not that it would matter anyway, since setPose ignores `animating`
    // entirely once `die()` has been called (see SpriteActor's doc).
    const walking = !this.playerDead && vecLength(this.player.velX, this.player.velY) > 1;
    const light = this.world.map.sectors[sectorIndex] ? this.transfers.spriteLight(sectorIndex) : 128;
    // The player is an emitter too — `PLAY F`, the firing frame, is the muzzle flash GLDEFS binds
    // `ZOMBIEATK` to, the same light the zombieman's own `POSS F` gets. `PLAYER_EMITTER_ID` keeps
    // it clear of `PosedThing.id` (a plain array index) and of the effects' negative IDs.
    // The leaf is left to `DynamicLights` to resolve: both `offer` and `tintAt` fall back to the
    // same descent, and only once a light is actually live — so a WAD with no GLDEFS, or lights
    // switched off, pays nothing for it here.
    const tint = this.lights.offerAndTint(this.playerActor.frameKey, x, y, z, PLAYER_EMITTER_ID);
    this.playerActor.setPose(
      { x, y, z },
      {
        facingDeg,
        light,
        dt,
        // Left true while frozen on purpose: at `dt` 0 the sprite holds the stride it was in,
        // where `false` would snap it to standing — a pause is not a stop.
        animating: walking,
        viewerAngleDeg: viewAngleDeg,
        tint,
        sky: skyLitSector(this.world.map.sectors[sectorIndex]),
      },
    );
  }

  /** One sky name as art, however the set ships it — `levelSkyArt`'s lookup. */
  private skyArt(name: string): Bitmap | null {
    return this.gfx.texture(name) ?? this.gfx.picture(name);
  }

  /** DEVMODE's status text. Only ever called while the panel is shown — see `DebugHud.update`. */
  private debugLines(fps: number): string[] {
    const { camera } = this.view;
    const sector = this.world.sectorIndexAt(this.player.x, this.player.y);
    const channels = this.audio.channelUsage;
    const cameraDeg = ((Math.round(camera.yawDeg) % 360) + 360) % 360;
    return [
      `${this.currentMap}   ${this.title}`,
      `${fps} fps   ${this.built?.triangles ?? 0} tris   monsters awake ${this.things?.awakeMonsterCount() ?? 0}`,
      `pos ${this.player.x.toFixed(0)}, ${this.player.y.toFixed(0)}   z ${this.player.z.toFixed(0)}   sector ${sector}`,
      `Sound channels: ${channels.playing}/${channels.total} (${channels.dropped} burst-dropped)`,
      `cam ${camera.distance.toFixed(0)}u ${camera.tiltDeg.toFixed(0)}°tilt ${cameraDeg}°yaw`,
      this.cameraReadout(),
    ];
  }

  /**
   * The camera line of `debugLines`. A playback's camera comes from the record, so the auto
   * camera's dials are standing still and reporting them would be a lie — the view in force is
   * what there is to say (docs/replays.md § Playback).
   */
  private cameraReadout(): string {
    if (this.playback) return `replay camera: ${this.playback.cameraView}`;
    return getCameraMode() === 'auto' ? this.autoCamera.readout() : 'manual';
  }
}

function readStoredFpsCap(): FpsCap {
  const stored = readStorage(FPS_CAP_STORAGE_KEY, DEFAULT_FPS_CAP);
  return FPS_CAPS.find((c) => c === stored) ?? DEFAULT_FPS_CAP;
}
