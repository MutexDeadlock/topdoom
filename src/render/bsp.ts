/**
 * Reconstructs each subsector's convex floor polygon from the BSP: the node planes above it,
 * clipped against its own segs — sparing that clip where a wall stops inside the leaf, and
 * redirecting a leaf hidden behind self-referencing lines to the sector that encloses it.
 * Both ask `sectorprobe.ts` where a point is, since the BSP is what is being rebuilt here.
 * See docs/render.md § BSP polygon reconstruction, § Walls that stop inside their cell and
 * § Self-referencing sectors.
 */
import { SUBSECTOR_BIT, type DoomMap, type Vertex } from '../wad/map.ts';
import { clipConvexPolygon as clip, polygonCentroid } from '../util/geom.ts';
import { SectorProbe, selfReferencing } from './sectorprobe.ts';

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

/**
 * How far the line may run past the wall on it before that overhang is looked at,
 * in map units. Measured, like the two tolerances above: the cracks this has to
 * tolerate are rounding-scale, and the overhangs it has to catch are the length
 * of a wall stub — tens of units — so anything in between works.
 * docs/render.md § Walls that stop inside their cell.
 */
const SEG_SPAN_SLACK = 4;

/**
 * How far past a wall's end, and how far off its line, the ground beyond it is
 * probed. Tuned by feel between the same two bounds as `SEG_SPAN_SLACK`: enough
 * to clear the line itself, little enough to stay in whatever is immediately
 * around the corner.
 */
const WALL_END_PROBE = 4;

/** One of a leaf's segs, endpoints as the VERTEXES records the map already holds. */
interface Wall {
  a: Vertex;
  b: Vertex;
}

/**
 * Whether the wall on this seg's line really bounds `cell`, so that clipping the
 * cell by that line is right — false where the wall stops inside the cell and
 * the same leaf carries on around its end, which a clip by the infinite line
 * would cut away. Decided by probing the ground just past the end the leaf's
 * walls cover, on the side the clip would remove; the sparing is then bounded to
 * overhangs this sector could own at all.
 * docs/render.md § Walls that stop inside their cell.
 */
function wallBoundsCell(probe: () => SectorProbe, cell: number[], walls: Wall[], index: number, sector: number): boolean {
  const { a, b } = walls[index];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return true;

  // Where the wall's infinite line crosses the cell, in the wall's own parameter.
  const n = cell.length / 2;
  let tMin = Infinity;
  let tMax = -Infinity;
  let px = cell[(n - 1) * 2];
  let py = cell[(n - 1) * 2 + 1];
  let dPrev = dx * (py - a.y) - dy * (px - a.x);
  for (let i = 0; i < n; i++) {
    const qx = cell[i * 2];
    const qy = cell[i * 2 + 1];
    const dCur = dx * (qy - a.y) - dy * (qx - a.x);
    if (dPrev > 0 !== dCur > 0 && dPrev !== dCur) {
      const f = dPrev / (dPrev - dCur);
      const ix = px + (qx - px) * f;
      const iy = py + (qy - py) * f;
      const t = ((ix - a.x) * dx + (iy - a.y) * dy) / lengthSq;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    px = qx;
    py = qy;
    dPrev = dCur;
  }
  // The line misses the cell entirely: clipping by it is a no-op either way.
  if (tMin > tMax) return true;

  const length = Math.sqrt(lengthSq);
  const slack = SEG_SPAN_SLACK / length;
  // `lineCoverage` only ever widens [0, 1], so a crossing inside that span is
  // covered whatever the scan would say. With the miss above, this leaves only
  // about one wall in ten actually paying for the scan (measured on EPIC MAP03).
  if (tMin >= -slack && tMax <= 1 + slack) return true;

  const cover = lineCoverage(walls, index);
  const beforeStart = cover.min - tMin > slack;
  const afterEnd = tMax - cover.max > slack;
  if (!beforeStart && !afterEnd) return true;
  // What sparing the clip would spare is the piece on the far side of the line,
  // whole — so it has to be a piece this sector could own.
  if (!probe().withinSector(sector, clip(cell, a.x, a.y, -dx, -dy), SEG_CLIP_MAX_TOLERANCE)) return true;

  // The clip keeps `side <= tolerance` (util/geom.ts), so it removes the left
  // side of the seg's own direction — which is where the probe steps.
  const offX = (-dy / length) * WALL_END_PROBE;
  const offY = (dx / length) * WALL_END_PROBE;
  const stepX = (dx / length) * WALL_END_PROBE;
  const stepY = (dy / length) * WALL_END_PROBE;
  const floorPast = (t: number, away: number) =>
    probe().sectorIndexAt(a.x + dx * t + away * stepX + offX, a.y + dy * t + away * stepY + offY) === sector;
  if (beforeStart && floorPast(cover.min, -1)) return false;
  if (afterEnd && floorPast(cover.max, 1)) return false;
  return true;
}

/** How far off a seg's line another seg may sit and still count as lying on it. Tuned by feel. */
const COLLINEAR_EPS = 1;

/**
 * How far along this wall's line the leaf's walls on that line reach, in the
 * wall's own parameter — [0, 1] widened by every collinear neighbour. Only the
 * one caller above, and only once it knows the answer can matter.
 */
function lineCoverage(walls: Wall[], index: number): { min: number; max: number } {
  const { a, b } = walls[index];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const length = Math.sqrt(lengthSq);
  const cover = { min: 0, max: 1 };
  for (const [i, other] of walls.entries()) {
    if (i === index) continue;
    const offA = Math.abs(dx * (other.a.y - a.y) - dy * (other.a.x - a.x)) / length;
    const offB = Math.abs(dx * (other.b.y - a.y) - dy * (other.b.x - a.x)) / length;
    if (offA > COLLINEAR_EPS || offB > COLLINEAR_EPS) continue;
    const tA = ((other.a.x - a.x) * dx + (other.a.y - a.y) * dy) / lengthSq;
    const tB = ((other.b.x - a.x) * dx + (other.b.y - a.y) * dy) / lengthSq;
    cover.min = Math.min(cover.min, tA, tB);
    cover.max = Math.max(cover.max, tA, tB);
  }
  return cover;
}

export interface SubSectorPoly {
  /**
   * Sector this subsector is *drawn* as — everything reading this field (flats,
   * mover meshes in `render/mapmesh.ts`) follows it. Usually the one its segs
   * resolve to, but a leaf bounded only by self-referencing lines takes the
   * sector enclosing it instead; gameplay wants the BSP sector and asks
   * `sectorOfSubSector` for it. docs/render.md § Self-referencing sectors.
   */
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

  // Built on the first leaf that actually needs it: a map with neither a wall
  // stub inside a leaf nor a self-referencing sector never probes at all, and
  // the stock IWADs are all of that kind.
  let sectorProbe: SectorProbe | null = null;
  const probe = () => (sectorProbe ??= new SectorProbe(map));

  const finishLeaf = (ssIndex: number, poly: number[]) => {
    const ss = map.subsectors[ssIndex];
    if (!ss) return;

    const walls: Wall[] = [];
    let allSelfRef = true;
    for (let i = 0; i < ss.count; i++) {
      const seg = map.segs[ss.first + i];
      if (!seg) continue;
      const a = map.vertexes[seg.v1];
      const b = map.vertexes[seg.v2];
      if (!a || !b) continue;
      walls.push({ a, b });
      if (!selfReferencing(map, seg.linedef)) allSelfRef = false;
    }

    let sector = sectorOfSubSector(map, ssIndex);
    let clipped = poly;
    for (const [i, wall] of walls.entries()) {
      if (!wallBoundsCell(probe, clipped, walls, i, sector)) continue;
      clipped = clip(clipped, wall.a.x, wall.a.y, wall.b.x - wall.a.x, wall.b.y - wall.a.y, segClipTolerance(clipped, wall.a, wall.b));
      if (clipped.length < 6) break;
    }

    // A leaf bounded only by self-referencing lines draws as the sector
    // *enclosing* it, the way vanilla shows it — docs/render.md § Self-referencing sectors.
    if (allSelfRef && walls.length > 0 && clipped.length >= 6) {
      const centre = polygonCentroid(clipped);
      const enclosing = probe().sectorIndexAt(centre.x, centre.y, true);
      if (enclosing >= 0) sector = enclosing;
    }

    result[ssIndex] = {
      sector,
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
