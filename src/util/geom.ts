/**
 * 2D segment intersection between (ax,ay)-(bx,by) and (cx,cy)-(dx,dy).
 * Returns the crossing's parameter `t` along the first segment, or null if
 * they don't cross within both segments' bounds. Shared by render/occlusion.ts
 * (camera-player sightline vs. wall) and game/fogofwar.ts (player-sample
 * sightline vs. solid wall) — same primitive, different segments.
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
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;

  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;

  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t };
}

/**
 * Where along the segment a→b its closest point to (px, py) lies, as a
 * parameter clamped to [0, 1]. Split out of `distSqToSegment` because a
 * projectile's swept hit test needs the *position* of closest approach (to
 * interpolate the missile's height there), not just the distance.
 */
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
 * Vanilla's collision box as the circle this engine tests instead. A DOOM thing
 * is an axis-aligned square of half-width `halfWidth` (`PIT_CheckThing`'s
 * `blockdist`, `PIT_AddThingIntercepts`'s bounding box), which something
 * arriving on an arbitrary bearing sees as `perimeter/π` wide on average rather
 * than `2·halfWidth`; the circle presenting that same mean width has radius
 * `4·halfWidth/π`. Used by every shot-vs-body test — `ThingLayer.raycastMonster`
 * and `ProjectileLayer`'s swept hit tests — and it is the same conversion
 * `MONSTER_BULLET_SLOP` (game/monsters/attacks.ts) already applies by hand to
 * the player's own 16-unit box. See docs/combat.md § How a shot deals damage.
 */
export function boxToCircleRadius(halfWidth: number): number {
  return (halfWidth * 4) / Math.PI;
}

/**
 * Point-in-convex-polygon test via consistent cross-product sign (works for
 * either winding order, since only sign *agreement* across edges matters).
 * `poly` is a flat [x0,y0, x1,y1, …] array. Used by render/occlusion.ts's
 * `FlatFader` to test whether a camera-player sightline's height-crossing
 * point falls inside a raised floor's footprint.
 */
export function pointInConvexPolygon(px: number, py: number, poly: ArrayLike<number>): boolean {
  const n = poly.length / 2;
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
 * Like `pointInConvexPolygon`, but also true when the point is within
 * `radius` of the polygon's boundary. A single subsector polygon is a BSP
 * implementation detail, not a visual unit — one physical floor (e.g. a
 * raised platform) routinely gets split into several adjacent subsector
 * polygons that share edges. The exact height-crossing point of a
 * camera-player sightline can only ever land inside *one* of those pieces,
 * but the player has real width (their collision circle, at least), so a
 * neighbouring piece just across that shared edge is just as much "in the
 * way" on screen. Inflating the test by the player's radius catches those
 * without needing to know which polygons are fragments of the same surface.
 */
export function pointNearConvexPolygon(px: number, py: number, poly: ArrayLike<number>, radius: number): boolean {
  if (pointInConvexPolygon(px, py, poly)) return true;
  const n = poly.length / 2;
  const r2 = radius * radius;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[((i + 1) % n) * 2];
    const by = poly[((i + 1) % n) * 2 + 1];
    if (distSqToSegment(px, py, ax, ay, bx, by) <= r2) return true;
  }
  return false;
}

const CLIP_EPS = 1e-6;

/**
 * Clips a convex polygon against the half-plane cross(p) <= 0 (Sutherland-Hodgman).
 * The line is given as a point (px, py) plus a direction (dx, dy). `poly` is a
 * flat [x0,y0, x1,y1, …] array; the result may have more or fewer points.
 *
 * `tolerance` (map units, default 0) pushes the line that far towards the
 * discarded side, so the result keeps anything within that distance of it. The
 * result is still a proper half-plane clip of the input, hence still convex and
 * still a subset of it.
 */
export function clipConvexPolygon(
  poly: number[],
  px: number,
  py: number,
  dx: number,
  dy: number,
  tolerance = 0,
): number[] {
  const n = poly.length / 2;
  if (n === 0) return poly;
  const out: number[] = [];

  // `side` is a cross product, so it scales with the direction's length: the
  // tolerance has to be scaled the same way to mean a distance in map units.
  // `CLIP_EPS` only decides which side a point counts as being on; the cut runs
  // through the tolerance-offset line itself, so tolerance 0 clips exactly.
  const cut = tolerance * Math.hypot(dx, dy);
  const limit = cut + CLIP_EPS;
  const side = (x: number, y: number) => dx * (y - py) - dy * (x - px);

  let ax = poly[(n - 1) * 2];
  let ay = poly[(n - 1) * 2 + 1];
  let da = side(ax, ay);

  for (let i = 0; i < n; i++) {
    const bx = poly[i * 2];
    const by = poly[i * 2 + 1];
    const db = side(bx, by);

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
