import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sectorLines } from '../../src/game/world.ts';
import { NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * The sector→bordering-lines index every neighbor walk runs through. What
 * matters is that it reproduces the full-linedef scan it replaced *exactly*,
 * ordering included — several specials react to whichever neighbor comes
 * first. See docs/world.md § The sector→lines index.
 */

/** The scan the index replaced: every line touching `sectorIndex`, in linedef order. */
function scanAll(map: DoomMap, sectorIndex: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.linedefs.length; i++) {
    const line = map.linedefs[i];
    const front = line.right !== NO_SIDE ? map.sidedefs[line.right]?.sector : undefined;
    const back = line.left !== NO_SIDE ? map.sidedefs[line.left]?.sector : undefined;
    if (front === sectorIndex || back === sectorIndex) out.push(i);
  }
  return out;
}

describe('world · sector→lines index', () => {
  test('matches a full scan, in linedef order, for every sector', () => {
    const { map } = gridMap([
      '.....',
      '.##..',
      '...#.',
      '.....',
    ]);
    for (let i = 0; i < map.sectors.length; i++) {
      assert.deepEqual([...sectorLines(map, i)], scanAll(map, i), `sector ${i}`);
    }
  });

  test('a line whose two sides name the same sector is listed once', () => {
    const { map } = gridMap(['..']);
    // Re-point both sides of one line at sector 0, vanilla's self-referencing shape.
    const line = map.linedefs.find((l) => l.left !== NO_SIDE && l.right !== NO_SIDE)!;
    map.sidedefs[line.right].sector = 0;
    map.sidedefs[line.left].sector = 0;
    const index = map.linedefs.indexOf(line);
    assert.equal(sectorLines(map, 0).filter((i) => i === index).length, 1);
  });

  test('one-sided lines are indexed too — callers do their own filtering', () => {
    const { map } = gridMap(['.']);
    // The single cell's four edges are all one-sided (nothing beyond the grid).
    assert.equal(map.linedefs.filter((l) => l.left === NO_SIDE).length, 4);
    assert.deepEqual([...sectorLines(map, 0)], scanAll(map, 0));
    assert.equal(sectorLines(map, 0).length, 4);
  });

  test('a sector index past the end yields no lines rather than throwing', () => {
    const { map } = gridMap(['..']);
    assert.deepEqual([...sectorLines(map, 999)], []);
  });
});
