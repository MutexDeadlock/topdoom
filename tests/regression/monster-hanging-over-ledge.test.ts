import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import type { MonsterBody } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Pos2, Pos3 } from '../../src/types.ts';
import { ticsIn } from '../fixtures/tics.ts';
import { monsterBody } from '../fixtures/monsterbody.ts';

/**
 * A monster whose box already hangs over a ledge froze solid. Vanilla judges
 * the dropoff rule on the destination alone, so every direction it could
 * shuffle still hung over the same ledge and every one of them was refused —
 * including the ones leading away from it. See docs/monster-ai.md § The
 * dropoff rule for the MBF clipping that replaces it.
 *
 * Reported on DOOM1 E1M5: the alcove in front of the yellow door is 48 units
 * wide against a demon's 60, so a demon in there always straddles the lift line
 * on one side or the door line on the other. With the lift parked down the
 * demon stood frozen until it came back up. The fixture is that shape without
 * the door: a one-cell alcove too narrow for the monster to stand clear of
 * either edge, a solid wall east and a 104-unit pit west.
 */

const stats = MONSTER_STATS[ThingType.demon];
/** Narrow enough that the demon's 60-unit box always spans one edge or the other. */
const CELL = 48;
const PIT_FLOOR = -104;

/** Pit on the west, floor on the east; `open` widens the floor side from the one-cell alcove. */
function pitGrid(open: number, cell: number) {
  const row = `#v${'.'.repeat(open)}#`;
  return gridMap(['#'.repeat(open + 3), row, row, row, '#'.repeat(open + 3)], {
    cell,
    heights: { v: { floor: PIT_FLOOR, ceil: 128 } },
  });
}

/** A demon on the floor at `at`, headed east, with `extra` over the resting body. */
function demonBody(at: Pos2, world: World, extra: Partial<MonsterBody> = {}): MonsterBody {
  return monsterBody({ ...at, z: world.groundFloor(at.x, at.y, stats.radius, true) }, { movedir: 0, ...extra });
}

/** The E1M5 shape: a one-cell alcove the demon cannot stand clear of either edge of. */
function alcove(): { world: World; body: MonsterBody; target: Pos3; edge: number } {
  const grid = pitGrid(1, CELL);
  const world = new World(grid.map);
  const centre = grid.centre(2, 2);
  // West of centre: the box spans the pit edge and stops short of the wall, the
  // one straddle the E1M5 demon was left in. Dead centre would span both, and
  // the wall alone would refuse every step for reasons that aren't the dropoff.
  const at = { x: centre.x - 10, y: centre.y };
  return {
    world,
    body: demonBody(at, world),
    target: { x: at.x + 4 * CELL, y: at.y, z: 0 }, // east, past the wall: unreachable, so it only ever re-routes
    edge: centre.x - CELL / 2, // the pit's near edge
  };
}

describe('Regressions · a monster already hanging over a ledge', () => {
  test('is standing over a dropoff to begin with', () => {
    const { world, body } = alcove();
    assert.equal(body.z, 0, 'the straddled opening pins it to the high side');
    assert.ok(world.floorAt(body.x, body.y) === 0 && body.x - stats.radius < 2 * CELL, 'and its box hangs over the pit');
  });

  test('walks instead of freezing, and never off the ledge', () => {
    const { world, body, target, edge } = alcove();
    const start = { x: body.x, y: body.y };
    let travelled = 0;
    let lowest = body.z;
    let westmost = body.x;
    for (let i = 0; i < ticsIn(30); i++) {
      stepMonsterAI(body, stats, world, { dt: DOOM_TIC, target, targetRadius: PLAYER_RADIUS, targetHeight: PLAYER_HEIGHT, blockersFor: () => [] });
      travelled = Math.max(travelled, Math.hypot(body.x - start.x, body.y - start.y));
      lowest = Math.min(lowest, body.z);
      westmost = Math.min(westmost, body.x);
    }
    assert.ok(travelled > CELL / 2, `expected the monster to pace the alcove, moved ${travelled.toFixed(1)}`);
    assert.equal(lowest, 0, 'it must not descend the ledge it was hanging over');
    // Its *centre* must stay on floor, or the sprite reads as walking on air
    // over the pit — half a body of overhang is what a monster at any ledge
    // shows, more is the artifact the centre clause of `dropoffRefuses` bounds.
    assert.ok(westmost >= edge, `centre crossed the ledge by ${(edge - westmost).toFixed(1)} units`);
  });

  test('stays on solid ground at an open ledge, where it has room to drift', () => {
    // The alcove pins the centre clause against a wall; this is the same rule
    // with nothing but the ledge stopping the monster, and a target across the
    // pit so it keeps pressing into it. Without that clause the two relative
    // clauses let it slide out until a sliver of its box is all that is left on
    // floor — a monster visibly walking on air over the pit.
    const grid = pitGrid(2, 128);
    const world = new World(grid.map);
    const edge = 2 * 128; // the pit's near edge
    const body = demonBody({ x: edge + 5, y: grid.centre(2, 2).y }, world, { movedir: 4 });
    const target = { x: edge - 256, y: body.y, z: PIT_FLOOR };
    for (let i = 0; i < ticsIn(20); i++) {
      stepMonsterAI(body, stats, world, { dt: DOOM_TIC, target, targetRadius: PLAYER_RADIUS, targetHeight: PLAYER_HEIGHT, blockersFor: () => [] });
      assert.equal(body.z, 0, `stepped into the pit at frame ${i}`);
      assert.ok(body.x >= edge, `centre crossed the ledge by ${(edge - body.x).toFixed(1)} units at frame ${i}`);
    }
  });

  test('a monster on flat ground still refuses to step onto the ledge', () => {
    // The relaxation reaches only a body that already hangs: from clear ground
    // the new form and vanilla's agree, and this is the half that must not move.
    const grid = pitGrid(2, 128);
    const world = new World(grid.map);
    const at = grid.centre(3, 2); // the far column, a clear body-width from the pit
    const body = demonBody(at, world, { movedir: 4 });
    const target = { x: at.x - 4 * 128, y: at.y, z: PIT_FLOOR }; // straight across the pit
    for (let i = 0; i < ticsIn(8); i++) {
      stepMonsterAI(body, stats, world, { dt: DOOM_TIC, target, targetRadius: PLAYER_RADIUS, targetHeight: PLAYER_HEIGHT, blockersFor: () => [] });
      assert.equal(body.z, 0, `stepped into the pit at frame ${i}`);
    }
  });
});
