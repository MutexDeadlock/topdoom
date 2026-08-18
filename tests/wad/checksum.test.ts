import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hashBytes, wadId, wadSetId } from '../../src/wad/checksum.ts';
import { Wad, WadFile } from '../../src/wad/wad.ts';
import { readFileSync } from 'node:fs';
import { wadFile } from '../fixtures/wadfile.ts';

/**
 * The content id keys persisted per-level records, and is meant to tell a saved game whether the
 * WAD set it was made with is the one loaded now. What matters is that it is a pure function of the
 * bytes: the same file always hashes the same, and a file that differs anywhere hashes differently.
 * See docs/wad.md § Content id.
 */
describe('WAD parsing · content ids', () => {
  test('the same bytes always hash to the same 16 hex chars, empty buffer included', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    assert.equal(hashBytes(bytes), hashBytes(Uint8Array.from(bytes)));
    assert.match(hashBytes(bytes), /^[0-9a-f]{16}$/);
    assert.match(hashBytes(new Uint8Array(0)), /^[0-9a-f]{16}$/);
  });

  test('a different value, a different order or a different length all change it', () => {
    assert.notEqual(
      hashBytes(Uint8Array.from([1, 2, 3, 4, 5])),
      hashBytes(Uint8Array.from([1, 2, 9, 4, 5])),
      'one flipped byte',
    );
    assert.notEqual(
      hashBytes(Uint8Array.from([1, 2, 3])),
      hashBytes(Uint8Array.from([1, 3, 2])),
      'a byte moved between positions',
    );
    // The length fold is what guarantees the last one; without it a run of trailing zero bytes
    // would be the only thing separating an early-truncated file from the whole one.
    assert.notEqual(
      hashBytes(Uint8Array.from([7, 7, 7])),
      hashBytes(Uint8Array.from([7, 7, 7, 0, 0])),
      'a prefix of another buffer',
    );
  });

  test('a file keeps one id, and two files with the same bytes share it', () => {
    const file = wadFile('IWAD', 'DOOM2.WAD', ['MAP01', 'THINGS']);
    const same = wadFile('IWAD', 'RENAMED.WAD', ['MAP01', 'THINGS']);
    assert.equal(wadId(file), wadId(file), 'memoized, not recomputed differently');
    assert.equal(wadId(file), wadId(same), 'the id follows the bytes, not the file name');
  });

  test('a set id names every file in load order', () => {
    const iwad = wadFile('IWAD', 'DOOM2.WAD', ['MAP01']);
    const pwad = wadFile('PWAD', 'SCYTHE.WAD', ['MAP01']);
    assert.deepEqual(wadSetId(new Wad([iwad, pwad])), [
      { name: 'DOOM2.WAD', id: wadId(iwad) },
      { name: 'SCYTHE.WAD', id: wadId(pwad) },
    ]);
  });

  test("the manifest's build-time id is the same string the runtime computes", () => {
    // The manifest plugin hashes a Node `Buffer` straight from `readFileSync`,
    // the runtime hashes an `ArrayBuffer` through `wadId` — and a save resolves
    // by matching one against the other, so a disagreement (a Buffer's view
    // offset into Node's pool, say) would silently refuse every load rather
    // than fail anywhere near the cause. docs/savegames.md § WAD-set identity.
    const bytes = readFileSync(new URL('../fixtures/wads/pinky_above_test.wad', import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.equal(hashBytes(bytes), wadId(new WadFile(buffer, 'pinky_above_test.wad')));
  });
});
