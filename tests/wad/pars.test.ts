import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parSecondsFor } from '../../src/wad/campaign/pars.ts';

/**
 * The two vanilla par tables and the order a par resolves in. Like the other table tests these
 * prove the transcription is **complete** and keyed right — only `g_game.c` settles whether an
 * individual number is correct. See docs/wad.md § Par times.
 */
describe('Vanilla tables · par times', () => {
  test('covers exactly E1M1-E3M9 for DOOM and MAP01-MAP32 for the commercial sets', () => {
    // `pars[4][10]`: rows 1-3, slots 1-9. Row 0 and each row's slot 0 are unused padding.
    const doom = [];
    for (let e = 1; e <= 4; e++) {
      for (let m = 1; m <= 9; m++) {
        if (parSecondsFor(`E${e}M${m}`, { mission: 'doom' }) !== undefined) doom.push(`E${e}M${m}`);
      }
    }
    assert.equal(doom.length, 27);
    assert.ok(doom.every((name) => !name.startsWith('E4')));

    // `cpars[32]`, indexed `cpars[gamemap-1]`.
    const doom2 = [];
    for (let m = 1; m <= 33; m++) {
      const name = `MAP${String(m).padStart(2, '0')}`;
      if (parSecondsFor(name, { mission: 'doom2' }) !== undefined) doom2.push(name);
    }
    assert.deepEqual(doom2.length, 32);
    assert.equal(parSecondsFor('MAP33', { mission: 'doom2' }), undefined);
  });

  test('reads the numbers g_game.c gives, at both ends of each table', () => {
    assert.equal(parSecondsFor('E1M1', { mission: 'doom' }), 30);
    assert.equal(parSecondsFor('E2M6', { mission: 'doom' }), 360);
    assert.equal(parSecondsFor('E3M9', { mission: 'doom' }), 135);
    assert.equal(parSecondsFor('MAP01', { mission: 'doom2' }), 30);
    assert.equal(parSecondsFor('MAP17', { mission: 'doom2' }), 420);
    assert.equal(parSecondsFor('MAP32', { mission: 'doom2' }), 30);
  });

  test('episode 4 has no par, because vanilla only reads one past its own array there', () => {
    for (let m = 1; m <= 9; m++) {
      assert.equal(parSecondsFor(`E4M${m}`, { mission: 'doom' }), undefined);
    }
  });

  test('Plutonia and TNT use cpars, the same numbers DOOM II does', () => {
    // Final Doom shipped on an unchanged `doom2.exe`, so `gamemode == commercial` holds for both.
    for (const mission of ['plutonia', 'tnt'] as const) {
      assert.equal(parSecondsFor('MAP01', { mission }), 30);
      assert.equal(parSecondsFor('MAP29', { mission }), 300);
    }
  });

  test('an unrecognised IWAD knows no par at all', () => {
    assert.equal(parSecondsFor('MAP01', { mission: null }), undefined);
    assert.equal(parSecondsFor('E1M1', { mission: null }), undefined);
  });

  test('a [PARS] entry beats the vanilla table, and supplies one where there is none', () => {
    const dehPars = new Map([['MAP01', 99], ['E4M1', 45]]);
    assert.equal(parSecondsFor('MAP01', { mission: 'doom2', dehPars }), 99);
    // Untouched by the patch: still the vanilla number.
    assert.equal(parSecondsFor('MAP02', { mission: 'doom2', dehPars }), 90);
    // A map the vanilla table has no row for at all.
    assert.equal(parSecondsFor('E4M1', { mission: 'doom', dehPars }), 45);
    // And a patch alone is enough, with no mission identified.
    assert.equal(parSecondsFor('MAP01', { mission: null, dehPars }), 99);
  });

  test('the map name is matched case-insensitively, like the rest of the campaign tables', () => {
    assert.equal(parSecondsFor('map01', { mission: 'doom2' }), 30);
    assert.equal(parSecondsFor('e1m1', { mission: 'doom' }), 30);
  });
});
