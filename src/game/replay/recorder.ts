/**
 * `ReplayRecorder`: the live `Input` wrapped so that everything a tic reads through it is written
 * down — the per-tic rows (the codec in `replay/row.ts`), the settings changes and the death
 * restarts `Game` reports. What it hands over at the end is a `ReplayCapture`.
 * docs/replays.md § Recording.
 */
import { AIM_QUANTUM, getRightMouseAction, type RightMouseAction, type TicInput } from '../input.ts';
import type { SaveCapture } from '../savegames.ts';
import type { GameSnapshot } from '../snapshot.ts';
import type { Pos2 } from '../../types.ts';
import type { CameraPose, TopDownCamera } from '../../render/camera.ts';
import { getRandomCursors } from '../../util/random.ts';
import {
  CHECK_INTERVAL,
  KEYFRAME_INTERVAL,
  checkCoord,
  type LevelMarker,
  type ReplayCapture,
  type ReplayData,
  type ReplayEvent,
  type SimSettings,
} from './defs.ts';
import { appendRow, emptyColumns, emptyRow, sampleInput, writeRowPose } from './row.ts';
import { sameSettings } from './settings.ts';

/** What a recording starts from: the level as a save would capture it, and the camera it stands at. */
export interface RecordingStart {
  capture: SaveCapture;
  /** The pose the first tic will be read at, already snapped — `Game.startRecording`. */
  pose: CameraPose;
  settings: SimSettings;
}

export class ReplayRecorder implements TicInput {
  private live: TicInput;
  private data: ReplayData;
  private start: RecordingStart;
  private levels: LevelMarker[];
  /** Restore events reference a snapshot by index; the same object restored twice is stored once. */
  private snapshotIndex = new Map<GameSnapshot, number>();
  private lastSettings: SimSettings;
  /**
   * The tic being recorded: the wheel and the aim point as the tic read them, the pose `beginTic`
   * handed over. The keys are sampled into it and the whole row appended by `endTic`.
   */
  private row = emptyRow();

  constructor(live: TicInput, start: RecordingStart) {
    this.live = live;
    this.start = start;
    this.lastSettings = start.settings;
    writeRowPose(this.row, start.pose);
    this.levels = [{ tic: 0, map: start.capture.map }];
    this.data = {
      snapshots: [start.capture.state],
      keyframes: [{ tic: 0, map: start.capture.map, snapshot: 0 }],
      settings: start.settings,
      tics: emptyColumns(),
      typed: [],
      events: [],
      checks: { x: [], y: [], cursor: [] },
    };
    this.snapshotIndex.set(start.capture.state, 0);
  }

  get tics(): number {
    return this.ticCount;
  }

  held(...codes: string[]): boolean {
    return this.live.held(...codes);
  }

  pressed(code: string): boolean {
    return this.live.pressed(code);
  }

  typed(): string {
    return this.live.typed();
  }

  get mouseDown(): boolean {
    return this.live.mouseDown;
  }

  rightMousePressed(action: RightMouseAction): boolean {
    return this.live.rightMousePressed(action);
  }

  /**
   * The sign alone: `WeaponSystem.handleSwitching` reads nothing else of a scroll, and the sign
   * is what the record keeps — so the live tic sees exactly what the playback will.
   */
  consumeWheel(): number {
    const delta = this.live.consumeWheel();
    this.row.wheel = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    return this.row.wheel;
  }

  aim(camera: TopDownCamera, planeZ: number): Pos2 | null {
    const point = this.live.aim(camera, planeZ);
    this.row.aimX = point ? Math.round(point.x / AIM_QUANTUM) : null;
    this.row.aimY = point ? Math.round(point.y / AIM_QUANTUM) : null;
    return point;
  }

  /**
   * Called by `Game` ahead of every tic with the player's position and the camera the tic will be
   * read at (omitted: the last one's): stamps a settings change made since the last tic as an event
   * for this one, and takes the desync sample when one is due.
   */
  beginTic(x: number, y: number, settings: SimSettings, pose?: CameraPose): void {
    if (pose) writeRowPose(this.row, pose);
    if (!sameSettings(settings, this.lastSettings)) {
      this.data.events.push({ tic: this.ticCount, kind: 'settings', settings });
      this.lastSettings = settings;
    }
    if (this.ticCount % CHECK_INTERVAL === 0) {
      const { checks } = this.data;
      checks.x.push(checkCoord(x));
      checks.y.push(checkCoord(y));
      checks.cursor.push(getRandomCursors().p);
    }
  }

  /** Closes the tic: the row is what the reads above saw, or holds nothing if never asked. */
  endTic(): void {
    const { row } = this;
    sampleInput(this.live, getRightMouseAction(), row);
    appendRow(this.data.tics, this.data.typed, row);
    row.wheel = 0;
    row.aimX = null;
    row.aimY = null;
    this.live.endTic();
  }

  /**
   * A death restart landing: the level is about to be rebuilt from `state` (null: a plain reload
   * with a fresh inventory) before the next tic. docs/replays.md § Restore events.
   */
  restore(map: string, state: GameSnapshot | null): void {
    const snapshot = state === null ? null : this.snapshotAt(state);
    const event: ReplayEvent = { tic: this.ticCount, kind: 'restore', map, snapshot };
    this.data.events.push(event);
  }

  /**
   * Whether a seek anchor is due at the tic about to run: an interval past the last one taken.
   * `Game` asks before every tic and takes the keyframe only where the moment allows a capture at
   * all, so a due one waits rather than being skipped. docs/replays.md § Seeking.
   */
  get keyframeDue(): boolean {
    const { keyframes } = this.data;
    return this.ticCount >= keyframes[keyframes.length - 1].tic + KEYFRAME_INTERVAL;
  }

  /** The anchor `keyframeDue` asked for, at the tic about to run. */
  keyframe(map: string, state: GameSnapshot): void {
    this.data.keyframes.push({ tic: this.ticCount, map, snapshot: this.snapshotAt(state) });
  }

  /** A level beginning at the current tic; the same map again (a restart) adds no marker. */
  levelLoaded(map: string): void {
    if (this.levels[this.levels.length - 1].map === map) return;
    this.levels.push({ tic: this.ticCount, map });
  }

  finish(): ReplayCapture {
    const { skill, wads, mapWad, patchWads } = this.start.capture;
    return {
      skill,
      wads,
      mapWad,
      ...(patchWads ? { patchWads } : {}),
      ticCount: this.ticCount,
      levels: this.levels,
      data: this.data,
    };
  }

  /** The tic about to run — one past the rows closed so far. */
  private get ticCount(): number {
    return this.data.tics.held.length;
  }

  /** Where `state` sits in `snapshots`, appending it the first time it is asked for. */
  private snapshotAt(state: GameSnapshot): number {
    const known = this.snapshotIndex.get(state);
    if (known !== undefined) return known;
    const index = this.data.snapshots.length;
    this.snapshotIndex.set(state, index);
    this.data.snapshots.push(state);
    return index;
  }
}
