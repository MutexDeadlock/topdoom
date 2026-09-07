import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { LightVisibility, SHADOW_STEPS } from '../../src/render/lights/vis.ts';
import { bspMap, leaf, plane, seg, twoSided, wall } from '../fixtures/bspmap.ts';
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
 * A room whose north boundary is one polygon edge across two leaves: a doorway west of x -32 into
 * the room above, a solid wall east of it. `gridMap` cannot state this — it gives every cell its
 * own leaf, so each edge borders exactly one — and it is DOOM2 MAP01's start room, whose north
 * edge runs the full width of the room with the way out in its western half.
 */
function roomWithHalfWalledEdge() {
  return bspMap({
    vertexes: [
      { x: -128, y: -128 },
      { x: 128, y: -128 },
      { x: 128, y: 0 },
      { x: -32, y: 0 },
      { x: -128, y: 0 },
      { x: -128, y: 128 },
      { x: -32, y: 128 },
    ],
    sidedefs: [0, 0],
    linedefs: [
      wall(1, 0),
      wall(0, 4),
      twoSided(4, 3, 0, 1),
      wall(3, 2),
      wall(2, 1),
      wall(4, 5),
      wall(5, 6),
      wall(6, 3),
    ],
    segs: [
      seg(1, 0, 0),
      seg(0, 4, 1),
      seg(4, 3, 2),
      seg(3, 2, 3),
      seg(2, 1, 4),
      seg(3, 4, 2, 1),
      seg(4, 5, 5),
      seg(5, 6, 6),
      seg(6, 3, 7),
    ],
    // 0 the south room, 1 the room through the doorway, 2 the solid ground beside it.
    subsectors: [
      [0, 5],
      [5, 4],
      [0, 0],
    ],
    // Read root-first: y <= 0 is the south room, and north of it x >= -32 is solid.
    nodes: [plane(-32, 0, 0, 1, leaf(2), leaf(1)), plane(0, 0, 1, 0, leaf(0), 0)],
    half: 512,
  });
}

/**
 * Five leaves in a 512x256 box, nothing but the outer wall: S in the south-west, a tall Z above
 * it, V and T stacked east of Z, and X the whole eastern half. A light in S's west reaches T
 * cheaply through Z or V; the hop from X's entry to the X/T edge is far longer. Between radius
 * 184 (X's own entry) and 276 (T through X), X is admitted and considers T first, along a hop
 * that overshoots the radius — what an older fill marked T seen on, and lost it. Every boundary is
 * open: the leaves are cut by partitions alone.
 */
function detourRoom() {
  return bspMap({
    vertexes: [
      { x: 0, y: 0 },
      { x: 512, y: 0 },
      { x: 512, y: 256 },
      { x: 0, y: 256 },
      { x: 192, y: 0 },
      { x: 192, y: 256 },
      { x: 0, y: 128 },
      { x: 64, y: 256 },
    ],
    sidedefs: [0],
    linedefs: [wall(1, 0), wall(0, 3), wall(3, 2), wall(2, 1)],
    segs: [seg(4, 0, 0), seg(0, 6, 1), seg(6, 3, 1), seg(3, 7, 2), seg(7, 5, 2), seg(1, 4, 0), seg(2, 1, 3), seg(5, 2, 2)],
    // 0 S [0,192]x[0,128], 1 V [64,192]x[128,192], 2 Z [0,64]x[128,256], 3 T [64,192]x[192,256],
    // 4 X [192,512]x[0,256].
    subsectors: [
      [0, 2],
      [2, 0],
      [2, 2],
      [4, 1],
      [5, 3],
    ],
    // Read root-first: east of x 192 is X; south of y 128 is S; west of x 64 is Z; south of y 192
    // is V, north of it T.
    nodes: [
      plane(64, 192, 1, 0, leaf(1), leaf(3)),
      plane(64, 128, 0, 1, 0, leaf(2)),
      plane(0, 128, 1, 0, leaf(0), 1),
      plane(192, 0, 0, 1, leaf(4), 2),
    ],
    half: 512,
  });
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

  test('an edge bordering two leaves is crossed where it opens and not where it walls', () => {
    // One polygon edge, a doorway in half of it and a wall in the other: probing its midpoint
    // answers for whichever of the two that point lands in and loses the other, which left MAP01's
    // start room lighting nothing north of it. docs/lights.md § The adjacency graph.
    const map = roomWithHalfWalledEdge();
    const world = new World(map);
    const vis = new LightVisibility(map, buildSubSectorPolys(map), world);
    const out: number[] = [];
    vis.reach(world.subsectorAt(0, -64), 0, -64, 400, out);
    const reached = new Set(out);

    assert.ok(reached.has(0), 'the light must at least light its own leaf');
    assert.ok(reached.has(1), 'the fill never crossed the open half of the edge');
    assert.ok(!reached.has(2), 'the fill crossed the walled half of the edge');
  });
  test('a leaf keeps the cheapest path to it, so a first hop past the radius cannot drop it', () => {
    const map = detourRoom();
    const world = new World(map);
    const vis = new LightVisibility(map, buildSubSectorPolys(map), world);
    const out: number[] = [];
    vis.reach(world.subsectorAt(8, 100), 8, 100, 200, out);
    assert.ok(out.includes(4), 'X lies within the radius and must be reached');
    assert.ok(out.includes(3), 'T is 113 units away through Z, and X considering it first must not lose it');
  });

  test('a bigger radius never reaches fewer leaves', () => {
    const map = detourRoom();
    const world = new World(map);
    const vis = new LightVisibility(map, buildSubSectorPolys(map), world);
    const from = world.subsectorAt(8, 100);
    let previous = new Set<number>();
    for (let radius = 100; radius <= 300; radius += 10) {
      const out: number[] = [];
      vis.reach(from, 8, 100, radius, out);
      const reached = new Set(out);
      for (const s of previous) assert.ok(reached.has(s), `leaf ${s} reached at radius ${radius - 10} but not at ${radius}`);
      previous = reached;
    }
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
