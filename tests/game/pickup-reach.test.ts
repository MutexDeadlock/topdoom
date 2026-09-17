import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { PICKUP_RANGE } from '../../src/game/inventory.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { thingLayer } from '../fixtures/spritestubs.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';
/**
 * `tryPickup`'s reach is `PIT_CheckThing`'s axis-aligned box, not a circle of
 * the same radius — the corners reach half again as far, which is what lets a
 * player collect an item sitting in an alcove they can never walk into
 * (ksutra.wad MAP04, the shells in sector 233). docs/items.md § Collecting things.
 */
describe('Items · pickup reach is a box, not a circle', () => {
  /** One open cell with a shell box at `(x, y)`, and the layer built over it. */
  function arena(x: number, y: number) {
    const grid = gridMap(['#####', '#...#', '#...#', '#####'], { cell: 128 });
    const map = grid.map;
    map.things.push({ x, y, angle: 0, type: ThingType.shells, flags: 7 });
    const world = new World(map);
    return thingLayer(world);
  }

  const item = { x: 320, y: 320 };

  test('a diagonal offset outside the circle but inside the box is collected', () => {
    // 31 and 32 per axis: both under the 36-unit blockdist, but 44.6 apart in a
    // straight line. These are ksutra MAP04's own figures.
    const layer = arena(item.x, item.y);
    let taken = 0;
    const at = { x: item.x - 31, y: item.y - 32, z: 0 };
    layer.tryPickup(at, at, PICKUP_RANGE, () => (taken++, true));
    assert.equal(taken, 1, 'vanilla collects this; a radius test would not');
  });

  test('the box edge is exclusive, matching `abs(d) >= blockdist` missing', () => {
    const layer = arena(item.x, item.y);
    let taken = 0;
    const edge = { x: item.x - PICKUP_RANGE, y: item.y, z: 0 };
    layer.tryPickup(edge, edge, PICKUP_RANGE, () => (taken++, true));
    assert.equal(taken, 0, 'exactly blockdist away on one axis is a miss');

    const inside = { x: item.x - PICKUP_RANGE + 1, y: item.y, z: 0 };
    layer.tryPickup(inside, inside, PICKUP_RANGE, () => (taken++, true));
    assert.equal(taken, 1, 'one unit closer is a hit');
  });
});

/**
 * An item's reach in height is `P_TouchSpecialThing`'s pair, not a band either side of the feet:
 * up to the collector's own height above them, and no more than 8 below. A player whose box still
 * spans a ledge stands on its high side, so an item on the floor beneath waits until they step
 * down. docs/items.md § Collecting things.
 */
describe('Items · pickup reach in height', () => {
  /** Whether a collector with its feet at `feet` takes a shell box lying on a floor at 0 below it. */
  function taken(feet: number): boolean {
    const grid = gridMap(['###', '#.#', '###'], { cell: 128 });
    const item = grid.centre(1, 1);
    grid.map.things.push({ x: item.x, y: item.y, angle: 0, type: ThingType.shells, flags: 7 });
    const layer = thingLayer(new World(grid.map));
    let got = false;
    const at = { x: item.x, y: item.y, z: feet };
    layer.tryPickup(at, at, PICKUP_RANGE, () => ((got = true), true));
    return got;
  }

  test('an item up to the collector\'s own height above its feet is in reach', () => {
    assert.equal(taken(-PLAYER_HEIGHT), true);
    assert.equal(taken(-PLAYER_HEIGHT - 1), false);
  });

  test('an item more than 8 below its feet is not', () => {
    assert.equal(taken(8), true);
    assert.equal(taken(9), false);
  });
});
