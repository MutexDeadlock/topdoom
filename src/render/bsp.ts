/**
 * Reconstructs each subsector's convex floor polygon from the BSP: the node planes above it,
 * clipped against its own segs — sparing that clip where a wall stops inside the leaf or a
 * seg was filed into the wrong side of its own line, and redirecting a leaf hidden behind
 * self-referencing lines to the sector that encloses it. All of these ask `sectorprobe.ts`
 * where a point is, since the BSP is what is being rebuilt here. Over those polygons it also
 * answers which leaves border which, the adjacency vanilla SEGS carries no minisegs to state,
 * and which of them form one connected region.
 * See docs/render.md § BSP polygon reconstruction, § Walls that stop inside their cell,
 * § Segs on the wrong side of their leaf, § Self-referencing sectors, § Leaf adjacency and
 * § Islands.
 */
import { NO_LINE, NO_SIDE, segSide, SUBSECTOR_BIT, type DoomMap, type Seg, type Vertex } from '../wad/map.ts';
import { clipConvexPolygon as clip, polygonCentroid, vecLength } from '../util/geom.ts';
import { SectorProbe, selfReferencing } from './sectorprobe.ts';

/**
 * A convex floor patch and the sector whose flat it wears — all a flat needs to
 * be drawn, and so what the mesh builder and `findSolidCaps` take. `SubSectorPoly`
 * is this plus what gameplay needs on top.
 */
export interface SectorPoly {
  /**
   * Sector this patch is *drawn* as — everything reading this field (flats,
   * mover meshes in `render/mapmesh.ts`) follows it. Usually the one its segs
   * resolve to, but a leaf bounded only by self-referencing lines takes the
   * sector enclosing it instead. docs/render.md § Self-referencing sectors.
   */
  sector: number;
  /** Convex polygon in DOOM coordinates, counter-clockwise. */
  points: Float64Array; // [x0,y0, x1,y1, …]
}

export interface SubSectorPoly extends SectorPoly {
  /**
   * Sector **gameplay** resolves this leaf to — floor/ceiling heights, sector
   * specials, sound propagation. Vanilla's `subsector->sector`, except on a leaf
   * the node builder filed under its neighbour through a wrong-side seg, where
   * it follows that repair instead: a **deliberate deviation** from
   * `R_PointInSubsector`, which reports the misfiled sector there — taken
   * because a top-down camera shows the disagreement between the floor drawn
   * and the floor stood on. It never follows the self-referencing redirect,
   * whose whole point is that gameplay keeps the hidden sector.
   * docs/render.md § Segs on the wrong side of their leaf.
   */
  physicalSector: number;
}

/**
 * Which leaves border each one, as compressed rows: leaf `i`'s neighbours are
 * `leaves[starts[i]]` up to `leaves[starts[i + 1]]`.
 */
export interface LeafGraph {
  starts: Int32Array;
  leaves: Int32Array;
}

/**
 * Least slack, in map units, on the clip against a seg whose line the cell is already
 * cut along: how far the node-clipped cell may stick out past that line before the
 * overhang is cut away. Without it, a seg line that disagrees with the partition it
 * shares an edge with by a rounding error shaves a sliver off the cell that the
 * neighbouring subsector doesn't fill — a visible crack in the floor.
 * docs/render.md § Cracks between subsectors.
 */
const SEG_CLIP_TOLERANCE = 4;

/**
 * Most slack `segClipTolerance` will hand one seg. Both bounds are measured, not tuned —
 * docs/render.md § Cracks between subsectors.
 */
const SEG_CLIP_MAX_TOLERANCE = 32;

/**
 * How far off a seg's own endpoints a cell edge may sit and still count as the
 * same line, in map units. A node partition built from a linedef stores integer
 * `(x, y, dx, dy)`, so it can only be a rounding error off that linedef where the
 * two meet; two units is that with headroom.
 * docs/render.md § Cracks between subsectors.
 */
const PARTITION_MATCH = 2;

/**
 * How far past an edge the neighbour probes sample, in map units — `buildLeafGraph`'s and
 * `buildIslands`'. **Tuned by feel**: a robustness value, far enough out to clear the clip's float
 * noise and the overhang `segClipTolerance` leaves, short enough not to step over a sliver leaf
 * whole.
 */
const NEIGHBOUR_PROBE = 0.5;

/**
 * One rebuild per map, handed to all three of its consumers — `World`'s
 * subsector -> sector table, the mesh build and the fog grid all want the same
 * polygons. Weak on the map, so a torn-down level takes its polygons with it.
 * Sharing is safe because a leaf's footprint is fixed geometry: a mover changes
 * sector heights and lights, never `vertexes`/`segs`/`nodes`.
 */
const built = new WeakMap<DoomMap, SubSectorPoly[]>();

/** One rebuild per map, like `buildSubSectorPolys`, and weak on it for the same reason. */
const graphs = new WeakMap<DoomMap, LeafGraph>();

/** One rebuild per map, like `buildLeafGraph`, and weak on it for the same reason. */
const islands = new WeakMap<DoomMap, Int32Array>();

/**
 * SEGS only stores edges that lie on real linedefs; the edges introduced by BSP
 * splits are missing. So each subsector is rebuilt by taking a large starting quad
 * and clipping it against every partition line on the path from the root to the
 * leaf, and finally against each of the subsector's segs — the GL minisegs among
 * them skipped, below. Treat the result as read-only: it is shared between callers.
 */
export function buildSubSectorPolys(map: DoomMap): SubSectorPoly[] {
  const cached = built.get(map);
  if (cached) return cached;
  const polys = rebuildSubSectorPolys(map);
  built.set(map, polys);
  return polys;
}

/** Sector of a subsector, resolved via its first seg -> linedef -> sidedef. */
export function sectorOfSubSector(map: DoomMap, ssIndex: number): number {
  const ss = map.subsectors[ssIndex];
  if (!ss) return 0;
  for (let i = 0; i < ss.count; i++) {
    const seg = map.segs[ss.first + i];
    if (!seg) continue;
    const sector = sectorOfSeg(map, seg);
    if (sector >= 0) return sector;
  }
  return 0;
}

/** Vanilla's `R_PointInSubsector`, or -1 on a tree the descent can't finish. */
export function subsectorAtPoint(map: DoomMap, x: number, y: number): number {
  if (map.nodes.length === 0) return map.subsectors.length > 0 ? 0 : -1;
  let child = map.nodes.length - 1;
  // The tree is data from a file: a corrupt child index could otherwise loop forever.
  for (let step = 0; step <= map.nodes.length; step++) {
    if (child & SUBSECTOR_BIT) {
      const leaf = child & ~SUBSECTOR_BIT;
      return leaf < map.subsectors.length ? leaf : -1;
    }
    const node = map.nodes[child];
    if (!node) return -1;
    // The same side test `rebuildSubSectorPolys` clips with: cross <= 0 is the right child.
    child = node.dx * (y - node.y) - node.dy * (x - node.x) <= 0 ? node.rightChild : node.leftChild;
  }
  return -1;
}

/**
 * Which leaves touch which. Vanilla SEGS carry no minisegs, so a leaf's splits into the rest of
 * its own sector have no edge to read the neighbour off; this recovers them geometrically instead,
 * probing a map unit's half past the midpoint of every polygon edge and descending the tree there.
 * docs/render.md § Leaf adjacency.
 */
export function buildLeafGraph(map: DoomMap): LeafGraph {
  const cached = graphs.get(map);
  if (cached) return cached;
  const graph = rebuildLeafGraph(map);
  graphs.set(map, graph);
  return graph;
}

/**
 * Which connected region each leaf belongs to, as an island per subsector: two leaves share one
 * where a two-sided line or a BSP split joins them, so a map is usually a single island and a
 * second is space only a teleporter reaches. Both union rules below err toward joining, since a
 * link too many only fails to hide something while a link missing is a hole in the view.
 * docs/render.md § Islands, docs/fogofwar.md § Islands for what reads it.
 */
export function buildIslands(map: DoomMap): Int32Array {
  const cached = islands.get(map);
  if (cached) return cached;
  const built = rebuildIslands(map);
  islands.set(map, built);
  return built;
}

/** One of a leaf's segs, endpoints as the VERTEXES records the map already holds. */
interface Wall {
  /** The seg's own endpoints: its extent along the wall, never its line. */
  a: Vertex;
  b: Vertex;
  /**
   * The wall's line — the seg's linedef, oriented the seg's way — which every side
   * question runs along: the clip, the wrong-side judgement, the sparing preview.
   * docs/render.md § Cracks between subsectors.
   */
  lineA: Vertex;
  lineB: Vertex;
  /** The SEGS record itself, so the repairs below can ask what sector its side names. */
  seg: Seg;
  /** Filed into the child on the wrong side of its own line — `wallFacesAwayFromCell`. */
  wrongSide: boolean;
}

function rebuildSubSectorPolys(map: DoomMap): SubSectorPoly[] {
  const { bounds } = map;
  const pad = 512;
  const x0 = bounds.minX - pad;
  const y0 = bounds.minY - pad;
  const x1 = bounds.maxX + pad;
  const y1 = bounds.maxY + pad;

  const result: SubSectorPoly[] = new Array(map.subsectors.length);

  // Built on the first leaf that actually needs it, so a map whose nodes are
  // clean enough that none of the repairs below ever fires pays nothing for them.
  let sectorProbe: SectorProbe | null = null;
  const probe = () => (sectorProbe ??= new SectorProbe(map));

  const finishLeaf = (ssIndex: number, poly: number[]) => {
    const ss = map.subsectors[ssIndex];
    if (!ss) return;

    const walls: Wall[] = [];
    let anyWrongSide = false;
    let allSelfRef = true;
    for (let i = 0; i < ss.count; i++) {
      const seg = map.segs[ss.first + i];
      if (!seg) continue;
      // A GL miniseg lies on the split that made the leaf, which the node clip above has
      // already applied — and every repair below asks a question about a linedef, which a
      // miniseg has none of (docs/wad.md § GL nodes), or about the seg's extent, which a
      // seg with none cannot answer either.
      if (seg.linedef === NO_LINE) continue;
      const a = map.vertexes[seg.v1];
      const b = map.vertexes[seg.v2];
      if (!a || !b || (a.x === b.x && a.y === b.y)) continue;
      const [lineA, lineB] = linedefLine(map, seg) ?? [a, b];
      // Judged here against the untouched node cell: once one wrong-side clip has
      // run, the cell the next would be judged against is already gone.
      const wrongSide = wallFacesAwayFromCell(poly, lineA, lineB);
      anyWrongSide ||= wrongSide;
      walls.push({ a, b, lineA, lineB, seg, wrongSide });
      if (!selfReferencing(map, seg.linedef)) allSelfRef = false;
    }

    // The sector the BSP resolves the leaf to, which is what the clips probe against
    // whichever sector the leaf ends up *drawn* as below.
    const bspSector = sectorOfSubSector(map, ssIndex);
    let sector = bspSector;

    // Segs the node builder filed into the child on the wrong side of their own
    // line are spared their clip entirely — with the drawn sector re-resolved,
    // since such a seg's front speaks for the neighbour — where the cell they
    // would wipe is all floor.
    // docs/render.md § Segs on the wrong side of their leaf.
    let clipped = clipBy(probe, poly, walls, bspSector, anyWrongSide);
    if (anyWrongSide) {
      const enclosing = clipped.length >= 6 ? enclosingSectorOfCell(probe(), clipped) : -1;
      if (enclosing >= 0) {
        sector = enclosing;
        for (const wall of walls) {
          if (wall.wrongSide) continue;
          const named = sectorOfSeg(map, wall.seg);
          if (named >= 0) {
            sector = named;
            break;
          }
        }
      } else {
        // The sparing failed its reality check: every clip stands, in seg order,
        // exactly as it would have without the detection.
        clipped = clipBy(probe, poly, walls, bspSector, false);
      }
    }

    // Read off before the redirect below, which is a drawing rule alone: the
    // wrong-side repair above is the only one that moves where the leaf really
    // *is*. A leaf whose segs all lie on self-referencing lines is exempt from
    // even that — such a seg names one sector on both sides, so it cannot have
    // been filed under the wrong one, and the trick needs gameplay to keep the
    // hidden sector. docs/render.md § Segs on the wrong side of their leaf.
    const physicalSector = allSelfRef ? bspSector : sector;

    // A leaf bounded only by self-referencing lines draws as the sector *enclosing*
    // it, the way vanilla shows it — and outranks the redirect above, whose "first
    // correctly filed seg" would name one of the very sectors being hidden.
    // docs/render.md § Self-referencing sectors.
    if (allSelfRef && walls.length > 0 && clipped.length >= 6) {
      const centre = polygonCentroid(clipped);
      const enclosing = probe().sectorIndexAt(centre.x, centre.y, true);
      if (enclosing >= 0) sector = enclosing;
    }

    result[ssIndex] = {
      sector,
      physicalSector,
      points: Float64Array.from(clipped.length >= 6 ? clipped : []),
    };
  };

  // Iterative rather than recursive: some maps have very deep BSP trees.
  const stack: { child: number; poly: number[] }[] = [];
  if (map.nodes.length === 0) {
    // Maps without nodes: each subsector only gets the hull formed by its segs.
    for (let i = 0; i < map.subsectors.length; i++) {
      finishLeaf(i, [x0, y0, x1, y0, x1, y1, x0, y1]);
    }
  } else {
    stack.push({ child: map.nodes.length - 1, poly: [x0, y0, x1, y0, x1, y1, x0, y1] });
  }

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

  // Every index ends up filled, so callers can index the result bare: leaves the
  // traversal never reached (broken nodes) are marked empty here.
  for (let i = 0; i < result.length; i++) {
    if (!result[i]) {
      const sector = sectorOfSubSector(map, i);
      result[i] = { sector, physicalSector: sector, points: new Float64Array(0) };
    }
  }
  return result;
}

/**
 * The seg's linedef, oriented the seg's way — the wall's line, where a split seg's
 * own endpoints are rounded off it — or null where the linedef or a vertex of it is
 * missing. `Seg.direction` is the one record of which way the seg runs.
 * docs/render.md § Cracks between subsectors.
 */
function linedefLine(map: DoomMap, seg: Seg): [Vertex, Vertex] | null {
  const line = map.linedefs[seg.linedef];
  const v1 = line && map.vertexes[line.v1];
  const v2 = line && map.vertexes[line.v2];
  if (!v1 || !v2) return null;
  return seg.direction === 0 ? [v1, v2] : [v2, v1];
}

/**
 * Whether the leaf's node-plane cell lies entirely on the side of this wall that
 * its clip would discard — a seg the node builder filed into the child on the
 * *wrong side* of its own line. A seg that really bounds its cell has the cell on
 * its keep side; clipping by a wrong-side one would wipe the cell down to the
 * tolerance band and leave the rest a hole. The caller double-checks against the
 * ground before sparing anything. docs/render.md § Segs on the wrong side of their leaf.
 */
function wallFacesAwayFromCell(cell: number[], a: Vertex, b: Vertex): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  // Both tolerances are scaled by the length instead of the cross products divided
  // by it, so the scan costs one square root rather than a division per corner.
  // This runs for every seg of every leaf and rejects all but a handful, so the
  // corner that proves the cell straddles the line exits on the spot.
  const length = Math.sqrt(lengthSq);
  const keepSide = -PARTITION_MATCH * length;
  let max = -Infinity;
  for (let i = 0; i < cell.length; i += 2) {
    const d = dx * (cell[i + 1] - a.y) - dy * (cell[i] - a.x);
    if (d < keepSide) return false;
    if (d > max) max = d;
  }
  return max > SEG_CLIP_TOLERANCE * length;
}

/**
 * The cell clipped against every seg of the leaf that really bounds it, in seg order.
 * `spare` skips the segs `wallFacesAwayFromCell` flagged; run with it false, the result
 * is bit-identical to never having detected one — which is what the reality check on the
 * sparing falls back to. docs/render.md § Segs on the wrong side of their leaf.
 */
function clipBy(probe: () => SectorProbe, poly: number[], walls: Wall[], sector: number, spare: boolean): number[] {
  let cell = poly;
  for (const [i, wall] of walls.entries()) {
    if (spare && wall.wrongSide) continue;
    if (!wallBoundsCell(probe, cell, walls, i, sector)) continue;
    const { lineA, lineB } = wall;
    cell = clip(cell, lineA.x, lineA.y, lineB.x - lineA.x, lineB.y - lineA.y, segClipTolerance(cell, wall.a, wall.b));
    if (cell.length < 6) break;
  }
  return cell;
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
  const { a, b, lineA, lineB } = walls[index];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

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
  const spared = clip(cell, lineA.x, lineA.y, lineA.x - lineB.x, lineA.y - lineB.y);
  if (!probe().withinSector(sector, spared, SEG_CLIP_MAX_TOLERANCE)) return true;

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

/**
 * How far off a seg's line a seg of another linedef may sit and still count as lying
 * on it. Tuned by feel; a seg of the same linedef lies on it by definition.
 */
const COLLINEAR_EPS = 1;

/**
 * How far along this wall's line the leaf's walls on that line reach, in the
 * wall's own parameter — [0, 1] widened by every collinear neighbour. Only the
 * one caller above, and only once it knows the answer can matter.
 */
function lineCoverage(walls: Wall[], index: number): { min: number; max: number } {
  const { a, b, seg } = walls[index];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const length = Math.sqrt(lengthSq);
  const cover = { min: 0, max: 1 };
  for (const [i, other] of walls.entries()) {
    if (i === index) continue;
    if (other.seg.linedef !== seg.linedef) {
      const offA = Math.abs(dx * (other.a.y - a.y) - dy * (other.a.x - a.x)) / length;
      const offB = Math.abs(dx * (other.b.y - a.y) - dy * (other.b.x - a.x)) / length;
      if (offA > COLLINEAR_EPS || offB > COLLINEAR_EPS) continue;
    }
    const tA = ((other.a.x - a.x) * dx + (other.a.y - a.y) * dy) / lengthSq;
    const tB = ((other.b.x - a.x) * dx + (other.b.y - a.y) * dy) / lengthSq;
    cover.min = Math.min(cover.min, tA, tB);
    cover.max = Math.max(cover.max, tA, tB);
  }
  return cover;
}

/**
 * Slack for one seg's clip: how far past its own endpoints the seg's line has to be
 * extrapolated to reach `cell`, in multiples of the seg's own length, clamped between
 * the two tolerances above. That ratio is how far the line can have drifted by the
 * time it gets there — docs/render.md § Cracks between subsectors.
 *
 * **Only a seg the cell is already cut along gets any slack.** Where the cell has no
 * boundary on the seg's line, the seg is the only thing bounding it there and the
 * drift the slack pays for cannot have happened, so the clip is exact; any slack
 * there is floor standing past the wall, which this camera sees over.
 * docs/render.md § Cracks between subsectors.
 */
function segClipTolerance(cell: number[], a: Vertex, b: Vertex): number {
  if (!cellCutAlong(cell, a, b)) return 0;
  const lengthSq = (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y);
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
 * Whether `cell` is already cut along this seg's own line — an edge of it running
 * within `PARTITION_MATCH` of both the seg's endpoints, which is what a node
 * partition built from the seg's linedef leaves. Only then is the seg's line and
 * the cell's boundary the *same* boundary, disagreeing by rounding, which is the
 * case `segClipTolerance` hands slack to.
 */
function cellCutAlong(cell: number[], a: Vertex, b: Vertex): boolean {
  const n = cell.length / 2;
  for (let i = 0; i < n; i++) {
    const px = cell[i * 2];
    const py = cell[i * 2 + 1];
    const qx = cell[((i + 1) % n) * 2];
    const qy = cell[((i + 1) % n) * 2 + 1];
    const ex = qx - px;
    const ey = qy - py;
    const edgeLength = Math.sqrt(ex * ex + ey * ey);
    if (edgeLength === 0) continue;
    const offA = Math.abs(ex * (a.y - py) - ey * (a.x - px)) / edgeLength;
    if (offA > PARTITION_MATCH) continue;
    const offB = Math.abs(ex * (b.y - py) - ey * (b.x - px)) / edgeLength;
    if (offB <= PARTITION_MATCH) return true;
  }
  return false;
}

/**
 * How far the cell's corners are pulled toward its centroid before probing the
 * ground under them. Tuned by feel: inside enough that a corner exactly on a
 * partition or wall line cannot probe the far side of it, outside enough that
 * the samples still see most of the cell.
 */
const CELL_SAMPLE_SHRINK = 0.75;

/**
 * The sector enclosing the cell's interior, or -1 when any of the samples —
 * the centroid, then each corner pulled toward it — lands in the void. The
 * wrong-side sparing's reality check: a cell whose interior is not all floor
 * keeps its clips, however broken its segs, so it can never stand a slab of
 * floor out in the void. docs/render.md § Segs on the wrong side of their leaf.
 */
function enclosingSectorOfCell(probe: SectorProbe, cell: number[]): number {
  const centre = polygonCentroid(cell);
  const enclosing = probe.sectorIndexAt(centre.x, centre.y, true);
  if (enclosing < 0) return -1;
  for (let i = 0; i < cell.length; i += 2) {
    const x = centre.x + (cell[i] - centre.x) * CELL_SAMPLE_SHRINK;
    const y = centre.y + (cell[i + 1] - centre.y) * CELL_SAMPLE_SHRINK;
    if (probe.sectorIndexAt(x, y, true) < 0) return -1;
  }
  return enclosing;
}

/** Sector the seg's own side names, or -1 where its linedef or sidedef is missing. */
function sectorOfSeg(map: DoomMap, seg: Seg): number {
  const line = map.linedefs[seg.linedef];
  if (!line) return -1;
  const side = map.sidedefs[segSide(line, seg.direction)];
  return side ? side.sector : -1;
}

function rebuildLeafGraph(map: DoomMap): LeafGraph {
  const polys = buildSubSectorPolys(map);
  const starts = new Int32Array(polys.length + 1);
  const leaves: number[] = [];
  const found: number[] = [];
  for (let i = 0; i < polys.length; i++) {
    starts[i] = leaves.length;
    const points = polys[i].points;
    const n = points.length / 2;
    found.length = 0;
    for (let e = 0; e < n; e++) {
      const ax = points[e * 2];
      const ay = points[e * 2 + 1];
      const bx = points[((e + 1) % n) * 2];
      const by = points[((e + 1) % n) * 2 + 1];
      const ex = bx - ax;
      const ey = by - ay;
      const length = vecLength(ex, ey);
      if (length < 1e-6) continue;
      // The rings are counter-clockwise (`SectorPoly.points`), so (ey, -ex) points out of one.
      const step = NEIGHBOUR_PROBE / length;
      const other = subsectorAtPoint(map, (ax + bx) / 2 + ey * step, (ay + by) / 2 - ex * step);
      if (other < 0 || other === i || found.includes(other)) continue;
      found.push(other);
      leaves.push(other);
    }
  }
  starts[polys.length] = leaves.length;
  return { starts, leaves: Int32Array.from(leaves) };
}

function rebuildIslands(map: DoomMap): Int32Array {
  const polys = buildSubSectorPolys(map);
  const parent = new Int32Array(polys.length);
  for (let i = 0; i < polys.length; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Every two-sided seg joins what lies across it. Both sides are probed because a seg can sit
  // anywhere along its line, so the leaf it was filed under need not be either of them.
  for (let ss = 0; ss < map.subsectors.length; ss++) {
    const { first, count } = map.subsectors[ss];
    for (let k = first; k < first + count; k++) {
      const seg = map.segs[k];
      if (!seg || seg.linedef === NO_LINE) continue;
      const line = map.linedefs[seg.linedef];
      if (!line || line.left === NO_SIDE || line.right === NO_SIDE) continue;
      const a = map.vertexes[seg.v1];
      const b = map.vertexes[seg.v2];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = vecLength(dx, dy);
      if (length < 1e-6) continue;
      const step = NEIGHBOUR_PROBE / length;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      for (let side = -1; side <= 1; side += 2) {
        const other = subsectorAtPoint(map, mx - dy * step * side, my + dx * step * side);
        if (other >= 0 && other !== ss) {
          union(ss, other);
        }
      }
    }
  }

  // Which sector pairs a two-sided line joins anywhere on the map: what tells the pass below a
  // leaf boundary inside one room from the void between two of them.
  const sectorCount = map.sectors.length;
  const joined = new Set<number>();
  for (const line of map.linedefs) {
    if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
    const front = map.sidedefs[line.right]?.sector;
    const back = map.sidedefs[line.left]?.sector;
    if (front === undefined || back === undefined || front === back) continue;
    joined.add(front * sectorCount + back);
    joined.add(back * sectorCount + front);
  }

  // A BSP split inside one sector has no seg between its halves, so those joins come off the
  // geometric adjacency instead.
  const graph = buildLeafGraph(map);
  for (let i = 0; i < polys.length; i++) {
    const si = polys[i].physicalSector;
    for (let k = graph.starts[i]; k < graph.starts[i + 1]; k++) {
      const j = graph.leaves[k];
      const sj = polys[j].physicalSector;
      if (si === sj || joined.has(si * sectorCount + sj)) {
        union(i, j);
      }
    }
  }

  const result = new Int32Array(polys.length);
  const ids = new Map<number, number>();
  for (let i = 0; i < polys.length; i++) {
    const root = find(i);
    let id = ids.get(root);
    if (id === undefined) {
      id = ids.size;
      ids.set(root, id);
    }
    result[i] = id;
  }
  return result;
}
