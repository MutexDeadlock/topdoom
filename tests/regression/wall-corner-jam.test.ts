import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap, type GridMap } from '../fixtures/gridmap.ts';
import { World, circleBlocked, slideMove } from '../../src/game/world.ts';
import { PLAYER_RADIUS } from '../../src/game/player.ts';
import type { Pos2 } from '../../src/types.ts';

/**
 * Pressing straight into a wall's *end* — the outside corner of a lift entrance,
 * a doorway, a step — froze the player completely: forward dead, backing off and
 * strafing fine. `roundCorner` is the fix. See docs/movement.md § slideMove.
 */

/**
 * A wall block in the south-west corner, open everywhere else — so its own
 * north-east corner sticks out into walkable floor, with the lane the player
 * wants running west along its north face.
 */
function scene(): { world: World; grid: GridMap; corner: Pos2 } {
  const grid = gridMap(['..', '#.']);
  return { world: new World(grid.map), grid, corner: { x: grid.cell, y: grid.cell } };
}

/** Diagonally clear of the corner by a whisker: legal to stand, but a step west is not. */
function atCorner(corner: Pos2): Pos2 {
  const clearance = PLAYER_RADIUS / Math.SQRT2 + 0.09;
  return { x: corner.x + clearance, y: corner.y + clearance };
}

describe('Regressions · a circle pressed into a wall corner', () => {
  test('the fixture puts the player against the corner, not against a wall face', () => {
    const { world, corner } = scene();
    const at = atCorner(corner);
    assert.equal(circleBlocked(world, at.x, at.y, PLAYER_RADIUS, 0), false, 'starts somewhere legal');
    assert.ok(circleBlocked(world, at.x - 8, at.y, PLAYER_RADIUS, 0), 'and a step due west is refused');
  });

  test('pushing along the wall past its end rounds the corner and carries on down the lane', () => {
    const { world, corner } = scene();
    const start = atCorner(corner);
    let at: Pos2 = start;

    at = slideMove(world, { ...at, z: 0 }, -8, 0, PLAYER_RADIUS);
    assert.ok(Math.hypot(at.x - start.x, at.y - start.y) > 1, 'the very first step must make real progress');

    for (let i = 0; i < 39; i++) at = slideMove(world, { ...at, z: 0 }, -8, 0, PLAYER_RADIUS);
    assert.ok(at.x < corner.x - PLAYER_RADIUS, `must end up west of the corner, got x=${at.x}`);
    assert.ok(at.y >= corner.y + PLAYER_RADIUS, `must round it to the north, not cut through, got y=${at.y}`);
    assert.equal(circleBlocked(world, at.x, at.y, PLAYER_RADIUS, 0), false);
  });

  /**
   * The "came up empty" gate must be a share of the requested move, not exact
   * zero — a microscopic cross-axis velocity residue otherwise "succeeds" by a
   * hair each tic and masks the jam. docs/movement.md § slideMove.
   */
  test('a microscopic cross-axis residue does not mask the jam', () => {
    const { world, corner } = scene();
    const start = atCorner(corner);
    const after = slideMove(world, { ...start, z: 0 }, -8, 2e-7, PLAYER_RADIUS);
    assert.ok(Math.hypot(after.x - start.x, after.y - start.y) > 1, 'must round the corner, not creep by 2e-7');
    assert.equal(circleBlocked(world, after.x, after.y, PLAYER_RADIUS, 0), false);
  });

  /**
   * The guard against over-correcting: rounding is only ever reached once the
   * projection *and* the stairstep have both come up empty, so a wall's length
   * still stops a body dead the way vanilla's does.
   */
  test('a head-on push into a wall face still stops dead', () => {
    const { world, grid } = scene();
    // Mid-span of the map's southern edge, well clear of either end of it.
    const start = { x: grid.centre(1, 1).x, y: PLAYER_RADIUS + 0.05 };
    const after = slideMove(world, { ...start, z: 0 }, 0, -8, PLAYER_RADIUS);
    assert.deepEqual(after, start, 'nothing to round, nothing to slide along');
  });

  test('an ordinary diagonal slide along a wall face is untouched', () => {
    const { world, grid } = scene();
    const start = { x: grid.centre(1, 1).x, y: PLAYER_RADIUS + 0.05 };
    // South-east into the southern wall: the southward half is lost, the eastward half survives.
    const after = slideMove(world, { ...start, z: 0 }, 6, -6, PLAYER_RADIUS);
    assert.ok(Math.abs(after.x - (start.x + 6)) < 1e-6, 'keeps the along-wall component');
    assert.equal(after.y, start.y, 'and loses the into-wall one');
  });
});
