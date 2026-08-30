import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import { AIM_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * A locked-on shot whose wedge is stopped by geometry short of its target used to
 * keep the wedge's slope anyway — aim no `P_AimLineAttack` ever found, since that
 * returns 0 with no `linetarget`. On DOOM2 MAP04 the crusher corridor (sector 76,
 * floor 24, ceiling down at 32 against neighbour floors of 32) left a hairline
 * slot, and a pellet clicked at a monster in the room beyond dived through it and
 * flew on past the shut crusher. The shot now falls back to a flat one, re-traced
 * so it ends where a flat shot stops. See docs/combat.md § shotPath.
 */

/** Ceiling of the crushed corridor: under the shooter's fire height, over the slot a slope finds. */
const CRUSHED_CEIL = 30;
/** The pit past the corridor, and the floor the target stands on. */
const PIT_FLOOR = -64;
const IMP_HALF = MONSTER_STATS[ThingType.imp].height / 2;
const EAST = 0;

/**
 * Shooter, crushed corridor, pit, solid wall, target — the target is behind the
 * wall, so nothing the wedge finds ever reaches it.
 */
function scene() {
  const grid = gridMap(['.c.#p'], {
    heights: {
      c: { floor: 0, ceil: CRUSHED_CEIL },
      p: { floor: PIT_FLOOR, ceil: 128 },
      '.': { floor: 0, ceil: 128 },
    },
  });
  // The pit cell the shot would fly over on its way to the wall.
  grid.map.sectors[grid.index(2, 0)].floorHeight = PIT_FLOOR;
  const world = new World(grid.map);
  const from = grid.centre(0, 0);
  const at = grid.centre(4, 0);
  const origin: Pos3 = { x: from.x, y: from.y, z: AIM_HEIGHT_OFFSET };
  const target: Pos3 = { x: at.x, y: at.y, z: PIT_FLOOR + IMP_HALF };
  return {
    origin,
    target,
    /** Distance to the corridor's near edge — where a flat shot is stopped. */
    toCorridor: grid.cell / 2,
    fire: () => world.shotPath(origin, EAST, target, undefined, { halfHeight: IMP_HALF, slopeOffset: 0 }),
  };
}

describe('Regressions · a locked shot stopped short of its target fires flat', () => {
  test('the shot stops at the shut corridor, not past it', () => {
    const { origin, toCorridor, fire } = scene();
    const path = fire();

    assert.notEqual(path.lineIndex, null, 'geometry stopped it');
    assert.equal(path.dist, toCorridor, 'at the corridor it could not fit through');
    assert.equal(path.z, origin.z, 'and flat, at the height it was fired from');
  });

  test('the slot under the corridor ceiling is real — a sloped ray does fit', () => {
    const { origin, target, toCorridor } = scene();
    const slope = (target.z - origin.z) / (target.x - origin.x);

    // What the old wedge aimed down: the raw line to the target clears the
    // corridor's floor and passes under its lowered ceiling.
    const atNear = origin.z + slope * toCorridor;
    const atFar = origin.z + slope * toCorridor * 3;
    assert.ok(atNear < CRUSHED_CEIL, `the sloped ray is at ${atNear} under the ${CRUSHED_CEIL} ceiling`);
    assert.ok(atFar > 0, `and still at ${atFar}, over the corridor floor`);
    assert.ok(origin.z > CRUSHED_CEIL, 'while the flat shot the fix fires cannot fit at all');
  });
});
