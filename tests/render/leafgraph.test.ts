import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLeafGraph, buildSubSectorPolys, subsectorAtPoint } from '../../src/render/bsp.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * Which leaves border which, recovered by probing past every polygon edge — the adjacency vanilla
 * SEGS cannot state, since it carries no minisegs. See docs/render-bsp.md § Leaf adjacency.
 */

/** Leaf `i`'s neighbours as a set, so a test can compare without depending on edge order. */
function neighbours(graph: ReturnType<typeof buildLeafGraph>, leaf: number): Set<number> {
  return new Set(Array.from(graph.leaves.slice(graph.starts[leaf], graph.starts[leaf + 1])));
}

describe('Rendering · leaf adjacency', () => {
  test('a cell borders the four cells around it and no others', () => {
    const grid = gridMap(['...', '...', '...']);
    const graph = buildLeafGraph(grid.map);
    const centre = grid.index(1, 1);
    assert.deepEqual(
      neighbours(graph, centre),
      new Set([grid.index(0, 1), grid.index(2, 1), grid.index(1, 0), grid.index(1, 2)]),
      'the diagonals share a corner, not an edge',
    );
  });

  test('a leaf on the outer wall has neighbours only inwards', () => {
    const grid = gridMap(['...', '...', '...']);
    const graph = buildLeafGraph(grid.map);
    assert.deepEqual(neighbours(graph, grid.index(0, 0)), new Set([grid.index(1, 0), grid.index(0, 1)]));
  });

  test('two leaves of one sector still find each other', () => {
    // The line between the two east cells made self-referencing: one sector over both leaves, with
    // no step for a seg to describe — the shape a BSP split inside a sector leaves behind.
    const grid = gridMap(['...']);
    const west = grid.index(1, 0);
    const east = grid.index(2, 0);
    for (const side of grid.map.sidedefs) {
      if (side.sector === east) side.sector = west;
    }
    const graph = buildLeafGraph(grid.map);
    assert.ok(neighbours(graph, west).has(east), 'the split is invisible to SEGS, not to the probe');
    assert.ok(neighbours(graph, east).has(west));
  });

  test('a point resolves to the leaf whose polygon holds it', () => {
    const grid = gridMap(['...', '...']);
    const polys = buildSubSectorPolys(grid.map);
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 2; row++) {
        const at = grid.centre(col, row);
        const leaf = subsectorAtPoint(grid.map, at.x, at.y);
        assert.equal(polys[leaf].sector, grid.index(col, row), `cell ${col},${row}`);
      }
    }
  });
});
