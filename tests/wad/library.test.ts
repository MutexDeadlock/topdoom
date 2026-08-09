import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergedMaps, type WadSource } from '../../src/wad/library.ts';

/**
 * The menu's level list is built from the manifest alone — no WAD is downloaded to fill it in — so
 * this covers the part that has to agree with what the game will later show on the level card:
 * which file provides each map, and which title (if any) applies. See docs/wad.md § Level names.
 */
function source(label: string, type: 'IWAD' | 'PWAD', maps: string[], levelNames: Record<string, string> = {}): WadSource {
  return {
    key: label,
    label,
    type,
    maps,
    lumpCount: maps.length,
    levelNames,
    size: 0,
    origin: 'server',
    bytes: () => Promise.reject(new Error('the menu must not need the bytes')),
  };
}

describe('WAD parsing · the menu level list', () => {
  test("an IWAD's own maps get their vanilla titles", () => {
    const maps = mergedMaps(source('DOOM2.WAD', 'IWAD', ['MAP01', 'MAP02']), []);
    assert.deepEqual(maps, [
      { name: 'MAP01', provider: 'DOOM2.WAD', title: 'Entryway' },
      { name: 'MAP02', provider: 'DOOM2.WAD', title: 'Underhalls' },
    ]);
  });

  test('a map an add-on took over is attributed to it and loses the IWAD title', () => {
    const maps = mergedMaps(source('DOOM2.WAD', 'IWAD', ['MAP01', 'MAP02']), [source('SCYTHE.WAD', 'PWAD', ['MAP01'])]);
    assert.deepEqual(maps[0], { name: 'MAP01', provider: 'SCYTHE.WAD' });
    assert.equal(maps[1].title, 'Underhalls', 'the map it left alone keeps its own');
  });

  test("an add-on's MAPINFO names its levels, and outranks the IWAD's titles", () => {
    const pwad = source('faulers.wad', 'PWAD', ['MAP01', 'MAP33'], { MAP01: 'Faulers First', MAP33: 'Beyond' });
    const maps = mergedMaps(source('DOOM2.WAD', 'IWAD', ['MAP01']), [pwad]);
    assert.deepEqual(maps, [
      { name: 'MAP01', provider: 'faulers.wad', title: 'Faulers First' },
      // A map the IWAD doesn't have is appended after its own, still named by the MAPINFO.
      { name: 'MAP33', provider: 'faulers.wad', title: 'Beyond' },
    ]);
  });

  test('an unrecognised IWAD contributes no titles', () => {
    const maps = mergedMaps(source('freedoom2.wad', 'IWAD', ['MAP01']), []);
    assert.deepEqual(maps, [{ name: 'MAP01', provider: 'freedoom2.wad' }]);
  });
});
