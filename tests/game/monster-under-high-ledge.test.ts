import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World, MAX_STEP_UP } from '../../src/game/world.ts';
import type { MonsterBody } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos3 } from '../../src/types.ts';
import { chaseFor, monsterBody } from '../fixtures/monsterbody.ts';

/**
 * A monster standing beside a ledge taller than a step levitated onto it the moment it woke:
 * `settleVertical` rested the body on the box-wide `groundFloor`, which counted an opening bottom
 * no `P_TryMove` would ever have let it climb, and the dropoff rule then measured every step back
 * down against that ledge and refused it. The monster spent the rest of the level hovering a
 * ledge's height over the floor. See docs/movement.md § Collision.
 *
 * **Repro: DOOM1 E1M1**, the shotgun guys authored at (240, -3376) and (240, -3088). They stand in
 * sector 24, floor -8; the platforms beside them (sectors 44 and 45) are at 40, and their 20-unit
 * box overlaps those platforms' linedefs by 4 units where the map puts them. The grid below is
 * that geometry in round numbers.
 */

const ROOM_FLOOR = 0;
const CEILING = 200;
/** Taller than a step, as E1M1's 48 is: the ledge the monster must not be lifted onto. */
const LEDGE = 48;
const CELL = 128;

const stats = MONSTER_STATS[ThingType.shotgunGuy];

/** The monster this far into the ledge's cell — `overlap` units of its box over the ledge line. */
function beside(overlap: number): { world: World; body: MonsterBody; target: Pos3; edge: number } {
  const grid = gridMap(
    [
      '#####',
      '#..L#',
      '#..L#',
      '#..L#',
      '#####',
    ],
    { cell: CELL, heights: { L: { floor: LEDGE, ceil: CEILING } } },
  );
  const world = new World(grid.map);
  const at = grid.centre(3, 2);
  const edge = at.x - CELL / 2;
  const x = edge - stats.radius + overlap;
  return {
    world,
    // Spawned as `pushThing` spawns one: on the floor under its own centre.
    body: monsterBody({ x, y: at.y, z: ROOM_FLOOR }),
    target: { x: grid.centre(1, 2).x, y: at.y, z: ROOM_FLOOR }, // west, on the room floor
    edge,
  };
}

function chase(f: ReturnType<typeof beside>, seconds: number, each?: (tic: number) => void): void {
  chaseFor(f.body, stats, f.world, f.target, seconds, { blockersFor: () => [], each });
}

describe('Monster AI · a monster standing under a ledge taller than a step', () => {
  test('the fixture holds the straddle the bug needs', () => {
    const f = beside(4);
    assert.equal(f.world.floorAt(f.body.x, f.body.y), ROOM_FLOOR, 'its centre is over the room floor');
    // The box-wide floor — what the body used to be rested on, and what the geometry still says.
    assert.equal(f.world.groundFloor(f.body.x, f.body.y, stats.radius, true), LEDGE, 'its box spans the ledge');
    assert.ok(LEDGE - ROOM_FLOOR > MAX_STEP_UP, `${LEDGE} is more than a ${MAX_STEP_UP}-unit step`);
  });

  test('the ledge does not hold up a body that could not have climbed it', () => {
    const f = beside(4);
    assert.equal(
      f.world.groundFloor(f.body.x, f.body.y, stats.radius, true, ROOM_FLOOR),
      ROOM_FLOOR,
      'asked with the feet, the same box rests on the room floor',
    );
  });

  test('it stays on the floor instead of levitating onto the ledge', () => {
    const f = beside(4);
    chase(f, 4, (tic) => assert.equal(f.body.z, ROOM_FLOOR, `left the floor at tic ${tic}`));
  });

  test('and walks off toward its target rather than freezing over the ledge', () => {
    const f = beside(4);
    const startX = f.body.x;
    chase(f, 4);
    assert.ok(f.body.x < startX - stats.radius, `expected it to head west, moved to ${f.body.x.toFixed(1)}`);
  });

  test('it still cannot climb the ledge from the floor', () => {
    // The half that must not move: the step-up gate is vanilla's and refuses this ledge whatever
    // the body's box already spans.
    const f = beside(4);
    f.target = { x: f.edge + CELL, y: f.body.y, z: LEDGE }; // on top of the ledge, so it keeps pressing
    chase(f, 6, (tic) => {
      assert.equal(f.body.z, ROOM_FLOOR, `climbed the ledge at tic ${tic}`);
      assert.ok(f.body.x <= f.edge, `centre crossed the ledge line at tic ${tic}`);
    });
  });
});
