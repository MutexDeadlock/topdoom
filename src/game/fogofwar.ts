import { buildSubSectorPolys } from '../render/bsp.ts';
import { segmentIntersect } from '../util/geom.ts';
import { dampen } from '../util/damping.ts';
import type { WallOccluder } from '../render/mapmesh.ts';
import type { World } from './world.ts';

/**
 * How far the player can reveal, in map units — derived from what the camera
 * actually frames, not tuned by feel. With `TopDownCamera`'s defaults the eye
 * sits `cos(60°)·480 = 240` above the followed point and `sin(60°)·480 = 416`
 * behind it, looking 30° below horizontal; the top edge of a 55° vertical FOV
 * is then 2.5° below horizontal and meets the floor `240/tan(2.5°) ≈ 5500`
 * out, i.e. ~5080 past the player. A radius shorter than that leaves geometry
 * the player is plainly looking at sitting in the dark — and, because
 * `ThingLayer` gates both rendering and shootability on fog alpha, a monster
 * standing in it is invisible *and* unhittable while it shoots back.
 * See docs/fogofwar.md § Reveal radius.
 */
const SIGHT_RADIUS = 5100;
/** Exponential smoothing rate (1/seconds) for the reveal, gentler than wall occlusion. */
const FADE_SPEED = 3;
/** Snap-to-target threshold for `dampen` — see its doc for why this matters. */
const SNAP_EPS = 0.004;

/**
 * Cap on how many not-yet-explored subsectors get their sample rays tested in
 * one `update` call. Tuned by feel against freedoom2 MAP03 (315 sectors, 2855
 * linedefs, 1531 subsectors): with no cap, the initial reveal sweep — every
 * unexplored subsector's sample points against every blocker within
 * `SIGHT_RADIUS` — measured 8.6ms/frame with the player standing still at
 * spawn, over half a 60fps budget before rendering runs at all, vs. ~0.3-0.4ms
 * on DOOM2 MAP02/E1M1. The cap turns that one-frame spike into a sweep spread
 * over several frames (`scanCursor` picks up where the last call left off,
 * round-robin), which is invisible: reveal already fades in over `FADE_SPEED`
 * seconds, so a few frames' delay before a subsector's fade even starts is
 * well under the threshold of "late". A subsector that fails every sample
 * this frame (out of range, or blocked) is simply retried on the next pass
 * through the array — no state is lost, `pending` just shrinks slower on a
 * level big enough to need the cap at all.
 */
const MAX_SIGHT_TESTS_PER_FRAME = 200;

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
 * Hides the parts of the level the player hasn't seen yet — without which the
 * dollhouse camera shows every room, including ones reached much later and
 * ones flagged secret, at once.
 *
 * State is **per subsector, not per sector**, and that distinction is the
 * whole ballgame. A DOOM sector is a logical grouping, not a place: one sector
 * number routinely covers scattered, disconnected chunks of a map, and even a
 * single connected one can be enormous. DOOM2 MAP02's inner water ring is one
 * sector spanning 21 subsectors and 18% of the map's floor area — revealing
 * per sector meant catching a glimpse of any one corner of it lit the entire
 * ring, which is exactly the bug this granularity fixes. Subsectors are the
 * BSP's convex leaves, i.e. actual places, so they reveal one at a time.
 *
 * Reveal is **sticky on sight**: a subsector the player has had line of sight
 * to stays lit for good, like DOOM's own automap filling in as you explore.
 * An earlier design kept sight-only reveals transient (fading back to black
 * once out of view) and made just the sectors walked through permanent, but at
 * subsector granularity "walked through" is a one-tile-wide trail — a room
 * would go dark behind the player except for a thin lit path through it, and
 * every camera orbit would flicker subsectors in and out. Once seen, kept.
 *
 * Sight is the *only* rule — in particular there is deliberately no special
 * case for sectors flagged secret (`special === 9`). That flag means "counts
 * toward the level's secret tally when entered", not "hidden from view", and
 * mappers apply it to places that are in plain sight: DOOM2 MAP01's secret is
 * the outdoor grass strip you look straight down onto through the big window,
 * with non-secret water beyond it. Excluding secrets from sight reveal punched
 * that strip out as a black hole in the middle of a view the player plainly
 * had, water and all. What actually hides a secret is geometry, and
 * `World.blocksSight` already models that faithfully: across DOOM E1M1-E1M8
 * and DOOM2 MAP01-MAP10, none of the 197 secret subsectors is visible from the
 * player start, so nothing is given away before the player has walked up and
 * looked at it — which is exactly what vanilla shows them too.
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

  /** Round-robin resume point into `sights` for `update`'s budgeted scan — see `MAX_SIGHT_TESTS_PER_FRAME`. */
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
    // black on frame one — a large dt drives the lerp below straight to
    // target, and `Infinity` bypasses `MAX_SIGHT_TESTS_PER_FRAME` so this one
    // call still reveals everything visible from spawn instead of leaving
    // some of it to fade in over the first few real frames.
    this.update(10, startX, startY, Infinity);
  }

  /** Player position in DOOM (x, y) coordinates. */
  update(dt: number, playerX: number, playerY: number, sightTestBudget = MAX_SIGHT_TESTS_PER_FRAME): void {
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

    for (let ss = 0; ss < this.alpha.length; ss++) {
      const target = this.explored[ss];
      if (this.alpha[ss] === target) continue;
      this.alpha[ss] = dampen(this.alpha[ss], target, FADE_SPEED, dt, SNAP_EPS);
    }
  }

  /**
   * Collects the sight-blocking lines within reach once per frame, so the
   * per-subsector rays below test a small flat array instead of each redoing
   * the grid lookup. Rebuilt every frame rather than cached at load, because
   * `blocksSight` reads live sector heights — once doors move, a door that
   * opens has to stop blocking on the very next frame.
   *
   * Each segment is stored slightly overlong (`BLOCKER_OVERLAP`). Where two
   * blockers meet at a shared vertex — a door leaf and its frame, two walls at
   * a corner — a ray aimed at that exact point passes just outside the end of
   * both and neither reports an intersection, so sight squirts through the
   * pinhole into the room beyond. (Measured: a sample point beside DOOM2
   * MAP02's closed door cleared the frame corner by 0.1 map units and lit the
   * room behind it.) A quarter-unit overlap closes those junctions and stays
   * far below the width of any real opening — vanilla's narrowest doorways are
   * 64 units across. Bigger is not better: at 0.5 the extended ends start
   * clipping sight that legitimately grazes along a wall, costing visibly more
   * wrongly-dark subsectors for no further leak closed.
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
   * Marks the whole level explored — the computer area map powerup
   * (`game/inventory.ts`'s `COMPUTER_MAP_TYPE`), which in vanilla fills in the
   * automap for the entire level at once. Here that *is* the whole effect:
   * this engine's map view and its play view are the same view, so revealing
   * the geometry is exactly what vanilla's own `pw_allmap` does to the automap.
   *
   * Only the `explored` flags are set, not `alpha` — the ordinary per-frame
   * lerp below fades the level in over `FADE_SPEED` instead of snapping it on,
   * which reads as the map drawing itself rather than a hard cut. Setting
   * `pending` to 0 also retires the sight-sampling loop above for the rest of
   * the level, since there is nothing left it could reveal.
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
