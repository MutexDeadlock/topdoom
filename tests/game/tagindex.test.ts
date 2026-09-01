import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sectorsByTag, linesByTag } from '../../src/game/world.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import type { DoomMap } from '../../src/wad/map.ts';

/**
 * The tag→sectors and tag→linedefs indexes every tag-driven special resolves
 * through. Ordering is behavior, not an implementation detail: a line-to-line
 * teleport takes whichever match comes *first*.
 * See docs/world.md § The tag indexes.
 */
describe('World · tag indexes', () => {
  /** The scans they replaced: ascending index order, vanilla's `P_Find*FromLineTag`. */
  function scanSectors(map: DoomMap, tag: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < map.sectors.length; i++) if (map.sectors[i].tag === tag) out.push(i);
    return out;
  }
  function scanLines(map: DoomMap, tag: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < map.linedefs.length; i++) if (map.linedefs[i].tag === tag) out.push(i);
    return out;
  }

  function tagged() {
    const grid = gridMap(['....', '....']);
    const { map } = grid;
    // Deliberately out of index order, so a lookup that echoed assignment
    // order rather than index order would show.
    map.sectors[5].tag = 7;
    map.sectors[1].tag = 7;
    map.sectors[3].tag = 7;
    map.sectors[2].tag = 9;
    map.linedefs[10].tag = 7;
    map.linedefs[2].tag = 7;
    map.linedefs[4].tag = 3;
    return map;
  }

  test('sectors carrying a tag come back in ascending index order', () => {
    const map = tagged();
    assert.deepEqual([...sectorsByTag(map, 7)], [1, 3, 5]);
    assert.deepEqual([...sectorsByTag(map, 7)], scanSectors(map, 7), 'matches the scan it replaced');
    assert.deepEqual([...sectorsByTag(map, 9)], [2]);
  });

  test('linedefs carrying a tag come back in ascending index order', () => {
    const map = tagged();
    assert.deepEqual([...linesByTag(map, 7)], [2, 10]);
    assert.deepEqual([...linesByTag(map, 7)], scanLines(map, 7), 'matches the scan it replaced');
    assert.deepEqual([...linesByTag(map, 3)], [4]);
  });

  test('a tag nothing carries yields nothing rather than throwing', () => {
    const map = tagged();
    assert.deepEqual([...sectorsByTag(map, 1234)], []);
    assert.deepEqual([...linesByTag(map, 1234)], []);
  });

  /**
   * Tag 0 is the untagged default on most sectors and lines, and every caller
   * refuses it upstream — indexing it would build the one bucket nobody reads.
   */
  test('tag 0 resolves to nothing, however many sectors carry it', () => {
    const map = tagged();
    assert.ok(
      scanSectors(map, 0).length > 0,
      'the fixture really does have untagged sectors, so this is not vacuous',
    );
    assert.deepEqual([...sectorsByTag(map, 0)], []);
    assert.deepEqual([...linesByTag(map, 0)], []);
  });

  test('the index is memoized per map, not rebuilt per call', () => {
    const map = tagged();
    assert.equal(sectorsByTag(map, 7), sectorsByTag(map, 7), 'same array identity on a second call');
    // A different map object gets its own index rather than the first one's.
    const other = tagged();
    assert.notEqual(sectorsByTag(other, 7), sectorsByTag(map, 7));
  });
});
