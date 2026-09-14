/**
 * {@link Game}: one running level — builds the scene from the WAD, owns the frame/tic loop, and
 * wires every subsystem (world, things, specials, weapons, projectiles, effects, fog of war, HUD,
 * audio) into the simulation order. See docs/frameloop.md.
 */
import * as THREE from 'three';
import type { Wad, WadFile } from './wad/wad.ts';
import { mapProvider, wadId } from './wad/checksum.ts';
import { bestTimeKey, recordBestTime, type BestTimeResult } from './game/besttimes.ts';
import { GraphicsBank, type Bitmap } from './wad/graphics.ts';
import { SpriteBank } from './wad/sprites.ts';
import { loadMap, mapLinedefBytes } from './wad/map.ts';
import { MaterialBank } from './render/textures.ts';
import { DynamicLights } from './render/lights.ts';
import { gldefsFromWad, parseGldefs } from './wad/gldefs.ts';
import { setDrawsOwnPlayer } from './wad/playerskin.ts';
import { AnimatedTextures } from './render/textureanim.ts';
import { buildMapMesh, worldToDoom } from './render/mapmesh.ts';
import { islandCount } from './render/bsp.ts';
import { VoidFloor } from './render/voidfloor.ts';
import { setLevelSky } from './render/skytint.ts';
import { levelSkyArt } from './wad/campaign/sky.ts';
import { LightVisibility } from './render/lights.ts';
import { SpriteActor, SpriteMaterialCache } from './render/sprites.ts';
import { PlayerSkins } from './render/playerskin.ts';
import type { LoadingScreen } from './ui/loading.ts';
import type { Viewport } from './render/viewport.ts';
import { headingYawDeg, latticeYaw, TopDownCamera } from './render/camera.ts';
import {
  bodiesOverlap,
  buildThingSprites,
  monstersTelefrag,
  TELEFRAG_DAMAGE,
  targetOfSlot,
  type CarryQuery,
  type CrossingBody,
  type MonsterRef,
} from './game/things.ts';
import {
  FULLBRIGHT_FRAMES,
  PLAYER_ACTION_FRAME_SECONDS,
  PLAYER_ATTACK_FRAMES,
  PLAYER_PAIN_FRAMES,
  obituary,
} from './game/things/tables.ts';
import { thrustSpeed } from './game/monsters/defs.ts';
import { MonsterAttacks } from './game/monsters/attacks.ts';
import { FadePass, FlatFader, WallFader } from './render/occlusion.ts';
import { SurfaceScroller } from './render/scroller.ts';
import { makeCollider, makeTouchCache, World, type ThingBlocker } from './game/world.ts';
import {
  aimPlaneZ,
  AIM_HEIGHT_OFFSET,
  HARD_LANDING_SPEED,
  Player,
  PLAYER_HEIGHT,
  PLAYER_MASS,
  PLAYER_RADIUS,
  playerBlocker,
} from './game/player.ts';
import {
  anyPlayerAlive,
  applyBarrelExplosion,
  livingPlayer,
  playerRef,
  type CombatContext,
  type PlayerHit,
} from './game/combat.ts';
import { SpriteFxLayer } from './game/spritefx.ts';
import { ProjectileLayer } from './game/projectiles.ts';
import { FogOfWar } from './game/fogofwar.ts';
import { AutoCamera } from './game/autocamera.ts';
import { SectorEffects, SpecialsController, type TeleportDest } from './game/specials.ts';
import { addBlockMates, scanSectors } from './game/specials/mapscan.ts';
import type { ShootAim } from './game/specials/shootaim.ts';
import { Forces } from './game/specials/forces.ts';
import { transfersOf } from './game/specials/transfers.ts';
import { VoodooDolls } from './game/specials/voodoo.ts';
import { colormapTint } from './wad/colormaps.ts';
import { readAnimated } from './wad/animated.ts';
import { readSwitches, switchPairs, type SwitchPairLookup } from './wad/switches.ts';
import { switchPairTexture } from './game/specials/defs.ts';
import { IconOfSin } from './game/monsters/iconofsin.ts';
import { Hud } from './ui/hud/hud.ts';
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
import { HudMessages, deathLine } from './ui/hud/messages.ts';
import { handleHotkeys } from './ui/devmode/debughud.ts';
import { ScreenEffects } from './ui/hud/screeneffects.ts';
import { DeathOverlay, type DeathHint } from './ui/hud/deathoverlay.ts';
import { Scoreboard, type ScoreRow } from './ui/hud/scoreboard.ts';
import { FrameProfiler } from './util/profiler.ts';
import { clearRandom, getRandomCursors, setRandomCursors } from './util/random.ts';
import {
  applySectors,
  sectorBaseline,
  serializeInventory,
  type GameSnapshot,
  type PlayerSlotSnapshot,
} from './game/snapshot.ts';
import { wadSetOf, type SaveCapture } from './game/savegames.ts';
import {
  GLOBAL_PLAYER_SETTINGS,
  ReplayPlayback,
  type ReloadStates,
  ReplayRecorder,
  ReplayDriver,
  type Replay,
  type ReplayCapture,
} from './game/replay.ts';
import {
  NetSeat,
  type NetCapture,
  type NetRestore,
  type NetSession,
  type SlotAssignment,
} from './game/net.ts';
import { playerDamageAtSkill, type Skill } from './game/skill.ts';
import {
  applyDamage,
  applyPickup,
  pickupLine,
  createInventory,
  finishLevel,
  getPistolStart,
  giveAllKeys,
  hasPower,
  leftInNetgame,
  pickupSound,
  PICKUP_RANGE,
  tickPowers,
  type Inventory,
  type KeySlot,
} from './game/inventory.ts';
import { warpTargets } from './game/cheats.ts';
import { gameModeOf, type GameMode } from './wad/campaign/gamemode.ts';
import { ThingType } from './game/things/doomednums.ts';
import { WEAPONS, WeaponSystem } from './game/weapons.ts';
import type { AudioEngine } from './audio/audio.ts';
import { playerOrigin } from './audio/sfx.ts';
import { PlayerSlot, playerDeath, type SlotSource } from './game/playerslot.ts';
import { Level, type LevelParts } from './game/level.ts';
import { Presenter } from './game/presenter.ts';
import {
  coopStarts,
  deathmatchSpot,
  deathmatchStarts,
  levelStartFor,
  MAX_PLAYERS,
  rebornSpot,
  spotTaken,
} from './game/playerstarts.ts';
import { TICS_PER_MINUTE, fragCredit, getFragLimit, getFriendlyFire, getTimeLimit } from './game/rules.ts';
import { IDLE_TIC_INPUT, respawnPressed, type TicInput } from './game/input.ts';
import { SoundBank } from './wad/sound.ts';
import { MusicBank } from './wad/music.ts';
import { MapInfo } from './wad/campaign/mapinfo.ts';
import { LevelMusic } from './audio/music.ts';
import type { Placement, Pos2, Pos3 } from './types.ts';
import { DOOM_TIC, FOG_START_FRACTION, VIEW_DISTANCE } from './constants.ts';
import { rayEntersBox, vecLength } from './util/geom.ts';
import { readStorage, writeStorage } from './util/storage.ts';

/**
 * Most tics one frame may run before the rest of the banked time is dropped.
 * Bounds both the catch-up burst after a stall and the worst-case cost of a
 * single frame; without it a backgrounded tab returns owing minutes of
 * simulation and spends them all in one frame. Five is ~143ms of debt.
 * docs/frameloop.md § The accumulator.
 */
const MAX_TICS_PER_FRAME = 5;

/**
 * What a level build costs per KB of `LINEDEFS`, and only the seed for {@link Game.buildMsPerKb},
 * which re-measures from every build this session. **Tuned by feel** in that sense: it has to be
 * right enough to put the first level of a session on the correct side of {@link SLOW_LOAD_MS},
 * and the measurements it came from are in the commit that added it.
 */
const BUILD_MS_PER_KB = 1.1;

/**
 * How slow a level load has to be predicted to be before it gets the loading screen rather than
 * just happening. **Tuned by feel**: below this the overlay is up for fewer frames than it takes to
 * read, which is a flicker rather than feedback. docs/session.md § The loading screen.
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
 * How many frames a second the loop is allowed to run at, `0` for as many as the display offers.
 * Lives here because {@link Game.frame} is the only thing it changes; the menu just wires its
 * select to {@link getFpsCap} and {@link setFpsCap}. See docs/frameloop.md § The FPS cap.
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
 * What a {@link Game} is being asked to play, beside the three handles it is given. Named rather
 * than positional because {@link GameOptions.startMap} and {@link GameOptions.title} are both
 * strings and a swap would typecheck.
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
  /**
   * Called when the campaign is over and nothing follows: the session layer's cue to tear this
   * {@link Game} down and put the menu back up (docs/session.md § Session lifecycle). A port: this
   * class knows nothing about the menu.
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
   * {@link PlayerSkins}. Null when the fetch failed, which draws the set's own `PLAY` art.
   * docs/sprites.md § Weapon-matching player sprites.
   */
  playerSkins?: WadFile | null;
  /**
   * The session's loading screen, so a level too big to build between two frames can put it up
   * first. Absent means the load simply happens inline. docs/session.md § The loading screen.
   */
  loading?: LoadingScreen | null;
  /**
   * A replay to play instead of taking live input: {@link GameOptions.restore} is then its first
   * snapshot, and the level starts under its recorded camera and settings. A constructor option
   * rather than a method because a playback always begins with a load. docs/replays.md § Playback.
   */
  playback?: Replay | null;
  /**
   * Stores the current moment as a savegame — the session layer's store call around
   * {@link Game.saveVia}. Taking a replay over calls it, so the level the player is handed is one
   * they can come back to. Absent means taking over stores nothing.
   */
  autoSave?: (() => Promise<unknown>) | null;
  /**
   * `?coop=` or `?deathmatch=` — how many players the session runs, as a netgame; absent is single
   * player. Every slot past the first stands idle until something drives it. A restore's own
   * {@link GameSnapshot.players} and {@link GameSnapshot.netgame} win over it.
   * docs/multiplayer-coop.md.
   */
  players?: number | null;
  /**
   * `?deathmatch=` — whether that netgame is a deathmatch. A network game's rules and a restore's
   * own {@link GameSnapshot.deathmatch} win over it. docs/multiplayer-deathmatch.md § Settings.
   */
  deathmatch?: boolean;
  /**
   * The network game this level is one seat of: every slot's input comes from its rows, the local
   * slot's is sampled and sent ahead, and the session says which slot this browser plays. A
   * joiner's {@link GameOptions.restore} is the host's snapshot.
   * docs/multiplayer-net.md § What a tic does.
   */
  net?: NetSession | null;
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
  private playerSkins: PlayerSkins;
  /**
   * Whether the loaded set draws the player its own way — resolved once, per
   * {@link setDrawsOwnPlayer}.
   */
  private setDrawsPlayer = false;
  private mapNames: string[];
  /**
   * Vanilla's `gamemode`, which the set's own map list stands in for — read once, and only by
   * IDKFA so far (docs/cheats.md § IDKFA).
   */
  private gameMode: GameMode;
  /**
   * The level being played, whole (game/level.ts): unset only before the constructor's own
   * {@link Game.buildLevel}, and replaced by every load after it.
   */
  private level!: Level;
  /**
   * Every player in the level, by slot — one, or {@link GameOptions.players}'s. Built in the
   * constructor body, after the DEHACKED patch, and never replaced: a level load rebuilds what is
   * per-level *inside* each. docs/multiplayer.md § Player slots.
   */
  private slots: PlayerSlot[] = [];
  /**
   * Which slot this browser plays: its keyboard, the menu's settings, its `R`. What is drawn is
   * {@link Game.viewed}'s.
   */
  private readonly localSlot: number;
  /**
   * This browser's seat in the network game the level runs in ({@link GameOptions.net}), or null.
   * While set, every slot reads its rows and the local slot's simulation camera is separate from
   * the drawn one, as under a playback. The session ending ends this {@link Game} too (`main.ts`).
   * docs/multiplayer-net.md § What a tic does, docs/multiplayer-net.md § Leaving.
   */
  private readonly net: NetSeat | null;
  /**
   * {@link Game.slots} as the thing layer reads them, `null` where dead — refilled per tic, never
   * reallocated.
   */
  private players: (Pos3 | null)[] = [];
  /**
   * Every slot's body, the dead included, as the fog sweeps from them — refilled like
   * {@link Game.players}.
   */
  private fogPoints: Pos2[] = [];
  /**
   * Whether the session runs as a netgame: {@link GameOptions.players}, or the restored snapshot's
   * own. Decided once, since which things spawn depends on it. docs/multiplayer-coop.md.
   */
  private netgame: boolean;
  /**
   * Whether the netgame is a deathmatch: {@link GameOptions.deathmatch}, the network session's
   * rules, or the restored snapshot's own. Decided once, as {@link Game.netgame} is and for the
   * same reason. docs/multiplayer-deathmatch.md.
   */
  private readonly deathmatch: boolean;
  /**
   * {@link Forces.carryForBody} bound once rather than per tic: `ThingLayer.update` takes it or
   * `undefined`, and building the closure at the call site allocated one every frame.
   */
  private carryForBody: CarryQuery = (pos, radius, cache) =>
    this.level.forces.carryForBody(pos, radius, cache);
  private animatedTextures!: AnimatedTextures;
  /** How a switch texture resolves to its opposite state — see the constructor. */
  private switchPairs: SwitchPairLookup;
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
   * The live-level view {@link Game.projectiles}, {@link Game.monsterAttacks} and the splash
   * helpers read this class through — see game/combat.ts.
   */
  private combat: CombatContext;
  /**
   * Set by the exit trigger and consumed in {@link Game.tic} once the specials block has returned —
   * **never** acted on inside the callback, or a mover rebuild still pending from that same pass
   * would add the old map's mesh to the new map's scene. Which of the two exits fired is carried
   * along, since it decides where the level leads.
   */
  private pendingExit: 'normal' | 'secret' | null = null;
  /**
   * The map the continue key loads, or -1 when nothing follows the exit just taken. Resolved the
   * moment the popup goes up rather than when it is dismissed — that is the last moment
   * {@link Game.currentMap} is still the level just finished. docs/wad.md § Level progression.
   */
  private nextMapIndex = 0;
  /**
   * What the exit just taken ended, or null when it merely led somewhere. Resolved with
   * {@link Game.nextMapIndex}, and for the same reason: both are answers about the level being
   * left. Outlives the popups — it is also what makes the transition off the card a rebirth rather
   * than an ordinary level change ({@link Game.enterLevel}'s `reborn`). docs/hud.md § End card.
   */
  private pendingEnd: EndScope | null = null;
  /**
   * Which end-of-level popup is up, or null while the level is running. The level is finished and
   * frozen behind either: {@link Game.tic} advances nothing until the player presses the continue
   * key. Not {@link Game.pause}, which is the menu's — a popup has to keep reading input.
   * docs/hud.md § Intermission.
   */
  private popup: 'intermission' | 'endcard' | null = null;
  /**
   * Seconds the popup has been up, for {@link INTERMISSION_INPUT_DELAY}. The only thing that
   * still advances while it is. Shared by both popups, and restarted when the card takes over so
   * one press can't dismiss them both.
   */
  private intermissionTime = 0;

  private running = false;
  private lastTime = 0;
  /**
   * Real time banked but not yet spent on a tic, always under {@link DOOM_TIC} once
   * {@link Game.frame} has drained it. Doubles as the interpolation alpha's numerator — see
   * docs/frameloop.md § The accumulator.
   */
  private accumulator = 0;
  /**
   * A level load parked for the next frame with the loading screen up, as the thunk that performs
   * it — every caller's own body differs, and only {@link Game.loadLevel} decides whether to park
   * one. docs/frameloop.md § A parked level load.
   */
  private pendingLoad: (() => void) | null = null;
  /**
   * {@link BUILD_MS_PER_KB} re-measured from the builds this session, so the prediction is *this*
   * machine's speed rather than the reference machine's after the first level.
   */
  private buildMsPerKb = BUILD_MS_PER_KB;
  /**
   * Timestamp of the previous rendering opportunity, skipped ones included — the display's own
   * period. See {@link Game.dueThisFrame}.
   */
  private lastRaf = 0;
  /**
   * When the next frame is due under the FPS cap; ignored while uncapped. See
   * {@link Game.dueThisFrame}.
   */
  private nextFrameAt = 0;
  /** Paused, not stopped: the level is frozen but still being drawn — see {@link Game.stillFrame}. */
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
  /**
   * The session's savegame writer, called when a replay is taken over — see {@link GameOptions}.
   */
  private autoSave: (() => Promise<unknown>) | null;
  /** Center-screen text — docs/hud.md § Center messages. */
  private message: CenterMessage;
  /** The feed over the bar: pickups, joins, deaths — docs/hud.md § HUD messages. */
  private messages: HudMessages;
  /** The "Entering / <level name>" card every map load raises — see ui/hud/levelcard.ts. */
  private levelCard: LevelCard;
  /** The end-of-level popup — see ui/hud/intermission.ts and {@link Game.popup}. */
  private intermission: Intermission;
  /** The campaign-over card the popup hands over to — see ui/hud/endcard.ts and {@link Game.popup}. */
  private endCard: EndCard;
  /**
   * The set's DEHACKED/BEX patch, or null for a set with none. Read once per {@link Game} like the
   * banks beside it: which patch applies depends on the file set, not on the current map.
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
   * Measurement itself always runs; only what `ProfilerHud` draws of it follows the overlay's
   * setting. docs/devmode.md § Profiling overlay.
   */
  private profiler = new FrameProfiler();
  /** What a frame draws, and how (game/presenter.ts). docs/frameloop.md § What runs in a frame. */
  private readonly presenter: Presenter;
  private screenEffects: ScreenEffects;
  private deathOverlay: DeathOverlay;
  /** The board Tab holds up — {@link Game.scoreboardRows}, docs/hud.md § Scoreboard. */
  private scoreboard: Scoreboard;
  readonly title: string;

  /**
   * The level-entry checkpoint: the level as it stood the moment this session advanced into it,
   * which `R` reloads where there is no {@link Game.savedState}. Null on the session's first level,
   * which nothing was advanced into. docs/savegames.md § The checkpoint.
   */
  private checkpoint: GameSnapshot | null = null;
  /** What the last exit of the last level calls — {@link GameOptions.onCampaignEnd}. */
  private onCampaignEnd: (() => void) | null;
  /** The session's loading screen, or null where nothing offers one (the tests). */
  private loading: LoadingScreen | null;
  /**
   * The savegame this level is currently playing out of, if any: the one it was loaded from, and
   * every manual save taken since. It is what `R` goes back to, ahead of {@link Game.checkpoint}
   * (docs/death.md § Player death). Dropped by {@link Game.enterLevel}; a playback's
   * {@link Game.restoreKeyframe} sets it to the landing's own.
   */
  private savedState: GameSnapshot | null;
  private disposed = false;

  /** `?pos=x,y` override for the player start, consumed by the first map load. */
  private startPos: Pos2 | null;
  /**
   * Whether *this level's* completion is disqualified from best times. A `?pos=` start can drop the
   * player anywhere — next to the exit included — and a taken-over replay was someone else's run up
   * to that point, so neither may set a record; the next level entered through an exit is the
   * player's own again. A cheat outlives the level, through `Cheats.used`
   * (docs/hud.md § Best times). Decided up front because {@link Game.startPos} is nulled out once
   * the first map has consumed it.
   */
  private cheated: boolean;
  /**
   * The recorder or playback behind the tic's input, and what the level does for either
   * (game/replay/driver.ts). docs/replays.md § The TicInput seam.
   */
  private readonly driver: ReplayDriver;

  constructor(view: Viewport, audio: AudioEngine, wad: Wad, options: GameOptions) {
    const {
      startMap,
      title,
      skill,
      startPos = null,
      restore = null,
      onCampaignEnd = null,
      gldefsText = '',
      playerSkins = null,
      loading = null,
      playback = null,
      autoSave = null,
      players = null,
      deathmatch = false,
      net = null,
    } = options;
    this.view = view;
    this.localSlot = net ? net.slot : 0;
    this.audio = audio;
    this.wad = wad;
    this.title = title;
    this.skill = skill;
    this.startPos = startPos;
    this.onCampaignEnd = onCampaignEnd;
    this.loading = loading;
    this.savedState = restore;
    // From the save when restoring: a `?pos=` run must not shed the flag by being saved and loaded
    // back (docs/hud.md § Best times). A playback inherits the recording's own verdict with its
    // first snapshot, so the intermission reports what the recording player did rather than the
    // fact of being a replay; whether a best time may actually be *written* is
    // `recordCompletion`'s separate question.
    this.cheated = restore ? restore.cheated : startPos !== null;
    // The snapshot's own when restoring, for the same reason: its thing ids were counted under it.
    this.netgame = restore ? restore.netgame : players !== null || net !== null;
    this.deathmatch = restore ? restore.deathmatch === true : net ? net.session.deathmatch : players !== null && deathmatch;
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
    this.playerSkins = new PlayerSkins({
      file: playerSkins,
      wad,
      bank: this.spriteBank,
      palette: gfx.palette,
      renderer: view.renderer,
    });
    this.hud = new Hud(gfx);
    this.message = new CenterMessage(gfx);
    this.messages = new HudMessages(gfx, this.netgame);
    this.levelCard = new LevelCard(gfx);
    this.intermission = new Intermission(gfx);
    this.endCard = new EndCard(gfx);
    this.deathOverlay = new DeathOverlay(gfx);
    this.scoreboard = new Scoreboard(gfx.palette);
    // Session-scoped like the banks above: which titles apply depends on the loaded file set
    // (its MAPINFO lumps and which IWAD it is), not on the current map.
    this.levelNames = new LevelNames(wad, mapInfo, this.dehacked);
    this.crosshair = new Crosshair(view.renderer.domElement);
    this.autoSave = autoSave;
    this.replayBar = new ReplayBar({
      takeOver: () => this.driver.takeOver(),
      watch: (slot) => this.driver.watch(slot),
      seek: (tic) => this.driver.seekTo(tic),
      levelName: (map) => this.levelNames.nameFor(map),
    });
    this.mapNames = wad.mapNames();
    if (this.mapNames.length === 0) throw new Error('no maps in the selected WADs');
    this.gameMode = gameModeOf(this.mapNames);
    // After `mapNames`: a progression may only name a level the loaded set actually provides.
    this.progression = new LevelProgression(mapInfo, this.mapNames);

    // After the patch, never as a field initializer: a slot's opening inventory reads `Misc`'s
    // `Initial Health`/`Initial Bullets` off `LIMITS` (docs/dehacked.md § Applying: reset, then
    // patch), and after the sprite banks, which its billboard is built on.
    // A restore brings its own slots, however the session was asked to start.
    const wanted = net ? net.slotCount : Math.min(Math.max(players ?? 1, 1), MAX_PLAYERS);
    this.growSlots(restore ? restore.players.length : wanted);
    // `slots` is handed over as is: the list is only ever grown, never replaced.
    this.net = net
      ? new NetSeat(net, {
          slots: this.slots,
          local: this.local,
          view,
          bodies: () => this.bodies(),
          rebindInputs: () => this.driver.rebind(),
          captureState: (joining) => this.captureState(joining),
          restoreLevel: (restore) => this.restoreFromNet(restore),
          say: (text) => this.message.show(text),
          notice: (text) => this.messages.show(text),
        })
      : null;
    const game = this;
    this.driver = new ReplayDriver({
      slots: this.slots,
      local: this.local,
      get viewed() {
        return game.viewed;
      },
      view,
      get level() {
        return game.level;
      },
      nameOf: (slot) => this.rosterName(slot.index),
      viewSwitched: () => this.viewSwitched(),
      drawnCamera: (slot) => this.drawnCamera(slot),
      ownInput: (slot) => this.ownInput(slot),
      ownSource: (slot) => this.ownSource(slot),
      blockedMoment: () => this.blockedMoment(),
      capture: () => this.captureSave({ thumbnail: false }),
      reloadLevel: (state) => this.reloadLevel(state),
      restoreKeyframe: (map, state, reloads) => this.restoreKeyframe(map, state, reloads),
      bodies: () => this.bodies(),
      showLevelCard: () => this.showLevelCard(this.currentMap),
      takenOver: () => this.takenOver(),
      drawBar: () => this.presenter.drawBar(),
      runTic: () => {
        this.beginTic();
        return this.tic();
      },
      tickOverlays: (dt) => this.presenter.tickOverlayClocks(dt),
      silence: (on) => this.audio.setSilent(on),
      clearPain: () => this.screenEffects.clearPain(),
      resyncClock: () => this.resyncClock(),
      drawLanding: (rawDt) => {
        this.profiler.beginFrame();
        this.presenter.draw(1, rawDt, false);
      },
    });
    this.driver.set(null);
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
      fogVisible: (subsector) => this.level.fogOfWar.isDrawn(subsector),
      lights: this.lights,
    });
    // The level is replaced on a map load, so the context reads it off this instance every time
    // rather than capturing its parts — hence the getters, and the alias, since an object
    // literal's own `this` is the literal. `slots` is the one live list.
    this.combat = {
      get world() {
        return game.level.world;
      },
      get things() {
        return game.level.things;
      },
      get slots() {
        return game.slots;
      },
      get pvp() {
        return game.pvp;
      },
      damageSlot: (slot, amount, hit) => this.damageSlot(this.slots[slot], amount, hit),
      triggerShot: (lineIndex, shooter) =>
        this.level.specials.triggerShot(lineIndex, this.shooterKeys(shooter), shooter),
      triggerShotPath: (from, to, blocker, shooter) =>
        this.level.specials.triggerShotPath(from, to, blocker, this.shooterKeys(shooter), shooter),
    };
    this.projectiles = new ProjectileLayer(this.combat, {
      effects: this.effects,
      spriteBank: this.spriteBank,
      spriteMaterials: this.spriteMaterials,
      audio,
    });
    this.monsterAttacks = new MonsterAttacks(this.combat, this.effects, this.projectiles, audio, (slot) =>
      hasPower(this.slots[slot].inventory, 'invisibility'),
    );

    // The local player's own eyes: the tints are theirs.
    this.screenEffects = new ScreenEffects(view.renderer);
    this.presenter = new Presenter({
      view,
      scene: this.scene,
      slots: this.slots,
      get viewed() {
        return game.viewed;
      },
      get level() {
        return game.level;
      },
      get playback() {
        return game.playback;
      },
      get recording() {
        return game.recording;
      },
      title,
      audio,
      lights: this.lights,
      effects: this.effects,
      projectiles: this.projectiles,
      animatedTextures: this.animatedTextures,
      playerSkins: this.playerSkins,
      setDrawsPlayer: this.setDrawsPlayer,
      profiler: this.profiler,
      overlays: {
        hud: this.hud,
        crosshair: this.crosshair,
        replayBar: this.replayBar,
        message: this.message,
        messages: this.messages,
        levelCard: this.levelCard,
        screenEffects: this.screenEffects,
        deathOverlay: this.deathOverlay,
        intermission: this.intermission,
        scoreboard: this.scoreboard,
      },
      scoreboardRows: () => this.scoreboardRows(),
      intermissionScoreRows: () => this.intermissionScoreRows(),
    });

    const start = this.mapNames.indexOf(startMap.toUpperCase());
    // The first-map fallback is fine for a fresh start, but a restore's things
    // and sectors only make sense on the exact map they were saved on.
    if (restore && start < 0) throw new Error(`the selected WADs have no map ${startMap.toUpperCase()}`);
    this.buildLevel(start >= 0 ? start : 0, restore);
    this.net?.bind();
    // After the load, which snapped the camera the way a save restore does: the recording's camera
    // was mid-glide, and its settings are the run's. docs/replays.md § Camera state.
    if (playback) {
      this.driver.startPlayback(playback);
      this.crosshair.detach(true);
    }
  }

  /** {@link Game.driver}'s recorder, if a replay is being recorded. */
  private get recorder(): ReplayRecorder | null {
    return this.driver.recorder;
  }

  private get playback(): ReplayPlayback | null {
    return this.driver.playback;
  }

  /** The slot this browser plays — {@link Game.localSlot}'s. */
  private get local(): PlayerSlot {
    return this.slots[this.localSlot];
  }

  /**
   * The slot the view is drawn for: the HUD and the overlays, the audio listener, the fog's drawn
   * island, the drawn camera. {@link Game.local} but under a playback, whose camera picker watches
   * any player ({@link ReplayPlayback.viewSlot}). No tic reads it. docs/multiplayer.md § Player
   * slots.
   */
  private get viewed(): PlayerSlot {
    const playback = this.playback;
    return playback ? this.slots[playback.viewSlot] : this.local;
  }

  /**
   * The drawn camera where `slot` is the one drawn, null for any other — what
   * {@link PlayerSlot.eachCamera} applies a discontinuity to beside the slot's own.
   */
  private drawnCamera(slot: PlayerSlot): TopDownCamera | null {
    return slot === this.viewed ? this.view.camera : null;
  }

  /**
   * What drives `slot` with no replay in charge: the network's rows, the keyboard for the local
   * slot, nothing for any other. {@link ReplayDriver.set} reads it.
   * docs/replays.md § The TicInput seam.
   */
  private ownInput(slot: PlayerSlot): TicInput {
    const net = this.net;
    if (net) return net.session.input(slot.index);
    return slot === this.local ? this.view.input : IDLE_TIC_INPUT;
  }

  /** {@link Game.ownInput}'s source, as {@link PlayerSlot.source} names it. */
  private ownSource(slot: PlayerSlot): SlotSource {
    if (this.net) return 'row';
    return slot === this.local ? 'live' : 'idle';
  }

  /**
   * As many slots as `count`, built in order — the constructor's, and a snapshot's that holds a
   * player this level did not: a joiner. A slot is never removed.
   */
  private growSlots(count: number): void {
    while (this.slots.length < count) this.slots.push(this.buildSlot(this.slots.length));
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  /**
   * Whether what is running is a replay rather than a run of the player's own — what the menu asks
   * to know whether starting something else would throw anything away (docs/menu.md § One screen,
   * two jobs).
   */
  get watchingReplay(): boolean {
    return this.playback !== null;
  }

  /**
   * Whether this level runs in a network session ({@link GameOptions.net}), which `main.ts` ends
   * it with. docs/multiplayer-net.md § Leaving.
   */
  get networked(): boolean {
    return this.net !== null;
  }

  /**
   * One player slot, its billboard in the scene. The local one runs on the viewport's own camera
   * under the menu's settings; any other on a camera of its own, under a copy of them. What drives
   * its input is {@link ReplayDriver.set}'s to say. Only {@link Game.growSlots} calls it, once per
   * player; a level load rebuilds what is per-level inside.
   */
  private buildSlot(index: number): PlayerSlot {
    // PLAY's own walk cycle: DOOM has no separate idle art, it just holds
    // frame A (this list's first entry) until the player is actually moving.
    // `FULLBRIGHT_FRAMES` lights the muzzle frame (`PLAY F`) the way vanilla does.
    const actor = new SpriteActor(this.spriteBank, this.spriteMaterials, {
      spriteName: 'PLAY',
      animFrames: ['A', 'B', 'C', 'D'],
      brightFrames: FULLBRIGHT_FRAMES,
    });
    const local = index === this.localSlot;
    const slot: PlayerSlot = new PlayerSlot({
      index,
      local,
      inventory: createInventory(),
      simCamera: local ? this.view.camera : new TopDownCamera(this.view.camera.aspect),
      input: IDLE_TIC_INPUT,
      settings: local ? GLOBAL_PLAYER_SETTINGS : { ...GLOBAL_PLAYER_SETTINGS },
      actor,
      consumePickup: (type, dropped, at) => this.consumePickup(slot, type, dropped, at),
    });
    this.scene.add(slot.actor.mesh);
    this.scene.add(slot.shadow.mesh);
    return slot;
  }

  /** Why a recording can't start now, or null — {@link ReplayDriver.recordingRefusal}. */
  recordingRefusal(): string | null {
    return this.driver.recordingRefusal();
  }

  /**
   * Starts recording from this moment; throws {@link Game.recordingRefusal}.
   * docs/replays.md § Recording.
   */
  startRecording(): void {
    this.driver.startRecording();
  }

  /** Ends the recording and hands it over for the store; null when none was running. */
  finishRecording(): ReplayCapture | null {
    return this.driver.finishRecording();
  }

  /**
   * What a take-over changes besides the seam and the camera ({@link ReplayDriver.takeOver}): the
   * level is the player's from here, and {@link Game.cheated} stays set — the run up to here was
   * not theirs.
   * docs/replays.md § Playback.
   */
  private takenOver(): void {
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
   * The view brought onto {@link Game.viewed} once it moved — a playback's camera picker onto
   * another player, a take-over back to the local one: the fog draws that player's island, the
   * drawn camera cuts to their pose, the damage flash and center message raised for the player
   * before are dropped, and the death overlay is the new player's — up over a corpse, killer and
   * all. docs/replays.md § Playback.
   */
  private viewSwitched(): void {
    const { viewed } = this;
    this.level.fogOfWar.setDrawn(viewed.index);
    if (this.view.camera !== viewed.simCamera) this.view.camera.copyFrom(viewed.simCamera);
    this.screenEffects.clearPain();
    this.message.clear();
    this.messages.clear();
    this.deathOverlay.clear();
    this.armDeathOverlay();
  }

  /**
   * The savegame taking over writes, so the handed-over level is one the player can come back to —
   * and, through {@link Game.saveVia}, what `R` reloads from here on. Reported on the feed rather
   * than on the bar, which is gone by the time it lands. A moment that refuses a save (a corpse, an
   * intermission) is skipped without a word: nobody asked for this one, and `R` or the next level's
   * checkpoint covers both. docs/replays.md § Playback, docs/hud.md § HUD messages.
   */
  private async saveTakeOver(): Promise<void> {
    if (!this.autoSave || this.blockedMoment() !== null) return;
    try {
      await this.autoSave();
      this.messages.show('game saved');
    } catch (err) {
      this.message.show((err as Error).message);
    }
  }

  /**
   * The level at `state`, for a keyframe restore ({@link ReplayDriver.runSeek}).
   *
   * @param map      the level to restore — this one when the set has no such map
   * @param reloads  what `R` reloads on that level, as playing through to it leaves them
   */
  private restoreKeyframe(map: string, state: GameSnapshot, reloads: ReloadStates): void {
    const index = this.mapNames.indexOf(map);
    this.buildLevel(index >= 0 ? index : this.level.index, state);
    // Not part of what `buildLevel` restores — it is the session's, and only a load that
    // starts a session (the constructor) reads it from a snapshot. A seek past a cheat the
    // recording typed has to arrive with the recording's own verdict on the run.
    this.cheated = state.cheated;
    // The landing's own, not the pair the playback left: a seek must not change what a take-over's
    // `R` reloads, and the jump may be onto another map. docs/savegames.md § The checkpoint.
    this.savedState = reloads.savedState;
    this.checkpoint = reloads.checkpoint;
  }

  get currentMap(): string {
    return this.level.name;
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
   * own words. Deliberately narrower than {@link Game.levelEnding}: the Icon of Sin's death cascade
   * stays saveable, since `IconSnapshot` carries `exitTimer`.
   */
  private blockedMoment(): string | null {
    if (this.local.dead) return 'while dead';
    if (this.popup === 'intermission') return 'during the intermission';
    if (this.popup === 'endcard') return 'once the campaign is over';
    if (this.pendingExit) return 'while the level is exiting';
    return null;
  }

  /**
   * Saves this moment through the caller's writer — Save, Overwrite and a take-over's autosave,
   * whose store call is all that differs. The capture, the write and {@link Game.savedState} stay
   * together because only a write that actually stored the bytes may move what `R` reloads
   * (docs/death.md § Player death). Refuses by *throwing*, the save path's one refusal convention
   * (docs/savegames.md § What is saved and what is deliberately not).
   */
  async saveVia(write: (capture: SaveCapture) => Promise<unknown>): Promise<void> {
    const capture = this.captureSave();
    await write(capture);
    this.savedState = capture.state;
  }

  /**
   * Starts the frame clock over: whatever real time just passed — paused behind the menu, or spent
   * building a level — is not simulation time, and running it back as a catch-up burst of tics is
   * exactly what {@link Game.accumulator} must not carry. {@link Game.nextFrameAt} is zeroed
   * rather than advanced, since the first frame after is always due and {@link Game.dueThisFrame}
   * resyncs off its own timestamp.
   * docs/frameloop.md § The accumulator.
   */
  private resyncClock(): void {
    this.lastTime = performance.now();
    this.lastRaf = this.lastTime;
    this.accumulator = 0;
    this.nextFrameAt = 0;
  }

  resume(): void {
    // A network game never stopped: the menu was up over it (`pause`), and closes again here.
    const net = this.net;
    if (net?.menuUp) {
      net.menuUp = false;
      this.view.input.reset();
      this.replayBar.setKeysActive(true);
      return;
    }
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
    // The other players are not waiting: the level runs on behind the menu, this slot's rows idle
    // meanwhile. docs/multiplayer-net.md § What a tic does.
    const net = this.net;
    if (net && this.running) {
      net.menuUp = true;
      this.view.input.reset();
      this.replayBar.setKeysActive(false);
      return;
    }
    if (this.paused) return; // a second call would leave two `stillFrame` loops running
    this.replayBar.setKeysActive(false);
    this.stop();
    this.paused = true;
    // The menu opens over the board Tab may be holding up, and no frame runs to take it down.
    this.scoreboard.clear();
    // ESC landing in the one frame a parked load waits out: the pause screen is about to show the
    // level behind it, so build that level now rather than leaving the overlay covering the menu.
    this.flushPendingLoad();
    requestAnimationFrame(this.stillFrame);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.driver.dispose();
    this.net?.dispose();
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
    for (const slot of this.slots) {
      slot.actor.dispose();
      slot.shadow.dispose();
    }
    this.level.dispose(this.scene);
    this.effects.dispose();
    this.materials.dispose();
    this.spriteMaterials.dispose();
    this.playerSkins.dispose();
  }

  /** Clears the per-level 2D overlays, shared by {@link Game.dispose} and every map load. */
  private clearOverlays(): void {
    this.deathOverlay.clear();
    this.message.clear();
    this.messages.clear();
    this.levelCard.clear();
    this.intermission.clear();
    this.endCard.clear();
    this.scoreboard.clear();
  }

  /**
   * What the board Tab holds up shows this frame: {@link Game.scoreRows} while the viewer holds Tab
   * with the menu closed; null otherwise, and over the intermission, which shows its own.
   * docs/hud.md § Scoreboard.
   */
  private scoreboardRows(): ScoreRow[] | null {
    if (this.paused || this.net?.menuUp || this.popup === 'intermission') return null;
    return this.view.input.viewerHolds('Tab') ? this.scoreRows() : null;
  }

  /**
   * What the intermission's board shows above its panel: {@link Game.scoreRows} while that popup
   * is up. docs/hud.md § Scoreboard.
   */
  private intermissionScoreRows(): ScoreRow[] | null {
    return this.popup === 'intermission' ? this.scoreRows() : null;
  }

  /**
   * Every slot's row on the scoreboard. Names and pings are the network session's roster, where
   * there is one.
   *
   * @returns null for a game of one player, unless over the network — no board shows then
   */
  private scoreRows(): ScoreRow[] | null {
    const net = this.net;
    if (!net && this.slots.length < 2) return null;
    const roster = net?.session.roster();
    return this.slots.map((slot) => {
      const entry = roster?.find((r) => r.slot === slot.index);
      return {
        name: entry?.name ?? `Player ${slot.index + 1}`,
        color: slot.drawColor(),
        kills: this.deathmatch ? slot.netFrags() : slot.kills,
        pingMs: entry?.pingMs ?? null,
        local: slot.local,
        present: entry?.present ?? true,
      };
    });
  }

  /**
   * Whether this level is already on its way out and nothing can stop it: an exit queued for the
   * next tic, or the Icon of Sin's death cascade, which runs for `BRAIN_DEATH_TO_EXIT` before it
   * calls `onExit`. A death inside that window raises no overlay and answers no `R` — the level is
   * over, it just hasn't finished saying so. docs/death.md § Dying on the way out.
   */
  private get levelEnding(): boolean {
    return this.pendingExit !== null || this.level.icon.exiting === true;
  }

  /**
   * Whether a player's shots reach the other players: a deathmatch, or coop with friendly fire on
   * — read live, as `pistolStart` is, so a network game's or a playback's pin applies.
   * docs/multiplayer-deathmatch.md § Player versus player.
   */
  private get pvp(): boolean {
    return this.deathmatch || getFriendlyFire();
  }

  /**
   * Whether a weapon the map placed stays for everyone: `P_GiveWeapon`'s
   * `netgame && deathmatch != 2` (`p_inter.c`) — coop, every deathmatch here being `-altdeath`.
   * docs/multiplayer-coop.md § Items and kills.
   */
  private get weaponsStay(): boolean {
    return this.netgame && !this.deathmatch;
  }

  /** A slot's name as the board shows it: {@link Game.rosterName}, else its player number. */
  private playerName(index: number): string {
    return this.rosterName(index) ?? `Player ${index + 1}`;
  }

  /** A slot's name in the network session's roster, null outside a network game. */
  private rosterName(index: number): string | null {
    return this.net?.session.roster().find((entry) => entry.slot === index)?.name ?? null;
  }

  /**
   * Takes the death overlay down when the level starts ending under a corpse — the intermission is
   * what the player should be looking at. Idempotent and self-guarded, so every place the level can
   * start ending calls it unconditionally. docs/death.md § Dying on the way out.
   */
  private endingOverCorpse(): void {
    if (!this.viewed.dead || !this.levelEnding) return;
    this.deathOverlay.clear();
    this.screenEffects.clearPain();
  }

  /**
   * The full state of this moment plus a thumbnail, ready for the store; throws
   * {@link Game.saveRefusal}'s reason when there is one. Only the store's own bookkeeping (ID,
   * name, date) is the caller's to add — a capture identifies its WAD set by content, so this
   * class knows nothing about the library it was picked from.
   */
  private captureSave(options: { thumbnail?: boolean } = {}): SaveCapture {
    const { thumbnail = true } = options;
    const refusal = this.saveRefusal();
    if (refusal) throw new Error(refusal);
    const { level } = this;
    return {
      ...wadSetOf(this.wad, level.name, this.dehacked?.sources ?? null),
      skill: this.skill,
      levelTime: level.time,
      // A thumbnail costs a full extra render, and only a save the menu lists ever draws one.
      thumb: thumbnail ? this.view.thumbnail(this.scene, 320) : '',
      state: this.captureSnapshot(),
    };
  }

  /**
   * The level for a network sync — the host's snapshot everyone restores. A corpse is no moment it
   * refuses: a dead slot restores as one. docs/multiplayer-net.md § Snapshots.
   *
   * @param joining  the slot joining, if any, whose body the snapshot holds fresh
   * @returns null on a moment no snapshot can carry: the popups and a pending exit, which
   *          {@link Game.blockedMoment} refuses a save over too
   */
  private captureState(joining: SlotAssignment | null): NetCapture | null {
    if (this.popup !== null || this.pendingExit !== null) return null;
    const state = this.captureSnapshot();
    if (joining) state.players[joining.slot] = this.freshSlotSnapshot(joining.slot);
    return { map: this.currentMap, state };
  }

  /**
   * A player entering a running level, as a snapshot holds one: a fresh body at `G_DoReborn`'s spot
   * with a fresh inventory and no kills, facing the spot's way — even in a slot someone left.
   * docs/multiplayer-net.md § Joining a game.
   */
  private freshSlotSnapshot(index: number): PlayerSlotSnapshot {
    const spot = this.rebornSpotFor(index);
    const inventory = this.freshInventory();
    const weapons = new WeaponSystem(playerOrigin(index));
    weapons.beginLevel(inventory);
    return {
      player: new Player(this.level.world, spot).snapshot(),
      inventory: serializeInventory(inventory),
      weapons: weapons.snapshot(),
      cameraYawDeg: latticeYaw(headingYawDeg(spot.angle)),
      dead: false,
    };
  }

  /**
   * This moment's snapshot, refusing nothing: what every capture is made of — the level's own share
   * ({@link Level.snapshot}), every slot's, and what outlives a level: the session's verdicts, the
   * effects in flight, the RNG.
   */
  private captureSnapshot(): GameSnapshot {
    return {
      cheated: this.cheated,
      netgame: this.netgame,
      ...(this.deathmatch ? { deathmatch: true as const } : {}),
      players: this.slots.map((slot) => slot.snapshot()),
      ...this.level.snapshot(),
      projectiles: this.projectiles.snapshot(),
      teleportFogs: this.effects.snapshotTeleportFogs(),
      rng: getRandomCursors(),
    };
  }

  private buildLevel(index: number, restore: GameSnapshot | null = null): void {
    // `M_ClearRandom`, from vanilla's own `G_InitNew` — this is the one place
    // every level start funnels through. docs/random.md § What this does not buy.
    clearRandom();
    // A slow load is not simulation time, same as a pause — see `resyncClock`.
    this.accumulator = 0;
    // A snapshot holding a player this level has no slot for yet: a joiner's, over the network.
    if (restore) this.growSlots(restore.players.length);
    for (const slot of this.slots) finishLevel(slot.inventory);
    // `P_SetupLevel` zeroes every player's `killcount` and `G_DoLoadLevel` their `frags`; a
    // restore reads the saved counts back below.
    for (const slot of this.slots) {
      slot.kills = 0;
      slot.frags.fill(0);
    }
    // Whatever was still ringing belongs to the level being torn down — a door
    // closing, a monster's death cry — and its origins are about to be reused.
    this.audio.stopAll();
    // A fresh map always starts with living players, however it was entered.
    for (const slot of this.slots) slot.standUp();
    this.clearOverlays();
    this.screenEffects.clearPain();
    this.popup = null;
    this.pendingEnd = null;
    const at = this.wrapIndex(index);
    const name = this.mapNames[at];
    this.recorder?.levelLoaded(name);
    // Before the map is built rather than after: the track outlives the load,
    // and `play` is a no-op when the level being entered wants the same one.
    this.audio.music.play(this.levelMusic.trackFor(name));

    // The constructor's own load has nothing to tear down.
    if (this.level) this.level.dispose(this.scene);

    const t0 = performance.now();
    const map = loadMap(this.wad, name);
    // Resolved once here rather than per teleport, the way the boss-death table is
    // (`bossDeathTriggersFor`): a map-identity gate can't change while a level runs.
    const monsterStomps = monstersTelefrag(map.name);
    // Straight out of `loadMap`, ahead of the restore below and of everything
    // that mutates a sector — this is the state a later load starts from, so it
    // is what a capture may leave out (docs/savegames.md § Apply order).
    const baseline = sectorBaseline(map);
    // Boom's render transfers, resolved ahead of the restore below: the two scans in `Transfers`'
    // constructor compare sector heights (`markFakeFloors`, `markPools`), and those have to be the
    // map's authored ones. docs/savegames.md § Apply order.
    const transfers = transfersOf(map, (name) => this.wad.find(name)?.size ?? null);
    // Before the sector snapshot below, so `totalSecrets` counts the map's
    // authored secrets — a found secret zeroes its sector's `special`.
    const sectorEffects = new SectorEffects(map, this.slots.length);
    // The sector snapshot is applied to the *map* here, ahead of everything
    // built from it, so meshes/world/fog all bake restored geometry and no
    // rebuild pass is needed — docs/savegames.md § Apply order.
    if (restore) {
      applySectors(map, restore.sectors);
      sectorEffects.restore(restore.sectorEffects);
    }
    const world = new World(map);
    // A fresh world invalidates every cached sector walk — see `PlayerSlot.touch`.
    for (const slot of this.slots) slot.touch = makeTouchCache();
    // Both drop whatever was still in flight or mid-animation in the level
    // being torn down, which would otherwise carry over into the new one.
    this.effects.beginLevel(world);
    // After `beginLevel` (which clears the layer) and after `applySectors`
    // above, so a fog re-samples its sector's *restored* light.
    if (restore?.teleportFogs) this.effects.restoreTeleportFogs(restore.teleportFogs);
    this.projectiles.beginLevel();
    const colormapTints: LevelParts['colormapTints'] = new Map();
    for (const { control } of transfers.waterSectors()) {
      const names = transfers.colormapsOf(control);
      if (!names || colormapTints.has(control)) continue;
      colormapTints.set(control, {
        mid: colormapTint(this.wad, names.mid),
        top: colormapTint(this.wad, names.top),
      });
    }
    // One scan, two sets: every sector a mover will drive, which leaves the static batch for
    // `SpecialsController` to own, and the subset of it that actually moves a vertex — see
    // `MapMeshOptions.movingSectors`.
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
    const subsectorAt = (x: number, y: number) => world.subsectorAt(x, y);
    const built = buildMapMesh(map, this.materials, {
      movableSectors,
      movingSectors,
      transfers,
      subsectorAt,
    });
    this.scene.add(built.group);
    // The colour this level's sky lends every surface under it, resolved once: the sky is fixed for
    // the whole of a level (docs/render-lighting.md § Outdoor sky tint). What the set's MAPINFO
    // names for this map wins, and only where the WAD actually carries it — docs/wad.md § The sky
    // texture.
    setLevelSky(levelSkyArt(map.name, this.mapInfoSkies.get(map.name.toUpperCase()), (name) => this.skyArt(name)));
    const voidFloor = new VoidFloor(map);
    this.scene.add(voidFloor.mesh);
    // The leaf graph the lights flood through, over the polygons the mesh just built — so a torch
    // stops at its wall. docs/lights.md § Light stops at walls.
    this.lights.bindLevel(new LightVisibility(map, built.polys, world));
    const fadePass = new FadePass(
      new WallFader(built.occluders, built.wallMeshes),
      new FlatFader(built.flatSurfaces, built.flatMeshes),
    );
    const forces = new Forces(map, world);
    // Constructed after `applySectors` on purpose, so a displacement scroller
    // spawns watching the restored control-sector height rather than the
    // authored one — `Forces.restore` covers what that ordering can't.
    forces.restore(restore?.scrollers);
    const voodoo = new VoodooDolls(world, !this.deathmatch);
    // Absent in a save from before dolls existed, which leaves them on their own
    // player starts — the same state a fresh load gives them.
    voodoo.restore(restore?.voodoo);
    const surfaceScroller = new SurfaceScroller(forces, built, this.materials);
    // Every slot on its own start (docs/multiplayer-coop.md § Starts), or in a deathmatch on a
    // random one of its own — `P_SetupLevel`'s `G_DeathMatchSpawnPlayer` per player, `G_CheckSpot`
    // refusing only a spot an earlier player took (docs/multiplayer-deathmatch.md § Starts); a save
    // and a `?pos=` override are applied over them below.
    const starts = coopStarts(world);
    const dmStarts = this.deathmatch ? deathmatchStarts(world) : [];
    const taken: Pos2[] = [];
    for (const slot of this.slots) {
      const drawn = restore ? null : deathmatchSpot(dmStarts, (at) => spotTaken(taken, at));
      slot.player = new Player(world, drawn ?? levelStartFor(starts, slot.index, taken));
      if (this.deathmatch && !restore) {
        giveAllKeys(slot.inventory);
      }
      taken.push({ x: slot.player.x, y: slot.player.y });
    }
    const first = this.slots[0];
    if (restore) {
      // The saved positions and cameras replace both the map's own starts and any
      // `?pos=` override, which stays queued for the next fresh level.
      for (const slot of this.slots) {
        const saved = restore.players[slot.index];
        slot.player.restore(saved.player);
        // `latticeYaw`: a save written by a build that took a playback over mid-glide carries an
        // off-lattice yaw, and nothing downstream would ever bring it back.
        // docs/camera.md § Camera orbit.
        slot.eachCamera(this.drawnCamera(slot), (camera) => (camera.yawDeg = latticeYaw(saved.cameraYawDeg)));
      }
    } else {
      // Applied before fog of war is seeded, so an explicit start position reveals
      // exactly what is visible from there and nothing from the map's real spawn.
      if (this.startPos) {
        first.player.moveTo(this.startPos);
        this.startPos = null;
      }
      // Every level (re)load starts each camera facing the same way its player
      // spawns facing, instead of always defaulting to due-north regardless of
      // the map's own player-start angle.
      for (const slot of this.slots) {
        slot.eachCamera(this.drawnCamera(slot), (camera) => camera.faceHeading(slot.player.angle));
      }
    }
    // After both branches, and after the yaw each sets: a camera belongs to
    // the session, not the level, so its smoothed follow point still holds the
    // outgoing level's — a load would open with the camera flying to the
    // player. docs/camera.md § The camera is simulation state.
    for (const slot of this.slots) {
      slot.autoCamera = new AutoCamera(world, transfers);
      // Seeded before snapTo, which poses the camera — so a level opens already
      // framed rather than mid-zoom. docs/camera.md § Auto camera.
      slot.autoCamera.seed(slot.player, slot.simCamera);
      slot.simCamera.snapTo(slot.player.followPoint());
    }
    // A level change re-seeds the viewer's own camera from the simulation's: it is a hard reset of
    // the framing, and gliding in from the outgoing level is exactly what `snapTo` exists to stop.
    if (this.view.camera !== this.viewed.simCamera) this.view.camera.copyFrom(this.viewed.simCamera);
    // One fog for everyone: every player's start is revealed at once.
    const bodies = this.slots.map((slot) => slot.player);
    // None at all in a deathmatch — docs/multiplayer-deathmatch.md § Fog.
    const fogOfWar = new FogOfWar(
      world,
      built.occluders,
      bodies,
      this.viewed.index,
      movableSectors,
      this.deathmatch ? 'off' : 'sweep',
    );
    if (restore) fogOfWar.restoreExplored(restore.fog);
    const specials = new SpecialsController(world, {
      bank: this.materials,
      scene: this.scene,
      fog: fogOfWar,
      built,
      meshOptions: { transfers, subsectorAt, movingSectors },
      onExit: (secret) => {
        this.pendingExit = secret ? 'secret' : 'normal';
      },
      onTeleport: (dest, slotIndex) => {
        const slot = this.slots[slotIndex];
        const { player } = slot;
        // Whatever stands on the landing pad is stomped (`P_TeleportMove`); the
        // player always stomps, so this arrival is never refused — docs/death.md § Telefrag.
        this.level.things.telefragAt(dest, PLAYER_RADIUS, true, targetOfSlot(slotIndex));
        // The other players' half of the stomp, which the thing layer cannot see.
        for (const other of this.slots) {
          if (other === slot || other.dead || !bodiesOverlap(dest, other.player, PLAYER_RADIUS * 2)) continue;
          this.damageSlot(other, TELEFRAG_DAMAGE, { from: dest, cause: targetOfSlot(slotIndex), slot: slotIndex });
        }
        // The origin puff's position has to be captured before teleportTo
        // overwrites it; the landing `z` only exists after. See
        // SpriteFxLayer.spawnTeleportPair for the pair itself.
        const from = { x: player.x, y: player.y, z: player.z };
        player.teleportTo(dest);
        // Boom's silent family spawns neither puff and plays no `telept` —
        // docs/specials-teleporters.md § Silent and line-to-line teleporters.
        if (!dest.silent) this.effects.spawnTeleportPair(from, dest, player.z);
        // The follow point always snaps; the yaw is reoriented by a vanilla teleport and turned
        // *relatively* by a silent one, which is what preserves the player's own Q/E orbit —
        // `turnYaw`, not an assignment, so a step still animating survives the trip
        // (docs/specials-teleporters.md § Silent and line-to-line teleporters). Yaw first either
        // way: `snapTo` poses the camera with it.
        // Both of the slot's cameras: a replay's viewer must not be left gliding across the map
        // either, and the operations are applied rather than the state copied, so a manual view
        // keeps its zoom.
        slot.eachCamera(this.drawnCamera(slot), (camera) => {
          if (dest.rotateBy === undefined) camera.faceHeading(dest.angle);
          else camera.turnYaw((dest.rotateBy * 180) / Math.PI);
          camera.snapTo(player.followPoint());
        });
      },
      // Who a mover can catch. The tests over them are the specials layer's own; this hands over
      // the bodies and nothing else — `things` as a getter because it is built further down.
      occupants: {
        things: () => this.level.things,
        players: bodies,
        // A crusher over a voodoo doll kills the player it stands for.
        dolls: voodoo.dolls,
        damageSlot: (slot, amount) => this.damageSlot(this.slots[slot], amount, { cause: 'crush' }),
        sprayBlood: (at) => this.effects.spawnCrushBlood(at),
      },
      playersAt: bodies,
      movableSectors,
      sfx: this.audio,
      switchPairs: this.switchPairs,
    });
    if (restore) {
      specials.restore(restore.specials);
      world.restoreSoundAlerted(restore.soundAlerted);
    }

    const things = buildThingSprites(world, {
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
        this.level.specials.notifyBossDeath(type, anyPlayerAlive(this.slots));
        this.level.icon.notifyBossDeath(type);
        this.endingOverCorpse();
      },
      restore: restore?.things,
      // `spawnTeleportFog` plays the `telept` that goes with each, exactly as a teleport does.
      onRespawn: (from, to) => {
        this.effects.spawnTeleportFog(from);
        this.effects.spawnTeleportFog(to);
      },
      onKill: (slot) => {
        this.slots[slot].kills++;
      },
      onItemRespawn: (at) => this.effects.spawnItemFog(at),
      lights: this.lights,
      netgame: this.netgame,
      deathmatch: this.deathmatch,
    });
    this.scene.add(things.group);

    // Built after `things`, which its cube spawns and telefrags go through.
    const icon = new IconOfSin(map, {
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
    this.level = new Level({
      name,
      index: at,
      monsterStomps,
      sectorBaseline: baseline,
      world,
      transfers,
      colormapTints,
      sectorEffects,
      built,
      voidFloor,
      fadePass,
      forces,
      surfaceScroller,
      voodoo,
      starts,
      dmStarts,
      fogOfWar,
      specials,
      things,
      icon,
      time: restore ? restore.levelTime : 0,
    });
    if (restore) {
      icon.restore(restore.icon);
      this.projectiles.restore(restore.projectiles);
      for (const slot of this.slots) slot.restore(restore.players[slot.index]);
      // A corpse restored — a keyframe's, a network sync's — is a death already under way: its
      // overlay goes back up, killer and all.
      this.armDeathOverlay();
    }

    // Raised last: this method clears every overlay at its top, so a card shown any earlier than
    // here would be wiped by its own load. A restore shows none — "Entering …" announces arriving
    // at a level, and loading a save resumes one already under way — the level-entry checkpoint
    // `restart` reloads included, which is a load like any other.
    if (!restore) this.showLevelCard(name);

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
        `${map.things.length} things (${things.count} rendered), ` +
        `${built.triangles} tris, ` +
        `${built.trimmedUppers + specials.trimmedUppers} ceiling trims, ` +
        `${islands} island${islands === 1 ? '' : 's'} in ${Math.round(buildMs)} ms`,
    );
    if (built.missingTextures.length > 0) {
      console.warn('missing textures:', built.missingTextures.join(', '));
    }
    if (things.missingArt.length > 0) {
      console.warn('things skipped, no sprite in this WAD set:', things.missingArt.join(', '));
      // Said on screen too, not only in the console: a skipped thing is simply absent from the
      // level, and nothing else explains why. Survives this load because `clearOverlays` runs
      // ahead of the build, and sits clear of the level card's own band
      // (docs/hud.md § Center messages).
      this.message.show(missingArtMessage(things.missingArt.length));
    }
  }

  /** The "Entering" card for `map` — raised by every arrival at a level. */
  private showLevelCard(map: string): void {
    this.levelCard.show(this.levelNames.nameFor(map), this.levelNames.graphicFor(map));
  }

  /**
   * Stops both loops. {@link Game.dispose} uses this rather than {@link Game.pause} — see
   * {@link Game.stillFrame}.
   */
  private stop(): void {
    this.running = false;
    this.paused = false;
    this.audio.suspend();
  }

  /**
   * Keeps redrawing the frozen level while paused, so the menu can sit over it — no dt, no input,
   * no profiling, every ~50 ms (docs/frameloop.md § Pausing). {@link Game.dispose} must go through
   * {@link Game.stop}, never {@link Game.pause}, or this would keep drawing a scene whose geometry
   * and materials are already released.
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
   * ({@link SpecialsController.crossMonster} — teleports plus the few door/lift types
   * vanilla lets one activate). Usually that is a monster walking, but a barrel or a decoration a
   * conveyor carried counts too — docs/specials-forces.md § Scrollers and conveyors. A teleport
   * gets the same `TFOG` puff at both ends the player's own does; vanilla spawns it for any thing
   * that teleports, not just the player.
   */
  private thingCrossedLines(prev: Pos2, mover: CrossingBody): TeleportDest | null {
    const dest = this.level.specials.crossMonster(prev, mover, this.playerOneKeys);
    return this.realizeThingTeleport(dest, mover);
  }

  /**
   * The other half of the same pair: `P_Move`'s `spechit` pass for a monster whose step to
   * `(tryX, tryY)` was refused ({@link SpecialsController.useMonster}), which is what opens a door
   * for a chasing monster. A teleport-switch landing is realized exactly as a crossed one is.
   * docs/monster-ai.md § Opening doors.
   */
  private thingUsedLines(mover: CrossingBody, tryX: number, tryY: number): TeleportDest | null {
    const dest = this.level.specials.useMonster(mover, tryX, tryY, this.playerOneKeys);
    return this.realizeThingTeleport(dest, mover);
  }

  /**
   * The landing a monster's teleport asked for, stomped and puffed — shared by the two paths
   * above, since a teleport means the same thing however the line was activated.
   *
   * @returns null where no teleport fired, or where one did and `P_TeleportMove` refused the
   *          landing, which leaves the thing where it stood — docs/death.md § Telefrag
   */
  private realizeThingTeleport(dest: TeleportDest | null | undefined, mover: CrossingBody): TeleportDest | null {
    if (!dest) return null;
    const { things, monsterStomps, world } = this.level;
    if (!things.telefragAt(dest, mover.blockRadius, monsterStomps, mover.id)) return null;
    // The players' half of the stomp: `telefragAt` covered every other body, but the
    // thing layer holds no player reference (same split as the spawn cube's).
    for (const slot of this.slots) {
      if (slot.dead || !bodiesOverlap(dest, slot.player, mover.blockRadius + PLAYER_RADIUS)) continue;
      if (!monsterStomps) return null;
      this.damageSlot(slot, TELEFRAG_DAMAGE, { from: dest, cause: mover.type, source: { id: mover.id, type: mover.type } });
    }
    // Boom's silent numbers puff at neither end (docs/specials-teleporters.md § Silent and
    // line-to-line teleporters). A fog puff has no body, so the plain sector
    // floor is the whole answer — `groundFloor` at radius 0 would walk the
    // lines to arrive at the same number.
    if (!dest.silent) {
      const from = { x: mover.x, y: mover.y, z: world.floorAt(mover.x, mover.y) };
      this.effects.spawnTeleportPair(from, dest, world.floorAt(dest.x, dest.y));
    }
    return dest;
  }

  /**
   * Applies armor-mitigated damage ({@link applyDamage}) to one player, transitioning to the death
   * animation once health hits 0. See docs/death.md § Player death.
   *
   * @returns whether the hit landed — false for a corpse and for invulnerability alike, so a
   *          caller with a follow-up effect (`resolveVileBlast`'s knockup) can gate on it
   */
  private damageSlot(slot: PlayerSlot, rawAmount: number, hit: PlayerHit = {}): boolean {
    if (slot.dead || rawAmount <= 0) return false;
    const { player, inventory } = slot;
    // Before anything reads it — knockback and the pain flash included, exactly as in vanilla.
    const amount = playerDamageAtSkill(rawAmount, this.skill);
    // Unclamped — vanilla's `target->health`, which the gib and the death cry read.
    // docs/death.md § Player death.
    const health = applyDamage(inventory, amount, slot.cheats.god);
    if (health === null) return false;
    if (hit.from) player.applyDamageThrust(thrustSpeed(amount, PLAYER_MASS), hit.from.x, hit.from.y);
    // The flash is the local player's own eyes, and the overlay below their own screen.
    if (slot === this.viewed) this.screenEffects.addPain(amount);
    if (health <= 0) {
      const death = playerDeath(health, this.gameMode);
      // The cause is kept on the slot, whoever is drawn: the overlay can go up long after the
      // blow — a view switched onto the corpse, a snapshot restored with it.
      // docs/death.md § Who killed the player.
      slot.die(hit.cause, death.gibbed);
      if (this.deathmatch) {
        const killer = fragCredit(slot.index, hit);
        if (killer !== null) this.slots[killer].frags[slot.index]++;
      }
      // Everyone's feed, in a game with someone else to read it; the overlay below is the victim's.
      if (this.netgame) {
        const killer = hit.slot !== undefined && hit.slot !== slot.index ? this.playerName(hit.slot) : null;
        this.messages.show(deathLine(this.playerName(slot.index), killer));
      }
      // Dying on an `exitBelowHealth` floor ends the level whatever killed the player, not only
      // when that floor's own damage did it — E1M8's pit is the ending, and a baron finishing the
      // job there must not leave the episode unwon. Set before the overlay below, which
      // `levelEnding` then keeps from being armed at all. docs/specials.md § Damage floors.
      const { sectorEffects, world } = this.level;
      if (sectorEffects.exitsOnDeath(world, player)) this.pendingExit = 'normal';
      // `player.update` stops running from here on, so it never writes `prev*`
      // again: leaving the window open would have every frame lerp the corpse
      // somewhere else between the last two live tics. docs/frameloop.md §
      // Interpolation.
      player.syncInterpolation();
      // docs/audio.md § Player and pickups.
      this.audio.play(death.sound, player, playerOrigin(slot.index));
      // The hint depends on what `R` will actually do — reload a savegame or restart the level —
      // and under a playback `R` is the record's rather than the viewer's, so there is nothing to
      // offer (docs/death.md § Player death).
      if (slot === this.viewed) this.armDeathOverlay();
      return true;
    }
    this.audio.play('plpain', player, playerOrigin(slot.index));
    slot.actor.playOnce(PLAYER_PAIN_FRAMES, PLAYER_ACTION_FRAME_SECONDS);
    return true;
  }

  /**
   * A netgame's respawn, in place — `G_DoReborn`: a fresh inventory and the cheats cleared
   * (`G_PlayerReborn`), the spot {@link rebornSpot} picks with `G_CheckSpot`'s fog in front of it,
   * and the body stood back up there. The level runs on untouched.
   * docs/multiplayer-coop.md § Respawn.
   */
  private respawnSlot(slot: PlayerSlot): void {
    const spot = this.rebornSpotFor(slot.index);
    slot.inventory = this.freshInventory();
    slot.cheats.reborn();
    slot.player.respawnAt(spot);
    slot.touch = makeTouchCache();
    slot.standUp();
    this.level.specials.reseatSlot(slot.index, spot);
    this.effects.spawnArrivalFog(spot, this.level.world.floorAt(spot.x, spot.y));
    // Every camera of the slot faces the way the new body does and cuts to it, as a teleport does.
    slot.eachCamera(this.drawnCamera(slot), (camera) => {
      camera.faceHeading(spot.angle);
      camera.snapTo(slot.player.followPoint());
    });
    slot.autoCamera.seed(slot.player, slot.simCamera);
    if (slot === this.viewed) {
      this.deathOverlay.clear();
      this.screenEffects.clearPain();
    }
  }

  /**
   * An inventory for a body just spawned or reborn: {@link createInventory}'s, and in a deathmatch
   * every key on top — `P_SpawnPlayer`'s grant, once for every spawn path.
   * docs/multiplayer-deathmatch.md § Rules.
   */
  private freshInventory(): Inventory {
    const inventory = createInventory();
    if (this.deathmatch) giveAllKeys(inventory);
    return inventory;
  }

  /**
   * Where slot `index` is reborn: `G_DoReborn`'s pick, its own start first — or in a deathmatch a
   * random deathmatch start, the coop pick only when every draw was blocked
   * (docs/multiplayer-deathmatch.md § Starts).
   */
  private rebornSpotFor(index: number): Placement {
    const { starts, dmStarts } = this.level;
    const blocked = (at: Pos2) => this.spotBlocked(at);
    return deathmatchSpot(dmStarts, blocked) ?? rebornSpot(starts, levelStartFor(starts, index, []), blocked);
  }

  /**
   * `G_CheckSpot`'s `P_CheckPosition` for a respawn: a player's box at `at` against the walls and
   * every solid body there — monsters, barrels and solid decorations, and the living players.
   */
  private spotBlocked(at: Pos2): boolean {
    const blockers = this.solidBodiesAround(at);
    const { world } = this.level;
    const z = world.groundFloor(at.x, at.y, PLAYER_RADIUS);
    const collider = makeCollider({ radius: PLAYER_RADIUS, z, height: PLAYER_HEIGHT, blockers });
    return world.positionBlocked(at.x, at.y, collider);
  }

  /**
   * The solid bodies around `at`: the thing layer's, and every living player but `except` — a
   * player is `MF_SOLID` to another (`PIT_CheckThing`). docs/multiplayer-coop.md § Collision.
   */
  private solidBodiesAround(at: Pos2, except?: PlayerSlot): ThingBlocker[] {
    const bodies = this.level.things.solidBodies(at);
    for (const other of this.slots) {
      if (other !== except && !other.dead) {
        bodies.push(playerBlocker(other.player));
      }
    }
    return bodies;
  }

  /**
   * The keys a shot fires a line's special with: the shooting player's, or — for a monster's
   * stray shot — {@link Game.playerOneKeys}.
   */
  private shooterKeys(shooter: number | null): ReadonlySet<KeySlot> {
    return shooter === null ? this.playerOneKeys : this.slots[shooter].inventory.keys;
  }

  /**
   * The keys an activation with no player of its own carries — a monster's crossing or stray shot:
   * player 1's, which is what those have always carried.
   */
  private get playerOneKeys(): ReadonlySet<KeySlot> {
    return this.slots[0].inventory.keys;
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
    if (this.netgame) return 'respawn';
    return this.savedState !== null ? 'reload-save' : 'restart';
  }

  /**
   * Arms the death overlay over {@link Game.viewed}'s corpse, naming what killed them
   * ({@link PlayerSlot.deathCause}) — nothing while that player lives, once the level is on its way
   * out, or over an end-of-level popup, which outlives that window (docs/death.md § Dying on the
   * way out).
   */
  private armDeathOverlay(): void {
    const { viewed } = this;
    if (!viewed.dead || this.levelEnding || this.popup !== null) return;
    const killer = obituary(viewed.deathCause, (slot) => this.playerName(slot));
    this.deathOverlay.show(killer, this.deathHint(), viewed.deathFrames);
  }

  /**
   * Whatever was typed this tic, the one response a completed code prints, and the level an
   * IDCLEV asked for.
   *
   * A cheat also ends this run's claim on a best time, the same way a `?pos=` start does — it
   * travels in the save with {@link Game.cheated}. docs/cheats.md § Saves and best times.
   */
  private applyCheats(slot: PlayerSlot): void {
    const typed = slot.input.typed();
    if (!typed) return;
    const response = slot.cheats.type(typed, slot.inventory, this.gameMode);
    if (response) {
      if (slot === this.viewed) this.message.show(response);
      this.cheated = true;
    }
    const warp = slot.cheats.takeWarp();
    if (warp !== null) this.warpToLevel(warp, slot);
  }

  /**
   * IDCLEV's own block: the two characters name a map of the loaded set, which is entered as a
   * fresh game — `G_DeferedInitNew`, so it pistol-starts whatever the setting says and the toggles
   * go with the rebirth. The level arriving is the whole response; only a pair naming no map says
   * anything, which is `cheat_clev`'s "IDCLEV target not found" in prboom-plus (vanilla's own
   * `ST_Responder` returns silently). docs/cheats.md § IDCLEV.
   */
  private warpToLevel(warp: string, slot: PlayerSlot): void {
    const targets = warpTargets(warp, this.currentMap);
    const index = targets.map((name) => this.mapNames.indexOf(name)).find((at) => at >= 0);
    if (index === undefined) {
      this.message.show(`No such level: ${targets[0]}`);
      return;
    }
    slot.cheats.warped();
    this.enterLevel(index, true);
  }

  /**
   * Advancing into another level: the exit the player just took, or IDCLEV's warp, which arrives
   * the same way. The checkpoint is taken *after* the load — what a death on the
   * new level returns to is that level at tic 0. Advancing while dead is `G_DoLoadLevel`'s
   * `PST_DEAD` → `PST_REBORN`, read off player state here rather than queued at the exit;
   * {@link Game.restart} restores a checkpoint instead (docs/death.md § Player death).
   *
   * @param reborn  a fresh {@link Inventory} for a living player too, as the pistol-start setting
   *                gives every transition (docs/hud.md § End card, docs/items.md § Pistol start)
   */
  private enterLevel(index: number, reborn = false): void {
    this.loadLevel(index, () => this.runEnterLevel(index, reborn));
  }

  /**
   * Every level load that happens while the loop is running goes through here: `run` at once, or
   * parked for the next frame with the loading screen up when the map is big enough that building
   * it would freeze visibly. The constructor's own first load does not — there is no frame to defer
   * to yet, and nothing on screen to freeze. docs/session.md § The loading screen.
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

  /**
   * Indices wrap, so an exit past the last map lands on the first — {@link Level.index} always is.
   */
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

  /** {@link Game.enterLevel}'s body, run either at once or on the frame after the overlay is up. */
  private runEnterLevel(index: number, reborn: boolean): void {
    // A level entered through an exit is the player's own run again, whatever disqualified the last
    // one — a `?pos=` start, a replay taken over. A cheat is the exception: it is the session's,
    // like the toggles it leaves (docs/hud.md § Best times).
    this.cheated = this.slots.some((slot) => slot.cheats.used);
    // Before the load, which hands these very objects to `WeaponSystem.beginLevel`.
    for (const slot of this.slots) {
      if (slot.dead || reborn || getPistolStart()) {
        slot.inventory = createInventory();
      }
    }
    // A savegame belongs to the level it was taken on; the checkpoint taken below — the level as
    // entered, the inventory carried in — is what `R` reloads from here on. docs/savegames.md § The
    // checkpoint.
    this.savedState = null;
    this.buildLevel(index);
    this.checkpoint = this.captureSnapshot();

    // The level's own seek anchor, on the tic its track marker gets: the advancing tic's row was
    // closed before this ran, so `ticCount` is already the new level's first. The checkpoint's own
    // object, so a recorded reload of it files no second copy. docs/replays.md § Seeking.
    this.driver.writeKeyframe(this.checkpoint);
  }

  /**
   * Where the exit just taken leads, into {@link Game.nextMapIndex} and {@link Game.pendingEnd}.
   * {@link LevelProgression} answers for the WAD set's own MAPINFO and for vanilla's tables; where
   * neither knows one — a PWAD map set naming its levels its own way — the next map in load order
   * stands in.
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
    this.nextMapIndex =
      next.kind === 'map' ? this.mapNames.indexOf(next.name) : this.level.index + 1;
  }

  /**
   * Swaps the intermission for the campaign-over card, on the same frozen level and the same
   * continue key — {@link Game.intermissionTime} restarts so the press that dismissed the popup
   * can't carry straight through this one. docs/hud.md § End card.
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
   * `R`, while dead: the level again from {@link Game.savedState}, else from
   * {@link Game.checkpoint}, else fresh with a fresh inventory (docs/death.md § Player death). All
   * three are in memory, so each is one {@link Game.loadLevel}, and `R` on a map slow enough to
   * freeze gets the loading screen an exit would.
   */
  private restart(): void {
    // A replay restarts where its recording did: the restore event, not the key
    // (docs/replays.md § Restore events).
    if (this.playback) return;
    const state = this.savedState ?? this.checkpoint;
    this.loadLevel(this.level.index, () => this.reloadLevel(state));
  }

  /**
   * The level again — every way `R` reloads ends here, which is what lets a recording write the
   * reload down as one event at the tic it lands on. docs/replays.md § Restore events.
   *
   * @param state  the snapshot to reload, or null for the level fresh with a fresh inventory
   */
  private reloadLevel(state: GameSnapshot | null): void {
    if (!state) for (const slot of this.slots) slot.inventory = createInventory();
    this.recorder?.restore(this.currentMap, state);
    this.buildLevel(this.level.index, state);
  }

  /**
   * The host's snapshot, in place of whatever this browser had run to: a resync, or a joiner's
   * arrival — which adds a slot, and ends a recording, whose record has no room for one.
   * docs/multiplayer-net.md § Snapshots.
   *
   * @returns false when these WADs have no such map, which ends the session and this {@link Game}
   *          with it ({@link NetSeat.ready})
   */
  private restoreFromNet(restore: NetRestore): boolean {
    const index = this.mapNames.indexOf(restore.map);
    if (index < 0) return false;
    const joinEndsRecording = this.recorder !== null && restore.state.players.length > this.slots.length;
    if (joinEndsRecording) this.finishRecording();
    this.recorder?.restore(restore.map, restore.state);
    this.buildLevel(index, restore.state);
    this.cheated = restore.state.cheated;
    // After the build, whose `clearOverlays` would take it straight down again.
    if (joinEndsRecording) this.messages.show('recording ended: a player joined');
    return true;
  }

  /**
   * What goes between two tics: the seat's row and poses ({@link NetSeat.beginTic}), then the
   * recorder's or the playback's own step ({@link ReplayDriver.beginTic}).
   * docs/replays.md § Restore events, docs/multiplayer-net.md § What a tic does.
   */
  private beginTic(): void {
    this.net?.beginTic();
    this.driver.beginTic();
  }

  /**
   * The FPS cap ({@link getFpsCap}): whether this rendering opportunity is the one to use.
   * Skipping is the whole frame, so the input it would have consumed arrives on the next one; read
   * live rather than cached, so a change in the menu applies to the level already running.
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
    if (this.driver.seeking) {
      this.driver.runSeek(rawDt);
      requestAnimationFrame(this.frame);
      return;
    }
    // A playback banks time at its own speed, and none while paused or spent — the bar's pause
    // is not the menu's, the frame keeps running (docs/replays.md § Playback). A network game
    // banks none while a peer's rows are missing: the wait is not simulation time, so the frame
    // holds rather than owing tics (docs/multiplayer-net.md § Lockstep).
    const playback = this.playback;
    const stalled = this.net !== null && !this.net.ready();
    // A restore that ended the session has had `main.ts` dispose this `Game` meanwhile.
    if (this.disposed) return;
    const held = stalled || (playback !== null && (playback.paused || playback.ended));
    this.accumulator += held ? 0 : rawDt * (playback?.speed ?? 1);
    if (this.accumulator > MAX_TICS_PER_FRAME * DOOM_TIC) this.accumulator = MAX_TICS_PER_FRAME * DOOM_TIC;
    this.profiler.beginFrame();

    let ran = 0;
    while (this.accumulator >= DOOM_TIC && ran < MAX_TICS_PER_FRAME) {
      if (playback && !playback.hasTic) {
        this.accumulator = 0;
        break;
      }
      // The second and later tics of a frame ask again: each spends a row.
      if (ran > 0 && this.net !== null && !this.net.ready()) {
        if (this.disposed) return;
        this.accumulator = 0;
        break;
      }
      this.accumulator -= DOOM_TIC;
      ran++;
      this.beginTic();
      // A tic that swapped the level (an exit, a restart) invalidates
      // everything the rest of this frame would touch — stop and let the next
      // frame start clean on the new map.
      if (this.tic()) {
        requestAnimationFrame(this.frame);
        return;
      }
      this.driver.syncViewCamera(DOOM_TIC);
    }
    // A playback that ran no tic — paused, or spent — still lets the viewer look around.
    if (held) this.driver.syncViewCamera(DOOM_TIC);
    if (stalled) this.net?.noticeStall(now);

    // A frozen simulation is drawn at the tic-exact pose, not at the leftover
    // accumulator: with no further tic coming, the last two tics stay apart
    // forever while `alpha` keeps changing every frame, so the still scene
    // shakes between them. docs/frameloop.md § Interpolation.
    const still = this.popup !== null || (playback !== null && (playback.paused || playback.ended));
    this.presenter.draw(still ? 1 : this.accumulator / DOOM_TIC, rawDt, still);
    requestAnimationFrame(this.frame);
  };

  /**
   * One fixed {@link DOOM_TIC} step of the whole simulation, and the only place input is consumed.
   *
   * Parts of the call order here are load-bearing — specials before {@link Player.update} so a
   * lift underfoot has already moved when {@link World.groundFloor} samples it, the aim ray before
   * {@link Player.update} so {@link Player.angle} is this tic's.
   * docs/frameloop.md § What runs in a tic.
   *
   * @returns true if it loaded a different level, which makes every reference the caller holds
   *          stale
   */
  private tic(): boolean {
    const local = this.local;
    // The live keyboard, or the replay standing in for it, as `ReplayDriver.set` last pointed it.
    const input = local.input;
    // The level is over and frozen behind the popup: nothing is advanced — not the clock, not the
    // specials, not a monster — only the still scene is redrawn under it. Space/Enter rather than
    // any key, since Escape belongs to the menu (main.ts) and would otherwise both pause and eat
    // the popup in the same press.
    if (this.popup) {
      this.intermissionTime += DOOM_TIC;
      // Any slot's press: over the network every browser sees every row, so this is one answer.
      const go = this.slots.some((slot) => slot.input.pressed('Space') || slot.input.pressed('Enter'));
      this.endTicInputs();
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
      this.enterLevel(this.nextMapIndex, this.pendingEnd !== null);
      return true;
    }
    for (const slot of this.slots) {
      // Ahead of every system a cheat changes, and only while there is a live player to change:
      // a corpse answers `R` and nothing else. docs/cheats.md § Typing a code.
      if (!slot.dead) this.applyCheats(slot);
      // Set here rather than at the toggle, since a `Player` is rebuilt by every level load and the
      // cheat outlives it — and here rather than in the player block below, so that every system
      // this tic reads one `noclip`, not last tic's. docs/cheats.md § IDCLIP.
      slot.player.noclip = slot.cheats.noclip;
      // The slot's settings, pushed the same way for the same reason — the menu's for the local
      // slot (docs/multiplayer.md § Player settings).
      slot.player.autorun = slot.settings.autorun;
      slot.weapons.autoSwitch = slot.settings.autoSwitchWeapon;
    }
    // Under `net` the framing keys act on the drawn camera, in `tickViewCamera`.
    if (!this.net) handleHotkeys(input, local.simCamera);
    // Set before any system runs, since specials/monsters/weapons all raise
    // sounds during the update below. The camera's yaw is last tic's (it
    // settles in `camera.tick`, at the end) — a tic of smoothing lag on the
    // pan axis, which is inaudible. The drawn camera's: the one the player is looking through.
    this.audio.setListener(this.viewed.player, this.view.camera.viewerAngleDeg + 180);
    // A live slot's camera turns on its own keys; a replay's is posed from the record
    // (`beginTic`) and left alone here.
    for (const slot of this.slots) {
      if (slot.source === 'live') slot.simCamera.applyYawInput(slot.input, DOOM_TIC);
    }

    this.profiler.time('Specials', () => {
      const { specials } = this.level;
      specials.beginTic(DOOM_TIC);
      for (const slot of this.slots) {
        // A corpse uses no line and crosses none — `P_DeathThink` runs instead of
        // `P_MovePlayer` — and in a netgame its use press is the respawn's.
        if (slot.dead) continue;
        specials.activate(slot.index, slot.player, slot.input, slot.inventory.keys, slot.player.noclip);
      }
      specials.endTic(DOOM_TIC);
      // After the movers, not before: a displacement scroller's rate is the
      // height change its control sector just made this tic.
      this.level.forces.tick();
      // And the dolls after the forces that carry them, so a conveyor's
      // impulse and the walk lines it pushes a doll across land in one tic.
      // A doll stands on a player-1 start and is player 1's mobj throughout.
      if (!this.level.voodoo.empty) {
        const first = this.slots[0];
        this.level.voodoo.update(
          DOOM_TIC,
          this.level.forces,
          (prev, doll) => specials.crossVoodoo(prev, doll, first.inventory.keys),
          // A doll is a player mobj carrying `MF_PICKUP`, so what it runs over lands in the real
          // player's inventory — the same "on the player's behalf" the damage floors below use.
          // Gated on a living player, standing in for vanilla's `toucher->health` check.
          (doll, attempted) => {
            if (first.dead) return;
            this.level.things.tryPickup(doll, attempted, PICKUP_RANGE, first.consumePickup);
          },
        );
      }
    });
    // The `oof` a refused keyed line already played is raised inside `specials`; the message that
    // says *which* key it wants is this layer's, since that controller has no HUD — and the local
    // player's own screen.
    for (const slot of this.slots) {
      const locked = this.level.specials.consumeLockedLine(slot.index);
      if (locked && slot === this.viewed) {
        this.message.show(...lockedLineMessage(locked.lock, locked.kind));
      }
    }
    this.checkDeathmatchLimits();
    // Deferred from the exit trigger's callback (`pendingExit`): the popup goes up on the level as
    // it stands, and the continue key at the top of `tic` loads the next one.
    if (this.pendingExit) {
      this.resolveExit(this.pendingExit === 'secret');
      // Before `pendingExit` is cleared, which is half of what `levelEnding` reads. Catches a
      // death that beat the exit here rather than at the boss-death fan-out: an exit-line
      // walk-over is queued and consumed with nothing in between, but a crusher can kill between.
      this.endingOverCorpse();
      this.pendingExit = null;
      // The cheated popup reads the *same* flag that already refuses a best time — a run that
      // can't set one has nothing worth stating (docs/cheats.md § Saves and best times).
      this.intermission.setContinueHint(this.viewerContinues);
      this.intermission.show(this.level.stats(), this.recordCompletion(), this.parFor(), this.cheated);
      // Vanilla's own `S_ChangeMusic(mus_inter)` at the intermission, keeping
      // the level's track when the set has no intermission lump.
      const between = this.levelMusic.intermissionTrackFor(this.currentMap);
      if (between) this.audio.music.play(between);
      this.popup = 'intermission';
      this.intermissionTime = 0;
      this.endTicInputs();
      return false;
    }

    // A corpse answers one input: in single player `R`, which reloads the level; in a netgame use
    // or `R` on the slot's own input, whichever browser this is, which stands them back up in it.
    // Everything else a player drives is skipped below instead of branching here.
    if (this.netgame) {
      for (const slot of this.slots) {
        if (slot.dead && !this.levelEnding && respawnPressed(slot.input)) {
          this.respawnSlot(slot);
        }
      }
    } else if (local.dead && !this.levelEnding && input.pressed('KeyR')) {
      this.endTicInputs();
      this.restart();
      return true;
    }

    for (const slot of this.slots) {
      // Auto-aim, movement, firing and pickups freeze once a player is dead; fog of war, things
      // and effects below keep ticking, so a rocket fired just before dying finishes its flight.
      // Re-posed at alpha 1 so the ray is cast through the previous tic's exact camera rather than
      // the last frame's interpolated one, which is what keeps aim framerate-independent. Must sit
      // immediately before the ray — `draw` overwrites the pose. docs/frameloop.md § Posing for the
      // aim ray.
      let cursor: Pos2 | null = null;
      if (!slot.dead) {
        slot.simCamera.applyToCamera(1);
        cursor = this.updateLivingPlayer(slot, DOOM_TIC);
      }
      // After movement (the probe runs from this tic's position) and before
      // camera.tick, whose damping advances toward the fresh target.
      // docs/camera.md § Auto camera.
      // Skipped under a playback: the camera came from the record at the top of the tic, and
      // advancing it here would leave the next tic interpolating out of a pose nothing saw.
      if (slot.source === 'live') {
        this.profiler.time('Camera', () => slot.autoCamera.tick(slot.player, slot.simCamera));
        slot.simCamera.tick(DOOM_TIC, slot.player.followPoint(), cursor);
      }
    }
    if (anyPlayerAlive(this.slots)) this.level.time += DOOM_TIC;
    this.net?.tickViewCamera();

    this.refillBodies();
    this.profiler.time('Fog of War', () => this.level.fogOfWar.tick(this.fogPoints));
    this.updateThings(DOOM_TIC);
    this.updateEffects(DOOM_TIC);

    this.endTicInputs();
    return false;
  }

  /** Every slot's body as the fog sweeps from them, refilled for this tic — a check sample's. */
  private bodies(): readonly Pos2[] {
    this.refillBodies();
    return this.fogPoints;
  }

  /** {@link Game.players} and {@link Game.fogPoints} for the rest of the tic, refilled in place. */
  private refillBodies(): void {
    const { slots, players, fogPoints } = this;
    players.length = slots.length;
    fogPoints.length = slots.length;
    for (let i = 0; i < slots.length; i++) {
      players[i] = livingPlayer(slots[i]);
      fogPoints[i] = slots[i].player;
    }
  }

  /**
   * Closes every slot's input for the tic — the edges cleared, the wheel spent, a recording's rows
   * written — and moves a playback's cursor, which serves every slot the next row.
   */
  private endTicInputs(): void {
    for (const slot of this.slots) slot.input.endTic();
    this.driver.endTic();
    this.net?.endTic();
  }

  /**
   * Everything a *living* player drives in a frame: powers, aim, movement, firing, pickups and the
   * sector underfoot.
   *
   * @returns the point the camera leads toward: always where the cursor meets the aim plane, never
   *          the locked-on monster
   */
  private updateLivingPlayer(slot: PlayerSlot, dt: number): Pos2 | null {
    const { player, input, inventory, simCamera: camera } = slot;
    // Ticked with the rest of the player's own update and not while dead,
    // matching vanilla: powers age in `P_PlayerThink`, which hands off to
    // `P_DeathThink` and returns before reaching them once health hits 0.
    tickPowers(inventory, dt);
    // The cursor hovering over a monster — or over a switch a shot triggers —
    // locks aim onto it, **on hover, not on click** (docs/combat.md § Auto-aim).
    // The camera leads on `cursor` and never sees either lock, which is
    // docs/camera.md § Aim lead's rule and the reason they are returned
    // separately at all.
    const { monster, shootLine, cursor } = this.profiler.time('Player', () => {
      const planeZ = aimPlaneZ(camera);
      // The one read of where the player aims, and the ray the picks below use is cast *toward*
      // that point rather than through the pointer — so a replay, which records the point, casts
      // the same ray. No point (pointer above the horizon) picks nothing.
      // docs/replays.md § The TicInput seam.
      const onPlane = input.aim(camera, planeZ);
      const ray = onPlane ? camera.rayToward(onPlane.x, onPlane.y, planeZ) : null;
      // That same point in three dimensions — where both picks' ground bound starts
      // (`World.groundReach`, docs/combat.md § Auto-aim).
      const aimAt = onPlane ? { x: onPlane.x, y: onPlane.y, z: planeZ } : null;
      const m = ray && aimAt ? this.pickAimTarget(ray, aimAt, slot) : null;
      // A monster in front of the switch wins: the pointer is over its body,
      // and a shot would be absorbed by it long before reaching the wall.
      const line =
        m || !ray || !aimAt
          ? null
          : this.level.specials.pickShootTarget(ray, aimAt, player.z + AIM_HEIGHT_OFFSET);
      const at = m ?? line ?? onPlane;
      // Whatever the world is pushing the player with this tic — a conveyor
      // underfoot — onto the same momentum channel a hit's knockback uses.
      // Applied before the move, as `T_Scroll` runs before `P_PlayerThink`.
      const carry = this.level.forces.carryForBody(player, PLAYER_RADIUS, slot.touch);
      if (carry) player.applyForce(carry.x, carry.y);
      // Wind, current and point pushers, which unlike a conveyor reach the
      // player alone (`Forces.pushForBody`). "On the ground" is vanilla's
      // `thing->z > thing->floorz` test, which `groundFloor` answers here — a
      // full `checkPosition`, so it is only asked for where a pusher exists.
      if (this.level.forces.pusherCount > 0) {
        const { world, forces } = this.level;
        const onGround = player.z <= world.groundFloor(player.x, player.y, PLAYER_RADIUS);
        const push = forces.pushForBody(player, PLAYER_RADIUS, onGround, slot.touch);
        if (push) player.applyForce(push.x, push.y);
      }
      // What the floor underfoot does to the player's own movement — ice, mud,
      // or (on every map with no 223 line) nothing at all.
      const ground = this.level.forces.frictionUnder(player, {
        radius: PLAYER_RADIUS,
        speed: vecLength(player.velX, player.velY),
        cache: slot.touch,
      });
      // Monsters are solid: the player walks around them, not through them.
      player.update(dt, input, at, camera.viewerAngleDeg + 180, this.solidBodiesAround(player, slot), ground);
      return { monster: m, shootLine: line, cursor: onPlane };
    });

    this.profiler.time('Weapons', () => this.fireWeapons(slot, monster, shootLine));
    this.profiler.time('Player', () => this.collectPickupsAndSectorEffects(slot, dt));

    // Hard landings, and the weapon bookkeeping that has to run after every
    // switch source (`fireWeapons`' `handleSwitching`, a pickup) has had its
    // say — both belong to a living player only.
    if (player.landingSpeed > HARD_LANDING_SPEED) this.audio.play('oof', player, playerOrigin(slot.index));
    slot.weapons.update(dt, input.mouseDown, inventory, this.audio, player);
    return cursor;
  }

  /**
   * Weapon switching and this tic's trigger pull, turning each shot {@link WeaponSystem.fire}
   * returns into a projectile or tracer. docs/combat.md § Auto-aim.
   *
   * @param monster    the body aim locked onto, if any — what lets a shot angle toward its height
   * @param shootLine  the shoot-triggered wall aim locked onto, if any, likewise
   */
  private fireWeapons(slot: PlayerSlot, monster: MonsterRef | null, shootLine: ShootAim | null): void {
    const { player, input, inventory } = slot;
    // Called after player.update so player.angle already reflects this frame's aim.
    slot.weapons.handleSwitching(input, inventory, input.consumeWheel());
    const shots = slot.weapons.fire(input.mouseDown, inventory, player.angle);
    // Every shot actually fired wakes monsters without sight, melee included —
    // docs/monster-ai.md § Waking up.
    if (shots.length > 0) {
      this.level.world.noiseAlert(player.x, player.y, slot.index);
      slot.actor.playOnce(PLAYER_ATTACK_FRAMES, PLAYER_ACTION_FRAME_SECONDS);
      // One shot sound per trigger pull, not per pellet (see
      // `WeaponDef.fireSound`), on the player's own origin — so a held
      // chaingun trigger keeps cutting itself off instead of stacking up.
      // A melee swing's own sound comes later, from `spawnPlayerShot`, which is
      // the only place that knows whether it connected.
      const fire = WEAPONS[inventory.currentWeapon].fireSound;
      if (fire) this.audio.play(fire, player, playerOrigin(slot.index));
    }
    for (const shot of shots) {
      // The fire height is `spawnPlayerShot`'s own to pick. The locked-on monster travels with the
      // shot as the body to aim at; see world.ts's shotPath/blocksShot for why a locked shot is
      // allowed to clear the floor steps a free one is stopped by.
      this.projectiles.spawnPlayerShot(shot, monster, shootLine, slot.index);
    }
  }

  /**
   * What the cursor's ray locks onto: the thing layer's pick, and — where a player can be shot
   * ({@link Game.pvp}) — the other living players' own body boxes, tested exactly as a monster's is
   * ({@link rayEntersBox} over {@link PLAYER_RADIUS}/{@link PLAYER_HEIGHT}, bounded by
   * {@link World.groundReach}); the nearer entry wins. Body boxes only, never art.
   * docs/combat.md § Auto-aim.
   */
  private pickAimTarget(ray: THREE.Ray, aimAt: Pos3, shooter: PlayerSlot): (MonsterRef & { dist: number }) | null {
    const { things, world } = this.level;
    if (!this.pvp) return things.pickMonster(ray, aimAt);
    const o = worldToDoom(ray.origin.x, ray.origin.y, ray.origin.z);
    const d = worldToDoom(ray.direction.x, ray.direction.y, ray.direction.z);
    // Traced once for both scans: `groundReach` walks the map's lines.
    const reach = world.groundReach(o, aimAt);
    let best = things.pickMonster(ray, aimAt, reach);
    let bestDist = best?.dist ?? reach;
    for (const other of this.slots) {
      if (other === shooter || other.dead) continue;
      const { player } = other;
      const dist = rayEntersBox(o.x, o.y, o.z, d.x, d.y, d.z, player.x, player.y, PLAYER_RADIUS, player.z, player.z + PLAYER_HEIGHT);
      if (dist === null || dist >= bestDist) continue;
      bestDist = dist;
      best = playerRef(other.index, player, player.x, player.y, dist);
    }
    return best;
  }

  /**
   * What picking one item up means, for whichever player mobj reached it — the slot's own body or
   * a voodoo doll collecting on its behalf (docs/items.md § Collecting things). Bound to the slot
   * once ({@link PlayerSlot.consumePickup}), since both `tryPickup` call sites hand it straight
   * over.
   */
  private consumePickup(slot: PlayerSlot, type: number, dropped: boolean, at: Pos3): boolean {
    const taken = applyPickup(slot.inventory, type, {
      dropped,
      skill: this.skill,
      autoSwitch: slot.settings.autoSwitchWeapon,
      weaponsStay: this.weaponsStay,
    });
    // What a netgame leaves lying for everyone else: taken, and still there. A deathmatch takes its
    // weapons and puts them back later (docs/multiplayer-deathmatch.md § Item respawn).
    // docs/multiplayer-coop.md § Items and kills.
    const left = taken && this.netgame && leftInNetgame(type, dropped, this.weaponsStay);
    // The computer area map is the one pickup whose whole effect lives outside the `Inventory`
    // struct: it reveals the level's own geometry. Watched for here rather than handled in
    // `applyPickup` — the same "state there, world effect at the caller" split `tryPickup`
    // already makes for removing the item itself.
    if (taken && type === ThingType.computerMap) {
      this.level.fogOfWar.revealAll();
    }
    // Whichever slot took it, not the viewed one's alone: the puff covers an item vanishing, which
    // every player sees. An item left lying puffs nothing. docs/items.md § The pickup puff.
    if (taken && !left) {
      this.effects.spawnPickupFog(at);
    }
    // Unattenuated, as vanilla plays every pickup: you're standing on it — and for the local
    // player alone, `P_TouchSpecialThing`'s own `player == &players[consoleplayer]` gate. A key
    // left lying is silent: `P_TouchSpecialThing` returns before its sound, where a weapon's
    // `wpnup` is `P_GiveWeapon`'s own.
    if (taken && slot === this.viewed) {
      const sound = pickupSound(type);
      if (!left || sound === 'wpnup') {
        this.audio.play(sound);
      }
      // After `applyPickup`, which the medikit's line reads the health left by.
      const line = pickupLine(type, slot.inventory);
      if (line !== null) this.messages.show(line);
    }
    return taken && !left;
  }

  /**
   * The two things a player picks up by standing somewhere: items in reach, and whatever the
   * sector underfoot does to them (damage floors, secrets, an exit) — see
   * game/specials/sectoreffects.ts.
   */
  private collectPickupsAndSectorEffects(slot: PlayerSlot, dt: number): void {
    const { player, inventory } = slot;
    this.level.things.tryPickup(player, player.attempted, PICKUP_RANGE, slot.consumePickup);
    const sectorEffect = this.level.sectorEffects.update(
      dt,
      this.level.world,
      player,
      inventory,
      (amount) => this.damageSlot(slot, amount, { cause: 'slime' }),
      slot.index,
    );
    // The count is the level's; the announcement is the local player's own screen.
    if (sectorEffect.secretFound && slot === this.viewed) {
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
   * A deathmatch level's own two exits, checked where `P_UpdateSpecials` checks them: the time
   * limit (`p_spec.c`'s `levelTimer`, over {@link Level.time}) and Boom's frag limit (`-frags`:
   * any player's net frags). docs/multiplayer-deathmatch.md § Limits.
   */
  private checkDeathmatchLimits(): void {
    if (!this.deathmatch || this.levelEnding) return;
    const timeLimit = getTimeLimit();
    const fragLimit = getFragLimit();
    const timeUp = timeLimit > 0 && Math.round(this.level.time / DOOM_TIC) >= timeLimit * TICS_PER_MINUTE;
    const fragsUp = fragLimit > 0 && this.slots.some((slot) => slot.netFrags() >= fragLimit);
    if (timeUp || fragsUp) {
      this.pendingExit = 'normal';
    }
  }

  /**
   * Files the completion that just happened and reports how it compares to the level's best, or
   * null if this level's run may claim none. The record is keyed to the WAD file that
   * *provides* the map rather than to the loaded set — see docs/hud.md § Best times.
   */
  private recordCompletion(): BestTimeResult | null {
    // A replay is watched, not run, and a netgame's run is several players' — neither claims one,
    // any more than a cheated run does. docs/replays.md § Playback.
    if (this.playback || this.cheated || this.netgame) return null;
    const map = this.currentMap;
    const source = mapProvider(this.wad, map);
    if (!source) return null;
    return recordBestTime(bestTimeKey(source.id, map, this.skill), this.level.time, {
      wad: source.name,
      map,
      skill: this.skill,
    });
  }

  /**
   * Ticks the thing layer and realizes what it hands back: the monster attacks fired this frame,
   * and any barrel whose `A_Explode` came due. A player goes in as `null` once dead, matching
   * `P_KillMobj` stripping the player's `MF_SHOOTABLE`/`MF_SOLID` — docs/death.md § Player death
   * for what that does and doesn't freeze in the AI.
   */
  private updateThings(dt: number): void {
    // Refilled by `refillBodies` ahead of the fog, earlier in the same tic.
    const { players } = this;
    // Every attack a monster fired this tic comes back for us to apply/render, the same "system
    // returns data, caller realizes it" split as `WeaponSystem.fire`.
    const thingUpdate = this.profiler.time(
      'Monsters',
      () =>
        this.level.things.update(
          dt,
          players,
          (subsector) => this.level.fogOfWar.isVisible(subsector),
          (prev, mover) => this.thingCrossedLines(prev, mover),
          (mover, tryX, tryY) => this.thingUsedLines(mover, tryX, tryY),
          this.level.forces.carriesAnything() ? this.carryForBody : undefined,
        ),
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
   * Draws nothing — {@link Presenter.drawEffects} is the other half.
   *
   * The order is load-bearing: projectiles advance before impacts, so an explosion or smoke puff
   * spawned by an arrival this tic is drawn on the very next frame rather than one late.
   */
  private updateEffects(dt: number): void {
    this.profiler.time('Effects', () => {
      this.effects.updateTeleportFogs(dt);
      this.effects.updatePickupFogs(dt);
      this.effects.updateTracers(dt);
      this.projectiles.update(dt);
      this.level.icon.update(dt);
      this.effects.updateImpacts(dt);
    });
  }

  /** One sky name as art, however the set ships it — {@link levelSkyArt}'s lookup. */
  private skyArt(name: string): Bitmap | null {
    return this.gfx.texture(name) ?? this.gfx.picture(name);
  }
}

function readStoredFpsCap(): FpsCap {
  const stored = readStorage(FPS_CAP_STORAGE_KEY, DEFAULT_FPS_CAP);
  return FPS_CAPS.find((c) => c === stored) ?? DEFAULT_FPS_CAP;
}
