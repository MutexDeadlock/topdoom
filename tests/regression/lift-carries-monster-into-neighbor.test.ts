import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { neighborSectorIndices, World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { MoverOccupancy } from '../../src/game/specials/moverblocking.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos2 } from '../../src/types.ts';
import { gridMap, type GridMap } from '../fixtures/gridmap.ts';
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
 * See docs/specials-movers.md § Every other mover stops instead.
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
  return populate(grid, grid.index(1, 1), { x: 2 * CELL - inset, y: grid.centre(1, 1).y });
}

/**
 * Lift, strip, crawlspace in a row of 16-unit cells: the strip is narrower than the demon's box, so
 * a demon centred in the crawlspace reaches across it onto the lift.
 * docs/specials-movers.md § Every other mover stops instead.
 */
function stripScene() {
  const cell = 16;
  const low = { floor: BOTTOM, ceil: TOP };
  const grid = gridMap(['#######', ...Array<string>(5).fill('#Lsccc#'), '#######'], {
    cell,
    heights: { L: { floor: BOTTOM, ceil: TOP + DEMON.height }, s: low, c: low },
  });
  const scene = populate(grid, grid.index(1, 3), { x: 3 * cell + 4, y: grid.centre(3, 3).y });
  return { ...scene, centreSector: grid.index(3, 3) };
}

/** A demon placed at `at` on `grid`'s map, and the occupancy the mover in `lift` asks. */
function populate(grid: GridMap, lift: number, at: Pos2) {
  grid.map.things.push({ ...at, angle: 0, type: ThingType.demon, flags: 7 });
  const world = new World(grid.map);
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

  test('a demon centred two sectors away still reaches the lift across a narrow strip', () => {
    const { world, lift, at, centreSector, occupancy } = stripScene();
    assert.equal(world.sectorIndexAt(at.x, at.y), centreSector, 'its centre is past the strip');
    assert.ok(!neighborSectorIndices(world.map, lift).includes(centreSector), 'and not in a sector bordering the lift');
    assert.equal(occupancy.blocksFloorRise(lift, TOP), true, 'the top would pin it under the crawlspace');
  });
});
