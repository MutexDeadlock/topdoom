import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { inflateZlib } from '../../src/util/inflate.ts';

/**
 * The decoder is exercised against Node's own zlib as the reference encoder:
 * whatever `deflateSync` emits at any compression level must decode back to the
 * input. Level 0 forces stored blocks, tiny inputs get fixed-Huffman blocks,
 * repetitive data gets dynamic tables with overlapping copies — together the
 * three RFC 1951 block types. See docs/wad.md § Node formats for why this
 * exists at all.
 */
describe('Inflate · raw DEFLATE', () => {
  const patterns: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)],
    ['one byte', Uint8Array.from([42])],
    ['short text', new TextEncoder().encode('hello, hello, hello world')],
    [
      'repetitive (overlapping copies)',
      new TextEncoder().encode('abcabcabc'.repeat(20000)),
    ],
    [
      'pseudo-random (barely compressible)',
      Uint8Array.from({ length: 65536 }, (_, i) => (i * 2654435761) >>> 24),
    ],
  ];

  for (const [label, data] of patterns) {
    test(`zlib round-trip: ${label}`, () => {
      assert.deepEqual(inflateZlib(deflateSync(data)), data);
    });
  }

  test('stored blocks (level 0), long enough to need several', () => {
    const data = Uint8Array.from({ length: 200000 }, (_, i) => i & 0xff);
    assert.deepEqual(inflateZlib(deflateSync(data, { level: 0 })), data);
  });

  test('every compression level agrees', () => {
    const data = new TextEncoder().encode('the quick brown fox '.repeat(1000));
    for (let level = 0; level <= 9; level++) {
      assert.deepEqual(inflateZlib(deflateSync(data, { level })), data);
    }
  });

  test('a truncated stream throws instead of returning partial data', () => {
    const packed = deflateSync(new TextEncoder().encode('some data worth having'));
    assert.throws(() => inflateZlib(packed.subarray(0, packed.length - 6)));
  });

  test('a corrupted adler32 trailer is detected', () => {
    const packed = deflateSync(new TextEncoder().encode('checksummed payload'));
    packed[packed.length - 1] ^= 0xff;
    assert.throws(() => inflateZlib(packed), /adler32/);
  });

  test('a non-zlib header is rejected', () => {
    assert.throws(() => inflateZlib(Uint8Array.from([0xff, 0xff, 0, 0, 0, 0])), /zlib/);
  });
});
