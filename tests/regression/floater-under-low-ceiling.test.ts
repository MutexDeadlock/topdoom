import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { type MonsterBody } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { monsterBody } from '../fixtures/monsterbody.ts';
import { stepFor } from '../fixtures/tics.ts';

/**
 * A cacodemon whose box straddles a block too short to stand on was pinned to
 * that block's top forever: the flier clamp took the *floor* over the ceiling
 * where the two disagreed, so `settleVertical` shoved it up into the gap, every
 * step out came back `'adjust'` ("must lower itself to fit"), and the descent
 * `floatOverStep` made was undone by the next clamp in the same frame.
 * `P_ZMovement` clamps the ceiling last, so the ceiling wins.
 * See docs/monster-ai.md § Floating monsters.
 *
 * A body standing on the room floor is no longer lifted onto that block at all —
 * a ledge more than a step above a body's feet is not what it rests on
 * (docs/movement.md § Collision) — so the clamp is asked here of a flier that
 * drifted onto the block under its own power, which is the state the bug left
 * behind and the one the clamp order still has to answer.
 *
 * **Repro: DOOM2 MAP29**, the cacodemon at (-112, 1104). Sector 76 is the room
 * (floor 352, ceiling 504) and sector 82 the diagonal `SW1LION` switch block
 * (floor 480, ceiling 504) 24 units from it — closer than the 31-unit radius,
 * so the straddle can never be walked off. The grid below is that geometry with
 * round numbers.
 */

const ROOM_FLOOR = 0;
const CEILING = 160;
/** The block top: high enough that what is left under the ceiling is shorter than the body. */
const BLOCK_TOP = 136;
const CELL = 128;

const CACO = MONSTER_STATS[ThingType.cacodemon];

function loadBlock(type: number = ThingType.cacodemon): { world: World; body: MonsterBody; player: Pos3 } {
  const stats = MONSTER_STATS[type]!;
  const grid = gridMap(
    [
      '#####',
      '#...#',
      '#.B.#',
      '#...#',
      '#...#',
      '#####',
    ],
    {
      cell: CELL,
      heights: {
        '.': { floor: ROOM_FLOOR, ceil: CEILING },
        B: { floor: BLOCK_TOP, ceil: CEILING },
        '#': { floor: 0, ceil: 0 },
      },
    },
  );
  const world = new World(grid.map);
  const block = grid.centre(2, 2);
  // Just south of the block's south edge, closer than the body's own radius —
  // the straddle the whole bug needs, and what MAP29 authors by hand.
  const x = block.x;
  const y = block.y - CELL / 2 - (stats.radius - 7);

  return {
    world,
    player: { x, y: grid.centre(2, 4).y, z: ROOM_FLOOR },
    // At `pushThing`'s spawn height — the *centre* sector's floor — facing the player as
    // `A_FaceTarget` would leave it.
    body: monsterBody({ x, y, z: ROOM_FLOOR }, { angle: -Math.PI / 2 }),
  };
}

/** Steps the monster at a fixed 35 fps for `seconds`. */
function run(f: ReturnType<typeof loadBlock>, seconds: number): void {
  stepFor(seconds, () => stepMonsterAI(f.body, CACO, f.world, { dt: DOOM_TIC, target: f.player, targetRadius: PLAYER_RADIUS, targetHeight: PLAYER_HEIGHT }));
}

describe('Regressions · a floater straddling a block it cannot fit on', () => {
  test('the fixture holds the geometry the tests assume', () => {
    const f = loadBlock();
    // The straddle: the box spans the block's edge, so the box-wide floor is
    // the block top while the centre still stands over the room floor.
    assert.equal(f.world.groundFloor(f.body.x, f.body.y, CACO.radius, true), BLOCK_TOP, 'box floor is the block top');
    assert.equal(f.world.sectorAt(f.body.x, f.body.y)?.floorHeight, ROOM_FLOOR, 'its centre is over the room floor');
    // And what is left over that block top is shorter than the body — the
    // disagreement between the two clamps that the bug resolved the wrong way.
    assert.ok(CEILING - BLOCK_TOP < CACO.height, `${CEILING - BLOCK_TOP} of headroom against a ${CACO.height}-tall body`);
  });

  test('a body on the room floor is not lifted onto the block at all', () => {
    const f = loadBlock();
    run(f, DOOM_TIC);
    assert.equal(f.body.z, ROOM_FLOOR, 'the block is more than a step above its feet');
  });

  test('the ceiling wins over the floor, so a body on the block is never left in the gap', () => {
    const f = loadBlock();
    // Hovering at the block top, which a flier can reach on its own and which is exactly where
    // the bug used to shove it.
    f.body.z = BLOCK_TOP;
    run(f, DOOM_TIC);
    assert.equal(f.body.z, CEILING - CACO.height, 'clamped to the ceiling, below the block top');
  });

  // Both 31-unit fliers, both `MF_FLOAT`, both pinned by the same clamp. The
  // lost soul is deliberately not here: its charge (`MF_SKULLFLY`) moves
  // through its own branch rather than `testStep`, so it launches off the
  // block whatever the clamp does and would pass for the wrong reason.
  for (const [name, type] of [
    ['cacodemon', ThingType.cacodemon],
    ['pain elemental', ThingType.painElemental],
  ] as const) {
    const stats = MONSTER_STATS[type]!;
    test(`a ${name} gets out instead of hanging on the block forever`, () => {
      const f = loadBlock(type);
      const start = { x: f.body.x, y: f.body.y };
      stepFor(3, () => stepMonsterAI(f.body, stats, f.world, { dt: DOOM_TIC, target: f.player, targetRadius: PLAYER_RADIUS, targetHeight: PLAYER_HEIGHT }));
      const moved = Math.hypot(f.body.x - start.x, f.body.y - start.y);
      assert.ok(moved > stats.radius, `left the block (moved ${moved.toFixed(1)} units)`);
      assert.ok(f.body.z <= CEILING - stats.height, `still fits under the ceiling (z = ${f.body.z})`);
    });
  }
});
