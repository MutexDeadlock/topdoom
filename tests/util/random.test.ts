import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearRandom, mRandom, pRandom, RNDTABLE } from '../../src/util/random.ts';
import { callsIn, filesUnder } from '../fixtures/files.ts';

/**
 * DOOM's `rndtable` and the two cursors over it. Every damage roll, every aim
 * fuzz, every AI coin flip and every broken light in the engine draws from
 * here, so a transcription slip or a shared cursor is a subtle bias in all of
 * them at once. See docs/random.md § The table and the two cursors.
 */

describe('Vanilla tables · the random table', () => {
  test('is 256 entries of m_random.c, verbatim', () => {
    assert.equal(RNDTABLE.length, 256, 'the cursor masks with &0xff, so a short table would read undefined');
    // Anchors at both ends and the wrap point, against `linuxdoom-1.10/m_random.c`.
    assert.deepEqual([...RNDTABLE.slice(0, 6)], [0, 8, 109, 220, 222, 241], 'opening run');
    assert.deepEqual([...RNDTABLE.slice(252)], [120, 163, 236, 249], 'closing run');
    // Checksum over the whole table, so a slip in the middle — where the
    // anchors above can't reach — fails here rather than as a faint bias.
    assert.equal(
      [...RNDTABLE].reduce((a, b) => a + b, 0),
      32986,
      'sum of all 256 entries of the vanilla table',
    );
  });

  test('clearRandom puts the first draw on entry 1, not entry 0', () => {
    clearRandom();
    // Vanilla pre-increments, so `rndtable[0]` is never returned right after a
    // clear — a post-increment port would start every level on a 0 roll, which
    // is a guaranteed minimum-damage first shot.
    assert.equal(pRandom(), RNDTABLE[1]);
    assert.equal(pRandom(), RNDTABLE[2]);
    clearRandom();
    assert.equal(pRandom(), RNDTABLE[1], 'and a clear puts it back');
  });

  test('the cursor wraps after 256 draws, and covers the whole table', () => {
    clearRandom();
    const cycle = Array.from({ length: 256 }, () => pRandom());
    assert.deepEqual(
      [...cycle].sort((a, b) => a - b),
      [...RNDTABLE].sort((a, b) => a - b),
      'one full cycle is exactly the table, so no entry is skipped or doubled',
    );
    assert.equal(pRandom(), cycle[0], 'and the 257th draw is the 1st again');
  });

  test('the two cursors do not disturb each other', () => {
    clearRandom();
    pRandom();
    pRandom();
    // Vanilla splits the cursors so a cosmetic draw can never shift the
    // simulation's sequence. Collapsing them into one would still pass every
    // other test in this file.
    mRandom();
    mRandom();
    mRandom();
    assert.equal(pRandom(), RNDTABLE[3], 'three M draws left the P cursor where it was');

    clearRandom();
    mRandom();
    pRandom();
    pRandom();
    assert.equal(mRandom(), RNDTABLE[2], 'and the same the other way round');
  });

});

describe('Vanilla tables · the table is the only entropy source', () => {
  test('nothing in src/ calls Math.random', () => {
    // The repo runs no linter, so this test is the only thing standing between
    // a new call site and a second, undocumented source of randomness
    // alongside the table. docs/testing.md § Determinism.
    // Call sites, not mentions: a declaration whose comment names the banned call is documenting
    // this very rule, and must not break the build for it.
    const offenders = callsIn(filesUnder('src', (path) => path.endsWith('.ts')), /\bMath\.random\s*\(/g);
    assert.deepEqual(
      offenders,
      [],
      `draw from util/random.ts: pRandom for the simulation, mRandom for cosmetics\n${offenders.join('\n')}`,
    );
  });
});
