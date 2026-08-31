import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMap, mapLinedefBytes } from '../../src/wad/map.ts';
import { Wad } from '../../src/wad/wad.ts';
import { fixtureWad } from '../fixtures/wadfile.ts';

/**
 * `mapLinedefBytes` answers from the lump directory alone, which is the whole point: `game.ts`
 * asks it how big a map is *before* deciding whether building it needs the loading screen.
 * See docs/menu.md § The loading screen.
 */
describe('WAD parsing · map size without loading', () => {
  const wad = new Wad(fixtureWad('doom1_e1m1.wad'));

  test('is the LINEDEFS lump size, and agrees with the map that loads', () => {
    const bytes = mapLinedefBytes(wad, 'E1M1');
    assert.ok(bytes > 0);
    // Doom-format linedefs are 14 bytes each (docs/wad.md § Map formats), so the estimate the
    // prediction scales is the real linedef count and not an accident of lump padding.
    assert.equal(bytes % 14, 0);
    assert.equal(bytes / 14, loadMap(wad, 'E1M1').linedefs.length);
  });

  test('a map the set does not have estimates zero rather than throwing', () => {
    // `loadMap` throws for the same name; the estimate has no way to act on that and must not
    // turn a missing map into a load failure at the wrong layer.
    assert.equal(mapLinedefBytes(wad, 'MAP07'), 0);
    assert.throws(() => loadMap(wad, 'MAP07'), /not found/);
  });
});
