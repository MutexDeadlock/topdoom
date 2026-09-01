import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type * as THREE from 'three';
import { gridMap, addControlLine } from '../fixtures/gridmap.ts';
import { specialsRig, vertexHeights, NO_INPUT, TIC } from '../fixtures/specialsrig.ts';

/**
 * `SpecialsController.drawMovers`: moving planes are drawn interpolated between
 * tics while the simulation only ever sees tic-exact heights, and a
 * discontinuous jump collapses its window instead of gliding.
 * See docs/frameloop.md § Interpolation.
 */

/** Every flat-fan vertex height across the mover meshes hung on the rig's scene. */
function flatHeights(scene: THREE.Object3D): number[] {
  return vertexHeights(scene, (key) => key.startsWith('flat:'));
}

/** Whether any of `heights` sits within float32 round-off of `expected`. */
function hasHeightNear(heights: number[], expected: number): boolean {
  return heights.some((h) => Math.abs(h - expected) < 1e-3);
}

describe('specials · mover interpolation', () => {
  /** A raised lift (SR 62, tag 1) beside a floor-0 neighbour, mid-stroke after one tic. */
  function loweringLift() {
    const grid = gridMap(['la'], {
      heights: { l: { floor: 0, ceil: 128 }, a: { floor: 64, ceil: 128 } },
    });
    const { map } = grid;
    const lift = grid.index(1, 0);
    map.sectors[lift].tag = 1;
    addControlLine(map, 64, 0, 62, 1);
    const line = map.linedefs.length - 1;
    const r = specialsRig(map, grid.centre(0, 0));
    r.trigger(line);
    const before = map.sectors[lift].floorHeight;
    r.specials.update(TIC, { x: 0, y: 0, angle: 0 }, NO_INPUT, new Set());
    return { map, rig: r, lift, before, after: map.sectors[lift].floorHeight };
  }

  test('the mesh is drawn at the lerped height while the map keeps the tic-exact one', () => {
    const { map, rig: r, lift, before, after } = loweringLift();
    assert.ok(after < before, 'the fixture must actually move the lift');

    r.specials.drawMovers(0.5);
    assert.equal(map.sectors[lift].floorHeight, after, 'the simulation height is restored after drawing');
    const mid = before + (after - before) * 0.5;
    assert.ok(hasHeightNear(flatHeights(r.scene), mid), 'the floor fan sits halfway through the tic');

    r.specials.drawMovers(1);
    assert.ok(hasHeightNear(flatHeights(r.scene), after), 'alpha 1 draws the tic-exact height');
  });

  test('a settled mover stops carrying a window', () => {
    const { rig: r } = loweringLift();
    // A full stroke and its wait, plus slack: down, hold, back up to rest.
    for (let i = 0; i < 400; i++) r.tick();
    const windows = (r.specials as unknown as { moverLerp: Map<number, unknown> }).moverLerp;
    assert.equal(windows.size, 0, 'every window was closed and dropped');
  });

  test("a toggle plat's instant stroke draws at its end, not glided", () => {
    // Boom's 212 (WR toggle plat) seals the sector within one tic — a
    // deliberate discontinuity, so its window is collapsed rather than lerped.
    const grid = gridMap(['a.'], { heights: { a: { floor: 64, ceil: 128 } } });
    const { map } = grid;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = 212;
    map.linedefs[line].tag = 1;
    map.sectors[1].tag = 1;
    const floor = map.sectors[1].floorHeight;
    const ceil = map.sectors[1].ceilHeight;
    const r = specialsRig(map, grid.centre(1, 0));
    r.trigger(line);
    r.specials.update(TIC, { x: 0, y: 0, angle: 0 }, NO_INPUT, new Set());
    assert.equal(map.sectors[1].floorHeight, ceil, 'the stroke completed inside the tic');

    r.specials.drawMovers(0.5);
    const heights = flatHeights(r.scene);
    assert.ok(hasHeightNear(heights, ceil), 'the floor is drawn sealed against the ceiling');
    const mid = floor + (ceil - floor) * 0.5;
    assert.equal(hasHeightNear(heights, mid), false, 'nothing is drawn mid-glide');
  });
});
