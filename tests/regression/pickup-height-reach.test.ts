import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';
import { PICKUP_RANGE } from '../../src/game/inventory.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

/**
 * An item's reach in height is `P_TouchSpecialThing`'s pair, not a band either side of the feet:
 * up to the collector's own height above them, and no more than 8 below. A player whose box still
 * spans a ledge stands on its high side, so an item on the floor beneath waits until they step
 * down. docs/items.md § Collecting things.
 */
describe('Regressions · pickup reach in height', () => {
  /** Whether a collector with its feet at `feet` takes a shell box lying on a floor at 0 below it. */
  function taken(feet: number): boolean {
    const grid = gridMap(['###', '#.#', '###'], { cell: 128 });
    const item = grid.centre(1, 1);
    grid.map.things.push({ x: item.x, y: item.y, angle: 0, type: ThingType.shells, flags: 7 });
    const layer = buildThingSprites(new World(grid.map), { bank: BANK, materials: MATERIALS, skill: 3 });
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
