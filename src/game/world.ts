import { LF, NO_SIDE, SUBSECTOR_BIT, type DoomMap, type Sector, type Thing } from '../wad/map.ts';
import { sectorOfSubSector } from '../render/bsp.ts';
import { distSqToSegment, segmentIntersect } from '../util/geom.ts';
import { PLAYER_HEIGHT } from './player.ts';

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

  readonly map: DoomMap;

  constructor(map: DoomMap) {
    this.map = map;
    const { minX, minY, maxX, maxY } = map.bounds;
    this.gridMinX = minX;
    this.gridMinY = minY;
    this.gridCols = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL) + 1);
    this.gridRows = Math.max(1, Math.ceil((maxY - minY) / GRID_CELL) + 1);
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
   * The lowest floor this circle's footprint touches — vanilla's own
   * `tmdropoffz`, the mirror image of `groundFloor`'s `tmfloorz` (highest
   * touched floor instead of lowest). `circleBlocked`'s dropoff check
   * compares the two: a mover that would rest somewhere `groundFloor` puts it
   * well above this — i.e. it's still straddling a ledge whose far side drops
   * away sharply — is standing over a dropoff, matching vanilla's own
   * `P_TryMove` rule.
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

  /** Player 1 start (thing type 1); falls back to the map centre. */
  playerStart(): { x: number; y: number; angle: number } {
    const t = this.thingsOfType(1)[0];
    if (t) return { x: t.x, y: t.y, angle: (t.angle * Math.PI) / 180 };
    const { minX, minY, maxX, maxY } = this.map.bounds;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, angle: 0 };
  }

  /**
   * Floods a noise outward from the sector at (x, y) through every two-sided
   * line, matching vanilla's `P_NoiseAlert`/`P_RecursiveSound` (confirmed
   * against the actual `linuxdoom-1.10` source rather than assumed, the same
   * rigor as the line-special tables elsewhere in this codebase): a line
   * whose vertical opening is fully closed (a shut door) stops the flood
   * outright, a `LF.BLOCK_SOUND` line softens it once (crossable, but a
   * *second* `BLOCK_SOUND` crossing on the same path stops it), and every
   * other two-sided line passes it through unchanged. Marked sectors
   * (`isSoundAlerted`) stay marked for the rest of the level — vanilla's own
   * `sector->soundtarget` is never cleared either — so a monster that only
   * wanders into an already-noisy sector later still wakes, not just
   * whichever monster happened to be standing there at the moment of the
   * shot. The state-space search tracks `(sector, hasCrossedABlockLine)`
   * pairs rather than just sectors, so a sector reached first via a
   * sound-blocked path can still be re-entered (and propagate further) via a
   * later, unblocked path — exactly the nuance vanilla's own
   * `soundtraversed <= soundblocks+1` guard preserves.
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
 * A blast's own impact point routinely sits exactly on the wall it hit (a
 * rocket exploding against a wall, rather than on a monster out in the open)
 * — without this margin, a splash-damage ray leaving from that point would
 * immediately register a self-intersection with that very wall at its own
 * origin (t≈0) and `hasLineOfSight` would report every direction blocked,
 * including straight out into the open room the explosion is plainly in.
 * Skipping a crossing this close to the ray's start is the same "nudge off
 * the geometry you're standing on" idea `WALL_OVERLAP`/`BLOCKER_OVERLAP` use
 * elsewhere, just applied to the *near* end of the ray instead of extending
 * its target.
 */
const SELF_HIT_MARGIN = 1;

/**
 * How far apart (map units) to sample intervening sectors' floor/ceiling
 * along a sightline — see `hasLineOfSight`'s doc for why this exists at all.
 * Fine enough to catch a typical ledge/mezzanine overhang, coarse enough
 * that a long sightline doesn't cost dozens of BSP walks.
 */
const SIGHT_HEIGHT_SAMPLE_STEP = 64;

/**
 * True if a straight 3D line between two points isn't crossed by any
 * sight-blocking *line* (`World.blocksSight`, e.g. a closed door) **and**
 * doesn't need to pass through the floor or ceiling of any sector it
 * travels over/under along the way.
 *
 * The line-crossing half is the same test FogOfWar's own player-to-sample
 * rays use for reveal, factored out here so splash/radius damage (game.ts's
 * `applyRadiusDamage`) and monster AI (game/monsters.ts) can ask "does this
 * reach that point" without duplicating the raycast. The floor/ceiling half
 * exists because that test alone only ever finds a *wall* between two
 * points — it has no idea a solid floor could separate them with no wall in
 * the way at all: a monster standing in a room genuinely underneath a ledge
 * the player is standing on, with no shared two-sided line anywhere near the
 * straight 2D path between them, registered as fully visible (and
 * shootable) purely because nothing in `linesNear` ever blocked it. Vanilla
 * avoids this because its own `P_CheckSight` walks the BSP and narrows a
 * top/bottom sight wedge through every sector's actual floor/ceiling height
 * as it crosses — this is a coarser stand-in for that: sample points along
 * the path, and reject if the straight line's own interpolated height at any
 * sampled point falls outside that point's sector's floor..ceiling range.
 */
export function hasLineOfSight(world: World, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): boolean {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  for (const i of world.linesNear((x1 + x2) / 2, (y1 + y2) / 2, dist / 2 + 1)) {
    if (!world.blocksSight(i)) continue;
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) continue;
    const hit = segmentIntersect(x1, y1, x2, y2, a.x, a.y, b.x, b.y);
    if (hit && hit.t * dist > SELF_HIT_MARGIN) return false;
  }

  const steps = Math.max(1, Math.ceil(dist / SIGHT_HEIGHT_SAMPLE_STEP));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sector = world.sectorAt(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    if (!sector) continue;
    const sz = z1 + (z2 - z1) * t;
    if (sz < sector.floorHeight || sz > sector.ceilHeight) return false;
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

/**
 * A body (monster or player) that other bodies physically bump into —
 * vanilla's `MF_SOLID` things, tested by `PIT_CheckThing`. Callers pass the
 * set of *other* bodies; nothing here filters out the mover itself.
 *
 * There is deliberately no height on this, because vanilla has none either:
 * `PIT_CheckThing`'s solid-blocking path returns before any z comparison, so
 * a DOOM actor blocks over its **entire** vertical extent regardless of how
 * far above or below the mover it actually is — the "infinitely tall actors"
 * behavior. Adding a height check here would be a quiet deviation, not a fix;
 * mappers routinely (if accidentally) rely on the vanilla rule.
 */
export interface ThingBlocker {
  x: number;
  y: number;
  radius: number;
}

/**
 * True if a body of `radius` standing at (x, y) overlaps one of `blockers` —
 * vanilla's `PIT_CheckThing` overlap test, which is an axis-aligned **box**
 * check on the summed radii (`abs(dx) < r1+r2 && abs(dy) < r1+r2`), not the
 * circle test the rest of this file's collision uses. Kept boxy on purpose:
 * it's why squeezing past a DOOM monster in a doorway behaves the way it
 * does, and rounding it off would change contact ranges everywhere by up to
 * ~40% on the diagonal.
 */
function blockedByThings(x: number, y: number, radius: number, blockers: readonly ThingBlocker[] | undefined): boolean {
  if (!blockers) return false;
  for (const b of blockers) {
    const reach = radius + b.radius;
    if (Math.abs(b.x - x) < reach && Math.abs(b.y - y) < reach) return true;
  }
  return false;
}

/**
 * True if a circle at (x, y) overlaps any line that blocks it. `forMonster`
 * — see `World.isSolidWall`. `avoidDropoff`, when true, also rejects this
 * position if it stands over a dropoff — `groundFloor`'s rest height sits
 * more than `MAX_STEP_UP` above `dropoffFloor`'s lowest touched floor —
 * matching vanilla's own `P_TryMove`, which uses the identical 24-unit
 * threshold for both the step-up allowance and this dropoff rule. Vanilla
 * exempts `MF_DROPOFF`/`MF_FLOAT` things (notably its floating monsters);
 * here that's the caller's job (`game/monsters.ts` never passes true for a
 * flying monster type) — the player's own movement never passes it at all,
 * since walking off a ledge and falling under gravity is this engine's own
 * deliberate, already-shipped player feature (see player.ts's own doc).
 * `blockers` are the other solid bodies in the way (see `ThingBlocker`);
 * omitting them means only geometry blocks, which is what every caller did
 * before monsters could bump into anything.
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
): boolean {
  if (blockedByThings(x, y, radius, blockers)) return true;
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
 * Moves a circle by (dx, dy) and slides along whatever it hits, by trying the
 * two axes separately. Returns the position actually reached. `forMonster`/
 * `avoidDropoff` — see `circleBlocked`; the player's own movement never
 * passes either.
 */
export function slideMove(
  world: World,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  z: number,
  forMonster = false,
  avoidDropoff = false,
  blockers?: readonly ThingBlocker[],
): { x: number; y: number } {
  let nx = x;
  let ny = y;
  if (dx !== 0 && !circleBlocked(world, x + dx, y, radius, z, forMonster, avoidDropoff, blockers)) nx = x + dx;
  if (dy !== 0 && !circleBlocked(world, nx, y + dy, radius, z, forMonster, avoidDropoff, blockers)) ny = y + dy;
  // If sliding on one axis failed while the other moved, retry the blocked axis
  // from the new position — that lets the player round convex corners smoothly.
  if (ny === y && dy !== 0 && nx !== x && !circleBlocked(world, nx, y + dy, radius, z, forMonster, avoidDropoff, blockers)) ny = y + dy;
  return { x: nx, y: ny };
}

/**
 * How far a hitscan shot or a projectile travels before it's treated as
 * having reached its target, in map units — vanilla's own `MISSILERANGE`
 * (`32*64`), which every one of its hitscan attacks passes to `P_LineAttack`,
 * player and monster alike. A pure distance with no time component, so unlike
 * player.ts's `GRAVITY` there was never anything to convert.
 */
export const WEAPON_RANGE = 2048;

/**
 * Each candidate wall is extended this far past both its own endpoints
 * before the ray is tested against it — the same fix and the same distance
 * as FogOfWar's `BLOCKER_OVERLAP`. Two walls meeting exactly at a shared
 * vertex (a corner, a door frame) otherwise let a ray aimed right at that
 * point pass just outside the end of both and hit neither, so a shot fired
 * straight at a corner would sail through the gap instead of stopping.
 */
const WALL_OVERLAP = 0.25;

/**
 * True if this line should stop a shot passing through it at height `z` —
 * `z` being wherever *this particular* shot's line (which may be sloped, see
 * `shotPath`) is when it crosses this line, not a single height for the whole
 * flight.
 *
 * Deliberately **not** `isSolidWall`: a shot is never stopped by the
 * `BLOCKING` flag alone, only by a line with no opening at all — either a
 * genuinely one-sided wall, or a two-sided line whose opening has closed
 * (a shut door). Vanilla's own hitscan/projectile traversal
 * (`PTR_ShootTraverse` in `p_map.c`) only ever checks whether a line is
 * two-sided and whether its vertical opening clears the shot; it never reads
 * `ML_BLOCKING` at all, which only ever gates *movement*
 * (`PIT_CheckLine`/`P_CheckPosition`). A two-sided `BLOCKING` line — a barred
 * window or railing, the exact same kind of thing `blocksSight` already
 * treats as sight-passable — stops a *walking* thing but not a bullet or
 * fireball, precisely like a real window: you can shoot through bars you
 * can't walk through. Reusing `isSolidWall` here was wrong, and was exactly
 * why DOOM2 MAP01's east imp closet (sector 38, whose fence is a real
 * `BLOCKING` two-sided line) blocked *both* the player's own shots at the
 * imp and the imp's fireballs at the player, when vanilla would let both
 * pass straight through.
 *
 * The height test below only applies to a **free** shot, one aimed by the
 * mouse at open floor with no target locked. Such a shot flies flat at the
 * shooter's own height, so a sector whose floor has stepped up to or above
 * `z` — a low platform just a bit taller than the shot is flying — has to
 * stop it, even though a *taller* person could see over it; without this a
 * projectile sailed straight through the riser, since the opening beyond it
 * was tall enough for sight but not for the shot. A **locked-on** shot
 * (`lockedOn`) is the opposite case: the shot is deliberately angled up or
 * down to reach a target it already knows the exact position of, so an
 * intervening step is something it clears rather than hits. Applying the
 * height test there stopped such a shot dead at the near edge of the platform
 * its target stood on — which read as the shot going flat and ignoring the
 * click. `shotPath`'s own `skipHeightTest` parameter controls this
 * separately from whether a `target` was given at all — see its doc for why
 * a monster's own fired shot needs a target (to slope toward the player's
 * height) without inheriting this leniency.
 */
function blocksShot(world: World, lineIndex: number, z: number, lockedOn: boolean): boolean {
  const line = world.map.linedefs[lineIndex];
  if (!line || line.left === NO_SIDE || line.right === NO_SIDE) return true;
  const opening = world.openingOf(lineIndex);
  if (!opening || opening.top <= opening.bottom) return true;
  if (lockedOn) return false;
  return z < opening.bottom || z > opening.top;
}

/** Where a shot actually ends up: the point it stopped at, the height it was at there, and how far that was. */
export interface ShotPath {
  x: number;
  y: number;
  z: number;
  dist: number;
}

/**
 * Traces a shot fired from (x, y) at height `z` along `angleRad` and returns
 * where it ends up, stopped at the nearest line that blocks it
 * (`blocksShot`, tested at that line's own height along the shot's slope).
 *
 * With no `target` this is a free shot: flat at `z`, out to `WEAPON_RANGE`,
 * stopped by walls and by floor/ceiling steps it can't clear.
 *
 * With a `target` — auto-aim's locked-on monster (main.ts), or a monster's
 * own fired shot aimed at whatever it's hunting, player or another monster
 * (game.ts's `spawnMonsterProjectile`/`resolveMonsterHitscan`) — it instead
 * runs from `z` to the target's own height over exactly the
 * distance to it, so it angles toward a target standing higher or lower
 * rather than flying flat past it, and stops *at* the target instead of
 * continuing to whatever is behind. The origin height stays `z`, the
 * shooter's own, so a rendered tracer/projectile always starts at the
 * shooter rather than mid-air.
 *
 * `skipHeightTest` (default: true whenever `target` is given) is the
 * player-auto-aim leniency described on `blocksShot` — clearing an
 * intervening step instead of being stopped dead at its near edge — kept as
 * a *separate* parameter from `target` specifically so a monster's own shot
 * can still slope toward the player's height without inheriting it: the
 * player has no such "auto-aim" convenience to justify skipping the height
 * test, so a monster's projectile should be blocked by a low or high step
 * exactly the way a free shot would be, just angled correctly.
 *
 * Used both for a hitscan weapon's tracer endpoint and for how far a fired
 * projectile is allowed to fly (game/weapons.ts, main.ts, game.ts).
 */
export function shotPath(
  world: World,
  x: number,
  y: number,
  z: number,
  angleRad: number,
  target: { x: number; y: number; z: number } | null = null,
  skipHeightTest: boolean = target !== null,
): ShotPath {
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  const maxRange = target ? Math.hypot(target.x - x, target.y - y) : WEAPON_RANGE;
  const endZ = target ? target.z : z;
  const tx = x + dx * maxRange;
  const ty = y + dy * maxRange;
  let nearestT = 1;
  for (const i of world.linesNear(x, y, maxRange)) {
    const line = world.map.linedefs[i];
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) continue;
    const ldx = b.x - a.x;
    const ldy = b.y - a.y;
    const len = Math.hypot(ldx, ldy);
    const ex = len > 0 ? (ldx / len) * WALL_OVERLAP : 0;
    const ey = len > 0 ? (ldy / len) * WALL_OVERLAP : 0;
    const hit = segmentIntersect(x, y, tx, ty, a.x - ex, a.y - ey, b.x + ex, b.y + ey);
    if (!hit || hit.t >= nearestT) continue;
    if (blocksShot(world, i, z + (endZ - z) * hit.t, skipHeightTest)) nearestT = hit.t;
  }
  const dist = maxRange * nearestT;
  return { x: x + dx * dist, y: y + dy * dist, z: z + (endZ - z) * nearestT, dist };
}
