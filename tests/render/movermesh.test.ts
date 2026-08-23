import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMoverMesh, refreshMoverMesh, type MoverMesh } from '../../src/render/mapmesh.ts';
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
