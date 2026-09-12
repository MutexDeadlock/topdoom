/**
 * The primitives more than one layer needs — segment crossings, point-to-segment distance, the
 * swept box tests, the convex-polygon queries, and the one 3D test here (`rayEntersBox`, auto-aim's
 * pick). Pure functions on scalars, deliberately: their callers compute coordinates inline
 * thousands of times a frame, so a point-object parameter here would allocate in exactly the wrong
 * place (docs/conventions.md § Named arguments).
 * Each is documented at its own declaration; the rules built on them live with their callers —
 * docs/movement.md § Collision, docs/render-occlusion.md, docs/fogofwar.md and
 * docs/monster-attacks.md § Monster projectiles in flight.
 */
import type { Pos2 } from '../types.ts';

/**
 * Length of the 2D vector (dx, dy) — what every distance in `src/` is measured with.
 *
 * `Math.hypot` is the obvious spelling and is deliberately not used anywhere in the tree
 * (`tests/util/geom.test.ts` fails the build on one): ECMA-262 leaves its result
 * implementation-approximated, where `*` and `Math.sqrt` are exactly specified IEEE-754, so this
 * form is the one that agrees bit-for-bit across engines. It is also the faster of the two —
 * `hypot`'s only edge is the overflow/underflow guard, which no map-space coordinate (|x| < 32768)
 * can reach. What that engine agreement is and isn't worth:
 * docs/random.md § What this does not buy.
 */
export function vecLength(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 2D segment crossing between (ax,ay)-(bx,by) and (cx,cy)-(dx,dy): the crossing's parameter along
 * the first segment, or **-1** when they don't cross within both segments' bounds.
 *
 * The form every per-line inner loop uses — sightlines, shot and projectile traces, the fog's
 * sight sweep, the wall fader — because the `{ t }` its wrapper returns would allocate one object
 * per crossing in code that runs thousands of times a frame. `segmentIntersect` wraps it for the
 * callers that read `t` off a record instead.
 */
export function segmentCrossT(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;

  const denom = rx * sy - ry * sx;
  if (denom > -1e-9 && denom < 1e-9) return -1;

  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  if (t < 0 || t > 1) return -1;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (u < 0 || u > 1) return -1;
  return t;
}

/**
 * `segmentCrossT` as a nullable record: the crossing's parameter `t` along the first segment, or
 * null if they don't cross within both segments' bounds. For the callers outside a hot loop —
 * `specials.ts`'s walk and use triggers, `world.ts`'s sliding moves.
 */
export function segmentIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { t: number } | null {
  const t = segmentCrossT(ax, ay, bx, by, cx, cy, dx, dy);
  return t < 0 ? null : { t };
}

/** Where along the segment a→b its closest point to (px, py) lies, clamped to [0, 1]. */
export function closestTOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Squared distance from a point to a line segment. */
export function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const t = closestTOnSegment(px, py, ax, ay, bx, by);
  const cx = ax + (bx - ax) * t - px;
  const cy = ay + (by - ay) * t - py;
  return cx * cx + cy * cy;
}

/**
 * How far along a **hitscan** trace it strikes the body of half-width `radius`
 * at (bx, by), or null if it misses — vanilla's `PIT_AddThingIntercepts`
 * (`p_maputl.c`). `dirX`/`dirY` must be a unit direction, so the result is a
 * distance.
 *
 * Vanilla tests one of the box's two *diagonals* rather than the box, picked by
 * whether the trace's `dx` and `dy` share a sign — equivalent to a box test, and
 * the reason a body's hitscan width is direction-dependent.
 * See docs/combat.md § How a shot deals damage.
 */
export function traceHitsBox(
  ox: number,
  oy: number,
  dirX: number,
  dirY: number,
  bx: number,
  by: number,
  radius: number,
): number | null {
  // `tracepositive` is vanilla's `(trace.dx ^ trace.dy) > 0` — the two sign
  // bits agreeing. A zero component takes its sign from the other one, which
  // the XOR does for free and this has to spell out.
  const negX = dirX < 0;
  const negY = dirY < 0;
  const tracePositive = negX === negY && (dirX !== 0 || dirY !== 0);
  const x1 = bx - radius;
  const y1 = tracePositive ? by + radius : by - radius;
  const x2 = bx + radius;
  const y2 = tracePositive ? by - radius : by + radius;
  // `P_PointOnDivlineSide` for each end: not crossed if both land the same side.
  const s1 = dirX * (y1 - oy) - dirY * (x1 - ox) < 0;
  const s2 = dirX * (y2 - oy) - dirY * (x2 - ox) < 0;
  if (s1 === s2) return null;
  // `P_InterceptVector`, the crossing's fraction along the trace.
  const ddx = x2 - x1;
  const ddy = y2 - y1;
  const den = ddy * dirX - ddx * dirY;
  if (den === 0) return null;
  const frac = ((x1 - ox) * ddy + (oy - y1) * ddx) / den;
  return frac < 0 ? null : frac;
}

/**
 * How far an explosion at (px, py) is from the **edge** of the body of
 * half-width `radius` at (bx, by), never below 0 — vanilla's `PIT_RadiusAttack`
 * (`p_map.c`), which is what its splash falls off over.
 *
 * Neither centre-to-centre nor Euclidean: vanilla subtracts the body's own
 * radius and measures on the Chebyshev metric, which together decide how much
 * splash a wide monster takes. Whole map units, floored as vanilla's `>> FRACBITS` leaves them, so
 * a splash deals whole points. See docs/combat.md § Splash and the BFG.
 */
export function blastDistanceToBox(px: number, py: number, bx: number, by: number, radius: number): number {
  const dx = Math.abs(bx - px);
  const dy = Math.abs(by - py);
  const dist = Math.floor((dx > dy ? dx : dy) - radius);
  return dist < 0 ? 0 : dist;
}

/**
 * How far from a body's centre either box test can reach — its half-diagonal.
 * A grid prefilter feeding `traceHitsBox` or `segmentEntersBox` has to be
 * inflated by this or the widest bodies are dropped before the test sees them,
 * which shows up only as a hit-rate change on crowded maps.
 */
export function boxReach(halfWidth: number): number {
  return halfWidth * Math.SQRT2;
}

/**
 * Where along the segment (x1,y1)→(x2,y2) a point first enters the axis-aligned
 * box of half-width `half` centred on (bx, by), as a parameter in [0, 1], or
 * null if it never does — vanilla's `PIT_CheckThing` overlap
 * (`blockdist = thing->radius + tmthing->radius`, missing on
 * `abs(dx) >= blockdist || abs(dy) >= blockdist`), swept along the step rather
 * than sampled at its end.
 *
 * Sweeping is this engine's own; under the tic lock the fastest missile covers
 * 25 units a step, narrower than any box it can meet, so it is belt-and-braces
 * rather than load-bearing (`tests/regression/projectile-contact.test.ts`).
 * Exactly grazing the box is a miss, matching vanilla's `>=`.
 * See docs/monster-attacks.md § Monster projectiles in flight.
 */
export function segmentEntersBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bx: number,
  by: number,
  half: number,
): number | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0) {
    if (Math.abs(x1 - bx) >= half) return null;
  } else {
    let near = (bx - half - x1) / dx;
    let far = (bx + half - x1) / dx;
    if (near > far) [near, far] = [far, near];
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
  }

  if (dy === 0) {
    if (Math.abs(y1 - by) >= half) return null;
  } else {
    let near = (by - half - y1) / dy;
    let far = (by + half - y1) / dy;
    if (near > far) [near, far] = [far, near];
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
  }

  return t0 < t1 ? t0 : null;
}

/**
 * How far along the ray from (ox,oy,oz) in direction (dx,dy,dz) it first enters the box of
 * half-width `half` centred on (bx, by) and standing from `floor` up to `top`, or null if it never
 * does. The one 3D primitive here, and its only caller is auto-aim's pick
 * (`ThingLayer.pickMonster`): a body's own `mobjinfo` box against the ray from the camera, a plain
 * box and deliberately **not** `traceHitsBox`'s direction-dependent diagonal. Slab-clipped like
 * `segmentEntersBox`, with the same explicit guard on an axis-parallel component and the same
 * "exactly grazing is a miss". The far end is unbounded: a pointer ray has no length of its own,
 * and the near crossing is what orders candidates. docs/combat.md § Auto-aim.
 */
export function rayEntersBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  bx: number,
  by: number,
  half: number,
  floor: number,
  top: number,
): number | null {
  let t0 = 0;
  let t1 = Infinity;

  if (dx === 0) {
    if (Math.abs(ox - bx) >= half) return null;
  } else {
    const a = (bx - half - ox) / dx;
    const b = (bx + half - ox) / dx;
    const near = a < b ? a : b;
    const far = a < b ? b : a;
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    // Bailing out per axis rather than once at the end: `pickMonster` runs this over every thing
    // on the map each tic and nearly all of them miss, so most calls should end on the first slab.
    if (t0 >= t1) return null;
  }

  if (dy === 0) {
    if (Math.abs(oy - by) >= half) return null;
  } else {
    const a = (by - half - oy) / dy;
    const b = (by + half - oy) / dy;
    const near = a < b ? a : b;
    const far = a < b ? b : a;
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 >= t1) return null;
  }

  // The vertical slab is the body's feet-to-head span, which unlike the two above is not centred
  // on the anchor: a thing's `z` is where it stands.
  if (dz === 0) {
    if (oz <= floor || oz >= top) return null;
  } else {
    const a = (floor - oz) / dz;
    const b = (top - oz) / dz;
    const near = a < b ? a : b;
    const far = a < b ? b : a;
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
  }

  return t0 < t1 ? t0 : null;
}

/**
 * Mean of a flat [x0,y0, x1,y1, …] polygon's vertexes — inside it for a convex
 * one, which every subsector polygon is. The one primitive here that returns a
 * point rather than scalars: every caller wants both coordinates, and each asks
 * once per subsector — at level build, or on a mover rebuild, or on a leaf's
 * first use — never per frame, so the object costs nothing where it is used.
 */
export function polygonCentroid(poly: ArrayLike<number>): Pos2 {
  const n = poly.length / 2;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += poly[i * 2];
    y += poly[i * 2 + 1];
  }
  return { x: x / n, y: y / n };
}

/** A flat polygon's axis-aligned extent, filled by `polygonBounds` into a caller-owned buffer. */
export interface PolygonBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The axis-aligned box around a flat [x0,y0, x1,y1, …] polygon, written into `out`. An out-param
 * rather than a fresh object for the reason the module header gives: the dicing loop asks once per
 * cut polygon, and a mover re-cuts every frame it moves.
 */
export function polygonBounds(poly: ArrayLike<number>, out: PolygonBounds): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i];
    const y = poly[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  out.minX = minX;
  out.minY = minY;
  out.maxX = maxX;
  out.maxY = maxY;
}

/**
 * Point-in-convex-polygon test via consistent cross-product sign (works for
 * either winding order, since only sign *agreement* across edges matters).
 * `poly` is a flat [x0,y0, x1,y1, …] array. The degenerate case of
 * `segmentMeetsConvexPolygon` below, which is what the renderer itself asks;
 * this stays as the primitive tests assert a footprint with.
 */
export function pointInConvexPolygon(px: number, py: number, poly: ArrayLike<number>): boolean {
  const n = Math.floor(poly.length / 2);
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[((i + 1) % n) * 2];
    const by = poly[((i + 1) % n) * 2 + 1];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/**
 * Whether any part of the segment `(x0, y0) → (x1, y1)` lies inside the convex
 * `poly` (a flat [x0,y0, x1,y1, …] array), touching edges included. The
 * segment twin of `pointInConvexPolygon`, and the one `FlatFader` actually
 * needs: a sightline meets a floor's height plane over a whole *span* rather
 * than at a point, because the thing it must reveal is an upright sprite with
 * height — docs/render-occlusion.md § Flats.
 *
 * A Cyrus-Beck clip: each edge is a half-plane the segment's parameter range is
 * narrowed against, so the whole test is one pass over the edges and allocates
 * nothing. Either winding works, the way it does for `pointInConvexPolygon` —
 * but this one has to *know* which, so a caller asking the same immutable ring
 * every frame passes `wind` (-1 or 1) from its own memo rather than paying a
 * shoelace pass per call; omitted, it is derived here.
 */
export function segmentMeetsConvexPolygon(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  poly: ArrayLike<number>,
  wind?: number,
): boolean {
  const n = Math.floor(poly.length / 2);
  if (n < 3) return false;
  const w = wind ?? (signedPolygonArea2(poly) < 0 ? -1 : 1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  let enter = 0;
  let exit = 1;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const ex = poly[((i + 1) % n) * 2] - ax;
    const ey = poly[((i + 1) % n) * 2 + 1] - ay;
    // Inside is `at + t * rate >= 0`, oriented by the ring's winding.
    const at = w * (ex * (y0 - ay) - ey * (x0 - ax));
    const rate = w * (ex * dy - ey * dx);
    if (rate === 0) {
      // Parallel to this edge: either the whole segment clears it or none of it does.
      if (at < 0) return false;
      continue;
    }
    const t = -at / rate;
    if (rate > 0) {
      if (t > enter) enter = t;
    } else if (t < exit) {
      exit = t;
    }
    if (enter > exit) return false;
  }
  return true;
}

const CLIP_EPS = 1e-6;

/**
 * Twice the shoelace sum of a flat `[x0,y0, x1,y1, …]` ring — that is, the **signed** area:
 * positive counter-clockwise, negative clockwise, and its magnitude the area. Fewer than three
 * points has none.
 *
 * The one shoelace in the tree: `render/solids.ts` asks it which way a ring winds,
 * `render/mapmesh.ts` asks how much a diced cell covers, and the tests assert on both. Returning
 * the signed value un-halved keeps every caller's own convention one operation away (`Math.abs`,
 * `/ 2`) rather than making four bodies of the same arithmetic that differ only in which they
 * applied.
 */
export function signedPolygonArea2(poly: ArrayLike<number>): number {
  const n = Math.floor(poly.length / 2);
  if (n < 3) return 0;
  let sum = 0;
  let ax = poly[(n - 1) * 2];
  let ay = poly[(n - 1) * 2 + 1];
  for (let i = 0; i < n; i++) {
    const bx = poly[i * 2];
    const by = poly[i * 2 + 1];
    sum += ax * by - bx * ay;
    ax = bx;
    ay = by;
  }
  return sum;
}

/**
 * Clips a convex polygon against the half-plane cross(p) <= 0 (Sutherland-Hodgman).
 * The line is given as a point (px, py) plus a direction (dx, dy). `poly` is a
 * flat [x0,y0, x1,y1, …] array; the result may have more or fewer points.
 *
 * `tolerance` (map units, default 0) pushes the line that far towards the
 * discarded side, so the result keeps anything within that distance of it. The
 * result is still a proper half-plane clip of the input, hence still convex and
 * still a subset of it.
 *
 * `out` lets a caller that clips in a loop reuse one buffer instead of taking a fresh array per
 * cut (`mapmesh.ts`'s `diceOnGrid`, which cuts every flat on the map against a grid). It is
 * cleared on entry, so it must **not** alias `poly`.
 */
export function clipConvexPolygon(
  poly: ArrayLike<number>,
  px: number,
  py: number,
  dx: number,
  dy: number,
  tolerance = 0,
  out: number[] = [],
): number[] {
  out.length = 0;
  const n = poly.length / 2;
  if (n === 0) return out;

  // The side test is a cross product, so it scales with the direction's length:
  // the tolerance has to be scaled the same way to mean a distance in map units.
  // `CLIP_EPS` only decides which side a point counts as being on; the cut runs
  // through the tolerance-offset line itself, so tolerance 0 clips exactly.
  const cut = tolerance === 0 ? 0 : tolerance * vecLength(dx, dy);
  const limit = cut + CLIP_EPS;

  let ax = poly[(n - 1) * 2];
  let ay = poly[(n - 1) * 2 + 1];
  let da = dx * (ay - py) - dy * (ax - px);

  for (let i = 0; i < n; i++) {
    const bx = poly[i * 2];
    const by = poly[i * 2 + 1];
    const db = dx * (by - py) - dy * (bx - px);

    const aIn = da <= limit;
    const bIn = db <= limit;

    if (aIn !== bIn) {
      const t = (da - cut) / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
    if (bIn) out.push(bx, by);

    ax = bx;
    ay = by;
    da = db;
  }
  return out;
}
