import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { MAX_STEP_UP, World, positionBlocked } from '../../src/game/world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';

/**
 * A raised lift could be walked off into a neighbor whose ceiling sits far
 * *below* the lift's floor — the player ended up standing inside solid
 * geometry. The line-opening test had only two of `P_TryMove`'s three height gates,
 * missing `tmceilingz - thing->z < thing->height` ("mobj must lower itself to
 * fit"), which is the only one that fires here. Reported against DOOM2 MAP06
 * line 359: the lift (sector 122) parked up at 40, against sector 118's
 * ceiling at -440. See docs/movement.md § Collision.
 */

/** Pit floor and low-ceilinged crawlspace, both reachable only from the pit floor. */
const PIT_FLOOR = -512;
const CRAWL_CEIL = -440;
const LIFT_FLOOR = 40;

/**
 * Two cells: open pit, and a crawlspace whose ceiling is 72 above the shared
 * floor. MAP06 puts an 8-unit strip of pit between the lift's edge and the
 * crawlspace, which is what lets a circle standing at lift height straddle the
 * crawlspace's own linedef; the fixture reproduces that straddle directly.
 */
function scene(): { world: World; x: number; y: number } {
  const grid = gridMap(['pc'], {
    heights: { p: { floor: PIT_FLOOR, ceil: 184 }, c: { floor: PIT_FLOOR, ceil: CRAWL_CEIL } },
  });
  const world = new World(grid.map);
  // Just inside the pit cell, close enough that the circle spans the boundary.
  return { world, x: grid.cell - 4, y: grid.centre(0, 0).y };
}

describe('Regressions · a low-ceilinged neighbor blocks a body standing above it', () => {
  test('neither pre-existing gate can account for the block', () => {
    const { world, x, y } = scene();
    // The opening is a full player tall, and crossing into it is a step *down*,
    // so this is the third gate or nothing.
    assert.ok(CRAWL_CEIL - PIT_FLOOR >= PLAYER_HEIGHT, 'opening is tall enough to stand in');
    assert.ok(PIT_FLOOR - LIFT_FLOOR <= MAX_STEP_UP, 'no step up into it');
    assert.equal(world.groundCeiling(x, y, PLAYER_RADIUS), CRAWL_CEIL, 'the circle really straddles it');
  });

  test('blocked at lift height', () => {
    const { world, x, y } = scene();
    assert.ok(positionBlocked(world, x, y, PLAYER_RADIUS, LIFT_FLOOR, PLAYER_HEIGHT), 'must not walk off the raised lift');
  });

  test('free on the pit floor, which is the way through', () => {
    const { world, x, y } = scene();
    assert.ok(!positionBlocked(world, x, y, PLAYER_RADIUS, PIT_FLOOR, PLAYER_HEIGHT), 'the crawl-through must stay open');
  });

  test('blocked while still airborne above the opening', () => {
    const { world, x, y } = scene();
    // Mid-fall the player's feet are above the opening's top by more than a
    // body height, which vanilla refuses the same way.
    assert.ok(positionBlocked(world, x, y, PLAYER_RADIUS, CRAWL_CEIL - PLAYER_HEIGHT + 1, PLAYER_HEIGHT), 'no room to fit yet');
    assert.ok(!positionBlocked(world, x, y, PLAYER_RADIUS, CRAWL_CEIL - PLAYER_HEIGHT, PLAYER_HEIGHT), 'exactly fits');
  });
});
