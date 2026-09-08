/**
 * The thing layer's spatial index: living bodies and raisable corpses bucketed into a uniform cell
 * grid, rebuilt once per frame, so monster-vs-monster collision, splash queries, monster hitscans
 * and the arch-vile's corpse search never walk the whole `posed` array.
 *
 * Every shape in here exists because the obvious version measured too slow.
 * **Don't simplify any of it without measuring** — docs/monster-ai.md § Spatial indexing.
 */
import { MAX_MOMENTUM_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS } from '../player.ts';
import { MONSTER_DEATH_FRAME_SECONDS } from './tables.ts';
import { chaseStep, type RaiseCandidate } from '../monsters/defs.ts';
import { FAST_MONSTER_STATS, MONSTER_STATS } from '../monsters/tables.ts';
import { makeCollider, type ThingBlocker, type World } from '../world.ts';
import { type PosedThing } from './defs.ts';
import type { Pos2, Pos3 } from '../../types.ts';
import { DOOM_TIC } from '../../constants.ts';

/**
 * How far around the *player* to look for bodies they could bump into (`solidBodies`). A fixed
 * worst case is fine here: it must clear two spider masterminds with room for a frame's movement,
 * and it is paid once per frame for one body. `blockersFor` deliberately does **not** use it —
 * docs/monster-ai.md § Spatial indexing.
 */
const BLOCKER_SEARCH_RADIUS = 320;

/**
 * Cell size of the monster lookup grid (`blockerGrid`), deliberately much smaller than the
 * worst-case search box: the box is sized *per monster*, so small cells are what let an ordinary
 * 20-unit monster scan a handful of candidates. docs/monster-ai.md § Spatial indexing.
 */
const BLOCKER_GRID_CELL = 128;

/**
 * One ray sweep for `ThingGrid.forEachMonsterAlongRay` — six numbers no positional list keeps
 * straight (docs/conventions.md § Named arguments).
 */
export interface RayQuery {
  /**
   * Where the ray starts. A point object, not the `x`/`y` scalars the box queries take: this
   * signature allocates either way, so the exception those rely on buys nothing here. The sweep is
   * flat, so only `x`/`y` are read — a caller's `Pos3` is assignable as it stands.
   */
  from: Pos2;
  /** Unit direction. */
  dirX: number;
  dirY: number;
  /** How far along the ray to sweep. */
  maxDist: number;
  /** How far off the ray a body can still be struck — the caller's widest possible hit radius. */
  clearance: number;
  /**
   * How far past a body's own radius the caller still counts a hit — 0 for a bullet, a missile's
   * radius for its step. What the per-cell skip adds to a cell's widest body; `clearance` sizes
   * the sweep and stays as wide as it is. docs/monster-ai.md § Spatial indexing.
   */
  ownReach: number;
}

/** The queries `createThingGrid` hands back — see each method's own doc. */
export interface ThingGrid {
  /**
   * Re-buckets every thing from its current position. Called once per `ThingLayer.update`, ahead
   * of any query below, so a cell's contents are up to one frame stale — which `BLOCKER_MARGIN`
   * covers for the cell box, and each body's own `PosedThing.moveBound` for the per-body tests:
   * its chase step, a lost soul's charge, and a knockback tic only while it carries momentum or
   * `mayCarry` says a conveyor could hand it some this tic. docs/monster-ai.md § Spatial indexing.
   */
  rebuild(mayCarry: boolean): void;
  /**
   * A live body about to be moved further than any `moveBound` covers — a teleport — so the cell
   * it was filed in can no longer be skipped past it. Call before the move.
   */
  markDisplaced(p: PosedThing): void;
  /**
   * Largest collision radius currently in the grid. Callers that test each candidate against *its
   * own* radius size their search box with this rather than with the biggest monster in the game —
   * docs/monster-ai.md § Spatial indexing.
   */
  maxBodyRadius(): number;
  /**
   * Every living body in the grid cells covering `radius` around (x, y), skipping any cell whose
   * bodies lie further than `ownReach` past their own radius from the point — `ownReach` being
   * how far beyond a body's radius the caller's own test still accepts it.
   */
  forEachMonsterNear(x: number, y: number, radius: number, ownReach: number, visit: (p: PosedThing) => void): void;
  forEachMonsterAlongRay(ray: RayQuery, visit: (p: PosedThing) => void): void;
  /**
   * The solid bodies within `probeReach` of `p`'s own reach — how far from `p`, per axis, the
   * caller will probe with the list. A body further than `p`'s radius plus its own plus that
   * cannot touch any probe, so it is left out without changing a verdict.
   */
  blockersFor(p: PosedThing, player: Pos3 | null, probeReach: number): readonly ThingBlocker[];
  findRaisableCorpse(x: number, y: number, vileRadius: number): RaiseCandidate | null;
  solidBodies(pos: Pos2): ThingBlocker[];
}

/**
 * Builds the index over a level's live `posed` array. The array is held by reference and re-read
 * on every `rebuild`, so a thing spawned after load — a drop, a lost soul, the Icon's cube
 * monsters — is picked up with no extra bookkeeping.
 */
export function createThingGrid(world: World, posed: PosedThing[]): ThingGrid {
  // Taken off `World`, never passed beside it — docs/conventions.md § Named arguments.
  const map = world.map;
  // Per grid, not per module: a DEHACKED patch may have rewritten the stat tables since import.
  const BLOCKER_MARGIN = blockerMargin();

  /** The grid's origin, read per cell by the gap arithmetic below. */
  const gridMinX = map.bounds.minX;
  const gridMinY = map.bounds.minY;
  /** The cell grid both bucket arrays below are indexed by, sized to the map's own bounds. */
  const blockerCols = Math.max(1, Math.ceil((map.bounds.maxX - map.bounds.minX) / BLOCKER_GRID_CELL) + 1);
  const blockerRows = Math.max(1, Math.ceil((map.bounds.maxY - map.bounds.minY) / BLOCKER_GRID_CELL) + 1);
  /**
   * The solid bodies filed by `BLOCKER_GRID_CELL` cell, in `posed` order — vanilla's blockmap,
   * for vanilla's reason. A counting sort over `posed` each rebuild: cell `i`'s bodies are the
   * slots `cellStart[i]..cellStart[i + 1]`, `slotThing` the body in each and `slotX`/`slotY`
   * where it stood at the rebuild, laid out contiguously so a query's first refusal reads no body
   * at all. docs/monster-ai.md § Spatial indexing has what it admits beyond monsters.
   */
  const cellStart = new Int32Array(blockerCols * blockerRows + 1);
  /** Each cell's body count while sorting, then its fill cursor. */
  const cellCount = new Int32Array(blockerCols * blockerRows);
  let slotX = new Float64Array(0);
  let slotY = new Float64Array(0);
  /**
   * Each slot's `PosedThing.moveBound`, beside its position for the same read — `Infinity` once
   * `markDisplaced` reports a teleport, the one move no bound covers.
   */
  let slotSlack = new Float32Array(0);
  const slotThing: PosedThing[] = [];
  /**
   * The widest body in each cell, 0 for an empty one, so a query skips a cell nothing in it
   * could reach from — and tells an empty cell by one read.
   * docs/monster-ai.md § Spatial indexing.
   */
  const cellMaxRadius = new Float32Array(blockerCols * blockerRows);
  /** The largest `slotSlack` in each cell, what a cell skip allows for. */
  const cellMaxSlack = new Float32Array(blockerCols * blockerRows);

  /**
   * Raisable corpses in the same cell grid, filled in the same `posed` pass. Backs
   * `findRaisableCorpse`, deliberately not a linear scan however rare arch-viles seem —
   * docs/monster-ai.md § Spatial indexing has the map that disproves it.
   */
  const corpseGrid: PosedThing[][] = new Array(blockerCols * blockerRows);
  /** Cells with anything in them, so a rebuild clears only those instead of the whole grid. */
  const corpseDirty: number[] = [];
  /** Largest corpse radius in `corpseGrid`, sizing `findRaisableCorpse`'s box. */
  let maxCorpseRadius = 0;
  /** Bumped per `forEachMonsterAlongRay` call; see `PosedThing.queryStamp`. */
  let monsterQueryStamp = 0;
  /** Largest radius in `blockerGrid`, sizing `blockersFor`'s box to what this map contains. */
  let maxBlockerRadius = PLAYER_RADIUS;

  /**
   * Reused storage for `blockersFor`'s result: `blockerPool` owns the objects and only grows,
   * `blockerScratch` is refilled with references, so a steady-state frame allocates nothing.
   *
   * **The tradeoff: the result is valid only until the next call** — hence `readonly`, and hence
   * its one caller consuming it synchronously. `solidBodies` deliberately does *not* share this.
   * docs/monster-ai.md § Spatial indexing.
   */
  const blockerPool: ThingBlocker[] = [];
  const blockerScratch: ThingBlocker[] = [];

  /**
   * The collider `findRaisableCorpse` probes each candidate with, refilled rather than rebuilt:
   * it sits inside that search's cell loop. See `makeCollider`.
   */
  const corpseCollider = makeCollider({ radius: 0, z: 0, height: 0, forMonster: true });

  function rebuild(mayCarry: boolean): void {
    cellCount.fill(0);
    cellMaxRadius.fill(0);
    // Every bound is rewritten below, so a teleport's `Infinity` needs no clearing of its own.
    cellMaxSlack.fill(0);
    maxBlockerRadius = PLAYER_RADIUS;
    for (const i of corpseDirty) corpseGrid[i].length = 0;
    corpseDirty.length = 0;
    maxCorpseRadius = 0;
    let n = 0;
    for (const p of posed) {
      if (p.dead) {
        // A hidden corpse (`MONSTER_CORPSE_VANISHES`) is simply not there to raise, matching
        // `P_RemoveMobj`.
        if (!p.raiseFrames || p.hidden) continue;
        if (p.blockRadius > maxCorpseRadius) maxCorpseRadius = p.blockRadius;
        const i = blockerRow(p.y) * blockerCols + blockerCol(p.x);
        let cell = corpseGrid[i];
        if (!cell) corpseGrid[i] = cell = [];
        if (cell.length === 0) corpseDirty.push(i);
        cell.push(p);
        continue;
      }
      // A living barrel, and any `SOLID_DECORATION_TYPES` prop, is exactly as
      // solid as a monster — vanilla's own MF_SOLID — so both join the same
      // grid: they block the player (`solidBodies`) and a monster's own
      // movement (`blockersFor`) for free through the machinery already built
      // for monsters. Unlike the barrel, a plain decoration isn't
      // `MF_SHOOTABLE` — `raycastMonster`/`monstersNear` explicitly filter
      // `SOLID_DECORATION_TYPES` back out, so it still doesn't stop a shot.
      if (!p.isSolid) continue;
      if (p.blockRadius > maxBlockerRadius) maxBlockerRadius = p.blockRadius;
      const i = blockerRow(p.y) * blockerCols + blockerCol(p.x);
      p.gridCell = i;
      cellCount[i]++;
      if (p.blockRadius > cellMaxRadius[i]) cellMaxRadius[i] = p.blockRadius;
      const bound = moveBoundOf(p, mayCarry);
      p.moveBound = bound;
      if (bound > cellMaxSlack[i]) cellMaxSlack[i] = bound;
      n++;
    }
    if (slotX.length < n) {
      const capacity = Math.max(n, slotX.length * 2);
      slotX = new Float64Array(capacity);
      slotY = new Float64Array(capacity);
      slotSlack = new Float32Array(capacity);
    }
    slotThing.length = n;
    let filled = 0;
    for (let i = 0; i < cellCount.length; i++) {
      cellStart[i] = filled;
      filled += cellCount[i];
      cellCount[i] = cellStart[i];
    }
    cellStart[cellCount.length] = filled;
    // The second pass files each body at its cell's cursor, which keeps `posed` order within a
    // cell — the order every list a query hands out is read in.
    for (const p of posed) {
      if (p.dead || !p.isSolid) continue;
      const k = cellCount[p.gridCell]++;
      p.gridSlot = k;
      slotX[k] = p.x;
      slotY[k] = p.y;
      slotSlack[k] = p.moveBound;
      slotThing[k] = p;
    }
  }

  function maxBodyRadius(): number {
    return maxBlockerRadius;
  }

  function markDisplaced(p: PosedThing): void {
    // A teleport is just a move no bound covers, so it is filed as an unbounded one: every test
    // below already admits a body whose slack reaches the query, and `Infinity` reaches every
    // query. The guard is for a body the last `rebuild` never filed — dead, or not solid.
    const k = p.gridSlot;
    if (k < 0 || slotThing[k] !== p) return;
    slotSlack[k] = Infinity;
    cellMaxSlack[p.gridCell] = Infinity;
  }

  /**
   * Every living monster in the grid cells covering `radius` around (x, y). Narrows the
   * candidates only — the caller still applies its own exact distance test. Padded by
   * `BLOCKER_MARGIN`, since the grid buckets each monster by where it stood at rebuild time.
   */
  function forEachMonsterNear(x: number, y: number, radius: number, ownReach: number, visit: (p: PosedThing) => void): void {
    const reach = radius + BLOCKER_MARGIN;
    const c0 = blockerCol(x - reach);
    const c1 = blockerCol(x + reach);
    const r0 = blockerRow(y - reach);
    const r1 = blockerRow(y + reach);
    // `gapX` is the same for a whole column, so the cell's west edge is walked rather than
    // recomputed per cell — as in `blockersFor`.
    const cellX0 = gridMinX + c0 * BLOCKER_GRID_CELL;
    for (let gy = r0; gy <= r1; gy++) {
      const rowBase = gy * blockerCols;
      const gapY = cellGap(y, gridMinY, gy);
      let cellX = cellX0;
      for (let gx = c0; gx <= c1; gx++, cellX += BLOCKER_GRID_CELL) {
        const i = rowBase + gx;
        const widest = cellMaxRadius[i];
        if (widest === 0) continue;
        const coarse = ownReach + widest;
        const gapX = edgeGap(x, cellX);
        if (cellSkipped(gapX, gapY, coarse + cellMaxSlack[i])) continue;
        // The same refusal per body, off where it stood at the rebuild and its own move bound —
        // `Infinity` for one that teleported, which no bound covers.
        const end = cellStart[i + 1];
        for (let k = cellStart[i]; k < end; k++) {
          const limit = coarse + slotSlack[k];
          if (Math.abs(slotX[k] - x) > limit || Math.abs(slotY[k] - y) > limit) continue;
          visit(slotThing[k]);
        }
      }
    }
  }

  /**
   * Every living monster in or beside the cells a ray passes through, each visited at most once.
   * Deliberately simpler than `forEachLineAlongSegment`'s exact DDA — half-cell steps with a
   * square cell sweep each, conservative by a wide margin — and stamped rather than `Set`-deduped.
   * docs/monster-ai.md § Spatial indexing.
   */
  function forEachMonsterAlongRay(ray: RayQuery, visit: (p: PosedThing) => void): void {
    const { from, dirX, dirY, maxDist, clearance, ownReach } = ray;
    const { x, y } = from;
    const stamp = ++monsterQueryStamp;
    const stride = BLOCKER_GRID_CELL / 2;
    const steps = Math.ceil(maxDist / stride);
    const halo = Math.max(1, Math.ceil((clearance + BLOCKER_MARGIN) / BLOCKER_GRID_CELL));
    // Every ray point lies within half a stride of some sample, so a cell further from the sample
    // than that plus what its widest body reaches holds nothing the ray could strike.
    const sampleReach = stride / 2 + ownReach;
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(s * stride, maxDist);
      const px = x + dirX * t;
      const py = y + dirY * t;
      const cx = blockerCol(px);
      const cy = blockerRow(py);
      for (let gy = cy - halo; gy <= cy + halo; gy++) {
        if (gy < 0 || gy >= blockerRows) continue;
        const rowBase = gy * blockerCols;
        const gapY = cellGap(py, gridMinY, gy);
        for (let gx = cx - halo; gx <= cx + halo; gx++) {
          if (gx < 0 || gx >= blockerCols) continue;
          const i = rowBase + gx;
          const widest = cellMaxRadius[i];
          if (widest === 0) continue;
          const gapX = cellGap(px, gridMinX, gx);
          if (cellSkipped(gapX, gapY, sampleReach + widest + cellMaxSlack[i])) continue;
          // No per-body refusal here: a body's turn in the visit order decides an exact tie
          // between two hits, and a later sample must not be the one to visit it.
          const end = cellStart[i + 1];
          for (let k = cellStart[i]; k < end; k++) {
            const p = slotThing[k];
            if (p.queryStamp === stamp) continue;
            p.queryStamp = stamp;
            visit(p);
          }
        }
      }
    }
  }

  /**
   * The solid bodies near `p` it can bump into — every other living monster, the player, and any
   * solid decoration or barrel, all `MF_SOLID`. `p` itself is excluded.
   *
   * **The returned array is reused** — see `blockerScratch`.
   *
   * The single hottest thing in monster AI, so the box is sized from the radii actually involved
   * rather than a fixed worst case (docs/monster-ai.md § Spatial indexing) and stays 2D even
   * though bodies have heights (docs/movement.md § Collision). Each blocker's `z` is read live off
   * the `PosedThing`, so a flier's current float height is what the caller compares against.
   */
  function blockersFor(p: PosedThing, player: Pos3 | null, probeReach: number): readonly ThingBlocker[] {
    blockerScratch.length = 0;
    const ownRadius = p.blockRadius;
    // `blockedByThings` only ever reports an overlap inside `r1 + r2`, so nothing further than
    // the widest summed radii plus the margin can matter, and searching further is pure waste.
    const reach = ownRadius + maxBlockerRadius + BLOCKER_MARGIN;
    // `null` once the player is dead: `P_KillMobj` clears `MF_SOLID` alongside `MF_SHOOTABLE`,
    // so a corpse is no more an obstacle than it is a target.
    if (player) {
      const playerReach = ownRadius + PLAYER_RADIUS + probeReach;
      if (Math.abs(player.x - p.x) <= playerReach && Math.abs(player.y - p.y) <= playerReach) {
        pushBlocker(player.x, player.y, player.z, PLAYER_RADIUS, PLAYER_HEIGHT);
      }
    }
    const c0 = blockerCol(p.x - reach);
    const c1 = blockerCol(p.x + reach);
    const r0 = blockerRow(p.y - reach);
    const r1 = blockerRow(p.y + reach);
    const cellX0 = gridMinX + c0 * BLOCKER_GRID_CELL;
    for (let gy = r0; gy <= r1; gy++) {
      const rowBase = gy * blockerCols;
      const gapY = cellGap(p.y, gridMinY, gy);
      let cellX = cellX0;
      for (let gx = c0; gx <= c1; gx++, cellX += BLOCKER_GRID_CELL) {
        const i = rowBase + gx;
        // One typed read tells an empty cell apart: every body has a radius.
        const widest = cellMaxRadius[i];
        if (widest === 0) continue;
        const gapX = edgeGap(p.x, cellX);
        // `reach` assumes the map's widest body; this cell's own widest is the real bound, and a
        // cell whose nearest edge is further than that — plus what a body in it may have moved
        // since the rebuild — holds nothing the pair test below could pass.
        // docs/monster-ai.md § Spatial indexing.
        const coarse = ownRadius + widest + probeReach;
        if (cellSkipped(gapX, gapY, coarse + cellMaxSlack[i])) continue;
        // The cell's widest body bounds every pair in it, so the first refusal reads only where
        // the candidate stood at the rebuild and its own move bound — `Infinity` for one that
        // teleported. `pushIfNear` then applies the pair's own bound to its live position.
        const end = cellStart[i + 1];
        for (let k = cellStart[i]; k < end; k++) {
          const limit = coarse + slotSlack[k];
          if (Math.abs(slotX[k] - p.x) > limit || Math.abs(slotY[k] - p.y) > limit) continue;
          pushIfNear(p, slotThing[k], ownRadius, probeReach);
        }
      }
    }
    return blockerScratch;
  }

  /**
   * The first corpse near (x, y) this arch-vile could raise, or null — `PIT_VileCheck`, and the
   * `resurrect` callback `runChaseCall` takes. Grid-accelerated the same shape as `blockersFor`;
   * which corpse wins when several qualify follows grid iteration order, as arbitrary as vanilla's
   * own blockmap order. Deliberately skips `P_CheckPosition`'s re-test against other nearby
   * things. docs/monster-archvile.md § Resurrection.
   */
  function findRaisableCorpse(x: number, y: number, vileRadius: number): RaiseCandidate | null {
    const reach = vileRadius + maxCorpseRadius + BLOCKER_MARGIN;
    const c0 = blockerCol(x - reach);
    const c1 = blockerCol(x + reach);
    const r0 = blockerRow(y - reach);
    const r1 = blockerRow(y + reach);
    for (let gy = r0; gy <= r1; gy++) {
      const rowBase = gy * blockerCols;
      for (let gx = c0; gx <= c1; gx++) {
        const cell = corpseGrid[rowBase + gx];
        if (cell === undefined || cell.length === 0) continue;
        for (const c of cell) {
          // A corpse an earlier vile already raised this frame: grid buckets are up to a frame
          // stale, `dead` is read live.
          if (!c.dead) continue;
          // "Not lying still yet" — vanilla's own `thing->tics != -1` gate.
          if (c.deadTime < c.deathFrameCount * MONSTER_DEATH_FRAME_SECONDS) continue;
          const pairReach = c.blockRadius + vileRadius;
          if (Math.abs(c.x - x) > pairReach || Math.abs(c.y - y) > pairReach) continue;
          // No room to stand back up.
          corpseCollider.radius = c.blockRadius;
          corpseCollider.z = c.z;
          corpseCollider.height = c.bodyHeight;
          if (world.positionBlocked(c.x, c.y, corpseCollider)) continue;
          return { id: c.id, x: c.x, y: c.y };
        }
      }
    }
    return null;
  }

  /**
   * Every living monster, still-standing barrel and solid decoration near `pos`, as a body the
   * *player* walks around. A plain linear scan on purpose — it runs once a frame for one body —
   * and a freshly allocated array, never `blockerScratch`. See that buffer's doc.
   */
  function solidBodies(pos: Pos2): ThingBlocker[] {
    const out: ThingBlocker[] = [];
    for (const p of posed) {
      if (p.dead || !p.isSolid) continue;
      if (Math.abs(p.x - pos.x) > BLOCKER_SEARCH_RADIUS || Math.abs(p.y - pos.y) > BLOCKER_SEARCH_RADIUS) continue;
      out.push({ x: p.x, y: p.y, z: p.z, radius: p.blockRadius, height: p.bodyHeight });
    }
    return out;
  }

  /**
   * Whether a query may leave a cell entirely unread: its nearest edge, per axis, lies further
   * from the query point than anything in it could reach. `limit` is the caller's own reach past
   * a body's radius, plus the cell's widest body (`cellMaxRadius`), plus the worst move any body
   * in it can make this tic (`cellMaxSlack`, `Infinity` once one teleported). Exactly the bodies
   * the caller's own test would refuse, so skipping changes nothing.
   * docs/monster-ai.md § Spatial indexing.
   */
  function cellSkipped(gapX: number, gapY: number, limit: number): boolean {
    return gapX > limit || gapY > limit;
  }

  /**
   * `PosedThing.moveBound` for one live solid body: its own chase step, which covers the sub-step
   * and the full-step fallback alike; a lost soul's charge; and one tic of momentum — only while
   * it has some, or a conveyor could give it some before it moves. Every in-tic mover of a live
   * body but a teleport, which `markDisplaced` covers.
   */
  function moveBoundOf(p: PosedThing, mayCarry: boolean): number {
    const stats = p.stats;
    let bound = stats ? chaseStep(stats) : 0;
    const charge = stats?.ranged?.charge;
    if (charge && charge.speed * DOOM_TIC > bound) {
      bound = charge.speed * DOOM_TIC;
    }
    if (mayCarry || p.velX !== 0 || p.velY !== 0) {
      bound = Math.max(bound, MAX_MOMENTUM_SPEED * DOOM_TIC);
    }
    return bound;
  }

  /** A coordinate's distance to the nearest edge of grid row/column `index`, 0 inside it. */
  function cellGap(v: number, gridMin: number, index: number): number {
    return edgeGap(v, gridMin + index * BLOCKER_GRID_CELL);
  }

  /** The same, for a caller walking the cell's low edge along a row rather than indexing it. */
  function edgeGap(v: number, lo: number): number {
    return v < lo ? lo - v : v > lo + BLOCKER_GRID_CELL ? v - lo - BLOCKER_GRID_CELL : 0;
  }

  /**
   * `blockersFor`'s per-candidate test: the pair's own summed radii plus the caller's probe reach,
   * on live positions. The distance goes first — it refuses most candidates, and the other two
   * reads are only paid for the few that pass.
   */
  function pushIfNear(p: PosedThing, other: PosedThing, ownRadius: number, probeReach: number): void {
    // Tighter than `reach`, which has to assume the map's largest monster and its longest step:
    // this pair's own summed radii and this caller's own step are the real bound.
    // docs/monster-ai.md § Spatial indexing.
    const pairReach = ownRadius + other.blockRadius + probeReach;
    if (Math.abs(other.x - p.x) > pairReach || Math.abs(other.y - p.y) > pairReach) return;
    // `dead` is re-checked because a monster can be killed (infighting, splash) after the grid
    // was built for this frame.
    if (other === p || other.dead) return;
    pushBlocker(other.x, other.y, other.z, other.blockRadius, other.bodyHeight);
  }

  /**
   * Grid column/row for a map coordinate, clamped so a thing outside the map's own bounds still
   * lands in a real cell.
   */
  function blockerCol(x: number): number {
    const c = Math.floor((x - map.bounds.minX) / BLOCKER_GRID_CELL);
    return c < 0 ? 0 : c >= blockerCols ? blockerCols - 1 : c;
  }

  function blockerRow(y: number): number {
    const r = Math.floor((y - map.bounds.minY) / BLOCKER_GRID_CELL);
    return r < 0 ? 0 : r >= blockerRows ? blockerRows - 1 : r;
  }

  /**
   * Writes one blocker into the pooled result. Five scalars rather than a body object
   * (docs/conventions.md § Named arguments): taking one would mean allocating the very object the
   * pool exists to avoid, and the player — which is not a `PosedThing` — goes through here too.
   */
  function pushBlocker(x: number, y: number, z: number, radius: number, height: number): void {
    const i = blockerScratch.length;
    let b = blockerPool[i];
    if (!b) blockerPool[i] = b = { x: 0, y: 0, z: 0, radius: 0, height: 0 };
    b.x = x;
    b.y = y;
    b.z = z;
    b.radius = radius;
    b.height = height;
    blockerScratch.push(b);
  }

  // Seeded once here so a lookup landing before the first `update` — a splash on the opening
  // frame, say — still finds the monsters that exist. Nothing moves before that update, so no
  // conveyor can have carried anything by then.
  rebuild(false);

  return {
    rebuild,
    markDisplaced,
    maxBodyRadius,
    forEachMonsterNear,
    forEachMonsterAlongRay,
    blockersFor,
    findRaisableCorpse,
    solidBodies,
  };
}

/**
 * Slack added to every blocker search, so narrowing it to the bodies that can actually touch can't
 * miss one: the longest probe step plus the worst one-frame grid staleness. The two maxima are
 * taken **independently and added**, never maximised as a per-type sum — docs/monster-ai.md §
 * Spatial indexing. Derived from the stat tables rather than hardcoded so it can't drift out of
 * sync with them, the nightmare table included.
 *
 * Computed per grid rather than at import, because a DEHACKED patch may have rewritten either
 * table by then (docs/dehacked.md § Applying: reset, then patch). A grid is built once per level,
 * so the reduce costs nothing.
 */
function blockerMargin(): number {
  const every = [...Object.values(MONSTER_STATS), ...Object.values(FAST_MONSTER_STATS)];
  return (
    every.reduce((max, s) => Math.max(max, chaseStep(s)), 0) +
    every.reduce((max, s) => Math.max(max, s.speed), 0) * DOOM_TIC
  );
}
