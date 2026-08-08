import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipConvexPolygon,
  distSqToSegment,
  pointInConvexPolygon,
  pointNearConvexPolygon,
  segmentIntersect,
} from '../../src/util/geom.ts';

/**
 * The five primitives under every sightline in the engine — wall occlusion, fog
 * reveal, and `World`'s own line queries all bottom out here, so a sign error
 * shows up as a subtle visual bug three subsystems away.
 */

const UNIT_SQUARE = [0, 0, 10, 0, 10, 10, 0, 10];

function polygonArea(poly: number[]): number {
  const n = poly.length / 2;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

describe('Geometry · segments', () => {
  test('segmentIntersect finds the crossing parameter along the first segment', () => {
    // Vertical segment crossed a quarter of the way along.
    const hit = segmentIntersect(0, 0, 40, 0, 10, -5, 10, 5);
    assert.ok(hit);
    assert.equal(hit.t, 0.25);

    // t is along the *first* segment only, so swapping the pair changes it.
    const swapped = segmentIntersect(10, -5, 10, 5, 0, 0, 40, 0);
    assert.ok(swapped);
    assert.equal(swapped.t, 0.5);
  });

  test('segmentIntersect rejects parallel, collinear and out-of-bounds crossings', () => {
    assert.equal(segmentIntersect(0, 0, 10, 0, 0, 5, 10, 5), null, 'parallel');
    assert.equal(segmentIntersect(0, 0, 10, 0, 20, 0, 30, 0), null, 'collinear (denom ~ 0)');
    assert.equal(segmentIntersect(0, 0, 10, 0, 0, 0, 10, 0), null, 'identical, also collinear');
    // The infinite lines cross, but past the end of one segment or the other.
    assert.equal(segmentIntersect(0, 0, 10, 0, 20, -5, 20, 5), null, 't > 1');
    assert.equal(segmentIntersect(0, 0, 10, 0, -20, -5, -20, 5), null, 't < 0');
    assert.equal(segmentIntersect(0, 0, 10, 0, 5, 5, 5, 15), null, 'u out of range');
  });

  test('distSqToSegment clamps to the endpoints instead of the infinite line', () => {
    // Perpendicular foot inside the segment.
    assert.equal(distSqToSegment(5, 3, 0, 0, 10, 0), 9);
    // Past each end: the distance is to the endpoint, not to the line (which
    // would be 9 in both cases).
    assert.equal(distSqToSegment(-4, 3, 0, 0, 10, 0), 25);
    assert.equal(distSqToSegment(14, 3, 0, 0, 10, 0), 25);
    // On the segment.
    assert.equal(distSqToSegment(5, 0, 0, 0, 10, 0), 0);
    // A zero-length segment must not divide by zero — the `lenSq > 0` guard.
    assert.equal(distSqToSegment(3, 4, 0, 0, 0, 0), 25);
  });
});

describe('Geometry · convex polygons', () => {
  test('pointInConvexPolygon works for either winding and rejects degenerate input', () => {
    const cw = [0, 0, 0, 10, 10, 10, 10, 0];
    assert.equal(pointInConvexPolygon(5, 5, UNIT_SQUARE), true);
    assert.equal(pointInConvexPolygon(5, 5, cw), true, 'only sign *agreement* matters');
    assert.equal(pointInConvexPolygon(15, 5, UNIT_SQUARE), false);
    assert.equal(pointInConvexPolygon(-1, 5, UNIT_SQUARE), false);
    // On an edge the cross product is 0, which is skipped rather than counted as
    // disagreement — so the boundary reads as inside.
    assert.equal(pointInConvexPolygon(0, 5, UNIT_SQUARE), true);
    assert.equal(pointInConvexPolygon(0, 0, UNIT_SQUARE), true, 'a corner');
    // Fewer than three points is not a polygon.
    assert.equal(pointInConvexPolygon(0, 0, [0, 0, 1, 1]), false);
    assert.equal(pointInConvexPolygon(0, 0, []), false);
  });

  test('pointNearConvexPolygon inflates the test by the radius', () => {
    // Its whole reason to exist: one physical floor is routinely split across
    // several subsector polygons, so a point just across a shared edge is still
    // "in the way". 3 units outside, tested with radius 4.
    assert.equal(pointInConvexPolygon(13, 5, UNIT_SQUARE), false);
    assert.equal(pointNearConvexPolygon(13, 5, UNIT_SQUARE, 4), true);
    assert.equal(pointNearConvexPolygon(13, 5, UNIT_SQUARE, 2), false);
    // Exactly on the radius counts — the test is `<= r2`.
    assert.equal(pointNearConvexPolygon(13, 5, UNIT_SQUARE, 3), true);
    // Inside short-circuits regardless of radius.
    assert.equal(pointNearConvexPolygon(5, 5, UNIT_SQUARE, 0), true);
    // Corner-diagonal distance is Euclidean, not per-axis.
    assert.equal(pointNearConvexPolygon(13, 14, UNIT_SQUARE, 4), false, 'hypot(3,4) = 5 > 4');
    assert.equal(pointNearConvexPolygon(13, 14, UNIT_SQUARE, 5), true);
  });

  test('clipConvexPolygon keeps the cross <= 0 half-plane', () => {
    // side(x,y) = dx*(y-py) - dy*(x-px). A partition through x = 5 pointing +Y
    // keeps x >= 5 — the half the BSP calls "right", and the same sign
    // `World.subsectorAt` walks the tree by.
    const right = clipConvexPolygon([...UNIT_SQUARE], 5, 0, 0, 1);
    assert.deepEqual(right, [5, 0, 10, 0, 10, 10, 5, 10]);
    assert.equal(polygonArea(right), 50);

    // Mirroring the direction takes the complement, which is exactly how bsp.ts
    // derives a node's left child from the same partition.
    const left = clipConvexPolygon([...UNIT_SQUARE], 5, 0, 0, -1);
    assert.equal(polygonArea(left), 50);
    assert.ok(
      left.every((_, i) => i % 2 === 1 || left[i] <= 5),
      'the left child holds x <= 5',
    );
  });

  test('clipConvexPolygon handles fully-inside, fully-outside and empty input', () => {
    // Partition far to the west: the whole square is on the kept side.
    const inside = clipConvexPolygon([...UNIT_SQUARE], -100, 0, 0, 1);
    assert.equal(polygonArea(inside), 100, 'the whole square survives');

    // Far to the east: nothing is. This is the branch that makes a subsector
    // poly come out degenerate, which `buildSubSectorPolys` then drops.
    const outside = clipConvexPolygon([...UNIT_SQUARE], 100, 0, 0, 1);
    assert.deepEqual(outside, [], 'nothing survives');

    assert.deepEqual(clipConvexPolygon([], 0, 0, 0, 1), [], 'n === 0 returns the input');
  });
});
