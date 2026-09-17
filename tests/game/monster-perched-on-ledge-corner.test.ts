import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World, MAX_STEP_UP } from '../../src/game/world.ts';
import type { MonsterBody } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos3 } from '../../src/types.ts';
import { chaseFor, monsterBody } from '../fixtures/monsterbody.ts';

/**
 * A monster whose box grazed small rubble climbed it — each rise a legal step — onto the corner of
 * a ledge taller than a step, its centre over the floor below, and froze there: every step off
 * read as a drop from the ledge, every step back onto it was walled. `dropoffRefuses` caps the
 * standing floor at a step above the centre's, so the body steps down.
 * See docs/monster-ai.md § The dropoff rule.
 *
 * **Repro: GoingDown.wad MAP25**, sector 9's south-east corner (lines 84 and 5641, floor -144): a
 * demon at (169, -746), z -144, over sector 127 (floor -176). The grids below are that shape in
 * round numbers, in a corridor only just wider than the demon.
 */

const stats = MONSTER_STATS[ThingType.demon];
const CELL = 8;
/** Taller than a step, as MAP25's 32 is. */
const LEDGE = 32;
/** How far the demon's box reaches onto the strip it stands on. */
const OVERLAP = 4;

/**
 * `strips` (glyphs west to east) against the west wall, open floor east of them, 64 units of
 * corridor against the demon's 60-unit box so it cannot step north or south. The demon's box
 * reaches `OVERLAP` onto the easternmost strip, its feet at `z`; the target is east on the floor.
 */
function corridor(
  strips: string,
  heights: Record<string, number>,
  z: number,
): { world: World; body: MonsterBody; target: Pos3; edge: number } {
  const row = `#${strips}${'.'.repeat(16)}#`;
  const grid = gridMap(['#'.repeat(row.length), ...Array<string>(8).fill(row), '#'.repeat(row.length)], {
    cell: CELL,
    heights: Object.fromEntries(Object.entries(heights).map(([glyph, floor]) => [glyph, { floor, ceil: 128 }])),
  });
  const world = new World(grid.map);
  const edge = grid.centre(strips.length, 1).x + CELL / 2;
  const y = (grid.centre(1, 4).y + grid.centre(1, 5).y) / 2;
  return {
    world,
    body: monsterBody({ x: edge + stats.radius - OVERLAP, y, z }),
    target: { x: grid.centre(row.length - 2, 4).x, y, z: 0 },
    edge,
  };
}

function chase(f: ReturnType<typeof corridor>, seconds: number, each?: (tic: number) => void): void {
  chaseFor(f.body, stats, f.world, f.target, seconds, { blockersFor: () => [], each });
}

describe('Monster AI · a monster perched on a ledge corner over the floor', () => {
  test('the fixture holds the perch', () => {
    const { world, body } = corridor('L', { L: LEDGE }, LEDGE);
    assert.equal(world.floorAt(body.x, body.y), 0, 'its centre is over the floor');
    assert.equal(world.groundFloor(body.x, body.y, stats.radius, true, body.z), LEDGE, 'the strip holds it up');
    assert.ok(LEDGE > MAX_STEP_UP, `${LEDGE} is more than a ${MAX_STEP_UP}-unit step`);
  });

  test('steps down off the corner instead of freezing', () => {
    const f = corridor('L', { L: LEDGE }, LEDGE);
    chase(f, 3);
    assert.equal(f.body.z, 0, 'it came down to the floor it was hanging over');
    assert.ok(f.body.x - stats.radius >= f.edge, `its box is still over the ledge at x ${f.body.x.toFixed(1)}`);
  });
});
