import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type * as THREE from 'three';
import { gridMap, addControlLine } from '../fixtures/gridmap.ts';
import { specialsRig, vertexHeights, MASKED_TEXTURE, TIC } from '../fixtures/specialsrig.ts';
import { NO_INPUT } from '../fixtures/input.ts';
import type { WallOccluder } from '../../src/render/mapmesh.ts';

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

describe('Specials · mover interpolation', () => {
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

  test('a rising lift’s bars fill the opening the fade asks about, to the last ulp', () => {
    // `WallFader` exempts a masked quad only while it sits inside its line's opening; one that
    // pokes out fades. Two ways a rising lift's bars poked out (GoingDown.wad MAP01, sector 483):
    // the opening read at the tic-exact floor, which stands above the drawn one, and the quad's
    // bottom interpolated as `top + (bottom - top)`, which lands an ulp low.
    // docs/render-occlusion.md § Which sightlines a wall fades for.
    const grid = gridMap(['la'], {
      heights: { l: { floor: 0, ceil: 128 }, a: { floor: 16, ceil: 128 } },
    });
    const { map } = grid;
    const lift = grid.index(1, 0);
    map.sectors[lift].tag = 1;
    const gate = grid.westEdge(1, 0);
    for (const side of [map.linedefs[gate].right, map.linedefs[gate].left]) {
      map.sidedefs[side].middle = MASKED_TEXTURE;
      map.sidedefs[side].lower = 'STEP';
    }
    // SR 64, floor up to the lowest surrounding ceiling.
    addControlLine(map, 64, 0, 64, 1);
    const r = specialsRig(map, grid.centre(0, 0));
    r.trigger(map.linedefs.length - 1);
    r.specials.update(TIC, { x: 0, y: 0, angle: 0 }, NO_INPUT, new Set());
    const after = map.sectors[lift].floorHeight;
    assert.ok(after > 16, 'the fixture must actually raise the lift');

    // A lerped floor that `top + (floor - top)` rounds low, under the bars' top at the ceiling.
    const top = map.sectors[lift].ceilHeight;
    let alpha = 0;
    for (let i = 1; i < 1000 && alpha === 0; i++) {
      const floor = 16 + (after - 16) * (i / 1000);
      if (top + (floor - top) < floor) alpha = i / 1000;
    }
    assert.ok(alpha > 0, 'the fixture must land the lift on a height the round trip rounds');
    r.specials.drawMovers(alpha);

    type MoverFaders = { geometry: { moverMeshes: Map<number, { walls: { occluders: WallOccluder[] } }> } };
    const bars = [...(r.specials as unknown as MoverFaders).geometry.moverMeshes.values()]
      .flatMap((entry) => entry.walls.occluders)
      .filter((o) => o.key === `wall:${MASKED_TEXTURE}`);
    assert.ok(bars.length > 0, 'the bars are drawn in the lift’s own mesh');
    const opening = { top: 0, bottom: 0 };
    r.world.openingInto(gate, opening);
    assert.ok(
      bars.some((o) => o.botH < opening.bottom),
      'the tic-exact opening stands above the drawn bars',
    );
    assert.ok(r.specials.drawnOpeningInto(gate, opening), 'a two-sided line has an opening');
    for (const o of bars) {
      assert.ok(o.botH >= opening.bottom && o.topH <= opening.top, `bars [${o.botH}, ${o.topH}] fill the drawn opening`);
    }
  });
});
