import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AIM_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { SHOT_ROOM as GRID, impBody, shotRig } from '../fixtures/shotrig.ts';

/**
 * A locked-on pellet used to take the distance to its target as its range, so one the spread threw
 * off the body stopped in mid-air beside it: every tracer of a shotgun blast ended at the clicked
 * monster, its puff hung there, and nothing behind the target could be hit. `P_LineAttack` sends
 * each bullet its full range whatever `P_BulletSlope` found. See docs/combat.md § Range.
 */

const IMP = MONSTER_STATS[ThingType.imp];

const SHOOTER = GRID.centre(1, 3);
/** The far wall's face, where a pellet nothing else stops ends. */
const WALL_X = GRID.centre(9, 3).x + GRID.cell / 2;
/** Off the aim by enough to clear an imp three cells out: 384 · sin 0.15 ≈ 57 units to the side. */
const STRAY = 0.15;

describe('Regressions · a locked-on pellet flies its full range', () => {
  test('a pellet the spread throws off the locked body flies on to the far wall', () => {
    const target = impBody(1, GRID.centre(4, 3));
    const { damaged, tracers, fire } = shotRig(GRID, SHOOTER, [target]);
    fire(STRAY, target);

    assert.deepEqual(damaged, [], 'it missed the target');
    assert.equal(tracers.length, 1);
    assert.ok(Math.abs(tracers[0].x - WALL_X) < 1e-6, `expected the wall at ${WALL_X}, ended at ${tracers[0].x}`);
  });

  test('that pellet strikes a monster standing behind the target on its line', () => {
    const target = impBody(1, GRID.centre(4, 3));
    const behind = impBody(2, { x: SHOOTER.x + Math.cos(STRAY) * 640, y: SHOOTER.y + Math.sin(STRAY) * 640 });
    const { damaged, tracers, fire } = shotRig(GRID, SHOOTER, [target, behind]);
    fire(STRAY, target);

    assert.deepEqual(damaged, [2]);
    assert.ok(tracers[0].x > target.x + IMP.radius, 'the tracer ends past the target, at the body it hit');
  });

  test('a pellet on the body still stops there, its blood at the fired slope where it struck', () => {
    const target = impBody(1, GRID.centre(4, 3));
    const { damaged, blood, tracers, fire } = shotRig(GRID, SHOOTER, [target]);
    fire(0, target);

    assert.deepEqual(damaged, [1]);
    assert.ok(Math.abs(tracers[0].x - target.x) < 1e-6, 'the tracer ends on the body');
    // Nothing narrows the wedge in open floor, so the shot is aimed at the body's centre.
    const centre = target.z + IMP.height / 2;
    assert.ok(Math.abs(blood[0].z - centre) < 1e-6, `blood at ${blood[0].z}, expected ${centre}`);
    assert.ok(Math.abs(tracers[0].z - centre) < 1e-6, `tracer end at ${tracers[0].z}, expected ${centre}`);
    assert.notEqual(AIM_HEIGHT_OFFSET, centre, 'the aim is not flat, so the height is a real check');
  });
});
