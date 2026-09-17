import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { MoverOccupancy } from '../../src/game/specials/moverblocking.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { thingLayer } from '../fixtures/spritestubs.ts';
import { crushSources } from '../fixtures/specialsrig.ts';

/**
 * Both mover obstruction tests asked who was standing in the moving sector by sampling eight
 * points of a body's box — its corners and edge midpoints. A sector narrower than that sampling
 * step falls between the samples, so a body straddling it was invisible to the mover: a rising
 * lift carried a demon up and pinned it (every step out reads blocked, and nothing reported
 * `nofit`, so the lift never reversed), and a closing door shut through one standing in the
 * doorway. `boxOverlapsSector` now goes through `World.sectorsTouching`.
 * Repro: GoingDown.wad MAP08's crate-lift, sector 1, an 8-unit ring around its inner sector.
 * See docs/specials-movers.md § Every other mover stops instead.
 */

const DEMON = MONSTER_STATS[ThingType.demon];
/** Narrower than the demon's radius, which is what the rim sample used to step by. */
const CELL = 16;
/** The strip's ceiling: exactly its raised floor, so a demon on it has nowhere to stand. */
const CEIL = 64;

/**
 * A room with one cell-wide strip through the middle — the mover — and a demon `inset` units west
 * of the strip's own west edge, so a positive `inset` under `DEMON.radius` puts the strip under
 * the demon's box without putting any of it under the demon's centre.
 */
function scene(inset: number) {
  const grid = gridMap(
    [
      '#############',
      '#...........#',
      '#...........#',
      '#...........#',
      '#.....M.....#',
      '#...........#',
      '#...........#',
      '#...........#',
      '#############',
    ],
    { cell: CELL, heights: { M: { floor: 0, ceil: CEIL } } },
  );
  const map = grid.map;
  const mover = grid.index(6, 4);
  const centre = grid.centre(6, 4);
  const at = { x: centre.x - CELL / 2 - inset, y: centre.y };
  map.things.push({ ...at, angle: 0, type: ThingType.demon, flags: 7 });
  const world = new World(map);
  const things = thingLayer(world);
  return { world, mover, at, occupancy: new MoverOccupancy(world, crushSources({ things: () => things })) };
}

/** The eight box points the membership test used to sample, as multiples of `radius`. */
const OLD_RIM = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
] as const;

describe('Specials · a mover sector narrower than the body straddling it', () => {
  test('the strip is under the demon’s box and under none of the points a rim sample takes', () => {
    const { world, mover, at } = scene(8);
    assert.equal(DEMON.radius, 30, "MT_SERGEANT's own mobjinfo radius");
    assert.notEqual(world.sectorIndexAt(at.x, at.y), mover, 'its centre stands next to the strip');
    for (const [dx, dy] of OLD_RIM) {
      const x = at.x + dx * DEMON.radius;
      const y = at.y + dy * DEMON.radius;
      assert.notEqual(world.sectorIndexAt(x, y), mover, `rim point ${dx},${dy} steps over the strip`);
    }
    assert.equal(world.sectorsTouching(at.x, at.y, DEMON.radius, []).includes(mover), true);
    assert.equal(world.groundCeiling(at.x, at.y, DEMON.radius, true), CEIL, 'the strip roofs its box');
  });

  test('a rising strip stops rather than carrying the demon beside it up', () => {
    const { occupancy, mover } = scene(8);
    assert.equal(occupancy.blocksFloorRise(mover, CEIL), true, 'the top would pin it under the strip');
    assert.equal(occupancy.blocksFloorRise(mover, CEIL - DEMON.height), false, 'still clear this far down');
    assert.equal(occupancy.blocksFloorRise(mover, CEIL - DEMON.height + 1), true, 'one unit into the strip');
  });

  test('a closing strip stops on the demon straddling it', () => {
    const { occupancy, mover } = scene(8);
    assert.equal(occupancy.blocksCeilingLower(mover, DEMON.height), false, 'exactly the height it needs');
    assert.equal(occupancy.blocksCeilingLower(mover, DEMON.height - 1), true, 'one unit short of it');
  });

  test('a demon standing clear of the strip is nobody’s business', () => {
    const { occupancy, mover } = scene(DEMON.radius + 1);
    assert.equal(occupancy.blocksFloorRise(mover, CEIL), false, 'the ordinary case is untouched');
    assert.equal(occupancy.blocksCeilingLower(mover, 1), false);
  });
});
