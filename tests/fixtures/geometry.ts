/**
 * Measurements over the flat `[x0,y0, x1,y1, …]` polygons `util/geom.ts` and
 * `render/bsp.ts` pass around, for tests that need to assert on a shape rather than
 * on its individual vertices.
 */

/** Shoelace area of a polygon, whichever way it winds. Fewer than three points has no area. */
export function polygonArea(poly: ArrayLike<number>): number {
  const n = Math.floor(poly.length / 2);
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  return Math.abs(sum) / 2;
}
