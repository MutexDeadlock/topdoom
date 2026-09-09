/**
 * The solid structures a DOOM map draws as something other than a room: closed rings of one-sided
 * linedefs with no sector inside them, and the blocks a mapper builds out of a sector with no room
 * in it. Vanilla never has to draw their tops; a camera looking down does.
 * See docs/render-solids.md.
 */
import { isTextured, NO_SIDE, SKY_FLAT, type DoomMap, type Sector } from '../wad/map.ts';
import { polygonBounds, polygonCentroid, signedPolygonArea2, vecLength, type PolygonBounds } from '../util/geom.ts';
import { readStorage, writeStorage } from '../util/storage.ts';
import type { SectorPoly } from './bsp.ts';

const STORAGE_KEY = 'solidCaps';

/**
 * Whether the map's solid structures are capped at all. On by default, and read once per level
 * (`solidsOf`): the caps are baked into the static batches, so a toggle mid-level would leave a
 * mover rebuild disagreeing with them. docs/render-solids.md.
 */
let enabled = readStorage(STORAGE_KEY, true);

export function getSolidCaps(): boolean {
  return enabled;
}

export function setSolidCaps(on: boolean): void {
  enabled = on;
  writeStorage(STORAGE_KEY, on);
}

/**
 * How far outside an edge the side probe steps, in map units — far enough to clear the line, short
 * enough to stay in the sector it borders.
 */
const PROBE_DISTANCE = 1;

/**
 * Rings smaller than this are mapping debris (a slit, a zero-width leftover), not something with a
 * visible top. **Tuned by feel.**
 */
const MIN_AREA = 4;

/**
 * How large a structure's footprint may be and still be lidded, in map units² — a 128×128 crate.
 * **Tuned by feel**: past it a ring is the level's own wall mass rather than an object standing in
 * a room, and its lid is a plate through the mass (DOOM1 E1M1's L-shaped mass beside the hexagon
 * courtyard, 87,296 units² roofed at 176). It limits only a ring with a **lip**: one whose every
 * wall ends at the lid (`flushAtTop`) is closed all round at any size — E1M6's two computer banks
 * at (-224, -128) and (96, -128), 40,960 units² each with every face at 248.
 * docs/render-solids.md.
 */
const MAX_CAP_AREA = 16384;

/**
 * How far above the light most of a cap's own walls carry that cap may still be lit — two of DOOM's
 * 16-unit light steps. **Tuned by feel**: a wall dimmer than that is the shade the structure casts
 * at its own foot and must not darken its top (GoingDown.wad MAP08's crate stack, a 112 strip
 * against the 144 the level around it carries), while one far brighter is a lit region the
 * structure merely borders (DOOM2 MAP12: 180 units of a 255 light strip on a 2,857-unit ring).
 */
const SHADE_STEP = 32;

/**
 * What `pocketsOf` asks of a structure's top, and all it asks: how high it stands, what lights it,
 * and which of its faces stop where a level beside them begins. A ring's cap answers it and so does
 * a block's. docs/render-solids.md.
 */
export interface SolidLid {
  /**
   * Where the top sits: the lowest ceiling among the faces that are the structure's top
   * (`lidLevels`, `materialReach`), so it never floats above a wall top and reopens the gap.
   */
  height: number;
  /**
   * Sector the top takes its **light** from, rarely the one that set `height` (`litFace`,
   * `litOutside`): the light most of the walls it closes carry, lifted to a brighter one beside it.
   */
  lightSector: number;
  /**
   * The faces that stop where the level beside them begins (`buriedFaces`, `SolidBlock.buried`),
   * as linedef indexes — what `pocketsOf` reads. Empty on a cap under a lid.
   */
  buried: readonly number[];
}

/**
 * One solid structure's lid: the ring's footprint, the height its walls reach,
 * and where its material and light come from.
 */
export interface SolidCap extends SolidLid {
  /** Ring footprint in DOOM (x, y), flattened — in order, closed implicitly. */
  points: Float64Array;
  /** `points`' box — where a wall texture's run on the lid starts (`capTextureOrigin`). */
  bounds: PolygonBounds;
  /**
   * Wall texture to draw it with — the ring's own, since a solid block's top is made of what its
   * sides are.
   */
  texture: string;
  /** Sector whose ceiling set `height`, and the one the cap's fans are filed under. */
  sector: number;
  /**
   * Whether this cap is one of the levels *below* the lid: a ring with faces buried under a
   * neighbouring level gets a further cap at each such level (`lidLevels`), so the box is closed
   * from that side too, seen only from the level it closes. docs/render-solids.md.
   */
  under: boolean;
  /**
   * Linedef whose front side lends the lid its texture — and, with it, the texture row that side
   * shows at the wall top the lid meets. docs/render-solids.md.
   */
  line: number;
  /**
   * A point just outside *each* of the ring's edges, in the sector that edge borders, flattened
   * (x, y) in ring order — every side the structure can be seen from, which is what decides when
   * its cap is revealed. Degenerate edges carry `NaN`. docs/render-solids.md.
   */
  probes: Float64Array;
}

/**
 * Every closed ring of one-sided linedefs that has the map *outside* it — the pillars, crates and
 * lamp posts that need a lid. A ring with its sector inside is a room's outer wall, and one that
 * encloses any floor is a building; both are dropped.
 * docs/render-solids.md has the rules and why each holds.
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
    caps.push(...capsFor(map, polys, ring));
  }
  return caps;
}

/**
 * One solid block's cap: what every leaf of it draws, and what it takes to re-decide that at the
 * heights the level stands at now. No footprint of its own — the leaves are the footprint.
 * docs/render-solids.md § Blocks built out of a sector.
 */
export interface SolidBlockCap extends SolidLid {
  /** Every sector the block fills: the roomless ones, and whatever is sealed inside them. */
  sectors: ReadonlySet<number>;
  /** The roomless sectors with their neighbours — what `blockCapHeight` re-asks `materialReach` over. */
  solid: readonly { sector: number; neighbours: readonly number[] }[];
  /**
   * Wall texture to fall back on, and the linedef it takes that row from — `blockTexture`.
   * Anchored to `bounds`, so one block's leaves share a texture run rather than each starting one.
   */
  texture: string;
  line: number;
  bounds: PolygonBounds;
  /** The ceiling flat the cap wears instead, where the block carries one — `blockFlat`. */
  flat?: string;
  /**
   * A point just outside each of the block's faces, flattened (x, y): every side it can be seen
   * from, which is what decides when its cap is revealed — a leaf inside solid material never is
   * (docs/fogofwar.md § Closed sectors). Degenerate faces carry `NaN`.
   */
  probes: Float64Array;
}

/**
 * The solid **blocks** a map builds out of sectors rather than out of void: a sector with no room
 * in it — floor at or above ceiling — that stands above the ground beside it, whose neighbours
 * carry its material on up to their own ceilings in their upper textures. Vanilla shows such a
 * block from the side alone, and it is a crate or a pillar as much as a void ring is.
 *
 * One cap per block, drawn by every leaf of every sector it fills rather than emitted as geometry
 * here (`flatSpecsOf`): a leaf polygon is already convex, a light well cut into a crate would
 * otherwise leave the top a hole, and the flat path is where a mover re-decides what its sector
 * draws — a block a lift lowers stops being one.
 * docs/render-solids.md § Blocks built out of a sector.
 */
export function findSolidBlocks(map: DoomMap): SolidBlockCap[] {
  const known = blocksBuilt.get(map);
  if (known) return known;
  const caps: SolidBlockCap[] = [];
  for (const block of blocksOf(map)) {
    const probes = new Float64Array(block.faces.length * 2);
    const bounds: PolygonBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const [i, face] of block.faces.entries()) {
      const line = map.linedefs[face.line];
      const a = map.vertexes[line.v1];
      const b = map.vertexes[line.v2];
      if (a && b) {
        bounds.minX = Math.min(bounds.minX, a.x, b.x);
        bounds.minY = Math.min(bounds.minY, a.y, b.y);
        bounds.maxX = Math.max(bounds.maxX, a.x, b.x);
        bounds.maxY = Math.max(bounds.maxY, a.y, b.y);
      }
      // Off the side the level lies on: the linedef's right, or its left where `face.side` is that.
      probeOff(map, face.line, line.right === face.side ? 1 : -1, probes, i);
    }

    const texture = blockTexture(map, block);
    caps.push({
      sectors: block.sectors,
      solid: block.solid,
      height: block.height,
      texture: texture.name,
      line: texture.line,
      bounds,
      flat: block.flat,
      lightSector: litOutside(map, block),
      buried: block.buried,
      probes,
    });
  }
  blocksBuilt.set(map, caps);
  return caps;
}

/** One trace per map, weak on it as `bsp.ts`'s polys are: three callers ask, none changes the map. */
const blocksBuilt = new WeakMap<DoomMap, SolidBlockCap[]>();

/**
 * The blocks a mover can move, each as the full list of its sectors — what a caller has to make
 * mover-owned **whole**, a block's cap being one decision over all of it (`blockCapHeight`):
 * GoingDown.wad MAP08's crate at (-352, -272), an 8-unit rim on a lift around a sealed light well.
 * docs/render-solids.md § Blocks built out of a sector.
 */
export function movableBlocks(map: DoomMap, movable: ReadonlySet<number>): number[][] {
  const groups: number[][] = [];
  for (const cap of findSolidBlocks(map)) {
    const sectors = [...cap.sectors];
    if (sectors.some((i) => movable.has(i))) groups.push(sectors);
  }
  return groups;
}

/**
 * The height a block's cap stands at now, or null where the level has taken the material out from
 * under it: `materialReach`, re-asked over the sectors `blocksOf` grouped once. What holds a cap up
 * is the **material over the block**, not the block's floor — a lift that drops a crate's floor
 * leaves everything above the crate's ceiling standing and opens a nook under it, which is roofed
 * like any other (§ The pockets in them); it is the block's **ceiling** rising to the level's own
 * that ends the material, which is what a mapper does to sink a pillar for good (Literalism MAP18's
 * field: one `40` per cluster beside the `38`/`219` that lower the floor).
 *
 * Any one part losing its material takes the whole cap: the structure is one object, and half a lid
 * is worse than none. docs/render-solids.md § Blocks built out of a sector.
 */
export function blockCapHeight(map: DoomMap, cap: SolidBlockCap): number | null {
  let height = Infinity;
  for (const { sector, neighbours } of cap.solid) {
    const reach = materialReach(map, sector, neighbours);
    if (reach === null) return null;
    height = Math.min(height, reach);
  }
  return height === Infinity ? null : height;
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
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * How much of a sector's whole perimeter its buried structure walls must make up before it counts
 * as a pocket in the structure. A plain wall of the level counts against it like an opening does,
 * rather than ruling the sector out on its own: GoingDown.wad MAP08's nook at (136, 64) carries 32
 * units of the room's `SHAWN2` wall and is a crate nook all the same. **Tuned by feel** alongside
 * the height and area tests in `pocketsOf`: under 0.2 come the alcoves a room merely has a crate
 * wall on, roofed in the room's own rock ceiling (MAP08's sector 109 and MAP31's 383, both
 * `RROCK14` at 0.18), and below those MAP26's warehouse floor. At 0.2 the crate nooks remain and
 * the alcoves are gone — MAP08's sector 36 sits at 0.23.
 */
const POCKET_SHARE = 0.2;

/**
 * How far a structure's lid may stand above a pocket's own ceiling: the material the structure has
 * over the nook. **Tuned by feel** — one crate's height covers every real case in the committed
 * WADs (GoingDown.wad MAP08 and MAP31 are 32 or 64, freedoom2 MAP10's is 10), while freedoom2
 * MAP17's sector 83 sits 336 under the lid of a tower it merely leans on, and would be roofed
 * up there.
 */
const POCKET_RISE = 64;

/**
 * How big a pocket may be, in map units². **Tuned by feel**: a nook cut into a structure is small,
 * and the committed WADs leave a clean gap — every real one is under 6,000 (GoingDown.wad MAP08's
 * run from 448 to 3,968), while the next candidates up are rooms that happen to be ringed by
 * structure walls, from DOOM2 MAP13's 12,544 to freedoom2 MAP29's 254,976. Two crates side by side.
 */
const POCKET_AREA = 8192;

/** What to draw over a pocket, and what its structure's lid wears. */
export interface SolidPockets {
  /**
   * Pocket sector → the plane that roofs it: the height of the lid around it, in the pocket's own
   * **ceiling** flat, lit by the sector that lid takes its light from. Not the pocket's ceiling
   * *height* — that plane is inside the structure, 64 units down in a crate stack, and roofing
   * there leaves the hole it was meant to close. Nor the pocket's own light: the roof is the top of
   * the structure, and the pocket is dim because it is the shade *under* it (GoingDown.wad MAP08:
   * 112 in the nook against 144 on the stack).
   */
  roofs: Map<number, { height: number; flat: string; lightSector: number }>;
  /** Index into the caps → the flat its lid wears, where its ring encloses a pocket. */
  lidFlat: Map<number, string>;
}

/**
 * The pockets **in** the map's solid structures: a nook carved out of one, with the structure's own
 * level running over it — GoingDown.wad MAP08's sector 39. Every one-sided wall such a sector has
 * is a face of some ring that stops where the level beside it begins (`SolidCap.buried`), and those
 * walls are at least `POCKET_SHARE` of its perimeter. The pocket is roofed at the lid's height and
 * that ceiling flat is what the lid wears. docs/render-solids.md § The pockets in them.
 */
export function pocketsOf(map: DoomMap, polys: readonly SectorPoly[], caps: readonly SolidLid[]): SolidPockets {
  const area = new Float64Array(map.sectors.length);
  for (const poly of polys) {
    if (poly.points.length >= 6) area[poly.sector] += Math.abs(signedPolygonArea2(poly.points) / 2);
  }

  const lidsOfLine = new Map<number, number[]>();
  for (const [i, cap] of caps.entries()) {
    for (const line of cap.buried) {
      const at = lidsOfLine.get(line);
      if (at) at.push(i);
      else lidsOfLine.set(line, [i]);
    }
  }

  const buried = new Float64Array(map.sectors.length);
  const solid = new Float64Array(map.sectors.length);
  const open = new Float64Array(map.sectors.length);
  /** The lowest ceiling a sector opens onto — how far a roof over it may reach before it pokes
   * through a neighbouring room's own. */
  const opensUnder = new Float64Array(map.sectors.length).fill(Infinity);
  const lidsOfSector = new Map<number, Set<number>>();
  const bury = (sector: number, length: number, lids: readonly number[]): void => {
    buried[sector] += length;
    let seen = lidsOfSector.get(sector);
    if (!seen) lidsOfSector.set(sector, (seen = new Set()));
    for (const lid of lids) seen.add(lid);
  };
  for (const [i, line] of map.linedefs.entries()) {
    const a = map.vertexes[line.v1];
    const b = map.vertexes[line.v2];
    if (!a || !b) continue;
    const length = vecLength(b.x - a.x, b.y - a.y);
    const right = line.right === NO_SIDE ? undefined : map.sidedefs[line.right];
    const left = line.left === NO_SIDE ? undefined : map.sidedefs[line.left];
    if (right && left) {
      // A solid block's face onto what it stands over (`findSolidBlocks`) is a structure wall
      // stopping where the nook's level begins, the same as a ring's buried face: the side that is
      // not the block is the nook's. GoingDown.wad MAP08's sector 257, an 8-unit slot under a
      // crate.
      const blockLids = lidsOfLine.get(i);
      if (blockLids) {
        bury((roomless(map.sectors[right.sector]) ? left : right).sector, length, blockLids);
        continue;
      }
      for (const [own, other] of [[right, left], [left, right]] as const) {
        open[own.sector] += length;
        // Only a neighbour whose ceiling is *above* this sector's caps a roof over it. One at the
        // same height is the same space, not a lid on it: MAP08's nooks 36 and 165 open onto each
        // other at 64 and are both roofed at the stack's 128.
        const ceiling = map.sectors[other.sector]?.ceilHeight ?? -Infinity;
        const mine = map.sectors[own.sector]?.ceilHeight ?? Infinity;
        if (ceiling > mine) opensUnder[own.sector] = Math.min(opensUnder[own.sector], ceiling);
      }
      continue;
    }
    const own = right ?? left;
    if (!own) continue;
    const lids = lidsOfLine.get(i);
    if (lids) bury(own.sector, length, lids);
    else solid[own.sector] += length;
  }

  const roofs: SolidPockets['roofs'] = new Map();
  const lidFlat: SolidPockets['lidFlat'] = new Map();
  for (const [i, sector] of map.sectors.entries()) {
    if (buried[i] === 0) continue;
    if (buried[i] < POCKET_SHARE * (buried[i] + solid[i] + open[i])) continue;
    // A closed door has nothing between floor and ceiling to roof, and a sky is not a crate top.
    if (roomless(sector) || sector.ceilTex === SKY_FLAT) continue;
    const lids = lidsOfSector.get(i);
    if (!lids || lids.size === 0) continue;
    // The lowest lid around it, for the reason `lidLevels` takes the lowest ceiling: a roof above
    // one of its own walls reopens the gap. Its sector lights the roof, being the one this piece of
    // the structure's top belongs to.
    let lowest = -1;
    for (const lid of lids) {
      if (lowest >= 0 && caps[lid].height >= caps[lowest].height) continue;
      lowest = lid;
    }
    const lid = caps[lowest];
    // The structure has to *have* material over the nook, and no more of it than a crate's worth:
    // a lid below the nook's own ceiling belongs to something shorter standing beside it, and one
    // far above to a tower it only leans on. A roof may not reach past what the nook opens onto
    // either, or it hides a neighbouring room from the level's own ceiling down.
    if (lid.height < sector.ceilHeight || lid.height - sector.ceilHeight > POCKET_RISE) continue;
    if (lid.height > opensUnder[i] || area[i] > POCKET_AREA) continue;
    roofs.set(i, { height: lid.height, flat: sector.ceilTex, lightSector: lid.lightSector });
    for (const lid of lids) lidFlat.set(lid, sector.ceilTex);
  }
  return { roofs, lidFlat };
}

/**
 * The linedefs and vertexes of the closed ring `start` belongs to, or null where it is not a simple
 * one.
 */
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
 * The same outline where a junction stopped the simple walk — a structure welded to a wall, or to
 * another structure, shares a vertex with a third one-sided line. Void lies to the left of every
 * one-sided line, so keeping to one face means taking the **rightmost turn** at each vertex.
 *
 * Deliberately a fallback, never a replacement: a ring wound inconsistently has no single void
 * side to follow, and the simple walk closes rings this declines.
 * docs/render-solids.md.
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

/** The caps one ring gets — its lid, plus one at each level a buried face stops at (`lidLevels`). */
function capsFor(map: DoomMap, polys: readonly SectorPoly[], ring: { lines: number[]; vertexes: number[] }): SolidCap[] {
  const points = new Float64Array(ring.vertexes.length * 2);
  for (const [i, v] of ring.vertexes.entries()) {
    const vertex = map.vertexes[v];
    if (!vertex) return [];
    points[i * 2] = vertex.x;
    points[i * 2 + 1] = vertex.y;
  }
  // Halved back to a true area, the unit `MIN_AREA` and `MAX_CAP_AREA` are in; the sign is what the
  // winding normalisation below reads.
  const area = signedPolygonArea2(points) / 2;
  const size = Math.abs(area);
  if (size < MIN_AREA) return [];
  // The trace starts in an arbitrary direction, so normalise the winding: a lid is triangulated
  // like a floor, and a floor faces up only where its footprint is counter-clockwise in map space.
  if (area < 0) reversePoints(points);

  const textures = new Map<string, number>();
  for (const lineIndex of ring.lines) {
    const side = map.sidedefs[map.linedefs[lineIndex].right];
    if (!side || !isTextured(side.middle)) continue;
    textures.set(side.middle, (textures.get(side.middle) ?? 0) + 1);
  }
  const texture = mostCounted(textures);
  if (texture === undefined) return [];

  const probes = probesAround(map, ring.lines);
  const probe = longestEdgeProbe(map, ring.lines, probes);
  // The sector sitting *inside* the ring makes it a room's outer wall, not a
  // structure standing in one — there is nothing above it to draw.
  if (!probe || pointInPolygon(points, probe.x, probe.y)) return [];
  const bounds: PolygonBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  polygonBounds(points, bounds);
  if (enclosesFloor(polys, points, bounds)) return [];

  const buriedFlags = buriedFaces(map, ring.lines);
  const buried = ring.lines.filter((_, i) => buriedFlags[i]);
  // `lidLevels` puts the lid first and the levels it closes off underneath after it.
  const levels = lidLevels(map, ring.lines, buriedFlags);
  // A lid at or under the ground the ring stands on closes nothing, and every cap below it is
  // deeper still. docs/render-solids.md.
  if (levels.length === 0 || levels[0].height <= lowestFloor(map, ring.lines)) return [];
  // Past `MAX_CAP_AREA` a ring is the level's wall mass, and only one whose every wall ends at the
  // lid is capped. docs/render-solids.md.
  if (size > MAX_CAP_AREA && !flushAtTop(map, ring.lines, buriedFlags, levels[0].height)) return [];

  const caps: SolidCap[] = [];
  for (const [i, { height, sector }] of levels.entries()) {
    const line = phaseLine(map, ring.lines, texture, height);
    if (line < 0) continue;
    const lightSector = litFace(map, ring.lines, height, sector);
    caps.push({ points, bounds, height, texture, sector, lightSector, under: i > 0, buried: i > 0 ? [] : buried, line, probes });
  }
  return caps;
}

/** Whether every face that is the structure's top ends at the lid — `MAX_CAP_AREA`. */
function flushAtTop(map: DoomMap, lines: readonly number[], buried: readonly boolean[], height: number): boolean {
  for (const [i, lineIndex] of lines.entries()) {
    const side = map.sidedefs[map.linedefs[lineIndex].right];
    const own = side ? map.sectors[side.sector] : undefined;
    if (own && !buried[i] && own.ceilHeight !== height) return false;
  }
  return true;
}

/**
 * The heights a ring is capped at, each with the sector the cap takes its light from. First the
 * lid: the **lowest** ceiling among the faces that are the structure's top, so it can never float
 * above a wall top and leave the gap it exists to close. Then one level per distinct ceiling a
 * buried face (`buried`, from `buriedFaces`) stops at below the lid, so the box is closed from
 * that side as well — from the tunnel a crate straddles, its wall ends at the tunnel ceiling, and
 * the lid up on the platform level would leave a hollow band under it. A ring buried at *every*
 * face cannot arise: burying the highest ceiling of the lot takes a neighbouring floor at least
 * that high, and `buriedFaces` spares the closed sectors that alone could offer one.
 * docs/render-solids.md.
 */
function lidLevels(map: DoomMap, lines: readonly number[], buried: readonly boolean[]): { height: number; sector: number }[] {
  let height = Infinity;
  let sector = -1;
  for (const [i, lineIndex] of lines.entries()) {
    const side = map.sidedefs[map.linedefs[lineIndex].right];
    if (!side) continue;
    const own = map.sectors[side.sector];
    if (!own || buried[i] || own.ceilHeight >= height) continue;
    height = own.ceilHeight;
    sector = side.sector;
  }
  if (sector < 0) return [];

  const levels = [{ height, sector }];
  for (const [i, lineIndex] of lines.entries()) {
    if (!buried[i]) continue;
    const own = map.sectors[map.sidedefs[map.linedefs[lineIndex].right].sector];
    if (own.ceilHeight >= height || levels.some((level) => level.height === own.ceilHeight)) continue;
    levels.push({ height: own.ceilHeight, sector: map.sidedefs[map.linedefs[lineIndex].right].sector });
  }
  return levels;
}

/** The lowest floor any of a ring's faces stands on — the ground the structure rises out of. */
function lowestFloor(map: DoomMap, lines: readonly number[]): number {
  let lowest = Infinity;
  for (const lineIndex of lines) {
    const side = map.sidedefs[map.linedefs[lineIndex].right];
    const own = side ? map.sectors[side.sector] : undefined;
    if (own && own.floorHeight < lowest) {
      lowest = own.floorHeight;
    }
  }
  return lowest;
}

/**
 * The linedef a cap at `height` takes its texture phase from: the cap sits level with the wall it
 * closes, so the side wearing `texture` whose own ceiling is nearest that height. -1 where none
 * wears it.
 */
function phaseLine(map: DoomMap, lines: readonly number[], texture: string, height: number): number {
  let line = -1;
  let nearest = Infinity;
  for (const lineIndex of lines) {
    const side = map.sidedefs[map.linedefs[lineIndex].right];
    if (!side || side.middle !== texture) continue;
    const own = map.sectors[side.sector];
    if (!own || Math.abs(own.ceilHeight - height) >= nearest) continue;
    nearest = Math.abs(own.ceilHeight - height);
    line = lineIndex;
  }
  return line;
}

/**
 * The sector a cap at `height` is lit by. Both steps below run over the ring's faces that are
 * **level with** the cap — the wall tops it closes — and never over the one that happened to set
 * the height, which is an artefact of the trace order. First the light most of that perimeter
 * carries; then the brightest face within `SHADE_STEP` of it, since a face dimmer than its fellows
 * around one structure is the shade that structure casts on the floor at its own foot.
 * docs/render-solids.md.
 */
function litFace(map: DoomMap, lines: readonly number[], height: number, fallback: number): number {
  const faces: LitFace[] = [];
  for (const lineIndex of lines) {
    const side = map.sidedefs[map.linedefs[lineIndex].right];
    if (!side || map.sectors[side.sector]?.ceilHeight !== height) continue;
    const face = litFaceOf(map, lineIndex, side.sector);
    if (face) faces.push(face);
  }
  return litSector(faces, fallback);
}

/** A face as `litSector` weighs it: the light of the sector it fronts, over its length. */
interface LitFace {
  sector: number;
  light: number;
  length: number;
}

/** `sector`'s face along `lineIndex` for `litSector`, or null where the line is degenerate. */
function litFaceOf(map: DoomMap, lineIndex: number, sector: number): LitFace | null {
  const line = map.linedefs[lineIndex];
  const a = map.vertexes[line.v1];
  const b = map.vertexes[line.v2];
  const own = map.sectors[sector];
  if (!a || !b || !own) return null;
  return { sector, light: own.light, length: vecLength(b.x - a.x, b.y - a.y) };
}

/**
 * The light pick both `litFace` and `litOutside` end on: the light most of the faces' perimeter
 * carries (a tie going to the brighter), then the brightest face within `SHADE_STEP` of it.
 */
function litSector(faces: readonly LitFace[], fallback: number): number {
  const perimeter = new Map<number, number>();
  for (const face of faces) perimeter.set(face.light, (perimeter.get(face.light) ?? 0) + face.length);
  let mostly = -Infinity;
  let longest = 0;
  for (const [light, length] of perimeter) {
    if (length < longest || (length === longest && light <= mostly)) continue;
    longest = length;
    mostly = light;
  }
  let sector = fallback;
  let light = -Infinity;
  for (const face of faces) {
    if (face.light > mostly + SHADE_STEP || face.light <= light) continue;
    light = face.light;
    sector = face.sector;
  }
  return sector;
}

/** One solid block: the sectors it fills, the height its material reaches, and its outside faces. */
interface SolidBlock {
  /** The roomless sectors themselves, and everything sealed inside them. */
  sectors: Set<number>;
  /** Only the roomless ones, each with its neighbours — `SolidBlockCap.solid`. */
  solid: { sector: number; neighbours: number[] }[];
  /** Where the material ends: the lowest ceiling the level around it carries. */
  height: number;
  /** The linedefs around it, each with the sidedef facing the level and the sector behind that. */
  faces: { line: number; side: number; outside: number }[];
  /**
   * The faces onto what the block **stands over** — a sector whose ceiling is at or under the
   * block's floor — as linedef indexes: a ring's buried faces, for `pocketsOf`.
   */
  buried: number[];
  /**
   * The ceiling flat of what the block stands over, or undefined where it stands on a floor: the
   * surface the mapper drew for this block's underside is the one drawing of it there is.
   */
  flat?: string;
}

/** A sector with nothing between floor and ceiling — solid material, or a door shut. */
function roomless(sector: Sector | undefined): boolean {
  return sector !== undefined && sector.floorHeight >= sector.ceilHeight;
}

/**
 * Every solid block on the map (`findSolidBlocks`): the roomless sectors `solidReach` accepts,
 * grouped. Blocks that touch are one block, and a region of ordinary sectors whose whole boundary
 * is blocks is sealed inside them and belongs to the same one.
 *
 * A block may **not** carry a one-sided wall of its own: that is the doorway a door sits in, and a
 * shut door is roomless in exactly the same way as a crate is. docs/render-solids.md.
 */
function blocksOf(map: DoomMap): SolidBlock[] {
  const count = map.sectors.length;
  const neighbours: Set<number>[] = map.sectors.map(() => new Set<number>());
  const walled = new Uint8Array(count);
  for (const line of map.linedefs) {
    if (line.left === NO_SIDE || line.right === NO_SIDE) {
      const side = line.right === NO_SIDE ? line.left : line.right;
      if (side !== NO_SIDE) walled[map.sidedefs[side].sector] = 1;
      continue;
    }
    const right = map.sidedefs[line.right].sector;
    const left = map.sidedefs[line.left].sector;
    if (right === left) continue;
    neighbours[right].add(left);
    neighbours[left].add(right);
  }

  const solid = new Uint8Array(count);
  const top = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const reach = walled[i] ? null : solidReach(map, i, neighbours[i]);
    if (reach === null) continue;
    solid[i] = 1;
    top[i] = reach;
  }

  const group = singletons(count);
  for (let i = 0; i < count; i++) {
    if (!solid[i]) continue;
    for (const j of neighbours[i]) {
      if (solid[j]) join(group, i, j);
    }
  }
  for (const region of sealedRegions(map, neighbours, walled, solid)) {
    for (const i of region) join(group, region[0], i);
  }

  const blocks = new Map<number, SolidBlock>();
  for (let i = 0; i < count; i++) {
    if (!solid[i]) continue;
    const root = find(group, i);
    let block = blocks.get(root);
    if (block) block.height = Math.min(block.height, top[i]);
    else blocks.set(root, (block = { sectors: new Set(), solid: [], height: top[i], faces: [], buried: [] }));
    block.solid.push({ sector: i, neighbours: [...neighbours[i]] });
  }
  for (let i = 0; i < count; i++) {
    blocks.get(find(group, i))?.sectors.add(i);
  }
  const under = new Map<SolidBlock, Map<string, number>>();
  for (const [i, line] of map.linedefs.entries()) {
    if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
    const right = map.sidedefs[line.right].sector;
    const left = map.sidedefs[line.left].sector;
    const a = map.vertexes[line.v1];
    const b = map.vertexes[line.v2];
    for (const [own, side, outside] of [
      [right, line.left, left],
      [left, line.right, right],
    ] as const) {
      const block = blocks.get(find(group, own));
      if (!block) continue;
      if (!block.sectors.has(outside)) block.faces.push({ line: i, side, outside });
      // What the block stands over, from either side of it: a sealed sector inside it counts like
      // a nook beside it does, but another roomless sector is more of the same material and has no
      // surface to lend.
      if (!solid[own] || solid[outside] || !a || !b) continue;
      if (map.sectors[outside].ceilHeight > map.sectors[own].floorHeight) continue;
      // A sector sealed inside the block is capped with it already; only a nook beside it is a
      // pocket for `pocketsOf` to roof.
      if (!block.sectors.has(outside)) block.buried.push(i);
      const flats = under.get(block) ?? new Map<string, number>();
      const flat = map.sectors[outside].ceilTex;
      flats.set(flat, (flats.get(flat) ?? 0) + vecLength(b.x - a.x, b.y - a.y));
      under.set(block, flats);
    }
  }
  for (const block of blocks.values()) {
    block.flat = blockFlat(map, block, under.get(block));
  }
  return [...blocks.values()].filter((block) => oneLoop(map, block.faces));
}

/**
 * How high the level around a sector carries material over it — the lowest ceiling a neighbour
 * raises above the sector's own, for the reason `lidLevels` takes the lowest of a ring's — or null
 * where no neighbour reaches over it at all.
 *
 * The **sky** carries no material, and the height a mapper gave an outdoor ceiling is arbitrary:
 * Sunder MAP19's courtyard is 10,240, and capping its wall stubs there hangs planes 9,216 units
 * over the level. docs/render-solids.md § Blocks built out of a sector.
 */
function materialReach(map: DoomMap, index: number, neighbours: Iterable<number>): number | null {
  const sector = map.sectors[index];
  if (!sector) return null;
  let reach = Infinity;
  for (const j of neighbours) {
    const other = map.sectors[j];
    if (!other || other.ceilTex === SKY_FLAT) continue;
    if (other.ceilHeight > sector.ceilHeight) reach = Math.min(reach, other.ceilHeight);
  }
  return reach === Infinity ? null : reach;
}

/**
 * Whether a sector is a block at all, and how high its material reaches: `materialReach`, plus a
 * sector with no room in it standing **above the ground beside it**. A shut door and the solid
 * filler a mapper leaves between rooms are roomless in exactly the way a crate is, and both are
 * level with the floor they sit in.
 *
 * Asked at **load** only (`blocksOf`). Once a block has been picked out, what keeps its cap is the
 * material over it and nothing else — `blockCapHeight`.
 */
function solidReach(map: DoomMap, index: number, neighbours: Iterable<number>): number | null {
  const sector = map.sectors[index];
  if (!sector || !roomless(sector)) return null;
  let ground = Infinity;
  for (const j of neighbours) {
    const other = map.sectors[j];
    if (other) ground = Math.min(ground, other.floorHeight);
  }
  return sector.floorHeight <= ground ? null : materialReach(map, index, neighbours);
}

/**
 * Whether a block's outside is a **single** loop. More than one, and it runs around something that
 * is not part of it — the level's own wall mass, drawn as one roomless sector, which wraps every
 * room on the map (GoingDown.wad MAP26's sector 257, 156 leaves over 2,976 x 2,560 units). Capping
 * that fills the map's walls in, which is not what a block is. The ring tracer answers the same
 * question with `enclosesFloor`. docs/render-solids.md.
 */
function oneLoop(map: DoomMap, faces: readonly { line: number }[]): boolean {
  if (faces.length === 0) return false;
  const group = singletons(map.vertexes.length);
  for (const face of faces) {
    const line = map.linedefs[face.line];
    join(group, line.v1, line.v2);
  }
  const first = find(group, map.linedefs[faces[0].line].v1);
  return faces.every((face) => find(group, map.linedefs[face.line].v1) === first);
}

/**
 * The ceiling flat a block's cap wears, or undefined for the ring's wall texture. First the flat of
 * what the block **stands over** (`under`, by shared perimeter): the mapper drew this block's
 * underside there, and it is the one drawing of it the map has — GoingDown.wad MAP08's block at
 * (548, -100) stands over two crate nooks and is `CRATOP2`, a crate top, where its own ceiling is
 * `RROCK14`, the warehouse ceiling that would land as rock across a crate. Failing that its own
 * ceiling, which nothing in the level can look at and is right far more often than a wall texture
 * laid flat: MAP09's rock pedestals are `RROCK10` like everything around them, where the wall
 * texture is `WOOD5` planks stretched over an octagon. docs/render-solids.md.
 */
function blockFlat(map: DoomMap, block: SolidBlock, under: ReadonlyMap<string, number> | undefined): string | undefined {
  const over = under && mostCounted(under);
  if (over !== undefined) return over;
  const own = new Set<string>();
  for (const i of block.sectors) {
    if (roomless(map.sectors[i])) own.add(map.sectors[i].ceilTex);
  }
  return own.size === 1 ? [...own][0] : undefined;
}

/**
 * The regions of ordinary sectors that are sealed inside solid blocks: every neighbour a block
 * standing **over** them, and no wall of their own. A light well cut into a crate is one, and so is
 * the ring of sectors a mapper nests inside it to grade the light. Returned with the blocks around
 * each, so the caller can make them one structure.
 */
function sealedRegions(
  map: DoomMap,
  neighbours: readonly Set<number>[],
  walled: Uint8Array,
  solid: Uint8Array,
): number[][] {
  const seen = new Uint8Array(map.sectors.length);
  const regions: number[][] = [];
  for (let start = 0; start < map.sectors.length; start++) {
    if (seen[start] || solid[start]) continue;
    const region = [start];
    const bounding: number[] = [];
    seen[start] = 1;
    let sealed = true;
    let underside = Infinity;
    for (let at = 0; at < region.length; at++) {
      const i = region[at];
      if (walled[i] || neighbours[i].size === 0) {
        sealed = false;
      }
      for (const j of neighbours[i]) {
        if (solid[j]) {
          bounding.push(j);
          underside = Math.min(underside, map.sectors[j].floorHeight);
          continue;
        }
        if (!seen[j]) {
          seen[j] = 1;
          region.push(j);
        }
      }
    }
    // Enclosed is not sealed: the blocks around the region have to stand **over** all of it, their
    // lowest floor at or above every ceiling in it, or block and region are the same space and the
    // block is a wall around a room rather than a lid on one. Asked of the whole region and not
    // only of the sectors that touch a block, since one nested inside another inherits nothing:
    // Sunder MAP07's sector 13 rims a chamber whose ceilings step up to 176, well over the 128 the
    // ring stands at. docs/render-solids.md § Blocks built out of a sector.
    if (region.some((i) => map.sectors[i].ceilHeight > underside)) {
      sealed = false;
    }
    if (sealed && bounding.length > 0) {
      regions.push([...region, ...bounding]);
    }
  }
  return regions;
}

/** Union-find over dense indexes — a block's sectors in `blocksOf`, its vertexes in `oneLoop`. */
function singletons(count: number): Int32Array {
  const group = new Int32Array(count);
  for (let i = 0; i < count; i++) group[i] = i;
  return group;
}

function find(group: Int32Array, i: number): number {
  let root = i;
  while (group[root] !== root) root = group[root];
  for (let at = i; group[at] !== root; ) {
    const next = group[at];
    group[at] = root;
    at = next;
  }
  return root;
}

function join(group: Int32Array, a: number, b: number): void {
  const rootA = find(group, a);
  const rootB = find(group, b);
  if (rootA !== rootB) group[rootB] = rootA;
}

/**
 * The wall texture a block's cap falls back on, and the linedef it takes that texture's row from:
 * the upper the level around it wears where it meets the block's top, which is the face the cap
 * sits level with. A block whose neighbours left theirs blank comes back with no name, and the cap
 * is then drawn on the block's own ceiling flat or not at all (`capArt`).
 */
function blockTexture(map: DoomMap, block: SolidBlock): { name: string; line: number } {
  const textures = new Map<string, number>();
  for (const face of block.faces) {
    if (map.sectors[face.outside]?.ceilHeight !== block.height) continue;
    const side = map.sidedefs[face.side];
    if (!side || !isTextured(side.upper)) continue;
    textures.set(side.upper, (textures.get(side.upper) ?? 0) + 1);
  }
  const name = mostCounted(textures) ?? '';
  // `capTextureOrigin` reads the linedef's *right* side, so a face the level meets from there is
  // the one that lends the peg run its own wall is drawn with.
  let line = block.faces[0].line;
  for (const face of block.faces) {
    if (map.linedefs[face.line].right !== face.side || map.sidedefs[face.side]?.upper !== name) continue;
    line = face.line;
    break;
  }
  return { name, line };
}

/**
 * The sector a block's cap is lit by, on `litFace`'s rule and for its reasons: the light most of
 * the level around the block carries where it meets the block's top, lifted to a brighter one
 * beside it. docs/render-solids.md.
 */
function litOutside(map: DoomMap, block: SolidBlock): number {
  const faces: LitFace[] = [];
  for (const face of block.faces) {
    if (map.sectors[face.outside]?.ceilHeight !== block.height) continue;
    const lit = litFaceOf(map, face.line, face.outside);
    if (lit) faces.push(lit);
  }
  return litSector(faces, faces[0]?.sector ?? block.faces[0].outside);
}

/** The key most of `counts` fell on — the texture most of a structure's faces wear — or undefined for none. */
function mostCounted(counts: ReadonlyMap<string, number>): string | undefined {
  let best: string | undefined;
  let most = 0;
  for (const [key, count] of counts) {
    if (count > most) {
      most = count;
      best = key;
    }
  }
  return best;
}

/**
 * Which of a ring's faces are **not** its top: a wall whose ceiling is at or under the floor its
 * neighbour along the ring stands on is a level the structure passes through — a crate beside a
 * step, whose low face stops where the step's floor begins. Letting one of those set the height
 * sinks the lid inside the structure and opens the box the lid exists to close.
 *
 * A face onto a sector with **nothing between floor and ceiling** is never one of them: a shut door
 * or the solid filler a mapper leaves between rooms is not a level anything stands on, and its
 * ceiling meets the test against any neighbour at all. docs/render-solids.md.
 */
function buriedFaces(map: DoomMap, lines: readonly number[]): boolean[] {
  const fronts = lines.map((lineIndex) => {
    const side = map.sidedefs[map.linedefs[lineIndex].right];
    return side ? map.sectors[side.sector] : undefined;
  });
  const n = lines.length;
  const meets = fronts.map((own, i) => {
    if (!own || roomless(own)) return false;
    const before = fronts[(i + n - 1) % n]?.floorHeight ?? -Infinity;
    const after = fronts[(i + 1) % n]?.floorHeight ?? -Infinity;
    return own.ceilHeight <= Math.max(before, after);
  });

  // A run of faces sharing a front sector is one wall the mapper split, and it stands in one level;
  // where any of it meets the level beside it, all of it is inside that level. Without this a
  // segment the run's ends shield sets the lid and sinks it — GoingDown.wad MAP08's crate at
  // (-397, 4), three faces onto the nook it stands in, lidded at 64 rather than at the 128 its
  // wooden upper half reaches, and the crate at (-28, -148), whose nook then stayed a hole.
  const sectorOf = lines.map((lineIndex) => map.sidedefs[map.linedefs[lineIndex].right]?.sector ?? -1);
  const buried = meets.slice();
  for (let i = 0; i < n; i++) {
    if (!meets[i] || sectorOf[i] < 0) continue;
    for (const step of [1, n - 1]) {
      for (let k = (i + step) % n; sectorOf[k] === sectorOf[i] && !buried[k]; k = (k + step) % n) {
        buried[k] = true;
      }
    }
  }
  return buried;
}

/**
 * Whether any of the map's *floor* lies inside the ring, which makes it a building's outer wall
 * rather than a solid block. The question goes to the subsectors and not to the raw vertexes —
 * docs/render-solids.md. A subsector is convex, so the mean of its points is inside it.
 */
function enclosesFloor(polys: readonly SectorPoly[], points: Float64Array, bounds: PolygonBounds): boolean {
  const { minX, minY, maxX, maxY } = bounds;
  for (const poly of polys) {
    if (poly.points.length < 6) continue;
    const { x: cx, y: cy } = polygonCentroid(poly.points);
    if (cx <= minX || cx >= maxX || cy <= minY || cy >= maxY) continue;
    if (pointInPolygon(points, cx, cy)) return true;
  }
  return false;
}

/**
 * A point `PROBE_DISTANCE` off the front (right) side of every edge, in ring order — the side that
 * edge's sector is on. Probed off the linedef's own direction, not the ring traversal's, since it
 * is the linedef that decides which side its sidedef faces. A degenerate edge yields `NaN`.
 */
function probesAround(map: DoomMap, lines: readonly number[]): Float64Array {
  const out = new Float64Array(lines.length * 2);
  for (const [i, lineIndex] of lines.entries()) probeOff(map, lineIndex, 1, out, i);
  return out;
}

/**
 * Probe `at` of `out`: the point `PROBE_DISTANCE` off a linedef's midpoint on its right side, or
 * its left for `sign` -1 — `NaN` for a degenerate line.
 */
function probeOff(map: DoomMap, lineIndex: number, sign: 1 | -1, out: Float64Array, at: number): void {
  const line = map.linedefs[lineIndex];
  const a = map.vertexes[line.v1];
  const b = map.vertexes[line.v2];
  const length = a && b ? vecLength(b.x - a.x, b.y - a.y) : 0;
  if (length < 1e-6) {
    out[at * 2] = NaN;
    out[at * 2 + 1] = NaN;
    return;
  }
  out[at * 2] = (a.x + b.x) / 2 + ((sign * (b.y - a.y)) / length) * PROBE_DISTANCE;
  out[at * 2 + 1] = (a.y + b.y) / 2 - ((sign * (b.x - a.x)) / length) * PROBE_DISTANCE;
}

/**
 * The probe off the ring's **longest** edge — the one the "is the sector inside this ring?" test
 * asks, since the longest edge is the least likely to be a stub whose side says something else.
 */
function longestEdgeProbe(map: DoomMap, lines: readonly number[], probes: Float64Array): { x: number; y: number } | null {
  let best = -1;
  let bestLength = 0;
  for (const [i, lineIndex] of lines.entries()) {
    if (Number.isNaN(probes[i * 2])) continue;
    const line = map.linedefs[lineIndex];
    const a = map.vertexes[line.v1];
    const b = map.vertexes[line.v2];
    const length = vecLength(b.x - a.x, b.y - a.y);
    if (length <= bestLength) continue;
    bestLength = length;
    best = i;
  }
  return best < 0 ? null : { x: probes[best * 2], y: probes[best * 2 + 1] };
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
