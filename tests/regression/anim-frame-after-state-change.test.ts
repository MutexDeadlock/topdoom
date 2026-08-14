import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SpriteAnimator } from '../../src/render/sprites.ts';
import type { SpriteMaterialCache } from '../../src/render/sprites.ts';
import type { SpriteBank } from '../../src/wad/sprites.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * `SpriteAnimator.animIndex` is one field shared by three sequences (the base
 * cycle, `playOnce`'s override, and `die`'s death chain), so switching sequence
 * can leave it pointing past the end of the new, shorter one. `resolve` then
 * reads `frames[animIndex]` as `undefined`, and `SpriteBank.lookup` throws on
 * `frame.toUpperCase()`.
 *
 * It used to be masked by ordering: `advance` clamps the index, and every
 * `resolve` in the engine happened to run immediately after an `advance` in the
 * same loop. Splitting simulation from drawing (docs/frameloop.md § What runs in
 * a tic) removed that guarantee — a monster killed in `MonsterAttacks.resolve`,
 * *after* its own `advance` for the tic, is drawn before it is ever advanced
 * again. NUTS.WAD hits it within seconds of the first fight.
 *
 * The rule this pins: **`animIndex` is valid for whatever sequence `resolve`
 * would read, at every moment — not merely after an `advance`.**
 */

const WALK = ['A', 'B', 'C', 'D'];
const DEATH = ['E', 'F', 'G'];

/**
 * Records every frame letter `resolve` asks for, and rejects a non-string the
 * way the real `SpriteBank.lookup` does — it calls `frame.toUpperCase()`.
 * Returning `undefined` short-circuits `resolve` before it touches materials,
 * which is what this test wants and `fixtures/spritestubs.ts`'s `recordingBank`
 * (every lump exists) deliberately does not do.
 */
function missingLumpBank(): { bank: SpriteBank; asked: (string | undefined)[] } {
  const asked: (string | undefined)[] = [];
  const bank = {
    lookup(_sprite: string, frame: string) {
      asked.push(frame);
      if (typeof frame !== 'string') throw new TypeError('Cannot read properties of undefined (reading \'toUpperCase\')');
      return undefined;
    },
  } as unknown as SpriteBank;
  return { bank, asked };
}

const MATERIALS = { get: () => null } as unknown as SpriteMaterialCache;

/** Walks the cycle until `animIndex` sits past the end of a 3-frame sequence. */
function walkedToLastFrame(): { anim: SpriteAnimator; asked: (string | undefined)[] } {
  const { bank, asked } = missingLumpBank();
  const anim = new SpriteAnimator(bank, MATERIALS, 'TROO', WALK, 4 * DOOM_TIC);
  for (let i = 0; i < 3; i++) anim.advance(4 * DOOM_TIC, true);
  return { anim, asked };
}

describe('Regressions · a sprite drawn between advance and its next advance', () => {
  test('the fixture really does leave the index past a 3-frame sequence', () => {
    // Without this the test proves nothing: the walk has to have run past
    // DEATH's last index for the switch to be able to dangle.
    const { anim, asked } = walkedToLastFrame();
    anim.resolve(0, 0);
    assert.equal(asked.at(-1), WALK[3], 'sitting on the walk cycle’s last frame');
    assert.ok(WALK.length > DEATH.length, 'and the death chain is the shorter one');
  });

  test('dying mid-cycle resolves without advancing first', () => {
    const { anim, asked } = walkedToLastFrame();
    anim.die(DEATH, 6 * DOOM_TIC);
    // The crash was here: resolve before any advance, exactly as the draw half
    // reaches a monster killed after its own update ran this tic.
    assert.doesNotThrow(() => anim.resolve(0, 0));
    // Not merely "didn't throw" — a death must start on its own first frame, or
    // a corpse pops in partway through its animation.
    assert.equal(asked.at(-1), DEATH[0]);
  });

  test('an attack pose mid-cycle resolves without advancing first', () => {
    const { anim, asked } = walkedToLastFrame();
    // Same shape via playOnce: a monster that fires in the tic it also walked.
    anim.playOnce(['E'], 3 * DOOM_TIC);
    assert.doesNotThrow(() => anim.resolve(0, 0));
    assert.equal(asked.at(-1), 'E');
  });

  test('the following advance still runs the new sequence from its start', () => {
    // Guards against "fix" by clamping in resolve alone, which would leave the
    // sequence's own index and animIndex disagreeing from then on.
    const { anim, asked } = walkedToLastFrame();
    anim.die(DEATH, 6 * DOOM_TIC);
    anim.advance(6 * DOOM_TIC, true);
    anim.resolve(0, 0);
    assert.equal(asked.at(-1), DEATH[1], 'one death frame in, not restarted or skipped');
  });
});
