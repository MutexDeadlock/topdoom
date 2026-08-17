import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { computeMovableSectors } from '../../src/game/specials/mapscan.ts';
import { gridMap, addTransferLine } from '../fixtures/gridmap.ts';
import { specialsRig, USE_INPUT, TIC } from '../fixtures/specialsrig.ts';

/**
 * A Boom 242 control sector whose floor moves moves the drawn water surface
 * with it — the two share no linedef, so the rebuild edge is explicit.
 * See docs/specials.md § Deep water.
 */

/**
 * A pool at (3,1) drawing its surface from a control cell at (1,1) that a
 * switch raises by 24 — Boom's rising water.
 */
function risingPool() {
  const grid = gridMap(['#####', '#...#', '#####'], {
    heights: { '.': { floor: 0, ceil: 128 } },
  });
  const map = grid.map;
  const pool = grid.index(3, 1);
  const control = grid.index(1, 1);
  map.sectors[pool].floorHeight = -64;
  map.sectors[pool].tag = 6;
  map.sectors[control].tag = 7;
  addTransferLine(map, control, 242, 6);

  // S1 raise floor by 24 on the control sector: the water level rises, and the
  // mover is aimed at a sector the pool shares no line with.
  const sw = grid.westEdge(2, 1);
  map.linedefs[sw].special = 15;
  map.linedefs[sw].tag = 7;
  return { map, grid, pool, control };
}

/** The heights of every flat fan drawn for `sector`, static batches and mover meshes alike. */
function fanHeights(scene: THREE.Object3D, built: { flatSurfaces: { sector: number; height: number }[] }, sector: number): number[] {
  const out = built.flatSurfaces.filter((f) => f.sector === sector).map((f) => f.height);
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.name.startsWith('flat:')) return;
    const pos = obj.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) out.push(pos.getY(i));
  });
  return out;
}

describe('specials · moving water', () => {
  test('a movable control sector makes the water it drives movable too', () => {
    const { map, pool, control } = risingPool();
    const movable = computeMovableSectors(map);
    assert.ok(movable.has(control), 'the control sector moves');
    assert.ok(movable.has(pool), 'so the water it draws must be rebuildable');
  });

  test('raising the control sector raises the drawn surface', () => {
    const { map, grid, pool, control } = risingPool();
    const rig = specialsRig(map, grid.centre(1, 1));
    const surfaceHeights = () =>
      new Set(fanHeights(rig.scene, rig.built, pool).filter((h) => h !== -64 && h !== 128));

    assert.ok(surfaceHeights().has(0), 'surface starts at the control sector floor');

    // Press the switch from the cell in front of it, then let the floor run.
    const at = grid.centre(1, 1);
    rig.specials.update(TIC, at.x, at.y, 0, USE_INPUT, new Set());
    for (let i = 0; i < 200; i++) rig.tick(TIC);

    assert.equal(map.sectors[control].floorHeight, 24, 'the control floor rose by 24');
    assert.ok(surfaceHeights().has(24), 'and the water surface rose with it');
    assert.equal(surfaceHeights().has(0), false, 'nothing is left at the old level');
  });
});
