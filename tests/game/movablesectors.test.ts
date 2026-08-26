import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { scanSectors } from '../../src/game/specials/mapscan.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * The two questions the load-time scan answers, and why they are two: a sector
 * has to leave the static batch either because a mover drives its height *or*
 * because a switch texture on one of its walls has to be swapped, and only the
 * first of those stops `render/mapmesh.ts` dicing its walls vertically.
 * See docs/render.md § Mover meshes.
 */
describe('specials · movable versus moving sectors', () => {
  /** The line between two grid cells, whichever way round its sidedefs happen to sit. */
  function boundary(map: DoomMap, a: number, b: number): number {
    const i = map.linedefs.findIndex((l) => {
      if (l.left === NO_SIDE) return false;
      const f = map.sidedefs[l.right].sector;
      const k = map.sidedefs[l.left].sector;
      return (f === a && k === b) || (f === b && k === a);
    });
    assert.ok(i >= 0, 'the boundary line exists');
    return i;
  }

  /**
   * Three cells in a row. The switch sits on the *left* cell's wall and lowers
   * the *right* one, so the sector that carries the art and the sector that
   * moves are never the same one.
   */
  function level() {
    const grid = gridMap(['...'], { heights: { '.': { floor: 0, ceil: 128 } } });
    const map = grid.map;
    const host = grid.index(0, 0);
    const target = grid.index(2, 0);
    map.sectors[target].tag = 7;
    const line = boundary(map, host, grid.index(1, 0));
    map.linedefs[line].special = 23; // S1 floor lower to lowest
    map.linedefs[line].tag = 7;
    const side = map.sidedefs[map.linedefs[line].right].sector === host ? map.linedefs[line].right : map.linedefs[line].left;
    map.sidedefs[side].middle = 'SW1BRN1';
    return { map, host, target };
  }

  test('a switch puts its own sector in the movable set', () => {
    const { map, host, target } = level();
    const { movable } = scanSectors(map);
    assert.ok(movable.has(host), 'the wall carrying the switch stayed in the static batch');
    assert.ok(movable.has(target), 'the sector the switch lowers stayed in the static batch');
  });

  test('but not in the moving one, which is only the sectors a special drives', () => {
    const { map, host, target } = level();
    const { moving } = scanSectors(map);
    assert.ok(!moving.has(host), 'a switch was read as movement');
    assert.ok(moving.has(target), 'the sector the switch lowers was not read as movement');
  });

  test('one scan answers both, and moving stays a subset of movable', () => {
    const { map } = level();
    const { moving, movable } = scanSectors(map);
    for (const sectorIndex of moving) {
      assert.ok(movable.has(sectorIndex), `sector ${sectorIndex} moves but is not movable`);
    }
    assert.ok(movable.size > moving.size, 'the switch host widened only the movable set');
  });
});
