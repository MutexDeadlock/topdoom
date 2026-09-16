/**
 * {@link PlayerSlot}: one player's whole share of a level — body, inventory, weapons, cheats, the
 * camera the simulation reads for them, the input that drives them, and the billboard and shadow
 * they are drawn as. `game.ts` holds one per player; which one is the local player is
 * {@link PlayerSlot.local}. docs/multiplayer.md § Player slots.
 */
import type { Player } from './player.ts';
import type { Inventory } from './inventory.ts';
import { WeaponSystem } from './weapons.ts';
import { Cheats } from './cheats.ts';
import type { TicInput } from './input.ts';
import type { AutoCamera } from './autocamera.ts';
import { makeTouchCache, type SectorTouchCache } from './world.ts';
import { deserializeInventory, serializeInventory, type PlayerSlotSnapshot } from './snapshot.ts';
import {
  CORPSE_GIB,
  PLAYER_DEATH_FRAME_SECONDS,
  PLAYER_DEATH_FRAME_TICS,
  PLAYER_DEATH_FRAMES,
  PLAYER_SPAWN_HEALTH,
  PLAYER_XDEATH_FRAMES,
} from './things/tables.ts';
import type { TopDownCamera } from '../render/camera.ts';
import type { SpriteActor } from '../render/sprites.ts';
import { PlayerShadow } from '../render/playershadow.ts';
import { playerOrigin, type SfxId } from '../audio/sfx.ts';
import type { GameMode } from '../wad/campaign/gamemode.ts';
import type { PlayerSettings } from './replay/defs.ts';
import { getPlayerColor, slotColor, type PlayerColor } from '../wad/playercolor.ts';
import type { Pos3 } from '../types.ts';
import { asDamageCause, type DamageCause } from './combat.ts';
import { MAX_PLAYERS } from './playerstarts.ts';
import { fragSum, secondsUntil } from './rules.ts';
import { TICRATE } from '../constants.ts';

/**
 * What drives a slot's input: the live `Input`, a replay's record, a network game's row, or
 * nothing at all (`IDLE_TIC_INPUT`). docs/multiplayer.md § Player slots.
 */
export type SlotSource = 'live' | 'replay' | 'row' | 'idle';

/** Taking one item, for whichever player mobj reached it — `ThingLayer.tryPickup`'s consumer. */
export type PickupConsumer = (type: number, dropped: boolean, at: Pos3) => boolean;

export interface PlayerSlotOptions {
  index: number;
  /** Whether this is the slot the browser plays. */
  local: boolean;
  /**
   * Built after the DEHACKED patch, never before — docs/dehacked.md § Applying: reset, then patch.
   */
  inventory: Inventory;
  simCamera: TopDownCamera;
  input: TicInput;
  settings: PlayerSettings;
  actor: SpriteActor;
  consumePickup: PickupConsumer;
}

/**
 * How many seconds the death overlay counts down over a deathmatch corpse before it stands back up
 * without a press — tuned by feel. docs/multiplayer-deathmatch.md § Forced respawn.
 */
export const RESPAWN_COUNTDOWN_SECONDS = 6;

/**
 * Tics a deathmatch corpse lies before it is reborn on its own: the plain death chain the overlay
 * waits out before it rises, then {@link RESPAWN_COUNTDOWN_SECONDS} of countdown on it. No vanilla
 * counterpart — `P_DeathThink` (`p_user.c`) waits for `BT_USE` however long that takes.
 */
export const FORCED_RESPAWN_TICS =
  PLAYER_DEATH_FRAMES.length * PLAYER_DEATH_FRAME_TICS + RESPAWN_COUNTDOWN_SECONDS * TICRATE;

/**
 * The whole seconds left before a deathmatch corpse is reborn on its own, rounded up — what the
 * death overlay's countdown line reads.
 *
 * @param deadTics  the corpse's {@link PlayerSlot.deadTics}
 */
export function respawnCountdown(deadTics: number): number {
  return secondsUntil(deadTics, FORCED_RESPAWN_TICS);
}

/** How a player's death plays out — {@link playerDeath}'s answer. */
export interface PlayerDeath {
  /** The gib chain, {@link PLAYER_XDEATH_FRAMES} — `P_KillMobj`'s `xdeathstate`. */
  gibbed: boolean;
  /** The cry: `A_XScream`'s `slop` for a gib, else `A_PlayerScream`'s `pdiehi` or `pldeth`. */
  sound: SfxId;
}

/**
 * How a player dies of a killing hit: below `-spawnhealth` the body gibs (`P_KillMobj`,
 * `p_inter.c`); otherwise `A_PlayerScream` (`p_enemy.c`) cries `pdiehi` below −50, in a commercial
 * game only. docs/death.md § Player death.
 *
 * @param health    the body's health after the hit, unclamped — vanilla's `target->health`, which
 *                  goes below 0 where the HUD's `player->health` stops at it
 * @param gameMode  the loaded set's, which gates `pdiehi`
 * @returns the chain the corpse plays and the sound it makes
 */
export function playerDeath(health: number, gameMode: GameMode): PlayerDeath {
  if (health < -PLAYER_SPAWN_HEALTH) return { gibbed: true, sound: 'slop' };
  return { gibbed: false, sound: gameMode === 'commercial' && health < -50 ? 'pdiehi' : 'pldeth' };
}

export class PlayerSlot {
  readonly index: number;
  /**
   * The slot this browser plays: its keyboard, the menu's settings and colour. What is drawn is
   * `Game.viewed`'s. docs/multiplayer.md § Player slots.
   */
  readonly local: boolean;
  /** The body, rebuilt by every level load. */
  player!: Player;
  inventory: Inventory;
  /** The slot's weapons, sounding on its own {@link playerOrigin}. */
  readonly weapons: WeaponSystem;
  /**
   * True once this player's health has hit 0 — freezes their movement, aim, firing and pickups
   * until the level is reloaded. docs/death.md § Player death.
   */
  dead = false;
  /**
   * What killed this player, while {@link PlayerSlot.dead}: the killing hit's cause, kept for every
   * slot so the death overlay can go up over the corpse later — a replay's view switched onto it, a
   * snapshot restored with it. Undefined for an unattributed death. docs/death.md § Who killed the
   * player.
   */
  deathCause: DamageCause | undefined = undefined;
  /**
   * Whether this player's corpse plays the gib chain rather than the plain one, while
   * {@link PlayerSlot.dead}: what {@link PlayerSlot.deathFrames} picks, and what a snapshot lays
   * down again. docs/death.md § Player death.
   */
  gibbed = false;
  /**
   * Whether a mover has since crunched this player's corpse to a pool of blood, while
   * {@link PlayerSlot.dead} — {@link PlayerSlot.squash}. No tic reads it.
   * docs/specials-crushers.md § Crushed corpses.
   */
  crushed = false;
  /**
   * Tics this player has lain dead, counted in a netgame from the tic after the killing one: what
   * a deathmatch's forced respawn waits out. docs/multiplayer-deathmatch.md § Forced respawn.
   */
  deadTics = 0;
  /**
   * The kills this player made this level — vanilla's `player_t.killcount`, which `P_SetupLevel`
   * zeroes and `Game.buildLevel` does too. Counted in a netgame only; what the scoreboard shows.
   * docs/multiplayer-coop.md § Items and kills.
   */
  kills = 0;
  /**
   * Whom this player killed this level, by the victim's slot — `player_t.frags[MAXPLAYERS]`, which
   * `G_DoLoadLevel` zeroes and `G_PlayerReborn` keeps. Counted in a deathmatch only; the board
   * shows {@link PlayerSlot.netFrags}. docs/multiplayer-deathmatch.md § Frags.
   */
  readonly frags: number[] = new Array(MAX_PLAYERS).fill(0);
  /**
   * The body's cached touched-sector list for the three per-tic force queries — one body, one
   * cache (`World.sectorsTouchingCached`), so carry/push/friction share one sector walk per tic
   * instead of three. Reset per level: the positions it was keyed on are the old map's.
   */
  touch: SectorTouchCache = makeTouchCache();
  /**
   * The camera the **simulation** reads for this player — the viewport's own, and under a
   * playback a private one that evolves from the record alone, so that looking around cannot
   * change what the run does. docs/camera.md § The camera is simulation state.
   */
  simCamera: TopDownCamera;
  /** Rebuilt per level, like the body. */
  autoCamera!: AutoCamera;
  /**
   * The typed cheat codes and the two toggles they leave on — vanilla's `player_t.cheats`, owned
   * by the session rather than the level: an exit carries them into the next map. docs/cheats.md.
   */
  readonly cheats = new Cheats();
  /** What this slot's tic reads its input through — see {@link PlayerSlot.source}. */
  input: TicInput;
  source: SlotSource = 'live';
  /**
   * The settings this player runs under: `GLOBAL_PLAYER_SETTINGS` for the local slot, a record of
   * its own for any other. Pushed onto the body and the weapons every tic, like
   * {@link Cheats.noclip}. docs/multiplayer.md § Player settings.
   */
  settings: PlayerSettings;
  /**
   * The armour colour this player picked, where it came with the slot — a network game's
   * assignment, a replay's record — or null for {@link PlayerSlot.drawColor}'s default.
   * docs/sprites.md § Player colours.
   */
  color: PlayerColor | null = null;
  /** The billboard this player is drawn as, and the disc under its feet. Session-scoped. */
  readonly actor: SpriteActor;
  readonly shadow = new PlayerShadow();
  /** What this player collecting an item means — bound to the slot once, handed to `tryPickup`. */
  readonly consumePickup: PickupConsumer;

  constructor(options: PlayerSlotOptions) {
    this.index = options.index;
    this.local = options.local;
    this.weapons = new WeaponSystem(playerOrigin(options.index));
    this.inventory = options.inventory;
    this.simCamera = options.simCamera;
    this.input = options.input;
    this.settings = options.settings;
    this.actor = options.actor;
    this.consumePickup = options.consumePickup;
  }

  /**
   * Alive again with the inventory it holds now: the weapons reset onto it, the billboard back on
   * its feet — a level load's, and a coop respawn's (docs/multiplayer-coop.md § Respawn).
   */
  standUp(): void {
    this.weapons.beginLevel(this.inventory);
    this.dead = false;
    this.deathCause = undefined;
    this.gibbed = false;
    this.crushed = false;
    this.deadTics = 0;
    this.actor.revive();
  }

  /**
   * Down for this life: the killing hit's, and a snapshot's corpse laid down again. The billboard
   * plays `PLAY`'s plain death chain, or its xdeath one where `gibbed`.
   *
   * @param cause   what killed the player, undefined where nothing is blamed
   * @param gibbed  {@link playerDeath}'s verdict on the killing hit
   */
  die(cause: DamageCause | undefined, gibbed: boolean): void {
    this.dead = true;
    this.deathCause = cause;
    this.gibbed = gibbed;
    this.deadTics = 0;
    this.pose();
  }

  /**
   * The corpse crunched to a pool of blood by a mover that left it no room — `PIT_ChangeSector`'s
   * `S_GIBS` — and a snapshot's pool laid down again. docs/specials-crushers.md § Crushed corpses.
   */
  squash(): void {
    if (!this.dead || this.crushed) return;
    this.crushed = true;
    this.pose();
  }

  /**
   * The chain the corpse plays, each frame {@link PLAYER_DEATH_FRAME_SECONDS} long: the pool where
   * {@link PlayerSlot.crushed}, else `PLAY`'s xdeath where {@link PlayerSlot.gibbed} and its plain
   * death otherwise — what the death overlay waits out. docs/death.md § Player death.
   */
  get deathFrames(): string[] {
    if (this.crushed) return CORPSE_GIB.frames;
    return this.gibbed ? PLAYER_XDEATH_FRAMES : PLAYER_DEATH_FRAMES;
  }

  /** This player's score: everyone else they killed, minus themselves — `WI_fragSum`. */
  netFrags(): number {
    return fragSum(this.frags, this.index);
  }

  /** How solid this player draws — the billboard and the disc under it fade together. */
  setOpacity(opacity: number): void {
    this.actor.setOpacity(opacity);
    this.shadow.setOpacityScale(opacity);
  }

  /**
   * The colour this player's armour draws in: the one that came with the slot; the menu's for the
   * local player otherwise; its player number's vanilla colour for anyone else.
   * docs/sprites.md § Player colours.
   */
  drawColor(): PlayerColor {
    return this.color ?? (this.local ? getPlayerColor() : slotColor(this.index));
  }

  /**
   * `apply` on every camera of this slot: its own, and the drawn one where a playback or a network
   * game has separated the two. For the discontinuities both must take — a level load, a teleport,
   * a keyframe restore — since neither may be left gliding in from where it was.
   *
   * @param viewCamera  the drawn camera where this slot is the one drawn, null for any other
   */
  eachCamera(viewCamera: TopDownCamera | null, apply: (camera: TopDownCamera) => void): void {
    apply(this.simCamera);
    if (viewCamera && viewCamera !== this.simCamera) {
      apply(viewCamera);
    }
  }

  /**
   * Hands the simulation back to `viewCamera`, at the pose it is being drawn at, with the auto
   * camera seeded there rather than left to glide in from wherever it last stood — a replay taken
   * over, a network game left. docs/camera.md § The camera is simulation state.
   */
  attachSimCamera(viewCamera: TopDownCamera): void {
    this.simCamera = viewCamera;
    this.autoCamera.seed(this.player, viewCamera);
  }

  /** The slot as a save holds it. */
  snapshot(): PlayerSlotSnapshot {
    return {
      player: this.player.snapshot(),
      inventory: serializeInventory(this.inventory),
      weapons: this.weapons.snapshot(),
      // Where the orbit is heading, not the angle a Q/E step happens to be passing through: only
      // whole steps move it afterwards, so a mid-glide yaw would strand the restored camera
      // between two lattice angles for good. docs/camera.md § Camera orbit.
      cameraYawDeg: this.simCamera.targetYawDeg,
      dead: this.dead,
      // Only while one is actually on: an honest slot's save carries nothing.
      // docs/cheats.md § Saves and best times.
      ...(this.cheats.used ? { cheats: this.cheats.snapshot() } : {}),
      ...(this.kills > 0 ? { kills: this.kills } : {}),
      ...(this.frags.some((n) => n !== 0) ? { frags: [...this.frags] } : {}),
      ...(this.deathCause !== undefined ? { deathCause: this.deathCause } : {}),
      ...(this.gibbed ? { gibbed: true } : {}),
      ...(this.crushed ? { crushed: true } : {}),
      ...(this.dead && this.deadTics > 0 ? { deadTics: this.deadTics } : {}),
    };
  }

  /**
   * The slot back from its snapshot, at `Game.buildLevel`'s step for it: the cheats, the kills,
   * the inventory, the weapons that read that inventory, and a corpse laid down again with its
   * clock. The body and the camera yaw are the load's own steps, earlier — docs/savegames.md
   * § Apply order.
   */
  restore(saved: PlayerSlotSnapshot): void {
    this.cheats.restore(saved.cheats);
    this.kills = saved.kills ?? 0;
    this.frags.fill(0);
    saved.frags?.forEach((n, slot) => {
      if (slot < MAX_PLAYERS) this.frags[slot] = n;
    });
    this.inventory = deserializeInventory(saved.inventory);
    // After the line above: `restore` derives `weaponLastFrame` off the
    // inventory it is handed, and `beginLevel` only saw the outgoing one.
    this.weapons.restore(saved.weapons, this.inventory);
    if (saved.dead) this.die(asDamageCause(saved.deathCause), saved.gibbed === true);
    if (saved.crushed) this.squash();
    this.deadTics = saved.deadTics ?? 0;
  }

  /**
   * The billboard laid down in {@link PlayerSlot.deathFrames}, from the pool's own sprite once
   * {@link PlayerSlot.crushed} — frames and sprite picked together, as `enterDeathPose` does.
   */
  private pose(): void {
    this.actor.die(this.deathFrames, PLAYER_DEATH_FRAME_SECONDS, this.crushed ? CORPSE_GIB.sprite : undefined);
  }
}
