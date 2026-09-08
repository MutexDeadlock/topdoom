import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Forces } from '../../src/game/specials/forces.ts';
import { World } from '../../src/game/world.ts';
import { NO_SIDE, type DoomMap } from '../../src/wad/map.ts';

/**
 * `Forces` runs on two clocks — the simulation's fixed tic for anything the
 * game reads, the frame delta for the visual offsets alone (docs/specials-forces.md
 * § Scrollers and conveyors). These pin that split, which is easy to collapse
 * by accident into "advance everything by `dt`" and would make a conveyor's
 * strength depend on the display it is drawn on.
 */
describe('Regressions · scrollers and the frame delta', () => {
  function oneScrollerMap(special: number): DoomMap {
    return {
      name: 'TEST',
      nodeFormat: 'vanilla',
      vertexes: [
        { x: 0, y: 0 },
        { x: 128, y: 0 },
      ],
      sectors: [{ floorHeight: 0, ceilHeight: 128, floorTex: 'F', ceilTex: 'F', light: 160, special: 0, tag: 7 }],
      sidedefs: [{ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: 'W', sector: 0 }],
      linedefs: [{ v1: 0, v2: 1, flags: 0, special, tag: 7, right: 0, left: NO_SIDE }],
      segs: [],
      subsectors: [],
      nodes: [],
      things: [],
      bounds: { minX: 0, minY: 0, maxX: 128, maxY: 128 },
    } as unknown as DoomMap;
  }

  function forcesFor(special: number): Forces {
    const map = oneScrollerMap(special);
    return new Forces(map, new World(map));
  }

  test('the conveyor impulse is the same however often frames are drawn', () => {
    // `tick` takes no delta at all, which is the structural half of this; the
    // assertion is that the impulse a tic produces never moves.
    const forces = forcesFor(252);
    forces.tick();
    const first = forces.carryInSector(0)!.x;
    for (let i = 0; i < 10; i++) forces.advanceOffsets(1 / 200);
    forces.tick();
    assert.equal(forces.carryInSector(0)!.x, first);
    forces.advanceOffsets(1);
    forces.tick();
    assert.equal(forces.carryInSector(0)!.x, first);
  });

  test('one long frame scrolls a surface exactly as far as many short ones', () => {
    const coarse = forcesFor(251);
    coarse.tick();
    coarse.advanceOffsets(1);

    const fine = forcesFor(251);
    fine.tick();
    for (let i = 0; i < 200; i++) fine.advanceOffsets(1 / 200);

    assert.ok(
      Math.abs(coarse.flatOffset(0, false).x - fine.flatOffset(0, false).x) < 1e-9,
      `${coarse.flatOffset(0, false).x} vs ${fine.flatOffset(0, false).x}`,
    );
  });

  test('a negative frame delta leaves finite offsets rather than poisoning them', () => {
    // A level's first frame can compute a negative `rawDt` — see the sibling
    // `animated-negative-dt` regression for where that comes from.
    const forces = forcesFor(48);
    forces.tick();
    for (const dt of [-0.004, -0.5, -1000]) forces.advanceOffsets(dt);
    assert.ok(Number.isFinite(forces.sideOffset(0).x), `offset was ${forces.sideOffset(0).x}`);
    forces.advanceOffsets(1);
    assert.ok(Number.isFinite(forces.sideOffset(0).x));
  });

  test('an accelerative scroller builds on tics, not on frames', () => {
    // Its `vdx` must not depend on how many times the renderer asked for offsets
    // in between — that is the whole reason acceleration lives in `tick`.
    const map = oneScrollerMap(215);
    map.sectors.push({ ...map.sectors[0], tag: 0 });
    map.sidedefs[0].sector = 1;
    const forces = new Forces(map, new World(map));
    map.sectors[1].floorHeight += 8;
    forces.tick();
    forces.advanceOffsets(1);
    const afterOneTic = forces.flatOffset(0, false).x;

    // The same tic again, but with a hundred frames drawn during it.
    const map2 = oneScrollerMap(215);
    map2.sectors.push({ ...map2.sectors[0], tag: 0 });
    map2.sidedefs[0].sector = 1;
    const other = new Forces(map2, new World(map2));
    map2.sectors[1].floorHeight += 8;
    other.tick();
    for (let i = 0; i < 100; i++) other.advanceOffsets(1 / 100);
    assert.ok(Math.abs(other.flatOffset(0, false).x - afterOneTic) < 1e-9);
  });
});
