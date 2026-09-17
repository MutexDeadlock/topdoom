import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LIGHT_CELL_MARGIN, LIGHT_CELL_SIZE, LightCells, lightCellsOf } from '../../src/render/lights/cells.ts';
import { FLAT_GRID_LEN, WALL_CHUNK_LEN, buildMapMesh } from '../../src/render/mapmesh.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { DynamicLights } from '../../src/render/lights.ts';
import { LightVisibility } from '../../src/render/lights/vis.ts';
import { parseGldefs } from '../../src/wad/gldefs.ts';
import { World } from '../../src/game/world.ts';
import { Transfers } from '../../src/game/specials/transfers.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * Light cells: a leaf too big for one cell is gridded, so a fragment on a huge floor walks the
 * lights near it rather than every light the leaf holds — docs/lights.md § Light cells. These pin
 * the layout, the margin that makes filing a surface by one point exact, and that a light lands
 * in the cells near it and no others.
 */

const DEFS = parseGldefs(`pointlight LAMP { color 1 1 1 size 80 }
object LAMP { frame LAMP { light LAMP } }`);

/** One square leaf `side` units across, its south-west corner at the origin. */
function square(side: number): LightCells {
  return new LightCells([{ sector: 0, points: Float64Array.from([0, 0, side, 0, side, side, 0, side]) }]);
}

describe('Dynamic lights · light cells', () => {
  test('the margin covers half a wall chunk and half a flat dice cell', () => {
    assert.ok(LIGHT_CELL_MARGIN > WALL_CHUNK_LEN / 2);
    assert.ok(LIGHT_CELL_MARGIN > (FLAT_GRID_LEN * Math.SQRT2) / 2);
  });

  test('a leaf that fits one cell has one; a bigger one a catch-all and a grid', () => {
    const small = square(LIGHT_CELL_SIZE);
    assert.equal(small.cellCount, 1);
    assert.equal(small.isSplit(0), false);
    assert.equal(small.cellOf(0, 10, 10), 0);
    const big = square(LIGHT_CELL_SIZE * 3);
    assert.equal(big.isSplit(0), true);
    assert.equal(big.cellCount, 1 + 9);
    assert.equal(big.wholeCell(0), 0);
    assert.equal(big.cellOf(0, 10, 10), 1);
    assert.equal(big.cellOf(0, LIGHT_CELL_SIZE * 2.5, 10), 3);
    assert.equal(big.cellOf(0, 10, LIGHT_CELL_SIZE * 2.5), 7);
    // A point on or past the boundary lands on the grid's edge rather than off it.
    assert.equal(big.cellOf(0, -5, LIGHT_CELL_SIZE * 3 + 5), 7);
  });

  test('a surface wider than the margin files under the catch-all', () => {
    const big = square(LIGHT_CELL_SIZE * 3);
    assert.equal(big.cellFor(0, 10, 10, LIGHT_CELL_MARGIN), 1);
    assert.equal(big.cellFor(0, 10, 10, LIGHT_CELL_MARGIN + 1), big.wholeCell(0));
  });

  test('a box hands out the catch-all plus every sub-cell it overlaps', () => {
    const big = square(LIGHT_CELL_SIZE * 3);
    const out: number[] = [];
    big.cellsWithin(0, LIGHT_CELL_SIZE - 10, 10, LIGHT_CELL_SIZE + 10, 20, out);
    assert.deepEqual(out, [0, 1, 2]);
    out.length = 0;
    big.cellsWithin(0, -1000, -1000, 5000, 5000, out);
    assert.equal(out.length, 10);
    out.length = 0;
    square(LIGHT_CELL_SIZE).cellsWithin(0, -1000, -1000, 5000, 5000, out);
    assert.deepEqual(out, [0]);
  });

  test('one layout per polygon set, shared by the mesh and the lights', () => {
    const polys = buildSubSectorPolys(gridMap(['..']).map);
    assert.equal(lightCellsOf(polys), lightCellsOf(polys));
  });

  /** A room several cells across, so its one leaf is split into a grid of them. */
  function bigLeaf() {
    const side = LIGHT_CELL_SIZE * 4;
    const grid = gridMap(['.'], { cell: side });
    const map = grid.map;
    const world = new World(map);
    const vis = new LightVisibility(map, buildSubSectorPolys(map), world);
    const centre = grid.centre(0, 0);
    const leaf = world.subsectorAt(centre.x, centre.y);
    assert.ok(vis.cells.isSplit(leaf), 'the fixture leaf must be big enough to split');
    // A light in the south-west corner of the room.
    const at = { x: centre.x - side / 2 + 40, y: centre.y - side / 2 + 40 };
    return { grid, map, world, vis, leaf, at, side };
  }

  test('on a big leaf a light lists in the cells near it and no others', () => {
    const { vis, leaf, at, side } = bigLeaf();
    const lights = new DynamicLights(DEFS);
    lights.bindLevel(vis);
    lights.beginFrame(0, at.x, at.y);
    lights.offer('LAMPA', at.x, at.y, 0, 1);
    lights.commit();
    const slots = lights.uniforms.uLightVis.value.image.data as Uint32Array;
    const lit = (x: number, y: number) => (slots[vis.cells.cellOf(leaf, x, y) * 4] & 0xff) === 0;
    assert.ok(lit(at.x, at.y), 'the cell the light stands in');
    assert.ok((slots[vis.cells.wholeCell(leaf) * 4] & 0xff) === 0, 'the catch-all');
    assert.ok(!lit(at.x + side - 80, at.y + side - 80), 'the far corner, out of reach');
  });

  test('the mesh files a big leaf’s floor under several cells', () => {
    const { map, world, vis, leaf } = bigLeaf();
    const built = buildMapMesh(map, BANK, { transfers: new Transfers(map), subsectorAt: (x, y) => world.subsectorAt(x, y) });
    const flat = built.flatSurfaces.find((f) => f.subsector === leaf)!;
    const cells = built.flatMeshes.get(flat.key)!.geometry.getAttribute('aLightCell');
    const seen = new Set<number>();
    for (let v = 0; v < flat.vertexCount; v++) seen.add(cells.getX(flat.vertexStart + v));
    assert.ok(seen.size > 1, 'a floor spanning several cells files under several');
    for (const c of seen) assert.ok(c > vis.cells.wholeCell(leaf) && c < vis.cells.cellCount, `cell ${c} off the leaf's grid`);
  });
});
