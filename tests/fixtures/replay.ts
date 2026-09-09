import type { GameSnapshot } from '../../src/game/snapshot.ts';
import { CHECK_INTERVAL, type ReplayCapture } from '../../src/game/replay.ts';

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
      settings: {
        autorun: true,
        autoSwitchWeapon: true,
        rightMouse: 'use',
        cameraMode: 'auto',
        infiniteTallActors: false,
        pistolStart: false,
      },
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
      events: [],
      checks: { x: samples.map(() => 1), y: samples.map(() => 2), cursor: samples.map(() => 0) },
    },
  };
}

/**
 * `things` is here because a read validates every snapshot's list; the float is what the store's
 * own test is about — a snapshot round-trips exactly rather than through a lossy encoding.
 */
const REPLAY_SNAPSHOT = {
  player: { x: 1.000000123456789 },
  rng: { p: 0, m: 0 },
  things: { changed: [] },
} as unknown as GameSnapshot;
