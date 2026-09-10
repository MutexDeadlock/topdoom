import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { coopStarts, levelStartFor, rebornSpot } from '../../src/game/playerstarts.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { fxLayer } from '../fixtures/spritestubs.ts';

/**
 * Where each player enters a level, and where `G_DoReborn` stands a dead one back up.
 * docs/multiplayer-coop.md § Starts, § Respawn.
 */

/** A one-row room with the given starts, as `[doomednum, column, angle]`. */
function room(...starts: [type: number, col: number, angle?: number][]) {
  const grid = gridMap(['#######', '#.....#', '#######'], { cell: 128 });
  for (const [type, col, angle = 0] of starts) grid.map.things.push(thingAt(grid, col, 1, type, angle));
  return { grid, world: new World(grid.map) };
}

describe('Player starts · coop starts', () => {
  test("each slot's start is the last thing of its type; a type the map lacks is null", () => {
    const { grid, world } = room(
      [ThingType.playerStart, 1],
      [ThingType.playerStart2, 2],
      [ThingType.playerStart2, 3],
      [ThingType.playerStart4, 5, 90],
    );
    const starts = coopStarts(world);
    const x = (col: number) => grid.centre(col, 1).x;
    assert.deepEqual(
      starts.map((s) => s?.x ?? null),
      [x(1), x(3), null, x(5)],
    );
    assert.equal(starts[3]?.angle, Math.PI / 2);
  });

  test('a slot with no start of its own takes the first nobody took, then player 1’s', () => {
    const starts = coopStarts(room([ThingType.playerStart, 1], [ThingType.playerStart2, 2]).world);
    const [one, two] = [starts[0]!, starts[1]!];
    assert.equal(levelStartFor(starts, 1, [one]), two, 'its own, taken or not');
    assert.equal(levelStartFor(starts, 3, [one]), two, 'the first start still free');
    assert.equal(levelStartFor(starts, 2, [one, two]), one, 'every one taken: player 1’s');
  });
});

describe('Player starts · respawn', () => {
  test('its own start when free, else the first free one in slot order, else its own anyway', () => {
    const starts = coopStarts(
      room([ThingType.playerStart, 1], [ThingType.playerStart2, 3, 180], [ThingType.playerStart3, 5]).world,
    );
    const own = starts[1]!;
    assert.equal(rebornSpot(starts, own, () => false), own);
    assert.equal(
      rebornSpot(starts, own, (at) => at.x === own.x),
      starts[0],
      "player 1's start, facing its own way",
    );
    assert.equal(rebornSpot(starts, own, () => true), own, 'inside something — too bad');
  });

  test("the fog stands 20 units ahead of the spot, on the spot's floor", () => {
    const { world } = room([ThingType.playerStart, 2, 90]);
    const spot = coopStarts(world)[0]!;
    const layer = fxLayer({ fogVisible: () => true });
    layer.beginLevel(world);
    layer.spawnArrivalFog(spot, world.floorAt(spot.x, spot.y));
    const [fog] = layer.snapshotTeleportFogs();
    assert.ok(Math.abs(fog.x - spot.x) < 1e-9);
    assert.ok(Math.abs(fog.y - (spot.y + 20)) < 1e-9);
    assert.equal(fog.z, world.floorAt(spot.x, spot.y));
  });
});
