/**
 * {@link ReplayDriver}: the recorder or playback behind the tic's input, as the level runs it —
 * which one is in charge and what every slot reads through it, a recording's start and end, a
 * playback's take-over, its camera, its seek. `Game` holds one and answers for it through
 * {@link ReplayHost}. docs/replays.md § The TicInput seam.
 */
import { ReplayRecorder } from './recorder.ts';
import { ReplayPlayback } from './playback.ts';
import type { Keyframe, Replay, ReplayCapture } from './defs.ts';
import { quantizePose } from './defs.ts';
import { applySimSettings, captureSessionSettings, releaseSimSettings } from './settings.ts';
import type { Level } from '../level.ts';
import type { PlayerSlot, SlotSource } from '../playerslot.ts';
import type { TicInput } from '../input.ts';
import type { SaveCapture } from '../savegames.ts';
import type { GameSnapshot } from '../snapshot.ts';
import { latticeYaw, TopDownCamera } from '../../render/camera.ts';
import type { Viewport } from '../../render/viewport.ts';
import { DOOM_TIC } from '../../constants.ts';
import type { Pos2 } from '../../types.ts';

/**
 * How long one frame may spend running a replay's seek forward. Long enough that a minute of
 * recording catches up in a handful of frames, short enough that the page still answers a click
 * or an ESC between slices — tuned by feel, and it buys more tics than it looks like: the frame
 * it runs in draws nothing. docs/replays.md § Seeking.
 */
const SEEK_BUDGET_MS = 60;

/** What the driver asks of the level it runs — `Game` answers with one object literal. */
export interface ReplayHost {
  /** Every player slot; the list is never replaced, only grown. */
  readonly slots: readonly PlayerSlot[];
  /** The slot this browser plays. */
  readonly local: PlayerSlot;
  /** The slot the view is drawn for — `Game.viewed`: the local one, or the watched player. */
  readonly viewed: PlayerSlot;
  readonly view: Viewport;
  readonly level: Level;
  /** The name a network game's roster gives `slot`'s player, or null outside one. */
  nameOf(slot: PlayerSlot): string | null;
  /** The view brought onto {@link ReplayHost.viewed} once that changed — `Game.viewSwitched`. */
  viewSwitched(): void;
  /**
   * The drawn camera where `slot` is {@link ReplayHost.viewed}, null for any other — what
   * {@link PlayerSlot.eachCamera} takes. `Game.drawnCamera`.
   */
  drawnCamera(slot: PlayerSlot): TopDownCamera | null;
  /** What drives a slot with no replay in charge: the network's rows, the keyboard, nothing. */
  ownInput(slot: PlayerSlot): TicInput;
  ownSource(slot: PlayerSlot): SlotSource;
  /** The moment a state capture is refused at, as a clause, or null — `Game.blockedMoment`. */
  blockedMoment(): string | null;
  /**
   * The moment as a save holds it, without a thumbnail. Throws where
   * {@link ReplayHost.blockedMoment} refuses.
   */
  capture(): SaveCapture;
  /**
   * The level again — `Game.reloadLevel`.
   *
   * @param state  null for the level fresh
   */
  reloadLevel(state: GameSnapshot | null): void;
  /**
   * The level `map` at `state`, for a keyframe.
   *
   * @param map  the level to restore — this one when the set has no such map
   */
  restoreKeyframe(map: string, state: GameSnapshot): void;
  /** Every slot's body as the fog sweeps from them, refilled for this tic — the check sample's. */
  bodies(): readonly Pos2[];
  /** The "Entering" card for the current level. */
  showLevelCard(): void;
  /** The level is the player's from here: what a take-over changes besides the seam. */
  takenOver(): void;
  /** The playback bar redrawn for the seek in progress. */
  drawBar(): void;
  /**
   * One tic, `beginTic` included.
   *
   * @returns true when it swapped the level
   */
  runTic(): boolean;
  /** The timed overlays' clocks, which run on frames a seek draws none of. */
  tickOverlays(dt: number): void;
  silence(on: boolean): void;
  clearPain(): void;
  resyncClock(): void;
  /** The frame a seek lands on: the target drawn once, at the tic-exact pose. */
  drawLanding(rawDt: number): void;
}

export class ReplayDriver {
  private readonly host: ReplayHost;
  /**
   * What the tic reads its input through instead of the live `Input` while a replay is being
   * recorded or played — see the two getters below it.
   */
  private replay: ReplayRecorder | ReplayPlayback | null = null;
  /**
   * The keyframe a jump in progress still has to restore, and whether the bar's marker has had a
   * frame to itself yet. Null once it is restored, and for a jump that needs no anchor at all.
   * docs/replays.md § Seeking.
   */
  private seekAnchor: { frame: Keyframe; announced: boolean } | null = null;

  constructor(host: ReplayHost) {
    this.host = host;
  }

  /**
   * The recorder in charge, if a replay is being recorded. Routed through a getter — see CLAUDE.md.
   */
  get recorder(): ReplayRecorder | null {
    return this.replay instanceof ReplayRecorder ? this.replay : null;
  }

  get playback(): ReplayPlayback | null {
    return this.replay instanceof ReplayPlayback ? this.replay : null;
  }

  /** Whether a jump is in progress, which owns the frames until it lands. */
  get seeking(): boolean {
    return this.playback?.seekTarget != null;
  }

  /**
   * Puts `replay` in charge and points every slot's {@link PlayerSlot.input} and
   * {@link PlayerSlot.source} at it in the same step — the one place either is switched.
   * docs/replays.md § The TicInput seam.
   *
   * @param replay  null for nothing: each slot reads what the host's {@link ReplayHost.ownInput}
   *                says drives it
   */
  set(replay: ReplayRecorder | ReplayPlayback | null): void {
    this.replay = replay;
    for (const slot of this.host.slots) {
      // A recorder wraps whatever the slot read before it — the network's rows included.
      slot.input = replay ? replay.input(slot.index) : this.host.ownInput(slot);
      slot.source = replay instanceof ReplayPlayback ? 'replay' : this.host.ownSource(slot);
    }
  }

  /**
   * {@link ReplayDriver.set} again with what is in charge: every slot's own input may have changed
   * underneath.
   */
  rebind(): void {
    this.set(this.replay);
  }

  /**
   * Starts playing `replay`, after the load that snapped the camera the way a save restore does:
   * the recording's camera was mid-glide, and its settings are the run's.
   * docs/replays.md § Camera state.
   */
  startPlayback(replay: Replay): void {
    const playback = new ReplayPlayback(replay);
    this.set(playback);
    const { local, view, slots } = this.host;
    // A camera of its own, so the viewer's can be moved without moving the ray the picks are
    // cast along — `syncViewCamera` is what the drawn one follows.
    local.simCamera = new TopDownCamera(view.camera.aspect);
    // Every slot's own first pose: the level load left them framed on the player starts, which is
    // not where the recording was looking from.
    this.snapToTic(playback, 0);
    for (const slot of slots) slot.color = playback.slotColors[slot.index];
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
    if (this.host.local.cheats.typing) return 'finish typing the cheat code first';
    const moment = this.host.blockedMoment();
    return moment === null ? null : `you can't start recording ${moment}`;
  }

  /**
   * Starts recording from this moment. The level is **reloaded from the capture** first, so the
   * run being recorded is exactly what a playback restores, transients and all — and the camera
   * is put back mid-glide afterwards, since the reload snapped it. Throws
   * {@link ReplayDriver.recordingRefusal}. docs/replays.md § Recording.
   */
  startRecording(): void {
    const refusal = this.recordingRefusal();
    if (refusal) throw new Error(refusal);
    const { slots, level } = this.host;
    const cameras = slots.map((slot) => ({ sim: slot.simCamera.snapshot(), auto: slot.autoCamera.snapshot() }));
    // Elided: this is a replay's snapshot 0, and the reload below re-spawns the things it leaves
    // out — docs/replays.md § The record.
    const capture = this.host.capture();
    const entering = level.time === 0;
    this.host.reloadLevel(capture.state);
    for (const slot of slots) {
      slot.simCamera.restore(cameras[slot.index].sim);
      slot.autoCamera.restore(cameras[slot.index].auto);
    }
    // A reload shows no card, but a recording that begins as the level does still is arriving.
    if (entering) this.host.showLevelCard();
    this.set(
      new ReplayRecorder(
        slots.map((slot) => slot.input),
        {
          capture,
          poses: slots.map((slot) => quantizePose(slot.simCamera.pose())),
          players: slots.map((slot) => slot.settings),
          colors: slots.map((slot) => slot.drawColor()),
          names: slots.map((slot) => this.host.nameOf(slot)),
          session: captureSessionSettings(),
        },
      ),
    );
  }

  /** Ends the recording and hands it over for the store; null when none was running. */
  finishRecording(): ReplayCapture | null {
    const recorder = this.recorder;
    if (!recorder) return null;
    this.set(null);
    return recorder.finish();
  }

  /**
   * Hands a replay's level to the player right here: live input from the next tic, settings back
   * to the stored ones, the viewport's camera back in charge of the simulation.
   * docs/replays.md § Playback.
   */
  takeOver(): void {
    const playback = this.playback;
    if (!playback) return;
    releaseSimSettings();
    this.set(null);
    const { local, view } = this.host;
    // Only the local slot is taken over: a view on another player comes back to it first, so the
    // pose the viewport's camera hands the simulation is its own. docs/replays.md § Playback.
    if (playback.viewSlot !== local.index) this.host.viewSwitched();
    const camera = view.camera;
    // The pose came from the record, so the orbit can be anywhere a Q/E step passed through; from
    // here on only whole steps move it, so it is glided back onto the lattice first — before the
    // save `takenOver` writes, which reads the target. docs/camera.md § Camera orbit.
    camera.stepYaw(latticeYaw(camera.yawDeg) - camera.yawDeg);
    // The viewport's camera takes the simulation back over at the pose it is being drawn at, so
    // taking over in the manual view keeps the view the player is looking at. The auto camera
    // stood still through the playback, which is why the hand-back seeds it.
    local.attachSimCamera(camera);
    view.input.reset();
    this.host.takenOver();
  }

  /**
   * The camera picker's player entries: watches slot `slot`'s player
   * ({@link ReplayPlayback.viewSlot}) and brings the view over to them. docs/replays.md § Playback.
   */
  watch(slot: number): void {
    const playback = this.playback;
    if (!playback || slot === playback.viewSlot || !this.host.slots[slot]) return;
    playback.viewSlot = slot;
    this.host.viewSwitched();
  }

  /**
   * Jumps the playback to `tic`. The state comes from the last keyframe at or before it and the
   * tics from there to the target are then run, which {@link ReplayDriver.runSeek} does over the
   * frames that follow — a jump that stays ahead of the current position and passes no keyframe
   * needs no restore and runs on from here. docs/replays.md § Seeking.
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
  runSeek(rawDt: number): void {
    const playback = this.playback;
    if (!playback) return;
    const pending = this.seekAnchor;
    if (pending !== null && !pending.announced) {
      pending.announced = true;
      this.host.drawBar();
      return;
    }
    if (pending !== null) {
      this.seekAnchor = null;
      this.applyKeyframe(pending.frame, playback);
    }
    const swapped = this.advanceSeek(playback);
    // The target landed: draw it. A tic that swapped the level leaves the next frame to do it.
    if (playback.seekTarget === null && !swapped) {
      this.host.drawLanding(rawDt);
    } else {
      this.host.drawBar();
    }
  }

  /**
   * Brings the drawn camera up to the watched player's simulation camera, once per tic of a
   * playback: mirrored outright in the recording view, and in the manual one driven by the viewer's
   * own orbit and framing keys around the same follow point. Nothing here reaches the simulation.
   * docs/replays.md § Playback.
   */
  syncViewCamera(dt: number): void {
    const playback = this.playback;
    const { viewed, view } = this.host;
    const camera = view.camera;
    if (!playback || camera === viewed.simCamera) return;
    if (playback.cameraView === 'recording') {
      camera.copyFrom(viewed.simCamera);
      return;
    }
    const input = view.input;
    camera.applyYawInput(input, dt);
    camera.applyFramingKeys(input);
    camera.tick(dt, viewed.player.followPoint(), playback.lastAim);
    // The live input is read by nothing else while a replay plays, and its edges have to be
    // cleared by someone or a press would latch for the rest of the playback.
    input.endTic();
  }

  /**
   * What goes between two tics: the recorder's keyframe, settings diff and desync sample, or the
   * playback's due events (a reload lands here, synchronously — never parked), its settings pinned
   * again, and its sample compared. docs/replays.md § Restore events.
   */
  beginTic(): void {
    const { slots } = this.host;
    const recorder = this.recorder;
    if (recorder) {
      // Before the tic the anchor is stamped for; a refused one waits for the next tic.
      if (recorder.keyframeDue) this.writeKeyframe();
      // Every slot's camera snapped onto the record's lattice *before* the tic reads it, so what
      // ran is what is stored — the aim point's own rule. `roundPose`, not `setPose`: the orbit and
      // the framing are heading somewhere and that is not part of a pose.
      // docs/replays.md § Camera state.
      const poses = slots.map((slot) => {
        const pose = quantizePose(slot.simCamera.pose());
        slot.simCamera.roundPose(pose);
        return pose;
      });
      recorder.beginTic(
        slots.map((slot) => slot.player),
        slots.map((slot) => slot.settings),
        captureSessionSettings(),
        poses,
      );
      return;
    }
    const playback = this.playback;
    if (!playback) return;
    // The camera is an input here, not a computation: every slot's tic runs at the pose the
    // recording ran at, whatever this build's camera code would have picked.
    // docs/replays.md § Camera state.
    for (const slot of slots) {
      const pose = playback.poseAt(playback.cursor, slot.index);
      if (pose) slot.simCamera.setPose(pose);
    }
    for (const event of playback.eventsAt(playback.cursor)) {
      if (event.kind !== 'restore') continue;
      this.host.reloadLevel(event.snapshot === null ? null : playback.replay.data.snapshots[event.snapshot]);
    }
    this.pinSettings(playback);
    // After the events, whose reload stands every body up anew.
    playback.check(this.host.bodies());
  }

  /** Moves a playback's cursor: every slot is served the next row. */
  endTic(): void {
    this.playback?.endTic();
  }

  /**
   * A seek anchor for the recorder at this moment, where one is recording and the moment allows a
   * capture at all: a keyframe taken mid-cheat or over a corpse would restore what a save refuses
   * to write. docs/replays.md § Seeking.
   */
  writeKeyframe(): void {
    const recorder = this.recorder;
    if (!recorder || this.host.local.cheats.typing || this.host.blockedMoment() !== null) {
      return;
    }
    recorder.keyframe(this.host.level.name, this.host.capture().state);
  }

  /** A playback's pins come off; a recording is finished by the session layer before this. */
  dispose(): void {
    if (this.playback) releaseSimSettings();
    this.set(null);
  }

  /**
   * A playback's settings in force: the local slot's pinned through the owners, where
   * `GLOBAL_PLAYER_SETTINGS` reads them, and every other slot's as a record of its own.
   */
  private pinSettings(playback: ReplayPlayback): void {
    applySimSettings(playback.settings);
    const { slots, local } = this.host;
    for (const slot of slots) {
      if (slot !== local) slot.settings = playback.slotSettings[slot.index];
    }
  }

  /** The world as `frame` held it at that anchor, cameras and pinned settings included. */
  private applyKeyframe(frame: Keyframe, playback: ReplayPlayback): void {
    const state = playback.replay.data.snapshots[frame.snapshot];
    this.host.restoreKeyframe(frame.map, state);
    playback.seek(frame.tic);
    this.snapToTic(playback, frame.tic);
    // The state is the record's own again, so whatever had drifted before this point is gone.
    playback.desyncedAt = null;
  }

  /**
   * One frame's share of a seek's catch-up: tics run as fast as they will inside
   * {@link SEEK_BUDGET_MS}, with sound off. docs/replays.md § Seeking.
   *
   * @returns true when a tic swapped the level, which ends the slice and the frame with it —
   *          everything the draw would touch has just been rebuilt
   */
  private advanceSeek(playback: ReplayPlayback): boolean {
    const target = playback.seekTarget;
    if (target === null) return false;
    const until = performance.now() + SEEK_BUDGET_MS;
    let swapped = false;
    this.host.silence(true);
    try {
      while (!swapped && playback.cursor < target && playback.hasTic) {
        swapped = this.host.runTic();
        // The timed overlays' clocks run on frames, and a catch-up draws none: without this a
        // secret found at 0:10 is still announced on a landing at 0:30. Ticked in sim time, so
        // what the landing tic would show when watched is what it shows. docs/replays.md § Seeking.
        this.host.tickOverlays(DOOM_TIC);
        if (performance.now() >= until) break;
      }
    } finally {
      this.host.silence(false);
    }
    if (playback.cursor < target && playback.hasTic) return swapped;
    playback.seekTarget = null;
    this.syncViewCamera(DOOM_TIC);
    // Every hit the catch-up ran through added to the damage flash, none of which the viewer saw —
    // undropped, the frame the jump lands on opens red over a fight that is already over. The
    // sound's own answer to the same problem is `silence` above. docs/replays.md § Seeking.
    this.host.clearPain();
    // The catch-up took real time no tic is owed for, and the frame it ends on draws the target.
    this.host.resyncClock();
    return swapped;
  }

  /**
   * Every slot's pose of `tic`, on each of its cameras, snapped rather than glided into — the
   * camera was somewhere else entirely a moment ago — and the playback's settings pinned. For the
   * discontinuities: a playback opening, a keyframe landing. docs/replays.md § Camera state.
   */
  private snapToTic(playback: ReplayPlayback, tic: number): void {
    const { slots } = this.host;
    for (const slot of slots) {
      const pose = playback.poseAt(tic, slot.index);
      if (pose) slot.eachCamera(this.host.drawnCamera(slot), (camera) => camera.snapPose(pose));
    }
    this.pinSettings(playback);
  }
}
