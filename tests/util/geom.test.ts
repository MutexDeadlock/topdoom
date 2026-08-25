import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blastDistanceToBox,
  clipConvexPolygon,
  distSqToSegment,
  pointInConvexPolygon,
  segmentEntersBox,
  segmentIntersect,
  signedPolygonArea2,
  traceHitsBox,
} from '../../src/util/geom.ts';
import { polygonArea } from '../fixtures/geometry.ts';

/**
 * The five primitives under every sightline in the engine — wall occlusion, fog
 * reveal, and `World`'s own line queries all bottom out here, so a sign error
 * shows up as a subtle visual bug three subsystems away.
 */

const UNIT_SQUARE = [0, 0, 10, 0, 10, 10, 0, 10];

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

  test('clipConvexPolygon measures its tolerance in map units, not cross-product units', () => {
    // The tolerance pushes the line towards the discarded side by that distance,
    // so it survives whatever length the caller's direction vector happens to
    // have — a seg's direction is its own length, never normalized.
    const short = clipConvexPolygon([...UNIT_SQUARE], 5, 0, 0, 1, 2);
    const long = clipConvexPolygon([...UNIT_SQUARE], 5, 0, 0, 1000, 2);
    assert.deepEqual(short, [3, 0, 10, 0, 10, 10, 3, 10], 'x >= 5 - 2');
    assert.deepEqual(long, short, 'the same cut, from a direction 1000x as long');

    // Slack on the seg clip is what stops a partition that disagrees with its
    // own linedef by a rounding error from shaving a crack in the floor —
    // docs/render.md § Cracks between subsectors.
    assert.equal(polygonArea(clipConvexPolygon([...UNIT_SQUARE], 1.5, 0, 0, 1)), 85, 'the exact cut');
    const untouched = clipConvexPolygon([...UNIT_SQUARE], 1.5, 0, 0, 1, 2);
    assert.equal(polygonArea(untouched), 100, 'a cut shallower than the tolerance takes nothing');
  });

  test('clipConvexPolygon handles fully-inside, fully-outside and empty input', () => {
    // Partition far to the west: the whole square is on the kept side.
    const inside = clipConvexPolygon([...UNIT_SQUARE], -100, 0, 0, 1);
    assert.equal(polygonArea(inside), 100, 'the whole square survives');

    // Far to the east: nothing is. This is the branch that makes a subsector
    // poly come out degenerate, which `buildSubSectorPolys` then drops.
    const outside = clipConvexPolygon([...UNIT_SQUARE], 100, 0, 0, 1);
    assert.deepEqual(outside, [], 'nothing survives');

    assert.deepEqual(clipConvexPolygon([], 0, 0, 0, 1), [], 'no points clips to no points');
  });

  test('clipConvexPolygon fills a caller-owned buffer, clearing whatever it held', () => {
    // What lets `mapmesh.ts`'s `diceOnGrid` cut every flat on the map against a grid without an
    // array per cut. The buffer is cleared on entry, so a shorter result cannot leave a tail
    // of the previous one behind.
    const out: number[] = [1, 2, 3, 4, 5, 6, 7, 8];
    const got = clipConvexPolygon([...UNIT_SQUARE], -100, 0, 0, 1, 0, out);
    assert.equal(got, out, 'the buffer itself comes back');
    assert.equal(polygonArea(out), 100);

    clipConvexPolygon([...UNIT_SQUARE], 100, 0, 0, 1, 0, out);
    assert.deepEqual(out, [], 'a fully-clipped result must empty the buffer');
  });

  test('clipConvexPolygon reads a Float64Array as readily as an array', () => {
    // `SubSectorPoly.points` is a `Float64Array`, and `diceOnGrid` clips it directly.
    const typed = Float64Array.from(UNIT_SQUARE);
    assert.deepEqual(clipConvexPolygon(typed, -100, 0, 0, 1), [...UNIT_SQUARE]);
  });

  test('the four axis-aligned half-planes a grid cut needs', () => {
    // The degenerate cases of the same clip, tabulated at `mapmesh.ts`'s `diceOnGrid`. A square
    // from (0,0) to (10,10) halved four ways: each keeps 50 of the 100.
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    const keepXHigh = clipConvexPolygon(sq, 5, 0, 0, 1);
    const keepXLow = clipConvexPolygon(sq, 5, 0, 0, -1);
    const keepYHigh = clipConvexPolygon(sq, 0, 5, -1, 0);
    const keepYLow = clipConvexPolygon(sq, 0, 5, 1, 0);
    for (const half of [keepXHigh, keepXLow, keepYHigh, keepYLow]) assert.equal(polygonArea(half), 50);
    for (let i = 0; i < keepXHigh.length; i += 2) assert.ok(keepXHigh[i] >= 5, 'x >= 5 kept a point west of the cut');
    for (let i = 0; i < keepXLow.length; i += 2) assert.ok(keepXLow[i] <= 5, 'x <= 5 kept a point east of the cut');
    for (let i = 1; i < keepYHigh.length; i += 2) assert.ok(keepYHigh[i] >= 5, 'y >= 5 kept a point south of the cut');
    for (let i = 1; i < keepYLow.length; i += 2) assert.ok(keepYLow[i] <= 5, 'y <= 5 kept a point north of the cut');

    // The two halves of one cut must share their edge exactly, or a diced floor grows a seam.
    assert.equal(polygonArea(keepXHigh) + polygonArea(keepXLow), 100);
  });
});

describe('geometry · signed area', () => {
  test('the sign is the winding and the magnitude is twice the area', () => {
    const ccw = [0, 0, 10, 0, 10, 10, 0, 10];
    const cw = [0, 0, 0, 10, 10, 10, 10, 0];
    assert.equal(signedPolygonArea2(ccw), 200, 'counter-clockwise is positive, un-halved');
    assert.equal(signedPolygonArea2(cw), -200, 'clockwise is negative');
    assert.equal(Math.abs(signedPolygonArea2(cw)) / 2, 100, 'halved, it is the area');
  });

  test('anything without three points has no area', () => {
    assert.equal(signedPolygonArea2([]), 0);
    assert.equal(signedPolygonArea2([0, 0]), 0);
    assert.equal(signedPolygonArea2([0, 0, 10, 10]), 0);
  });

  test('a degenerate ring measures zero however many points it has', () => {
    // What `diceOnGrid`'s cell filter rejects on: a cut that only grazes a polygon comes back as
    // three or four collinear points.
    assert.equal(signedPolygonArea2([0, 0, 5, 5, 10, 10, 5, 5]), 0);
  });
});

/**
 * The two shot-vs-body tests, which are different shapes in vanilla and were
 * both a mean-width circle here until movement stopped approximating boxes.
 * See docs/combat.md § How a shot deals damage.
 */
describe('Geometry · shot-vs-body', () => {
  test('a hitscan’s width is direction-dependent: radius head-on, radius·√2 at 45°', () => {
    // `PIT_AddThingIntercepts` crosses one *diagonal* of the box, not the box.
    // Due east at a body of radius 16 at the origin: the diagonal spans y ±16.
    assert.notEqual(traceHitsBox(-100, 15.9, 1, 0, 0, 0, 16), null, 'just inside head-on');
    assert.equal(traceHitsBox(-100, 16.1, 1, 0, 0, 0, 16), null, 'just outside head-on');

    // On the 45° diagonal the tested cross-section is the full corner-to-corner
    // span, so the reach perpendicular to the trace is radius·√2.
    const d = Math.SQRT1_2;
    const wide = 16 * Math.SQRT2;
    // Offset perpendicular to a north-east trace, i.e. along (-d, d).
    for (const [off, want] of [[wide - 0.1, true], [wide + 0.1, false]] as [number, boolean][]) {
      const ox = -100 - d * off;
      const oy = -100 + d * off;
      assert.equal(traceHitsBox(ox, oy, d, d, 0, 0, 16) !== null, want, `offset ${off}`);
    }
  });

  test('a hitscan resolves at the diagonal, so a centred shot lands on the body’s centre', () => {
    // Not the near face: the crossing is with the diagonal, which for a shot
    // straight down the middle is the body's own centre — where the puff goes.
    const centred = traceHitsBox(-100, 0, 1, 0, 0, 0, 16);
    assert.ok(centred !== null && Math.abs(centred - 100) < 1e-9, `expected 100, got ${centred}`);

    // Off-centre it slides along the diagonal, so a shot grazing the near edge
    // resolves earlier than one down the middle.
    const grazing = traceHitsBox(-100, 15, 1, 0, 0, 0, 16);
    assert.ok(grazing !== null && grazing < centred, `expected earlier than ${centred}, got ${grazing}`);

    // Same body, but the trace points away from it.
    assert.equal(traceHitsBox(-100, 0, -1, 0, 0, 0, 16), null);
  });

  test('a projectile’s box is the plain summed-radii AABB, exclusive at the edge', () => {
    // Flying east past a body of half-width 22 at the origin.
    assert.notEqual(segmentEntersBox(-100, 21.9, 100, 21.9, 0, 0, 22), null);
    assert.equal(segmentEntersBox(-100, 22, 100, 22, 0, 0, 22), null, 'exactly flush is a miss');
    // A 45° pass is measured against the same axis-aligned box, whose corner
    // reach is 22·√2 ≈ 31.1 perpendicular to the travel.
    const perp = (p: number) => segmentEntersBox(-100, -100 + p, 100, 100 + p, 0, 0, 22);
    assert.notEqual(perp(40), null, 'perpendicular offset 28.3, inside the corner');
    assert.equal(perp(50), null, 'perpendicular offset 35.4, outside it');
  });

  test('a projectile’s contact is the entry point, and a miss is null', () => {
    const t = segmentEntersBox(-100, 0, 100, 0, 0, 0, 22);
    assert.ok(t !== null && Math.abs(t - 0.39) < 1e-9, `enters at x = -22, got t=${t}`);
    assert.equal(segmentEntersBox(-100, 50, 100, 50, 0, 0, 22), null);
  });
});

/**
 * `PIT_RadiusAttack`'s range: to the body's *edge*, on the Chebyshev metric.
 * Measuring centre-to-centre instead under-damaged every wide monster, which is
 * exactly the kind explosions get aimed at. See docs/combat.md § Splash and the BFG.
 */
describe('Geometry · blast range', () => {
  test('it measures to the body’s edge, so a wide body is caught further out', () => {
    // A 48-radius mancubus 100 units east of a 128-unit barrel blast.
    assert.equal(blastDistanceToBox(0, 0, 100, 0, 48), 52);
    // `PIT_RadiusAttack` deals `radius - dist`, so a 128-unit blast does 76 there;
    // centre-to-centre would have said 100, i.e. 28 damage.

    // A narrow body at the same spot is hurt less — the subtraction is per-body.
    assert.equal(blastDistanceToBox(0, 0, 100, 0, 16), 84);
  });

  test('it is Chebyshev, not Euclidean', () => {
    // Diagonal at (60, 60): Euclidean 84.9, Chebyshev 60. A point body sees 60.
    assert.equal(blastDistanceToBox(0, 0, 60, 60, 0), 60);
    assert.ok(Math.hypot(60, 60) > 84, 'the Euclidean distance really is further');
  });

  test('a body overlapping the blast point is at range 0, never negative', () => {
    assert.equal(blastDistanceToBox(0, 0, 10, 0, 48), 0);
    assert.equal(blastDistanceToBox(0, 0, 0, 0, 16), 0);
  });
});
