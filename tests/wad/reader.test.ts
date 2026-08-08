import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../../src/wad/reader.ts';

/**
 * The byte cursor every WAD lump is parsed through. docs/wad.md warns that
 * synthetic data won't catch parser regressions in general — that warning is
 * about lump *structure* and real-world WAD quirks, and it still stands. These
 * tests cover only what `Reader` itself is: pure byte→value decoding, where a
 * hand-built buffer is exactly as good as a real one.
 */

function reader(bytes: number[]): Reader {
  return new Reader(Uint8Array.from(bytes).buffer);
}

describe('WAD parsing · byte cursor', () => {
  test('Reader decodes little-endian, with the right signedness', () => {
    const r = reader([0x01, 0x02, 0x03, 0x04]);
    assert.equal(r.u16(), 0x0201, 'low byte first');
    r.seek(0);
    assert.equal(r.u32(), 0x04030201);

    // i16 vs u16 on the same bytes: 0xffff.
    const neg = reader([0xff, 0xff, 0xff, 0xff]);
    assert.equal(neg.i16(), -1);
    neg.seek(0);
    assert.equal(neg.u16(), 65535);
    neg.seek(0);
    assert.equal(neg.i32(), -1);
    neg.seek(0);
    assert.equal(neg.u32(), 4294967295);

    // Sector heights and vertex coordinates are i16 and routinely negative.
    const coord = reader([0x00, 0x80]);
    assert.equal(coord.i16(), -32768);
  });

  test('Reader advances by the width it read', () => {
    const r = reader([1, 0, 2, 0, 0, 0, 3]);
    assert.equal(r.pos, 0);
    r.u16();
    assert.equal(r.pos, 2);
    r.u32();
    assert.equal(r.pos, 6);
    assert.equal(r.u8(), 3);
    assert.equal(r.pos, 7);
  });

  test('Reader tracks length and eof, honouring an offset window', () => {
    const r = reader([1, 2, 3]);
    assert.equal(r.length, 3);
    assert.equal(r.eof, false);
    r.seek(3);
    assert.equal(r.eof, true);

    // A lump is read as a window into the whole file buffer.
    const whole = Uint8Array.from([9, 9, 1, 2, 9]).buffer;
    const windowed = new Reader(whole, 2, 2);
    assert.equal(windowed.length, 2);
    assert.equal(windowed.u8(), 1);
    assert.equal(windowed.u8(), 2);
    assert.equal(windowed.eof, true);
  });

  test('bytes returns a view over the source buffer at the right offset', () => {
    const r = reader([1, 2, 3, 4, 5]);
    r.seek(1);
    const slice = r.bytes(3);
    assert.deepEqual([...slice], [2, 3, 4]);
    assert.equal(r.pos, 4);
  });
});

describe('WAD parsing · lump names', () => {
  test('name8 ends the name at the first NUL and upper-cases the rest', () => {
    // The documented failure: editors do not always zero the rest of the field,
    // so a one-character name followed by a previous edit's leftovers must read
    // as "-", not "-GRAY7". A sidedef reading "-GRAY7" asks for a texture that
    // does not exist, instead of correctly asking for none.
    const leftovers = reader([0x2d, 0x00, 0x47, 0x52, 0x41, 0x59, 0x37, 0x00]);
    assert.equal(leftovers.name8(), '-');
    assert.equal(leftovers.pos, 8, 'all 8 bytes consumed regardless of the NUL');

    // A full 8-character name has no terminator at all.
    const full = reader([0x53, 0x57, 0x31, 0x42, 0x52, 0x43, 0x4f, 0x4d]);
    assert.equal(full.name8(), 'SW1BRCOM');

    // Lower case in the file, upper case in the directory.
    const lower = reader([0x6d, 0x61, 0x70, 0x30, 0x31, 0x00, 0x00, 0x00]);
    assert.equal(lower.name8(), 'MAP01');

    const empty = reader([0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(empty.name8(), '');
  });
});
