import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TopDownCamera } from '../../src/render/camera.ts';
import { AIM_HEIGHT_OFFSET, EYE_HEIGHT } from '../../src/game/player.ts';

/**
 * The aim plane is derived from the camera's own follow height, so a fall
 * cannot move the cursor's world point out from under a lagging camera.
 * See docs/camera.md § Aim lead.
 */

const TIC = 1 / 35;
const NDC_X = 0.4;
const NDC_Y = -0.25;

/** Where the pointer meets the aim plane, both ways of choosing that plane's height. */
function cursorPoints(camera: TopDownCamera, playerZ: number) {
  camera.applyToCamera(1);
  return {
    fromCamera: camera.pointerToPlane(NDC_X, NDC_Y, camera.followHeight - EYE_HEIGHT + AIM_HEIGHT_OFFSET),
    fromPlayer: camera.pointerToPlane(NDC_X, NDC_Y, playerZ + AIM_HEIGHT_OFFSET),
  };
}

describe('render · the aim plane during a fall', () => {
  test('a pure vertical fall leaves the cursor where it was', () => {
    const camera = new TopDownCamera(16 / 9, { yawDeg: 0 });
    camera.snapTo({ x: 0, y: 0, z: EYE_HEIGHT });
    const settled = cursorPoints(camera, 0);
    assert.ok(settled.fromCamera && settled.fromPlayer);
    // Standing still, the two rules agree exactly — this changes no steady state.
    assert.ok(Math.abs(settled.fromCamera.x - settled.fromPlayer.x) < 1e-9);
    assert.ok(Math.abs(settled.fromCamera.y - settled.fromPlayer.y) < 1e-9);

    // Drop 160 units, as walking into one of BOOMEDIT's pools does, and run the
    // single tic the camera needs to notice. The player has not moved in x/y.
    const fallenZ = -160;
    camera.tick(TIC, { x: 0, y: 0, z: fallenZ + EYE_HEIGHT }, null);
    const falling = cursorPoints(camera, fallenZ);
    assert.ok(falling.fromCamera && falling.fromPlayer);

    assert.ok(
      Math.abs(falling.fromCamera.x - settled.fromCamera.x) < 1e-9 &&
        Math.abs(falling.fromCamera.y - settled.fromCamera.y) < 1e-9,
      'the camera-derived plane keeps the cursor still',
    );
    // The old rule moved it, which is the swing this exists to stop.
    const moved = Math.hypot(falling.fromPlayer.x - settled.fromPlayer.x, falling.fromPlayer.y - settled.fromPlayer.y);
    assert.ok(moved > 50, `the player-derived plane moved the cursor ${moved.toFixed(0)} units`);
  });

  test('followHeight is the eye height the camera was given, once settled', () => {
    const camera = new TopDownCamera(16 / 9);
    camera.snapTo({ x: 100, y: 200, z: -24 + EYE_HEIGHT });
    camera.applyToCamera(1);
    assert.ok(Math.abs(camera.followHeight - (-24 + EYE_HEIGHT)) < 1e-9);
  });
});
