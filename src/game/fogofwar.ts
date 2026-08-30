/**
 * Fog of war: hides the parts of the level the player hasn't seen yet, revealing per subsector,
 * sticky on sight. See docs/fogofwar.md.
 */
import { buildSubSectorPolys } from '../render/bsp.ts';
import { polygonCentroid, segmentCrossT } from '../util/geom.ts';
import { dampen } from '../util/damping.ts';
import { decodeRuns, encodeRuns } from './snapshot.ts';
import { scanSectors } from './specials/mapscan.ts';
import { VIEW_DISTANCE } from '../constants.ts';
import type { Pos2 } from '../types.ts';
import { wallProbePoint, type WallOccluder } from '../render/mapmesh.ts';
import type { World } from './world.ts';

/** Exponential smoothing rate (1/seconds) for the reveal, gentler than wall occlusion. */
const FADE_SPEED = 3;
/** Snap-to-target threshold for `dampen` — see its doc for why this matters. */
const SNAP_EPS = 0.004;

/**
 * How many wall quads one frame's reveal may name individually before
 * `changedWalls` gives up and reports "all of them" instead. A reveal touches a
 * handful of subsectors a frame and each holds a few dozen quads; the fallback
 * is for the level-wide ramp the computer area map starts, where the list would
 * be as long as the map and the full pass is cheaper than building it.
 * **Tuned by feel.**
 */
const CHANGED_WALL_LIMIT = 4096;

/** What `changedBounds` reports when the change was wholesale — a box nothing is outside. */
const EVERYWHERE = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

/**
 * Cap on how many not-yet-explored subsectors get their sample rays tested in one `tick` call
 * (tuned by feel; `scanCursor` carries the rest of the nearest-first `order` onto later tics),
 * alongside the work cap below. Counted per tic, not per frame — `explored` is a gameplay input,
 * so the sweep rate must not depend on framerate. See docs/fogofwar.md § Sight testing.
 */
const MAX_SIGHT_TESTS_PER_TIC = 350;

/**
 * Second cap on the same sweep, in the work its rays actually do rather than the subsectors they
 * cover — `forEachLineAlongSegment`'s own count of cells stepped and lines tested (tuned by feel).
 * A subsector count bounds the wrong quantity; see docs/fogofwar.md § Sight testing.
 */
const MAX_SIGHT_WORK_PER_TIC = 150000;

/**
 * Width of one distance ring in the counting sort that orders the sweep nearest-first
 * (`buildOrder`). Only coarse ordering matters — within a ring the sweep keeps BSP order — so this
 * trades ring count against how exactly "nearest" is honoured. Tuned by feel: about a twentieth of
 * the radius the camera actually frames, so the ordering is exact well inside what the player is
 * looking at. See docs/fogofwar.md § Sweep order.
 */
const ORDER_RING = 256;

/**
 * How far the player may drift from the point `order` was built for before it is rebuilt, and the
 * slack added to the radius cutoff so a subsector that comes into range during that drift is
 * already in the array. Tuned by feel: small enough that the ordering stays honest, large enough
 * that a rebuild costs nothing at running speed. docs/fogofwar.md § Sweep order.
 */
const ORDER_ANCHOR_SLACK = 256;

/** How far a boundary sample is pulled toward the centroid, to keep it off the walls. */
const BOUNDARY_INSET = 0.25;

interface SubSectorSight {
  /**
   * Sample points as x,y pairs: centroid first, then every corner and every
   * edge midpoint, each pulled in toward the centroid.
   */
  samples: Float64Array;
  cx: number;
  cy: number;
  /** Farthest sample from the centroid, for a cheap distance reject. */
  radius: number;
}

/**
 * Per-subsector reveal state, sticky on sight, with sight as the only rule (no special case for
 * secret-flagged sectors) — each of those three choices is load-bearing; see docs/fogofwar.md.
 */
export class FogOfWar {
  private world: World;
  private sights: (SubSectorSight | null)[];
  private explored: Uint8Array;
  private alpha: Float32Array;
  private pending: number;
  private wallSubsector: Int32Array;
  /** Which sector each subsector belongs to — what `closedTarget` reads to spot a solid one. */
  private sectorOf: Int32Array;
  /**
   * Sectors a special can drive (`scanSectors`' `movable`) — the half of "no vertical opening"
   * that is shut space rather than solid geometry, and so excluded from `closedTarget`'s waiver.
   * docs/fogofwar.md § Closed sectors.
   */
  private movableSectors: ReadonlySet<number>;

  /**
   * Which tic each line's `blocksSight` answer was computed on, and what it was — see
   * `testBlocker`.
   */
  private blockStamp: Int32Array;
  private blockFlag: Uint8Array;
  /** Bumped once per `tick`, so a line's `blocksSight` is read at most once per tic. */
  private scanId = 0;

  /**
   * Which wall quads face into each subsector — `wallSubsector` inverted, as a
   * prefix-sum table plus its items. It exists so `updateFade` can name the
   * quads a reveal moved instead of leaving `WallFader.commit` to rediscover
   * them by walking the map: see `changedWalls`.
   */
  private wallsBySubsectorStart: Int32Array;
  private wallsBySubsector: Int32Array;
  /** The quads `updateFade` moved, refilled per frame — the buffer `changedWalls` hands out. */
  private changedWallList = new Int32Array(CHANGED_WALL_LIMIT);
  private changedWallCount = 0;
  /**
   * Each subsector's own 2D bounds, so `changedBounds` can say where a frame's
   * reveal happened without a second pass over the geometry.
   */
  private ssMinX: Float64Array;
  private ssMinY: Float64Array;
  private ssMaxX: Float64Array;
  private ssMaxY: Float64Array;
  /**
   * The union of the bounds of everything `updateFade` moved, and whether it moved anything at all.
   */
  private changedBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private changedAny = false;
  /**
   * Set whenever the changed quads are not worth naming one by one — a
   * wholesale alpha write (the constructor's seed, a restore) or more moving at
   * once than the buffer holds. `changedWalls` reports "all of them" once and
   * clears it.
   */
  private wallsAllChanged = true;
  /**
   * The same fallback for `changedBounds`, kept apart because the two are read
   * by different callers on the same frame and each consumes its own.
   */
  private boundsAllChanged = true;

  /** Scratch for `wallSubsectorAt`, which runs per mover quad per tic — see `wallProbePoint`. */
  private wallProbe: Pos2 = { x: 0, y: 0 };

  /**
   * The sector whose own lines this ray is allowed through, or -1 — set only
   * while sampling a *closed* subsector, which nothing else can see into.
   * See `sweep` and docs/fogofwar.md § Closed sectors.
   */
  private rayTargetSector = -1;

  /** The ray `testBlocker` is testing, and whether it has been blocked — see `sightClear`. */
  private rayX1 = 0;
  private rayY1 = 0;
  private rayX2 = 0;
  private rayY2 = 0;
  private rayBlocked = false;
  /**
   * What is left of this tic's `MAX_SIGHT_WORK_PER_TIC`; `sightClear` charges what each ray cost.
   */
  private workLeft = 0;

  /**
   * Round-robin resume point into `order` for `tick`'s budgeted scan — see
   * `MAX_SIGHT_TESTS_PER_TIC`.
   */
  private scanCursor = 0;

  /**
   * The subsectors the sweep may test, **nearest the player first** — the order `scanCursor` walks,
   * rebuilt by `buildOrder` once the player drifts `ORDER_ANCHOR_SLACK` off the point it was built
   * for. On a large level which subsector is scanned when decides what a tic's budget buys at all;
   * docs/fogofwar.md § Sweep order.
   */
  private order: Int32Array;
  /** How much of `order` is live: entries past this are out of reveal range from the anchor. */
  private orderCount = 0;
  /** Scratch bucket counts for `buildOrder`'s counting sort, one per `ORDER_RING`-wide ring. */
  private orderRings: Int32Array;
  /** The point `order` was built for; `ensureOrder` rebuilds once the player drifts off it. */
  private orderX = 0;
  private orderY = 0;

  constructor(
    world: World,
    occluders: WallOccluder[],
    start: Pos2,
    movableSectors?: ReadonlySet<number>,
  ) {
    this.world = world;
    const map = world.map;
    // Passed in by `game.ts`, which has already run this scan for the mesh
    // build; derived here only so a caller that has no reason to care (a test,
    // a tool) still gets the right answer rather than a silently permissive one.
    this.movableSectors = movableSectors ?? scanSectors(map).movable;
    const polys = buildSubSectorPolys(map);

    this.sights = new Array(polys.length).fill(null);
    this.explored = new Uint8Array(polys.length);
    this.alpha = new Float32Array(polys.length);
    this.sectorOf = new Int32Array(polys.length);
    for (let ss = 0; ss < polys.length; ss++) this.sectorOf[ss] = polys[ss].sector;

    this.blockStamp = new Int32Array(map.linedefs.length);
    this.blockFlag = new Uint8Array(map.linedefs.length);

    this.ssMinX = new Float64Array(polys.length);
    this.ssMinY = new Float64Array(polys.length);
    this.ssMaxX = new Float64Array(polys.length);
    this.ssMaxY = new Float64Array(polys.length);
    for (let ss = 0; ss < polys.length; ss++) {
      const pts = polys[ss].points;
      // A leaf the BSP clip left with no polygon at all gets the whole plane
      // rather than the inverted box an empty sweep would produce: `overlaps`
      // must never answer "nowhere near" for a subsector whose reveal moved.
      let minX = pts.length === 0 ? -Infinity : Infinity;
      let minY = pts.length === 0 ? -Infinity : Infinity;
      let maxX = pts.length === 0 ? Infinity : -Infinity;
      let maxY = pts.length === 0 ? Infinity : -Infinity;
      for (let p = 0; p < pts.length; p += 2) {
        if (pts[p] < minX) minX = pts[p];
        if (pts[p] > maxX) maxX = pts[p];
        if (pts[p + 1] < minY) minY = pts[p + 1];
        if (pts[p + 1] > maxY) maxY = pts[p + 1];
      }
      this.ssMinX[ss] = minX;
      this.ssMinY[ss] = minY;
      this.ssMaxX[ss] = maxX;
      this.ssMaxY[ss] = maxY;
    }

    for (let ss = 0; ss < polys.length; ss++) {
      const poly = polys[ss];
      const n = poly.points.length / 2;
      // A subsector the BSP clip left degenerate draws no floor at all. Mark it
      // explored rather than leaving it dark forever: any wall probe that lands
      // in one would otherwise pin that wall permanently invisible.
      if (n < 3) {
        this.explored[ss] = 1;
        this.alpha[ss] = 1;
        continue;
      }

      const { x: cx, y: cy } = polygonCentroid(poly.points);

      // Centroid first — one ray settles the common case, and the loop that
      // uses these stops at the first sample that comes back clear, so the
      // extra points below only cost anything for a subsector the centroid ray
      // failed on. Corners alone aren't enough there: a long subsector seen
      // edge-on through a doorway typically has both its centroid and all its
      // corners outside the visible wedge while its edges cross it, so every
      // edge midpoint is sampled too. Missing one is a black patch in the
      // middle of a view the player plainly has.
      const samples = new Float64Array((2 * n + 1) * 2);
      samples[0] = cx;
      samples[1] = cy;
      let radius = 0;
      let w = 2;
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        const kx = poly.points[k * 2];
        const ky = poly.points[k * 2 + 1];
        // The corner, then the midpoint of the edge leaving it. Written out rather than looped
        // over a pair of pairs: this runs per edge of every subsector on the map at level load.
        for (let half = 0; half < 2; half++) {
          const px = half === 0 ? kx : (kx + poly.points[j * 2]) / 2;
          const py = half === 0 ? ky : (ky + poly.points[j * 2 + 1]) / 2;
          const sx = px + (cx - px) * BOUNDARY_INSET;
          const sy = py + (cy - py) * BOUNDARY_INSET;
          samples[w++] = sx;
          samples[w++] = sy;
          radius = Math.max(radius, Math.hypot(sx - cx, sy - cy));
        }
      }

      this.sights[ss] = { samples, cx, cy, radius };
    }

    this.pending = this.sights.reduce((n, s) => n + (s ? 1 : 0), 0);

    this.order = new Int32Array(polys.length);
    // One ring per `ORDER_RING` up to the farthest key `ringOf` admits, inclusive. Sized off
    // `VIEW_DISTANCE` rather than the map, so it is a handful of entries however large the level
    // is.
    this.orderRings = new Int32Array(Math.floor((VIEW_DISTANCE + ORDER_ANCHOR_SLACK) / ORDER_RING) + 1);
    this.buildOrder(start.x, start.y);

    // Which subsector each wall quad faces into, so a wall reveals with the
    // space it encloses. `mapmesh` resolves the same quantity for the dynamic
    // lights (`WallOccluder.subsector`) and it is one BSP descent per quad, so
    // take its answer where there is one; -1 means that build was given no
    // probe (tests, tools) and this does it itself.
    this.wallSubsector = new Int32Array(occluders.length);
    for (let i = 0; i < occluders.length; i++) {
      const o = occluders[i];
      this.wallSubsector[i] = o.subsector >= 0 ? o.subsector : this.wallSubsectorAt(o.ax, o.ay, o.bx, o.by);
    }
    this.wallsBySubsectorStart = new Int32Array(polys.length + 1);
    this.wallsBySubsector = new Int32Array(occluders.length);
    for (let i = 0; i < occluders.length; i++) this.wallsBySubsectorStart[this.wallSubsector[i] + 1]++;
    for (let ss = 0; ss < polys.length; ss++) {
      this.wallsBySubsectorStart[ss + 1] += this.wallsBySubsectorStart[ss];
    }
    const cursor = Int32Array.from(this.wallsBySubsectorStart.subarray(0, polys.length));
    for (let i = 0; i < occluders.length; i++) this.wallsBySubsector[cursor[this.wallSubsector[i]]++] = i;

    // Seed the spawn's surroundings fully revealed instead of fading up from
    // black on frame one: unbounded on both caps, so this one call reveals
    // everything visible from spawn rather than leaving some of it to fade in
    // over the first few tics. The alpha snap below skips the fade itself.
    this.sweep(start.x, start.y, Infinity, Infinity);
    this.alpha.set(this.explored);
  }

  /** The `explored` bitmap, run-length encoded for a savegame (`snapshot.ts: encodeRuns`). */
  snapshotExplored(): number[] {
    return encodeRuns(this.explored);
  }

  /**
   * Overwrites the exploration state wholesale — not ORed in, so a restore
   * reproduces the save exactly even over the constructor's own spawn-seeded
   * reveal. `pending` is recounted and the visual alpha snapped to match, the
   * same snap the constructor ends on.
   */
  restoreExplored(runs: number[]): void {
    this.explored.set(decodeRuns(runs, this.explored.length));
    this.pending = 0;
    for (let ss = 0; ss < this.sights.length; ss++) {
      if (this.sights[ss] && !this.explored[ss]) this.pending++;
    }
    this.alpha.set(this.explored);
    this.wallsAllChanged = true;
    this.boundsAllChanged = true;
  }

  /**
   * One tic of reveal: marks newly seen subsectors `explored`, from the player's DOOM (x, y). On
   * the **simulation** clock, because `explored` decides what can be shot; the visual fade is
   * `updateFade`, which is not. docs/fogofwar.md § What gameplay reads.
   */
  tick(playerX: number, playerY: number): void {
    this.sweep(playerX, playerY, MAX_SIGHT_TESTS_PER_TIC, MAX_SIGHT_WORK_PER_TIC);
  }

  /**
   * Fades each subsector's drawn alpha toward whether it is explored. Purely
   * cosmetic and on the **render** clock: nothing in the simulation reads
   * `alpha`, which is what lets this stay framerate-smooth without making
   * shootability framerate-dependent.
   */
  updateFade(dt: number): void {
    this.changedWallCount = 0;
    this.changedAny = false;
    for (let ss = 0; ss < this.alpha.length; ss++) {
      const target = this.explored[ss];
      if (this.alpha[ss] === target) continue;
      this.alpha[ss] = dampen(this.alpha[ss], target, FADE_SPEED, dt, SNAP_EPS);
      // Where the reveal is happening, for `changedBounds`.
      if (!this.changedAny) {
        this.changedAny = true;
        this.changedBox.minX = this.ssMinX[ss];
        this.changedBox.minY = this.ssMinY[ss];
        this.changedBox.maxX = this.ssMaxX[ss];
        this.changedBox.maxY = this.ssMaxY[ss];
      } else {
        if (this.ssMinX[ss] < this.changedBox.minX) this.changedBox.minX = this.ssMinX[ss];
        if (this.ssMinY[ss] < this.changedBox.minY) this.changedBox.minY = this.ssMinY[ss];
        if (this.ssMaxX[ss] > this.changedBox.maxX) this.changedBox.maxX = this.ssMaxX[ss];
        if (this.ssMaxY[ss] > this.changedBox.maxY) this.changedBox.maxY = this.ssMaxY[ss];
      }
      // The walls this subsector holds now read a different reveal, so file
      // them for `changedWalls`. Past the buffer it stops filing and says
      // "everything" instead — a level-wide reveal is worth one full pass, not
      // a list as long as the map.
      const from = this.wallsBySubsectorStart[ss];
      const to = this.wallsBySubsectorStart[ss + 1];
      if (this.changedWallCount + (to - from) > this.changedWallList.length) {
        this.wallsAllChanged = true;
        continue;
      }

      for (let k = from; k < to; k++) this.changedWallList[this.changedWallCount++] = this.wallsBySubsector[k];
    }
  }

  /**
   * Where the last `updateFade`'s reveal happened: one coarse box around every subsector whose
   * alpha moved, or `null` when none did — its reader only asks whether a mesh *might* be affected.
   * A wholesale write reports the whole plane; reading it does not consume that fallback, which
   * `changedWalls` owns. docs/fogofwar.md § Which walls a reveal moved.
   */
  changedBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.boundsAllChanged) {
      this.boundsAllChanged = false;
      return EVERYWHERE;
    }
    return this.changedAny ? this.changedBox : null;
  }

  /**
   * The wall quads whose reveal alpha moved in the last `updateFade`, or `null` for "all of them".
   * Reading it consumes that fallback, so it must be called once per frame, after `updateFade`.
   * docs/fogofwar.md § Which walls a reveal moved.
   */
  changedWalls(): { indices: Int32Array; count: number } | null {
    if (this.wallsAllChanged) {
      this.wallsAllChanged = false;
      return null;
    }
    return { indices: this.changedWallList, count: this.changedWallCount };
  }

  /**
   * Whether a subsector has been revealed — the **gameplay** gate, deciding
   * what is drawn, shootable and auto-aimable (`ThingLayer.update`). Reads the
   * crisp `explored` flag rather than the damped `alpha`, so it cannot depend on
   * how many frames the fade has had. docs/fogofwar.md § What gameplay reads.
   */
  isVisible(subsector: number): boolean {
    return this.explored[subsector] !== 0;
  }

  /**
   * Marks the whole level explored — the computer area map powerup (vanilla's `pw_allmap`, which
   * here reveals the play view itself). Only `explored` is set, not `alpha`, so the level fades in
   * rather than snapping on. See docs/items.md § Powerups and the backpack.
   */
  revealAll(): void {
    this.explored.fill(1);
    this.pending = 0;
  }

  /** Current reveal alpha (0 = hidden, 1 = fully shown) for a subsector. */
  alphaOf(subsector: number): number {
    return this.alpha[subsector] ?? 1;
  }

  /** Reveal alpha for a wall quad, by the index it has in the built map's occluder list. */
  wallAlpha(occluderIndex: number): number {
    return this.alphaOf(this.wallSubsector[occluderIndex]);
  }

  /**
   * The subsector a wall quad faces into, for the mover quads the constructor never indexed. A BSP
   * descent, so it is the fallback rather than the path — a mesh built with a probe already carries
   * the answer on `WallOccluder.subsector`. docs/fogofwar.md § Mover wall quads.
   */
  wallSubsectorAt(ax: number, ay: number, bx: number, by: number): number {
    wallProbePoint(ax, ay, bx, by, this.wallProbe);
    return this.world.subsectorAt(this.wallProbe.x, this.wallProbe.y);
  }

  /**
   * `tick`'s body, with both caps named rather than defaulted, so the constructor's spawn seed can
   * ask for an unbounded pass on both without an in-band flag.
   */
  private sweep(playerX: number, playerY: number, subsectorBudget: number, workBudget: number): void {
    const currentSS = this.world.subsectorAt(playerX, playerY);
    if (currentSS >= 0 && currentSS < this.explored.length && !this.explored[currentSS]) {
      this.explored[currentSS] = 1;
      this.pending--;
    }
    if (this.pending <= 0) return;

    this.ensureOrder(playerX, playerY);

    this.scanId++;
    this.workLeft = workBudget;
    const order = this.order;
    const n = this.orderCount;
    let budget = subsectorBudget;
    let k = this.scanCursor;
    for (let steps = 0; steps < n && budget > 0 && this.workLeft > 0; steps++, k = k + 1 < n ? k + 1 : 0) {
      const ss = order[k];
      const s = this.explored[ss] ? undefined : this.sights[ss];
      if (!s) continue;
      // Reveal reaches exactly as far as the player can see, so the bound is
      // `VIEW_DISTANCE` itself. docs/fogofwar.md § Reveal radius. Squared, so
      // the subsectors this rejects never pay for a root. Kept though `order` is already cut to
      // range: that cutoff is anchored, this one answers for the live position.
      const dx = s.cx - playerX;
      const dy = s.cy - playerY;
      const reach = VIEW_DISTANCE + s.radius;
      if (dx * dx + dy * dy > reach * reach) continue;

      budget--;
      this.rayTargetSector = this.closedTarget(ss);
      // Both budgets are spent a whole subsector at a time: stopping between its samples would
      // leave it dark though visible until a later pass reaches it again.
      for (let i = 0; i < s.samples.length; i += 2) {
        if (this.sightClear(playerX, playerY, s.samples[i], s.samples[i + 1])) {
          this.explored[ss] = 1;
          this.pending--;
          break;
        }
      }
    }
    this.rayTargetSector = -1;
    this.scanCursor = k;
  }

  /**
   * Rebuilds `order` if the player has drifted `ORDER_ANCHOR_SLACK` from the point it was built
   * for.
   */
  private ensureOrder(playerX: number, playerY: number): void {
    const dx = playerX - this.orderX;
    const dy = playerY - this.orderY;
    if (dx * dx + dy * dy <= ORDER_ANCHOR_SLACK * ORDER_ANCHOR_SLACK) return;
    this.buildOrder(playerX, playerY);
  }

  /**
   * Fills `order` with every subsector that can be in reveal range of a player near (px, py),
   * nearest first, and restarts the sweep at the near end. A counting sort into `ORDER_RING`-wide
   * rings rather than a comparison sort, keyed on `distance - radius`; both choices are
   * load-bearing at this cadence — docs/fogofwar.md § Sweep order.
   */
  private buildOrder(px: number, py: number): void {
    const rings = this.orderRings;
    const ringCount = rings.length;
    rings.fill(0);

    const n = this.sights.length;
    for (let ss = 0; ss < n; ss++) {
      const s = this.sights[ss];
      if (!s) continue;
      const ring = this.ringOf(s, px, py);
      if (ring < 0) continue;
      rings[ring]++;
    }

    // Prefix sum in place: each ring's count becomes where its first entry goes.
    let at = 0;
    for (let r = 0; r < ringCount; r++) {
      const count = rings[r];
      rings[r] = at;
      at += count;
    }
    this.orderCount = at;

    const order = this.order;
    for (let ss = 0; ss < n; ss++) {
      const s = this.sights[ss];
      if (!s) continue;
      const ring = this.ringOf(s, px, py);
      if (ring < 0) continue;
      order[rings[ring]++] = ss;
    }

    this.orderX = px;
    this.orderY = py;
    this.scanCursor = 0;
  }

  /**
   * Which `ORDER_RING`-wide ring `s` falls in for a player at (px, py), or -1 for out of range.
   * One function rather than inline at both `buildOrder` passes: a counting sort is only correct
   * while the pass that counts and the pass that places agree on every entry.
   */
  private ringOf(s: SubSectorSight, px: number, py: number): number {
    const dx = s.cx - px;
    const dy = s.cy - py;
    const key = Math.sqrt(dx * dx + dy * dy) - s.radius;
    if (key > VIEW_DISTANCE + ORDER_ANCHOR_SLACK) return -1;
    // The cutoff above is the same expression `orderRings` is sized from, so the ring it admits is
    // always in range; a player standing inside a subsector gives a negative key, hence the floor.
    return key > 0 ? (key / ORDER_RING) | 0 : 0;
  }

  /**
   * The sector of a subsector that is **permanently** solid — no vertical opening, and no special
   * or mover that could ever give it one — else -1. `testBlocker` waives such a sector's own lines
   * while sampling it, or it would stay dark all level and draw as a hole. The opening test is live
   * rather than load-time. docs/fogofwar.md § Closed sectors.
   */
  private closedTarget(ss: number): number {
    const index = this.sectorOf[ss];
    const sector = this.world.map.sectors[index];
    if (!sector || sector.ceilHeight > sector.floorHeight) return -1;
    return this.movableSectors.has(index) ? -1 : index;
  }

  /**
   * True if no sight-blocking line lies between the player and (tx, ty), walking only the grid
   * cells the ray crosses and charging what that cost against this tic's work budget.
   * docs/fogofwar.md § Sight testing.
   */
  private sightClear(px: number, py: number, tx: number, ty: number): boolean {
    this.rayX1 = px;
    this.rayY1 = py;
    this.rayX2 = tx;
    this.rayY2 = ty;
    this.rayBlocked = false;
    this.workLeft -= this.world.forEachLineAlongSegment(px, py, tx, ty, this.testBlocker);
    return !this.rayBlocked;
  }

  /**
   * `forEachLineAlongSegment`'s visitor, a bound field rather than a closure per call: the sweep
   * runs thousands of rays a tic and a fresh closure each would allocate in exactly the wrong
   * place. docs/fogofwar.md § Sight testing.
   */
  private testBlocker = (i: number): boolean | void => {
    // The closed subsector's own boundary, waived — see `closedTarget`. Ahead
    // of the memo, which is keyed by line alone and shared with rays that are
    // not exempt.
    if (this.rayTargetSector >= 0 && this.bordersTarget(i)) return;
    if (this.blockStamp[i] !== this.scanId) {
      this.blockStamp[i] = this.scanId;
      this.blockFlag[i] = this.world.blocksSight(i) ? 1 : 0;
    }
    if (this.blockFlag[i] === 0) return;
    // `World.lineOverlapEnds` carries the shared-vertex overhang every ray-vs-wall
    // test in the engine needs — see `WALL_OVERLAP`, docs/fogofwar.md § Sight testing.
    const e = i * 4;
    const ends = this.world.lineOverlapEnds;
    const ax = ends[e];
    const ay = ends[e + 1];
    const bx = ends[e + 2];
    const by = ends[e + 3];
    if (segmentCrossT(this.rayX1, this.rayY1, this.rayX2, this.rayY2, ax, ay, bx, by) >= 0) {
      return (this.rayBlocked = true);
    }
  };

  /** Whether a line has `rayTargetSector` on either side — the waiver in `testBlocker`. */
  private bordersTarget(lineIndex: number): boolean {
    const line = this.world.map.linedefs[lineIndex];
    if (!line) return false;
    const sides = this.world.map.sidedefs;
    return (
      sides[line.right]?.sector === this.rayTargetSector || sides[line.left]?.sector === this.rayTargetSector
    );
  }
}
