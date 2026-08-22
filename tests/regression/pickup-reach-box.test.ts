import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { PICKUP_RANGE } from '../../src/game/inventory.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

/**
 * `tryPickup`'s reach is `PIT_CheckThing`'s axis-aligned box, not a circle of
 * the same radius — the corners reach half again as far, which is what lets a
 * player collect an item sitting in an alcove they can never walk into
 * (ksutra.wad MAP04, the shells in sector 233). docs/items.md § Collecting things.
 */
describe('Regression · pickup reach is a box, not a circle', () => {
  /** One open cell with a shell box at `(x, y)`, and the layer built over it. */
  function arena(x: number, y: number) {
    const grid = gridMap(['#####', '#...#', '#...#', '#####'], { cell: 128 });
    const map = grid.map;
    map.things.push({ x, y, angle: 0, type: ThingType.shells, flags: 7 });
    const world = new World(map);
    return buildThingSprites(map, world, BANK, MATERIALS, 3);
  }

  const item = { x: 320, y: 320 };

  test('a diagonal offset outside the circle but inside the box is collected', () => {
    // 31 and 32 per axis: both under the 36-unit blockdist, but 44.6 apart in a
    // straight line. These are ksutra MAP04's own figures.
    const layer = arena(item.x, item.y);
    let taken = 0;
    layer.tryPickup({ x: item.x - 31, y: item.y - 32, z: 0 }, PICKUP_RANGE, () => (taken++, true));
    assert.equal(taken, 1, 'vanilla collects this; a radius test would not');
  });

  test('the box edge is exclusive, matching `abs(d) >= blockdist` missing', () => {
    const layer = arena(item.x, item.y);
    let taken = 0;
    layer.tryPickup({ x: item.x - PICKUP_RANGE, y: item.y, z: 0 }, PICKUP_RANGE, () => (taken++, true));
    assert.equal(taken, 0, 'exactly blockdist away on one axis is a miss');

    layer.tryPickup({ x: item.x - PICKUP_RANGE + 1, y: item.y, z: 0 }, PICKUP_RANGE, () => (taken++, true));
    assert.equal(taken, 1, 'one unit closer is a hit');
  });
});
