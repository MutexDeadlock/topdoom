import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMoverMesh, refreshMoverMesh, WALL_CHUNK_LEN, type MoverMesh } from '../../src/render/mapmesh.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMoverIndex } from '../../src/game/specials/movergeometry.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * A mover's per-tic mesh update: the in-place refresh that stands in for a
 * rebuild, and what it refuses. The rule under test is that it may never change
 * the geometry a from-scratch `buildMoverMesh` produces — see docs/render.md
 * § Mover meshes.
 */

/**
 * Three open cells in a row whose middle one is the mover, parked mid-travel so
 * it has the steps a moving lift has rather than the ones it has at either end.
 */
function level() {
  const grid = gridMap(['.L.'], { heights: { L: { floor: 32, ceil: 128 } } });
  const map = grid.map;
  const sector = grid.index(1, 0);
  // The fixture leaves every texture slot unset, and an unset slot draws no
  // quad at all — so there would be nothing for a refresh to rewrite.
  for (const side of map.sidedefs) {
    side.upper = 'UPPER';
    side.lower = 'LOWER';
    side.middle = 'MIDDLE';
  }
  const polys = buildSubSectorPolys(map);
  const options = { movableSectors: new Set([sector]) };
  const index = buildMoverIndex(map, polys);
  return {
    map,
    sector,
    build: () => buildMoverMesh(map, polys, sector, BANK, options, index),
    refresh: (mesh: MoverMesh) => refreshMoverMesh(mesh, map, polys, sector, BANK, options, index),
  };
}

/** Every buffer plus every occluder/fan record, flattened to something assert can compare. */
function shape(mesh: MoverMesh) {
  const batches = Object.fromEntries(
    [...mesh.meshes].map(([key, m]) => [
      key,
      (['position', 'uv', 'color'] as const).map((attr) => [...(m.geometry.getAttribute(attr).array as Float32Array)]),
    ]),
  );
  return {
    batches,
    wallQuads: mesh.wallQuads.map((q) => ({ ...q })),
    flatFans: mesh.flatFans.map((f) => ({ ...f, points: [...f.points] })),
  };
}

describe('render · mover meshes', () => {
  test('a refresh after a height change matches a mesh built from scratch', () => {
    const { map, sector, build, refresh } = level();
    const mesh = build();
    // Mid-travel, the state a lift is in on all but the last tic of its move:
    // the same quads as before, at new heights.
    map.sectors[sector].floorHeight = 37;
    assert.equal(refresh(mesh), true);
    assert.deepEqual(shape(mesh), shape(build()));
  });

  test('a refresh keeps the occluder and fan records the faders are holding', () => {
    const { map, sector, build, refresh } = level();
    const mesh = build();
    const [quad] = mesh.wallQuads;
    const fans = mesh.flatFans;
    const floor = fans.find((f) => !f.isCeiling)!;
    map.sectors[sector].floorHeight = 37;
    refresh(mesh);
    // Same arrays and same objects, carrying the new heights:
    // `WallFader`/`FlatFader` index their smoothing state into these, so
    // replacing either restarts a fade mid-motion.
    assert.equal(mesh.wallQuads[0], quad);
    assert.equal(mesh.flatFans, fans);
    assert.equal(floor.height, 37);
  });

  test('a refresh moves a flat\'s plane without re-dicing its footprint', () => {
    // The flats are the half a refresh does *not* rebuild: a mover changes a plane and a light,
    // never a footprint, so the position attribute's Y lane and the colour are all that may move.
    // docs/render.md § Mover meshes.
    const { map, sector, build, refresh } = level();
    const mesh = build();
    const floor = mesh.flatFans.find((f) => !f.isCeiling)!;
    const attr = mesh.meshes.get(floor.key)!.geometry.getAttribute('position');
    const before = [...(attr.array as Float32Array)];

    map.sectors[sector].floorHeight = 37;
    assert.equal(refresh(mesh), true);

    const after = attr.array as Float32Array;
    let moved = 0;
    for (let v = floor.vertexStart; v < floor.vertexStart + floor.vertexCount; v++) {
      assert.equal(after[v * 3], before[v * 3], 'a flat vertex moved in x');
      assert.equal(after[v * 3 + 2], before[v * 3 + 2], 'a flat vertex moved in z');
      assert.equal(after[v * 3 + 1], 37, 'the plane did not follow the sector');
      if (after[v * 3 + 1] !== before[v * 3 + 1]) moved++;
    }
    assert.equal(moved, floor.vertexCount, 'the fan was left at its old height');
    assert.equal(floor.height, 37);
  });

  test('a flat that changes texture is refused, so the caller builds a fresh mesh', () => {
    // The structural case the flats *can* hit: a fan\'s art is part of which batch it lives in,
    // and the in-place write has nowhere to put a fan that belongs somewhere else.
    const { map, sector, build, refresh } = level();
    const mesh = build();
    map.sectors[sector].floorTex = 'OTHERFLT';
    assert.equal(refresh(mesh), false);
  });

  test('a mover wall long enough to be chunked keeps every chunk across a refresh', () => {
    // Chunk count follows the wall's footprint, which a height change never
    // touches — so a lift mid-travel keeps the records (and with them the
    // per-chunk fade the faders index into them). See docs/render.md
    // § Wall occlusion fading.
    const grid = gridMap(['.L.'], { cell: 512, heights: { L: { floor: 32, ceil: 128 } } });
    const map = grid.map;
    const sector = grid.index(1, 0);
    for (const side of map.sidedefs) {
      side.upper = 'UPPER';
      side.lower = 'LOWER';
      side.middle = 'MIDDLE';
    }
    const polys = buildSubSectorPolys(map);
    const options = { movableSectors: new Set([sector]) };
    const index = buildMoverIndex(map, polys);
    const mesh = buildMoverMesh(map, polys, sector, BANK, options, index);

    assert.ok(
      mesh.wallQuads.some((q) => q.ax !== q.segAx || q.ay !== q.segAy),
      'a 512-unit mover wall builds more than one chunk',
    );
    const before = mesh.wallQuads.map((q) => ({ ...q }));
    const records = [...mesh.wallQuads];

    map.sectors[sector].floorHeight = 37;
    assert.equal(refreshMoverMesh(mesh, map, polys, sector, BANK, options, index), true);

    assert.deepEqual([...mesh.wallQuads], records, 'the same record objects, so no fade restarts');
    for (const [i, q] of mesh.wallQuads.entries()) {
      assert.equal(q.ax, before[i].ax, 'chunk footprints are unchanged');
      assert.equal(q.bx, before[i].bx);
      assert.equal(q.segAx, before[i].segAx, 'and they still name the same parent segment');
    }
    assert.ok(
      mesh.wallQuads.some((q) => q.botH === 37 || q.topH === 37),
      'while the heights did move',
    );
  });

  /**
   * A tall mover wall, and the two answers `movingSectors` gives about it: a
   * sector nothing can move dices vertically like static geometry, one a
   * special drives cannot. NUTS.WAD MAP01 is why it matters — one switch on a
   * sidedef makes the whole 12000-unit arena a mover, and its 900-unit walls
   * came out as single quads the occlusion fade had no vertices to open a hole
   * in. docs/render.md § Mover meshes.
   */
  function tallLevel(movingSectors: Set<number> | undefined, layout = '.T.') {
    const grid = gridMap([layout], { heights: { T: { floor: 0, ceil: 512 }, L: { floor: 32, ceil: 128 } } });
    const map = grid.map;
    const sector = grid.index(1, 0);
    for (const side of map.sidedefs) {
      side.upper = 'UPPER';
      side.lower = 'LOWER';
      side.middle = 'MIDDLE';
    }
    const polys = buildSubSectorPolys(map);
    const movable = new Set(map.sectors.map((_, i) => i).filter((i) => layout[i % layout.length] !== '.'));
    const options = { movableSectors: new Set([sector, ...movable]), movingSectors };
    const index = buildMoverIndex(map, polys);
    return {
      map,
      sector,
      mesh: buildMoverMesh(map, polys, sector, BANK, options, index),
      refresh: (mesh: MoverMesh) => refreshMoverMesh(mesh, map, polys, sector, BANK, options, index),
    };
  }

  test('a mover that only carries a switch dices its walls vertically, like static geometry', () => {
    const { mesh } = tallLevel(new Set());
    assert.ok(mesh.wallQuads.length > 0, 'the fixture drew no wall quads at all');
    const tallest = Math.max(...mesh.wallQuads.map((q) => q.topH - q.botH));
    assert.ok(tallest <= WALL_CHUNK_LEN, `a ${tallest}-unit quad survived the vertical dicing`);
  });

  test('a mover a special can actually drive keeps each wall one quad tall', () => {
    const { sector, mesh } = tallLevel(undefined);
    // The upper step over a 128-unit neighbour: 384 units of wall the fade
    // would have to reach the corners of.
    assert.ok(
      mesh.wallQuads.some((q) => q.sector === sector && q.topH - q.botH > WALL_CHUNK_LEN),
      'a moving wall was banded, so its quad count now moves with its height',
    );
  });

  test('a still sector leaves its side of a moving neighbour undiced, since that tier is sized from both', () => {
    // Middle cell still (it only carries a switch), right cell a lift. The
    // still sector's own quads on the shared line are sized from the *lift's*
    // heights, so banding them would move their count as the lift travels —
    // and `refreshMoverMesh` may not rewrite a mesh whose count moved.
    const lift = tallLevel(new Set([2]), '.TL');
    assert.ok(
      Math.max(...lift.mesh.wallQuads.map((q) => q.topH - q.botH)) > WALL_CHUNK_LEN,
      'the side facing the lift was banded anyway',
    );
    // The same level with nothing moving: now every side of it dices, which is
    // what pins the difference on the neighbour rather than on the layout.
    const still = tallLevel(new Set(), '.TL');
    assert.ok(
      Math.max(...still.mesh.wallQuads.map((q) => q.topH - q.botH)) <= WALL_CHUNK_LEN,
      'a level with no mover in it still refused to dice',
    );
  });

  test('a still sector next to a travelling lift still refreshes in place, all the way down', () => {
    // What the rule above buys: the still sector's own side of the shared line
    // is the one quad whose height the lift moves, and it is the one left
    // undiced — so its count holds and the mesh is never thrown away and
    // rebuilt mid-travel. docs/render.md § Mover meshes.
    const { map, mesh, refresh } = tallLevel(new Set([2]), '.TL');
    const quads = mesh.wallQuads.length;
    // The lift's ceiling drives the still sector's upper step over it, which
    // sweeps from 384 units of wall down to 128 — three bands' worth, had it
    // been diced.
    for (let ceil = 128; ceil <= 384; ceil += 32) {
      map.sectors[2].ceilHeight = ceil;
      assert.equal(refresh(mesh), true, `the mesh was refused at ceiling ${ceil}`);
      assert.equal(mesh.wallQuads.length, quads, `the quad count moved at ceiling ${ceil}`);
    }
  });

  test('a refusal leaves the mesh untouched when the sector loses a quad', () => {
    const { map, sector, build, refresh } = level();
    const mesh = build();
    const before = shape(mesh);
    // Floor up to the neighbours' ceiling: the lower steps around the mover
    // are gone, so the buffers no longer fit and only a full rebuild will do.
    map.sectors[sector].floorHeight = 128;
    assert.equal(refresh(mesh), false);
    assert.deepEqual(shape(mesh), before);
  });
});
