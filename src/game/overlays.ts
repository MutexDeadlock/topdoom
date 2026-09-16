/**
 * {@link Overlays}: the 2D layers over the level — the status bar, the crosshair, the playback
 * bar, the center message and the feed, the level card, the two end-of-level popups, the death
 * overlay, the scoreboard and the screen effects. Built here, raised by `Game`'s tic through the
 * methods below, updated every frame by `Presenter`. Whose screen a line lands on — the viewed
 * player's — is decided here, not by the tic. docs/hud.md, docs/frameloop.md § What runs in a
 * frame.
 */
import type * as THREE from 'three';
import type { PlayerSlot } from './playerslot.ts';
import type { Level } from './level.ts';
import type { ReplayPlayback } from './replay.ts';
import type { LockedLine } from './specials.ts';
import type { NetNotice, RosterEntry } from './net.ts';
import type { BestTimeResult } from './besttimes.ts';
import { pickupLine } from './inventory.ts';
import { obituary } from './things/tables.ts';
import type { GraphicsBank } from '../wad/graphics.ts';
import type { GameMode } from '../wad/campaign/gamemode.ts';
import type { LevelNames } from '../wad/campaign/names.ts';
import type { PlayerColor } from '../wad/playercolor.ts';
import type { ColorTint } from '../wad/colormaps.ts';
import type { AudioEngine } from '../audio/audio.ts';
import type { SfxId } from '../audio/sfx.ts';
import { Hud } from '../ui/hud/hud.ts';
import { Crosshair } from '../ui/hud/crosshair.ts';
import { ReplayBar, type ReplayBarHooks } from '../ui/hud/replaybar.ts';
import {
  CenterMessage,
  killsLeftMessage,
  lockedLineMessage,
  missingArtMessage,
  SECRET_MESSAGE,
  timeLeftMessage,
} from '../ui/hud/message.ts';
import { deathLine, HudMessages, presenceLine } from '../ui/hud/messages.ts';
import { LevelCard } from '../ui/hud/levelcard.ts';
import { Intermission, type ContinueHint } from '../ui/hud/intermission.ts';
import { EndCard, type EndScope } from '../ui/hud/endcard.ts';
import { DeathOverlay, type DeathHint } from '../ui/hud/deathoverlay.ts';
import { nameColors, rankByKills, Scoreboard, type ScoreRow } from '../ui/hud/scoreboard.ts';
import { ScreenEffects } from '../ui/hud/screeneffects.ts';
import type { TextRun, WadFontRecolor } from '../ui/hud/wadfont.ts';
import type { Pos2 } from '../types.ts';

/**
 * Which end-of-level popup is up: the level is finished and frozen behind either.
 * docs/hud.md § Intermission, § End card.
 */
export type EndPopup = 'intermission' | 'endcard';

/** What the overlays read of the game they sit over — `Game` hands it over as one object. */
export interface OverlayHost {
  /** Every player slot; the list is never replaced, only grown. */
  readonly slots: readonly PlayerSlot[];
  /** The slot the screen is drawn for. docs/multiplayer.md § Player slots. */
  readonly viewed: PlayerSlot;
  readonly level: Level;
  readonly playback: ReplayPlayback | null;
  readonly recording: boolean;
  readonly netgame: boolean;
  readonly deathmatch: boolean;
  /** The WAD set's label — the end card's second line. */
  readonly title: string;
  readonly audio: AudioEngine;
  readonly gameMode: GameMode;
  readonly levelNames: LevelNames;
  /** Whether the level is on its way out. docs/death.md § Dying on the way out. */
  readonly levelEnding: boolean;
  readonly popup: EndPopup | null;
  /**
   * The network session's roster, for the board's names and pings.
   *
   * @returns null outside a network game
   */
  roster(): readonly RosterEntry[] | null;
  /** Whether the viewer holds the board up this frame. docs/hud.md § Scoreboard. */
  holdsBoard(): boolean;
  /** The line under the popups. docs/hud.md § Intermission. */
  continueHint(): ContinueHint;
  /** The line the death overlay offers. docs/death.md § Player death. */
  deathHint(): DeathHint;
  /**
   * The seconds the death overlay counts down over the viewed corpse.
   * docs/multiplayer-deathmatch.md § Forced respawn.
   *
   * @returns null where no respawn is forced
   */
  respawnCountdown(): number | null;
  /**
   * What the HUD clock reads in place of the time spent. docs/multiplayer-deathmatch.md § Limits.
   *
   * @returns null where no time limit counts down
   */
  timeLeft(): number | null;
}

/** What building the overlays takes beside the host. */
export interface OverlayOptions {
  /** The set's own graphics: every font and icon. */
  gfx: GraphicsBank;
  /** The viewport's renderer: the crosshair's canvas, the screen effects' clear colour. */
  renderer: THREE.WebGLRenderer;
  /** What the playback bar asks of the replay driver. */
  bar: ReplayBarHooks;
}

export class Overlays {
  private readonly host: OverlayHost;
  private readonly hud: Hud;
  private readonly crosshair: Crosshair;
  /** The playback bar; hidden outside a replay. docs/replays.md § Playback. */
  private readonly replayBar: ReplayBar;
  /** Center-screen text — docs/hud.md § Center messages. */
  private readonly message: CenterMessage;
  /** The feed over the bar: pickups, joins, deaths — docs/hud.md § HUD messages. */
  private readonly messages: HudMessages;
  /** The "Entering / <level name>" card every map load raises — ui/hud/levelcard.ts. */
  private readonly levelCard: LevelCard;
  private readonly intermission: Intermission;
  private readonly endCard: EndCard;
  private readonly deathOverlay: DeathOverlay;
  /** The board Tab holds up — docs/hud.md § Scoreboard. */
  private readonly scoreboard: Scoreboard;
  /** The local player's own eyes: the tints are theirs. */
  private readonly screenEffects: ScreenEffects;
  /** Each armour colour's name colour on a message ({@link Overlays.slotName}), the board's own. */
  private readonly nameColors: Record<PlayerColor, WadFontRecolor>;

  constructor(host: OverlayHost, options: OverlayOptions) {
    const { gfx, renderer, bar } = options;
    this.host = host;
    this.hud = new Hud(gfx);
    this.crosshair = new Crosshair(renderer.domElement);
    this.replayBar = new ReplayBar(bar);
    this.message = new CenterMessage(gfx);
    this.messages = new HudMessages(gfx, host.netgame);
    this.levelCard = new LevelCard(gfx);
    this.intermission = new Intermission(gfx);
    this.endCard = new EndCard(gfx);
    this.deathOverlay = new DeathOverlay(gfx);
    this.scoreboard = new Scoreboard(gfx.palette);
    this.screenEffects = new ScreenEffects(renderer);
    this.nameColors = nameColors(gfx.palette);
  }

  /**
   * Every layer's frame. docs/frameloop.md § What runs in a frame.
   *
   * @param replayAim  where the recording's aim point falls on screen, in NDC, or null for no
   *                   reticle
   * @param tint       the colour cast the whole view draws under, or null for none
   */
  update(dt: number, replayAim: Pos2 | null, tint: ColorTint | null): void {
    const { host } = this;
    const { inventory } = host.viewed;
    this.hud.update(inventory, host.level.stats(), host.recording, host.timeLeft());
    this.crosshair.update(inventory.health);
    this.replayBar.update(host.playback, replayAim, inventory.health);
    this.tickClocks(dt);
    this.deathOverlay.setCountdown(host.respawnCountdown());
    // After the clocks, which may have raised the overlay this very frame.
    this.message.setCovered(this.deathOverlay.up);
    this.screenEffects.update(dt, inventory);
    this.screenEffects.setColormapTint(tint);
    this.scoreboard.update(host.holdsBoard() ? this.scoreRows() : null);
    this.intermission.showScores(host.popup === 'intermission' ? this.intermissionScoreRows() : null);
  }

  /**
   * The timed overlays' clocks: the center message, the feed, the level card and the death
   * overlay. Every frame's, and a seek's catch-up tics', which draw no frame.
   * docs/replays.md § Seeking.
   */
  tickClocks(dt: number): void {
    this.message.update(dt);
    this.messages.update(dt);
    this.levelCard.update(dt);
    this.deathOverlay.update(dt);
  }

  /** The playback bar alone, with no reticle — what a seek draws on the frames it owns. */
  drawBar(): void {
    this.replayBar.update(this.host.playback, null, this.host.viewed.inventory.health);
  }

  /**
   * Takes every per-level layer down ahead of a map load: all of them are static markup that
   * outlives the level that raised them. docs/hud.md § The HUD.
   */
  beginLevel(): void {
    this.clear();
    this.screenEffects.clearPain();
  }

  /** The "Entering" card for `map` — raised by every arrival at a level. */
  showLevelCard(map: string): void {
    const { levelNames } = this.host;
    this.levelCard.show(levelNames.nameFor(map), levelNames.graphicFor(map));
  }

  /**
   * Said on screen, not only in the console: a thing skipped for want of its sprite is simply
   * absent from the level, and nothing else explains why. Sits clear of the level card's own band
   * (docs/hud.md § Center messages).
   */
  reportMissingArt(types: number): void {
    this.message.show(missingArtMessage(types));
  }

  /**
   * The end-of-level popup over the frozen level: a deathmatch's result is the board alone
   * (docs/multiplayer-deathmatch.md § Scoreboard and the overlay), any other level's its stats.
   * A center message goes with the level it was raised on, not over its result.
   * docs/hud.md § Intermission.
   *
   * @param record      how the completion compares to the level's best, or null where it may
   *                    claim none
   * @param parSeconds  the level's par time, or null where nothing knows one
   */
  showIntermission(record: BestTimeResult | null, parSeconds: number | null, cheated: boolean): void {
    const { host } = this;
    this.message.clear();
    this.intermission.setContinueHint(host.continueHint());
    if (host.deathmatch) {
      this.intermission.showDeathmatch();
    } else {
      this.intermission.show(host.level.stats(), record, parSeconds, cheated);
    }
  }

  /**
   * Swaps the intermission for the campaign-over card. docs/hud.md § End card.
   *
   * @param map        the level just finished, whose episode the card names
   * @param continues  whether a level follows the card
   */
  showEndCard(scope: EndScope, map: string, continues: boolean): void {
    const { host } = this;
    this.intermission.clear();
    this.endCard.show({
      scope,
      episodeGraphic: host.levelNames.episodeGraphicFor(map),
      subtitle: host.title,
      continues,
      hint: host.continueHint(),
    });
  }

  /** The damage flash, on the viewed player's own screen alone. docs/hud.md § Screen effects. */
  hurt(slot: PlayerSlot, amount: number): void {
    if (slot === this.host.viewed) this.screenEffects.addPain(amount);
  }

  /**
   * A death on everyone's feed, in a game with someone else to read it.
   * docs/hud.md § HUD messages.
   *
   * @param killer  the slot credited, or null where no other player was
   */
  deathLine(victim: PlayerSlot, killer: PlayerSlot | null): void {
    if (!this.host.netgame) return;
    this.messages.show(...deathLine(this.slotName(victim), killer ? this.slotName(killer) : null));
  }

  /**
   * Arms the death overlay over the viewed corpse, naming what killed them
   * ({@link PlayerSlot.deathCause}) — nothing while that player lives, once the level is on its way
   * out, or over an end-of-level popup, which outlives that window (docs/death.md § Dying on the
   * way out).
   */
  armDeathOverlay(): void {
    const { viewed, levelEnding, popup } = this.host;
    if (!viewed.dead || levelEnding || popup !== null) return;
    const killer = obituary(viewed.deathCause, (slot) => this.playerName(slot));
    this.deathOverlay.show(killer, this.host.deathHint(), viewed.deathFrames);
  }

  /**
   * Takes the death overlay down when the level starts ending under a corpse — the intermission is
   * what the player should be looking at. Idempotent and self-guarded, so every place the level can
   * start ending calls it unconditionally. docs/death.md § Dying on the way out.
   */
  endingOverCorpse(): void {
    if (!this.host.viewed.dead || !this.host.levelEnding) return;
    this.deathOverlay.clear();
    this.screenEffects.clearPain();
  }

  /** A body stood back up: the viewed player's overlay and flash go with the corpse. */
  respawned(slot: PlayerSlot): void {
    if (slot !== this.host.viewed) return;
    this.deathOverlay.clear();
    this.screenEffects.clearPain();
  }

  /**
   * The secret's announcement, on the finder's own screen — unattenuated, like a pickup: it's an
   * announcement to the player, not a sound in the world. docs/hud.md § Center messages.
   */
  secretFound(slot: PlayerSlot): void {
    if (slot !== this.host.viewed) return;
    this.message.show(SECRET_MESSAGE);
    this.host.audio.playCue('secret');
  }

  /**
   * The pickup's line on the feed, the taker's own screen alone. After `applyPickup`, which the
   * medikit's line reads the health left by. docs/hud.md § HUD messages.
   */
  pickedUp(slot: PlayerSlot, type: number): void {
    if (slot !== this.host.viewed) return;
    const line = pickupLine(type, slot.inventory);
    if (line !== null) this.messages.show(line);
  }

  /**
   * Which key a refused line wants, on the user's own screen; the `oof` is the specials layer's.
   * docs/items.md § Locked doors and use triggers.
   */
  lockedLine(slot: PlayerSlot, locked: LockedLine): void {
    if (slot === this.host.viewed) this.message.show(...lockedLineMessage(locked.lock, locked.kind));
  }

  /** The one response a completed cheat prints, on the typist's own screen. docs/cheats.md. */
  cheatResponse(slot: PlayerSlot, response: string): void {
    if (slot === this.host.viewed) this.message.show(response);
  }

  /**
   * A kill that brought `slot` within reach of the kill limit — the viewer's own in the second
   * person. docs/multiplayer-deathmatch.md § Limits.
   */
  announceKillsLeft(slot: PlayerSlot, kills: number): void {
    const who = slot === this.host.viewed ? null : this.slotName(slot);
    this.announce(...killsLeftMessage(who, kills));
  }

  /** The time limit's countdown line. docs/multiplayer-deathmatch.md § Limits. */
  announceTimeLeft(seconds: number): void {
    this.announce(timeLeftMessage(seconds));
  }

  /** Center-screen text on the viewed player's screen, whoever it is about. */
  say(text: string): void {
    this.message.show(text);
  }

  /** A line for the feed that names no player: a save stored, a recording ended. */
  note(text: string): void {
    this.messages.show(text);
  }

  /**
   * Who joined, who left — heard only with the line: a mode that hides the feed silences it too.
   * docs/hud.md § HUD messages.
   */
  notice(notice: NetNotice): void {
    const player = { text: notice.name, color: this.nameColors[notice.color] };
    if (this.messages.show(...presenceLine(player, notice.event))) this.host.audio.playCue(this.messageCue);
  }

  /**
   * The view brought onto another player: the damage flash and the messages raised for the player
   * before are dropped, and the death overlay is the new player's — up over a corpse, killer and
   * all. docs/replays.md § Playback.
   */
  viewSwitched(): void {
    this.screenEffects.clearPain();
    this.message.clear();
    this.messages.clear();
    this.deathOverlay.clear();
    this.armDeathOverlay();
  }

  /** A playback begins: the reticle is drawn where the recording aimed, not on the pointer. */
  playbackStarted(): void {
    this.crosshair.detach(true);
  }

  /**
   * A playback taken over: the pointer has its reticle back, and the popup or overlay on screen,
   * drawn without the viewer's hint, gets it. docs/replays.md § Playback.
   */
  takenOver(): void {
    this.crosshair.detach(false);
    this.deathOverlay.setHint(this.host.deathHint());
    this.intermission.setContinueHint(this.host.continueHint());
    this.endCard.setContinueHint(this.host.continueHint());
  }

  /**
   * The menu up over the level, or closed again: the bar's `Space` is the viewer's only while the
   * menu is not reading keys, and the board goes down as the menu opens over it — no frame runs
   * to take it down under a pause.
   */
  setMenuUp(up: boolean): void {
    this.replayBar.setKeysActive(!up);
    if (up) this.scoreboard.clear();
  }

  /** The damage flash off — a seek's landing, which is no hit. */
  clearPain(): void {
    this.screenEffects.clearPain();
  }

  /** Everything down and let go of, ahead of the `Game` that drove these elements going away. */
  dispose(): void {
    this.crosshair.detach(false);
    this.replayBar.dispose();
    this.screenEffects.reset();
    this.clear();
  }

  /** Every per-level layer down. */
  private clear(): void {
    this.deathOverlay.clear();
    this.message.clear();
    this.messages.clear();
    this.levelCard.clear();
    this.intermission.clear();
    this.endCard.clear();
    this.scoreboard.clear();
  }

  /** A center message with its tick ({@link Overlays.messageCue}): how a deathmatch's limits speak. */
  private announce(...runs: TextRun[]): void {
    this.message.show(...runs);
    this.host.audio.playCue(this.messageCue);
  }

  /**
   * The cue a message announces itself with — vanilla's chat message's: `hu_stuff.c` plays
   * `sfx_radio` in a commercial game and `sfx_tink` otherwise. docs/audio.md § Cues.
   */
  private get messageCue(): SfxId {
    return this.host.gameMode === 'commercial' ? 'radio' : 'tink';
  }

  /** A slot's name as the board shows it: the roster's, else its player number. */
  private playerName(index: number): string {
    return this.host.roster()?.find((entry) => entry.slot === index)?.name ?? `Player ${index + 1}`;
  }

  /** A slot's name as a message draws it: {@link Overlays.playerName}, in the slot's armour colour. */
  private slotName(slot: PlayerSlot): TextRun {
    return { text: this.playerName(slot.index), color: this.nameColors[slot.drawColor()] };
  }

  /**
   * What the intermission's board shows above its panel: a deathmatch's result ranked, its winner
   * marked. docs/hud.md § Scoreboard.
   */
  private intermissionScoreRows(): ScoreRow[] | null {
    const rows = this.scoreRows();
    return rows && this.host.deathmatch ? rankByKills(rows) : rows;
  }

  /**
   * Every slot's row on the scoreboard. Names and pings are the network session's roster, where
   * there is one.
   *
   * @returns null for a game of one player, unless over the network — no board shows then
   */
  private scoreRows(): ScoreRow[] | null {
    const { slots, deathmatch } = this.host;
    const roster = this.host.roster();
    if (!roster && slots.length < 2) return null;
    return slots.map((slot) => {
      const entry = roster?.find((r) => r.slot === slot.index);
      return {
        name: entry?.name ?? `Player ${slot.index + 1}`,
        color: slot.drawColor(),
        kills: deathmatch ? slot.netFrags() : slot.kills,
        pingMs: entry?.pingMs ?? null,
        local: slot.local,
        present: entry?.present ?? true,
      };
    });
  }
}
