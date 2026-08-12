/**
 * The thing layer's spatial index: living bodies and raisable corpses bucketed
 * into a uniform cell grid, rebuilt once per frame, so monster-vs-monster
 * collision, splash queries, monster hitscans and the arch-vile's corpse
 * search never walk the whole `posed` array.
 *
 * Every shape in here exists because the obvious version was measured and was
 * too slow — the cell size, the per-pair reach test, the reused result buffer,
 * the stamped ray dedupe. **Don't simplify any of it without measuring.** See
 * docs/monster-ai.md § Spatial indexing.
 */
import type { DoomMap } from '../../wad/map.ts';
import { PLAYER_RADIUS } from '../player.ts';
import { MONSTER_DEATH_FRAME_SECONDS, MONSTER_TYPES, SOLID_DECORATION_TYPES } from '../thingdefs.ts';
import { FAST_MONSTER_STATS, MONSTER_STATS, type RaiseCandidate } from '../monsters/defs.ts';
import { circleBlocked, type ThingBlocker, type World } from '../world.ts';
import { type PosedThing } from './defs.ts';
import { ThingType } from '../thingtypes.ts';
import type { Pos2, Pos3 } from '../../types.ts';

/**
 * How far around the *player* to look for bodies they could bump into
 * (`solidBodies`). A fixed worst case is fine here — it must exceed the
 * largest possible contact reach (two spider masterminds, at 128 units of
 * radius each) with room to spare for a frame's movement, and it's paid once
 * per frame for one body. `blockersFor` deliberately does **not** use it: run
 * per monster per frame, a fixed box that assumes the largest monster in the
 * game is exactly the waste that made monster AI the frame's bottleneck.
 */
const BLOCKER_SEARCH_RADIUS = 320;

/**
 * Cell size of the monster lookup grid (`blockerGrid`). Deliberately much
 * smaller than the worst-case search box: the box is sized *per monster* from
 * its own radius (see `blockersFor`), so small cells are what let an ordinary
 * 20-unit-radius monster scan a handful of candidates instead of everything
 * within the largest radius any monster in the game could need.
 */
const BLOCKER_GRID_CELL = 128;

/**
 * The most simulated time one step can ever represent — `game.ts`'s fixed
 * `TIC_SECONDS`, since the simulation only ever advances a whole tic at a time.
 * Kept as its own literal rather than imported to avoid a cycle back through
 * `game.ts`, which owns the real one. docs/frameloop.md § The accumulator.
 */
const MAX_FRAME_DT = 1 / 35;

/**
 * Slack added to every blocker search so narrowing it to the bodies that can
 * actually touch can't miss one — the longest probe step (`tryWalk` reaches a
 * full `P_Move` ahead) plus the worst one-frame grid staleness. Derived from
 * `MONSTER_STATS` rather than hardcoded so it can't drift out of sync.
 *
 * Both tables feed it, so the one figure covers a nightmare level too: a fast
 * demon out-runs every ordinary monster, and a margin that only knew the
 * normal table would come up short by its extra frame of travel. The probe
 * term needs no such care — halving a monster's tics doubles its speed and
 * halves its `chaseInterval`, leaving their product exactly as it was — but it
 * costs nothing to take both the same way.
 *
 * The two maxima are taken **independently and added**, not maximised as a
 * per-type sum: the monster probing and the monster that drifted are different
 * monsters, so nothing requires them to be the same type. See
 * docs/monster-ai.md § Spatial indexing.
 */
const EVERY_STAT = [...Object.values(MONSTER_STATS), ...Object.values(FAST_MONSTER_STATS)];
const BLOCKER_MARGIN =
  EVERY_STAT.reduce((max, s) => Math.max(max, s.speed * s.chaseInterval), 0) +
  EVERY_STAT.reduce((max, s) => Math.max(max, s.speed), 0) * MAX_FRAME_DT;

/** The queries `createThingGrid` hands back — see each method's own doc. */
export interface ThingGrid {
  /**
   * Re-buckets every thing from its current position. Called once per
   * `ThingLayer.update`, ahead of any query below; a cell's contents are
   * therefore up to one frame stale, which `BLOCKER_MARGIN` covers.
   */
  rebuild(): void;
  /**
   * Largest collision radius currently in the grid. Callers that test each
   * candidate against *its own* radius (`ThingLayer.monstersAlongStep`) size
   * their search box with this rather than with the biggest monster in the
   * game — the same adaptive trick `blockersFor` uses.
   */
  maxBodyRadius(): number;
  forEachMonsterNear(x: number, y: number, radius: number, visit: (p: PosedThing) => void): void;
  forEachMonsterAlongRay(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    maxDist: number,
    clearance: number,
    visit: (p: PosedThing) => void,
  ): void;
  blockersFor(p: PosedThing, player: Pos3 | null): readonly ThingBlocker[];
  findRaisableCorpse(x: number, y: number, vileRadius: number): RaiseCandidate | null;
  solidBodies(pos: Pos2): ThingBlocker[];
}

/**
 * Builds the index over a level's live `posed` array. The array is held by
 * reference and re-read on every `rebuild`, so things spawned after load
 * (drops, lost souls, the Icon's cube monsters) are picked up with no extra
 * bookkeeping.
 */
export function createThingGrid(map: DoomMap, world: World, posed: PosedThing[]): ThingGrid {
  /**
   * Solid bodies bucketed by `BLOCKER_GRID_CELL`, rebuilt once per `update()`
   * and read by `blockersFor` below — vanilla's blockmap, for vanilla's
   * reason. What it admits beyond monsters, and why the shot queries have to
   * filter some of that back out, is docs/monster-ai.md § Spatial indexing.
   *
   * Cells hold `PosedThing`s rather than ids so `blockersFor` needs no second
   * lookup, and their arrays are emptied and refilled rather than reallocated,
   * since this runs every frame.
   */
  const blockerCols = Math.max(1, Math.ceil((map.bounds.maxX - map.bounds.minX) / BLOCKER_GRID_CELL) + 1);
  const blockerRows = Math.max(1, Math.ceil((map.bounds.maxY - map.bounds.minY) / BLOCKER_GRID_CELL) + 1);
  const blockerGrid: PosedThing[][] = new Array(blockerCols * blockerRows);
  /** Indices of the cells that actually have anything in them, so a rebuild clears only those instead of walking the whole grid. */
  const blockerDirty: number[] = [];

  /**
   * Raisable corpses bucketed into `blockerGrid`'s cell grid, filled in the
   * same `posed` pass. Backs `findRaisableCorpse`, which was a linear scan on
   * the unverified assumption that arch-viles are rare — they aren't on every
   * map, and it cost most of a frame there. docs/monster-ai.md § Spatial
   * indexing.
   */
  const corpseGrid: PosedThing[][] = new Array(blockerCols * blockerRows);
  /** Indices of the cells that actually have anything in them, so a rebuild clears only those instead of walking the whole grid. */
  const corpseDirty: number[] = [];
  /** Largest collision radius among corpses currently in `corpseGrid`, sizing `findRaisableCorpse`'s search box the same way `maxBlockerRadius` sizes `blockersFor`'s. */
  let maxCorpseRadius = 0;
  /** Bumped per `forEachMonsterAlongRay` call; see `PosedThing.queryStamp`. */
  let monsterQueryStamp = 0;
  /** Largest collision radius currently in the grid, so `blockersFor` sizes its box to what this map contains rather than to the biggest monster in the game. */
  let maxBlockerRadius = PLAYER_RADIUS;

  /** Grid column/row for a map coordinate, clamped so a thing outside the map's own bounds still lands in a real cell. */
  function blockerCol(x: number): number {
    const c = Math.floor((x - map.bounds.minX) / BLOCKER_GRID_CELL);
    return c < 0 ? 0 : c >= blockerCols ? blockerCols - 1 : c;
  }

  function blockerRow(y: number): number {
    const r = Math.floor((y - map.bounds.minY) / BLOCKER_GRID_CELL);
    return r < 0 ? 0 : r >= blockerRows ? blockerRows - 1 : r;
  }

  function rebuild(): void {
    for (const i of blockerDirty) blockerGrid[i].length = 0;
    blockerDirty.length = 0;
    maxBlockerRadius = PLAYER_RADIUS;
    for (const i of corpseDirty) corpseGrid[i].length = 0;
    corpseDirty.length = 0;
    maxCorpseRadius = 0;
    for (const p of posed) {
      if (p.dead) {
        // A hidden corpse (MONSTER_CORPSE_VANISHES — see that doc) no longer
        // exists as far as an arch-vile is concerned, matching vanilla's own
        // P_RemoveMobj: it's simply not there to raise.
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
      if (!MONSTER_TYPES.has(p.type) && p.type !== ThingType.barrel && !SOLID_DECORATION_TYPES.has(p.type)) continue;
      if (p.blockRadius > maxBlockerRadius) maxBlockerRadius = p.blockRadius;
      const i = blockerRow(p.y) * blockerCols + blockerCol(p.x);
      let cell = blockerGrid[i];
      if (!cell) blockerGrid[i] = cell = [];
      if (cell.length === 0) blockerDirty.push(i);
      cell.push(p);
    }
  }

  /**
   * Every living monster in the grid cells covering `radius` around (x, y).
   * The caller still applies its own exact distance test; this only narrows
   * the candidates. Padded by `BLOCKER_MARGIN` since the grid buckets each
   * monster by where it stood at rebuild time.
   */
  function forEachMonsterNear(x: number, y: number, radius: number, visit: (p: PosedThing) => void): void {
    const reach = radius + BLOCKER_MARGIN;
    const c0 = blockerCol(x - reach);
    const c1 = blockerCol(x + reach);
    const r0 = blockerRow(y - reach);
    const r1 = blockerRow(y + reach);
    for (let gy = r0; gy <= r1; gy++) {
      const rowBase = gy * blockerCols;
      for (let gx = c0; gx <= c1; gx++) {
        const cell = blockerGrid[rowBase + gx];
        if (cell === undefined) continue;
        for (const p of cell) visit(p);
      }
    }
  }

  /**
   * Every living monster in or beside the cells a ray passes through, each
   * visited at most once — backs `raycastMonster`, called dozens of times a
   * frame on a crowded map.
   *
   * Deliberately simpler than `forEachLineAlongSegment`'s exact DDA: half-cell
   * steps with a square cell sweep each. Half-cell steps skip no cell on the
   * path, and a sweep `n` cells either side clears a full `n ×
   * BLOCKER_GRID_CELL` units laterally, so it cannot miss a monster the exact
   * ray would hit. `clearance` is how far off the ray a body can still be
   * struck — the caller's widest possible hit radius, which is per-species and
   * so up to a spider mastermind's 163 units rather than the flat ~24 this
   * assumed while one shared hitbox covered every type. Stamped rather than
   * `Set`-deduped, since consecutive neighbourhoods overlap heavily.
   * docs/monster-ai.md § Spatial indexing.
   */
  function forEachMonsterAlongRay(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    maxDist: number,
    clearance: number,
    visit: (p: PosedThing) => void,
  ): void {
    const stamp = ++monsterQueryStamp;
    const stride = BLOCKER_GRID_CELL / 2;
    const steps = Math.ceil(maxDist / stride);
    const halo = Math.max(1, Math.ceil((clearance + BLOCKER_MARGIN) / BLOCKER_GRID_CELL));
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(s * stride, maxDist);
      const cx = blockerCol(x + dirX * t);
      const cy = blockerRow(y + dirY * t);
      for (let gy = cy - halo; gy <= cy + halo; gy++) {
        if (gy < 0 || gy >= blockerRows) continue;
        const rowBase = gy * blockerCols;
        for (let gx = cx - halo; gx <= cx + halo; gx++) {
          if (gx < 0 || gx >= blockerCols) continue;
          const cell = blockerGrid[rowBase + gx];
          if (cell === undefined) continue;
          for (const p of cell) {
            if (p.queryStamp === stamp) continue;
            p.queryStamp = stamp;
            visit(p);
          }
        }
      }
    }
  }

  /**
   * Reused storage for `blockersFor`'s result — `blockerPool` owns the objects
   * and only grows, `blockerScratch` is refilled with references, so a
   * steady-state frame allocates nothing. Allocating fresh per call profiled as
   * the majority of all monster-AI time on a crowded map (docs/monster-ai.md §
   * Spatial indexing).
   *
   * **The tradeoff: the result is valid only until the next call** — hence
   * `readonly`, and hence its one caller consuming it synchronously.
   * `solidBodies` deliberately does *not* share this: once per frame for the
   * player, a plain allocation costs nothing and an aliased buffer is a trap.
   */
  const blockerPool: ThingBlocker[] = [];
  const blockerScratch: ThingBlocker[] = [];

  function pushBlocker(x: number, y: number, radius: number): void {
    const i = blockerScratch.length;
    let b = blockerPool[i];
    if (!b) blockerPool[i] = b = { x: 0, y: 0, radius: 0 };
    b.x = x;
    b.y = y;
    b.radius = radius;
    blockerScratch.push(b);
  }

  /**
   * The solid bodies near `p` it can bump into — every other living monster,
   * the player, and any solid decoration/barrel, all `MF_SOLID` in vanilla.
   * `p` itself is excluded.
   *
   * **The returned array is reused** — see `blockerScratch`.
   *
   * The box is sized from the radii actually involved, not a fixed worst case,
   * and only the cells it covers are scanned. The single hottest thing in
   * monster AI; see docs/monster-ai.md § Spatial indexing.
   */
  function blockersFor(p: PosedThing, player: Pos3 | null): readonly ThingBlocker[] {
    blockerScratch.length = 0;
    const ownRadius = p.blockRadius;
    // `blockedByThings` only ever reports an overlap inside `r1 + r2`, so
    // nothing further than the widest possible summed radii (plus the margin)
    // can matter — searching further is pure waste, and it was: a fixed
    // 320-unit box collected ~145 candidates per monster on a map of 20-unit
    // grunts, which profiled as half of all monster-AI time.
    const reach = ownRadius + maxBlockerRadius + BLOCKER_MARGIN;
    // `null` once the player is dead — vanilla's `P_KillMobj` clears the
    // player's `MF_SOLID` right alongside `MF_SHOOTABLE`, so a corpse is no
    // more an obstacle than it is a target.
    if (player) {
      const playerReach = ownRadius + PLAYER_RADIUS + BLOCKER_MARGIN;
      if (Math.abs(player.x - p.x) <= playerReach && Math.abs(player.y - p.y) <= playerReach) {
        pushBlocker(player.x, player.y, PLAYER_RADIUS);
      }
    }
    const c0 = blockerCol(p.x - reach);
    const c1 = blockerCol(p.x + reach);
    const r0 = blockerRow(p.y - reach);
    const r1 = blockerRow(p.y + reach);
    for (let gy = r0; gy <= r1; gy++) {
      const rowBase = gy * blockerCols;
      for (let gx = c0; gx <= c1; gx++) {
        const cell = blockerGrid[rowBase + gx];
        if (cell === undefined || cell.length === 0) continue;
        for (const other of cell) {
          // `dead` is re-checked because a monster can be killed (infighting,
          // splash) after the grid was built for this frame.
          if (other === p || other.dead) continue;
          // Tighter than `reach`, which has to assume the map's largest
          // monster: this pair's own summed radii is the real bound. That
          // matters on a map like NUTS.WAD, where 795 spider masterminds
          // (radius 128) would otherwise widen every 20-unit grunt's box too.
          const pairReach = ownRadius + other.blockRadius + BLOCKER_MARGIN;
          if (Math.abs(other.x - p.x) > pairReach || Math.abs(other.y - p.y) > pairReach) continue;
          pushBlocker(other.x, other.y, other.blockRadius);
        }
      }
    }
    return blockerScratch;
  }

  /**
   * Vanilla's `PIT_VileCheck`, the `resurrect` callback `runChaseCall` takes:
   * the first corpse near (x, y) this arch-vile could raise, or null.
   * Grid-accelerated the same shape as `blockersFor` — box, cells, exact
   * per-pair test. Which corpse wins when several qualify follows grid
   * iteration order, as arbitrary as vanilla's own blockmap order.
   *
   * Skips vanilla's `P_CheckPosition` re-test against other nearby things (the
   * corpse height-quadrupling trick) — raises are rare enough that reusing
   * `blockersFor`'s per-caller machinery here wasn't worth the coupling.
   * docs/monster-archvile.md.
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
          // A corpse this same frame's earlier vile already resurrected —
          // grid buckets are up to a frame stale, `dead` is read live.
          if (!c.dead) continue;
          // "Not lying still yet" — vanilla's own `thing->tics != -1` gate.
          if (c.deadTime < c.deathFrameCount * MONSTER_DEATH_FRAME_SECONDS) continue;
          const pairReach = c.blockRadius + vileRadius;
          if (Math.abs(c.x - x) > pairReach || Math.abs(c.y - y) > pairReach) continue;
          if (circleBlocked(world, c.x, c.y, c.blockRadius, c.z, true)) continue; // no room to stand back up
          return { id: c.id, x: c.x, y: c.y };
        }
      }
    }
    return null;
  }

  /**
   * Every living monster, still-standing barrel and solid decoration near
   * `pos` as a body the *player* walks around. A plain linear scan on purpose:
   * it runs once a frame for one body, and a fixed `BLOCKER_SEARCH_RADIUS` box
   * over `posed` is simpler than a grid query for a caller that isn't hot.
   * A freshly allocated array, never `blockerScratch` — see that buffer's doc.
   */
  function solidBodies(pos: Pos2): ThingBlocker[] {
    const out: ThingBlocker[] = [];
    for (const p of posed) {
      if (p.dead || (!MONSTER_TYPES.has(p.type) && p.type !== ThingType.barrel && !SOLID_DECORATION_TYPES.has(p.type))) continue;
      if (Math.abs(p.x - pos.x) > BLOCKER_SEARCH_RADIUS || Math.abs(p.y - pos.y) > BLOCKER_SEARCH_RADIUS) continue;
      out.push({ x: p.x, y: p.y, radius: p.blockRadius });
    }
    return out;
  }

  // Seeded once here so a lookup that lands before the first `update` (a
  // splash on the opening frame, say) still finds the monsters that exist.
  rebuild();

  return {
    rebuild,
    maxBodyRadius: () => maxBlockerRadius,
    forEachMonsterNear,
    forEachMonsterAlongRay,
    blockersFor,
    findRaisableCorpse,
    solidBodies,
  };
}
