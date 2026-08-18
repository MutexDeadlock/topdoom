import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { colormapTint } from '../../src/wad/colormaps.ts';
import { Wad, WadFile } from '../../src/wad/wad.ts';
import { fixtureWad } from '../fixtures/wadfile.ts';

/**
 * The colour cast of a named Boom colormap lump — what a 242 sector tints the
 * view with. See docs/wad.md § Colormap lumps.
 */

/** A WAD holding PLAYPAL plus the named lumps, built as real bytes. */
function wadWith(lumps: { name: string; data: Uint8Array }[]): Wad {
  const dirSize = lumps.length * 16;
  const dataSize = lumps.reduce((n, l) => n + l.data.length, 0);
  const buf = new Uint8Array(12 + dataSize + dirSize);
  const view = new DataView(buf.buffer);
  buf.set([0x50, 0x57, 0x41, 0x44]); // "PWAD"
  view.setInt32(4, lumps.length, true);
  view.setInt32(8, 12 + dataSize, true);
  let offset = 12;
  let entry = 12 + dataSize;
  for (const l of lumps) {
    buf.set(l.data, offset);
    view.setInt32(entry, offset, true);
    view.setInt32(entry + 4, l.data.length, true);
    for (let i = 0; i < 8; i++) buf[entry + 8 + i] = i < l.name.length ? l.name.charCodeAt(i) : 0;
    offset += l.data.length;
    entry += 16;
  }
  return new Wad([new WadFile(buf.buffer as ArrayBuffer, 'test.wad')]);
}

/** A palette whose entry i is a pure grey ramp, so a remap's arithmetic is easy to predict. */
function greyPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) p.set([i, i, i], i * 3);
  return p;
}

/** 34 rows of 256 indexes, row 0 filled by `row0` and the rest identity. */
function colormap(row0: (i: number) => number): Uint8Array {
  const data = new Uint8Array(34 * 256);
  for (let i = 0; i < 256; i++) data[i] = row0(i);
  for (let row = 1; row < 34; row++) for (let i = 0; i < 256; i++) data[row * 256 + i] = i;
  return data;
}

describe('WAD parsing · colormap tints', () => {
  test('an identity colormap tints nothing', () => {
    const wad = wadWith([
      { name: 'PLAYPAL', data: greyPalette() },
      { name: 'PLAIN', data: colormap((i) => i) },
    ]);
    assert.deepEqual(colormapTint(wad, 'PLAIN'), { r: 1, g: 1, b: 1 });
  });

  test('a colormap that halves the palette halves every channel', () => {
    const wad = wadWith([
      { name: 'PLAYPAL', data: greyPalette() },
      { name: 'HALF', data: colormap((i) => i >> 1) },
    ]);
    const tint = colormapTint(wad, 'HALF')!;
    // Sum of i>>1 over 0..255 is 16256, sum of i is 32640.
    for (const channel of [tint.r, tint.g, tint.b]) {
      assert.ok(Math.abs(channel - 16256 / 32640) < 1e-9, `${channel} is the summed ratio`);
    }
  });

  test('a missing or wrong-sized lump is not a colormap', () => {
    const wad = wadWith([
      { name: 'PLAYPAL', data: greyPalette() },
      { name: 'SHORT', data: new Uint8Array(256) },
    ]);
    assert.equal(colormapTint(wad, 'SHORT'), null, 'too short — it is a texture name');
    assert.equal(colormapTint(wad, 'NOSUCH'), null);
    assert.equal(colormapTint(wad, '-'), null, 'the empty sidedef slot');
  });

  test("BOOMEDIT's own colormaps come out the colours they are named for", () => {
    // The real lumps, over a real palette: `doom1_lumps.wad` carries the
    // shareware IWAD's PLAYPAL and COLORMAP, `boomedit.wad` the named maps.
    const wad = new Wad([fixtureWad('doom1_lumps.wad'), fixtureWad('boomedit.wad')]);

    const blue = colormapTint(wad, 'BLUMAP')!;
    assert.ok(blue.b > 0.9 && blue.r < 0.1 && blue.g < 0.1, `BLUMAP is blue: ${JSON.stringify(blue)}`);
    const red = colormapTint(wad, 'REDMAP')!;
    assert.ok(red.r > 0.9 && red.g < 0.1 && red.b < 0.1, `REDMAP is red: ${JSON.stringify(red)}`);
    // The IWAD's own COLORMAP is the plain light ramp: row 0 is the identity.
    assert.deepEqual(colormapTint(wad, 'COLORMAP'), { r: 1, g: 1, b: 1 });
  });
});
