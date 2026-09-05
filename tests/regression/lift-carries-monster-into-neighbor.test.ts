import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { MoverOccupancy } from '../../src/game/specials/moverblocking.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { crushSources } from '../fixtures/specialsrig.ts';

/**
 * A rising lift measured a monster against its *own* sector's ceiling, so one
 * standing on the lift's edge — box overhanging a neighbor whose ceiling the
 * lift's raised floor is flush with — was carried up into that neighbor and
 * pinned there: every step out of it reads blocked, and the lift never reverses
 * because nothing reported `nofit`. The player already had the straddle-aware
 * overhead (`World.groundCeiling`); monsters did not. Repro: GoingDown.wad
 * MAP03, the lift in sector 67 against the crawlspace in sector 7.
 * See docs/specials.md § Every other mover stops instead.
 */

const DEMON = MONSTER_STATS[ThingType.demon];
const CELL = 128;
/** The lift's floor at rest, flush with the crawlspace's ceiling beside it. */
const TOP = -40;
const BOTTOM = -136;

/**
 * Two cells: the lift, tall enough for a demon at rest, and a crawlspace whose
 * ceiling is exactly the lift's raised floor. The demon stands `inset` units
 * west of the shared edge, i.e. on the lift.
 */
function scene(inset: number) {
  const grid = gridMap(['####', '#Lc#', '####'], {
    cell: CELL,
    heights: { L: { floor: BOTTOM, ceil: TOP + DEMON.height }, c: { floor: BOTTOM, ceil: TOP } },
  });
  const map = grid.map;
  const lift = grid.index(1, 1);
  const at = { x: 2 * CELL - inset, y: grid.centre(1, 1).y };
  map.things.push({ ...at, angle: 0, type: ThingType.demon, flags: 7 });
  const world = new World(map);
  const things = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
  return { world, lift, at, occupancy: new MoverOccupancy(world, crushSources({ things: () => things })) };
}

describe('Regressions · a lift edge carrying a monster into a low neighbor', () => {
  test('the straddle is what the block turns on, not the lift’s own gap', () => {
    const { world, lift, at } = scene(20);
    assert.equal(DEMON.radius, 30, "MT_SERGEANT's own mobjinfo radius");
    assert.equal(world.map.sectors[lift].ceilHeight - TOP, DEMON.height, 'the demon fits the lift exactly');
    assert.equal(world.groundCeiling(at.x, at.y, DEMON.radius, true), TOP, 'the box really straddles it');
  });

  test('a demon on the lift’s edge stops the rise before it reaches the top', () => {
    const { occupancy, lift } = scene(20);
    assert.equal(occupancy.blocksFloorRise(lift, TOP), true, 'the top would pin it under the crawlspace');
    assert.equal(occupancy.blocksFloorRise(lift, TOP - DEMON.height), false, 'still clear this far down');
    assert.equal(occupancy.blocksFloorRise(lift, TOP - DEMON.height + 1), true, 'one unit into the crawlspace');
  });

  test('a demon standing clear of the edge rides all the way up', () => {
    const { occupancy, lift } = scene(DEMON.radius + 1);
    assert.equal(occupancy.blocksFloorRise(lift, TOP), false, 'the ordinary case is untouched');
  });
});
