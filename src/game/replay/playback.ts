/**
 * {@link ReplayPlayback}: a replay's record served as every slot's input, one row per tic through
 * the codec in `replay/row.ts`, with the playback controls (speed, pause) and the desync check the
 * bar reads. docs/replays.md § Playback.
 */
import type { TicInput } from '../input.ts';
import type { Pos2, Pos3 } from '../../types.ts';
import type { CameraPose, TopDownCamera } from '../../render/camera.ts';
import { getRandomCursors } from '../../util/random.ts';
import { asPlayerColor, slotColor, type PlayerColor } from '../../wad/playercolor.ts';
import {
  CHECK_INTERVAL,
  NORMAL_SPEED_INDEX,
  checkCoord,
  poseAt,
  speedAt,
  type Keyframe,
  type PlayerSettings,
  type Replay,
  type ReplayEvent,
  type SessionSettings,
  type SimSettings,
} from './defs.ts';
import { RowInput, readRow } from './row.ts';
import type { GameSnapshot } from '../snapshot.ts';

/** What the viewer is watching a replay through — see {@link ReplayPlayback.cameraView}. */
export type ReplayCameraView = 'recording' | 'manual';

/**
 * What `R` reloads on a level, `Game.savedState` and `Game.checkpoint` — see
 * {@link ReplayPlayback.reloadsAt}.
 */
export interface ReloadStates {
  savedState: GameSnapshot | null;
  checkpoint: GameSnapshot | null;
}

export class ReplayPlayback {
  readonly replay: Replay;
  /** The next tic to serve; {@link ReplayPlayback.ticCount} once the stream is spent. */
  cursor = 0;
  speedIndex = NORMAL_SPEED_INDEX;
  paused = false;
  /** The tic the first check sample disagreed at, or null while everything matches. */
  desyncedAt: number | null = null;
  /**
   * Whether the drawn camera is the one the recording had, or the viewer's own. Only ever the
   * *drawn* one: the simulation keeps its own camera either way, so looking around cannot change
   * what the run does. docs/replays.md § Playback.
   */
  cameraView: ReplayCameraView = 'recording';
  /**
   * The slot the viewer watches — its HUD, its camera, its reticle. Only ever what is *drawn*, like
   * {@link ReplayPlayback.cameraView}; the bar's camera picker moves it (`ReplayDriver.watch`).
   * docs/replays.md § Playback.
   */
  viewSlot = 0;
  /**
   * Slot 0's player settings in force beside the session's — what `Game` pins through the owners
   * before every tic, the local slot being 0. Events move it.
   */
  settings: SimSettings;
  /** Every slot's player settings in force, by slot; events move them. */
  readonly slotSettings: PlayerSettings[];
  /** Every slot's armour colour: the record's, or the slot's default where it wrote none. */
  readonly slotColors: PlayerColor[];
  /**
   * What the camera picker calls every slot's player: the name its record carries, else the
   * player's number — never the replay's credit, which names whoever stored it.
   */
  readonly slotNames: string[];
  /**
   * The tic a seek in progress is catching up to, null when none is. `Game` sets it and grinds
   * the tics out a frame's worth at a time. docs/replays.md § Seeking.
   */
  seekTarget: number | null = null;
  /**
   * Which way the jump in progress went, as the viewer asked for it — a backward one still runs
   * its tics forwards from a keyframe, and the marker over the frozen frame has to say backward
   * anyway. docs/replays.md § Seeking.
   */
  seekBack = false;

  private session: SessionSettings;
  private typedAt: Map<number, string>[];
  private eventIndex = 0;
  /** Each slot's input, its row re-read wherever the cursor moves. */
  private inputs: PlaybackInput[];

  constructor(replay: Replay) {
    this.replay = replay;
    const { slots } = replay.data;
    this.slotSettings = slots.map((slot) => slot.settings);
    this.slotColors = slots.map((slot, index) => asPlayerColor(slot.color, slotColor(index)));
    this.slotNames = slots.map((slot, index) => slotNameOf(slot.name, index));
    this.session = replay.data.session;
    this.settings = { ...this.slotSettings[0], ...this.session };
    this.typedAt = slots.map((slot) => new Map(slot.typed));
    this.inputs = slots.map((slot) => new PlaybackInput({ rightMouse: slot.settings.rightMouse }));
    this.readCursorRows();
  }

  get ticCount(): number {
    return this.replay.ticCount;
  }

  get hasTic(): boolean {
    return this.cursor < this.replay.ticCount;
  }

  /** The stream is spent; the bar offers a restart and the frame loop banks nothing. */
  get ended(): boolean {
    return !this.hasTic;
  }

  get speed(): number {
    return speedAt(this.speedIndex);
  }

  /** Slot `slot`'s input: its record's row for the tic about to run. */
  input(slot: number): TicInput {
    return this.inputs[slot];
  }

  /**
   * The watched slot's aim point of the tic just run, with its plane height — the manual view's
   * camera lead, which is a per-tic reader. What the reticle is *drawn* at is
   * {@link ReplayPlayback.aimAt}'s interpolation of it.
   */
  get lastAim(): Pos3 | null {
    return this.inputs[this.viewSlot].lastAim;
  }

  /**
   * Where the watched slot's recording aimed during the tic being drawn. Interpolated between the
   * last two tics' points for the same reason every sprite in the frame is: the record holds one
   * per tic, and a reticle stepping 35 times a second under a camera moving at the refresh rate
   * reads as stutter. docs/replays.md § Playback.
   *
   * @param alpha  the fraction of the way through the tic being drawn
   * @returns null while nothing is aimed at
   */
  aimAt(alpha: number): Pos3 | null {
    const { lastAim: to, prevAim: from } = this.inputs[this.viewSlot];
    // A tic that aimed nowhere has no point to come from — the reticle arrives at this one.
    if (!to || !from) return to;
    return {
      x: from.x + (to.x - from.x) * alpha,
      y: from.y + (to.y - from.y) * alpha,
      z: from.z + (to.z - from.z) * alpha,
    };
  }

  /** Closes the tic for every slot: the cursor moves on and each input's row with it. */
  endTic(): void {
    this.cursor++;
    this.readCursorRows();
  }

  /** The camera slot `slot` was recorded at on tic `tic`, null past the end of the stream. */
  poseAt(tic: number, slot = 0): CameraPose | null {
    const record = this.replay.data.slots[slot];
    return record ? poseAt(record.tics, tic) : null;
  }

  /** The keyframe a jump to `tic` starts from: the last one at or before it, `[0]` at worst. */
  keyframeAt(tic: number): Keyframe {
    const { keyframes } = this.replay.data;
    let found = keyframes[0];
    for (const frame of keyframes) {
      if (frame.tic > tic) break;
      found = frame;
    }
    return found;
  }

  /**
   * What `R` reloads on the level a jump to `frame` lands on, as playing through to it leaves them:
   * the record's start on its first level, which is what a playback is built from, and on a level
   * entered since, the keyframe laid down as it was entered — null where that one was refused.
   * docs/savegames.md § The checkpoint.
   */
  reloadsAt(frame: Keyframe): ReloadStates {
    const { levels, data } = this.replay;
    let entered = levels[0];
    for (const marker of levels) {
      if (marker.tic > frame.tic) break;
      entered = marker;
    }
    if (entered === levels[0]) return { savedState: data.snapshots[0], checkpoint: null };
    const anchor = data.keyframes.find((k) => k.tic === entered.tic && k.map === entered.map);
    return { savedState: null, checkpoint: anchor ? data.snapshots[anchor.snapshot] : null };
  }

  /**
   * Puts the stream at `tic`, re-seating what only ever walked forwards: the event cursor and the
   * settings, which are whatever the last event before `tic` left them (the check samples are
   * indexed by the tic, so they need nothing re-seated). Events stamped *for* `tic` stay pending,
   * since `Game` applies those before running it. docs/replays.md § Seeking.
   */
  seek(tic: number): void {
    const { data } = this.replay;
    this.cursor = Math.max(0, Math.min(this.ticCount, Math.round(tic)));
    this.readCursorRows();
    for (const input of this.inputs) {
      input.lastAim = null;
      input.prevAim = null;
    }
    for (let slot = 0; slot < data.slots.length; slot++) this.slotSettings[slot] = data.slots[slot].settings;
    this.session = data.session;
    this.settle();
    this.eventIndex = 0;
    while (this.eventIndex < data.events.length && data.events[this.eventIndex].tic < this.cursor) {
      this.applyEvent(data.events[this.eventIndex++]);
    }
  }

  /** The events stamped for the tic about to run, in the order they were recorded. */
  eventsAt(tic: number): readonly ReplayEvent[] {
    const { events } = this.replay.data;
    let due: ReplayEvent[] | null = null;
    while (this.eventIndex < events.length && events[this.eventIndex].tic <= tic) {
      const event = events[this.eventIndex++];
      if (event.tic === tic) (due ??= []).push(event);
      this.applyEvent(event);
    }
    return due ?? NO_EVENTS;
  }

  /**
   * Compares the recording's sample for the tic about to run, if it took one, against every slot's
   * live position and the random cursor; the first disagreement is kept and later ones ignored. The
   * samples sit one per {@link CHECK_INTERVAL} from tic 0, so the tic indexes them and a seek needs
   * no cursor of its own.
   */
  check(bodies: readonly Pos2[]): void {
    if (this.desyncedAt !== null || this.cursor % CHECK_INTERVAL !== 0) return;
    const { checks } = this.replay.data;
    const i = this.cursor / CHECK_INTERVAL;
    if (i >= checks.cursor.length) return;
    let agrees = checks.cursor[i] === getRandomCursors().p;
    for (let slot = 0; agrees && slot < bodies.length; slot++) {
      agrees = checks.x[slot]?.[i] === checkCoord(bodies[slot].x) && checks.y[slot]?.[i] === checkCoord(bodies[slot].y);
    }
    if (!agrees) this.desyncedAt = this.cursor;
  }

  /** A settings or session event taking effect; a restore is `Game`'s to carry out. */
  private applyEvent(event: ReplayEvent): void {
    if (event.kind === 'restore') return;
    if (event.kind === 'settings') this.slotSettings[event.slot] = event.settings;
    else this.session = event.settings;
    this.settle();
  }

  /**
   * {@link ReplayPlayback.settings} and every input's right-button binding brought up to the
   * settings in force.
   */
  private settle(): void {
    this.settings = { ...this.slotSettings[0], ...this.session };
    for (let slot = 0; slot < this.inputs.length; slot++) {
      this.inputs[slot].rightMouse = this.slotSettings[slot].rightMouse;
    }
  }

  private readCursorRows(): void {
    const { slots } = this.replay.data;
    for (let slot = 0; slot < this.inputs.length; slot++) {
      readRow(slots[slot].tics, this.typedAt[slot], this.cursor, this.inputs[slot].row);
    }
  }
}

/**
 * What {@link ReplayPlayback.eventsAt} answers on the ordinary tic, so it allocates nothing there.
 */
const NO_EVENTS: readonly ReplayEvent[] = [];

/**
 * One slot's name for {@link ReplayPlayback.slotNames}.
 *
 * @param recorded  the record's own `name`, as the file holds it
 */
function slotNameOf(recorded: unknown, index: number): string {
  const name = typeof recorded === 'string' ? recorded.trim() : '';
  return name || `Player ${index + 1}`;
}

/**
 * One slot's row served as its input, keeping the last two aim points it answered — the reticle
 * is drawn between them. The row and the binding it answers under are the playback's to set, and
 * so is the cursor ({@link ReplayPlayback.endTic}).
 */
class PlaybackInput extends RowInput {
  /** The aim point of the tic just run, with its plane height. */
  lastAim: Pos3 | null = null;
  /** The tic before {@link PlaybackInput.lastAim}'s. */
  prevAim: Pos3 | null = null;

  aim(camera: TopDownCamera, planeZ: number): Pos2 | null {
    const point = super.aim(camera, planeZ);
    this.prevAim = this.lastAim;
    this.lastAim = point ? { x: point.x, y: point.y, z: planeZ } : null;
    return point;
  }
}
