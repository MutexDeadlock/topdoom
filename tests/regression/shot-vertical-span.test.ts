import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, type ThingLayer } from '../../src/game/things.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { AIM_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * `raycastMonster`'s vertical gate used to be a flat band around the fire
 * height (`|body.z - origin.z| > body.height`), which made a body standing
 * below the shooter unreachable however close it was: a mancubus in a pit 64
 * under the ledge sits 96 below the aim height and is only 64 tall, so every
 * trace through this function missed it — the BFG's 40-ray spray, which is that
 * weapon's whole damage, included. It is now `PTR_AimTraverse`'s slope span
 * measured at the body's own distance. See docs/combat.md § The vertical test.
 */

/** Map units per cell, so a body `n` cells east stands exactly `n * CELL` out. */
const CELL = 128;
const EAST = 0;
/** The player's column; the pit runs east of it. */
const FROM = 1;

/**
 * The player on flat floor at 0, one mancubus `col` cells east standing on a
 * floor `pitDepth` below (negative sinks it, as NoSp2 MAP04's pen does).
 */
function scene(pitDepth: number, col: number): { layer: ThingLayer; origin: Pos3; dist: number } {
  const grid = gridMap(['#######', '#.ppppp', '#######'], {
    cell: CELL,
    heights: { p: { floor: pitDepth, ceil: 256 } },
  });
  const map = grid.map;
  map.things.push(thingAt(grid, FROM, 1, 1), thingAt(grid, col, 1, ThingType.mancubus));
  const layer = buildThingSprites(new World(map), { bank: BANK, materials: MATERIALS, skill: 3 });
  const player: Pos3 = { ...grid.centre(FROM, 1), z: 0 };
  // One tic so the layer settles the body onto its floor and marks it seen —
  // `raycastMonster` filters on fog visibility.
  layer.update(DOOM_TIC, [player]);
  return {
    layer,
    origin: { x: player.x, y: player.y, z: player.z + AIM_HEIGHT_OFFSET },
    dist: (col - FROM) * CELL,
  };
}

describe('Regressions · a shot’s vertical span', () => {
  test('a mancubus in a pit below the shooter is still in the trace', () => {
    const { layer, origin } = scene(-64, FROM + 1);
    const hit = layer.raycastMonster(origin, EAST, 1024);
    assert.ok(hit, 'the body 96 below the aim height, one cell out, is reached');
    assert.equal(hit.z, -64, 'and it is the one standing in the pit');
  });

  test('the reach is a cone, so the same drop is out of range near and in range far', () => {
    // 150 down puts the body's top 118 below the aim height: past the cone at
    // one cell (0.92 slope), well inside it at three (0.31). No band around the
    // fire height can tell those two apart.
    const near = scene(-150, FROM + 1);
    const far = scene(-150, FROM + 3);
    assert.equal(near.layer.raycastMonster(near.origin, EAST, 1024), null, `nothing reachable at ${near.dist}`);
    assert.ok(far.layer.raycastMonster(far.origin, EAST, 1024), `the same drop is in the cone at ${far.dist}`);
  });

  test('a caller with a slope of its own gets PTR_ShootTraverse, not the cone', () => {
    const { layer, origin } = scene(0, FROM + 1);
    assert.ok(layer.raycastMonster(origin, EAST, 1024, { slope: 0 }), 'a flat bolt crosses the body');
    assert.equal(
      layer.raycastMonster(origin, EAST, 1024, { slope: -0.5 }),
      null,
      'one aimed down passes under it, though the cone would have admitted it',
    );
  });
});
