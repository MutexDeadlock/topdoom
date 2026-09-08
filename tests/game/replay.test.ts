import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AIM_QUANTUM, quantizeAim, type TicInput } from '../../src/game/input.ts';
import { ReplayRecorder, type RecordingStart } from '../../src/game/replay/recorder.ts';
import { ReplayPlayback } from '../../src/game/replay/playback.ts';
import {
  CHECK_INTERVAL,
  KEYFRAME_INTERVAL,
  REPLAY_VERSION,
  SPEED_STEPS,
  describeEngine,
  packTics,
  positionFraction,
  quantizePose,
  replaySeconds,
  replayTics,
  speedAt,
  unpackTics,
  ticAtFraction,
  type Replay,
  type SimSettings,
} from '../../src/game/replay/defs.ts';
import { applySimSettings, captureSimSettings, releaseSimSettings } from '../../src/game/replay/settings.ts';
import { getAutorun } from '../../src/game/player.ts';
import { getInfiniteTallActors } from '../../src/game/world.ts';
import { getRightMouseAction } from '../../src/game/input.ts';
import { clearRandom, pRandom } from '../../src/util/random.ts';
import type { GameSnapshot } from '../../src/game/snapshot.ts';
import type { SaveCapture } from '../../src/game/savegames.ts';
import type { CameraPose, TopDownCamera } from '../../src/render/camera.ts';
import type { Pos2 } from '../../src/types.ts';

/**
 * A recording is what the tic read, tic for tic, and a playback serves exactly that back — the
 * property the whole feature rests on. See docs/replays.md § The record.
 */

/** One tic's worth of live input, as a scripted `TicInput` would answer it. */
interface Row {
  held?: string[];
  pressed?: string[];
  typed?: string;
  fire?: boolean;
  right?: boolean;
  wheel?: number;
  aim?: Pos2 | null;
}

function scripted(rows: Row[]): TicInput & { tic: number } {
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

const CAMERA = {} as TopDownCamera;

/** The camera a recording starts at, as `startRecording` hands one over — already snapped. */
const START_POSE: CameraPose = { yaw: 90, point: [64, 41, -128], distance: 480, tilt: 57.5 };
const SNAPSHOT = { player: {}, rng: { p: 0, m: 0 } } as unknown as GameSnapshot;

function start(): RecordingStart {
  const capture = {
    map: 'E1M1',
    skill: 3,
    wads: [{ name: 'DOOM.WAD', id: 'abc' }],
    mapWad: 'abc',
    levelTime: 0,
    thumb: '',
    state: SNAPSHOT,
  } as SaveCapture;
  return {
    capture,
    pose: START_POSE,
    settings: captureSimSettings(),
    devmode: false,
  };
}

/** Every read a tic makes, in one record, from whichever input is in charge. */
function readTic(input: TicInput): Record<string, unknown> {
  return {
    w: input.held('KeyW'),
    wd: input.held('KeyW', 'KeyD'),
    shift: input.held('ShiftLeft'),
    space: input.pressed('Space'),
    r: input.pressed('KeyR'),
    typed: input.typed(),
    fire: input.mouseDown,
    right: input.rightMousePressed(getRightMouseAction()),
    wheel: input.consumeWheel(),
    aim: input.aim(CAMERA, 10),
  };
}

function replayOf(recorder: ReplayRecorder): Replay {
  const capture = recorder.finish();
  // Through JSON, as the store would carry it.
  return JSON.parse(
    JSON.stringify({
      ...capture,
      id: 'r',
      version: REPLAY_VERSION,
      at: '',
      name: 'n',
      description: '',
      player: '',
      build: '',
      engine: '',
    }),
  ) as Replay;
}

describe('Replays · recording and playing back', () => {
  test('a playback answers every read exactly as the live input did', () => {
    const rows: Row[] = [
      { held: ['KeyW'], aim: { x: 100.123, y: -50.5 } },
      { held: ['KeyW', 'KeyD', 'ShiftLeft'], pressed: ['Space'], fire: true, aim: { x: 101, y: -51 } },
      { typed: 'id', wheel: 37.5, right: true, aim: null },
      { pressed: ['KeyR'], wheel: -3, aim: { x: 0, y: 0 } },
      {},
    ];
    const live = scripted(rows);
    const recorder = new ReplayRecorder(live, start());
    const seen: Record<string, unknown>[] = [];
    for (let i = 0; i < rows.length; i++) {
      recorder.beginTic(0, 0, captureSimSettings());
      seen.push(readTic(recorder));
      recorder.endTic();
    }
    assert.equal(recorder.tics, rows.length);

    const playback = new ReplayPlayback(replayOf(recorder));
    const served: Record<string, unknown>[] = [];
    while (playback.hasTic) {
      served.push(readTic(playback));
      playback.endTic();
    }
    assert.deepEqual(served, seen);
    assert.equal(playback.ended, true);
    assert.equal(playback.desyncedAt, null);
  });

  test('the live tic sees the wheel as its sign and the aim quantized, which is what is stored', () => {
    const live = scripted([{ wheel: 37.5, aim: { x: 100.123, y: -50.5 } }]);
    const recorder = new ReplayRecorder(live, start());
    assert.equal(recorder.consumeWheel(), 1);
    const aim = recorder.aim(CAMERA, 0);
    assert.deepEqual(aim, { x: Math.round(100.123 * 64) / 64, y: -50.5 });
    assert.equal(quantizeAim(null), null);
    assert.equal(AIM_QUANTUM, 1 / 64);
  });

  test('a settings change is an event on the tic it is first in force for', () => {
    const live = scripted([{}, {}, {}]);
    const recorder = new ReplayRecorder(live, start());
    const changed: SimSettings = { ...captureSimSettings(), autorun: !getAutorun() };
    recorder.beginTic(0, 0, captureSimSettings());
    recorder.endTic();
    recorder.beginTic(0, 0, changed);
    recorder.endTic();
    recorder.beginTic(0, 0, changed);
    recorder.endTic();
    const replay = replayOf(recorder);
    assert.deepEqual(replay.data.events, [{ tic: 1, kind: 'settings', settings: changed }]);

    const playback = new ReplayPlayback(replay);
    assert.deepEqual(playback.eventsAt(0), []);
    assert.equal(playback.settings.autorun, getAutorun(), 'tic 0 runs on the start settings');
    playback.endTic();
    assert.equal(playback.eventsAt(1).length, 1);
    assert.equal(playback.settings.autorun, changed.autorun);
  });

  test('a restore is stamped for the tic that follows it, and a snapshot is stored once', () => {
    const live = scripted([{}, {}, {}]);
    const recorder = new ReplayRecorder(live, start());
    const other = { player: {}, rng: { p: 5, m: 0 } } as unknown as GameSnapshot;
    recorder.beginTic(0, 0, captureSimSettings());
    recorder.endTic();
    recorder.restore('E1M1', other);
    recorder.beginTic(0, 0, captureSimSettings());
    recorder.endTic();
    recorder.restore('E1M1', other);
    recorder.restore('E1M1', null);
    const replay = replayOf(recorder);
    assert.deepEqual(replay.data.events, [
      { tic: 1, kind: 'restore', map: 'E1M1', snapshot: 1 },
      { tic: 2, kind: 'restore', map: 'E1M1', snapshot: 1 },
      { tic: 2, kind: 'restore', map: 'E1M1', snapshot: null },
    ]);
    assert.equal(replay.data.snapshots.length, 2);
    assert.deepEqual(replay.levels, [{ tic: 0, map: 'E1M1' }], 'a restart adds no level marker');
    recorder.levelLoaded('E1M2');
  });

  test('a level marker is added once per new map', () => {
    const recorder = new ReplayRecorder(scripted([{}]), start());
    recorder.levelLoaded('E1M1');
    recorder.endTic();
    recorder.levelLoaded('E1M2');
    recorder.levelLoaded('E1M2');
    assert.deepEqual(recorder.finish().levels, [
      { tic: 0, map: 'E1M1' },
      { tic: 1, map: 'E1M2' },
    ]);
  });

  test('the camera the tic ran at is recorded and served back, snapped to the lattice', () => {
    const recorder = new ReplayRecorder(scripted([{}, {}]), start());
    const pose = quantizePose({ yaw: 91.3333, point: [64.51, 41, -128.02], distance: 500.4, tilt: 57.77 });
    recorder.beginTic(0, 0, captureSimSettings(), pose);
    recorder.endTic();
    // A tic told nothing keeps the last camera, which is what a recording that starts mid-glide
    // has.
    recorder.endTic();
    const playback = new ReplayPlayback(replayOf(recorder));
    assert.deepEqual(playback.poseAt(0), pose, 'through JSON, exactly the pose the tic ran at');
    assert.deepEqual(playback.poseAt(1), pose);
    assert.equal(playback.poseAt(2), null, 'past the end of the stream');
  });

  test('a keyframe is due once an interval has passed, and only then', () => {
    const recorder = new ReplayRecorder(scripted([]), start());
    assert.equal(recorder.keyframeDue, false, 'the start is keyframe 0 already');
    for (let i = 0; i < KEYFRAME_INTERVAL - 1; i++) recorder.endTic();
    assert.equal(recorder.keyframeDue, false);
    recorder.endTic();
    assert.equal(recorder.keyframeDue, true);
    // A refused moment leaves it due: the anchor waits rather than being skipped.
    recorder.endTic();
    assert.equal(recorder.keyframeDue, true);
    const state = { player: {}, rng: { p: 1, m: 0 } } as unknown as GameSnapshot;
    recorder.keyframe('E1M2', state);
    assert.equal(recorder.keyframeDue, false);
    const { data } = recorder.finish();
    assert.deepEqual(
      data.keyframes,
      [
        { tic: 0, map: 'E1M1', snapshot: 0 },
        { tic: KEYFRAME_INTERVAL + 1, map: 'E1M2', snapshot: 1 },
      ],
    );
  });

  test('a seek re-seats the settings and the check cursor, forwards and back', () => {
    const rows: Row[] = Array.from({ length: CHECK_INTERVAL * 2 + 1 }, () => ({}));
    const recorder = new ReplayRecorder(scripted(rows), start());
    const changed: SimSettings = { ...captureSimSettings(), autorun: !captureSimSettings().autorun };
    for (let tic = 0; tic < rows.length; tic++) {
      recorder.beginTic(tic, 0, tic < CHECK_INTERVAL ? captureSimSettings() : changed);
      recorder.endTic();
    }
    const playback = new ReplayPlayback(replayOf(recorder));
    const settled = playback.replay.data.settings;
    playback.seek(CHECK_INTERVAL * 2);
    assert.deepEqual(playback.settings, changed, 'the last settings event before the target is in force');
    assert.equal(playback.ended, false);
    // The sample at that tic is still ahead, so the check still lands.
    playback.check(CHECK_INTERVAL * 2, 0);
    assert.equal(playback.desyncedAt, null);
    playback.seek(0);
    assert.deepEqual(playback.settings, settled, 'a jump back drops the events it had passed');
    playback.check(999, 0);
    assert.equal(playback.desyncedAt, 0, 'the sample at tic 0 is served again, not skipped');
  });

  test('a jump lands on the last keyframe at or before it', () => {
    const recorder = new ReplayRecorder(scripted([]), start());
    const state = { player: {}, rng: { p: 1, m: 0 } } as unknown as GameSnapshot;
    for (let i = 0; i < KEYFRAME_INTERVAL; i++) recorder.endTic();
    recorder.keyframe('E1M1', state);
    const playback = new ReplayPlayback(replayOf(recorder));
    assert.equal(playback.keyframeAt(0).tic, 0);
    assert.equal(playback.keyframeAt(KEYFRAME_INTERVAL - 1).tic, 0);
    assert.equal(playback.keyframeAt(KEYFRAME_INTERVAL).tic, KEYFRAME_INTERVAL);
    assert.equal(playback.keyframeAt(KEYFRAME_INTERVAL * 9).tic, KEYFRAME_INTERVAL);
  });

  test('a level entered anchors a jump at its own first tic', () => {
    const recorder = new ReplayRecorder(scripted([]), start());
    const state = { player: {}, rng: { p: 1, m: 0 } } as unknown as GameSnapshot;
    for (let i = 0; i < 100; i++) recorder.endTic();
    // `Game.runEnterLevel`'s order: the track marker, then the anchor at the same tic.
    recorder.levelLoaded('E1M2');
    recorder.keyframe('E1M2', state);
    const playback = new ReplayPlayback(replayOf(recorder));
    const marker = playback.replay.levels[1];
    assert.equal(marker.tic, 100);
    assert.equal(playback.keyframeAt(marker.tic).tic, marker.tic, 'a jump to the marker lands on the level');
    assert.equal(playback.keyframeAt(marker.tic).map, 'E1M2');
    // And the interval measures from it, not from the last anchor before the level.
    for (let i = 0; i < KEYFRAME_INTERVAL - 1; i++) recorder.endTic();
    assert.equal(recorder.keyframeDue, false);
    recorder.endTic();
    assert.equal(recorder.keyframeDue, true);
  });

  test('the check samples catch a divergence at the first sample that disagrees', () => {
    clearRandom();
    const rows: Row[] = Array.from({ length: CHECK_INTERVAL * 2 + 1 }, () => ({}));
    const recorder = new ReplayRecorder(scripted(rows), start());
    for (let i = 0; i < rows.length; i++) {
      recorder.beginTic(i, 0, captureSimSettings());
      recorder.endTic();
    }
    const replay = replayOf(recorder);
    assert.equal(replay.data.checks.length, 3);

    clearRandom();
    const playback = new ReplayPlayback(replay);
    for (let i = 0; i < rows.length; i++) {
      playback.check(i, 0);
      playback.endTic();
    }
    assert.equal(playback.desyncedAt, null, 'the same run matches');

    clearRandom();
    const diverged = new ReplayPlayback(replay);
    for (let i = 0; i < rows.length; i++) {
      // A stray draw after the first sample shifts the cursor for the second.
      if (i === 1) pRandom();
      diverged.check(i, 0);
      diverged.endTic();
    }
    assert.equal(diverged.desyncedAt, CHECK_INTERVAL);
  });

  test('the settings pins take effect without storage and come off again', () => {
    const before = captureSimSettings();
    const pinned: SimSettings = {
      ...before,
      autorun: !before.autorun,
      infiniteTallActors: !before.infiniteTallActors,
      rightMouse: before.rightMouse === 'use' ? 'none' : 'use',
    };
    applySimSettings(pinned);
    assert.equal(getAutorun(), pinned.autorun);
    assert.equal(getInfiniteTallActors(), pinned.infiniteTallActors);
    assert.equal(getRightMouseAction(), pinned.rightMouse);
    assert.deepEqual(captureSimSettings(), pinned);
    releaseSimSettings();
    assert.deepEqual(captureSimSettings(), before);
  });
});

describe('Replays · the pure helpers', () => {
  test('the stored columns are differences, and come back the values they were', () => {
    const tics = {
      held: [1, 2, 3],
      pressed: [0, 0, 0],
      buttons: [0, 0, 0],
      wheel: [0, 0, 0],
      aimX: [6400, 6410, null],
      aimY: [-100, -90, null],
      poseYaw: [5760, 5766, 5771],
      poseX: [4096, 4090, 4081],
      poseY: [2624, 2624, 2624],
      poseZ: [-8192, -8190, -8187],
      poseDistance: [30720, 30700, 30680],
      poseTilt: [3680, 3681, 3682],
    };
    const packed = packTics(tics);
    assert.deepEqual(packed.poseYaw, [5760, 6, 5], 'the first value, then the steps');
    assert.deepEqual(packed.aimX, [6400, 10, null], 'a tic with no aim point carries no difference');
    assert.deepEqual(packed.held, tics.held, 'the mask columns are left alone');
    assert.deepEqual(unpackTics(packed), tics);
  });

  test('speedAt clamps into the table and positionFraction into 0..1', () => {
    assert.equal(speedAt(-3), SPEED_STEPS[0]);
    assert.equal(speedAt(3), 1);
    assert.equal(speedAt(99), SPEED_STEPS[SPEED_STEPS.length - 1]);
    assert.equal(positionFraction(0, 100), 0);
    assert.equal(positionFraction(50, 100), 0.5);
    assert.equal(positionFraction(500, 100), 1);
    assert.equal(positionFraction(0, 0), 1, 'an empty stream reads as finished');
    assert.equal(ticAtFraction(-0.5, 700), 0);
    assert.equal(ticAtFraction(0.5, 700), 350);
    assert.equal(ticAtFraction(2, 700), 700);
    assert.equal(replayTics(5), 175, "the arrow keys' skip in tics");
    assert.equal(replaySeconds(replayTics(12)), 12);
  });

  test('describeEngine names the engine behind a user agent', () => {
    const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const edge = `${chrome} Edg/128.0.0.0`;
    assert.equal(describeEngine(chrome), 'V8 · Chrome 128');
    assert.equal(describeEngine(firefox), 'SpiderMonkey · Firefox 130');
    assert.equal(describeEngine(safari), 'JavaScriptCore · Safari 18');
    assert.equal(describeEngine(edge), 'V8 · Edge 128');
    assert.equal(describeEngine('curl/8'), 'unknown');
  });
});
