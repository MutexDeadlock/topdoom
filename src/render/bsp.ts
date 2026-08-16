/**
 * Reconstructs each subsector's convex floor polygon from the BSP: the node planes above it,
 * clipped against its own segs. See docs/render.md § BSP polygon reconstruction.
 */
import { SUBSECTOR_BIT, type DoomMap, type Vertex } from '../wad/map.ts';
import { clipConvexPolygon as clip } from '../util/geom.ts';

/**
 * Least slack, in map units, on the clip against a subsector's own segs: how far the
 * node-clipped cell may stick out past a seg's line before that overhang is cut
 * away. Without it, a seg line that disagrees with the partition it shares an
 * edge with by a rounding error shaves a sliver off the cell that the neighbouring
 * subsector doesn't fill — a visible crack in the floor.
 * docs/render.md § Cracks between subsectors.
 */
const SEG_CLIP_TOLERANCE = 4;
/** Most slack `segClipTolerance` will hand one seg. Both bounds are measured, not tuned — docs/render.md § Cracks between subsectors. */
const SEG_CLIP_MAX_TOLERANCE = 32;

/**
 * Slack for one seg's clip: how far past its own endpoints the seg's line has to be
 * extrapolated to reach `cell`, in multiples of the seg's own length, clamped between
 * the two tolerances above. That ratio is how far the line can have drifted by the
 * time it gets there — docs/render.md § Cracks between subsectors.
 */
function segClipTolerance(cell: number[], a: Vertex, b: Vertex): number {
  const lengthSq = (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y);
  if (lengthSq === 0) return SEG_CLIP_TOLERANCE;
  // Compared squared, so the whole scan costs one square root rather than one per corner.
  let reachSq = 0;
  for (let i = 0; i < cell.length; i += 2) {
    const x = cell[i];
    const y = cell[i + 1];
    const dSq = Math.min((x - a.x) * (x - a.x) + (y - a.y) * (y - a.y), (x - b.x) * (x - b.x) + (y - b.y) * (y - b.y));
    if (dSq > reachSq) reachSq = dSq;
  }
  return Math.min(SEG_CLIP_MAX_TOLERANCE, Math.max(SEG_CLIP_TOLERANCE, Math.sqrt(reachSq / lengthSq)));
}

export interface SubSectorPoly {
  /** Sector this subsector belongs to. */
  sector: number;
  /** Convex polygon in DOOM coordinates, counter-clockwise. */
  points: Float64Array; // [x0,y0, x1,y1, …]
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
      clipped = clip(clipped, a.x, a.y, b.x - a.x, b.y - a.y, segClipTolerance(clipped, a, b));
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
