import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SpriteAnimator, VIEWER_ANGLE_DEG, type SpriteSkin } from '../../src/render/sprites.ts';
import type { SpriteBank } from '../../src/wad/sprites.ts';
import { BANK, MATERIALS, materialsStub } from '../fixtures/spritestubs.ts';

/** A bank holding only `letters`, so a frame the skin lacks can be told from one it has. */
function bankOf(letters: string): SpriteBank {
  return {
    lookup: (sprite: string, frame: string, digit: number) =>
      letters.includes(frame) ? { lump: `${sprite}${frame}${digit}`, flip: false } : null,
  } as unknown as SpriteBank;
}

/** Facing the camera, so every lookup lands on rotation 1 and the digit stays out of the way. */
const FACING = VIEWER_ANGLE_DEG;

const tagOf = (cached: unknown): string => (cached as { tag?: string }).tag ?? 'own';
const lumpOf = (cached: unknown): string => (cached as { lump: string }).lump;

/**
 * The player's billboard drawing another file's art for the weapon in hand: which bank and cache
 * answer, and what stays untouched while they do.
 * docs/sprites.md § Weapon-matching player sprites.
 */
describe('Sprites · a skin', () => {
  test('draws the skin’s lump while frameKey stays the animator’s own', () => {
    const anim = new SpriteAnimator(BANK, MATERIALS, 'PLAY', ['A']);
    anim.setSkin({ bank: bankOf('ABCDEFG'), materials: materialsStub({ tag: 'skin' }), spriteName: 'PLA3' });
    const cached = anim.resolve(FACING, VIEWER_ANGLE_DEG);
    assert.equal(lumpOf(cached), 'PLA3A1');
    assert.equal(tagOf(cached), 'skin');
    // The key `FULLBRIGHT_FRAMES` and GLDEFS are both looked up by: never the skin's name.
    assert.equal(anim.frameKey, 'PLAYA');
  });

  test('the memo does not survive a switch between two banks holding the same lump name', () => {
    const anim = new SpriteAnimator(BANK, MATERIALS, 'PLAY', ['A']);
    // A skin whose sprite name is `PLAY` too, i.e. the same lump name in two material caches —
    // the case a lump-name-only memo would answer from the wrong cache.
    anim.setSkin({ bank: bankOf('A'), materials: materialsStub({ tag: 'skin' }), spriteName: 'PLAY' });
    assert.equal(tagOf(anim.resolve(FACING, VIEWER_ANGLE_DEG)), 'skin');
    anim.setSkin(null);
    const own = anim.resolve(FACING, VIEWER_ANGLE_DEG);
    assert.equal(lumpOf(own), 'PLAYA1');
    assert.equal(tagOf(own), 'own');
  });

  test('a frame the skin has no lump for falls back to the animator’s own art', () => {
    const anim = new SpriteAnimator(BANK, MATERIALS, 'PLAY', ['A']);
    anim.setSkin({ bank: bankOf('A'), materials: materialsStub({ tag: 'skin' }), spriteName: 'PLA3' });
    anim.playOnce(['G'], 1);
    const cached = anim.resolve(FACING, VIEWER_ANGLE_DEG);
    assert.equal(lumpOf(cached), 'PLAYG1');
    assert.equal(anim.frameKey, 'PLAYG');
  });

  test('switching skins mid-death does not restart the death chain', () => {
    const anim = new SpriteAnimator(BANK, MATERIALS, 'PLAY', ['A']);
    const skin: SpriteSkin = { bank: bankOf('HIJ'), materials: materialsStub({ tag: 'skin' }), spriteName: 'PLA5' };
    anim.die(['H', 'I', 'J'], 1);
    anim.advance(1.5, false);
    anim.resolve(FACING, VIEWER_ANGLE_DEG);
    assert.equal(anim.frameKey, 'PLAYI');
    anim.setSkin(skin);
    const cached = anim.resolve(FACING, VIEWER_ANGLE_DEG);
    assert.equal(lumpOf(cached), 'PLA5I1');
    assert.equal(anim.frameKey, 'PLAYI');
  });
});
