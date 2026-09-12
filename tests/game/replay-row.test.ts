import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AIM_QUANTUM, getRightMouseAction } from '../../src/game/input.ts';
import { ReplayRecorder } from '../../src/game/replay/recorder.ts';
import { ReplayPlayback } from '../../src/game/replay/playback.ts';
import { RowInput, appendRow, emptyColumns, emptyRow, readRow, type TicRow } from '../../src/game/replay/row.ts';
import { captureSimSettings } from '../../src/game/replay/settings.ts';
import { BUTTON_FIRE, BUTTON_RIGHT_EDGE, type Replay } from '../../src/game/replay/defs.ts';
import type { GameSnapshot } from '../../src/game/snapshot.ts';
import type { CameraPose } from '../../src/render/camera.ts';
import type { PlayerColor } from '../../src/wad/playercolor.ts';
import {
  NO_CAMERA,
  START_POSE,
  START_SNAPSHOT,
  beginTic,
  recordingStart,
  replayCapture,
  scriptedInput,
  type ScriptedRow,
} from '../fixtures/replay.ts';

/**
 * The row codec every per-tic input goes through — the recorder writing a row, the playback
 * reading one back. docs/replays.md § The record.
 */

/** Bits of `BOUND_KEYS`: `KeyW` is 0, `KeyD` 3, `Space` 12. */
const KEY_W = 1 << 0;
const KEY_D = 1 << 3;
const SPACE = 1 << 12;

describe('Replays · the row codec', () => {
  test('a row appended and read back is that row, typed characters and a missed aim included', () => {
    const rows: TicRow[] = [
      {
        held: KEY_W | KEY_D,
        pressed: SPACE,
        buttons: BUTTON_FIRE | BUTTON_RIGHT_EDGE,
        wheel: -1,
        aimX: 640,
        aimY: -17,
        poseYaw: 5760,
        poseX: 1,
        poseY: -2,
        poseZ: 3,
        poseDistance: 30720,
        poseTilt: 3680,
        typed: 'idkfa',
      },
      { ...emptyRow(), held: 1 << 29 },
    ];
    const tics = emptyColumns();
    const typed: [number, string][] = [];
    for (const row of rows) appendRow(tics, typed, row);
    assert.deepEqual(typed, [[0, 'idkfa']], 'only a tic that typed something is stored');
    const typedAt = new Map(typed);
    rows.forEach((row, tic) => {
      const back = { ...emptyRow(), typed: 'stale' };
      readRow(tics, typedAt, tic, back);
      assert.deepEqual(back, row);
    });
  });

  test('past the end of the stream a read is an idle row', () => {
    const tics = emptyColumns();
    appendRow(tics, [], { ...emptyRow(), held: KEY_W, aimX: 1, aimY: 1 });
    const back = { ...emptyRow(), held: KEY_D, typed: 'x' };
    readRow(tics, new Map(), 1, back);
    assert.deepEqual(back, emptyRow());
  });

  test('a row input answers every read from its row, the right button under its own binding', () => {
    const input = new RowInput({ rightMouse: 'use' });
    Object.assign(input.row, {
      held: KEY_W | KEY_D,
      pressed: SPACE,
      buttons: BUTTON_FIRE | BUTTON_RIGHT_EDGE,
      wheel: 1,
      aimX: 640,
      aimY: -64,
      typed: 'iddqd',
    });
    assert.equal(input.held('KeyW'), true);
    assert.equal(input.held('KeyA', 'KeyD'), true);
    assert.equal(input.held('KeyS'), false);
    assert.equal(input.pressed('Space'), true);
    assert.equal(input.pressed('KeyW'), false);
    assert.equal(input.mouseDown, true);
    // The stored binding is `previousweapon` in a fresh profile; the row's slot binds `use`.
    assert.equal(getRightMouseAction(), 'previousweapon');
    assert.equal(input.rightMousePressed('use'), true);
    assert.equal(input.rightMousePressed('previousweapon'), false);
    assert.equal(input.consumeWheel(), 1);
    assert.deepEqual(input.aim(NO_CAMERA, 0), { x: 640 * AIM_QUANTUM, y: -64 * AIM_QUANTUM });
    assert.equal(input.typed(), 'iddqd');

    input.row.aimX = null;
    assert.equal(input.aim(NO_CAMERA, 0), null, 'a tic that aimed nowhere');
  });

  test('a playback answers the right button under its own settings, and moves with their events', () => {
    const capture = replayCapture(3);
    const [record] = capture.data.slots;
    record.tics.buttons = [BUTTON_RIGHT_EDGE, BUTTON_RIGHT_EDGE, BUTTON_RIGHT_EDGE];
    record.typed = [[0, 'iddqd']];
    capture.data.events = [{ tic: 2, kind: 'settings', slot: 0, settings: { ...record.settings, rightMouse: 'none' } }];
    const playback = new ReplayPlayback(capture as Replay);
    const input = playback.input(0);
    assert.equal(input.rightMousePressed('use'), true, 'recorded under `use`, stored `previousweapon`');
    assert.equal(input.typed(), 'iddqd');
    playback.endTic();
    playback.endTic();
    playback.eventsAt(2);
    assert.equal(input.rightMousePressed('use'), false);
    assert.equal(input.rightMousePressed('none'), true);
  });

  test("a slot's colour is written only where it is not its default, and read back with the default", () => {
    const record = (colors: PlayerColor[]) => {
      const recorder = new ReplayRecorder([scriptedInput([{}])], { ...recordingStart(), colors });
      beginTic(recorder, 0, 0, captureSimSettings());
      recorder.input(0).endTic();
      return recorder.finish();
    };
    assert.equal(record(['red']).data.slots[0].color, 'red');
    assert.ok(!('color' in record(['green']).data.slots[0]), "player 1's own green is left out");
    assert.deepEqual(new ReplayPlayback(record(['red']) as Replay).slotColors, ['red']);
    assert.deepEqual(new ReplayPlayback(replayCapture(1) as Replay).slotColors, ['green'], 'a record with none');
  });

  test("a slot's name is written only where one is known, and read back as the number where none is", () => {
    const recorder = new ReplayRecorder([scriptedInput([{}]), scriptedInput([{}])], {
      ...recordingStart(),
      poses: [START_POSE, START_POSE],
      players: [...recordingStart().players, ...recordingStart().players],
      colors: ['green', 'red'],
      names: [null, 'Bob'],
    });
    const capture = recorder.finish();
    assert.ok(!('name' in capture.data.slots[0]), 'no name for a slot nobody named');
    assert.equal(capture.data.slots[1].name, 'Bob');
    const playback = new ReplayPlayback({ ...capture, player: 'Fauler' } as Replay);
    assert.deepEqual(playback.slotNames, ['Player 1', 'Bob'], "the replay's credit names no slot");
  });

  test('the recorder writes, byte for byte, the one-player record reshaped as one slot', () => {
    const other = { players: [{ player: { x: 1 } }], rng: { p: 5, m: 0 } } as unknown as GameSnapshot;
    const recorder = new ReplayRecorder([scriptedInput(ORACLE_ROWS)], recordingStart());
    const input = recorder.input(0);
    for (let i = 0; i < ORACLE_ROWS.length; i++) {
      const settings = captureSimSettings();
      if (i >= 4) settings.autorun = !settings.autorun;
      beginTic(recorder, 10.4 + i, -3.6 - i, settings, ORACLE_POSES[i % ORACLE_POSES.length]);
      if (i === 2) recorder.restore('E1M1', other);
      if (i === 3) recorder.levelLoaded('E1M2');
      if (i === 5) recorder.restore('E1M2', other);
      if (i === 6) recorder.keyframe('E1M2', START_SNAPSHOT);
      const row = ORACLE_ROWS[i];
      if (row.readAim) input.aim(NO_CAMERA, 0);
      if (row.readWheel) input.consumeWheel();
      input.endTic();
    }
    assert.equal(JSON.stringify(recorder.finish()), ORACLE);
  });
});

/** One scripted tic of the oracle run, and which of the two once-a-tic reads it makes. */
interface OracleRow extends ScriptedRow {
  readAim?: boolean;
  readWheel?: boolean;
}

const ORACLE_ROWS: OracleRow[] = [
  { held: ['KeyW'], aim: { x: 100.123, y: -50.5 }, readAim: true },
  { held: ['KeyW', 'KeyD', 'ShiftLeft'], pressed: ['Space'], fire: true, aim: { x: 101, y: -51 }, readAim: true },
  { typed: 'id', wheel: 37.5, right: true, aim: null, readAim: true, readWheel: true },
  { pressed: ['KeyR', 'Digit3'], wheel: -3, aim: { x: 0, y: 0 }, readWheel: true },
  { held: ['BracketRight', 'ArrowLeft'], fire: true, right: true },
  {},
  { typed: 'dqd', held: ['KeyQ'], aim: { x: -7.77, y: 3.01 }, readAim: true },
];

const ORACLE_POSES: CameraPose[] = [
  START_POSE,
  { yaw: 90.015625, point: [64.5, 41.25, -128], distance: 481, tilt: 57.5 },
  { yaw: 135, point: [-3.140625, 0, 12], distance: 350, tilt: 50 },
];

/**
 * `ReplayRecorder.finish()` over the run above: what the recorder wrote before `replay/row.ts`,
 * moved into one slot's record — the columns, the typed tics and the settings as they were, the
 * session's half beside them, the check positions per slot — and nothing else changed.
 */
const ORACLE =
  '{"skill":3,"wads":[{"name":"DOOM.WAD","id":"abc"}],"mapWad":"abc","ticCount":7,"levels":[{"tic":0,"map":"E1M1"' +
  '},{"tic":3,"map":"E1M2"}],"data":{"snapshots":[{"players":[{"player":{}}],"rng":{"p":0,"m":0}},{"players":[{"p' +
  'layer":{"x":1}}],"rng":{"p":5,"m":0}}],"keyframes":[{"tic":0,"map":"E1M1","snapshot":0},{"tic":6,"map":"E1M2",' +
  '"snapshot":0}],"session":{"infiniteTallActors":false,"pistolStart":false},"slots":[{"settings":{"autorun":true' +
  ',"autoSwitchWeapon":true,"rightMouse":"previousweapon","cameraMode":"auto"},"tics":{"held":[1,265,0,0,53687097' +
  '6,0,1024],"pressed":[0,4096,0,147456,0,0,0],"buttons":[0,1,2,0,3,0,0],"wheel":[0,0,1,-1,0,0,0],"aimX":[6408,64' +
  '64,null,null,null,null,-497],"aimY":[-3232,-3264,null,null,null,null,193],"poseYaw":[5760,5761,8640,5760,5761,' +
  '8640,5760],"poseX":[4096,4128,-201,4096,4128,-201,4096],"poseY":[2624,2640,0,2624,2640,0,2624],"poseZ":[-8192,' +
  '-8192,768,-8192,-8192,768,-8192],"poseDistance":[30720,30784,22400,30720,30784,22400,30720],"poseTilt":[3680,3' +
  '680,3200,3680,3680,3200,3680]},"typed":[[2,"id"],[6,"dqd"]]}],"events":[{"tic":2,"kind":"restore","map":"E1M1"' +
  ',"snapshot":1},{"tic":4,"kind":"settings","slot":0,"settings":{"autorun":false,"autoSwitchWeapon":true,"rightM' +
  'ouse":"previousweapon","cameraMode":"auto"}},{"tic":5,"kind":"restore","map":"E1M2","snapshot":1}],"checks":{"' +
  'x":[[10]],"y":[[-4]],"cursor":[0]}}}';
