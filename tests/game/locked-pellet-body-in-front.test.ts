import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOT_ROOM as GRID, impBody, shotRig } from '../fixtures/shotrig.ts';

/**
 * A pellet that passed its lock test used to count as a hit on the clicked monster without the
 * bodies on its line ever being traced, so a click shot straight through whatever stood in front of
 * the target — a screen of zombies, a barrel, a player. `PTR_ShootTraverse` walks a trace's
 * intercepts nearest-first. See docs/combat.md § How a shot deals damage.
 */

const SHOOTER = GRID.centre(1, 3);
const EAST = 0;

describe('Combat · a body in front of a locked-on target takes the pellet', () => {
  test('a body standing on the line in front of the target is hit instead of it', () => {
    const front = impBody(1, GRID.centre(3, 3));
    const target = impBody(2, GRID.centre(5, 3));
    const { damaged, tracers, fire } = shotRig(GRID, SHOOTER, [front, target]);
    fire(EAST, target);

    assert.deepEqual(damaged, [1]);
    assert.ok(tracers[0].x < target.x - target.radius, 'the tracer ends at the body in front');
  });

  test('a body a row beside the line leaves the target to take it', () => {
    const beside = impBody(1, GRID.centre(3, 2));
    const target = impBody(2, GRID.centre(5, 3));
    const { damaged, tracers, fire } = shotRig(GRID, SHOOTER, [beside, target]);
    fire(EAST, target);

    assert.deepEqual(damaged, [2]);
    assert.ok(Math.abs(tracers[0].x - target.x) < 1e-6, 'the tracer ends on the target');
  });

  test('a locked target in front of another body still takes the pellet itself', () => {
    const target = impBody(1, GRID.centre(3, 3));
    const behind = impBody(2, GRID.centre(5, 3));
    const { damaged, fire } = shotRig(GRID, SHOOTER, [target, behind]);
    fire(EAST, target);

    assert.deepEqual(damaged, [1]);
  });
});
