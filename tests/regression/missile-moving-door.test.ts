import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECTILE_RADIUS } from '../../src/game/spritefx/tables.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { rocket, shotRig } from '../fixtures/shotrig.ts';

/**
 * A straight missile's flight used to end at the wall its launch-time trace found, with the floor
 * and ceiling sampled only where each tic's step ended. A door that opened under a rocket fired at
 * it left the rocket bursting in mid-air where the door had been, and a 16-unit door that shut in
 * front of one let it through whenever a 20-unit step jumped the door's sector. `P_XYMovement`
 * tries every move against the lines as they stand that tic. See docs/combat.md § Where an impact
 * sits.
 */

const CELL = 8;
const COLS = 120;
const DOOR_COL = 60;
/** Two cells: a 16-unit door, thinner than a rocket's 20-unit step. */
const DOOR_CELLS = 2;
const ROW = '#' + '.'.repeat(DOOR_COL - 1) + 'D'.repeat(DOOR_CELLS) + '.'.repeat(COLS - DOOR_COL - DOOR_CELLS - 1) + '#';
const GRID = gridMap(['#'.repeat(COLS), ROW, ROW, ROW, '#'.repeat(COLS)], {
  cell: CELL,
  heights: { D: { floor: 0, ceil: 128 } },
});
const DOOR_FACE = DOOR_COL * CELL;
const FAR_WALL = (COLS - 1) * CELL;
const STANDOFF = PROJECTILE_RADIUS.MISL;
const ROCKET = rocket();
/** Every whole-unit launch position across one rocket step, so no step phase goes untried. */
const OFFSETS = Array.from({ length: 20 }, (_, i) => i);

/** One rocket fired east, the door's ceiling at `before` on launch and at `after` from tic 3. */
function burstX(offset: number, before: number, after: number): number {
  const start = GRID.centre(1, 2);
  const rig = shotRig(GRID, { x: start.x + offset, y: start.y }, []);
  const door = [1, 2, 3].flatMap((row) => Array.from({ length: DOOR_CELLS }, (_, i) => GRID.index(DOOR_COL + i, row)));
  const setDoor = (ceil: number) => {
    for (const s of door) rig.world.map.sectors[s].ceilHeight = ceil;
  };
  setDoor(before);
  rig.launch(ROCKET, null);
  rig.fly((tic) => {
    if (tic === 3) setDoor(after);
  });
  assert.equal(rig.impacts.length, 1, 'one explosion');
  return rig.impacts[0].x;
}

describe('Regressions · a missile meets a door as it stands when it gets there', () => {
  test('a door that shuts in front of a rocket stops it at the door, whatever the step phase', () => {
    for (const offset of OFFSETS) {
      const x = burstX(offset, 128, 0);
      assert.ok(x <= DOOR_FACE && x >= DOOR_FACE - STANDOFF, `launched ${offset} in, burst at ${x}`);
    }
  });

  test('a door that opens before the rocket gets there lets it fly on to the far wall', () => {
    for (const offset of OFFSETS) {
      const x = burstX(offset, 0, 128);
      assert.ok(Math.abs(x - (FAR_WALL - STANDOFF)) < 1e-6, `launched ${offset} in, burst at ${x}`);
    }
  });
});
