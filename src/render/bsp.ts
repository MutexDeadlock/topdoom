import { SUBSECTOR_BIT, type DoomMap } from '../wad/map.ts';

export interface SubSectorPoly {
  /** Sector this subsector belongs to. */
  sector: number;
  /** Convex polygon in DOOM coordinates, counter-clockwise. */
  points: Float64Array; // [x0,y0, x1,y1, …]
}

const EPS = 1e-6;

/**
 * Clips a convex polygon against the half-plane cross(p) <= 0 (Sutherland-Hodgman).
 * The line is given as a point (px, py) plus a direction (dx, dy).
 */
function clip(poly: number[], px: number, py: number, dx: number, dy: number): number[] {
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

    const aIn = da <= EPS;
    const bIn = db <= EPS;

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

/**
 * SEGS only stores edges that lie on real linedefs; the edges introduced by BSP
 * splits are missing. So each subsector is rebuilt by taking a large starting quad
 * and clipping it against every partition line on the path from the root to the
 * leaf, and finally against each of the subsector's segs.
 */
export function buildSubSectorPolys(map: DoomMap): SubSectorPoly[] {
  const { bounds } = map;
  const pad = 512;
  const x0 = bounds.minX - pad;
  const y0 = bounds.minY - pad;
  const x1 = bounds.maxX + pad;
  const y1 = bounds.maxY + pad;

  const result: SubSectorPoly[] = new Array(map.subsectors.length);

  const finishLeaf = (ssIndex: number, poly: number[]) => {
    const ss = map.subsectors[ssIndex];
    if (!ss) return;

    let clipped = poly;
    for (let i = 0; i < ss.count; i++) {
      const seg = map.segs[ss.first + i];
      if (!seg) continue;
      const a = map.vertexes[seg.v1];
      const b = map.vertexes[seg.v2];
      if (!a || !b) continue;
      clipped = clip(clipped, a.x, a.y, b.x - a.x, b.y - a.y);
      if (clipped.length < 6) break;
    }

    result[ssIndex] = {
      sector: sectorOfSubSector(map, ssIndex),
      points: Float64Array.from(clipped.length >= 6 ? clipped : []),
    };
  };

  // Iterative rather than recursive: some maps have very deep BSP trees.
  const stack: { child: number; poly: number[] }[] = [];
  const rootIndex = map.nodes.length - 1;

  if (map.nodes.length === 0) {
    // Maps without nodes: each subsector only gets the hull formed by its segs.
    for (let i = 0; i < map.subsectors.length; i++) {
      finishLeaf(i, [x0, y0, x1, y0, x1, y1, x0, y1]);
    }
    return result;
  }

  stack.push({ child: rootIndex, poly: [x0, y0, x1, y0, x1, y1, x0, y1] });

  while (stack.length > 0) {
    const { child, poly } = stack.pop()!;

    if (child & SUBSECTOR_BIT) {
      finishLeaf(child & ~SUBSECTOR_BIT, poly);
      continue;
    }
    const node = map.nodes[child];
    if (!node) continue;

    // Right side: cross <= 0. Left side: cross >= 0, i.e. clip with a mirrored direction.
    const right = clip(poly, node.x, node.y, node.dx, node.dy);
    const left = clip(poly, node.x, node.y, -node.dx, -node.dy);

    if (right.length >= 6) stack.push({ child: node.rightChild, poly: right });
    if (left.length >= 6) stack.push({ child: node.leftChild, poly: left });
  }

  // Mark subsectors the traversal never reached (broken nodes) as empty.
  for (let i = 0; i < result.length; i++) {
    if (!result[i]) result[i] = { sector: sectorOfSubSector(map, i), points: new Float64Array(0) };
  }
  return result;
}

/** Sector of a subsector, resolved via its first seg -> linedef -> sidedef. */
export function sectorOfSubSector(map: DoomMap, ssIndex: number): number {
  const ss = map.subsectors[ssIndex];
  if (!ss) return 0;
  for (let i = 0; i < ss.count; i++) {
    const seg = map.segs[ss.first + i];
    if (!seg) continue;
    const line = map.linedefs[seg.linedef];
    if (!line) continue;
    const sideIndex = seg.direction === 0 ? line.right : line.left;
    const side = map.sidedefs[sideIndex];
    if (side) return side.sector;
  }
  return 0;
}
