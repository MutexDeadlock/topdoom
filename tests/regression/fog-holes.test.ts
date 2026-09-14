import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { gridMap, type CellHeights } from '../fixtures/gridmap.ts';

/**
 * A sector too small to be a place — a sound channel or vent through the wall mass — is explored
 * like any other and never drawn. Reported on ksutra MAP04 sector 187, a 2×344 channel 8 high
 * between sectors 116 and 188 that lit up as a strip across the void from one spot in a passage.
 * docs/fogofwar.md § Holes in the wall.
 */
describe('Regressions · fog and holes in the wall', () => {
  test('a low, narrow, walled-in sector is explored and not drawn, and sight still passes it', () => {
    const { world, start, leaf } = channel({ floor: 0, ceil: 8 }, 16);
    const fog = new FogOfWar(world, [], [start], 0);
    assert.equal(fog.isVisible(leaf(1)), true, 'explored');
    assert.equal(fog.isDrawn(leaf(1)), false, 'not drawn');
    assert.equal(fog.alphaOf(leaf(1)), 0, 'dark');
    assert.equal(fog.isDrawn(leaf(2)), true, 'the room past it');
  });

  test('a sector as high as the limit, or wider than it, is a place', () => {
    for (const [label, heights, cell] of [
      ['16 high', { floor: 0, ceil: 16 }, 16],
      ['32 wide', { floor: 0, ceil: 8 }, 32],
    ] as const) {
      const { world, start, leaf } = channel(heights, cell);
      const fog = new FogOfWar(world, [], [start], 0);
      assert.equal(fog.isDrawn(leaf(1)), true, label);
    }
  });

  test('the top of a block standing just under the ceiling is drawn', () => {
    // TNT MAP11 sector 186: a crate top 2 below the ceiling of the rooms either side.
    const { world, start, leaf } = channel({ floor: 120, ceil: 128 }, 16);
    const fog = new FogOfWar(world, [], [start], 0);
    assert.equal(fog.isDrawn(leaf(1)), true);
  });

  test('a low sector open on most of its boundary is part of the room around it', () => {
    const grid = gridMap(['...', '.h.', '...'], { cell: 16, heights: { h: { floor: 0, ceil: 8 } } });
    const world = new World(grid.map);
    const start = grid.centre(0, 0);
    const fog = new FogOfWar(world, [], [start], 0);
    const p = grid.centre(1, 1);
    assert.equal(fog.isDrawn(world.subsectorAt(p.x, p.y)), true);
  });

  test('a low sector a special can drive is left alone', () => {
    const { grid, start, leaf, world } = channel({ floor: 0, ceil: 8 }, 16);
    const { map } = grid;
    const useLine = grid.westEdge(1, 0);
    map.linedefs[useLine].special = 1;
    assert.equal(map.sidedefs[map.linedefs[useLine].left].sector, grid.index(1, 0), 'the door is the channel');
    const fog = new FogOfWar(world, [], [start], 0);
    assert.equal(fog.isDrawn(leaf(1)), true);
  });
});

/** `.h.`: a sector of the given heights between two rooms, every cell `cell` wide, walled north and south. */
function channel(heights: CellHeights, cell: number) {
  const grid = gridMap(['.h.'], { cell, heights: { h: heights } });
  const world = new World(grid.map);
  const leaf = (col: number): number => {
    const p = grid.centre(col, 0);
    return world.subsectorAt(p.x, p.y);
  };
  return { grid, world, start: grid.centre(0, 0), leaf };
}
