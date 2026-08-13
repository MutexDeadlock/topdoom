/**
 * Fog of war: hides the parts of the level the player hasn't seen yet, revealing per subsector,
 * sticky on sight. See docs/fogofwar.md.
 */
import { buildSubSectorPolys } from '../render/bsp.ts';
import { segmentIntersect } from '../util/geom.ts';
import { dampen } from '../util/damping.ts';
import { decodeRuns, encodeRuns } from './snapshot.ts';
import type { WallOccluder } from '../render/mapmesh.ts';
import type { World } from './world.ts';

/**
 * How far the player can reveal, in map units — derived from what the camera actually frames, not
 * tuned by feel; the geometry, and why falling short of the frame is a gameplay bug, is
 * docs/fogofwar.md § Reveal radius. Bracketed by tests/regression/fog-reveal-radius.test.ts.
 */
const SIGHT_RADIUS = 5100;
/** Exponential smoothing rate (1/seconds) for the reveal, gentler than wall occlusion. */
const FADE_SPEED = 3;
/** Snap-to-target threshold for `dampen` — see its doc for why this matters. */
const SNAP_EPS = 0.004;

/**
 * Cap on how many not-yet-explored subsectors get their sample rays tested in one `tick` call
 * (tuned by feel; `scanCursor` round-robins the rest onto later tics). Counted per tic, not per
 * frame — `explored` is a gameplay input, so the sweep rate must not depend on framerate.
 * See docs/fogofwar.md § Reveal radius.
 */
const MAX_SIGHT_TESTS_PER_TIC = 350;

/**
 * How far a wall's probe point is pushed off its own face, so it lands inside
 * the subsector that wall bounds rather than exactly on the boundary.
 */
const WALL_PROBE_OFFSET = 1.5;
/** How far a boundary sample is pulled toward the centroid, to keep it off the walls. */
const BOUNDARY_INSET = 0.25;
/** Map units each sight blocker is extended past both ends — see refreshBlockers. */
const BLOCKER_OVERLAP = 0.25;

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

  /** Sight-blocking lines near the player, refreshed each frame as x1,y1,x2,y2 runs. */
  private blockers: number[] = [];

  /** Round-robin resume point into `sights` for `tick`'s budgeted scan — see `MAX_SIGHT_TESTS_PER_TIC`. */
  private scanCursor = 0;

  constructor(world: World, occluders: WallOccluder[], startX: number, startY: number) {
    this.world = world;
    const map = world.map;
    const polys = buildSubSectorPolys(map);

    this.sights = new Array(polys.length).fill(null);
    this.explored = new Uint8Array(polys.length);
    this.alpha = new Float32Array(polys.length);

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

      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        cx += poly.points[i * 2];
        cy += poly.points[i * 2 + 1];
      }
      cx /= n;
      cy /= n;

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
        const mx = (kx + poly.points[j * 2]) / 2;
        const my = (ky + poly.points[j * 2 + 1]) / 2;
        for (const [px, py] of [
          [kx, ky],
          [mx, my],
        ]) {
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

    // Which subsector each wall quad faces into, so a wall reveals with the
    // space it encloses. mapmesh builds every quad with its face to the right
    // of a->b, so nudging the midpoint along that normal lands just inside.
    this.wallSubsector = new Int32Array(occluders.length);
    for (let i = 0; i < occluders.length; i++) {
      const o = occluders[i];
      this.wallSubsector[i] = this.probeWallSubsector(o.ax, o.ay, o.bx, o.by);
    }

    // Seed the spawn's surroundings fully revealed instead of fading up from
    // black on frame one. `Infinity` bypasses `MAX_SIGHT_TESTS_PER_TIC` so this
    // one call reveals everything visible from spawn rather than leaving some of
    // it to fade in over the first few tics; the alpha snap below is what skips
    // the fade itself.
    this.tick(startX, startY, Infinity);
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
  }

  /**
   * One tic of reveal: marks newly seen subsectors `explored`. Player position
   * in DOOM (x, y) coordinates.
   *
   * On the **simulation** clock, because `explored` decides what can be shot
   * (`isVisible`). The visual fade is `updateFade`, which is not.
   * docs/fogofwar.md § What gameplay reads.
   */
  tick(playerX: number, playerY: number, sightTestBudget = MAX_SIGHT_TESTS_PER_TIC): void {
    const currentSS = this.world.subsectorAt(playerX, playerY);
    if (currentSS >= 0 && currentSS < this.explored.length && !this.explored[currentSS]) {
      this.explored[currentSS] = 1;
      this.pending--;
    }

    if (this.pending > 0) {
      this.refreshBlockers(playerX, playerY);

      const n = this.sights.length;
      let budget = sightTestBudget;
      let ss = this.scanCursor;
      for (let steps = 0; steps < n && budget > 0; steps++) {
        if (!this.explored[ss]) {
          const s = this.sights[ss];
          if (s && !(Math.hypot(s.cx - playerX, s.cy - playerY) - s.radius > SIGHT_RADIUS)) {
            budget--;
            for (let i = 0; i < s.samples.length; i += 2) {
              if (this.sightClear(playerX, playerY, s.samples[i], s.samples[i + 1])) {
                this.explored[ss] = 1;
                this.pending--;
                break;
              }
            }
          }
        }
        ss = ss + 1 < n ? ss + 1 : 0;
      }
      this.scanCursor = ss;
    }
  }

  /**
   * Fades each subsector's drawn alpha toward whether it is explored. Purely
   * cosmetic and on the **render** clock: nothing in the simulation reads
   * `alpha`, which is what lets this stay framerate-smooth without making
   * shootability framerate-dependent.
   */
  updateFade(dt: number): void {
    for (let ss = 0; ss < this.alpha.length; ss++) {
      const target = this.explored[ss];
      if (this.alpha[ss] === target) continue;
      this.alpha[ss] = dampen(this.alpha[ss], target, FADE_SPEED, dt, SNAP_EPS);
    }
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
   * Collects the sight-blocking lines within reach once per frame — rebuilt live rather than
   * cached because `blocksSight` reads current sector heights — each stored `BLOCKER_OVERLAP`
   * overlong so a ray can't squirt through a shared-vertex junction. See docs/fogofwar.md.
   */
  private refreshBlockers(playerX: number, playerY: number): void {
    const map = this.world.map;
    this.blockers.length = 0;
    for (const i of this.world.linesNear(playerX, playerY, SIGHT_RADIUS)) {
      if (!this.world.blocksSight(i)) continue;
      const line = map.linedefs[i];
      const a = map.vertexes[line.v1];
      const b = map.vertexes[line.v2];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const ex = len > 0 ? (dx / len) * BLOCKER_OVERLAP : 0;
      const ey = len > 0 ? (dy / len) * BLOCKER_OVERLAP : 0;
      this.blockers.push(a.x - ex, a.y - ey, b.x + ex, b.y + ey);
    }
  }

  /** True if no sight-blocking line lies between the player and (tx, ty). */
  private sightClear(px: number, py: number, tx: number, ty: number): boolean {
    const minX = px < tx ? px : tx;
    const maxX = px < tx ? tx : px;
    const minY = py < ty ? py : ty;
    const maxY = py < ty ? ty : py;

    for (let i = 0; i < this.blockers.length; i += 4) {
      const ax = this.blockers[i];
      const ay = this.blockers[i + 1];
      const bx = this.blockers[i + 2];
      const by = this.blockers[i + 3];
      // Bounding-box reject first: most candidates are nowhere near this ray.
      if ((ax < minX && bx < minX) || (ax > maxX && bx > maxX)) continue;
      if ((ay < minY && by < minY) || (ay > maxY && by > maxY)) continue;
      if (segmentIntersect(px, py, tx, ty, ax, ay, bx, by)) return false;
    }
    return true;
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
   * Reveal alpha for a wall quad that isn't in the static occluder list —
   * game/specials.ts's mover geometry (door/lift walls), which is built and
   * rebuilt on its own and so was never indexed in the constructor loop
   * above. Same probe, computed on demand instead of cached; movers only
   * ever have a handful of quads, so this costs nothing per frame.
   */
  wallAlphaAt(ax: number, ay: number, bx: number, by: number): number {
    return this.alphaOf(this.probeWallSubsector(ax, ay, bx, by));
  }

  private probeWallSubsector(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (ax + bx) / 2 + (dy / len) * WALL_PROBE_OFFSET;
    const my = (ay + by) / 2 + (-dx / len) * WALL_PROBE_OFFSET;
    return this.world.subsectorAt(mx, my);
  }
}
