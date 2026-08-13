import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World, positionBlocked } from '../../src/game/world.ts';
import { MONSTER_STATS } from '../../src/game/monsters/defs.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import type { MonsterBody } from '../../src/game/monsters/defs.ts';
import { ThingType } from '../../src/game/thingtypes.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * A zombieman placed flush against a wall woke and shot but never took a step.
 * Its spawn point sits *inside* its own radius, so every per-frame sub-step out
 * of the overlap read as blocked even though `tryWalk` had just proved the full
 * chase step lands clear. Vanilla never sees this: `P_Move` tests only the
 * destination. DOOM2 MAP02's zombieman at (1056, 960) is the reported case;
 * 94 monsters across DOOM/DOOM2/SCYTHE spawn this way. See docs/monster-ai.md
 * § Movement.
 */

const stats = MONSTER_STATS[ThingType.zombieman];

/** Big enough that a whole chase step plus the monster's radius stays inside one cell. */
const CELL = 128;

/**
 * One open row with a wall at each end. The monster starts hard against the
 * left wall, the target sits well clear to the east.
 */
function scene(overlap: number): { world: World; body: MonsterBody; target: { x: number; y: number; z: number } } {
  const grid = gridMap(['#....#'], { cell: CELL });
  const world = new World(grid.map);
  // The left wall's face is the boundary between cell 0 and cell 1.
  const wallX = CELL;
  const y = grid.centre(1, 0).y;
  const body: MonsterBody = {
    id: 1,
    x: wallX + stats.radius - overlap,
    y,
    z: 0,
    velZ: 0,
    angle: 0,
    attackPause: 0,
    burstLeft: 0,
    burstTimer: 0,
    chargeTimer: 0,
    chargeAngle: 0,
    painTimer: 0,
    inFloat: false,
    movedir: 8,
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
  return { world, body, target: { x: grid.centre(4, 0).x, y, z: 0 } };
}

/** Runs `seconds` of AI at the simulation's own tic rate and reports how far the monster actually travelled. */
function travelled(world: World, body: MonsterBody, target: { x: number; y: number; z: number }, seconds: number): number {
  const startX = body.x;
  const startY = body.y;
  for (let f = 0; f < Math.round(seconds / DOOM_TIC); f++) {
    stepMonsterAI(body, stats, DOOM_TIC, world, target, PLAYER_RADIUS, PLAYER_HEIGHT);
  }
  return Math.hypot(body.x - startX, body.y - startY);
}

describe('Regressions · a monster spawned flush against a wall', () => {
  test('the fixture really does start it inside the wall', () => {
    const { world, body } = scene(4);
    assert.ok(
      positionBlocked(world, body.x, body.y, stats.radius, body.z, true),
      'its own spawn point is blocked — otherwise this test proves nothing',
    );
  });

  test('it walks out of the overlap instead of standing still, at any overlap up to one chase step', () => {
    for (const overlap of [1, 4, 7]) {
      const { world, body, target } = scene(overlap);
      assert.ok(travelled(world, body, target, 2) > 32, `overlap of ${overlap}: must cover real ground in two seconds`);
      assert.equal(
        positionBlocked(world, body.x, body.y, stats.radius, body.z, true),
        false,
        `overlap of ${overlap}: must end up clear of the wall`,
      );
    }
  });

  /**
   * The reach of the escape hatch is exactly one chase step, because that is
   * the move `tryWalk` validates — the same bound vanilla's `P_TryWalk` has.
   * A monster buried deeper has no legal 8-way step at all and stays put in
   * vanilla too. 89 of the 95 overlapping monsters in DOOM/DOOM2/SCYTHE are
   * inside the bound; the six that aren't are the wide types (mancubus,
   * spectre) whose radius leaves them no room.
   */
  test('one step is the bound, and past it the monster legitimately stays put', () => {
    const step = stats.speed * stats.chaseInterval;
    assert.ok(step > 7 && step < 8, `a zombieman moves ${step} units per chase call`);

    // The inside half of the bracket is the overlap-7 case in the test above.
    const tooDeep = scene(9);
    assert.equal(travelled(tooDeep.world, tooDeep.body, tooDeep.target, 2), 0, 'no legal step exists');
    assert.equal(tooDeep.body.movedir, 8, 'DI_NODIR — newChaseDir found nothing, as in vanilla');
  });

  // The guard against over-correcting — a monster wedged into a space smaller
  // than itself must not walk out through the wall — lives in
  // `monster-substep-blocked-midway.test.ts`. It is the same code path for both
  // fixes: every `tryWalk` fails, `newChaseDir` leaves `movedir` at `DI_NODIR`,
  // and the movement block neither escape hatch sits in is skipped entirely.

  test('an ordinary monster in the open is unaffected', () => {
    const grid = gridMap(['#.....#'], { cell: CELL });
    const world = new World(grid.map);
    const { body } = scene(0);
    const start = grid.centre(1, 0);
    body.x = start.x;
    body.y = start.y;
    assert.equal(
      positionBlocked(world, body.x, body.y, stats.radius, 0, true),
      false,
      'starts clear, so the escape hatch never applies',
    );
    assert.ok(travelled(world, body, { x: grid.centre(5, 0).x, y: start.y, z: 0 }, 2) > 32);
  });
});
