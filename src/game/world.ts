import { LF, NO_SIDE, SUBSECTOR_BIT, type DoomMap, type Sector, type Thing } from '../wad/map.ts';
import { sectorOfSubSector } from '../render/bsp.ts';
import { distSqToSegment } from '../util/geom.ts';

/** Vanilla DOOM values, in map units. */
export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;
export const MAX_STEP_UP = 24;

const GRID_CELL = 128;

export interface Opening {
  top: number;
  bottom: number;
}

/**
 * The map plus the queries the game logic needs: where am I, how high is the
 * floor here, and which lines are close enough to bump into.
 */
export class World {
  private grid = new Map<number, number[]>();
  private gridMinX: number;
  private gridMinY: number;
  private gridCols: number;
  private gridRows: number;

  readonly map: DoomMap;

  constructor(map: DoomMap) {
    this.map = map;
    const { minX, minY, maxX, maxY } = map.bounds;
    this.gridMinX = minX;
    this.gridMinY = minY;
    this.gridCols = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL) + 1);
    this.gridRows = Math.max(1, Math.ceil((maxY - minY) / GRID_CELL) + 1);
    this.buildGrid();
  }

  /** Buckets every linedef into the cells its bounding box touches. */
  private buildGrid(): void {
    for (let i = 0; i < this.map.linedefs.length; i++) {
      const line = this.map.linedefs[i];
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;

      const c0 = this.cellX(Math.min(a.x, b.x));
      const c1 = this.cellX(Math.max(a.x, b.x));
      const r0 = this.cellY(Math.min(a.y, b.y));
      const r1 = this.cellY(Math.max(a.y, b.y));

      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const key = cy * this.gridCols + cx;
          let bucket = this.grid.get(key);
          if (!bucket) this.grid.set(key, (bucket = []));
          bucket.push(i);
        }
      }
    }
  }

  private cellX(x: number): number {
    return Math.max(0, Math.min(this.gridCols - 1, Math.floor((x - this.gridMinX) / GRID_CELL)));
  }

  private cellY(y: number): number {
    return Math.max(0, Math.min(this.gridRows - 1, Math.floor((y - this.gridMinY) / GRID_CELL)));
  }

  /** Linedef indices whose cell overlaps the box around (x, y) with the given radius. */
  linesNear(x: number, y: number, radius: number): number[] {
    const seen = new Set<number>();
    const c0 = this.cellX(x - radius);
    const c1 = this.cellX(x + radius);
    const r0 = this.cellY(y - radius);
    const r1 = this.cellY(y + radius);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const bucket = this.grid.get(cy * this.gridCols + cx);
        if (bucket) for (const i of bucket) seen.add(i);
      }
    }
    return [...seen];
  }

  /** Walks the BSP tree down to the subsector containing the point. */
  subsectorAt(x: number, y: number): number {
    const nodes = this.map.nodes;
    if (nodes.length === 0) return 0;
    let child = nodes.length - 1;
    while ((child & SUBSECTOR_BIT) === 0) {
      const node = nodes[child];
      if (!node) return 0;
      // Same side test as the renderer: cross < 0 means the front (right) side.
      const cross = node.dx * (y - node.y) - node.dy * (x - node.x);
      child = cross < 0 ? node.rightChild : node.leftChild;
    }
    return child & ~SUBSECTOR_BIT;
  }

  sectorIndexAt(x: number, y: number): number {
    return sectorOfSubSector(this.map, this.subsectorAt(x, y));
  }

  sectorAt(x: number, y: number): Sector | undefined {
    return this.map.sectors[this.sectorIndexAt(x, y)];
  }

  floorAt(x: number, y: number): number {
    return this.sectorAt(x, y)?.floorHeight ?? 0;
  }

  ceilingAt(x: number, y: number): number {
    return this.sectorAt(x, y)?.ceilHeight ?? 0;
  }

  /** Gap a two-sided line leaves free, or null if the line is impassable. */
  openingOf(lineIndex: number): Opening | null {
    const line = this.map.linedefs[lineIndex];
    if (!line) return null;
    if (line.left === NO_SIDE || line.right === NO_SIDE) return null;
    const front = this.map.sectors[this.map.sidedefs[line.right]?.sector];
    const back = this.map.sectors[this.map.sidedefs[line.left]?.sector];
    if (!front || !back) return null;
    return {
      top: Math.min(front.ceilHeight, back.ceilHeight),
      bottom: Math.max(front.floorHeight, back.floorHeight),
    };
  }

  /**
   * The height a body of this radius should rest at, standing here: the local
   * sector's floor, raised to the bottom of any two-sided opening its circle
   * is currently straddling. DOOM keeps a mover pinned to a ledge's high side
   * for as long as its collision circle still spans that ledge's line (see
   * `thing->floorz` in P_TryMove) — only once fully clear of it does the
   * floor, and so z, drop to the low side. Using the bare point-sampled floor
   * instead would make falling off a ledge deadlock: the very next frame's
   * step-up test would compare the now-low z against the still-high opening
   * bottom and block every further move near that edge, forever.
   */
  groundFloor(x: number, y: number, radius: number): number {
    let floor = this.floorAt(x, y);
    const rSq = radius * radius;
    for (const i of this.linesNear(x, y, radius)) {
      if (this.isSolidWall(i)) continue;
      const line = this.map.linedefs[i];
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      if (distSqToSegment(x, y, a.x, a.y, b.x, b.y) >= rSq) continue;
      if (!crossesLine(x, y, radius, a.x, a.y, b.x, b.y)) continue;
      const opening = this.openingOf(i);
      if (opening) floor = Math.max(floor, opening.bottom);
    }
    return floor;
  }

  /** True if this line is a hard wall regardless of height — no opening to test. */
  isSolidWall(lineIndex: number): boolean {
    const line = this.map.linedefs[lineIndex];
    if (!line) return true;
    if (line.flags & LF.BLOCKING) return true;
    return line.left === NO_SIDE || line.right === NO_SIDE;
  }

  /**
   * True if this line stops a line of sight through it (game/fogofwar.ts).
   *
   * Deliberately *not* `isSolidWall`, in both directions:
   * - A **closed door** is a two-sided line whose sectors leave no vertical gap
   *   (the door sector's ceiling is winched down to its floor). Vanilla never
   *   flags those `BLOCKING` — it can't, they have to become passable when the
   *   door opens — so `isSolidWall` says "not solid" and sight sails straight
   *   through into the room beyond. Every one of DOOM2 MAP01's 24 openingless
   *   two-sided lines is unflagged, which is exactly why the room behind the
   *   locked door showed up from the corridor.
   * - Conversely a **window or railing** is two-sided *and* `BLOCKING`: it stops
   *   a body but not an eye. Treating it as sight-blocking would black out a
   *   courtyard the player is plainly looking into over a fence.
   *
   * So the test is the vertical opening, matching what vanilla's own
   * `P_CheckSight` keys off, rather than the movement-blocking rules.
   */
  blocksSight(lineIndex: number): boolean {
    const line = this.map.linedefs[lineIndex];
    if (!line) return true;
    if (line.left === NO_SIDE || line.right === NO_SIDE) return true;
    const opening = this.openingOf(lineIndex);
    return !opening || opening.top <= opening.bottom;
  }

  /** True if a body standing at feet height `z` cannot cross this line. */
  blocksMovement(lineIndex: number, z: number): boolean {
    if (this.isSolidWall(lineIndex)) return true;
    const opening = this.openingOf(lineIndex);
    if (!opening) return true;
    if (opening.top - opening.bottom < PLAYER_HEIGHT) return true;
    if (opening.bottom - z > MAX_STEP_UP) return true;
    return false;
  }

  thingsOfType(type: number): Thing[] {
    return this.map.things.filter((t) => t.type === type);
  }

  /** Player 1 start (thing type 1); falls back to the map centre. */
  playerStart(): { x: number; y: number; angle: number } {
    const t = this.thingsOfType(1)[0];
    if (t) return { x: t.x, y: t.y, angle: (t.angle * Math.PI) / 180 };
    const { minX, minY, maxX, maxY } = this.map.bounds;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, angle: 0 };
  }
}

/** Sectors on the other side of a two-sided line from `sectorIndex`. */
function neighborSectors(map: DoomMap, sectorIndex: number): Sector[] {
  const out: Sector[] = [];
  for (const line of map.linedefs) {
    if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
    const frontSec = map.sidedefs[line.right]?.sector;
    const backSec = map.sidedefs[line.left]?.sector;
    let neighborIndex: number | undefined;
    if (frontSec === sectorIndex) neighborIndex = backSec;
    else if (backSec === sectorIndex) neighborIndex = frontSec;
    if (neighborIndex === undefined) continue;
    const sec = map.sectors[neighborIndex];
    if (sec) out.push(sec);
  }
  return out;
}

/**
 * Neighbor-height queries a specials mover needs to resolve a target height
 * (`P_FindLowestFloorSurrounding` and friends in vanilla). Each falls back to
 * the sector's own current height only when it has no two-sided neighbors at
 * all — never leaves a mover with nowhere to go. That fallback must not
 * apply just because the sector's own height happens to already be the most
 * extreme value: a closed door's sector has floor == ceiling, so seeding a
 * *lowest* reduction with its own (already-lowest-possible) ceiling would
 * make every real neighbor lose to it, pinning the door's "open" target at
 * its own closed height instead of the corridor's actual ceiling.
 */
export function lowestNeighborFloor(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.floorHeight ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.floorHeight < result) result = n.floorHeight;
    found = true;
  }
  return result;
}

export function highestNeighborFloor(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.floorHeight ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.floorHeight > result) result = n.floorHeight;
    found = true;
  }
  return result;
}

export function nextHigherFloor(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  const base = sector?.floorHeight ?? 0;
  let result = base;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (n.floorHeight > base && (!found || n.floorHeight < result)) {
      result = n.floorHeight;
      found = true;
    }
  }
  return result;
}

export function nextLowerFloor(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  const base = sector?.floorHeight ?? 0;
  let result = base;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (n.floorHeight < base && (!found || n.floorHeight > result)) {
      result = n.floorHeight;
      found = true;
    }
  }
  return result;
}

export function lowestNeighborCeiling(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.ceilHeight ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.ceilHeight < result) result = n.ceilHeight;
    found = true;
  }
  return result;
}

export function highestNeighborCeiling(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.ceilHeight ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.ceilHeight > result) result = n.ceilHeight;
    found = true;
  }
  return result;
}

/** Darkest neighboring sector's light level — the "minlight" a blink/glow special dims to. */
export function darkestNeighborLight(map: DoomMap, sectorIndex: number): number {
  const sector = map.sectors[sectorIndex];
  let result = sector?.light ?? 0;
  let found = false;
  for (const n of neighborSectors(map, sectorIndex)) {
    if (!found || n.light < result) result = n.light;
    found = true;
  }
  return result;
}

/**
 * True if a circle centred at (x, y) reaches across the infinite extension of
 * segment a-b, rather than sitting entirely on one side of it. A two-sided
 * opening (step height, headroom) should only gate movement while the mover
 * is actually straddling the line — exactly what DOOM's own P_BoxOnLineSide
 * check achieves for the player's bounding box. Without this, merely being
 * within radius of a ledge's linedef after already having fallen down it
 * would re-trigger the step-height test forever, using the far (higher)
 * side's floor, and permanently trap the player at the edge.
 */
function crossesLine(x: number, y: number, radius: number, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return true;
  const cross = dx * (y - ay) - dy * (x - ax);
  return Math.abs(cross) / len < radius;
}

/** True if a circle at (x, y) overlaps any line that blocks it. */
export function circleBlocked(world: World, x: number, y: number, radius: number, z: number): boolean {
  const rSq = radius * radius;
  for (const i of world.linesNear(x, y, radius + 1)) {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) continue;
    if (distSqToSegment(x, y, a.x, a.y, b.x, b.y) >= rSq) continue;
    if (world.isSolidWall(i)) return true;
    if (!crossesLine(x, y, radius, a.x, a.y, b.x, b.y)) continue;
    if (world.blocksMovement(i, z)) return true;
  }
  return false;
}

/**
 * Moves a circle by (dx, dy) and slides along whatever it hits, by trying the
 * two axes separately. Returns the position actually reached.
 */
export function slideMove(
  world: World,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  z: number,
): { x: number; y: number } {
  let nx = x;
  let ny = y;
  if (dx !== 0 && !circleBlocked(world, x + dx, y, radius, z)) nx = x + dx;
  if (dy !== 0 && !circleBlocked(world, nx, y + dy, radius, z)) ny = y + dy;
  // If sliding on one axis failed while the other moved, retry the blocked axis
  // from the new position — that lets the player round convex corners smoothly.
  if (ny === y && dy !== 0 && nx !== x && !circleBlocked(world, nx, y + dy, radius, z)) ny = y + dy;
  return { x: nx, y: ny };
}
