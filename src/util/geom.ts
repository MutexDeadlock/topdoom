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

/** Squared distance from a point to a line segment. */
export function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t - px;
  const cy = ay + dy * t - py;
  return cx * cx + cy * cy;
}

const CLIP_EPS = 1e-6;

/**
 * Clips a convex polygon against the half-plane cross(p) <= 0 (Sutherland-Hodgman).
 * The line is given as a point (px, py) plus a direction (dx, dy). `poly` is a
 * flat [x0,y0, x1,y1, …] array; the result may have more or fewer points.
 */
export function clipConvexPolygon(poly: number[], px: number, py: number, dx: number, dy: number): number[] {
  const n = poly.length / 2;
  if (n === 0) return poly;
  const out: number[] = [];

  const side = (x: number, y: number) => dx * (y - py) - dy * (x - px);

  let ax = poly[(n - 1) * 2];
  let ay = poly[(n - 1) * 2 + 1];
  let da = side(ax, ay);

  for (let i = 0; i < n; i++) {
    const bx = poly[i * 2];
    const by = poly[i * 2 + 1];
    const db = side(bx, by);

    const aIn = da <= CLIP_EPS;
    const bIn = db <= CLIP_EPS;

    if (aIn !== bIn) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
    if (bIn) out.push(bx, by);

    ax = bx;
    ay = by;
    da = db;
  }
  return out;
}
