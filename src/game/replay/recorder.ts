/**
 * `ReplayRecorder`: the live `Input` wrapped so that everything a tic reads through it is written
 * down — the per-tic record, the typed characters, the settings changes and the death restarts
 * `Game` reports. What it hands over at the end is a `ReplayCapture`. docs/replays.md § Recording.
 */
import { AIM_QUANTUM, getRightMouseAction, type RightMouseAction, type TicInput } from '../input.ts';
import type { SaveCapture } from '../savegames.ts';
import type { GameSnapshot } from '../snapshot.ts';
import type { Pos2 } from '../../types.ts';
import type { CameraPose, TopDownCamera } from '../../render/camera.ts';
import { getRandomCursors } from '../../util/random.ts';
import {
  BUTTON_FIRE,
  BUTTON_RIGHT_EDGE,
  CHECK_INTERVAL,
  KEYFRAME_INTERVAL,
  POSE_QUANTUM,
  type LevelMarker,
  type ReplayCapture,
  type ReplayData,
  type ReplayEvent,
  type SimSettings,
} from './defs.ts';
import { heldMask, pressedMask } from './keys.ts';
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
  private wheelSign = 0;
  private aimX: number | null = null;
  private aimY: number | null = null;
  /** The camera this tic is being read at, handed over by `beginTic` already snapped. */
  private pose: CameraPose;

  constructor(live: TicInput, start: RecordingStart) {
    this.live = live;
    this.start = start;
    this.lastSettings = start.settings;
    this.pose = start.pose;
    this.levels = [{ tic: 0, map: start.capture.map }];
    this.data = {
      snapshots: [start.capture.state],
      keyframes: [{ tic: 0, map: start.capture.map, snapshot: 0 }],
      settings: start.settings,
      tics: {
        held: [],
        pressed: [],
        buttons: [],
        wheel: [],
        aimX: [],
        aimY: [],
        poseYaw: [],
        poseX: [],
        poseY: [],
        poseZ: [],
        poseDistance: [],
        poseTilt: [],
      },
      typed: [],
      events: [],
      checks: [],
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
    this.wheelSign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    return this.wheelSign;
  }

  aim(camera: TopDownCamera, planeZ: number): Pos2 | null {
    const point = this.live.aim(camera, planeZ);
    this.aimX = point ? Math.round(point.x / AIM_QUANTUM) : null;
    this.aimY = point ? Math.round(point.y / AIM_QUANTUM) : null;
    return point;
  }

  /**
   * Called by `Game` ahead of every tic with the player's position and the camera the tic will be
   * read at: stamps a settings change made since the last tic as an event for this one, and takes
   * the desync sample when one is due.
   */
  beginTic(x: number, y: number, settings: SimSettings, pose: CameraPose = this.pose): void {
    this.pose = pose;
    if (!sameSettings(settings, this.lastSettings)) {
      this.data.events.push({ tic: this.ticCount, kind: 'settings', settings });
      this.lastSettings = settings;
    }
    if (this.ticCount % CHECK_INTERVAL === 0) this.data.checks.push([this.ticCount, x, y, getRandomCursors().p]);
  }

  /** Closes the tic: the row is what the reads above saw, or hold nothing if never asked. */
  endTic(): void {
    const buttons =
      (this.live.mouseDown ? BUTTON_FIRE : 0) | (this.live.rightMousePressed(getRightMouseAction()) ? BUTTON_RIGHT_EDGE : 0);
    const text = this.live.typed();
    if (text !== '') this.data.typed.push([this.ticCount, text]);
    const { tics } = this.data;
    tics.held.push(heldMask(this.live));
    tics.pressed.push(pressedMask(this.live));
    tics.buttons.push(buttons);
    tics.wheel.push(this.wheelSign);
    tics.aimX.push(this.aimX);
    tics.aimY.push(this.aimY);
    tics.poseYaw.push(poseUnits(this.pose.yaw));
    tics.poseX.push(poseUnits(this.pose.point[0]));
    tics.poseY.push(poseUnits(this.pose.point[1]));
    tics.poseZ.push(poseUnits(this.pose.point[2]));
    tics.poseDistance.push(poseUnits(this.pose.distance));
    tics.poseTilt.push(poseUnits(this.pose.tilt));
    this.wheelSign = 0;
    this.aimX = null;
    this.aimY = null;
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

/** A pose component on the record's lattice. */
function poseUnits(v: number): number {
  return Math.round(v / POSE_QUANTUM);
}
