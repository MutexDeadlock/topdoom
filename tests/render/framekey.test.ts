import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type * as THREE from 'three';
import { SpriteActor, SpriteAnimator, VIEWER_ANGLE_DEG } from '../../src/render/sprites.ts';
import { litColor } from '../../src/render/mapmesh.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

/**
 * `SpriteAnimator.frameKey` is the logical `SPRITE + LETTER` the last `resolve` drew — what the
 * draw loops test against `FULLBRIGHT_FRAMES` to light a frame at 255. It follows every sequence
 * the animator can be in, including a death sequence drawn in another sprite.
 * docs/sprites.md § Fullbright frames.
 */
describe('Sprites · frameKey', () => {
  test('names the sprite and letter of the frame resolve drew, through every sequence', () => {
    const anim = new SpriteAnimator(BANK, MATERIALS, 'TROO', ['A', 'B'], 4 * DOOM_TIC);
    assert.equal(anim.frameKey, '');
    anim.resolve(0, VIEWER_ANGLE_DEG);
    assert.equal(anim.frameKey, 'TROOA');
    anim.advance(4 * DOOM_TIC + 1e-6, true);
    anim.resolve(0, VIEWER_ANGLE_DEG);
    assert.equal(anim.frameKey, 'TROOB');
    anim.playOnce(['H'], 1);
    anim.resolve(0, VIEWER_ANGLE_DEG);
    assert.equal(anim.frameKey, 'TROOH');
    // The barrel's seam: a death drawn in a different sprite names that sprite.
    anim.die(['C'], 1, 'BEXP');
    anim.resolve(0, VIEWER_ANGLE_DEG);
    assert.equal(anim.frameKey, 'BEXPC');
    anim.revive();
    anim.resolve(0, VIEWER_ANGLE_DEG);
    assert.equal(anim.frameKey, 'TROOA');
  });

  test('a SpriteActor lifts a bright frame to 255 and leaves the rest to its sector', () => {
    const pose = { facingDeg: 0, light: 64, dt: 0, animating: false, viewerAngleDeg: VIEWER_ANGLE_DEG, tint: undefined };
    const bright = new SpriteActor(BANK, MATERIALS, {
      spriteName: 'PLAY',
      animFrames: ['F'],
      brightFrames: new Set(['PLAYF']),
    });
    bright.setPose({ x: 0, y: 0, z: 0 }, pose);
    assert.equal((bright.mesh.material as THREE.MeshBasicMaterial).color.r, litColor(255));
    const plain = new SpriteActor(BANK, MATERIALS, {
      spriteName: 'PLAY',
      animFrames: ['A'],
      brightFrames: new Set(['PLAYF']),
    });
    plain.setPose({ x: 0, y: 0, z: 0 }, pose);
    assert.equal((plain.mesh.material as THREE.MeshBasicMaterial).color.r, litColor(64));
  });
});
