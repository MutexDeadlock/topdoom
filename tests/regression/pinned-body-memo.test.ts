import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { Forces } from '../../src/game/specials/forces.ts';
import { VoodooDolls } from '../../src/game/voodoo.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { addControlLine, gridMap, thingAt } from '../fixtures/gridmap.ts';
import { TIC } from '../fixtures/specialsrig.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

/**
 * **A conveyor-pinned body must resume the moment the wall in its way moves.**
 *
 * The pinned-body memo (docs/movement.md § Pinned-body memo) skips a blocked
 * body's per-tic re-derivation while its impulse and the stamped nearby sector
 * heights are unchanged. These tests guard the invalidation half: a belt-pinned
 * voodoo doll and a belt-pinned thing sit against a shut door for long enough
 * that the memo is certainly engaged, the door's ceiling then rises, and both
 * must walk through — a memo that fails to notice the height change leaves them
 * pinned against an open doorway forever.
 */
describe('Regressions · pinned-body memo invalidation', () => {
  test('a doll pinned against a shut door moves on once it opens', () => {
    const grid = gridMap(['..+.']);
    const map = grid.map;
    const start = grid.centre(1, 0);
    map.things.push(
      { x: start.x, y: start.y, angle: 0, type: ThingType.playerStart, flags: 0 },
      { x: grid.centre(0, 0).x, y: grid.centre(0, 0).y, angle: 0, type: ThingType.playerStart, flags: 0 },
    );
    for (const col of [0, 1]) map.sectors[grid.index(col, 0)].tag = 7;
    addControlLine(map, 512, 0, 252, 7); // 1.5 units/tic east, into the door
    const world = new World(map);
    const forces = new Forces(map, world);
    const dolls = new VoodooDolls(world);
    const doll = dolls.dolls[0];
    const run = (tics: number) => {
      for (let i = 0; i < tics; i++) {
        forces.tick();
        dolls.update(TIC, forces, () => null, () => {});
      }
    };
    run(100);
    const pinnedX = doll.x;
    assert.ok(pinnedX < grid.centre(2, 0).x - 64, 'the shut door should have pinned the doll');
    run(50);
    assert.equal(doll.x, pinnedX, 'pinned means not moving');
    // The door opens — by direct height mutation, which is exactly what the
    // memo's heights stamp must notice regardless of who moved the sector.
    map.sectors[grid.index(2, 0)].ceilHeight = 128;
    run(200);
    assert.ok(doll.x > pinnedX + 64, `the doll should have ridden on, moved ${doll.x - pinnedX} units`);
  });

  test('a belt-pinned thing moves on once the door opens', () => {
    const grid = gridMap(['######', '#..+.#', '######'], { cell: 128 });
    const map = grid.map;
    for (const col of [1, 2]) map.sectors[grid.index(col, 1)].tag = 7;
    addControlLine(map, 512, 0, 252, 7);
    map.things.push(thingAt(grid, 1, 1, ThingType.evilEye), thingAt(grid, 4, 1, ThingType.playerStart));
    const world = new World(map);
    const forces = new Forces(map, world);
    const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
    const run = (tics: number) => {
      for (let i = 0; i < tics; i++) {
        forces.tick();
        layer.update(TIC, null, undefined, undefined, (pos, radius, cache) => forces.carryForBody(pos, radius, cache));
      }
    };
    run(150);
    const pinnedX = layer.snapshot().things[0].x;
    assert.ok(pinnedX < grid.centre(3, 1).x - 64, 'the shut door should have pinned the eye');
    run(50);
    assert.equal(layer.snapshot().things[0].x, pinnedX, 'pinned means not moving');
    map.sectors[grid.index(3, 1)].ceilHeight = 128;
    run(200);
    const after = layer.snapshot().things[0].x;
    assert.ok(after > pinnedX + 64, `the eye should have ridden on, moved ${after - pinnedX} units`);
  });
});
