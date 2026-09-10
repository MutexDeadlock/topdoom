import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AIM_QUANTUM, quantizeAim, type TicInput } from '../../src/game/input.ts';
import { ReplayRecorder } from '../../src/game/replay/recorder.ts';
import { ReplayPlayback } from '../../src/game/replay/playback.ts';
import {
  CHECK_INTERVAL,
  KEYFRAME_INTERVAL,
  REPLAY_VERSION,
  SPEED_STEPS,
  checkTic,
  describeEngine,
  packTics,
  positionFraction,
  quantizePose,
  replaySeconds,
  replayTics,
  speedAt,
  unpackTics,
  ticAtFraction,
  type PlayerSettings,
  type Replay,
  type SimSettings,
} from '../../src/game/replay/defs.ts';
import { applySimSettings, captureSimSettings, releaseSimSettings } from '../../src/game/replay/settings.ts';
import { getAutorun } from '../../src/game/player.ts';
import { getInfiniteTallActors } from '../../src/game/world.ts';
import { getRightMouseAction } from '../../src/game/input.ts';
import { clearRandom, pRandom } from '../../src/util/random.ts';
import type { GameSnapshot } from '../../src/game/snapshot.ts';
import {
  NO_CAMERA,
  START_POSE,
  beginTic,
  recordingStart,
  scriptedInput,
  splitSettings,
  type ScriptedRow,
} from '../fixtures/replay.ts';

/**
 * A recording is what the tic read, tic for tic, and a playback serves exactly that back — the
 * property the whole feature rests on. See docs/replays.md § The record.
 */

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
    aim: input.aim(NO_CAMERA, 10),
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
    const rows: ScriptedRow[] = [
      { held: ['KeyW'], aim: { x: 100.123, y: -50.5 } },
      { held: ['KeyW', 'KeyD', 'ShiftLeft'], pressed: ['Space'], fire: true, aim: { x: 101, y: -51 } },
      { typed: 'id', wheel: 37.5, right: true, aim: null },
      { pressed: ['KeyR'], wheel: -3, aim: { x: 0, y: 0 } },
      {},
    ];
    const recorder = new ReplayRecorder([scriptedInput(rows)], recordingStart());
    const input = recorder.input(0);
    const seen: Record<string, unknown>[] = [];
    for (let i = 0; i < rows.length; i++) {
      beginTic(recorder, 0, 0);
      seen.push(readTic(input));
      input.endTic();
    }
    assert.equal(recorder.tics, rows.length);

    const playback = new ReplayPlayback(replayOf(recorder));
    const served: Record<string, unknown>[] = [];
    while (playback.hasTic) {
      served.push(readTic(playback.input(0)));
      playback.endTic();
    }
    assert.deepEqual(served, seen);
    assert.equal(playback.ended, true);
    assert.equal(playback.desyncedAt, null);
  });

  test('every slot is recorded and served back its own reads, settings and checks', () => {
    clearRandom();
    const start = recordingStart();
    const [mine] = start.players;
    const theirs: PlayerSettings = { ...mine, autorun: !mine.autorun };
    const recorder = new ReplayRecorder(
      [
        scriptedInput([{ held: ['KeyW'] }, { pressed: ['Space'] }]),
        scriptedInput([{ held: ['KeyS'], aim: { x: 5, y: 6 } }, { typed: 'x', fire: true }]),
      ],
      { ...start, poses: [START_POSE, START_POSE], players: [mine, theirs] },
    );
    const seen: Record<string, unknown>[][] = [[], []];
    for (let tic = 0; tic < 2; tic++) {
      // Slot 1's settings go back to slot 0's from the second tic.
      recorder.beginTic(
        [
          { x: 1, y: 2 },
          { x: 30, y: 40 },
        ],
        [mine, tic === 0 ? theirs : mine],
        start.session,
      );
      for (const slot of [0, 1]) seen[slot].push(readTic(recorder.input(slot)));
      for (const slot of [0, 1]) recorder.input(slot).endTic();
    }
    const replay = replayOf(recorder);
    assert.deepEqual(replay.data.events, [{ tic: 1, kind: 'settings', slot: 1, settings: mine }]);
    assert.deepEqual(replay.data.checks, { x: [[1], [30]], y: [[2], [40]], cursor: [0] });

    const playback = new ReplayPlayback(replay);
    assert.equal(playback.slotSettings[1].autorun, theirs.autorun);
    const served: Record<string, unknown>[][] = [[], []];
    while (playback.hasTic) {
      playback.eventsAt(playback.cursor);
      for (const slot of [0, 1]) served[slot].push(readTic(playback.input(slot)));
      playback.endTic();
    }
    assert.deepEqual(served, seen);
    assert.equal(playback.slotSettings[1].autorun, mine.autorun, 'the event moved slot 1 alone');

    const drifted = new ReplayPlayback(replay);
    drifted.check([
      { x: 1, y: 2 },
      { x: 31, y: 40 },
    ]);
    assert.equal(drifted.desyncedAt, 0, "a second slot's drift is a desync too");
  });

  test('the live tic sees the wheel as its sign and the aim quantized, which is what is stored', () => {
    const live = scriptedInput([{ wheel: 37.5, aim: { x: 100.123, y: -50.5 } }]);
    const input = new ReplayRecorder([live], recordingStart()).input(0);
    assert.equal(input.consumeWheel(), 1);
    const aim = input.aim(NO_CAMERA, 0);
    assert.deepEqual(aim, { x: Math.round(100.123 * 64) / 64, y: -50.5 });
    assert.equal(quantizeAim(null), null);
    assert.equal(AIM_QUANTUM, 1 / 64);
  });

  test('a settings change is an event on the tic it is first in force for', () => {
    const recorder = new ReplayRecorder([scriptedInput([{}, {}, {}])], recordingStart());
    const input = recorder.input(0);
    const changed: SimSettings = { ...captureSimSettings(), autorun: !getAutorun() };
    beginTic(recorder, 0, 0);
    input.endTic();
    beginTic(recorder, 0, 0, changed);
    input.endTic();
    beginTic(recorder, 0, 0, changed);
    input.endTic();
    const replay = replayOf(recorder);
    assert.deepEqual(replay.data.events, [{ tic: 1, kind: 'settings', slot: 0, settings: splitSettings(changed).player }]);

    const playback = new ReplayPlayback(replay);
    assert.deepEqual(playback.eventsAt(0), []);
    assert.equal(playback.settings.autorun, getAutorun(), 'tic 0 runs on the start settings');
    playback.endTic();
    assert.equal(playback.eventsAt(1).length, 1);
    assert.equal(playback.settings.autorun, changed.autorun);
  });

  test("a session change is an event of its own, whichever slot's menu made it", () => {
    const recorder = new ReplayRecorder([scriptedInput([{}, {}])], recordingStart());
    const input = recorder.input(0);
    const changed: SimSettings = { ...captureSimSettings(), pistolStart: !captureSimSettings().pistolStart };
    beginTic(recorder, 0, 0);
    input.endTic();
    beginTic(recorder, 0, 0, changed);
    input.endTic();
    const replay = replayOf(recorder);
    const session = { infiniteTallActors: changed.infiniteTallActors, pistolStart: changed.pistolStart };
    assert.deepEqual(replay.data.events, [{ tic: 1, kind: 'session', settings: session }]);

    const playback = new ReplayPlayback(replay);
    playback.endTic();
    playback.eventsAt(1);
    assert.equal(playback.settings.pistolStart, changed.pistolStart);
  });

  test('a restore is stamped for the tic that follows it, and a snapshot is stored once', () => {
    const recorder = new ReplayRecorder([scriptedInput([{}, {}, {}])], recordingStart());
    const input = recorder.input(0);
    const other = { players: [{ player: {} }], rng: { p: 5, m: 0 } } as unknown as GameSnapshot;
    beginTic(recorder, 0, 0);
    input.endTic();
    recorder.restore('E1M1', other);
    beginTic(recorder, 0, 0);
    input.endTic();
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
    const recorder = new ReplayRecorder([scriptedInput([{}])], recordingStart());
    recorder.levelLoaded('E1M1');
    recorder.input(0).endTic();
    recorder.levelLoaded('E1M2');
    recorder.levelLoaded('E1M2');
    assert.deepEqual(recorder.finish().levels, [
      { tic: 0, map: 'E1M1' },
      { tic: 1, map: 'E1M2' },
    ]);
  });

  test('the camera the tic ran at is recorded and served back, snapped to the lattice', () => {
    const recorder = new ReplayRecorder([scriptedInput([{}, {}])], recordingStart());
    const input = recorder.input(0);
    const pose = quantizePose({ yaw: 91.3333, point: [64.51, 41, -128.02], distance: 500.4, tilt: 57.77 });
    beginTic(recorder, 0, 0, captureSimSettings(), pose);
    input.endTic();
    // A tic told nothing keeps the last camera, which is what a recording that starts mid-glide
    // has.
    input.endTic();
    const playback = new ReplayPlayback(replayOf(recorder));
    assert.deepEqual(playback.poseAt(0), pose, 'through JSON, exactly the pose the tic ran at');
    assert.deepEqual(playback.poseAt(1), pose);
    assert.equal(playback.poseAt(2), null, 'past the end of the stream');
  });

  test('a keyframe is due once an interval has passed, and only then', () => {
    const recorder = new ReplayRecorder([scriptedInput([])], recordingStart());
    const input = recorder.input(0);
    assert.equal(recorder.keyframeDue, false, 'the start is keyframe 0 already');
    for (let i = 0; i < KEYFRAME_INTERVAL - 1; i++) input.endTic();
    assert.equal(recorder.keyframeDue, false);
    input.endTic();
    assert.equal(recorder.keyframeDue, true);
    // A refused moment leaves it due: the anchor waits rather than being skipped.
    input.endTic();
    assert.equal(recorder.keyframeDue, true);
    const state = { players: [{ player: {} }], rng: { p: 1, m: 0 } } as unknown as GameSnapshot;
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
    const rows: ScriptedRow[] = Array.from({ length: CHECK_INTERVAL * 2 + 1 }, () => ({}));
    const recorder = new ReplayRecorder([scriptedInput(rows)], recordingStart());
    const input = recorder.input(0);
    const changed: SimSettings = { ...captureSimSettings(), autorun: !captureSimSettings().autorun };
    for (let tic = 0; tic < rows.length; tic++) {
      beginTic(recorder, tic, 0, tic < CHECK_INTERVAL ? captureSimSettings() : changed);
      input.endTic();
    }
    const playback = new ReplayPlayback(replayOf(recorder));
    const settled = { ...playback.settings };
    playback.seek(CHECK_INTERVAL * 2);
    assert.deepEqual(playback.settings, changed, 'the last settings event before the target is in force');
    assert.equal(playback.ended, false);
    // The sample at that tic is still ahead, so the check still lands.
    playback.check([{ x: CHECK_INTERVAL * 2, y: 0 }]);
    assert.equal(playback.desyncedAt, null);
    playback.seek(0);
    assert.deepEqual(playback.settings, settled, 'a jump back drops the events it had passed');
    playback.check([{ x: 999, y: 0 }]);
    assert.equal(playback.desyncedAt, 0, 'the sample at tic 0 is served again, not skipped');
  });

  test('a jump lands on the last keyframe at or before it', () => {
    const recorder = new ReplayRecorder([scriptedInput([])], recordingStart());
    const state = { players: [{ player: {} }], rng: { p: 1, m: 0 } } as unknown as GameSnapshot;
    for (let i = 0; i < KEYFRAME_INTERVAL; i++) recorder.input(0).endTic();
    recorder.keyframe('E1M1', state);
    const playback = new ReplayPlayback(replayOf(recorder));
    assert.equal(playback.keyframeAt(0).tic, 0);
    assert.equal(playback.keyframeAt(KEYFRAME_INTERVAL - 1).tic, 0);
    assert.equal(playback.keyframeAt(KEYFRAME_INTERVAL).tic, KEYFRAME_INTERVAL);
    assert.equal(playback.keyframeAt(KEYFRAME_INTERVAL * 9).tic, KEYFRAME_INTERVAL);
  });

  test('a level entered anchors a jump at its own first tic', () => {
    const recorder = new ReplayRecorder([scriptedInput([])], recordingStart());
    const input = recorder.input(0);
    const state = { players: [{ player: {} }], rng: { p: 1, m: 0 } } as unknown as GameSnapshot;
    for (let i = 0; i < 100; i++) input.endTic();
    // `Game.runEnterLevel`'s order: the track marker, then the anchor at the same tic.
    recorder.levelLoaded('E1M2');
    recorder.keyframe('E1M2', state);
    const playback = new ReplayPlayback(replayOf(recorder));
    const marker = playback.replay.levels[1];
    assert.equal(marker.tic, 100);
    assert.equal(playback.keyframeAt(marker.tic).tic, marker.tic, 'a jump to the marker lands on the level');
    assert.equal(playback.keyframeAt(marker.tic).map, 'E1M2');
    // And the interval measures from it, not from the last anchor before the level.
    for (let i = 0; i < KEYFRAME_INTERVAL - 1; i++) input.endTic();
    assert.equal(recorder.keyframeDue, false);
    input.endTic();
    assert.equal(recorder.keyframeDue, true);
  });

  test('the check samples catch a divergence at the first sample that disagrees', () => {
    clearRandom();
    const rows: ScriptedRow[] = Array.from({ length: CHECK_INTERVAL * 2 + 1 }, () => ({}));
    const recorder = new ReplayRecorder([scriptedInput(rows)], recordingStart());
    for (let i = 0; i < rows.length; i++) {
      beginTic(recorder, i, 0);
      recorder.input(0).endTic();
    }
    const replay = replayOf(recorder);
    assert.equal(replay.data.checks.cursor.length, 3);

    clearRandom();
    const playback = new ReplayPlayback(replay);
    for (let i = 0; i < rows.length; i++) {
      playback.check([{ x: i, y: 0 }]);
      playback.endTic();
    }
    assert.equal(playback.desyncedAt, null, 'the same run matches');

    clearRandom();
    const diverged = new ReplayPlayback(replay);
    for (let i = 0; i < rows.length; i++) {
      // A stray draw after the first sample shifts the cursor for the second.
      if (i === 1) pRandom();
      diverged.check([{ x: i, y: 0 }]);
      diverged.endTic();
    }
    assert.equal(diverged.desyncedAt, CHECK_INTERVAL);
  });

  test('a check sample is indexed by its tic, and the position compares rounded', () => {
    clearRandom();
    const rows: ScriptedRow[] = Array.from({ length: CHECK_INTERVAL * 2 + 1 }, () => ({}));
    const recorder = new ReplayRecorder([scriptedInput(rows)], recordingStart());
    // `beginTic` is handed the tic number as the x coordinate, so a sample's x is the tic it
    // was taken at — which is what says no tic column is needed to find it again.
    for (let i = 0; i < rows.length; i++) {
      beginTic(recorder, i, 0);
      recorder.input(0).endTic();
    }
    const replay = replayOf(recorder);
    assert.deepEqual(replay.data.checks.x, [[checkTic(0), checkTic(1), checkTic(2)]]);

    // Under half a unit rounds onto the sample and passes; over it does not.
    clearRandom();
    const near = new ReplayPlayback(replay);
    for (let i = 0; i < rows.length; i++) {
      near.check([{ x: i + 0.4, y: -0.4 }]);
      near.endTic();
    }
    assert.equal(near.desyncedAt, null, 'a drift below half a unit is not a desync');

    clearRandom();
    const far = new ReplayPlayback(replay);
    for (let i = 0; i < rows.length; i++) {
      far.check([{ x: i + 0.6, y: 0 }]);
      far.endTic();
    }
    assert.equal(far.desyncedAt, 0, 'a drift over half a unit is caught at the first sample');
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
  test('the stored columns are second differences, and come back the values they were', () => {
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
    assert.deepEqual(packed.poseTilt, [3680, -3679, 0], 'a column climbing at a constant rate stores a zero');
    assert.deepEqual(packed.poseYaw, [5760, -5754, -1], 'each value against the two before it');
    assert.deepEqual(packed.aimX, [6400, -6390, null], 'a tic with no aim point carries no value');
    assert.deepEqual(packed.held, tics.held, 'the mask columns are left alone');
    assert.deepEqual(unpackTics(packed), tics);

    // A gap mid-column leaves the prediction where it was, so the value after it is predicted from
    // the two present values before — not from the gap.
    const gapped = { ...tics, aimX: [6400, null, 6410], aimY: [-100, null, -90] };
    assert.deepEqual(packTics(gapped).aimX, [6400, null, -6390]);
    assert.deepEqual(unpackTics(packTics(gapped)), gapped);
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
