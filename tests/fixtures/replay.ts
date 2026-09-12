import type { GameSnapshot } from '../../src/game/snapshot.ts';
import type { SaveCapture } from '../../src/game/savegames.ts';
import { getRightMouseAction, quantizeAim, type TicInput } from '../../src/game/input.ts';
import {
  CHECK_INTERVAL,
  GLOBAL_PLAYER_SETTINGS,
  captureSessionSettings,
  captureSimSettings,
  type RecordingStart,
  type ReplayCapture,
  type ReplayRecorder,
  type SimSettings,
} from '../../src/game/replay.ts';
import type { CameraPose, TopDownCamera } from '../../src/render/camera.ts';
import type { Pos2 } from '../../src/types.ts';
import { withSessionDefaults } from '../../src/game/replay/settings.ts';

/** One tic's worth of live input, as `scriptedInput` answers it. */
export interface ScriptedRow {
  held?: string[];
  pressed?: string[];
  typed?: string;
  fire?: boolean;
  right?: boolean;
  wheel?: number;
  aim?: Pos2 | null;
}

/** A live `TicInput` answering `rows[tic]`, advanced by `endTic` — what a recorder wraps. */
export function scriptedInput(rows: ScriptedRow[]): TicInput & { tic: number } {
  const input = {
    tic: 0,
    held: (...codes: string[]) => codes.some((c) => rows[input.tic]?.held?.includes(c) ?? false),
    pressed: (code: string) => rows[input.tic]?.pressed?.includes(code) ?? false,
    typed: () => rows[input.tic]?.typed ?? '',
    get mouseDown() {
      return rows[input.tic]?.fire ?? false;
    },
    rightMousePressed: (action: string) => (rows[input.tic]?.right ?? false) && getRightMouseAction() === action,
    consumeWheel: () => rows[input.tic]?.wheel ?? 0,
    aim: () => quantizeAim(rows[input.tic]?.aim ?? null),
    endTic: () => {
      input.tic++;
    },
  };
  return input;
}

/** The camera a scripted `aim` is handed; nothing reads it. */
export const NO_CAMERA = {} as TopDownCamera;

/** The camera a recording starts at, as `startRecording` hands one over — already snapped. */
export const START_POSE: CameraPose = { yaw: 90, point: [64, 41, -128], distance: 480, tilt: 57.5 };
export const START_SNAPSHOT = { players: [{ player: {} }], rng: { p: 0, m: 0 } } as unknown as GameSnapshot;

/** A one-slot recording's start on E1M1 at `START_POSE`, under the settings in force. */
export function recordingStart(): RecordingStart {
  const capture = {
    map: 'E1M1',
    skill: 3,
    wads: [{ name: 'DOOM.WAD', id: 'abc' }],
    mapWad: 'abc',
    levelTime: 0,
    thumb: '',
    state: START_SNAPSHOT,
  } as SaveCapture;
  return {
    capture,
    poses: [START_POSE],
    players: [{ ...GLOBAL_PLAYER_SETTINGS }],
    colors: ['green'],
    names: [null],
    session: captureSessionSettings(),
  };
}

/**
 * `ReplayRecorder.beginTic` for a one-slot recording: the slot at (x, y) under `settings`, split
 * into its player and session halves, at `pose` (omitted: the last one).
 */
export function beginTic(
  recorder: ReplayRecorder,
  x: number,
  y: number,
  settings: SimSettings = captureSimSettings(),
  pose?: CameraPose,
): void {
  const { player, session } = splitSettings(settings);
  recorder.beginTic([{ x, y }], [player], session, pose ? [pose] : undefined);
}

/** `settings` as a recording stores them: the player's half and the session's. */
export function splitSettings(settings: SimSettings) {
  const { autorun, autoSwitchWeapon, rightMouse, cameraMode } = settings;
  return { player: { autorun, autoSwitchWeapon, rightMouse, cameraMode }, session: withSessionDefaults(settings) };
}

/**
 * One recording as `Game` hands it to the store — the smallest capture that survives every
 * validation a read runs (`isPlayableData`), shared by the store's tests and the stock folder's.
 * docs/replays.md § The record.
 */
export function replayCapture(ticCount = 2): ReplayCapture {
  // One desync sample per `CHECK_INTERVAL` tics from tic 0 — what `isPlayableData` counts.
  const samples = Array(Math.ceil(ticCount / CHECK_INTERVAL)).fill(0);
  return {
    skill: 3,
    wads: [{ name: 'DOOM2.WAD', id: 'iwad' }],
    mapWad: 'iwad',
    ticCount,
    levels: [{ tic: 0, map: 'MAP01' }],
    data: {
      snapshots: [REPLAY_SNAPSHOT],
      keyframes: [{ tic: 0, map: 'MAP01', snapshot: 0 }],
      session: withSessionDefaults({}),
      slots: [
        {
          settings: { autorun: true, autoSwitchWeapon: true, rightMouse: 'use', cameraMode: 'auto' },
          tics: {
            poseYaw: Array(ticCount).fill(0),
            poseX: Array(ticCount).fill(0),
            poseY: Array(ticCount).fill(0),
            poseZ: Array(ticCount).fill(0),
            poseDistance: Array(ticCount).fill(0),
            poseTilt: Array(ticCount).fill(0),
            held: Array(ticCount).fill(0),
            pressed: Array(ticCount).fill(0),
            buttons: Array(ticCount).fill(0),
            wheel: Array(ticCount).fill(0),
            aimX: Array(ticCount).fill(null),
            aimY: Array(ticCount).fill(null),
          },
          typed: [],
        },
      ],
      events: [],
      checks: { x: [samples.map(() => 1)], y: [samples.map(() => 2)], cursor: samples.map(() => 0) },
    },
  };
}

/**
 * `things` is here because a read validates every snapshot's list; the float is what the store's
 * own test is about — a snapshot round-trips exactly rather than through a lossy encoding.
 */
const REPLAY_SNAPSHOT = {
  players: [{ player: { x: 1.000000123456789 } }],
  rng: { p: 0, m: 0 },
  things: { changed: [], lastlook: '' },
} as unknown as GameSnapshot;
