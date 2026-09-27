import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { shotRig } from '../fixtures/shotrig.ts';
import { AIM_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { MonsterRef } from '../../src/game/things/defs.ts';

/**
 * A pellet a window sill forces flat passes over a body in the pit beyond, locked on or not, and a
 * free pellet takes no aim cone. Repro: TLM.wad MAP03, the mancubus at (-561, -604) behind the
 * barred window north of it. docs/combat.md § How a shot deals damage, § The vertical test.
 */

/** The window's sill: just under the shooter's fire height, so a slope down into the pit can't clear it. */
const SILL = AIM_HEIGHT_OFFSET - 4;
const PIT_FLOOR = -72;
const EAST = 0;

/** Shooter, window, then the pit — the target two cells into it. */
function scene(windowFloor: number) {
  const grid = gridMap(['#######', '#.wppp#', '#######'], {
    cell: 128,
    heights: {
      w: { floor: windowFloor, ceil: 128 },
      p: { floor: PIT_FLOOR, ceil: 128 },
    },
  });
  const at = grid.centre(4, 1);
  const fatso = MONSTER_STATS[ThingType.mancubus];
  const target: MonsterRef = {
    id: 1,
    type: ThingType.mancubus,
    x: at.x,
    y: at.y,
    z: PIT_FLOOR,
    height: fatso.height,
    angle: 0,
    radius: fatso.radius,
  };
  const from = grid.centre(1, 1);
  return { rig: shotRig(grid, from, [target]), target, origin: { ...from, z: AIM_HEIGHT_OFFSET } };
}

describe('Combat · a pellet a sill forces flat misses the body below it', () => {
  test('the sill shuts the wedge, and the flat pellet passes over the mancubus', () => {
    const { rig, target } = scene(SILL);
    rig.fire(EAST, target);

    assert.deepEqual(rig.damaged, []);
    assert.equal(rig.tracers[0].z, AIM_HEIGHT_OFFSET, 'flat, at the fire height');
    assert.ok(rig.tracers[0].x > target.x + target.radius, 'on past the body, to the far wall');
  });

  test('with the sill down at the pit floor the same lock hits', () => {
    const { rig, target } = scene(PIT_FLOOR);
    rig.fire(EAST, target);

    assert.deepEqual(rig.damaged, [target.id]);
  });

  test('a free pellet takes no aim cone: with the sill down it still flies flat over the pit', () => {
    const { rig } = scene(PIT_FLOOR);
    rig.fire(EAST, null);

    assert.deepEqual(rig.damaged, []);
  });

  test('a free pellet hits a body its flat line crosses', () => {
    const { rig, target } = scene(SILL);
    target.z = SILL;
    rig.fire(EAST, null);

    assert.deepEqual(rig.damaged, [target.id]);
  });

  test("the aim cone a swing or a BFG ray takes narrows shut at the sill", () => {
    for (const [windowFloor, reaches] of [[SILL, false], [PIT_FLOOR, true]] as const) {
      const { rig, target, origin } = scene(windowFloor);
      const body = { feet: target.z, height: target.height };
      assert.equal(rig.world.shotReachesBody(origin, EAST, target.x - origin.x, body, undefined), reaches, `sill at ${windowFloor}`);
    }
  });
});
