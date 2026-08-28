import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World, type ThingBlocker } from '../../src/game/world.ts';
import { DIR_X, DIR_Y, DI_NODIR, type MonsterBody } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * A monster whose *approved* chase step lands clear, but whose per-tic sub-step
 * along the way does not, stood still forever: the sub-step set `moveBlocked`,
 * the next chase call re-routed, `tryWalk` approved the very same direction
 * again because the destination really is clear, and round it went. Reported on
 * DOOM2 MAP06 — a demon at (-68, 482) in the pit below the player, whose radius
 * grazes the wedge corner at (-64, 512) for the first 7 units of a 10-unit step.
 *
 * The sub-step is this engine's own; vanilla's `P_Move` judges a move on its
 * destination and on nothing in between. See docs/monster-ai.md § Movement.
 *
 * The fixture reproduces the same shape against a solid body rather than that
 * map's slanted geometry, which the ASCII grid cannot express: a monster walking
 * diagonally clips the corner of a blocker's box (`PIT_CheckThing` is an
 * axis-aligned box on the summed radii) and is clear of it again one step later.
 * A blocker that never moves — any `SOLID_DECORATION_TYPES` prop — froze the
 * monster just as permanently as the map corner did.
 */

const stats = MONSTER_STATS[ThingType.demon];

/** Sum of the two radii: the half-width of `blockedByThings`' box for this pair. */
const REACH = stats.radius + 20;

/**
 * The blocker sits south-east of the start, just outside the box on x and
 * inside it on y. Walking north-east brings x into the box before y leaves it,
 * so the overlap is a short window part-way along the step rather than
 * something the monster is already standing in or heading straight at.
 */
const BLOCKER_DX = REACH + 1.5;
const BLOCKER_DY = -(REACH - 5.5);

/** North-east, the direction `newChaseDir` takes toward a target up and to the right. */
const NE = 1;

function scene(): { world: World; body: MonsterBody; blockers: ThingBlocker[]; target: { x: number; y: number; z: number } } {
  const grid = gridMap(['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######'], { cell: 128 });
  const world = new World(grid.map);
  const at = grid.centre(3, 3);
  const body: MonsterBody = {
    id: 1,
    x: at.x,
    y: at.y,
    z: 0,
    velZ: 0,
    angle: 0,
    attackPause: 0,
    burstLeft: 0,
    burstTimer: 0,
    swinging: false,
    chargeTimer: 0,
    chargeAngle: 0,
    painTimer: 0,
    inFloat: false,
    movedir: DI_NODIR,
    movecount: 0,
    chaseTimer: 0,
    moveBlocked: false,
    threshold: 0,
    justHit: false,
    justAttacked: false,
    reactionTicks: 0,
    refiring: false,
    homingBias: false,
    walkSoundTimer: 0,
    walkSoundStep: 0,
  };
  return {
    world,
    body,
    blockers: [{ x: at.x + BLOCKER_DX, y: at.y + BLOCKER_DY, z: 0, radius: 20, height: stats.height }],
    // Far to the north-east, so every chase call keeps choosing the diagonal.
    target: { x: at.x + 1000, y: at.y + 1000, z: 0 },
  };
}

describe('Regressions · a sub-step refused part-way through an approved chase step', () => {
  test('the fixture really does block only mid-step', () => {
    const { world, body, blockers } = scene();
    const blockedAt = (travel: number): boolean =>
      world.positionBlocked(body.x + DIR_X[NE] * travel, body.y + DIR_Y[NE] * travel, stats.radius, body.z, stats.height, true, blockers);

    assert.equal(blockedAt(0), false, 'starts clear, so this is not the spawned-inside-a-wall case');
    assert.equal(blockedAt(stats.speed * DOOM_TIC), true, 'one tic along the step is refused');
    assert.equal(blockedAt(stats.speed * stats.chaseInterval), false, 'the whole chase step lands clear');
  });

  test('the monster walks the step instead of freezing against the corner', () => {
    const { world, body, blockers, target } = scene();
    const startX = body.x;
    const startY = body.y;
    for (let tic = 0; tic < Math.round(2 / DOOM_TIC); tic++) {
      stepMonsterAI(body, stats, DOOM_TIC, world, target, PLAYER_RADIUS, PLAYER_HEIGHT, blockers);
    }
    assert.ok(Math.hypot(body.x - startX, body.y - startY) > 100, 'must cover real ground in two seconds');
    assert.equal(
      world.positionBlocked(body.x, body.y, stats.radius, body.z, stats.height, true, blockers),
      false,
      'and must end up clear of the blocker',
    );
  });

  test('it takes exactly the step vanilla would, not a longer one', () => {
    // The fallback is `P_Move`'s own jump, so the monster covers one chase step
    // and no more — overshooting the destination `tryWalk` approved would be a
    // different bug.
    const { world, body, blockers, target } = scene();
    // Already committed to the diagonal, with `movecount` left over, so this
    // tic is pure movement and no chase call runs inside it.
    body.movedir = NE;
    body.movecount = 8;
    const startX = body.x;
    const startY = body.y;
    stepMonsterAI(body, stats, DOOM_TIC, world, target, PLAYER_RADIUS, PLAYER_HEIGHT, blockers);
    const moved = Math.hypot(body.x - startX, body.y - startY);
    // `DIR_X`/`DIR_Y`'s diagonals are vanilla's 0.71716, so a diagonal step is
    // the documented ~1.4% longer than a cardinal one.
    const expected = stats.speed * stats.chaseInterval * Math.hypot(DIR_X[NE], DIR_Y[NE]);
    assert.ok(Math.abs(moved - expected) < 0.01, `moved ${moved.toFixed(2)}, expected one ${expected.toFixed(2)}-unit chase step`);
  });

  test('a monster with nowhere legal to land still refuses to move', () => {
    // The guard against over-correcting, and it covers the escape hatch in
    // `monster-flush-against-wall.test.ts` too: both fallbacks only fire when
    // the full chase step lands clear, so a monster wedged into a space smaller
    // than itself must not walk out through the wall. A 56-unit cell is narrower
    // than the demon's 60-unit diameter.
    const grid = gridMap(['###', '#.#', '###'], { cell: 56 });
    const world = new World(grid.map);
    const { body } = scene();
    const at = grid.centre(1, 1);
    body.x = at.x;
    body.y = at.y;
    assert.ok(world.positionBlocked(body.x, body.y, stats.radius, 0, stats.height, true), 'boxed in');
    for (let tic = 0; tic < Math.round(2 / DOOM_TIC); tic++) {
      stepMonsterAI(body, stats, DOOM_TIC, world, { x: at.x + 400, y: at.y, z: 0 }, PLAYER_RADIUS, PLAYER_HEIGHT);
    }
    assert.equal(body.x, at.x, 'goes nowhere');
    assert.equal(body.y, at.y, 'goes nowhere');
  });
});
