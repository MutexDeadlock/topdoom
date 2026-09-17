import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWadFiles, mergedMaps, type WadSource } from '../../src/wad/library.ts';
import { writePwad } from '../../src/wad/write.ts';
import { wadSource } from '../fixtures/wadsource.ts';

/**
 * The menu's level list is built from the manifest alone — no WAD is downloaded to fill it in — so
 * this covers the part that has to agree with what the game will later show on the level card:
 * which file provides each map, and which title (if any) applies. See docs/wad.md § Level names.
 */
function source(label: string, type: 'IWAD' | 'PWAD', maps: string[], levelNames: Record<string, string> = {}): WadSource {
  return wadSource(label, { type, maps, lumpCount: maps.length, levelNames });
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

  test("the IWAD's own titles stop at the maps it still provides", () => {
    // freedoom2 + NUTS.WAD: the IWAD's DEHACKED names MAP01, but MAP01 is the add-on's level now.
    const iwad = source('freedoom2.wad', 'IWAD', ['MAP01', 'MAP02'], {
      MAP01: 'Hydroelectric Plant',
      MAP02: 'Filtration Complex',
    });
    const maps = mergedMaps(iwad, [source('NUTS.WAD', 'PWAD', ['MAP01'])]);
    assert.deepEqual(maps, [
      { name: 'MAP01', provider: 'NUTS.WAD' },
      { name: 'MAP02', provider: 'freedoom2.wad', title: 'Filtration Complex' },
    ]);
  });

  test("an add-on's titles reach a map it does not itself provide", () => {
    // EPIC.WAD ships five maps but its DEHACKED renames all 32, and in-game the title applies to
    // every one of them — the menu has to agree, so the provider is not consulted here.
    const epic = source('EPIC.WAD', 'PWAD', ['MAP01'], { MAP17: '17 - the miners' });
    const maps = mergedMaps(source('DOOM2.WAD', 'IWAD', ['MAP01', 'MAP17']), [epic]);
    assert.deepEqual(maps[1], { name: 'MAP17', provider: 'DOOM2.WAD', title: '17 - the miners' });
  });
});

/**
 * What the loading screen's bar is fed while a set downloads — the aggregate across files, against
 * a total that must be known before the first byte and must not move.
 * See docs/session.md § The loading screen.
 */
describe('WAD parsing · download progress', () => {
  /**
   * A source shaped like `serverSource`'s download: it declares itself with a synchronous 0, then
   * awaits — as a real one does on its response — before reporting chunks.
   */
  function streaming(label: string, size: number, chunks: number): WadSource {
    const wad = writePwad([{ name: 'MARKER', bytes: new Uint8Array(0) }]);
    return {
      ...source(label, 'PWAD', []),
      size,
      bytes: (onProgress) => {
        onProgress?.(0);
        return (async () => {
          for (let i = 1; i <= chunks; i++) {
            await Promise.resolve();
            onProgress?.((size / chunks) * i);
          }
          return wad.slice().buffer;
        })();
      },
    };
  }

  test('the total is fixed before any byte arrives, and the bar only moves forward', async () => {
    const seen: [number, number][] = [];
    await loadWadFiles(streaming('IWAD.WAD', 1000, 2), [streaming('ADD.WAD', 3000, 3)], (got, total) => seen.push([got, total]));

    assert.deepEqual(new Set(seen.map(([, total]) => total)), new Set([4000]));
    assert.deepEqual(seen.at(-1), [4000, 4000]);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i][0] >= seen[i - 1][0], 'the bar went backwards');
  });

  test('a source already in memory declares nothing and stays out of the total', async () => {
    const seen: [number, number][] = [];
    const warm: WadSource = {
      ...source('UPLOAD.WAD', 'PWAD', []),
      size: 9999,
      bytes: () => Promise.resolve(writePwad([{ name: 'MARKER', bytes: new Uint8Array(0) }]).slice().buffer),
    };
    await loadWadFiles(streaming('IWAD.WAD', 1000, 1), [warm], (got, total) => seen.push([got, total]));
    assert.deepEqual(seen, [[1000, 1000]]);
  });
});
