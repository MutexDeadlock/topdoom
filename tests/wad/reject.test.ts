import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { loadMap } from '../../src/wad/map.ts';
import { wadFile } from '../fixtures/wadfile.ts';

/**
 * `loadMap`'s REJECT policy: a table only survives parsing when consulting it
 * could change an answer. See docs/wad.md § REJECT for why a short one is
 * dropped rather than read the way vanilla reads it.
 */

const SECTORS = 4;
/** Bytes a full table for `SECTORS` sectors needs: one bit per ordered pair. */
const FULL = Math.ceil((SECTORS * SECTORS) / 8);

/** A map with just enough lumps to parse: the marker, `SECTORS`, and whatever REJECT is handed in. */
function mapWith(reject: Uint8Array | undefined) {
  const lumps = [{ name: 'MAP01' }, { name: 'SECTORS', bytes: new Uint8Array(SECTORS * 26) }];
  const wad = new Wad([
    wadFile('PWAD', 'T.WAD', reject ? [...lumps, { name: 'REJECT', bytes: reject }] : lumps),
  ]);
  return loadMap(wad, 'MAP01');
}

describe('WAD parsing · REJECT', () => {
  test('a full-size table with any bit set is kept', () => {
    const bytes = new Uint8Array(FULL);
    bytes[0] = 0b0000_0010; // sector 0 can't see sector 1
    const map = mapWith(bytes);
    assert.equal(map.reject?.length, FULL);
    assert.equal(map.reject?.[0], 0b0000_0010);
  });

  test('a longer table is trimmed to the bits the map can address', () => {
    const bytes = new Uint8Array(FULL + 8);
    bytes[0] = 1;
    assert.equal(mapWith(bytes).reject?.length, FULL);
  });

  test('an all-zero table is dropped — it rejects nothing, so nothing should consult it', () => {
    assert.equal(mapWith(new Uint8Array(FULL)).reject, undefined);
  });

  test('a table one byte short is dropped rather than read past its end', () => {
    const short = new Uint8Array(FULL - 1);
    short.fill(0xff);
    assert.equal(mapWith(short).reject, undefined);
  });

  test('no REJECT lump at all is the same as no table', () => {
    assert.equal(mapWith(undefined).reject, undefined);
  });
});
