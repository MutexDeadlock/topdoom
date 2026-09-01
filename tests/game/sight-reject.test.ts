import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * `hasLineOfSight`'s REJECT early-out — vanilla's first test in
 * `P_CheckSight`. The rule under test is that the table can only ever *remove*
 * sight the geometry allows, and that it is indexed by ordered sector pair.
 * See docs/world.md § REJECT.
 */

/** An open room: every cell is its own sector, all of them mutually visible. */
const ROOM = ['....', '....'];
const COLS = ROOM[0].length;
const SECTORS = COLS * ROOM.length;

/** Sector (and subsector) index of a cell, which the grid fixture makes one number. */
const cellIndex = (col: number, row: number): number => row * COLS + col;

/** The open room, with the ordered sector pairs named blind by its REJECT table. */
function room(...blind: readonly (readonly [number, number])[]) {
  const reject = new Uint8Array(Math.ceil((SECTORS * SECTORS) / 8));
  for (const [from, to] of blind) {
    const pnum = from * SECTORS + to;
    reject[pnum >> 3] |= 1 << (pnum & 7);
  }
  const grid = gridMap(ROOM, { reject: blind.length === 0 ? undefined : reject });
  const at = (col: number, row: number): Pos3 => ({ ...grid.centre(col, row), z: 0 });
  return { world: new World(grid.map), at };
}

const CORNER = cellIndex(0, 0);
const FAR = cellIndex(3, 1);

describe('World · REJECT', () => {
  test('with no table the open room is fully visible', () => {
    const { world, at } = room();
    assert.equal(world.hasLineOfSight(at(0, 0), at(3, 1)), true);
  });

  test('a set bit blinds a pair the geometry leaves in plain sight', () => {
    const { world, at } = room([CORNER, FAR]);
    assert.equal(world.hasLineOfSight(at(0, 0), at(3, 1)), false);
  });

  test('the subsector hints reach the same verdict as looking them up', () => {
    const { world, at } = room([CORNER, FAR]);
    assert.equal(world.hasLineOfSight(at(0, 0), at(3, 1), CORNER, FAR), false);
    // A hint of -1 means "look it up", and must not change the answer.
    assert.equal(world.hasLineOfSight(at(0, 0), at(3, 1), -1, FAR), false);
    // Neither may a hint naming no subsector this map has.
    assert.equal(world.hasLineOfSight(at(0, 0), at(3, 1), SECTORS + 99, FAR), true);
  });

  test('only the marked pair is blinded, and only in the direction it is marked', () => {
    const { world, at } = room([CORNER, FAR]);
    // Same origin, a different target: untouched.
    assert.equal(world.hasLineOfSight(at(0, 0), at(2, 0)), true);
    // The reverse pair has its own bit, which this table leaves clear —
    // vanilla's index is `s1 * numsectors + s2` with `s1` the looking end.
    assert.equal(world.hasLineOfSight(at(3, 1), at(0, 0)), true);
  });

  test('a clear bit cannot grant sight the geometry refuses', () => {
    const walled = gridMap(['.#.'], { reject: new Uint8Array(2) });
    const world = new World(walled.map);
    assert.equal(world.hasLineOfSight({ ...walled.centre(0, 0), z: 0 }, { ...walled.centre(2, 0), z: 0 }), false);
  });
});
