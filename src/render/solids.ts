/**
 * The solid structures a DOOM map draws as *void*: closed rings of one-sided
 * linedefs with no sector inside them. Vanilla never has to draw their tops;
 * a camera looking down does. See docs/render.md § Solid structures.
 */
import { NO_SIDE, type DoomMap } from '../wad/map.ts';
import { polygonCentroid } from '../util/geom.ts';
import type { SectorPoly } from './bsp.ts';

/** How far outside an edge the side probe steps, in map units — far enough to clear the line, short enough to stay in the sector it borders. */
const PROBE_DISTANCE = 1;

/** Rings smaller than this are mapping debris (a slit, a zero-width leftover), not something with a visible top. */
const MIN_AREA = 4;

/**
 * One solid structure's lid: the ring's footprint, the height its walls reach,
 * and where its material and light come from.
 */
export interface SolidCap {
  /** Ring footprint in DOOM (x, y), flattened — in order, closed implicitly. */
  points: Float64Array;
  /** Height the lid sits at: the lowest ceiling among the sectors the ring borders. */
  height: number;
  /** Wall texture to draw it with — the ring's own, since a solid block's top is made of what its sides are. */
  texture: string;
  /** Sector the lid takes its light from, and the one whose ceiling set `height`. */
  sector: number;
  /** A point just outside one edge, in the bordering sector — for resolving which subsector reveals the lid. */
  probeX: number;
  probeY: number;
}

/**
 * Every closed ring of one-sided linedefs that has the map *outside* it.
 *
 * A one-sided linedef has a sector on its front and nothing at all behind it,
 * so a ring of them is either a room's outer wall (the sector is inside) or a
 * solid structure standing in a room (the sector is outside). Only the second
 * kind has a top to draw, and the two are told apart by probing just off an
 * edge's front side: land outside the ring and the sector is outside it.
 *
 * A ring is closed by the simple walk where every vertex joins exactly two
 * one-sided lines, and by `traceVoidFace` where a weld puts a third there.
 *
 * Only rings enclosing **no floor at all** are lidded: a building's outer wall
 * is also a ring with the map outside it, and the void there is just the wall's
 * thickness, so roofing it over would bury every room it contains. A solid
 * block encloses no subsector; a building encloses its rooms'.
 */
export function findSolidCaps(map: DoomMap, polys: readonly SectorPoly[]): SolidCap[] {
  const linesAt = new Map<number, number[]>();
  const outgoing = new Map<number, number[]>();
  const solid: number[] = [];
  for (const [i, line] of map.linedefs.entries()) {
    if (line.left !== NO_SIDE || line.right === NO_SIDE) continue;
    solid.push(i);
    for (const v of [line.v1, line.v2]) {
      const at = linesAt.get(v);
      if (at) at.push(i);
      else linesAt.set(v, [i]);
    }
    const out = outgoing.get(line.v1);
    if (out) out.push(i);
    else outgoing.set(line.v1, [i]);
  }

  const caps: SolidCap[] = [];
  const visited = new Set<number>();
  for (const start of solid) {
    if (visited.has(start)) continue;
    const ring = traceRing(map, linesAt, visited, start) ?? traceVoidFace(map, outgoing, start);
    if (!ring) continue;
    for (const line of ring.lines) visited.add(line);
    const cap = capFor(map, polys, ring);
    if (cap) caps.push(cap);
  }
  return caps;
}

/** The linedefs and vertexes of the closed ring `start` belongs to, or null where it is not a simple one. */
function traceRing(
  map: DoomMap,
  linesAt: Map<number, number[]>,
  visited: Set<number>,
  start: number,
): { lines: number[]; vertexes: number[] } | null {
  const lines: number[] = [];
  const vertexes: number[] = [];
  let current = start;
  let from = map.linedefs[start].v1;
  for (;;) {
    lines.push(current);
    vertexes.push(from);
    visited.add(current);
    const line = map.linedefs[current];
    const next = line.v1 === from ? line.v2 : line.v1;
    const at = linesAt.get(next);
    // A junction (or a dead end) means this is not a simple ring.
    if (!at || at.length !== 2) return null;
    const other = at[0] === current ? at[1] : at[0];
    if (other === start) break;
    if (visited.has(other)) return null;
    current = other;
    from = next;
  }
  return lines.length >= 3 ? { lines, vertexes } : null;
}

/**
 * The same outline where a junction stopped the simple walk: a structure welded
 * to a wall, or to another structure, shares a vertex with a third one-sided
 * line, and which line continues *its* outline is then a real choice.
 *
 * A one-sided line has its sector on the right of `v1 -> v2`, so void is always
 * on the left of that direction, and a structure's outline is the void face
 * lying to the left of every line on it. Keeping to one face means taking the
 * **rightmost turn** available at each vertex: hugging the face on the left is
 * turning as far from it as the lines there allow. Take the leftmost instead and
 * a stub welded to the corner is followed out of the structure entirely.
 *
 * Only ever a fallback, never a replacement: over the committed WADs it
 * reproduces all 6505 rings the simple walk closes, line for line, but four
 * rings it closes are ones this declines — a ring wound inconsistently has no
 * single void side to follow. docs/render.md § Solid structures.
 */
function traceVoidFace(map: DoomMap, outgoing: Map<number, number[]>, start: number): { lines: number[]; vertexes: number[] } | null {
  const lines: number[] = [];
  const vertexes: number[] = [];
  let current = start;
  for (;;) {
    const line = map.linedefs[current];
    const a = map.vertexes[line.v1];
    const b = map.vertexes[line.v2];
    if (!a || !b) return null;
    lines.push(current);
    vertexes.push(line.v1);

    const candidates = outgoing.get(line.v2);
    if (!candidates || candidates.length === 0) return null;
    let next = candidates[0];
    if (candidates.length > 1) {
      const inAngle = Math.atan2(b.y - a.y, b.x - a.x);
      let bestTurn = Infinity;
      for (const candidate of candidates) {
        const other = map.linedefs[candidate];
        const oa = map.vertexes[other.v1];
        const ob = map.vertexes[other.v2];
        if (!oa || !ob) continue;
        let turn = Math.atan2(ob.y - oa.y, ob.x - oa.x) - inAngle;
        while (turn <= -Math.PI) turn += 2 * Math.PI;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        if (turn < bestTurn) {
          bestTurn = turn;
          next = candidate;
        }
      }
    }
    if (next === start) return lines.length >= 3 ? { lines, vertexes } : null;
    // Rejoining anywhere but the start means the walk is not tracing one face.
    if (lines.includes(next)) return null;
    current = next;
  }
}

function capFor(map: DoomMap, polys: readonly SectorPoly[], ring: { lines: number[]; vertexes: number[] }): SolidCap | null {
  const points = new Float64Array(ring.vertexes.length * 2);
  for (const [i, v] of ring.vertexes.entries()) {
    const vertex = map.vertexes[v];
    if (!vertex) return null;
    points[i * 2] = vertex.x;
    points[i * 2 + 1] = vertex.y;
  }
  const area = signedArea(points);
  if (Math.abs(area) < MIN_AREA) return null;
  // Which way round a ring comes out depends on the arbitrary direction the
  // trace happened to start in, so normalise it: a lid is triangulated and
  // wound like a floor, and a floor faces up only when its footprint is
  // counter-clockwise in map space. Backwards, it would be culled away.
  if (area < 0) reversePoints(points);

  // The lid takes the *lowest* ceiling the ring borders, so it can never float
  // above a wall top and leave the gap it exists to close.
  let sector = -1;
  let height = Infinity;
  const textures = new Map<string, number>();
  for (const lineIndex of ring.lines) {
    const side = map.sidedefs[map.linedefs[lineIndex].right];
    if (!side) continue;
    const own = map.sectors[side.sector];
    if (!own) continue;
    if (own.ceilHeight < height) {
      height = own.ceilHeight;
      sector = side.sector;
    }
    if (side.middle !== '' && side.middle !== '-') {
      textures.set(side.middle, (textures.get(side.middle) ?? 0) + 1);
    }
  }
  if (sector < 0 || textures.size === 0) return null;
  const texture = [...textures].sort((a, b) => b[1] - a[1])[0][0];

  const probe = probeOutside(map, ring);
  // The sector sitting *inside* the ring makes it a room's outer wall, not a
  // structure standing in one — there is nothing above it to draw.
  if (!probe || pointInPolygon(points, probe.x, probe.y)) return null;
  if (enclosesFloor(polys, points)) return null;

  return { points, height, texture, sector, probeX: probe.x, probeY: probe.y };
}

/**
 * Whether any of the map's *floor* lies inside the ring, which makes it a
 * building's outer wall rather than a solid block. Asked of the subsectors
 * rather than of stray vertexes: a WAD's `VERTEXES` lump carries plenty that
 * belong to no linedef at all, and a neighbour's corner can sit inside a
 * diagonal block's bounding box without anything standing there.
 *
 * A subsector is convex, so the mean of its points is inside it.
 */
function enclosesFloor(polys: readonly SectorPoly[], points: Float64Array): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  for (const poly of polys) {
    if (poly.points.length < 6) continue;
    const { x: cx, y: cy } = polygonCentroid(poly.points);
    if (cx <= minX || cx >= maxX || cy <= minY || cy >= maxY) continue;
    if (pointInPolygon(points, cx, cy)) return true;
  }
  return false;
}

/** A point `PROBE_DISTANCE` off the front (right) side of the ring's longest edge — the side its sector is on. */
function probeOutside(map: DoomMap, ring: { lines: number[]; vertexes: number[] }): { x: number; y: number } | null {
  let best = -1;
  let bestLength = 0;
  for (const [i, lineIndex] of ring.lines.entries()) {
    const line = map.linedefs[lineIndex];
    const a = map.vertexes[line.v1];
    const b = map.vertexes[line.v2];
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > bestLength) {
      bestLength = length;
      best = i;
    }
  }
  if (best < 0 || bestLength < 1e-6) return null;

  // Probed off the linedef's own direction, not the ring traversal's, since it
  // is the linedef that decides which side its sidedef faces.
  const line = map.linedefs[ring.lines[best]];
  const a = map.vertexes[line.v1];
  const b = map.vertexes[line.v2];
  const dx = (b.x - a.x) / bestLength;
  const dy = (b.y - a.y) / bestLength;
  return {
    x: (a.x + b.x) / 2 + dy * PROBE_DISTANCE,
    y: (a.y + b.y) / 2 - dx * PROBE_DISTANCE,
  };
}

function reversePoints(points: Float64Array): void {
  const n = points.length / 2;
  for (let i = 0; i < Math.floor(n / 2); i++) {
    const j = n - 1 - i;
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    points[i * 2] = points[j * 2];
    points[i * 2 + 1] = points[j * 2 + 1];
    points[j * 2] = x;
    points[j * 2 + 1] = y;
  }
}

function signedArea(points: Float64Array): number {
  let area = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return area / 2;
}

/** Ray-crossing test — the ring can be concave, so the convex helpers in util/geom.ts don't fit. */
export function pointInPolygon(points: Float64Array, x: number, y: number): boolean {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
