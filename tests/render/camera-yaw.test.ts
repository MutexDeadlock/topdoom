import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TopDownCamera } from '../../src/render/camera.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * The camera's orbit: a Q/E step animates towards its target, a `yawDeg`
 * assignment jumps, and `turnYaw` — the silent teleporter's relative reorient —
 * turns without abandoning a step still in flight.
 * See docs/camera.md § Camera orbit.
 */

const AT = { x: 0, y: 0, z: 41 };

describe('Rendering · camera orbit', () => {
  test('a Q/E step animates towards its target and settles on the 45° lattice', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    camera.stepYaw(45);

    camera.tick(DOOM_TIC, AT, null);
    assert.ok(camera.yawDeg > 0 && camera.yawDeg < 45, 'one tic moves partway');

    for (let i = 0; i < 200; i++) camera.tick(DOOM_TIC, AT, null);
    assert.ok(Math.abs(camera.yawDeg - 45) < 1e-6, 'the step arrives');
  });

  test('a silent teleport mid-step turns the orbit and still finishes the step', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    camera.stepYaw(45);
    camera.tick(DOOM_TIC, AT, null); // partway through the smoothing
    const partway = camera.yawDeg;

    // A silent teleporter through an identically-aligned line pair: no rotation
    // at all, the case that used to strand the yaw wherever the step had got to.
    camera.turnYaw(0);
    camera.snapTo(AT);
    assert.equal(camera.yawDeg, partway, 'a zero turn moves nothing on the spot');
    for (let i = 0; i < 200; i++) camera.tick(DOOM_TIC, AT, null);
    assert.ok(Math.abs(camera.yawDeg - 45) < 1e-6, 'the pending step survives the trip');
  });

  test('a rotating silent teleport carries the pending step with it', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    camera.stepYaw(45);
    camera.tick(DOOM_TIC, AT, null);

    camera.turnYaw(90); // a line pair a quarter turn apart
    camera.snapTo(AT);
    for (let i = 0; i < 200; i++) camera.tick(DOOM_TIC, AT, null);
    assert.ok(Math.abs(camera.yawDeg - 135) < 1e-6, 'the turn adds to the step, it does not eat it');
  });

  test('a vanilla teleport’s absolute reorient still cancels a pending step', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    camera.stepYaw(45);
    camera.tick(DOOM_TIC, AT, null);

    camera.yawDeg = 180; // the destination thing's own angle
    camera.snapTo(AT);
    for (let i = 0; i < 200; i++) camera.tick(DOOM_TIC, AT, null);
    assert.equal(camera.yawDeg, 180, 'the arrival angle is the whole answer');
  });

  test('the yaw wraps into (-180°, 180°] instead of accumulating turns', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    // A silent teleporter crossed back and forth turns the orbit a half turn each way.
    for (let i = 0; i < 5; i++) camera.turnYaw(180);
    assert.equal(camera.yawDeg, 180, 'two and a half turns read as the half turn they land on');

    camera.turnYaw(45);
    assert.equal(camera.yawDeg, -135, 'and past the top it comes out the bottom');

    camera.yawDeg = 900;
    assert.equal(camera.yawDeg, 180, 'an absolute reorient is wrapped too');
    camera.yawDeg = -900;
    assert.equal(camera.yawDeg, 180);
  });

  test('wrapping mid-step turns through the step, not the long way round', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    camera.yawDeg = 170;
    camera.stepYaw(45); // target 215, which wraps to -145 rather than turning back through 0

    let previous = camera.yawDeg;
    for (let i = 0; i < 200; i++) {
      camera.tick(DOOM_TIC, AT, null);
      // Each tic is a small step in one direction — never the 350° lurch a lone wrapped field
      // would produce, and never back the way it came.
      const stepped = ((camera.yawDeg - previous + 540) % 360) - 180;
      assert.ok(stepped >= -1e-9 && stepped < 45, `tic ${i} turned ${stepped}°`);
      previous = camera.yawDeg;
    }
    assert.ok(Math.abs(camera.yawDeg - -145) < 1e-6, 'and it arrives at the wrapped target');
  });

  test('turnYaw leaves no interpolation window for the next frame to animate out of', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    camera.turnYaw(90);
    camera.snapTo(AT);
    camera.applyToCamera(0);
    const atPrev = camera.viewAngleDeg;
    camera.applyToCamera(1);
    assert.ok(Math.abs(camera.viewAngleDeg - atPrev) < 1e-9, 'both ends of the window are the turned yaw');
  });
});
