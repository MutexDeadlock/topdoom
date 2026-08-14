import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap, type GridMap } from '../fixtures/gridmap.ts';
import { SLIDE_FUDGE, World, positionBlocked, slideMove } from '../../src/game/world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import type { Pos2 } from '../../src/types.ts';

/**
 * Pressing straight into a wall's *end* — the outside corner of a lift entrance,
 * a doorway, a step — used to freeze the player completely: forward dead,
 * backing off and strafing fine. It was a collision *circle* coming to rest
 * against the wall's endpoint, out past the wall's own length, where the wall
 * direction is a useless slide direction.
 *
 * A box cannot reach that state: a linedef stops applying once the box no
 * longer overlaps the line's own bounding box, so there is no cap to catch on
 * and no rescue heuristic here to test. What these cases pin is that the jam
 * stays gone. See docs/movement.md § slideMove.
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

/** In the lane, pressed against the north face of the block by a whisker. */
function inLane(corner: Pos2, x: number): Pos2 {
  return { x, y: corner.y + PLAYER_RADIUS + 0.05 };
}

describe('Regressions · a box pressed into a wall corner', () => {
  test('the fixture presses the player against the block, and past its end there is nothing left', () => {
    const { world, corner } = scene();

    const overBlock = inLane(corner, corner.x - 24);
    assert.equal(positionBlocked(world, overBlock.x, overBlock.y, PLAYER_RADIUS, 0, PLAYER_HEIGHT), false, 'legal in the lane');
    assert.ok(positionBlocked(world, overBlock.x, overBlock.y - 1, PLAYER_RADIUS, 0, PLAYER_HEIGHT), 'a step south is refused');

    // The same step one block-width east: the wall has ended, so it is free.
    // This is the geometry the circle used to catch on.
    const pastEnd = inLane(corner, corner.x + 24);
    assert.equal(positionBlocked(world, pastEnd.x, pastEnd.y - 1, PLAYER_RADIUS, 0, PLAYER_HEIGHT), false, 'past the end, nothing blocks');
  });

  test('pushing west past the wall’s end never stalls', () => {
    const { world, corner } = scene();
    const start = inLane(corner, corner.x + 24);
    let at: Pos2 = start;

    // Eight steps carries the box from east of the corner to well west of it,
    // crossing the endpoint that used to freeze it, and stopping short of the
    // map's own west wall.
    for (let i = 0; i < 8; i++) {
      const before = at;
      at = slideMove(world, { ...at, z: 0 }, -8, 0, PLAYER_RADIUS);
      assert.ok(before.x - at.x > 7.99, `step ${i} stalled at x=${at.x}`);
    }

    assert.ok(at.x < corner.x - PLAYER_RADIUS, `must end up west of the corner, got x=${at.x}`);
    assert.equal(at.y, start.y, 'and stay in the lane rather than drifting into the block');
    assert.equal(positionBlocked(world, at.x, at.y, PLAYER_RADIUS, 0, PLAYER_HEIGHT), false);
  });

  test('a microscopic cross-axis residue changes nothing', () => {
    const { world, corner } = scene();
    const start = inLane(corner, corner.x + 24);
    const after = slideMove(world, { ...start, z: 0 }, -8, 2e-7, PLAYER_RADIUS);
    assert.ok(start.x - after.x > 7.99, 'still a full step, not a 2e-7 creep');
    assert.equal(positionBlocked(world, after.x, after.y, PLAYER_RADIUS, 0, PLAYER_HEIGHT), false);
  });

  test('a diagonal clearance the circle used to pass is refused by the box', () => {
    const { world, corner } = scene();
    // Diagonally clear of the corner by a whisker of the *circle's* radius —
    // this was the old fixture's legal standing spot. The box is 16 wide on
    // both axes rather than 16 from the centre in every direction, so it
    // straddles the block's north face here and the position is refused.
    const clearance = PLAYER_RADIUS / Math.SQRT2 + 0.09;
    const at = { x: corner.x + clearance, y: corner.y + clearance };
    assert.ok(positionBlocked(world, at.x, at.y, PLAYER_RADIUS, 0, PLAYER_HEIGHT));
    // Clear on both axes is what it takes now.
    assert.equal(positionBlocked(world, corner.x + PLAYER_RADIUS + 0.05, corner.y + PLAYER_RADIUS + 0.05, PLAYER_RADIUS, 0, PLAYER_HEIGHT), false);
  });

  test('a head-on push into a wall face still stops dead', () => {
    const { world, grid } = scene();
    // Mid-span of the map's southern edge, well clear of either end of it.
    const start = { x: grid.centre(1, 1).x, y: PLAYER_RADIUS + 0.05 };
    const after = slideMove(world, { ...start, z: 0 }, 0, -8, PLAYER_RADIUS);
    assert.deepEqual(after, start, 'nothing to slide along');
  });

  test('an ordinary diagonal slide along a wall face keeps the along-wall component', () => {
    const { world, grid } = scene();
    const start = { x: grid.centre(1, 1).x, y: PLAYER_RADIUS + 0.05 };
    // South-east into the southern wall: the southward half is lost, the eastward half survives.
    const after = slideMove(world, { ...start, z: 0 }, 6, -6, PLAYER_RADIUS);
    assert.equal(after.y, start.y, 'loses the into-wall component');
    // Vanilla's `0x800` back-off stops the move short of the wall it found and
    // only slides the remainder, so one contact costs up to `SLIDE_FUDGE` of the
    // along-wall travel.
    const kept = after.x - start.x;
    assert.ok(kept > 6 * (1 - SLIDE_FUDGE) && kept <= 6, `keeps the along-wall component, got ${kept}`);
  });

  test('a move that reaches the wall part-way commits to it, then slides the rest', () => {
    const { world, grid } = scene();
    // Two units of headroom, so the box travels down onto the wall and then along it.
    const start = { x: grid.centre(1, 1).x, y: PLAYER_RADIUS + 2 };
    const after = slideMove(world, { ...start, z: 0 }, 6, -6, PLAYER_RADIUS);
    assert.ok(Math.abs(after.y - (start.y - 2 + 6 * SLIDE_FUDGE)) < 1e-9, `comes to rest just short of the wall, got y=${after.y}`);
    assert.ok(after.x - start.x >= 6 * (1 - SLIDE_FUDGE) - 1e-9, `and carries on along it, got dx=${after.x - start.x}`);
  });
});
