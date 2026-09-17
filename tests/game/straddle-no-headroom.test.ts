import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { ANY_HEIGHT, makeCollider, World } from '../../src/game/world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';

/**
 * The player walked onto a straddle of two openings that each fit on their own — one raising the
 * floor, the other lowering the ceiling — and was frozen there for good: `groundFloor` lifted `z`
 * onto the high floor, and from there the low ceiling refused every direction. `checkPosition`
 * asked `P_TryMove`'s "doesn't fit" per opening, where vanilla asks it of the box-wide
 * `tmceilingz - tmfloorz`. See docs/movement.md § Collision.
 *
 * **Repro: rush.wad MAP01** at (936, -1026): line 2118's opening into sector 373 (floor 160,
 * ceiling 224) and the 8×8 step sector 381 (floor 184), 24 units apart in sector 215 (floor 152).
 * The grid below is that geometry, one 24-unit column per sector.
 */

const LOW_CEIL_FLOOR = 160;
const LOW_CEIL = 224;
const ROOM_FLOOR = 152;
const STEP_FLOOR = 184;
const CEILING = 256;
const CELL = 24;

function scene(): { world: World; y: number; lowLine: number; stepLine: number } {
  const grid = gridMap(
    [
      '#####',
      '#nas#',
      '#nas#',
      '#nas#',
      '#####',
    ],
    {
      cell: CELL,
      heights: {
        n: { floor: LOW_CEIL_FLOOR, ceil: LOW_CEIL },
        a: { floor: ROOM_FLOOR, ceil: CEILING },
        s: { floor: STEP_FLOOR, ceil: CEILING },
      },
    },
  );
  const at = grid.centre(2, 2);
  return { world: new World(grid.map), y: at.y, lowLine: at.x - CELL / 2, stepLine: at.x + CELL / 2 };
}

/** The player's box with its feet at `z`. */
const asPlayer = (z: number) => makeCollider({ radius: PLAYER_RADIUS, z, height: PLAYER_HEIGHT });

describe('Collision · two openings that each fit leave no room together', () => {
  test('each opening alone is a legal place to stand', () => {
    const { world, y, lowLine, stepLine } = scene();
    assert.ok(LOW_CEIL - LOW_CEIL_FLOOR >= PLAYER_HEIGHT && CEILING - STEP_FLOOR >= PLAYER_HEIGHT, 'both openings fit');
    assert.ok(LOW_CEIL - STEP_FLOOR < PLAYER_HEIGHT, 'the window between them does not');
    assert.ok(!world.positionBlocked(lowLine + 4, y, asPlayer(LOW_CEIL_FLOOR)), 'over the low-ceiling line only');
    assert.ok(!world.positionBlocked(stepLine - 4, y, asPlayer(STEP_FLOOR)), 'over the step line only');
  });

  test('the box spanning both is refused, at either floor and for the geometry alone', () => {
    const { world, y, lowLine } = scene();
    const x = lowLine + CELL / 2;
    assert.ok(world.positionBlocked(x, y, asPlayer(LOW_CEIL_FLOOR)));
    assert.ok(world.positionBlocked(x, y, asPlayer(STEP_FLOOR)));
    assert.ok(world.positionBlocked(x, y, asPlayer(ANY_HEIGHT)));
  });

  test('walking into it stops short, on the floor, and can walk back', () => {
    const { world, y, lowLine } = scene();
    const body = { x: lowLine + 4, y, z: LOW_CEIL_FLOOR };
    // `Player.update`'s move and settle, one unit a tic, pressing east into the step.
    for (let tic = 0; tic < 30; tic++) {
      const moved = world.slideMove(body, 1, 0, PLAYER_RADIUS, []);
      body.x = moved.x;
      body.z = world.groundFloor(body.x, body.y, PLAYER_RADIUS, false, body.z);
      assert.equal(body.z, LOW_CEIL_FLOOR, `lifted onto the step at tic ${tic}`);
      assert.ok(!world.positionBlocked(body.x, body.y, asPlayer(body.z)), `standing somewhere illegal at tic ${tic}`);
    }
    const back = world.slideMove(body, -4, 0, PLAYER_RADIUS, []);
    assert.equal(back.x, body.x - 4, 'the way back is open');
  });

  test('a player inside one crushed sector still walks', () => {
    // The half that must not move: the fit rule spares a player whose box spans no opening —
    // docs/monster-ai.md § Movement.
    const grid = gridMap(['###', '#c#', '###'], { heights: { c: { floor: 0, ceil: 8 } } });
    const world = new World(grid.map);
    const at = grid.centre(1, 1);
    assert.ok(!world.positionBlocked(at.x + 4, at.y, asPlayer(0)));
  });
});
