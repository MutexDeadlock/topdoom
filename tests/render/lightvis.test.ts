import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { LightVisibility, SHADOW_STEPS } from '../../src/render/lightvis.ts';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { gridMap, type GridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/** The flood fill's reached set, as subsector indices. */
function reachFrom(vis: LightVisibility, world: World, grid: GridMap, col: number, row: number, radius: number): Set<number> {
  const at = grid.centre(col, row);
  const out: number[] = [];
  vis.reach(world.subsectorAt(at.x, at.y), at.x, at.y, radius, out);
  return new Set(out);
}

/** The subsector a cell's centre falls in. */
function leafAt(world: World, grid: GridMap, col: number, row: number): number {
  const at = grid.centre(col, row);
  return world.subsectorAt(at.x, at.y);
}

/**
 * Which subsectors a light actually reaches — GZDoom's own light-list model, a flood fill out of
 * the emitter's leaf that crosses only where sight does. docs/lights.md § Light stops at walls.
 */
describe('Dynamic lights · what a light can reach', () => {
  test('a wall stops the fill however large the radius', () => {
    // Two closets either side of a solid cell: nothing connects them, so no radius should bridge it.
    const grid = gridMap(['#####', '#.#.#', '#####'], { cell: 128 });
    const world = new World(grid.map);
    const vis = new LightVisibility(grid.map, buildSubSectorPolys(grid.map), world);
    const reached = reachFrom(vis, world, grid, 1, 1, 10000);

    assert.ok(reached.has(leafAt(world, grid, 1, 1)), 'a light must at least light its own leaf');
    assert.ok(!reached.has(leafAt(world, grid, 3, 1)), 'the fill crossed a solid wall');
  });

  test('an open boundary is crossed, and the far room is reached', () => {
    const grid = gridMap(['######', '#....#', '######'], { cell: 128 });
    const world = new World(grid.map);
    const vis = new LightVisibility(grid.map, buildSubSectorPolys(grid.map), world);
    const reached = reachFrom(vis, world, grid, 1, 1, 10000);
    assert.ok(reached.has(leafAt(world, grid, 4, 1)), 'the fill stopped inside one open room');
  });

  test('the radius bounds the fill along an open corridor', () => {
    const grid = gridMap(['########', '#......#', '########'], { cell: 128 });
    const world = new World(grid.map);
    const vis = new LightVisibility(grid.map, buildSubSectorPolys(grid.map), world);
    // Well short of the far end, which sits ~640 units away.
    const reached = reachFrom(vis, world, grid, 1, 1, 100);
    assert.ok(!reached.has(leafAt(world, grid, 6, 1)), 'the radius test never rejected anything');
  });

  test('a shut door blocks, and opening it lets light through on the next call', () => {
    // The blocking answer is asked live rather than baked into the graph, which is what makes a
    // door work at all — docs/lights.md § Light stops at walls.
    const grid = gridMap(['#####', '#.+.#', '#####'], { cell: 128 });
    const world = new World(grid.map);
    const vis = new LightVisibility(grid.map, buildSubSectorPolys(grid.map), world);
    const far = leafAt(world, grid, 3, 1);
    assert.ok(!reachFrom(vis, world, grid, 1, 1, 10000).has(far), 'a shut door let light through');

    const doorSector = grid.index(2, 1);
    grid.map.sectors[doorSector].ceilHeight = 128;
    assert.ok(reachFrom(vis, world, grid, 1, 1, 10000).has(far), 'an open door still blocked light');
  });

  test('the radius bounds the path, not the straight line to it', () => {
    // Two shafts joined at the bottom: 256 units apart as the crow flies, ~900 the only way a
    // light can actually travel. Bounding the straight line lets a light round a corner and come
    // back bright through the wall it just went round — docs/lights.md § Light stops at walls.
    const grid = gridMap(['#####', '#.#.#', '#.#.#', '#.#.#', '#...#', '#####'], { cell: 128 });
    const world = new World(grid.map);
    const vis = new LightVisibility(grid.map, buildSubSectorPolys(grid.map), world);
    const far = leafAt(world, grid, 3, 1);
    assert.ok(!reachFrom(vis, world, grid, 1, 1, 400).has(far), 'the fill measured the straight line');
    assert.ok(reachFrom(vis, world, grid, 1, 1, 2000).has(far), 'the path is reachable at all');
  });

  test('an emitter outside the map reaches nothing', () => {
    const grid = gridMap(['###', '#.#', '###'], { cell: 128 });
    const world = new World(grid.map);
    const vis = new LightVisibility(grid.map, buildSubSectorPolys(grid.map), world);
    const out: number[] = [];
    vis.reach(-1, 0, 0, 1000, out);
    assert.deepEqual(out, []);
  });
});

/** The bin `castShadows` files a direction under, matching the shader's own arithmetic. */
function binOf(radians: number): number {
  return Math.floor((radians / (2 * Math.PI) + 0.5) * SHADOW_STEPS);
}

const EAST = binOf(0);
const NORTH = binOf(-Math.PI / 2); // DOOM north is -z in three.js space, which is what the map indexes

/**
 * A light's shadow map: per direction, how far it gets before a wall stops it. This is the
 * per-pixel half of the occlusion — the leaf fill lets light through a doorway, and only this
 * stops it going through the wall beside that doorway. docs/lights.md § Light stops at walls.
 */
describe('Dynamic lights · where a light\'s shadows fall', () => {
  function shadowsAt(grid: GridMap, world: World, col: number, row: number, radius: number): Float32Array {
    const vis = new LightVisibility(grid.map, buildSubSectorPolys(grid.map), world);
    const out = new Float32Array(SHADOW_STEPS);
    const at = grid.centre(col, row);
    vis.castShadows(at.x, at.y, radius, out, 0);
    return out;
  }

  test('a wall stops the light at its own distance, in every direction it faces', () => {
    // One cell of open floor: the light stands 64 units from each of the four walls around it.
    const grid = gridMap(['###', '#.#', '###'], { cell: 128 });
    const world = new World(grid.map);
    const shadows = shadowsAt(grid, world, 1, 1, 400);
    assert.ok(Math.abs(shadows[EAST] - 64) < 1, `east blocker at ${shadows[EAST]}, expected 64`);
    assert.ok(Math.abs(shadows[NORTH] - 64) < 1, `north blocker at ${shadows[NORTH]}, expected 64`);
    // Nothing escapes a closed room: the furthest any direction gets is the corner.
    const furthest = Math.max(...shadows);
    assert.ok(furthest < 92, `something escaped a closed room, reaching ${furthest}`);
  });

  test('an open direction reports the radius, so nothing there is shadowed', () => {
    const grid = gridMap(['#####', '#...#', '#####'], { cell: 128 });
    const world = new World(grid.map);
    // From the west cell, the wall 320 units east is past a 200-unit radius.
    const shadows = shadowsAt(grid, world, 1, 1, 200);
    assert.equal(shadows[EAST], 200);
    assert.ok(Math.abs(shadows[NORTH] - 64) < 1, 'the wall beside it must still block');
  });

  test('a shut door casts a shadow and an open one stops casting it', () => {
    const grid = gridMap(['#####', '#.+.#', '#####'], { cell: 128 });
    const world = new World(grid.map);
    assert.ok(Math.abs(shadowsAt(grid, world, 1, 1, 200)[EAST] - 64) < 1, 'a shut door cast no shadow');
    grid.map.sectors[grid.index(2, 1)].ceilHeight = 128;
    assert.equal(shadowsAt(grid, world, 1, 1, 200)[EAST], 200, 'an open door still cast one');
  });
});

/**
 * The `aLightCell` attribute the geometry shader keys its visibility test off — every vertex of
 * every map surface carries the leaf that surface faces into. docs/render.md § Mesh building.
 */
describe('Dynamic lights · the leaf attribute on map geometry', () => {
  const grid = gridMap(['#####', '#...#', '#####'], { cell: 128 });
  // The fixture leaves every sidedef untextured, and an untextured side draws no quad at all.
  for (const side of grid.map.sidedefs) {
    side.upper = 'WALL';
    side.lower = 'WALL';
  }
  const world = new World(grid.map);
  const built = buildMapMesh(grid.map, BANK, { subsectorAt: (x, y) => world.subsectorAt(x, y) });

  test('every mesh carries one cell per vertex', () => {
    let meshes = 0;
    for (const mesh of [...built.wallMeshes.values(), ...built.flatMeshes.values()]) {
      meshes++;
      const cells = mesh.geometry.getAttribute('aLightCell');
      const pos = mesh.geometry.getAttribute('position');
      assert.ok(cells, `${mesh.name} has no aLightCell attribute`);
      assert.equal(cells.count, pos.count, `${mesh.name}: one cell per vertex`);
    }
    assert.ok(meshes > 0, 'the fixture built no geometry at all');
  });

  test('a wall quad names the leaf its face looks into, and its vertices agree', () => {
    // Not the leaf the wall is *in* — a one-sided wall has none — but the room in front of it,
    // which is the space a light has to have reached for the wall to be lit.
    assert.ok(built.occluders.length > 0, 'the fixture built no wall quads at all');
    for (const o of built.occluders) {
      assert.ok(o.subsector >= 0, 'a probed build must resolve every quad');
      const cells = built.wallMeshes.get(o.key)!.geometry.getAttribute('aLightCell');
      for (let v = 0; v < o.vertexCount; v++) {
        assert.equal(cells.getX(o.vertexStart + v), o.subsector);
      }
    }
  });

  test('a flat fan names its own leaf', () => {
    assert.ok(built.flatSurfaces.length > 0, 'the fixture built no flats at all');
    for (const f of built.flatSurfaces) {
      const cells = built.flatMeshes.get(f.key)!.geometry.getAttribute('aLightCell');
      assert.equal(cells.getX(f.vertexStart), f.subsector);
    }
  });

  test('without a probe the quads stay unresolved, which the shader reads as ungated', () => {
    const plain = buildMapMesh(grid.map, BANK, {});
    assert.ok(plain.occluders.every((o) => o.subsector === -1));
    const mesh = [...plain.wallMeshes.values()][0];
    assert.equal(mesh.geometry.getAttribute('aLightCell').getX(0), -1);
  });
});
