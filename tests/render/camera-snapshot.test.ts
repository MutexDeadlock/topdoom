import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TopDownCamera } from '../../src/render/camera.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { quantizePose } from '../../src/game/replay/defs.ts';

/**
 * A replay recorded mid-level carries the camera mid-glide: restoring a snapshot must reproduce
 * the run the original camera would have made from there, and rounding the live pose onto the
 * record's lattice every tic must not disturb it. See docs/replays.md § Camera state.
 */

const AT = { x: 100, y: -200, z: 41 };
const CURSOR = { x: 300, y: -100 };

describe('Rendering · camera snapshot', () => {
  test('a snapshot taken mid-step restores to the same run', () => {
    const original = new TopDownCamera(16 / 9);
    original.snapTo(AT);
    original.stepYaw(45);
    original.targetDistance = 700;
    for (let i = 0; i < 3; i++) original.tick(DOOM_TIC, AT, CURSOR);
    const state = JSON.parse(JSON.stringify(original.snapshot()));

    const copy = new TopDownCamera(4 / 3);
    copy.restore(state);
    assert.equal(copy.viewerAngleDeg, original.viewerAngleDeg, 'the mid-step yaw, exactly');
    assert.equal(copy.followHeight, original.followHeight);
    for (let i = 0; i < 20; i++) {
      original.tick(DOOM_TIC, AT, CURSOR);
      copy.tick(DOOM_TIC, AT, CURSOR);
      original.applyToCamera(1);
      copy.applyToCamera(1);
      assert.equal(copy.viewerAngleDeg, original.viewerAngleDeg, `yaw after tic ${i}`);
      assert.equal(copy.distance, original.distance, `distance after tic ${i}`);
      assert.deepEqual(copy.camera.position.toArray(), original.camera.position.toArray(), `pose after tic ${i}`);
    }
  });

  test('rounding the pose onto the record\'s lattice leaves a Q/E step to finish its glide', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    const start = camera.yawDeg;
    camera.stepYaw(45);
    camera.targetDistance = 700;
    // What a recording does before every tic reads the camera.
    for (let i = 0; i < 40; i++) {
      camera.roundPose(quantizePose(camera.pose()));
      camera.tick(DOOM_TIC, AT, CURSOR);
    }
    assert.ok(Math.abs(camera.yawDeg - (start + 45)) < 0.1, `the whole 45°, not one damped step: ${camera.yawDeg}`);
    assert.ok(Math.abs(camera.distance - 700) < 1, `the framing arrived too: ${camera.distance}`);
  });

  test('rayToward the plane point is the pointer ray, within float noise', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo(AT);
    camera.applyToCamera(1);
    const planeZ = 41 - 10;
    const point = camera.pointerToPlane(0.3, -0.2, planeZ);
    assert.ok(point, 'the pointer meets the plane');
    const fromPointer = camera.rayFor(0.3, -0.2);
    const toward = camera.rayToward(point.x, point.y, planeZ);
    assert.ok(toward.origin.distanceTo(fromPointer.origin) < 1e-9);
    assert.ok(toward.direction.distanceTo(fromPointer.direction) < 1e-9);
  });
});
