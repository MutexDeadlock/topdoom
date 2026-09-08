/**
 * Measurements over the flat `[x0,y0, x1,y1, …]` polygons `util/geom.ts` and
 * `render/bsp.ts` pass around, for tests that need to assert on a shape rather than
 * on its individual vertices.
 * See docs/testing.md § Shared helpers.
 */
import { signedPolygonArea2 } from '../../src/util/geom.ts';

/** Shoelace area of a polygon, whichever way it winds. Fewer than three points has no area. */
export function polygonArea(poly: ArrayLike<number>): number {
  return Math.abs(signedPolygonArea2(poly)) / 2;
}
