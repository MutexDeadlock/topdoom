import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CAMERA_DISTANCE,
  MAX_TILT_DEG,
  MIN_CAMERA_DISTANCE,
  MIN_RESCUE_DISTANCE,
  MIN_TILT_DEG,
  TopDownCamera,
} from '../../src/render/camera.ts';

/**
 * The camera's animated framing: `targetDistance`/`targetTiltDeg` glide on the
 * tic clock and interpolate per frame, while a plain `distance`/`tiltDeg`
 * assignment jumps. See docs/camera.md § Auto camera.
 */

const TIC = 1 / 35;

/** The three.js eye height above the follow point — a pure function of tilt and distance. */
function eyeHeight(camera: TopDownCamera, alpha: number): number {
  camera.applyToCamera(alpha);
  return camera.camera.position.y;
}

describe('render · camera framing', () => {
  test('a target glides and settles exactly, with no asymptotic residue', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo({ x: 0, y: 0, z: 41 });
    camera.targetDistance = 360;
    camera.targetTiltDeg = 50;

    camera.tick(TIC, { x: 0, y: 0, z: 41 }, null);
    assert.ok(camera.distance < 480 && camera.distance > 360, 'one tic moves partway');
    assert.ok(camera.tiltDeg < 60 && camera.tiltDeg > 50);

    for (let i = 0; i < 200; i++) camera.tick(TIC, { x: 0, y: 0, z: 41 }, null);
    assert.equal(camera.distance, 360, 'the damper snaps to the target exactly');
    assert.equal(camera.tiltDeg, 50);
  });

  test('applyToCamera interpolates the framing between the previous and current tic', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo({ x: 0, y: 0, z: 41 });
    camera.targetTiltDeg = 20; // pull well off vertical so the eye height moves a lot
    camera.tick(TIC, { x: 0, y: 0, z: 41 }, null);

    const atPrev = eyeHeight(camera, 0);
    const atHalf = eyeHeight(camera, 0.5);
    const atNow = eyeHeight(camera, 1);
    assert.ok(atNow > atPrev, 'lowering tilt raises the eye');
    assert.ok(atHalf > atPrev && atHalf < atNow, 'alpha 0.5 poses between the two tics');
  });

  test('the envelope is the camera’s own invariant, on both routes', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapFraming(99999, 90);
    assert.equal(camera.distance, MAX_CAMERA_DISTANCE, 'the jump route clamps');
    assert.equal(camera.tiltDeg, MAX_TILT_DEG);
    camera.targetDistance = -5;
    assert.equal(camera.targetDistance, MIN_CAMERA_DISTANCE, 'and so does the glide route');
    camera.targetTiltDeg = 0;
    assert.equal(camera.targetTiltDeg, MIN_TILT_DEG);
    // Out-of-range construction is clamped too, so no caller can seed past it.
    assert.equal(new TopDownCamera(16 / 9, { distance: 10, tiltDeg: 89 }).distance, MIN_CAMERA_DISTANCE);
  });

  test('the auto camera’s route has the lower floor, the manual keys’ route does not', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.targetDistance = -5;
    assert.equal(camera.targetDistance, MIN_CAMERA_DISTANCE, 'the route the manual keys share');
    camera.autoDistance = -5;
    assert.equal(camera.targetDistance, MIN_RESCUE_DISTANCE, 'the route the rescue writes through');
    camera.snapFraming(-5, 30);
    assert.equal(camera.distance, MIN_RESCUE_DISTANCE, 'and the jump route it seeds with');
    // The lower floor is a floor, not an opening: the top of the envelope is shared.
    camera.autoDistance = 99999;
    assert.equal(camera.targetDistance, MAX_CAMERA_DISTANCE);
  });

  test('snapFraming jumps with nothing left to interpolate or glide', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo({ x: 0, y: 0, z: 41 });
    camera.tick(TIC, { x: 0, y: 0, z: 41 }, null);
    camera.snapFraming(700, 30);
    assert.equal(camera.targetDistance, 700, 'the target follows the jump');
    assert.equal(camera.targetTiltDeg, 30);
    assert.ok(Math.abs(eyeHeight(camera, 0) - eyeHeight(camera, 1)) < 1e-9, 'no interpolation window remains');
    camera.tick(TIC, { x: 0, y: 0, z: 41 }, null);
    assert.equal(camera.distance, 700, 'and the next tic has nothing to glide to');
  });
});
