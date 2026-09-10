/**
 * `PlayerSlot`: one player's whole share of a level — body, inventory, weapons, cheats, the camera
 * the simulation reads for them, the input that drives them, and the billboard and shadow they are
 * drawn as. `game.ts` holds one per player, and slot 0 is the local player until the network
 * arrives. docs/multiplayer.md § Player slots.
 */
import type { Player } from './player.ts';
import type { Inventory } from './inventory.ts';
import { WeaponSystem } from './weapons.ts';
import { Cheats } from './cheats.ts';
import type { TicInput } from './input.ts';
import type { AutoCamera } from './autocamera.ts';
import { makeTouchCache, type SectorTouchCache } from './world.ts';
import type { TopDownCamera } from '../render/camera.ts';
import type { SpriteActor } from '../render/sprites.ts';
import { PlayerShadow } from '../render/playershadow.ts';
import { playerOrigin } from '../audio/sfx.ts';
import type { PlayerSettings } from './replay/defs.ts';
import type { Pos3 } from '../types.ts';

/**
 * What drives a slot's input: the live `Input`, a replay's record, a network row, or nothing at
 * all. Only the first two exist today; the others are named so the rest of the engine can
 * already ask. docs/multiplayer.md § Player slots.
 */
export type SlotSource = 'live' | 'replay' | 'row' | 'idle';

/** Taking one item, for whichever player mobj reached it — `ThingLayer.tryPickup`'s consumer. */
export type PickupConsumer = (type: number, dropped: boolean, at: Pos3) => boolean;

export interface PlayerSlotOptions {
  index: number;
  /** Built after the DEHACKED patch, never before — docs/dehacked.md § Applying: reset, then patch. */
  inventory: Inventory;
  simCamera: TopDownCamera;
  input: TicInput;
  settings: PlayerSettings;
  actor: SpriteActor;
  consumePickup: PickupConsumer;
}

export class PlayerSlot {
  readonly index: number;
  /** The body, rebuilt by every level load. */
  player!: Player;
  inventory: Inventory;
  /** The slot's weapons, sounding on its own `playerOrigin`. */
  readonly weapons: WeaponSystem;
  /**
   * True once this player's health has hit 0 — freezes their movement, aim, firing and pickups
   * until the level is reloaded. docs/death.md § Player death.
   */
  dead = false;
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
  /** What this slot's tic reads its input through — see `source`. */
  input: TicInput;
  source: SlotSource = 'live';
  /**
   * The settings this player runs under: `GLOBAL_PLAYER_SETTINGS` for the local slot, a record of
   * its own for any other. Pushed onto the body and the weapons every tic, like `cheats.noclip`.
   * docs/multiplayer.md § Player settings.
   */
  settings: PlayerSettings;
  /** The billboard this player is drawn as, and the disc under its feet. Session-scoped. */
  readonly actor: SpriteActor;
  readonly shadow = new PlayerShadow();
  /** What this player collecting an item means — bound to the slot once, handed to `tryPickup`. */
  readonly consumePickup: PickupConsumer;

  constructor(options: PlayerSlotOptions) {
    this.index = options.index;
    this.weapons = new WeaponSystem(playerOrigin(options.index));
    this.inventory = options.inventory;
    this.simCamera = options.simCamera;
    this.input = options.input;
    this.settings = options.settings;
    this.actor = options.actor;
    this.consumePickup = options.consumePickup;
  }

  /** How solid this player draws — the billboard and the disc under it fade together. */
  setOpacity(opacity: number): void {
    this.actor.setOpacity(opacity);
    this.shadow.setOpacityScale(opacity);
  }
}
