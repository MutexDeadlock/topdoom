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
    id: `id:${label}`,
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

  test('an unrecognised IWAD with no patch contributes no titles', () => {
    const maps = mergedMaps(source('freedoom2.wad', 'IWAD', ['MAP01']), []);
    assert.deepEqual(maps, [{ name: 'MAP01', provider: 'freedoom2.wad' }]);
  });

  test("a file's DEHACKED titles arrive as levelNames, so they name levels like a MAPINFO does", () => {
    // freedoom2's real shape: no MAPINFO, a name `missionOf` doesn't know, and a DEHACKED that
    // names every level — which the manifest folds into `levelNames`. Without it the menu showed
    // a bare `MAP01`. docs/dehacked.md § Strings.
    const maps = mergedMaps(source('freedoom2.wad', 'IWAD', ['MAP01'], { MAP01: 'Hydroelectric Plant' }), []);
    assert.deepEqual(maps, [{ name: 'MAP01', provider: 'freedoom2.wad', title: 'Hydroelectric Plant' }]);
  });

  test("an add-on's titles reach a map it does not itself provide", () => {
    // EPIC.WAD ships five maps but its DEHACKED renames all 32, and in-game the title applies to
    // every one of them — the menu has to agree, so the provider is not consulted here.
    const epic = source('EPIC.WAD', 'PWAD', ['MAP01'], { MAP17: '17 - the miners' });
    const maps = mergedMaps(source('DOOM2.WAD', 'IWAD', ['MAP01', 'MAP17']), [epic]);
    assert.deepEqual(maps[1], { name: 'MAP17', provider: 'DOOM2.WAD', title: '17 - the miners' });
  });
});
