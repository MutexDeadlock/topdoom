import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { Transfers } from '../../src/game/specials/transfers.ts';
import { NO_SIDE } from '../../src/wad/map.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';
import { CELL, CHUNK, group, lineAtY, walledRow, WALLTEX } from '../fixtures/fade.ts';

/**
 * Walls are cut into chunks at build time, both ways, so the fade has something smaller than a
 * whole line side to window (`tests/render/occlusion-fade.test.ts` is what does the windowing).
 * The dicing is its own rule: a chunk's footprints must meet exactly, or the seam between two is a
 * gap to see through, and their UVs must run on, or the texture jumps at every cut.
 * See docs/render-occlusion.md § The fade is a hole, not a wall.
 */

describe('Rendering · a wall is cut into chunks the fade can window', () => {
  test('a long wall builds one quad per chunk, tiling the line end to end', () => {
    const b = walledRow();
    // The middle cell's north edge: y = 2 * CELL, x from CELL to 2 * CELL.
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    assert.equal(quads.length, CELL / CHUNK, 'a wall that many chunks long is cut into that many quads');

    for (const [i, q] of quads.entries()) {
      assert.equal(q.segAx, quads[0].segAx, 'every chunk names the same parent segment');
      assert.equal(q.segBx, quads[0].segBx);
      assert.equal(Math.hypot(q.bx - q.ax, q.by - q.ay), CHUNK, 'each chunk is one chunk long');
      if (i > 0) {
        assert.deepEqual(
          { x: q.ax, y: q.ay },
          { x: quads[i - 1].bx, y: quads[i - 1].by },
          'and their footprints meet exactly, leaving no gap to see through',
        );
      }
    }
  });

  test('a wall shorter than a chunk stays one quad', () => {
    const grid = gridMap(['###', '...', '###'], { cell: CHUNK });
    for (const l of grid.map.linedefs) {
      if (l.right !== NO_SIDE) grid.map.sidedefs[l.right].upper = WALLTEX;
      if (l.left !== NO_SIDE) grid.map.sidedefs[l.left].upper = WALLTEX;
    }
    const b = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
    const line = lineAtY(grid, 2 * CHUNK, CHUNK * 1.5);
    assert.equal(group(b.occluders, line, true).length, 1);
  });

  test('chunk UVs stay continuous, so the texture does not jump at a cut', () => {
    const b = walledRow();
    const line = lineAtY(b.grid, 2 * CELL, CELL * 1.5);
    const quads = group(b.occluders, line, true);
    const attr = b.wallMeshes.get(quads[0].key)!.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 1; i < quads.length; i++) {
      const previousRight = attr.getX(quads[i - 1].vertexStart + 2);
      const left = attr.getX(quads[i].vertexStart);
      assert.ok(Math.abs(previousRight - left) < 1e-6, `chunk ${i} starts where ${i - 1} ended`);
    }
  });
});
