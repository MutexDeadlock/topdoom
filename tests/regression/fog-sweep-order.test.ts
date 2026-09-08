import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * The order the fog sweep visits subsectors in, which decides what a single frame can reveal.
 * See docs/fogofwar.md § Sweep order.
 */

/** Grid cell size this fixture measures its distances in. */
const CELL = 128;
/**
 * Side of the open room, in cells. Big enough that one tic's budget cannot clear it, and that the
 * far corner sits well past what one tic reveals; below ~40 the corner bound below fails on a
 * correct sweep.
 */
const ROOM = 48;

interface Cell {
  subsector: number;
  /** Distance from the player standing at the room's centre. */
  dist: number;
}

const SPAN = ROOM + 2;

/**
 * A big open room with a sealed corridor along the top to seed the fog from, so the constructor's
 * uncapped spawn sweep lands somewhere the room cannot be seen from and the room is still wholly
 * dark when the budgeted sweep first runs.
 */
const art = [
  '#'.repeat(SPAN + 2),
  `#${'.'.repeat(SPAN)}#`, // the corridor the fog is seeded in
  '#'.repeat(SPAN + 2), // sealing it off from the room
  ...Array.from({ length: ROOM }, () => `#${'.'.repeat(SPAN)}#`),
  '#'.repeat(SPAN + 2),
];
const grid = gridMap(art, { cell: CELL });
const world = new World(grid.map);

/** Where the corridor's seed sweep runs from, and where the player then arrives, as through a door. */
const seed = grid.centre(1, 1);
const centre = grid.centre(1 + (SPAN >> 1), 3 + (ROOM >> 1));

/** The room's cells with their distance from `centre`. Geometry only, so both tests share one copy. */
const cells: Cell[] = [];
for (let row = 3; row < 3 + ROOM; row++) {
  for (let col = 1; col <= SPAN; col++) {
    const p = grid.centre(col, row);
    cells.push({
      subsector: world.subsectorAt(p.x, p.y),
      dist: Math.hypot(p.x - centre.x, p.y - centre.y),
    });
  }
}

/** A fog freshly seeded in the corridor — per test, since the sweep mutates it. */
function darkRoom(): FogOfWar {
  return new FogOfWar(world, [], seed);
}

/**
 * The budgeted sweep spends each tic on the subsectors **nearest the player**, not on a slice of
 * the whole map. Round-robin over BSP index instead was the reported case: on Comatose MAP01
 * (55,029 subsectors, a 35,982-unit span) the sweep spent a tic's whole budget ray-casting to the
 * far side of the map while what the player was looking at waited seconds to light up.
 * See docs/fogofwar.md § Sweep order.
 */
describe('Regressions · fog sweep order', () => {
  /**
   * The room is wholly visible from its centre, so nothing here is bounded by geometry: what one
   * tic reveals is exactly what the budget bought, and *which* cells those are is the ordering.
   * Pinned behaviourally, by bracketing the farthest cell revealed between the ideal nearest-first
   * answer and what BSP order would have reached: `ORDER_RING` is not readable from outside
   * `fogofwar.ts`. See docs/testing.md § Feel dials are read, never pinned.
   */
  test('one tic reveals the cells nearest the player, not a spread across the room', () => {
    const fog = darkRoom();
    assert.equal(cells.filter((c) => fog.isVisible(c.subsector)).length, 0, 'the room starts dark');

    fog.tick(centre.x, centre.y);

    const revealed = cells.filter((c) => fog.isVisible(c.subsector));
    assert.ok(revealed.length > 0, 'the sweep revealed something');
    assert.ok(revealed.length < cells.length, 'and could not finish the room in one tic');

    // The nearest `revealed.length` cells there are: what a perfect nearest-first sweep would pick.
    const ideal = [...cells].sort((a, b) => a.dist - b.dist)[revealed.length - 1].dist;
    const farthest = Math.max(...revealed.map((c) => c.dist));
    // One `ORDER_RING` of slack, which is the exact bound: the sort buckets by distance and keeps
    // BSP order inside a bucket, so only the last ring it reaches comes out unordered. A tolerance
    // this fails is a ring coarse enough that the ordering has stopped paying for itself.
    assert.ok(
      farthest <= ideal + 2 * CELL,
      `farthest revealed ${farthest.toFixed(0)} should be within a ring of the ideal ${ideal.toFixed(0)}`,
    );
    // And the counterfactual the bug would have passed: BSP order spreads the same count of reveals
    // over the whole room, so its farthest lands out by the corner rather than in close.
    assert.ok(
      farthest < (Math.hypot(ROOM, ROOM) * CELL) / 4,
      `farthest revealed ${farthest.toFixed(0)} should be nowhere near the far corner`,
    );
  });

  /** Ordering must not change *what* is reachable, only when — the sweep still finishes the room. */
  test('the whole room still reveals', () => {
    const fog = darkRoom();
    for (let tic = 0; tic < 200 && cells.some((c) => !fog.isVisible(c.subsector)); tic++) {
      fog.tick(centre.x, centre.y);
    }
    const dark = cells.filter((c) => !fog.isVisible(c.subsector));
    assert.equal(dark.length, 0, `${dark.length} cells of the open room never revealed`);
  });
});
