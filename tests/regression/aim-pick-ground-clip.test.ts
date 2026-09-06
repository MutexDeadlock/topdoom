import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { vecLength } from '../../src/util/geom.ts';
import { rayThrough } from '../fixtures/aimray.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * Auto-aim's pick ray is bounded where it passes into the ground past the pointer's own aim point
 * (`World.groundReach`, docs/combat.md § Auto-aim). Repro: NUTS.WAD MAP01 from the raised walkway
 * at (1024, -559), where the unbounded ray ran on under the walkway and locked monsters in the
 * crowd 400-1400 units off, up to 180° from the pointer — and the lock aims the shot and turns
 * the player.
 */

/** The walkway's floor, and the aim plane over it — `AIM_HEIGHT_OFFSET` above the player's feet. */
const LEDGE = 300;
const AIM_Z = LEDGE + 36;
/** Chest height on the ground below, well inside the imp's body. */
const CHEST = 28;

/**
 * A raised walkway (`P`, floor 300) with open ground beyond it and an imp out on that ground —
 * NUTS.WAD's shape in miniature. The camera sits on the backward extension of the aim point → imp
 * line, so the two stand on **one screen pixel** and only the ground bound separates them.
 */
function ledge() {
  const grid = gridMap(['#############', '#PPPPPP.....#', '#############'], {
    cell: 128,
    heights: { P: { floor: LEDGE, ceil: 800 }, '.': { floor: 0, ceil: 800 } },
  });
  grid.map.things.push(thingAt(grid, 1, 1, 1), thingAt(grid, 10, 1, ThingType.imp));
  const world = new World(grid.map);
  const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
  const row = grid.centre(1, 1).y;
  const onLedge = { x: grid.centre(2, 1).x, y: row, z: AIM_Z };
  const impChest = { x: grid.centre(10, 1).x, y: row, z: CHEST };
  return { grid, world, layer, row, onLedge, impChest, camera: behind(onLedge, impChest, 700) };
}

/** `dist` units back along the line from `at` through `beyond` — where a camera aiming so looks from. */
function behind(at: Pos3, beyond: Pos3, dist: number): Pos3 {
  const len = vecLength(vecLength(beyond.x - at.x, beyond.y - at.y), beyond.z - at.z);
  return {
    x: at.x - ((beyond.x - at.x) / len) * dist,
    y: at.y - ((beyond.y - at.y) / len) * dist,
    z: at.z - ((beyond.z - at.z) / len) * dist,
  };
}

describe('Auto-aim · the pick ray stops where it enters the ground', () => {
  test('a body out past the walkway the pointer is on is not what the pointer is over', () => {
    const { layer, onLedge, impChest, camera } = ledge();
    // The ray meets the walkway's floor a cell past the aim point and runs under it from there;
    // the imp it goes on to cross stands on the ground beyond the walkway's edge.
    assert.equal(layer.pickMonster(rayThrough(camera, impChest), impChest)?.type, ThingType.imp, 'same ray');
    assert.equal(layer.pickMonster(rayThrough(camera, onLedge), onLedge), null, 'the aim point is on the walkway');
  });

  test('the ray is stopped at the first line past the floor it met, one crossing late', () => {
    const { world, onLedge, camera, grid } = ledge();
    const slope = (onLedge.z - camera.z) / (onLedge.x - camera.x);
    // The trace tests line crossings only, so it stops at the cell boundary after the flat the ray
    // actually met — one crossing late, inside the walkway, where no body's box reaches.
    const metFloor = camera.x + (LEDGE - camera.z) / slope;
    const reach = world.groundReach(camera, onLedge);
    const stopX = camera.x + ((onLedge.x - camera.x) / vecLength(onLedge.x - camera.x, onLedge.z - camera.z)) * reach;
    assert.ok(stopX > metFloor, `stopped at x ${stopX.toFixed(0)}, past the floor it met at ${metFloor.toFixed(0)}`);
    assert.ok(stopX - metFloor < grid.cell, 'and no further than one cell past it');
    assert.ok(stopX < grid.centre(6, 1).x + 64, 'well short of the walkway’s own east edge');
  });

  test('nothing between the camera and the aim point is tested', () => {
    const { grid, layer, row, impChest } = ledge();
    // A low camera looking along the walkway: the ray crosses its east edge *below* the walkway's
    // floor, so a bound measured from the camera would refuse the imp beyond it.
    const camera = { x: grid.centre(1, 1).x, y: row, z: LEDGE + 90 };
    const edgeX = grid.centre(6, 1).x + 64;
    const atEdge =
      camera.z + ((impChest.z - camera.z) / (impChest.x - camera.x)) * (edgeX - camera.x);
    assert.ok(atEdge < LEDGE, `the ray is at ${atEdge.toFixed(0)} over the walkway's edge, under its floor of ${LEDGE}`);
    assert.equal(layer.pickMonster(rayThrough(camera, impChest), impChest)?.type, ThingType.imp);
  });
});
