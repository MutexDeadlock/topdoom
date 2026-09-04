/**
 * `ReplayPlayback`: a replay's record served as the tic's input, one row per `endTic`, with the
 * playback controls (speed, pause) and the desync check the bar reads. docs/replays.md § Playback.
 */
import { AIM_QUANTUM, getRightMouseAction, type RightMouseAction, type TicInput } from '../input.ts';
import type { Pos2, Pos3 } from '../../types.ts';
import type { CameraPose, TopDownCamera } from '../../render/camera.ts';
import { getRandomCursors } from '../../util/random.ts';
import {
  BUTTON_FIRE,
  BUTTON_RIGHT_EDGE,
  NORMAL_SPEED_INDEX,
  poseAt,
  speedAt,
  type Keyframe,
  type Replay,
  type ReplayEvent,
  type SimSettings,
} from './defs.ts';
import { maskHas } from './keys.ts';

/** What the viewer is watching a replay through — see `ReplayPlayback.cameraView`. */
export type ReplayCameraView = 'recording' | 'manual';

export class ReplayPlayback implements TicInput {
  readonly replay: Replay;
  /** The next tic to serve; `ticCount` once the stream is spent. */
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
  /** The settings in force, re-asserted by `Game` before every tic; events move it. */
  settings: SimSettings;
  /**
   * The aim point of the tic just run, with its plane height — the manual view's camera lead, which
   * is a per-tic reader. What the reticle is *drawn* at is `aimAt`'s interpolation of it.
   */
  lastAim: Pos3 | null = null;
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

  private typedAt: Map<number, string>;
  private eventIndex = 0;
  private checkIndex = 0;
  /** The tic before `lastAim`'s — the point `aimAt` draws the reticle from. */
  private prevAim: Pos3 | null = null;

  constructor(replay: Replay) {
    this.replay = replay;
    this.settings = replay.data.settings;
    this.typedAt = new Map(replay.data.typed);
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

  held(...codes: string[]): boolean {
    const mask = this.replay.data.tics.held[this.cursor] ?? 0;
    for (const code of codes) {
      if (maskHas(mask, code)) return true;
    }
    return false;
  }

  pressed(code: string): boolean {
    return maskHas(this.replay.data.tics.pressed[this.cursor] ?? 0, code);
  }

  typed(): string {
    return this.typedAt.get(this.cursor) ?? '';
  }

  get mouseDown(): boolean {
    return ((this.replay.data.tics.buttons[this.cursor] ?? 0) & BUTTON_FIRE) !== 0;
  }

  rightMousePressed(action: RightMouseAction): boolean {
    const edge = ((this.replay.data.tics.buttons[this.cursor] ?? 0) & BUTTON_RIGHT_EDGE) !== 0;
    return edge && getRightMouseAction() === action;
  }

  consumeWheel(): number {
    return this.replay.data.tics.wheel[this.cursor] ?? 0;
  }

  aim(_camera: TopDownCamera, planeZ: number): Pos2 | null {
    const x = this.replay.data.tics.aimX[this.cursor] ?? null;
    const y = this.replay.data.tics.aimY[this.cursor] ?? null;
    this.prevAim = this.lastAim;
    if (x === null || y === null) {
      this.lastAim = null;
      return null;
    }
    const point = { x: x * AIM_QUANTUM, y: y * AIM_QUANTUM };
    this.lastAim = { x: point.x, y: point.y, z: planeZ };
    return point;
  }

  /**
   * Where the recording aimed `alpha` of the way through the tic being drawn, or null while
   * nothing is. Interpolated between the last two tics' points for the same reason every sprite in
   * the frame is: the record holds one per tic, and a reticle stepping 35 times a second under a
   * camera moving at the refresh rate reads as stutter. docs/replays.md § Playback.
   */
  aimAt(alpha: number): Pos3 | null {
    const to = this.lastAim;
    const from = this.prevAim;
    // A tic that aimed nowhere has no point to come from — the reticle arrives at this one.
    if (!to || !from) return to;
    return {
      x: from.x + (to.x - from.x) * alpha,
      y: from.y + (to.y - from.y) * alpha,
      z: from.z + (to.z - from.z) * alpha,
    };
  }

  endTic(): void {
    this.cursor++;
  }

  /** The camera tic `tic` was recorded at, null past the end of the stream. */
  poseAt(tic: number): CameraPose | null {
    return poseAt(this.replay.data.tics, tic);
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
   * Puts the stream at `tic`, re-seating what only ever walked forwards: the event cursor and the
   * settings, which are whatever the last event before `tic` left them (the check cursor re-seats
   * itself in `check`). Events stamped *for* `tic` stay pending, since `Game` applies those before
   * running it. docs/replays.md § Seeking.
   */
  seek(tic: number): void {
    const { events } = this.replay.data;
    this.cursor = Math.max(0, Math.min(this.ticCount, Math.round(tic)));
    this.lastAim = null;
    this.prevAim = null;
    this.settings = this.replay.data.settings;
    this.eventIndex = 0;
    while (this.eventIndex < events.length && events[this.eventIndex].tic < this.cursor) {
      const event = events[this.eventIndex++];
      if (event.kind === 'settings') this.settings = event.settings;
    }
    this.checkIndex = 0;
  }

  /** The events stamped for the tic about to run, in the order they were recorded. */
  eventsAt(tic: number): readonly ReplayEvent[] {
    const { events } = this.replay.data;
    let due: ReplayEvent[] | null = null;
    while (this.eventIndex < events.length && events[this.eventIndex].tic <= tic) {
      const event = events[this.eventIndex++];
      if (event.tic === tic) (due ??= []).push(event);
      if (event.kind === 'settings') this.settings = event.settings;
    }
    return due ?? NO_EVENTS;
  }

  /**
   * Compares the recording's sample for the tic about to run, if it took one, against the live
   * state; the first disagreement is kept and later ones ignored.
   */
  check(x: number, y: number): void {
    const { checks } = this.replay.data;
    while (this.checkIndex < checks.length && checks[this.checkIndex][0] < this.cursor) this.checkIndex++;
    const sample = checks[this.checkIndex];
    if (!sample || sample[0] !== this.cursor) return;
    this.checkIndex++;
    if (this.desyncedAt !== null) return;
    if (sample[1] !== x || sample[2] !== y || sample[3] !== getRandomCursors().p) {
      this.desyncedAt = this.cursor;
    }
  }
}

/** What `eventsAt` answers on the ordinary tic, so it allocates nothing there. */
const NO_EVENTS: readonly ReplayEvent[] = [];
