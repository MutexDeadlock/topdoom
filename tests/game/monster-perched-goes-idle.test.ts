import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World, MAX_STEP_UP, makeCollider, makePositionCheck } from '../../src/game/world.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { thingLayer } from '../fixtures/spritestubs.ts';

/**
 * A monster perched on a ledge corner — its box on the ledge, its centre over the floor more than a
 * step below — that lost its target and went idle was put down on its centre's floor, under the
 * ledge its box still overlapped. Every step from there climbs the ledge, so it never moved again.
 * The idle branches rest it on its box's floor instead. docs/monster-ai.md § Losing the target.
 *
 * **Repro: smax.wad MAP13**, the staircase under sector 97's edge (line 314, floor -40 over sector
 * 49's -72): a revenant at (-1370, 3134) sat at z -72 with its box 18 units onto the ledge.
 */

const stats = MONSTER_STATS[ThingType.revenant];
const CELL = 32;
/** More than a step above the floor, as MAP13's 32 is. */
const LEDGE = 32;
/** The stair the revenant climbs onto the ledge's edge from — a legal step below it. */
const STAIR = 16;
/** How far the revenant's box reaches onto the ledge. */
const OVERLAP = 8;

/** Ledge along the north, floor (west) and stair (east) south of it; the revenant on the stair. */
function ledge() {
  const rows = [
    '##############',
    '#LLLLLLLLLLLL#',
    '#LLLLLLLLLLLL#',
    '#......SSSSSS#',
    '#......SSSSSS#',
    '#......SSSSSS#',
    '##############',
  ];
  const grid = gridMap(rows, {
    cell: CELL,
    heights: { L: { floor: LEDGE, ceil: 256 }, S: { floor: STAIR, ceil: 256 }, '.': { floor: 0, ceil: 256 } },
  });
  const edgeY = grid.centre(1, 3).y + CELL / 2;
  const y = edgeY - stats.radius + OVERLAP;
  const start = thingAt(grid, 1, 5, 1);
  const monster = { ...thingAt(grid, 11, 3, ThingType.revenant), y };
  grid.map.things.push(start, monster);
  const world = new World(grid.map);
  const layer = thingLayer(world);
  const id = layer.monsterById(0) ? 0 : 1;
  return { grid, world, layer, id, y };
}

function standingBlocked(world: World, x: number, y: number, z: number): boolean {
  const collider = makeCollider({ radius: stats.radius, z, height: stats.height, forMonster: true });
  return world.checkPosition(x, y, collider, false, makePositionCheck()).blocked;
}

describe('Monster AI · a perched monster that goes idle', () => {
  test('keeps the ledge its box stands on, and walks off again when woken', () => {
    const { grid, world, layer, id, y } = ledge();
    assert.ok(LEDGE > MAX_STEP_UP, `${LEDGE} is more than a ${MAX_STEP_UP}-unit step`);
    const target: Pos3 = { ...grid.centre(1, 3), y, z: 0 };
    layer.damage(id, 1, { from: target });
    // Walk west along the ledge's edge until the centre is over the low floor.
    const floorEast = grid.centre(6, 3).x + CELL / 2 - stats.radius;
    for (let tic = 0; tic < 35 * 5 && layer.monsterById(id)!.x > floorEast; tic++) {
      layer.update(DOOM_TIC, [target]);
    }
    const perched = layer.monsterById(id)!;
    assert.ok(perched.x <= floorEast, `it reached the low floor, x ${perched.x.toFixed(1)}`);
    assert.equal(world.floorAt(perched.x, perched.y), 0, 'its centre is over the floor');
    assert.equal(perched.z, LEDGE, 'its box holds it up on the ledge');

    // The target is gone: the revenant gives up and idles where it stands.
    layer.update(DOOM_TIC, [null]);
    layer.update(DOOM_TIC, [null]);
    const idle = layer.monsterById(id)!;
    assert.equal(idle.z, LEDGE, 'still on the ledge, not sunk to its centre floor');
    assert.ok(!standingBlocked(world, idle.x, idle.y, idle.z), 'where it stands is a legal position');

    const at = { x: idle.x, y: idle.y };
    layer.damage(id, 1, { from: target });
    for (let tic = 0; tic < 35 * 2; tic++) layer.update(DOOM_TIC, [target]);
    const woken = layer.monsterById(id)!;
    assert.ok(Math.hypot(woken.x - at.x, woken.y - at.y) > 16, 'woken again, it walks');
  });
});
