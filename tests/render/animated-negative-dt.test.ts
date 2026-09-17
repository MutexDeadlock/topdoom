import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DOOM_TIC } from '../../src/constants.ts';
import { AnimatedTextures } from '../../src/render/textureanim.ts';
import type { GraphicsBank } from '../../src/wad/graphics.ts';
import type { MaterialBank, SurfaceKind } from '../../src/render/textures.ts';

/**
 * A level's first frame can compute a **negative** `rawDt` — `resume` stamps
 * `lastTime` with `performance.now()` while `frame` gets the timestamp of the
 * rendering opportunity it belongs to, which can predate it
 * (docs/frameloop.md § The accumulator). Fed into `AnimatedTextures`, a
 * negative running total floors to a negative tic, JS's `%` keeps the sign,
 * and `names[-1]` comes back `undefined` — which reached
 * `GraphicsBank.flat(undefined)` and killed the requestAnimationFrame chain,
 * hanging the game.
 *
 * Reported against BOOMEDIT.WAD, and its `ANIMATED` lump is why it surfaced
 * there: the threshold is `-2 × speedTics/35` seconds, so vanilla's uniform
 * 8-tic sequences need about -0.46 s while BOOMEDIT's 2-tic NUKAGE and SFALL
 * need only -0.11 s.
 */
describe('Rendering · animated textures and a negative frame delta', () => {
  /** A bank that claims every name, so no `has` check hides the bad index. */
  function recordingBank() {
    const frames: (string | undefined)[] = [];
    const bank = {
      has: () => true,
      setFrame: (_kind: SurfaceKind, _name: string, frameName: string) => frames.push(frameName),
    } as unknown as MaterialBank;
    return { bank, frames };
  }

  /** Three flats and three wall textures in WAD order, enough to slice sequences out of. */
  const GFX = {
    flatNamesInOrder: () => ['NUKAGE1', 'NUKAGE2', 'NUKAGE3'],
    textureNamesInOrder: () => ['BFALL1', 'BFALL2', 'BFALL3'],
  } as unknown as GraphicsBank;

  const DEFS = [
    { kind: 'flat' as const, start: 'NUKAGE1', end: 'NUKAGE3', speedTics: 2 },
    { kind: 'wall' as const, start: 'BFALL1', end: 'BFALL3', speedTics: 8 },
  ];

  test('a negative delta never asks for a frame outside the sequence', () => {
    for (const dt of [-0.004, -0.12, -0.2, -0.5, -2, -1000]) {
      const { bank, frames } = recordingBank();
      new AnimatedTextures(GFX, bank, DEFS).update(dt);
      assert.ok(
        frames.every((f) => f !== undefined),
        `dt ${dt} produced an undefined frame name`,
      );
    }
  });

  test('time still runs forward afterwards, from zero rather than from the negative', () => {
    const { bank, frames } = recordingBank();
    const anim = new AnimatedTextures(GFX, bank, DEFS);
    anim.update(-5);
    const afterNegative = frames.length;
    // 2 tics/frame at 35 Hz: a quarter second is four frame changes for the
    // first sequence, so it must actually advance rather than stay clamped.
    for (let i = 0; i < 9; i++) anim.update(DOOM_TIC);
    assert.ok(frames.length > afterNegative, 'the animation resumed');
    assert.ok(
      frames.every((f) => f !== undefined),
      'and still never asked for a frame outside the sequence',
    );
  });
});
