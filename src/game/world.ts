import { LF, NO_SIDE, SUBSECTOR_BIT, type DoomMap, type Sector, type Thing } from '../wad/map.ts';
import { sectorOfSubSector } from '../render/bsp.ts';
import { distSqToSegment, segmentIntersect } from '../util/geom.ts';
import { PLAYER_HEIGHT } from './player.ts';
import type { Placement, Pos2, Pos3 } from '../types.ts';

/** Vanilla DOOM value, in map units. */
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
  /** Adjacency list for `noiseAlert`'s flood, precomputed once instead of rescanning every linedef per visited sector. */
  private sectorNeighbors: { neighbor: number; lineIndex: number }[][] = [];
  /** Sectors a noise has ever reached (`noiseAlert`) — never cleared, matching vanilla's own `soundtarget`, which persists for the rest of the level once set. */
  private soundAlertedSectors = new Set<Sector>();
  /**
   * Per-linedef "last query that already visited this line" stamps, so
   * `forEachLineAlongSegment` can dedupe a line that spans several of the
   * cells it walks without allocating a `Set` per call. `linesNear` allocates
   * one every time, which is fine at its call rate but not at a sightline
   * check's — see `hasLineOfSight`.
   */
  private lineStamp: Int32Array;
  private queryId = 0;

  readonly map: DoomMap;

  constructor(map: DoomMap) {
    this.map = map;
    const { minX, minY, maxX, maxY } = map.bounds;
    this.gridMinX = minX;
    this.gridMinY = minY;
    this.gridCols = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL) + 1);
    this.gridRows = Math.max(1, Math.ceil((maxY - minY) / GRID_CELL) + 1);
    this.lineStamp = new Int32Array(map.linedefs.length);
    this.buildGrid();
    this.buildSectorNeighbors();
  }

  /** Every sector's two-sided-line neighbors, for `noiseAlert`'s flood — built once rather than rescanning all linedefs per visited sector. */
  private buildSectorNeighbors(): void {
    this.sectorNeighbors = this.map.sectors.map(() => []);
    for (let li = 0; li < this.map.linedefs.length; li++) {
      const line = this.map.linedefs[li];
      if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
      const front = this.map.sidedefs[line.right]?.sector;
      const back = this.map.sidedefs[line.left]?.sector;
      if (front === undefined || back === undefined) continue;
      this.sectorNeighbors[front]?.push({ neighbor: back, lineIndex: li });
      this.sectorNeighbors[back]?.push({ neighbor: front, lineIndex: li });
    }
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

  /**
   * Every linedef bucketed into a grid cell the segment (x1, y1)-(x2, y2)
   * passes through, each visited at most once. The visitor may return `true`
   * to stop the walk early, the way a `break` would.
   *
   * This is the query a **sightline** wants; `linesNear`'s radius box is
   * O(dist²) in cells for a thin line and was the engine's biggest single cost
   * on a crowded map. Allocation-free by design (stamp array, callback), since
   * it runs thousands of times per frame. docs/combat.md § hasLineOfSight
   * covers why this is both sound and necessary.
   */
  forEachLineAlongSegment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    visit: (lineIndex: number) => boolean | void,
  ): void {
    const stamp = ++this.queryId;
    let cx = this.cellX(x1);
    let cy = this.cellY(y1);
    const ex = this.cellX(x2);
    const ey = this.cellY(y2);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const stepX = dx >= 0 ? 1 : -1;
    const stepY = dy >= 0 ? 1 : -1;
    // How far along the segment (in its own 0..1 parameter) one full cell of
    // travel costs on each axis, and how far to the first cell boundary.
    const tDeltaX = dx !== 0 ? Math.abs(GRID_CELL / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(GRID_CELL / dy) : Infinity;
    let tMaxX =
      dx !== 0 ? (this.gridMinX + (cx + (stepX > 0 ? 1 : 0)) * GRID_CELL - x1) / dx : Infinity;
    let tMaxY =
      dy !== 0 ? (this.gridMinY + (cy + (stepY > 0 ? 1 : 0)) * GRID_CELL - y1) / dy : Infinity;

    // Bounded rather than "until (cx,cy) reaches (ex,ey)": cellX/cellY clamp to
    // the grid, so a segment starting or ending outside the map can otherwise
    // never reach its end cell.
    const maxSteps = this.gridCols + this.gridRows + 2;
    for (let step = 0; ; step++) {
      const bucket = this.grid.get(cy * this.gridCols + cx);
      if (bucket) {
        for (const i of bucket) {
          if (this.lineStamp[i] === stamp) continue;
          this.lineStamp[i] = stamp;
          if (visit(i) === true) return;
        }
      }
      if ((cx === ex && cy === ey) || step >= maxSteps) return;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        tMaxY += tDeltaY;
        cy += stepY;
      }
    }
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
   * is currently straddling — vanilla's `thing->floorz` in `P_TryMove`, which
   * keeps a mover pinned to a ledge's high side while its circle still spans
   * that ledge's line. Point-sampling the floor instead deadlocks a fall off a
   * ledge; see docs/movement.md § Collision.
   */
  groundFloor(x: number, y: number, radius: number, forMonster = false): number {
    let floor = this.floorAt(x, y);
    const rSq = radius * radius;
    for (const i of this.linesNear(x, y, radius)) {
      if (this.isSolidWall(i, forMonster)) continue;
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

  /**
   * The lowest ceiling a body of this radius must clear, standing here — the
   * mirror of `groundFloor`: the local sector's ceiling, lowered to the top
   * of any two-sided opening its circle is currently straddling. Exists so a
   * rising floor's headroom check (`game.ts: blocksFloorRise`) can see a
   * lower-ceilinged neighbor sector the player's circle still overlaps, not
   * just the rising sector's own ceiling — see docs/movement.md § Collision.
   */
  groundCeiling(x: number, y: number, radius: number, forMonster = false): number {
    let ceiling = this.ceilingAt(x, y);
    const rSq = radius * radius;
    for (const i of this.linesNear(x, y, radius)) {
      if (this.isSolidWall(i, forMonster)) continue;
      const line = this.map.linedefs[i];
      const a = this.map.vertexes[line.v1];
      const b = this.map.vertexes[line.v2];
      if (!a || !b) continue;
      if (distSqToSegment(x, y, a.x, a.y, b.x, b.y) >= rSq) continue;
      if (!crossesLine(x, y, radius, a.x, a.y, b.x, b.y)) continue;
      const opening = this.openingOf(i);
      if (opening) ceiling = Math.min(ceiling, opening.top);
    }
    return ceiling;
  }

  /**
   * The lowest floor this circle's footprint touches — vanilla's `tmdropoffz`,
   * the mirror of `groundFloor`'s `tmfloorz`. `circleBlocked`'s dropoff check
   * compares the two.
   */
  dropoffFloor(x: number, y: number, radius: number): number {
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
      const front = this.map.sectors[this.map.sidedefs[line.right]?.sector];
      const back = this.map.sectors[this.map.sidedefs[line.left]?.sector];
      if (front && back) floor = Math.min(floor, front.floorHeight, back.floorHeight);
    }
    return floor;
  }

  /**
   * True if this line is a hard wall regardless of height — no opening to
   * test. `forMonster` additionally treats an `LF.BLOCK_MONSTERS` line as
   * solid — vanilla's own `ML_BLOCKMONSTERS`, a line that fences monsters
   * out of an area (or off a ledge) while leaving the player free to walk
   * through; the player's own movement never passes `forMonster: true`, so
   * this only ever narrows what a monster can cross, never the player.
   */
  isSolidWall(lineIndex: number, forMonster = false): boolean {
    const line = this.map.linedefs[lineIndex];
    if (!line) return true;
    if (line.flags & LF.BLOCKING) return true;
    if (forMonster && line.flags & LF.BLOCK_MONSTERS) return true;
    return line.left === NO_SIDE || line.right === NO_SIDE;
  }

  /**
   * True if this line stops a line of sight through it (game/fogofwar.ts).
   *
   * The test is the vertical opening, what vanilla's `P_CheckSight` keys off —
   * deliberately *not* `isSolidWall`, which is wrong in both directions here
   * (a closed door isn't `BLOCKING`; a window/railing is). docs/fogofwar.md
   * has both cases.
   */
  blocksSight(lineIndex: number): boolean {
    const line = this.map.linedefs[lineIndex];
    if (!line) return true;
    if (line.left === NO_SIDE || line.right === NO_SIDE) return true;
    const opening = this.openingOf(lineIndex);
    return !opening || opening.top <= opening.bottom;
  }

  /** True if a body standing at feet height `z` cannot cross this line. `forMonster` — see `isSolidWall`. */
  blocksMovement(lineIndex: number, z: number, forMonster = false): boolean {
    if (this.isSolidWall(lineIndex, forMonster)) return true;
    const opening = this.openingOf(lineIndex);
    if (!opening) return true;
    if (opening.top - opening.bottom < PLAYER_HEIGHT) return true;
    if (opening.bottom - z > MAX_STEP_UP) return true;
    return false;
  }

  thingsOfType(type: number): Thing[] {
    return this.map.things.filter((t) => t.type === type);
  }

  /**
   * Player 1 start (thing type 1); falls back to the map centre.
   *
   * The **last** doomednum-1 thing, not the first — every earlier one is a
   * voodoo doll, and spawning on top of one is a real bug. See docs/wad.md §
   * Player start.
   */
  playerStart(): Placement {
    const starts = this.thingsOfType(1);
    const t = starts[starts.length - 1];
    if (t) return { x: t.x, y: t.y, angle: (t.angle * Math.PI) / 180 };
    const { minX, minY, maxX, maxY } = this.map.bounds;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, angle: 0 };
  }

  /**
   * Floods a noise outward from the sector at (x, y) through every two-sided
   * line — vanilla's `P_NoiseAlert`/`P_RecursiveSound`. Marked sectors stay
   * marked for the rest of the level (`sector->soundtarget` is never cleared
   * either). See docs/monsters.md § Waking up for the propagation rules.
   *
   * The search state is a `(sector, hasCrossedABlockLine)` pair, not just a
   * sector, so one reached first via a sound-blocked path can still be
   * re-entered and propagate further via a later unblocked one — vanilla's
   * `soundtraversed <= soundblocks+1` guard.
   */
  noiseAlert(x: number, y: number): void {
    const start = this.sectorIndexAt(x, y);
    const visited = new Set<number>();
    const stack: number[] = [start * 2];
    while (stack.length > 0) {
      const state = stack.pop()!;
      if (visited.has(state)) continue;
      visited.add(state);
      const sectorIndex = state >> 1;
      const soundBlocked = state & 1;
      const sector = this.map.sectors[sectorIndex];
      if (!sector) continue;
      this.soundAlertedSectors.add(sector);

      for (const { neighbor, lineIndex } of this.sectorNeighbors[sectorIndex] ?? []) {
        const opening = this.openingOf(lineIndex);
        if (!opening || opening.top <= opening.bottom) continue; // closed door: stops sound outright
        if (this.map.linedefs[lineIndex]?.flags & LF.BLOCK_SOUND) {
          if (soundBlocked === 0) stack.push(neighbor * 2 + 1);
        } else {
          stack.push(neighbor * 2 + soundBlocked);
        }
      }
    }
  }

  /** True if a noise (`noiseAlert`) has ever reached this sector this level. */
  isSoundAlerted(sector: Sector): boolean {
    return this.soundAlertedSectors.has(sector);
  }
}

/**
 * A ray whose origin sits essentially *on* a wall (a rocket exploding against
 * one) would otherwise register a self-intersection with it at t≈0 and report
 * every direction blocked. Crossings closer than this to the ray's start are
 * skipped — the near-end counterpart to `WALL_OVERLAP`/`BLOCKER_OVERLAP`.
 */
const SELF_HIT_MARGIN = 1;

/** How far apart (map units) to sample sector floor/ceiling along a sightline. */
const SIGHT_HEIGHT_SAMPLE_STEP = 64;

/**
 * Cap on floor/ceiling samples per sightline, whatever its length — the step
 * stretches instead of the count growing. 32 keeps full precision within
 * `WEAPON_RANGE` (2048/64 = 32) so nothing that can end in a shot changes;
 * see docs/combat.md § hasLineOfSight.
 */
const SIGHT_MAX_HEIGHT_SAMPLES = 32;

/**
 * True if a straight 3D line between two points is crossed by no
 * sight-blocking line (`World.blocksSight`) **and** keeps an unbroken sight
 * wedge through the floor/ceiling of every sector along the way.
 *
 * The wedge starts from a *fixed eye height* (`3/4` of `PLAYER_HEIGHT`,
 * vanilla's `sightzstart` fraction) rather than interpolating toward `z2` —
 * vanilla's `P_CheckSight` (`sightzstart`/`topslope`/`bottomslope`). Both the
 * fixed origin and the floor/ceiling half are load-bearing, and this is the
 * engine's most performance-sensitive query: docs/combat.md § hasLineOfSight
 * covers why, and what keeps it affordable.
 *
 * The eye-height fraction is computed inline rather than as a module-level
 * const: `world.ts` and `player.ts` import from each other, and a top-level
 * const evaluated at module load (rather than deferred inside a function body,
 * as every other `PLAYER_HEIGHT` use in this file is) hits the cycle's
 * initialization order — "Cannot access 'PLAYER_HEIGHT' before initialization".
 */
export function hasLineOfSight(world: World, from: Pos3, to: Pos3): boolean {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist === 0) return true;

  const eyeZ = from.z + PLAYER_HEIGHT * 0.75;
  let topSlope = (to.z + PLAYER_HEIGHT - eyeZ) / dist;
  let bottomSlope = (to.z - eyeZ) / dist;

  // Walks only the cells the sightline crosses; `linesNear`'s radius query is
  // O(dist²) in cells here — see `World.forEachLineAlongSegment`. A fully
  // blocking line stops the trace outright; an open two-sided one narrows the
  // sight wedge at its real opening, matching `P_SightTraverse` — the reason
  // this exists alongside the periodic sampling below is docs/combat.md §
  // hasLineOfSight.
  let blocked = false;
  world.forEachLineAlongSegment(from.x, from.y, to.x, to.y, (i) => {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) return;
    if (world.blocksSight(i)) {
      const hit = segmentIntersect(from.x, from.y, to.x, to.y, a.x, a.y, b.x, b.y);
      if (hit && hit.t * dist > SELF_HIT_MARGIN) return (blocked = true);
      return;
    }
    // Two-sided and open. Skip the segment math entirely for a flat
    // pass-through (equal floors and equal ceilings on both sides) — it
    // can't narrow the wedge, and it's most of a level's connective tissue —
    // mirroring `P_SightTraverse`'s own frontsector/backsector inequality
    // guards.
    const front = world.map.sectors[world.map.sidedefs[line.right]?.sector ?? -1];
    const back = world.map.sectors[world.map.sidedefs[line.left]?.sector ?? -1];
    if (!front || !back) return;
    if (front.floorHeight === back.floorHeight && front.ceilHeight === back.ceilHeight) return;
    const hit = segmentIntersect(from.x, from.y, to.x, to.y, a.x, a.y, b.x, b.y);
    if (!hit || hit.t * dist <= SELF_HIT_MARGIN) return;
    const crossDist = hit.t * dist;
    const bottomOpen = Math.max(front.floorHeight, back.floorHeight);
    const topOpen = Math.min(front.ceilHeight, back.ceilHeight);
    const crossBottomSlope = (bottomOpen - eyeZ) / crossDist;
    const crossTopSlope = (topOpen - eyeZ) / crossDist;
    if (crossBottomSlope > bottomSlope) bottomSlope = crossBottomSlope;
    if (crossTopSlope < topSlope) topSlope = crossTopSlope;
    if (topSlope <= bottomSlope) return (blocked = true);
  });
  if (blocked) return false;

  const steps = Math.min(
    SIGHT_MAX_HEIGHT_SAMPLES,
    Math.max(1, Math.ceil(dist / SIGHT_HEIGHT_SAMPLE_STEP)),
  );
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sector = world.sectorAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (!sector) continue;
    const sampleDist = dist * t;
    const floorSlope = (sector.floorHeight - eyeZ) / sampleDist;
    const ceilSlope = (sector.ceilHeight - eyeZ) / sampleDist;
    if (floorSlope > bottomSlope) bottomSlope = floorSlope;
    if (ceilSlope < topSlope) topSlope = ceilSlope;
    if (topSlope <= bottomSlope) return false;
  }
  return true;
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
 * Neighbor-height queries a specials mover needs to resolve a target height —
 * vanilla's `P_FindLowestFloorSurrounding` family. The `found` flag (rather
 * than seeding with the sector's own height) is load-bearing; see
 * docs/specials.md § Neighbor-height queries.
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
 * segment a-b, rather than sitting entirely on one side of it — DOOM's
 * `P_BoxOnLineSide`. A two-sided opening only gates movement while the mover
 * actually straddles the line; without this the player gets trapped at a ledge
 * edge (docs/movement.md § Collision).
 */
function crossesLine(x: number, y: number, radius: number, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return true;
  const cross = dx * (y - ay) - dy * (x - ax);
  return Math.abs(cross) / len < radius;
}

/**
 * A body (monster or player) that other bodies physically bump into —
 * vanilla's `MF_SOLID` things, tested by `PIT_CheckThing`. Callers pass the
 * set of *other* bodies; nothing here filters out the mover itself.
 *
 * **No height field, deliberately** — `PIT_CheckThing` returns before any z
 * comparison, so a DOOM actor blocks over its entire vertical extent
 * ("infinitely tall actors"). Adding a height check is a deviation, not a fix.
 */
export interface ThingBlocker extends Pos2 {
  radius: number;
}

/**
 * True if a body of `radius` standing at (x, y) overlaps one of `blockers` —
 * vanilla's `PIT_CheckThing` overlap test, an axis-aligned **box** check on
 * the summed radii, not the circle test the rest of this file uses. Boxy on
 * purpose (docs/monsters.md § Movement).
 *
 * `from`, when given, is where the mover currently stands. A blocker already
 * overlapped there only refuses the move if it presses further in (`newDist <
 * oldDist` to that blocker's centre) — otherwise two bodies that ended up
 * touching (map placement, or a knockback that skips this same check — see
 * `ThingLayer.applyKnockback`) can still work their way apart one frame at a
 * time instead of freezing both forever: every frame's step is a few units
 * against a reach of tens, so requiring the *destination* to already be fully
 * clear is unreachable in one step. A blocker not yet touched at `from` is
 * unaffected — you still can't walk into a thing you weren't already
 * overlapping.
 */
function blockedByThings(x: number, y: number, radius: number, blockers: readonly ThingBlocker[] | undefined, from?: Pos2): boolean {
  if (!blockers) return false;
  for (const b of blockers) {
    const reach = radius + b.radius;
    if (Math.abs(b.x - x) >= reach || Math.abs(b.y - y) >= reach) continue;
    if (from && Math.abs(b.x - from.x) < reach && Math.abs(b.y - from.y) < reach) {
      if (Math.hypot(b.x - x, b.y - y) >= Math.hypot(b.x - from.x, b.y - from.y)) continue;
    }
    return true;
  }
  return false;
}

/**
 * True if a circle at (x, y) overlaps any line that blocks it. `forMonster` —
 * see `World.isSolidWall`. `blockers` are the other solid bodies in the way
 * (see `ThingBlocker`); omitting them means only geometry blocks.
 *
 * `avoidDropoff` also rejects a position standing over a dropoff
 * (`groundFloor` more than `MAX_STEP_UP` above `dropoffFloor`) — vanilla's
 * `P_TryMove`. Exempting a thing from it is the caller's job here rather than
 * an `MF_DROPOFF`/`MF_FLOAT` check; the player never passes it, since falling
 * off a ledge is deliberate (docs/movement.md § Vertical physics).
 *
 * `from` — see `blockedByThings`: the mover's current position, so a body
 * already touching one of `blockers` can still move away from it.
 */
export function circleBlocked(
  world: World,
  x: number,
  y: number,
  radius: number,
  z: number,
  forMonster = false,
  avoidDropoff = false,
  blockers?: readonly ThingBlocker[],
  from?: Pos2,
): boolean {
  if (blockedByThings(x, y, radius, blockers, from)) return true;
  if (avoidDropoff && world.groundFloor(x, y, radius, forMonster) - world.dropoffFloor(x, y, radius) > MAX_STEP_UP) return true;
  const rSq = radius * radius;
  for (const i of world.linesNear(x, y, radius + 1)) {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) continue;
    if (distSqToSegment(x, y, a.x, a.y, b.x, b.y) >= rSq) continue;
    if (world.isSolidWall(i, forMonster)) return true;
    if (!crossesLine(x, y, radius, a.x, a.y, b.x, b.y)) continue;
    if (world.blocksMovement(i, z, forMonster)) return true;
  }
  return false;
}

/**
 * `blockingLineAt`'s answer when something other than a linedef stopped the
 * circle — a solid body, or a dropoff. No wall direction to slide along, so
 * `slideMove` falls back to its per-axis attempt, which is the right slide for
 * a body anyway: `PIT_CheckThing`'s blocker is an axis-aligned box.
 */
export const SOLID_BODY = -1;

/**
 * Which line blocks a circle at (x, y), or `null` if nothing does —
 * `circleBlocked`'s answer plus the identity of the blocker, which is what
 * `slideMove` needs to project a move onto the wall it ran into.
 *
 * Separate from `circleBlocked` on purpose (that one is hot and returns on the
 * first blocker; this one weighs all of them and the nearest wins). See
 * docs/movement.md § slideMove.
 *
 * `from` — see `blockedByThings`.
 */
export function blockingLineAt(
  world: World,
  x: number,
  y: number,
  radius: number,
  z: number,
  forMonster = false,
  avoidDropoff = false,
  blockers?: readonly ThingBlocker[],
  from?: Pos2,
): number | null {
  if (blockedByThings(x, y, radius, blockers, from)) return SOLID_BODY;
  if (avoidDropoff && world.groundFloor(x, y, radius, forMonster) - world.dropoffFloor(x, y, radius) > MAX_STEP_UP) return SOLID_BODY;
  const rSq = radius * radius;
  let best: number | null = null;
  let bestDistSq = Infinity;
  for (const i of world.linesNear(x, y, radius + 1)) {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) continue;
    const dSq = distSqToSegment(x, y, a.x, a.y, b.x, b.y);
    if (dSq >= rSq || dSq >= bestDistSq) continue;
    if (!world.isSolidWall(i, forMonster)) {
      if (!crossesLine(x, y, radius, a.x, a.y, b.x, b.y)) continue;
      if (!world.blocksMovement(i, z, forMonster)) continue;
    }
    best = i;
    bestDistSq = dSq;
  }
  return best;
}

/** How many walls one `slideMove` will project against before giving up — vanilla's own `P_SlideMove` retry count. */
const SLIDE_ATTEMPTS = 3;

/** Below this (map units) a projected slide has nothing left to give; treat the wall as head-on. */
const SLIDE_EPSILON = 1e-6;

/**
 * Moves a circle by (dx, dy) and slides along whatever it hits, returning the
 * position actually reached. `forMonster`/`avoidDropoff` — see
 * `circleBlocked`; the player's own movement never passes either, and nothing
 * else calls this at all (vanilla's `P_SlideMove` is the player's alone —
 * monsters get `P_Move`'s all-or-nothing step, see `game/monsters.ts`).
 *
 * This is vanilla's `P_HitSlideLine`: the refused move is **projected onto the
 * blocking line's own direction** and retried, up to `SLIDE_ATTEMPTS` walls in
 * turn. See docs/movement.md § slideMove for why the projection (and not the
 * per-axis split it replaced) is the only thing that works on a diagonal wall,
 * and why projecting from the current position rather than vanilla's contact
 * point is safe here.
 */
export function slideMove(
  world: World,
  from: Pos3,
  dx: number,
  dy: number,
  radius: number,
  forMonster = false,
  avoidDropoff = false,
  blockers?: readonly ThingBlocker[],
): Pos2 {
  const { x, y, z } = from;
  let mx = dx;
  let my = dy;
  let lastHit = null as number | null;
  for (let attempt = 0; attempt < SLIDE_ATTEMPTS; attempt++) {
    if (mx === 0 && my === 0) break;
    const hit = blockingLineAt(world, x + mx, y + my, radius, z, forMonster, avoidDropoff, blockers, from);
    if (hit === null) return { x: x + mx, y: y + my };
    // A body/dropoff has no wall direction, and hitting the same wall twice
    // means the projection made no progress (the circle already overlaps it) —
    // either way the per-axis fallback below is the only thing left to try.
    if (hit === SOLID_BODY || hit === lastHit) break;
    lastHit = hit;
    const line = world.map.linedefs[hit];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    const ldx = b.x - a.x;
    const ldy = b.y - a.y;
    const len = Math.hypot(ldx, ldy);
    if (len === 0) break;
    const along = (mx * ldx + my * ldy) / len;
    mx = (ldx / len) * along;
    my = (ldy / len) * along;
    if (Math.abs(mx) < SLIDE_EPSILON && Math.abs(my) < SLIDE_EPSILON) break;
  }

  // Fallback for the cases the projection can't resolve: a solid body, or a
  // circle already overlapping the wall it's trying to slide along.
  let nx = x;
  let ny = y;
  if (dx !== 0 && !circleBlocked(world, x + dx, y, radius, z, forMonster, avoidDropoff, blockers, from)) nx = x + dx;
  if (dy !== 0 && !circleBlocked(world, nx, y + dy, radius, z, forMonster, avoidDropoff, blockers, from)) ny = y + dy;
  if (ny === y && dy !== 0 && nx !== x && !circleBlocked(world, nx, y + dy, radius, z, forMonster, avoidDropoff, blockers, from)) ny = y + dy;
  return { x: nx, y: ny };
}

/** Vanilla's `MISSILERANGE` (`32*64`), what every hitscan attack passes to `P_LineAttack`. */
export const WEAPON_RANGE = 2048;

/**
 * Each candidate wall is extended this far past both endpoints before the ray
 * is tested against it — same fix and distance as FogOfWar's `BLOCKER_OVERLAP`.
 * Two walls meeting at a shared vertex otherwise let a ray aimed right at that
 * point pass outside the end of both and hit neither.
 */
const WALL_OVERLAP = 0.25;

/**
 * True if this line stops a shot passing through it at height `z` — wherever
 * *this* shot's (possibly sloped) line is when it crosses, not one height for
 * the whole flight. The **single-ray** form, for a shot whose slope is already
 * fixed; a locked-on shot gets `shotPath`'s wedge instead.
 *
 * Deliberately **not** `isSolidWall` — `PTR_ShootTraverse` never reads
 * `ML_BLOCKING`, so a shot passes through bars it can't walk through. See
 * docs/combat.md § shotPath.
 */
function blocksShot(world: World, lineIndex: number, z: number): boolean {
  const line = world.map.linedefs[lineIndex];
  if (!line || line.left === NO_SIDE || line.right === NO_SIDE) return true;
  const opening = world.openingOf(lineIndex);
  if (!opening || opening.top <= opening.bottom) return true;
  return z < opening.bottom || z > opening.top;
}

/**
 * Half the vertical extent a locked-on shot may aim within around its target
 * point, for `shotPath`'s wedge — `game.ts` passes a target `z` of roughly
 * mid-body, so a symmetric half-body band approximates the silhouette. Same
 * "any part counts" idea as `hasLineOfSight`'s `[z2, z2 + PLAYER_HEIGHT]`.
 *
 * A function rather than a module-level const for the `PLAYER_HEIGHT`
 * import-cycle reason documented on `hasLineOfSight`.
 */
function shotTargetHalfHeight(): number {
  return PLAYER_HEIGHT / 2;
}

/**
 * Where one frame of a *curving* projectile's flight ran into geometry, or
 * null if the step is clear — the per-step counterpart to `shotPath`'s single
 * launch-time trace, for the one projectile whose path isn't straight and so
 * can't have its stopping point resolved up front: the revenant's homing
 * missile (`game/projectiles.ts: advanceHoming`, docs/monsters.md § The
 * revenant's homing missile).
 *
 * Blocking is `blocksShot` at the height the step is at where it crosses each
 * line. A crossing within `SELF_HIT_MARGIN` of the step's start is skipped for
 * the reason `hasLineOfSight` skips one: a missile that just passed through an
 * opening starts the next step sitting essentially on it.
 */
export function projectileStepBlocker(
  world: World,
  from: Pos3,
  to: Pos3,
): { x: number; y: number; z: number; lineIndex: number } | null {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist === 0) return null;
  let nearestT = Infinity;
  let hitLine = -1;
  world.forEachLineAlongSegment(from.x, from.y, to.x, to.y, (i) => {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) return;
    // WALL_OVERLAP-extended for the shared-vertex corner-leak reason
    // documented on `shotPath`'s own crossing test.
    const ldx = b.x - a.x;
    const ldy = b.y - a.y;
    const len = Math.hypot(ldx, ldy);
    const ex = len > 0 ? (ldx / len) * WALL_OVERLAP : 0;
    const ey = len > 0 ? (ldy / len) * WALL_OVERLAP : 0;
    const hit = segmentIntersect(from.x, from.y, to.x, to.y, a.x - ex, a.y - ey, b.x + ex, b.y + ey);
    if (!hit || hit.t >= nearestT || hit.t * dist <= SELF_HIT_MARGIN) return;
    if (!blocksShot(world, i, from.z + (to.z - from.z) * hit.t)) return;
    nearestT = hit.t;
    hitLine = i;
  });
  if (hitLine < 0) return null;
  return {
    x: from.x + (to.x - from.x) * nearestT,
    y: from.y + (to.y - from.y) * nearestT,
    z: from.z + (to.z - from.z) * nearestT,
    lineIndex: hitLine,
  };
}

/** Where a shot actually ends up: the point it stopped at, the height it was at there, and how far that was. */
export interface ShotPath extends Pos3 {
  dist: number;
  /** The line that actually stopped it short (a wall, a shut door), or null if it reached `target`/`WEAPON_RANGE` unobstructed — the shoot-triggered specials (`game/specials.ts: triggerShot`) key off this. */
  lineIndex: number | null;
}

/**
 * Traces a shot fired from `origin` along `angleRad` and returns where it ends
 * up, stopped at the nearest line that blocks it. Used both for a hitscan
 * weapon's tracer endpoint and for how far a projectile may fly
 * (game/weapons.ts, game.ts).
 *
 * With no `target` this is a free shot: flat at `origin.z`, out to
 * `WEAPON_RANGE`. With one, it slopes from `origin.z` to the target's height
 * over exactly the distance to it and stops *at* the target — the origin stays
 * the shooter's own height so a rendered tracer never starts mid-air.
 *
 * `lockedOn` (default: true whenever `target` is given) switches blocking from
 * `blocksShot`'s single fixed ray to a **slope wedge**, vanilla's
 * `P_AimLineAttack` — the auto-aim leniency, and neither of the two things it
 * has been in the past. A monster's own fired shot passes `lockedOn: false`:
 * it needs `target` to aim, but has no "you clicked it" promise to honor. See
 * docs/combat.md § shotPath.
 */
export function shotPath(
  world: World,
  origin: Pos3,
  angleRad: number,
  target: Pos3 | null = null,
  lockedOn: boolean = target !== null,
): ShotPath {
  const { x, y, z } = origin;
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  const maxRange = target ? Math.hypot(target.x - x, target.y - y) : WEAPON_RANGE;
  const endZ = target ? target.z : z;
  const tx = x + dx * maxRange;
  const ty = y + dy * maxRange;
  let nearestT = 1;
  let blockingLine: number | null = null;

  /** This line's crossing point along the shot, or null — `WALL_OVERLAP`-extended for the corner-leak reason documented on `hasLineOfSight`'s own blocker set. */
  const crossingT = (i: number): number | null => {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) return null;
    const ldx = b.x - a.x;
    const ldy = b.y - a.y;
    const len = Math.hypot(ldx, ldy);
    const ex = len > 0 ? (ldx / len) * WALL_OVERLAP : 0;
    const ey = len > 0 ? (ldy / len) * WALL_OVERLAP : 0;
    const hit = segmentIntersect(x, y, tx, ty, a.x - ex, a.y - ey, b.x + ex, b.y + ey);
    return hit ? hit.t : null;
  };

  if (!lockedOn) {
    for (const i of world.linesNear(x, y, maxRange)) {
      const t = crossingT(i);
      if (t === null || t >= nearestT) continue;
      if (blocksShot(world, i, z + (endZ - z) * t)) {
        nearestT = t;
        blockingLine = i;
      }
    }
  } else {
    // Vanilla's P_AimLineAttack wedge — see this function's doc. Crossings have
    // to be walked nearest-first for the narrowing to mean anything, so unlike
    // the single-ray branch above (which can early-out on `nearestT` in any
    // order) this one collects and sorts first.
    const crossings: { t: number; i: number }[] = [];
    for (const i of world.linesNear(x, y, maxRange)) {
      const t = crossingT(i);
      if (t !== null) crossings.push({ t, i });
    }
    crossings.sort((p, q) => p.t - q.t);

    const half = shotTargetHalfHeight();
    let bottomSlope = (endZ - half - z) / maxRange;
    let topSlope = (endZ + half - z) / maxRange;
    for (const { t, i } of crossings) {
      const line = world.map.linedefs[i];
      // A genuinely solid wall or a shut door stops any shot outright, the
      // same two cases `blocksShot` leads with.
      if (line.left === NO_SIDE || line.right === NO_SIDE) {
        nearestT = t;
        blockingLine = i;
        break;
      }
      const opening = world.openingOf(i);
      if (!opening || opening.top <= opening.bottom) {
        nearestT = t;
        blockingLine = i;
        break;
      }
      const d = maxRange * t;
      if (d <= 0) continue; // a line the shot starts on contributes no constraint
      const bottom = (opening.bottom - z) / d;
      const topOfGap = (opening.top - z) / d;
      if (bottom > bottomSlope) bottomSlope = bottom;
      if (topOfGap < topSlope) topSlope = topOfGap;
      if (topSlope <= bottomSlope) {
        nearestT = t;
        blockingLine = i;
        break;
      }
    }
  }

  const dist = maxRange * nearestT;
  return { x: x + dx * dist, y: y + dy * dist, z: z + (endZ - z) * nearestT, dist, lineIndex: blockingLine };
}
