import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { NO_SIDE, type DoomMap, type LineDef, type Vertex } from '../../src/wad/map.ts';

/**
 * The collision narrowphase: `P_PointOnLineSide` and `P_BoxOnLineSide`
 * (`p_maputl.c`), which decide whether a mover's box spans a linedef. Every
 * movement probe in the engine bottoms out here — see docs/movement.md
 * § Collision.
 */

/** Just enough of a `DoomMap` for `World` to index the lines a case needs. */
function lineWorld(vertexes: Vertex[], pairs: readonly (readonly [number, number])[]): World {
  const linedefs: LineDef[] = pairs.map(([v1, v2]) => ({
    v1,
    v2,
    flags: 0,
    special: 0,
    tag: 0,
    right: NO_SIDE,
    left: NO_SIDE,
  }));
  const map: DoomMap = {
    name: 'TEST',
    vertexes,
    sectors: [],
    sidedefs: [],
    linedefs,
    segs: [],
    subsectors: [],
    nodes: [],
    things: [],
    reject: undefined,
    bounds: { minX: -256, minY: -256, maxX: 256, maxY: 256 },
  };
  return new World(map);
}

/** (0,0), (64,0), (0,64), (64,64), (64,-64) — the endpoints every case below draws from. */
const V: Vertex[] = [
  { x: 0, y: 0 },
  { x: 64, y: 0 },
  { x: 0, y: 64 },
  { x: 64, y: 64 },
  { x: 64, y: -64 },
];

/** Lines 0-4: east, west, north, the `ST_POSITIVE` diagonal, the `ST_NEGATIVE` one. */
const EAST = 0;
const WEST = 1;
const NORTH = 2;
const POSITIVE = 3;
const NEGATIVE = 4;

function world(): World {
  return lineWorld(V, [
    [0, 1],
    [1, 0],
    [0, 2],
    [0, 3],
    [0, 4],
  ]);
}

describe('Collision narrowphase · P_BoxOnLineSide', () => {
  test('a horizontal line: south is the front side, and the direction flips it', () => {
    const w = world();
    // An east-going line's right side is south, so a box below it is side 0.
    assert.equal(w.boxOnLineSide(8, -24, 24, -8, EAST), 0);
    assert.equal(w.boxOnLineSide(8, 8, 24, 24, EAST), 1);
    // The same geometry walked west swaps both, which is the `dx < 0` flip.
    assert.equal(w.boxOnLineSide(8, -24, 24, -8, WEST), 1);
    assert.equal(w.boxOnLineSide(8, 8, 24, 24, WEST), 0);
  });

  test('a vertical line: east is the front side', () => {
    const w = world();
    assert.equal(w.boxOnLineSide(8, 8, 24, 24, NORTH), 0);
    assert.equal(w.boxOnLineSide(-24, 8, -8, 24, NORTH), 1);
  });

  test('a box spanning the line reports -1, on every slopetype', () => {
    const w = world();
    for (const line of [EAST, WEST, NORTH, POSITIVE, NEGATIVE]) {
      assert.equal(w.boxOnLineSide(-8, -8, 8, 8, line), -1, `line ${line}`);
    }
  });

  test('the diagonals test opposing corners, picked by the slope sign', () => {
    const w = world();
    // y = x, running north-east: below-right is the front side.
    assert.equal(w.boxOnLineSide(8, -8, 24, 2, POSITIVE), 0);
    assert.equal(w.boxOnLineSide(-24, 8, -2, 24, POSITIVE), 1);
    // y = -x, running south-east: above-right is the front side.
    assert.equal(w.boxOnLineSide(8, 8, 24, 24, NEGATIVE), 1);
    assert.equal(w.boxOnLineSide(-24, -24, -8, -8, NEGATIVE), 0);
  });

  test('a point exactly on the line: the general path says back, the axis-aligned paths do not agree', () => {
    const w = world();
    // The general path is `right < left ? 0 : 1`, so equality falls through to
    // the back side.
    assert.equal(w.pointOnLineSide(32, 32, POSITIVE), 1);
    // The axis-aligned fast paths answer from their own `<=` instead, which
    // does not reduce to the same rule: a point on an east-going horizontal
    // line comes out *front*, and one on a north-going vertical line back.
    // Vanilla's own asymmetry, pinned so a "tidy-up" can't quietly change it.
    assert.equal(w.pointOnLineSide(32, 0, EAST), 0);
    assert.equal(w.pointOnLineSide(32, 0, WEST), 1);
    assert.equal(w.pointOnLineSide(0, 32, NORTH), 1);
  });

  test('a degenerate zero-length line is vertical, not horizontal', () => {
    // `P_LoadLineDefs` tests `!dx` first, so dx == dy == 0 lands on ST_VERTICAL.
    // Were it ST_HORIZONTAL this box would straddle (-1) instead of sitting east.
    const w = lineWorld([{ x: 0, y: 0 }], [[0, 0]]);
    assert.equal(w.boxOnLineSide(8, -8, 24, 8, 0), 0);
    assert.equal(w.boxOnLineSide(-24, -8, -8, 8, 0), 1);
  });
});

describe('Collision narrowphase · the line-bbox reject', () => {
  test('exactly flush is not an overlap', () => {
    const w = world();
    // The north line spans x = 0, y = 0..64. A box whose right edge lands
    // exactly on it does not touch it — vanilla's `<=`, and the same strict
    // boundary the circle test it replaced had.
    assert.equal(w.boxOverlapsLine(-16, 8, 0, 24, NORTH), false);
    assert.equal(w.boxOverlapsLine(-16, 8, 0.5, 24, NORTH), true);
  });

  test('past the line’s own extent it stops applying', () => {
    const w = world();
    // The east line spans x = 0..64 at y = 0. Out past its end there is
    // nothing to catch on — which is why a box never rests on a wall endpoint.
    assert.equal(w.boxOverlapsLine(80, -8, 112, 8, EAST), false);
    assert.equal(w.boxOverlapsLine(48, -8, 80, 8, EAST), true);
  });
});
