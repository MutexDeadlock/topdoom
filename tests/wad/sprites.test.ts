import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { wadFile } from '../fixtures/wadfile.ts';
import { SpriteBank, resetSpriteLumps, setSpriteLump } from '../../src/wad/sprites.ts';

/**
 * `SpriteBank`'s indexing rules, and in particular what happens when a merged set holds both a
 * `rot=0` lump and directional ones for the same frame letter. See
 * docs/sprites.md § Rotation 0 against directional frames.
 */

const rotations = (sprite: string, frame: string) =>
  Array.from({ length: 8 }, (_, i) => `${sprite}${frame}${i + 1}`);

function bank(...files: { name: string; lumps: string[] }[]): SpriteBank {
  return new SpriteBank(
    new Wad(files.map((f) => wadFile('PWAD', f.name, ['S_START', ...f.lumps, 'S_END']))),
  );
}

describe('WAD parsing · sprite rotation frames', () => {
  test('a frame with only a rot=0 lump answers every rotation digit', () => {
    const only0 = bank({ name: 'a.wad', lumps: ['TFOGA0'] });
    for (let digit = 1; digit <= 8; digit++) {
      assert.equal(only0.lookup('TFOG', 'A', digit)?.lump, 'TFOGA0');
    }
  });

  test("a later file's eight rotations beat an earlier rot=0 lump", () => {
    // NoSp3.wad's Cybruiser: SSWV's E-J get real rotations over DOOM2's SSWVE0-SSWVJ0, which
    // vanilla would I_Error on and Boom resolves per slot by load order.
    const merged = bank(
      { name: 'iwad.wad', lumps: ['SSWVE0'] },
      { name: 'pwad.wad', lumps: rotations('SSWV', 'E') },
    );
    for (let digit = 1; digit <= 8; digit++) {
      assert.equal(merged.lookup('SSWV', 'E', digit)?.lump, `SSWVE${digit}`);
    }
  });

  test("a later file's rot=0 lump beats earlier rotations", () => {
    const merged = bank(
      { name: 'iwad.wad', lumps: rotations('SSWV', 'E') },
      { name: 'pwad.wad', lumps: ['SSWVE0'] },
    );
    for (let digit = 1; digit <= 8; digit++) {
      assert.equal(merged.lookup('SSWV', 'E', digit)?.lump, 'SSWVE0');
    }
  });

  test('a rot=0 lump only fills the rotations a later file left alone', () => {
    const merged = bank(
      { name: 'iwad.wad', lumps: ['SSWVE0'] },
      { name: 'pwad.wad', lumps: ['SSWVE3'] },
    );
    assert.equal(merged.lookup('SSWV', 'E', 3)?.lump, 'SSWVE3');
    assert.equal(merged.lookup('SSWV', 'E', 4)?.lump, 'SSWVE0');
  });

  test('the mirrored half of a SSSSFRfr name claims its own rotation', () => {
    const mirrored = bank({ name: 'a.wad', lumps: ['POSSA2A8'] });
    assert.deepEqual(mirrored.lookup('POSS', 'A', 2), { lump: 'POSSA2A8', flip: false });
    assert.deepEqual(mirrored.lookup('POSS', 'A', 8), { lump: 'POSSA2A8', flip: true });
  });

  test('a later lump wins a rotation slot an earlier mirrored name already claimed', () => {
    const merged = bank(
      { name: 'iwad.wad', lumps: ['POSSA2A8'] },
      { name: 'pwad.wad', lumps: ['POSSA8'] },
    );
    assert.deepEqual(merged.lookup('POSS', 'A', 8), { lump: 'POSSA8', flip: false });
    assert.deepEqual(merged.lookup('POSS', 'A', 2), { lump: 'POSSA2A8', flip: false });
  });

  test("a [SPRITES] alias outranks own-name lumps loaded after it", () => {
    // The alias pass runs before the own-name one, so `POSS = ZOMB` reaches the ZOMB art even
    // though this set still ships POSS* lumps, and ships them in the later file.
    setSpriteLump('POSS', 'ZOMB');
    try {
      const renamed = bank(
        { name: 'iwad.wad', lumps: ['ZOMBA1'] },
        { name: 'pwad.wad', lumps: ['POSSA1'] },
      );
      assert.equal(renamed.lookup('POSS', 'A', 1)?.lump, 'ZOMBA1');
      assert.equal(renamed.lookup('ZOMB', 'A', 1)?.lump, 'ZOMBA1');
    } finally {
      resetSpriteLumps();
    }
  });

  test('a sprite or frame the set has no lump for resolves to nothing', () => {
    const sparse = bank({ name: 'a.wad', lumps: ['POSSA1'] });
    assert.equal(sparse.lookup('POSS', 'B', 1), undefined);
    assert.equal(sparse.lookup('SSWV', 'A', 1), undefined);
  });
});
