import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { beginWallShade, RADIUS, wallShadeAt } from '../../src/render/wallshadow.ts';
import { buildMoverMesh, ownTransfers, refreshMoverMesh } from '../../src/render/mapmesh.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMoverIndex } from '../../src/game/specials/movergeometry.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * What a floor darkens against, and what it does not: the shading exists to say where a wall
 * stands, so a ledge dropping away or a step the player walks over must leave the floor alone.
 * See docs/render.md § Wall contact shading.
 */

/** One cell wide enough that a sample can be out of reach of every wall but the one under test. */
const CELL = 512;

/** A rectangular fan for one sector — `beginWallShade` reads only the polygon's own footprint. */
function rect(sector: number, minX: number, minY: number, maxX: number, maxY: number) {
  return { sector, points: Float64Array.of(minX, minY, maxX, minY, maxX, maxY, minX, maxY) };
}

/**
 * The east cell of a two-cell grid, with the west neighbour's heights under test. Its west line is
 * the only one within reach of the samples below; the other three are the grid's own outer walls.
 */
function eastCell(west: { floor: number; ceil: number }) {
  const grid = gridMap(['W.'], { cell: CELL, heights: { W: west } });
  const sector = grid.index(1, 0);
  const shaded = beginWallShade(grid.map, ownTransfers(grid.map), rect(sector, CELL, 0, 2 * CELL, CELL), 0);
  // Distance from the west line, at the cell's mid-height so no outer wall is in range.
  return { shaded, at: (fromWall: number) => wallShadeAt(CELL + fromWall, CELL / 2) };
}

describe('Rendering · wall contact shading', () => {
  test('a wall darkens the floor at its foot and nothing far from it', () => {
    const cell = eastCell({ floor: 0, ceil: 0 });
    assert.ok(cell.shaded, 'a shut neighbour is a wall');
    assert.ok(cell.at(0) > 0.9, 'against the wall is full strength');
    assert.equal(cell.at(RADIUS), 0);
    assert.equal(cell.at(RADIUS * 2), 0);
  });

  test('the ramp only ever falls off with distance', () => {
    const cell = eastCell({ floor: 0, ceil: 0 });
    let previous = cell.at(0);
    for (let d = 4; d <= RADIUS; d += 4) {
      const here = cell.at(d);
      assert.ok(here <= previous, `${d} units out is darker than ${d - 4}`);
      previous = here;
    }
  });

  test('a step up is a wall, a tread the player walks over is not', () => {
    assert.ok(eastCell({ floor: 96, ceil: 256 }).at(8) > 0.8, 'a 96-unit step casts');
    assert.equal(eastCell({ floor: 8, ceil: 128 }).at(8), 0, 'an 8-unit tread does not');
  });

  test('a ledge dropping away casts nothing', () => {
    assert.equal(eastCell({ floor: -256, ceil: 128 }).at(8), 0);
  });

  test('a floor with nothing standing on it is not shaded at all', () => {
    // Ringed by drops on all four sides, so not one of its own lines carries a wall — the answer
    // `addFlatFan` reads to skip the per-vertex query outright.
    const grid = gridMap(['LLL', 'L.L', 'LLL'], { cell: CELL, heights: { L: { floor: -256, ceil: 128 } } });
    const sector = grid.index(1, 1);
    const shaded = beginWallShade(grid.map, ownTransfers(grid.map), rect(sector, CELL, CELL, 2 * CELL, 2 * CELL), 0);
    assert.equal(shaded, false);
  });

  test('a ceiling that merely hangs lower does not reach the floor', () => {
    assert.equal(eastCell({ floor: 0, ceil: 40 }).at(8), 0);
  });

  test('two leaves of one sector agree where they meet', () => {
    // The candidate filter is per leaf, so a vertex on a BSP split inside a room must come out the
    // same from either side of it or the seam shows.
    const grid = gridMap(['W.'], { cell: CELL, heights: { W: { floor: 0, ceil: 0 } } });
    const transfers = ownTransfers(grid.map);
    const sector = grid.index(1, 0);
    const x = CELL + 40;
    const y = CELL / 2;
    beginWallShade(grid.map, transfers, rect(sector, CELL, 0, CELL + 64, CELL), 0);
    const west = wallShadeAt(x, y);
    beginWallShade(grid.map, transfers, rect(sector, CELL + 64, 0, 2 * CELL, CELL), 0);
    assert.equal(wallShadeAt(x, y), west);
    assert.ok(west > 0);
  });

  test('a mover keeps its shading through a refresh and re-bakes it on a rebuild', () => {
    // A pit between two floors: shaded while it is a pit, and flush — so unshaded — once raised.
    const grid = gridMap(['...', '.L.', '...'], { cell: CELL, heights: { L: { floor: -64, ceil: 128 } } });
    const map = grid.map;
    const sector = grid.index(1, 1);
    for (const side of map.sidedefs) {
      side.upper = 'UPPER';
      side.lower = 'LOWER';
      side.middle = 'MIDDLE';
    }
    const polys = buildSubSectorPolys(map);
    const mover = { map, polys, bank: BANK, options: { movableSectors: new Set([sector]) }, index: buildMoverIndex(map, polys) };
    const shadeOf = (mesh: ReturnType<typeof buildMoverMesh>) => {
      const fan = mesh.flatFans[0];
      // A batch with no shading at all carries no attribute, which the shader reads back as 0.
      const attr = mesh.meshes.get(fan.key)!.geometry.getAttribute('aWallShade');
      if (!attr) return 0;
      let most = 0;
      for (let v = 0; v < fan.vertexCount; v++) most = Math.max(most, attr.getX(fan.vertexStart + v));
      return most;
    };

    const mesh = buildMoverMesh(mover, sector);
    assert.ok(shadeOf(mesh) > 0.5, 'the pit floor is shaded by the walls around it');

    // Raised most of the way: the refresh moves the plane and leaves the baked amount alone.
    map.sectors[sector].floorHeight = -8;
    assert.equal(refreshMoverMesh(mesh, mover, sector), true);
    assert.ok(shadeOf(mesh) > 0.5, 'a refresh never rewrites the shading');

    // Flush with its neighbours, where the lower step stops existing — which is what a refresh
    // refuses on, and the rebuild that follows is what re-bakes.
    map.sectors[sector].floorHeight = 0;
    assert.equal(refreshMoverMesh(mesh, mover, sector), false);
    assert.equal(shadeOf(buildMoverMesh(mover, sector)), 0);
  });

  test('a sector that does not exist shades nothing', () => {
    const grid = gridMap(['.'], { cell: CELL });
    assert.equal(beginWallShade(grid.map, ownTransfers(grid.map), rect(99, 0, 0, CELL, CELL), 0), false);
    assert.equal(wallShadeAt(CELL / 2, CELL / 2), 0);
  });
});
