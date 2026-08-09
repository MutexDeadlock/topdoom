import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hashBytes, wadId, wadSetId } from '../../src/wad/checksum.ts';
import { Wad, WadFile } from '../../src/wad/wad.ts';

/** A directory-only WAD, same shape as tests/wad/levelnames.test.ts uses — no lump bytes needed. */
function wadFile(type: 'IWAD' | 'PWAD', name: string, lumps: string[]): WadFile {
  const dirOffset = 12;
  const buffer = new ArrayBuffer(dirOffset + lumps.length * 16);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i++) bytes[i] = type.charCodeAt(i);
  view.setInt32(4, lumps.length, true);
  view.setInt32(8, dirOffset, true);
  lumps.forEach((lump, i) => {
    const at = dirOffset + i * 16;
    for (let c = 0; c < lump.length; c++) bytes[at + 8 + c] = lump.charCodeAt(c);
  });
  return new WadFile(buffer, name);
}

/**
 * The content id keys persisted per-level records, and is meant to tell a saved game whether the
 * WAD set it was made with is the one loaded now. What matters is that it is a pure function of the
 * bytes: the same file always hashes the same, and a file that differs anywhere hashes differently.
 * See docs/wad.md § Content id.
 */
describe('WAD parsing · content ids', () => {
  test('the same bytes always hash the same', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    assert.equal(hashBytes(bytes), hashBytes(Uint8Array.from(bytes)));
  });

  test('the hash is 16 hex chars', () => {
    assert.match(hashBytes(Uint8Array.from([0])), /^[0-9a-f]{16}$/);
  });

  test('one flipped byte changes it', () => {
    const a = Uint8Array.from([1, 2, 3, 4, 5]);
    const b = Uint8Array.from([1, 2, 9, 4, 5]);
    assert.notEqual(hashBytes(a), hashBytes(b));
  });

  test('a byte moved between positions changes it', () => {
    assert.notEqual(hashBytes(Uint8Array.from([1, 2, 3])), hashBytes(Uint8Array.from([1, 3, 2])));
  });

  test('a buffer that is a prefix of another hashes differently', () => {
    // The length fold is what guarantees this; without it a run of trailing zero bytes would be
    // the only thing separating an early-truncated file from the whole one.
    assert.notEqual(hashBytes(Uint8Array.from([7, 7, 7])), hashBytes(Uint8Array.from([7, 7, 7, 0, 0])));
  });

  test('an empty buffer still hashes', () => {
    assert.match(hashBytes(new Uint8Array(0)), /^[0-9a-f]{16}$/);
  });

  test('a file keeps one id, and two files with the same bytes share it', () => {
    const file = wadFile('IWAD', 'DOOM2.WAD', ['MAP01', 'THINGS']);
    const same = wadFile('IWAD', 'RENAMED.WAD', ['MAP01', 'THINGS']);
    assert.equal(wadId(file), wadId(file), 'memoized, not recomputed differently');
    assert.equal(wadId(file), wadId(same), 'the id follows the bytes, not the file name');
  });

  test('WADs with different directories get different ids', () => {
    const a = wadFile('IWAD', 'DOOM2.WAD', ['MAP01']);
    const b = wadFile('IWAD', 'DOOM2.WAD', ['MAP02']);
    assert.notEqual(wadId(a), wadId(b));
  });

  test('a set id names every file in load order', () => {
    const iwad = wadFile('IWAD', 'DOOM2.WAD', ['MAP01']);
    const pwad = wadFile('PWAD', 'SCYTHE.WAD', ['MAP01']);
    assert.deepEqual(wadSetId(new Wad([iwad, pwad])), [
      { name: 'DOOM2.WAD', id: wadId(iwad) },
      { name: 'SCYTHE.WAD', id: wadId(pwad) },
    ]);
  });
});
