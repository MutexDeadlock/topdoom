/**
 * Fog of war: hides the parts of the level the player hasn't seen yet, and the regions they are
 * not in, revealing per subsector and sticky on sight. See docs/fogofwar.md.
 */
import { buildIslands, buildSubSectorPolys } from '../render/bsp.ts';
import { polygonCentroid, segmentCrossT, vecLength } from '../util/geom.ts';
import { dampenWith } from '../util/damping.ts';
import { exp } from '../util/fdlibm.ts';
import { decodeRuns, encodeRuns } from './snapshot.ts';
import { scanSectors } from './specials/mapscan.ts';
import { VIEW_DISTANCE } from '../constants.ts';
import type { Pos2 } from '../types.ts';
import { wallProbePoint, type WallOccluder } from '../render/mapmesh.ts';
import { NO_SIDE } from '../wad/map.ts';
import type { MidCover } from '../render/midcover.ts';
import type { Opening, World } from './world.ts';

/** Exponential smoothing rate (1/seconds) for the reveal, gentler than wall occlusion. */
const FADE_SPEED = 3;
/** Snap-to-target threshold for `dampen` — see its doc for why this matters. */
const SNAP_EPS = 0.004;

/**
 * How many wall quads one frame's reveal may name individually before {@link FogOfWar.changedWalls}
 * gives up and reports "all of them" instead. A reveal touches a handful of subsectors a frame and
 * each holds a few dozen quads. **Tuned by feel.** docs/fogofwar.md § Which walls a reveal moved.
 */
const CHANGED_WALL_LIMIT = 4096;

/**
 * What {@link FogOfWar.changedBounds} reports when the change was wholesale — a box nothing is
 * outside.
 */
const EVERYWHERE = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

/**
 * Cap on how many not-yet-explored subsectors get their sample rays tested in one
 * {@link FogOfWar.tick} call (tuned by feel; {@link SweepAnchor.cursor} carries the rest of the
 * nearest-first {@link SweepAnchor.order} onto later tics), alongside the work cap below. Counted
 * per tic, not per frame — {@link FogOfWar.explored} is a gameplay input, so the sweep rate must
 * not depend on framerate. See docs/fogofwar.md § Sight testing.
 */
const MAX_SIGHT_TESTS_PER_TIC = 350;

/**
 * Second cap on the same sweep, in the work its rays actually do rather than the subsectors they
 * cover — {@link World.forEachLineAlongSegment}'s own count of cells stepped and lines tested
 * (tuned by feel). A subsector count bounds the wrong quantity; see
 * docs/fogofwar.md § Sight testing.
 */
const MAX_SIGHT_WORK_PER_TIC = 150000;

/**
 * Cap on {@link FogOfWar.redraw}'s rays in one tic, in the units of
 * {@link MAX_SIGHT_WORK_PER_TIC} (tuned by feel): a leaf explored past a covering midtexture is
 * looked at again every tic until something sees it cleanly, and a level can hold many that
 * nothing ever does. docs/fogofwar.md § Covering midtextures.
 */
const MAX_REDRAW_WORK_PER_TIC = 20000;

/**
 * Width of one distance ring in the counting sort that orders the sweep nearest-first
 * ({@link FogOfWar.buildOrder}). Only coarse ordering matters — within a ring the sweep keeps BSP
 * order — so this trades ring count against how exactly "nearest" is honoured. Tuned by feel: about
 * a twentieth of the radius the camera actually frames, so the ordering is exact well inside what
 * the player is looking at. See docs/fogofwar.md § Sweep order.
 */
const ORDER_RING = 256;

/**
 * How far the player may drift from the point {@link SweepAnchor.order} was built for before it is
 * rebuilt, and the slack added to the radius cutoff so a subsector that comes into range during
 * that drift is already in the array. Tuned by feel: small enough that the ordering stays honest,
 * large enough that a rebuild costs nothing at running speed. docs/fogofwar.md § Sweep order.
 */
const ORDER_ANCHOR_SLACK = 256;

/** How far a boundary sample is pulled toward the centroid, to keep it off the walls. */
const BOUNDARY_INSET = 0.25;

/**
 * The island of a leaf that is nowhere — one the BSP clip left degenerate. It draws nothing and has
 * no place to be disconnected from, so it passes the island gate whatever the player's is.
 */
const NO_ISLAND = -1;

/**
 * Whether the fog sweeps at all: `'off'` is a deathmatch's — everything explored, every island
 * gate open, no per-tic work — and answers every reader as a fully revealed level would.
 * docs/fogofwar.md § Off.
 */
export type FogMode = 'sweep' | 'off';

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

/** What a {@link FogOfWar} is built with beyond the level and its players. */
export interface FogOptions {
  /**
   * Sectors a special can drive ({@link scanSectors}' `movable`). `game.ts` has already run that
   * scan for the mesh build; derived when absent, so a caller with no reason to care (a test, a
   * tool) still gets the right answer rather than a silently permissive one.
   */
  movableSectors?: ReadonlySet<number>;
  /** `'off'` for a level with no fog — see {@link FogMode}. */
  mode?: FogMode;
  /**
   * The midtextures that hide what is past them, read by the draw gate only; absent, nothing is
   * hidden that way. docs/fogofwar.md § Covering midtextures.
   */
  cover?: MidCover;
}

/**
 * Per-subsector reveal state, sticky on sight, with sight as the only rule (no special case for
 * secret-flagged sectors) and only the player's own island drawn — each of those four choices is
 * load-bearing; see docs/fogofwar.md.
 */
export class FogOfWar {
  private world: World;
  private sights: (SubSectorSight | null)[];
  private explored: Uint8Array;
  private alpha: Float32Array;
  private pending: number;
  private wallSubsector: Int32Array;
  /**
   * Which sector each subsector belongs to — what {@link FogOfWar.closedTarget} reads to spot a
   * solid one.
   */
  private sectorOf: Int32Array;
  /**
   * Which connected region each subsector belongs to ({@link buildIslands}), or {@link NO_ISLAND}.
   * A copy of the shared table, because a sight reveal across two ids merges them for this level.
   * docs/fogofwar.md § Islands.
   */
  private island: Int32Array;
  /**
   * Sectors a special can drive ({@link scanSectors}' `movable`) — the half of "no vertical
   * opening" that is shut space rather than solid geometry, and so excluded from
   * {@link FogOfWar.closedTarget}'s waiver. docs/fogofwar.md § Closed sectors.
   */
  private movableSectors: ReadonlySet<number>;
  /** {@link FogOptions.cover}, or null. */
  private cover: MidCover | null;
  /**
   * Per leaf, where it sits in {@link FogOfWar.undrawnList}, or -1: an undrawn leaf is one explored
   * only along rays that crossed a covering midtexture — explored for everything a tic reads, and
   * not drawn. Nothing a tic reads is derived from it. docs/fogofwar.md § Covering midtextures.
   */
  private undrawnSlot: Int32Array;
  /** The undrawn leaves, packed — what {@link FogOfWar.redraw} walks. */
  private undrawnList: Int32Array;
  private undrawnCount = 0;
  /** Round-robin resume point into {@link FogOfWar.undrawnList}. */
  private redrawCursor = 0;
  /**
   * Leaves of a sector too small to be a place — a sound channel or a vent through the wall mass
   * ({@link findHoleSectors}): explored like any other, never drawn.
   * docs/fogofwar.md § Holes in the wall.
   */
  private hole: Uint8Array;
  /** {@link FogMode} `'off'`: the readers answer through the tables below, which never change. */
  private readonly off: boolean;

  /**
   * Which tic each line's {@link World.blocksSight} answer was computed on, and what it was — see
   * {@link FogOfWar.testBlocker}.
   */
  private blockStamp: Int32Array;
  private blockFlag: Uint8Array;
  /**
   * Bumped once per {@link FogOfWar.tick}, so a line's {@link World.blocksSight} is read at most
   * once per tic.
   */
  private scanId = 0;

  /**
   * Which wall quads face into each subsector — {@link FogOfWar.wallSubsector} inverted, as a
   * prefix-sum table plus its items. It exists so {@link FogOfWar.updateFade} can name the quads a
   * reveal moved instead of leaving `WallFader.commit` to rediscover them by walking the map: see
   * {@link FogOfWar.changedWalls}.
   */
  private wallsBySubsectorStart: Int32Array;
  private wallsBySubsector: Int32Array;
  /**
   * The quads {@link FogOfWar.updateFade} moved, refilled per frame — the buffer
   * {@link FogOfWar.changedWalls} hands out.
   */
  private changedWallList = new Int32Array(CHANGED_WALL_LIMIT);
  private changedWallCount = 0;
  /**
   * Each subsector's own 2D bounds, so {@link FogOfWar.changedBounds} can say where a frame's
   * reveal happened without a second pass over the geometry.
   */
  private ssMinX: Float64Array;
  private ssMinY: Float64Array;
  private ssMaxX: Float64Array;
  private ssMaxY: Float64Array;
  /**
   * The union of the bounds of everything {@link FogOfWar.updateFade} moved, and whether it moved
   * anything at all.
   */
  private changedBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private changedAny = false;
  /**
   * Set whenever the changed quads are not worth naming one by one — a wholesale alpha write (the
   * constructor's seed, a restore) or more moving at once than the buffer holds.
   * {@link FogOfWar.changedWalls} reports "all of them" once and clears it.
   */
  private wallsAllChanged = true;
  /**
   * The same fallback for {@link FogOfWar.changedBounds}, kept apart because the two are read by
   * different callers on the same frame and each consumes its own.
   */
  private boundsAllChanged = true;

  /**
   * Scratch for {@link FogOfWar.wallSubsectorAt}, which runs per mover quad per tic — see
   * {@link wallProbePoint}.
   */
  private wallProbe: Pos2 = { x: 0, y: 0 };

  /**
   * The sector whose own lines this ray is allowed through, or -1 — set only while sampling a
   * *closed* subsector, which nothing else can see into. See {@link FogOfWar.sweep} and
   * docs/fogofwar.md § Closed sectors.
   */
  private rayTargetSector = -1;

  /**
   * The ray {@link FogOfWar.testBlocker} is testing, and whether it has been blocked — see
   * {@link FogOfWar.sightClear}.
   */
  private rayX1 = 0;
  private rayY1 = 0;
  private rayX2 = 0;
  private rayY2 = 0;
  private rayBlocked = false;
  /**
   * Whether that ray crossed a covering midtexture — never a stop, only what
   * {@link FogOfWar.redraw} refuses to count as clean; see {@link FogOfWar.testBlocker}.
   */
  private rayCovered = false;
  /** Scratch for {@link FogOfWar.coverHidesRay}. */
  private coverOpening: Opening = { top: 0, bottom: 0 };
  /**
   * What is left of this tic's {@link MAX_SIGHT_WORK_PER_TIC}; {@link FogOfWar.sightClear} charges
   * what each ray cost.
   */
  private workLeft = 0;

  /** Each slot's sweep, by slot, grown as players first reveal — see {@link SweepAnchor}. */
  private anchors: SweepAnchor[] = [];
  /**
   * The slot whose island is drawn — {@link FogOfWar.setDrawn}'s. Only the drawing reads it: what a
   * tic may shoot is gated on every slot's island. docs/fogofwar.md § Islands.
   */
  private drawn: number;
  /**
   * Scratch bucket counts for {@link FogOfWar.buildOrder}'s counting sort, one per
   * {@link ORDER_RING}-wide ring.
   */
  private orderRings: Int32Array;

  constructor(
    world: World,
    occluders: WallOccluder[],
    starts: readonly Pos2[],
    drawn: number,
    options: FogOptions = {},
  ) {
    this.world = world;
    this.drawn = drawn;
    this.off = options.mode === 'off';
    const map = world.map;
    this.movableSectors = options.movableSectors ?? scanSectors(map).movable;
    this.cover = options.cover ?? null;
    const polys = buildSubSectorPolys(map);

    this.sights = new Array(polys.length).fill(null);
    this.explored = new Uint8Array(polys.length);
    this.alpha = new Float32Array(polys.length);
    this.undrawnSlot = new Int32Array(polys.length).fill(-1);
    this.undrawnList = new Int32Array(polys.length);
    this.sectorOf = new Int32Array(polys.length);
    this.hole = new Uint8Array(polys.length);
    const holes = findHoleSectors(world, this.movableSectors);
    for (let ss = 0; ss < polys.length; ss++) {
      this.sectorOf[ss] = polys[ss].sector;
      this.hole[ss] = holes[polys[ss].sector] ?? 0;
    }

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
          radius = Math.max(radius, vecLength(sx - cx, sy - cy));
        }
      }

      this.sights[ss] = { samples, cx, cy, radius };
    }

    this.pending = this.sights.reduce((n, s) => n + (s ? 1 : 0), 0);

    // Copied rather than shared with the rest of the engine, because `mergeIsland` rewrites it.
    this.island = Int32Array.from(buildIslands(map));
    // A wall probe landing in a degenerate leaf must not be pinned invisible by the island such a
    // leaf only nominally has.
    for (let ss = 0; ss < this.island.length; ss++) {
      if (!this.sights[ss]) this.island[ss] = NO_ISLAND;
    }

    // One ring per `ORDER_RING` up to the farthest key `ringOf` admits, inclusive. Sized off
    // `VIEW_DISTANCE` rather than the map, so it is a handful of entries however large the level
    // is.
    this.orderRings = new Int32Array(Math.floor((VIEW_DISTANCE + ORDER_ANCHOR_SLACK) / ORDER_RING) + 1);

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

    // Off: the whole level explored and no island to be outside of, so `isVisible`, `isDrawn`
    // and `alphaOf` answer "shown" through the same reads as ever — no branch on a hot path.
    if (this.off) {
      this.explored.fill(1);
      this.island.fill(NO_ISLAND);
      this.pending = 0;
      this.snapAlpha();
      return;
    }
    // Seed every start's surroundings fully revealed instead of fading up from
    // black on frame one: unbounded on both caps, so this one call reveals
    // everything visible from spawn rather than leaving some of it to fade in
    // over the first few tics. The alpha snap below skips the fade itself.
    this.scanId++;
    for (let slot = 0; slot < starts.length; slot++) {
      this.sweep(slot, starts[slot].x, starts[slot].y, Infinity, Infinity);
    }
    this.redraw(starts, Infinity);
    this.snapAlpha();
  }

  /**
   * The {@link FogOfWar.explored} bitmap, run-length encoded for a savegame ({@link encodeRuns}).
   */
  snapshotExplored(): number[] {
    return encodeRuns(this.explored);
  }

  /**
   * The undrawn leaves ({@link FogOfWar.undrawnSlot}) as a bitmap, run-length encoded the same way
   * — draw state riding along in a save. docs/fogofwar.md § Covering midtextures.
   */
  snapshotUndrawn(): number[] {
    return encodeRuns(Uint8Array.from(this.undrawnSlot, (at) => (at >= 0 ? 1 : 0)));
  }

  /**
   * Overwrites the exploration state wholesale — not ORed in, so a restore reproduces the save
   * exactly even over the constructor's own spawn-seeded reveal. {@link FogOfWar.pending} is
   * recounted and the visual alpha snapped to match, the same snap the constructor ends on.
   *
   * @param undrawn  {@link FogOfWar.snapshotUndrawn}'s runs; absent — a save from before it — draws
   *                 every explored leaf
   */
  restoreExplored(runs: number[], undrawn?: number[]): void {
    // A deathmatch save's runs say everything, which is what the level already shows.
    if (this.off) return;
    this.explored.set(decodeRuns(runs, this.explored.length));
    this.pending = 0;
    for (let ss = 0; ss < this.sights.length; ss++) {
      if (this.sights[ss] && !this.explored[ss]) {
        this.pending++;
      }
    }
    this.clearAllUndrawn();
    if (undrawn) {
      const bits = decodeRuns(undrawn, this.undrawnSlot.length);
      for (let ss = 0; ss < bits.length; ss++) {
        if (bits[ss] && this.explored[ss] && this.sights[ss]) {
          this.markUndrawn(ss);
        }
      }
    }
    this.snapAlpha();
  }

  /**
   * One tic of reveal: marks newly seen subsectors {@link FogOfWar.explored} from every slot's body
   * — one fog for everyone, the per-tic caps split between them. On the **simulation** clock,
   * because {@link FogOfWar.explored} decides what can be shot; the visual fade is
   * {@link FogOfWar.updateFade}, which is not.
   * docs/fogofwar.md § What gameplay reads, § Sweep order.
   *
   * @param points  each slot's body, dead or alive, by slot
   */
  tick(points: readonly Pos2[]): void {
    if (this.off || points.length === 0) return;
    this.scanId++;
    const tests = Math.ceil(MAX_SIGHT_TESTS_PER_TIC / points.length);
    const work = Math.ceil(MAX_SIGHT_WORK_PER_TIC / points.length);
    for (let slot = 0; slot < points.length; slot++) {
      const at = points[slot];
      this.sweep(slot, at.x, at.y, tests, work);
    }
    this.redraw(points, MAX_REDRAW_WORK_PER_TIC);
  }

  /**
   * Fades each subsector's drawn alpha toward whether it is explored. Purely cosmetic and on the
   * **render** clock: nothing in the simulation reads {@link FogOfWar.alpha}.
   */
  updateFade(dt: number): void {
    this.changedWallCount = 0;
    this.changedAny = false;
    if (this.off) return;
    // One exponential for the sweep rather than one per subsector: every alpha here fades at the
    // same rate over the same frame, which is the case `dampenWith` is for.
    const lerpT = 1 - exp(-FADE_SPEED * dt);
    const drawnIsland = this.drawnIsland();
    for (let ss = 0; ss < this.alpha.length; ss++) {
      const target = this.targetAlpha(ss, drawnIsland);
      if (this.alpha[ss] === target) continue;
      this.alpha[ss] = dampenWith(this.alpha[ss], target, lerpT, SNAP_EPS);
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
   * Where the last {@link FogOfWar.updateFade}'s reveal happened: one coarse box around every
   * subsector whose alpha moved — its reader only asks whether a mesh *might* be affected. A
   * wholesale write reports the whole plane; reading it does not consume that fallback, which
   * {@link FogOfWar.changedWalls} owns. docs/fogofwar.md § Which walls a reveal moved.
   *
   * @returns null when no alpha moved
   */
  changedBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.boundsAllChanged) {
      this.boundsAllChanged = false;
      return EVERYWHERE;
    }
    return this.changedAny ? this.changedBox : null;
  }

  /**
   * The wall quads whose reveal alpha moved in the last {@link FogOfWar.updateFade}. Reading the
   * "all of them" fallback consumes it, so it must be called once per frame, after
   * {@link FogOfWar.updateFade}. docs/fogofwar.md § Which walls a reveal moved.
   *
   * @returns null for "all of them"
   */
  changedWalls(): { indices: Int32Array; count: number } | null {
    if (this.wallsAllChanged) {
      this.wallsAllChanged = false;
      return null;
    }
    return { indices: this.changedWallList, count: this.changedWallCount };
  }

  /**
   * Whether a subsector has been revealed — the **gameplay** gate, deciding what is shootable and
   * auto-aimable (`ThingLayer.update`): explored, and in the island any slot stands in, so no
   * answer depends on which slot is drawn. docs/fogofwar.md § What gameplay reads, § Islands.
   */
  isVisible(subsector: number): boolean {
    if (this.explored[subsector] === 0) return false;
    const id = this.island[subsector];
    if (id === NO_ISLAND) return true;
    for (let slot = 0; slot < this.anchors.length; slot++) {
      if (this.anchors[slot].island === id) return true;
    }
    return false;
  }

  /**
   * Whether a subsector is drawn: explored, not seen only past a covering midtexture, not a
   * hole in the wall, and in the drawn slot's island — what a sprite or an effect is shown by.
   * Never a tic's question.
   * docs/fogofwar.md § Islands, § Covering midtextures, § Holes in the wall.
   */
  isDrawn(subsector: number): boolean {
    return this.drawnAt(subsector, this.drawnIsland());
  }

  /**
   * Draws slot `slot`'s island from here, cutting to it as a teleport does. Changes nothing a tic
   * reads. docs/fogofwar.md § Islands.
   */
  setDrawn(slot: number): void {
    if (slot === this.drawn) return;
    this.drawn = slot;
    this.snapAlpha();
  }

  /**
   * Marks the whole level explored — the computer area map powerup (vanilla's `pw_allmap`, which
   * here reveals the play view itself). Only {@link FogOfWar.explored} is set, not
   * {@link FogOfWar.alpha}, so the level fades in rather than snapping on; the island gate still
   * applies, so it reveals the region the player is in — past covering midtextures too.
   * See docs/items.md § Powerups and the backpack.
   */
  revealAll(): void {
    this.explored.fill(1);
    this.pending = 0;
    this.clearAllUndrawn();
  }

  /**
   * Current reveal alpha for a subsector.
   *
   * @returns 0 = hidden, 1 = fully shown
   */
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
   * the answer on {@link WallOccluder.subsector}. docs/fogofwar.md § Mover wall quads.
   */
  wallSubsectorAt(ax: number, ay: number, bx: number, by: number): number {
    wallProbePoint(ax, ay, bx, by, this.wallProbe);
    return this.world.subsectorAt(this.wallProbe.x, this.wallProbe.y);
  }

  /**
   * One player's share of {@link FogOfWar.tick}, with both caps named rather than defaulted, so the
   * spawn seeds can ask for an unbounded pass on both without an in-band flag. Every slot's sweep
   * moves that slot's island.
   */
  private sweep(slot: number, playerX: number, playerY: number, subsectorBudget: number, workBudget: number): void {
    const anchor = this.anchorFor(slot);
    const currentSS = this.world.subsectorAt(playerX, playerY);
    const inMap = currentSS >= 0 && currentSS < this.explored.length;
    if (inMap) {
      this.enterIsland(slot, this.island[currentSS]);
      if (!this.explored[currentSS]) {
        this.explored[currentSS] = 1;
        this.pending--;
      }
      // Standing in a leaf is seeing it, whatever hung between it and where it was first seen from.
      this.clearUndrawn(currentSS);
    }
    if (this.pending <= 0) return;
    // The island a reveal here proves connected to what it reaches: the one this player stands in.
    const from = anchor.island;

    this.ensureOrder(anchor, playerX, playerY);

    this.workLeft = workBudget;
    const order = anchor.order;
    const n = anchor.count;
    let budget = subsectorBudget;
    let k = anchor.cursor;
    for (let steps = 0; steps < n && budget > 0 && this.workLeft > 0; steps++, k = k + 1 < n ? k + 1 : 0) {
      const ss = order[k];
      const s = this.explored[ss] ? undefined : this.sights[ss];
      if (!s) continue;
      // Kept though `order` is already cut to range: that cutoff is anchored, this one answers for
      // the live position.
      if (!inReach(s, playerX, playerY)) continue;

      budget--;
      this.rayTargetSector = this.closedTarget(ss);
      // Both budgets are spent a whole subsector at a time: stopping between its samples would
      // leave it dark though visible until a later pass reaches it again.
      for (let i = 0; i < s.samples.length; i += 2) {
        if (this.sightClear(playerX, playerY, s.samples[i], s.samples[i + 1])) {
          this.explored[ss] = 1;
          this.pending--;
          // Explored all the same: a covering midtexture only keeps it off the screen.
          if (this.rayCovered) this.markUndrawn(ss);
          // A ray reached it, so the two are one place and the partition was wrong: the only
          // merge rule there is, docs/fogofwar.md § Islands.
          const reached = this.island[ss];
          if (reached !== from && reached !== NO_ISLAND) {
            this.mergeIsland(reached, from);
          }
          break;
        }
      }
    }
    this.rayTargetSector = -1;
    anchor.cursor = k;
  }

  /**
   * Slot `slot`'s sweep anchor, made on first use with no order yet — {@link FogOfWar.ensureOrder}
   * builds one.
   */
  private anchorFor(slot: number): SweepAnchor {
    while (this.anchors.length <= slot) {
      this.anchors.push({
        order: new Int32Array(this.sights.length),
        count: 0,
        x: NaN,
        y: NaN,
        cursor: 0,
        island: NO_ISLAND,
      });
    }
    return this.anchors[slot];
  }

  /**
   * Rebuilds `anchor`'s order if the player has drifted {@link ORDER_ANCHOR_SLACK} from the point
   * it was built for — or it was never built, which the `NaN` it starts at always fails.
   */
  private ensureOrder(anchor: SweepAnchor, playerX: number, playerY: number): void {
    const dx = playerX - anchor.x;
    const dy = playerY - anchor.y;
    if (dx * dx + dy * dy <= ORDER_ANCHOR_SLACK * ORDER_ANCHOR_SLACK) return;
    this.buildOrder(anchor, playerX, playerY);
  }

  /**
   * Fills {@link SweepAnchor.order} with every subsector that can be in reveal range of a player
   * near (px, py), nearest first, and restarts the sweep at the near end. A counting sort into
   * {@link ORDER_RING}-wide rings rather than a comparison sort, keyed on `distance - radius`; both
   * choices are load-bearing at this cadence — docs/fogofwar.md § Sweep order.
   */
  private buildOrder(anchor: SweepAnchor, px: number, py: number): void {
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
    anchor.count = at;

    const order = anchor.order;
    for (let ss = 0; ss < n; ss++) {
      const s = this.sights[ss];
      if (!s) continue;
      const ring = this.ringOf(s, px, py);
      if (ring < 0) continue;
      order[rings[ring]++] = ss;
    }

    anchor.x = px;
    anchor.y = py;
    anchor.cursor = 0;
  }

  /**
   * Which {@link ORDER_RING}-wide ring `s` falls in for a player at (px, py). One function rather
   * than inline at both {@link FogOfWar.buildOrder} passes: a counting sort is only correct while
   * the pass that counts and the pass that places agree on every entry.
   *
   * @returns -1 for out of range
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
   * or mover that could ever give it one — whose own lines {@link FogOfWar.testBlocker} waives
   * while sampling it. docs/fogofwar.md § Closed sectors.
   *
   * @returns -1 for any other subsector
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
    this.rayCovered = false;
    this.workLeft -= this.world.forEachLineAlongSegment(px, py, tx, ty, this.testBlocker);
    return !this.rayBlocked;
  }

  /**
   * {@link World.forEachLineAlongSegment}'s visitor, a bound field rather than a closure per call:
   * the sweep runs thousands of rays a tic and a fresh closure each would allocate in exactly the
   * wrong place. docs/fogofwar.md § Sight testing.
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
    if (this.blockFlag[i] === 0) {
      // Sight passes. A covering midtexture still hides what is past it from the draw gate, so the
      // ray is only noted covered: the walk decides what a tic reads, and art never stops it.
      // docs/fogofwar.md § Covering midtextures.
      const cover = this.cover;
      if (cover !== null && !this.rayCovered && cover.candidate(i) && this.coverHidesRay(cover, i)) {
        this.rayCovered = true;
      }
      return;
    }
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

  /**
   * Whether a line has {@link FogOfWar.rayTargetSector} on either side — the waiver in
   * {@link FogOfWar.testBlocker}.
   */
  private bordersTarget(lineIndex: number): boolean {
    const line = this.world.map.linedefs[lineIndex];
    if (!line) return false;
    const sides = this.world.map.sidedefs;
    return (
      sides[line.right]?.sector === this.rayTargetSector || sides[line.left]?.sector === this.rayTargetSector
    );
  }

  /**
   * Whether line `i`, which sight passes, crosses the ray being walked with a midtexture that hides
   * its opening from the eye's side. docs/fogofwar.md § Covering midtextures.
   */
  private coverHidesRay(cover: MidCover, i: number): boolean {
    const e = i * 4;
    const ends = this.world.lineOverlapEnds;
    const t = segmentCrossT(this.rayX1, this.rayY1, this.rayX2, this.rayY2, ends[e], ends[e + 1], ends[e + 2], ends[e + 3]);
    if (t < 0) return false;
    const o = this.coverOpening;
    if (!this.world.openingInto(i, o)) return false;
    return cover.hides(i, this.world.pointOnLineSide(this.rayX1, this.rayY1, i), o.bottom, o.top);
  }

  /**
   * Draws again every undrawn leaf some point now sees with nothing in the way, covering
   * midtextures included. It spends a budget of its own and writes nothing but the undrawn list.
   * Shares the tic's {@link FogOfWar.scanId} with the sweep before it.
   * docs/fogofwar.md § Covering midtextures.
   *
   * @param points  each slot's body, as {@link FogOfWar.tick} takes them
   */
  private redraw(points: readonly Pos2[], workBudget: number): void {
    if (this.undrawnCount === 0) return;
    this.workLeft = workBudget;
    let k = this.redrawCursor;
    // A pass clears at most one leaf per step, so the list never runs out before `steps` does.
    for (let steps = this.undrawnCount; steps > 0 && this.workLeft > 0; steps--) {
      if (k >= this.undrawnCount) k = 0;
      const ss = this.undrawnList[k];
      // A cleared leaf's slot takes the list's last entry, so `k` stays put to test that one next.
      if (this.seenClean(ss, points)) {
        this.clearUndrawn(ss);
      } else {
        k++;
      }
    }
    this.redrawCursor = k;
  }

  /**
   * Whether any of `points` reaches some sample of leaf `ss` along a ray nothing stops and no
   * covering midtexture crosses.
   */
  private seenClean(ss: number, points: readonly Pos2[]): boolean {
    const s = this.sights[ss];
    if (!s) return true;
    this.rayTargetSector = this.closedTarget(ss);
    for (let p = 0; p < points.length; p++) {
      const px = points[p].x;
      const py = points[p].y;
      if (!inReach(s, px, py)) continue;
      for (let i = 0; i < s.samples.length; i += 2) {
        if (this.sightClear(px, py, s.samples[i], s.samples[i + 1]) && !this.rayCovered) return true;
      }
    }
    return false;
  }

  /** Files leaf `ss` as undrawn. */
  private markUndrawn(ss: number): void {
    if (this.undrawnSlot[ss] >= 0) return;
    this.undrawnSlot[ss] = this.undrawnCount;
    this.undrawnList[this.undrawnCount++] = ss;
  }

  /** Takes leaf `ss` off the undrawn list, moving the list's last entry into its slot. */
  private clearUndrawn(ss: number): void {
    const at = this.undrawnSlot[ss];
    if (at < 0) return;
    const last = this.undrawnList[--this.undrawnCount];
    this.undrawnList[at] = last;
    this.undrawnSlot[last] = at;
    this.undrawnSlot[ss] = -1;
  }

  /** Empties the undrawn list. */
  private clearAllUndrawn(): void {
    for (let k = 0; k < this.undrawnCount; k++) this.undrawnSlot[this.undrawnList[k]] = -1;
    this.undrawnCount = 0;
    this.redrawCursor = 0;
  }

  /** The island the drawn slot stands in, {@link NO_ISLAND} before it stood in any. */
  private drawnIsland(): number {
    return this.anchors[this.drawn]?.island ?? NO_ISLAND;
  }

  /**
   * {@link FogOfWar.isDrawn}'s answer: explored, not undrawn ({@link FogOfWar.undrawnSlot}), not a
   * {@link FogOfWar.hole}, **and** in the drawn slot's island.
   *
   * @param drawnIsland  {@link FogOfWar.drawnIsland}'s answer, read once by a caller's loop
   */
  private drawnAt(subsector: number, drawnIsland: number): boolean {
    return (
      this.explored[subsector] !== 0 &&
      this.undrawnSlot[subsector] < 0 &&
      this.hole[subsector] === 0 &&
      inIsland(this.island[subsector], drawnIsland)
    );
  }

  /** What {@link FogOfWar.updateFade} damps toward: {@link FogOfWar.drawnAt} as an alpha. */
  private targetAlpha(subsector: number, drawnIsland: number): number {
    return this.drawnAt(subsector, drawnIsland) ? 1 : 0;
  }

  /**
   * Puts every drawn alpha on its target with no fade, and reports the change as wholesale: this
   * bypasses the damping loop that files what moved. The spawn seed, a restore and an island change
   * all end on it.
   */
  private snapAlpha(): void {
    const drawnIsland = this.drawnIsland();
    for (let ss = 0; ss < this.alpha.length; ss++) this.alpha[ss] = this.targetAlpha(ss, drawnIsland);
    this.wallsAllChanged = true;
    this.boundsAllChanged = true;
  }

  /**
   * Follows slot `slot` into another island; the drawn slot's cuts rather than fades — arriving in
   * one means a teleport. docs/fogofwar.md § Islands.
   */
  private enterIsland(slot: number, next: number): void {
    const anchor = this.anchors[slot];
    if (next === NO_ISLAND || next === anchor.island) return;
    anchor.island = next;
    if (slot === this.drawn) this.snapAlpha();
  }

  /**
   * Folds island `other` into `into`, the one the ray was cast from: a sight ray reaching it is
   * proof the two are a single place. Relabelling in one pass keeps the per-leaf gate a single
   * compare, and a level has only as many merges to do as it has islands. Every slot standing in
   * the island folded away follows. docs/fogofwar.md § Islands.
   */
  private mergeIsland(other: number, into: number): void {
    for (let ss = 0; ss < this.island.length; ss++) {
      if (this.island[ss] === other) this.island[ss] = into;
    }
    for (const anchor of this.anchors) {
      if (anchor.island === other) anchor.island = into;
    }
  }
}

/**
 * Whether a leaf of island `id` passes island `gate`'s gate — a leaf that is nowhere always does.
 */
function inIsland(id: number, gate: number): boolean {
  return id === NO_ISLAND || id === gate;
}

/**
 * Whether a leaf's sight `s` can be in reveal range of a point at (px, py): reveal reaches exactly
 * as far as the player can see, so the bound is `VIEW_DISTANCE` itself. Squared, so a leaf this
 * rejects never pays for a root. docs/fogofwar.md § Reveal radius.
 */
function inReach(s: SubSectorSight, px: number, py: number): boolean {
  const dx = s.cx - px;
  const dy = s.cy - py;
  const reach = VIEW_DISTANCE + s.radius;
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * A hole in the wall is lower than this (tuned by feel: an 8-high sound channel is one, a 24-high
 * crawlspace is not) — the first of {@link findHoleSectors}' limits.
 * docs/fogofwar.md § Holes in the wall.
 */
const HOLE_BELOW_HEIGHT = 16;
/** …no wider than this across its bounding box (tuned by feel)… */
const HOLE_MAX_WIDTH = 16;
/** …walled in, by one-sided or shut lines, for at least this share of its boundary (tuned by feel)… */
const HOLE_MIN_WALLED = 0.5;
/** …and has no opening line this long, a body's width (tuned by feel). */
const HOLE_OPENING_BELOW = 32;

/**
 * The sectors too small to be a place — within all four `HOLE_*` limits, roofed (its ceiling below
 * that of every open neighbour a body fits in, so the top of a block standing just under a ceiling
 * is not one), and nothing a special drives. Read off the heights the map loads with.
 * docs/fogofwar.md § Holes in the wall.
 *
 * @returns per sector, 1 for a hole
 */
function findHoleSectors(world: World, movable: ReadonlySet<number>): Uint8Array {
  const map = world.map;
  const n = map.sectors.length;
  const minX = new Float64Array(n).fill(Infinity);
  const minY = new Float64Array(n).fill(Infinity);
  const maxX = new Float64Array(n).fill(-Infinity);
  const maxY = new Float64Array(n).fill(-Infinity);
  const perimeter = new Float64Array(n);
  const walled = new Float64Array(n);
  const wideOpening = new Uint8Array(n);
  const roof = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < map.linedefs.length; i++) {
    const line = map.linedefs[i];
    const a = map.vertexes[line.v1];
    const b = map.vertexes[line.v2];
    const front = map.sidedefs[line.right]?.sector ?? -1;
    const back = line.left === NO_SIDE ? -1 : (map.sidedefs[line.left]?.sector ?? -1);
    // Sides by index rather than over a pair array: this runs per line of the map at level load.
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? front : back;
      if (s < 0) continue;
      minX[s] = Math.min(minX[s], a.x, b.x);
      minY[s] = Math.min(minY[s], a.y, b.y);
      maxX[s] = Math.max(maxX[s], a.x, b.x);
      maxY[s] = Math.max(maxY[s], a.y, b.y);
    }
    // A line with the same sector on both sides runs through the sector, not round it.
    if (front < 0 || front === back) continue;
    const len = vecLength(b.x - a.x, b.y - a.y);
    if (back < 0) {
      perimeter[front] += len;
      walled[front] += len;
      continue;
    }
    const shut = world.blocksSight(i);
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? front : back;
      const other = map.sectors[side === 0 ? back : front];
      perimeter[s] += len;
      if (shut) {
        walled[s] += len;
        continue;
      }
      if (len >= HOLE_OPENING_BELOW) wideOpening[s] = 1;
      // A neighbour too low for a body is the same channel carrying on, not a room over it.
      if (other.ceilHeight - other.floorHeight >= HOLE_BELOW_HEIGHT) roof[s] = Math.min(roof[s], other.ceilHeight);
    }
  }
  const holes = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    const sector = map.sectors[s];
    const height = sector.ceilHeight - sector.floorHeight;
    if (height <= 0 || height >= HOLE_BELOW_HEIGHT || movable.has(s) || wideOpening[s]) continue;
    if (sector.ceilHeight >= roof[s]) continue;
    if (Math.min(maxX[s] - minX[s], maxY[s] - minY[s]) > HOLE_MAX_WIDTH) continue;
    if (perimeter[s] === 0 || walled[s] < perimeter[s] * HOLE_MIN_WALLED) continue;
    holes[s] = 1;
  }
  return holes;
}

/**
 * One player's sweep: the subsectors it may test **nearest that player first**, rebuilt once they
 * drift {@link ORDER_ANCHOR_SLACK} off the point it was built for, and where the budgeted scan
 * resumes. On a large level which subsector is scanned when decides what a tic's budget buys at
 * all; docs/fogofwar.md § Sweep order.
 */
interface SweepAnchor {
  order: Int32Array;
  /**
   * How much of {@link SweepAnchor.order} is live: entries past this are out of reveal range from
   * the anchor.
   */
  count: number;
  /** The point {@link SweepAnchor.order} was built for; `NaN` until the first build. */
  x: number;
  y: number;
  /**
   * Round-robin resume point into {@link SweepAnchor.order} — see {@link MAX_SIGHT_TESTS_PER_TIC}.
   */
  cursor: number;
  /**
   * The island this player stands in, kept through a leaf that is nowhere; {@link NO_ISLAND} until
   * it stood in one. docs/fogofwar.md § Islands.
   */
  island: number;
}
