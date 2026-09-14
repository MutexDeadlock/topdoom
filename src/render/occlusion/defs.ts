/**
 * What the two faders both stand on: the hole a sightline opens and the dials that shape it, the
 * boxes a frame's sightlines live inside, and the bag of crossings one pass files for the other.
 * See docs/render-occlusion.md.
 */
import type * as THREE from 'three';
import { WALL_CHUNK_LEN } from '../mapmesh.ts';
import type { Opening } from '../../game/world.ts';
import type { Pos3 } from '../../types.ts';

/**
 * Target coverage (0..1) once a wall sits on the camera-player sightline —
 * rendered as a dithered discard (see MaterialBank.get), not real alpha
 * blending, so this reads as "fraction of pixels kept," not translucency.
 */

export const FADE_ALPHA = 0.2;

/**
 * How wide a hole a sightline opens in whatever it is stopped by. Walls and flats share it, so a
 * hole spanning a floor and the wall behind it is one shape. **Tuned by feel**, but sized off the
 * chunk rather than set as a bare number: alpha exists only at chunk corners, so a
 * {@link FADE_CORE} under `WALL_CHUNK_LEN / 2` cannot open a hole wider than one chunk, which on a
 * tall occluder seen at a grazing angle reads as a slit.
 * docs/render-occlusion.md § The fade is a hole, not a wall.
 */
export const FADE_RADIUS = WALL_CHUNK_LEN * 1.5;

/**
 * The core is this fraction of whatever radius a target carries, so every
 * target's hole is the one shape scaled. Stated once, here: {@link holeAlpha} shapes
 * the ramp through it and {@link FADE_CORE} is the player's own radius through it, so
 * retuning the ratio moves the renderer and the tests together.
 */
const FADE_CORE_FRACTION = 0.5;

export const FADE_CORE = FADE_RADIUS * FADE_CORE_FRACTION;

/**
 * How far an awake monster can be and still count as a fade target. **Tuned by feel** to roughly a
 * room's length, not converted from vanilla. Deliberately a plain distance cap rather than a
 * `hasLineOfSight` gate, which would make the fade a no-op for the case it exists for —
 * docs/render-occlusion.md § Wall occlusion fading.
 */
export const MONSTER_FADE_RANGE = 768;

/**
 * How wide a hole an awake *monster* opens, against the player's {@link FADE_RADIUS} —
 * **tuned by feel**, and deliberately under a whole chunk: its core is under `WALL_CHUNK_LEN / 2`,
 * so it can read as a slit. docs/render-occlusion.md § Which sightlines a wall fades for.
 */
export const MONSTER_FADE_RADIUS = FADE_RADIUS / 2;

/**
 * The alpha one crossing pulls a point at `distanceSquared` from it down to: `floor` inside the
 * core ({@link FADE_CORE_FRACTION} of `radius`), smoothstepped back to 1 by `radius`, and 1 beyond.
 * The one ramp both faders window with. docs/render-occlusion.md § The fade is a hole, not a wall.
 */
export function holeAlpha(distanceSquared: number, floor: number, radius: number): number {
  if (distanceSquared >= radius * radius) return 1;
  const core = radius * FADE_CORE_FRACTION;
  const d = Math.sqrt(distanceSquared);
  if (d <= core) return floor;
  const t = (d - core) / (radius - core);
  return floor + (1 - floor) * t * t * (3 - 2 * t);
}

/** Exponential smoothing rate (1/seconds) so fades don't pop in/out per frame. */
export const FADE_SPEED = 10;

/** Snap-to-target threshold for `dampen` — see its doc for why this matters. */
export const SNAP_EPS = 0.004;

/**
 * What occlusion is tested against — the player, or an awake monster. Not a point: `z` is the
 * middle of an **upright sprite** and `halfHeight` how far it reaches either side, so a sightline
 * is a wedge rather than a ray. `fadeFloor` is how far down this target pulls what hides it
 * ({@link FADE_ALPHA} is full strength) and `fadeRadius` how wide a hole it opens.
 * docs/render-occlusion.md § The target is the billboard.
 */
export type FadeTarget = Pos3 & { halfHeight: number; fadeFloor: number; fadeRadius: number };

/**
 * Per target, for the frame: the **vertical** plane its sprite stands in.
 * Nothing behind that plane can be hiding the target, so nothing there fades —
 * see docs/render-occlusion.md § The target is the billboard. Both faders keep one,
 * refilled per `update`; the hole dials stay on the target itself, which every
 * read site already holds.
 */
export class TargetPlanes {
  /**
   * The camera→target offset in plan, and `dot(n, target)`: `dot(n, p) > d0` is past the target.
   * Deliberately **not** normalized — every test compares two dot products against this same `n`,
   * so scaling changes neither side, and the hypot-and-two-divides per target is measurable across
   * the thousand-odd mover faders a frame refills.
   * docs/render-occlusion.md § The target is the billboard.
   *
   * A camera standing exactly over a target in plan leaves `n` and {@link TargetPlanes.d0} both
   * zero, and `0 > 0`
   * cuts nothing — the hole goes back to the whole ball. `MIN_TILT_DEG` keeps the player off that
   * point; a monster can stand on it for a frame.
   */
  nx = new Float64Array(0);
  ny = new Float64Array(0);
  d0 = new Float64Array(0);

  /** Refills for this frame's targets, growing on demand. */
  fill(camX: number, camY: number, targets: readonly FadeTarget[]): void {
    if (this.nx.length < targets.length) {
      const n = targets.length;
      this.nx = new Float64Array(n);
      this.ny = new Float64Array(n);
      this.d0 = new Float64Array(n);
    }
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k];
      const nx = t.x - camX;
      const ny = t.y - camY;
      this.nx[k] = nx;
      this.ny[k] = ny;
      this.d0[k] = nx * t.x + ny * t.y;
    }
  }
}

/** A 2D box in DOOM map space, for {@link fadeReach}'s caller to test its own geometry against. */
export interface FadeBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Grows `box` to hold one more point. */
export function stretchBox(box: FadeBox, x: number, y: number): void {
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (y < box.minY) box.minY = y;
  if (y > box.maxY) box.maxY = y;
}

/**
 * Whether two map-space boxes touch at all — a mover's footprint against a fade
 * reach or a reveal, or a fader's against the frame's bag of crossings. An
 * empty box ({@link emptyBox}, never stretched) overlaps nothing, which is the answer
 * a fader with no quads and a bag with no points both want.
 */
export function boxesOverlap(a: FadeBox, b: FadeBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** An inverted box, which {@link stretchBox} turns into the bound of whatever it is then given. */
export function emptyBox(): FadeBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

/** `box` grown on every side by `by`, written into `out` — an empty box stays empty. */
export function grownBox(box: FadeBox, by: number, out: FadeBox): FadeBox {
  out.minX = box.minX - by;
  out.minY = box.minY - by;
  out.maxX = box.maxX + by;
  out.maxY = box.maxY + by;
  return out;
}

/**
 * {@link sightBox}'s output, reused: the two faders run back to back and neither holds the box
 * past its own update.
 */
const sightBoxOut = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

/**
 * The box every sightline of one frame lives inside — the camera, stretched over every target. A
 * line side or a fan whose own bounds miss it cannot be crossed by any sightline, which is what
 * both faders reject on before any crossing work. Exact, not a heuristic.
 * docs/render-occlusion.md § The fade is a hole, not a wall.
 */
export function sightBox(camX: number, camY: number, targets: FadeTarget[]): typeof sightBoxOut {
  let minX = camX;
  let maxX = camX;
  let minY = camY;
  let maxY = camY;
  for (const t of targets) {
    if (t.x < minX) minX = t.x;
    if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.y > maxY) maxY = t.y;
  }
  sightBoxOut.minX = minX;
  sightBoxOut.maxX = maxX;
  sightBoxOut.minY = minY;
  sightBoxOut.maxY = maxY;
  return sightBoxOut;
}

/** The widest hole any of this frame's targets opens — how far a crossing can fold. */
export function maxFadeRadius(targets: readonly FadeTarget[]): number {
  let radius = 0;
  for (const t of targets) if (t.fadeRadius > radius) radius = t.fadeRadius;
  return radius;
}

/**
 * Everything this frame's fading can reach: the sight box above, grown by the
 * widest hole any of the targets opens. A crossing lies on a sightline and so
 * inside that box, and it folds nothing further than its own radius, so
 * geometry outside this box cannot change — which is what lets
 * `MoverGeometry.updateFading` skip a mesh outright once its faders are also
 * `idle`. See docs/render-occlusion.md § Mover meshes a frame cannot touch.
 */
export function fadeReach(camX: number, camY: number, targets: FadeTarget[], out: FadeBox): void {
  grownBox(sightBox(camX, camY, targets), maxFadeRadius(targets), out);
}

/**
 * The quads a `commit` caller knows fog of war moved this frame — {@link ChangedQuads.count}
 * entries of {@link ChangedQuads.indices}, which is a reused buffer and longer than the count.
 * Declared structurally here rather than imported, so the render layer keeps no import edge into
 * `game/fogofwar.ts`, as `render/scroller.ts`'s `ScrollOffsets` is. `null` means "assume all of
 * them", which is what a wholesale reveal reports.
 */
export interface ChangedQuads {
  readonly indices: Int32Array;
  readonly count: number;
}

/**
 * Caches each record's colour buffer by its mesh key, so a commit never looks one up per quad.
 * Both faders re-run it whenever a rebuild may have moved a record to another batch — see their
 * own `attrs` for when that is.
 */
export function resolveColorAttrs(
  records: readonly { key: string }[],
  meshes: Map<string, THREE.Mesh>,
  out: (THREE.BufferAttribute | undefined)[],
): void {
  out.length = records.length;
  for (let i = 0; i < records.length; i++) {
    out[i] = meshes.get(records[i].key)?.geometry.getAttribute('color') as
      | THREE.BufferAttribute
      | undefined;
  }
}

/**
 * Everything the frame's fade varies by: where the camera is, what it is looking past, and the wall
 * half's opening lookup.
 */
export interface FadeFrame {
  dt: number;
  /** The camera in DOOM (x, y, height) — not three.js space. */
  camX: number;
  camY: number;
  camZ: number;
  targets: FadeTarget[];
  openingInto: (line: number, out: Opening) => boolean;
}

/**
 * A growable bag of the points a pass-one sweep found — where a sightline was stopped, and the
 * index of the target it was stopped for (everything else about the hole belongs to that target).
 * One bag holds a whole frame's stops across **every** fader of its kind; walls and flats keep one
 * each. docs/render-occlusion.md § One hole, whichever mesh it lands in.
 */
export class FadeCrossings {
  x: Float64Array = new Float64Array(64);
  y: Float64Array = new Float64Array(64);
  /**
   * The height the sightline was stopped at: a wall crossing's, or the plane a floor pierce sits
   * in.
   */
  h: Float64Array = new Float64Array(64);
  /** Which target's sightline was stopped here — an index into {@link TargetPlanes}. */
  target: Float64Array = new Float64Array(64);
  count = 0;
  /**
   * Where the whole bag stands, grown as points arrive. Kept here rather than derived by each
   * reader because the bag is the frame's, not a fader's: every fader that folds it would otherwise
   * rebuild the same box, and only {@link FadeCrossings.push} can change the answer. Empty
   * (inverted) until the first point.
   */
  readonly bounds: FadeBox = emptyBox();

  reset(): void {
    this.count = 0;
    this.bounds.minX = Infinity;
    this.bounds.minY = Infinity;
    this.bounds.maxX = -Infinity;
    this.bounds.maxY = -Infinity;
  }

  push(x: number, y: number, h: number, target: number): void {
    if (this.count === this.x.length) {
      this.x = grow(this.x);
      this.y = grow(this.y);
      this.h = grow(this.h);
      this.target = grow(this.target);
    }
    this.x[this.count] = x;
    this.y[this.count] = y;
    this.h[this.count] = h;
    this.target[this.count] = target;
    this.count++;
    stretchBox(this.bounds, x, y);
  }
}

function grow(a: Float64Array): Float64Array {
  const next = new Float64Array(a.length * 2);
  next.set(a);
  return next;
}
