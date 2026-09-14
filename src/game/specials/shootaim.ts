/**
 * Where the pointer's aim ray meets a shoot-triggered line: the wall bands of such a
 * line a shot can actually be stopped by, and the point on one of them auto-aim locks
 * onto. `SpecialsController.pickShootTarget` supplies the candidates; see
 * docs/combat.md § Auto-aim.
 */
import * as THREE from 'three';
import { worldToDoom } from '../../render/mapmesh.ts';
import { NO_SIDE } from '../../wad/map.ts';
import type { Opening, World } from '../world.ts';
import type { Pos3 } from '../../types.ts';
import { vecLength } from '../../util/geom.ts';

/** A shoot-trigger line the pointer is over, and the point on it a shot should be aimed at. */
export interface ShootAim extends Pos3 {
  lineIndex: number;
}

/**
 * How far outside a band's drawn rectangle the pointer still counts as over it,
 * in map units — tuned by feel. A switch is a thin strip seen almost edge-on from
 * a camera hanging overhead, and DOOM2 MAP16's own shoot-switch lines are 12 and
 * 40 units long; picked to the pixel they would be practically unclickable.
 */
const PICK_TOLERANCE = 16;

/**
 * How far inside a band's edges the aim point is kept, in map units —
 * tuned by feel. The shot is traced along its own line from the player, so its height
 * where it crosses is only as exact as that arithmetic: aiming *at* a band edge
 * risks landing a unit the wrong side of it and passing straight through the line.
 */
const BAND_INSET = 4;

/**
 * Which of `lines` the pointer is over and where on it to aim, or null. The ray is tested against
 * each line's shootable **bands**, not its whole face, so the pointer over a window's opening picks
 * nothing and the shot goes through it as aimed. The nearest band hit wins, and the aim height is
 * then taken from whichever band of that line sits closest to `fireZ` — the flattest shot that
 * still strikes the line, since a steeper one only offers more geometry in between to run into.
 *
 * @param ray    the cursor ray, in three.js space (`TopDownCamera.rayFor`)
 * @param aimAt  the point on the aim plane the ray was cast toward
 * @param lines  every shoot-trigger line still able to fire
 * @param fireZ  the height the shot leaves the player at
 */
export function pickShootAim(
  world: World,
  ray: THREE.Ray,
  aimAt: Pos3,
  lines: readonly number[],
  fireZ: number,
): ShootAim | null {
  // DOOM space throughout: every candidate is map geometry, and the ray is the
  // only thing here that arrives in three.js space. `worldToDoom` maps the
  // direction as faithfully as the origin — the permutation has no translation.
  const { x: ox, y: oy, z: oz } = worldToDoom(ray.origin.x, ray.origin.y, ray.origin.z);
  const { x: dx, y: dy, z: dz } = worldToDoom(ray.direction.x, ray.direction.y, ray.direction.z);

  const opening: Opening = { top: 0, bottom: 0 };
  let best: ShootAim | null = null;
  // The body pick's ground bound, plus `PICK_TOLERANCE` of slack for the face the ray is stopped
  // *by* — which is one the pointer may well be over. docs/combat.md § Auto-aim.
  let bestT = world.groundReach({ x: ox, y: oy, z: oz }, aimAt) + PICK_TOLERANCE;

  for (const lineIndex of lines) {
    const line = world.map.linedefs[lineIndex];
    if (!line) continue;
    const a = world.map.vertexes[line.v1];
    const b = world.map.vertexes[line.v2];
    if (!a || !b) continue;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const len = vecLength(sx, sy);
    if (len === 0) continue;
    // Where the ray meets the upright plane the line's face lies in; `denom` is
    // zero looking straight along it, where a face of no apparent width can't
    // be pointed at anyway.
    const denom = (dx * sy - dy * sx) / len;
    if (denom > -1e-6 && denom < 1e-6) continue;
    const t = ((a.x - ox) * sy - (a.y - oy) * sx) / len / denom;
    if (t <= 0 || t >= bestT) continue;
    const along = ((ox + dx * t - a.x) * sx + (oy + dy * t - a.y) * sy) / len;
    if (along < -PICK_TOLERANCE || along > len + PICK_TOLERANCE) continue;

    const hz = oz + dz * t;
    let hit = false;
    let aimZ = 0;
    let bestDelta = Infinity;
    for (const band of shootableBands(world, lineIndex, opening)) {
      if (hz >= band.lo - PICK_TOLERANCE && hz <= band.hi + PICK_TOLERANCE) {
        hit = true;
      }
      const z = aimHeightIn(band, fireZ);
      const delta = Math.abs(z - fireZ);
      if (delta < bestDelta) {
        bestDelta = delta;
        aimZ = z;
      }
    }
    if (!hit) continue;

    // The aim point is kept inside the line's own ends: a hit within the
    // tolerance margin past one would otherwise aim at the line's *extension*,
    // which the shot goes on to cross nothing at.
    const inset = Math.min(BAND_INSET, len / 2);
    const s = clamp(along, inset, len - inset);
    bestT = t;
    best = { x: a.x + (sx / len) * s, y: a.y + (sy / len) * s, z: aimZ, lineIndex };
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A vertical stretch of a line's face that stops a shot — the solid wall above and/or below its
 * opening.
 */
interface Band {
  lo: number;
  hi: number;
}

/**
 * The bands of `lineIndex` a shot is stopped by — what `blocksShot`
 * (`game/world.ts`) says no to, as rectangles rather than as a predicate. A
 * one-sided line, and a two-sided one whose opening has closed, are solid over
 * their whole face; anything else is solid below the opening and above it, which
 * is exactly where a two-sided line's lower and upper textures are drawn.
 *
 * Read live off the sectors, so a rising door or a lowering lift moves the bands with it.
 */
function shootableBands(world: World, lineIndex: number, opening: Opening): Band[] {
  const { linedefs, sidedefs, sectors } = world.map;
  const line = linedefs[lineIndex];
  if (!line || line.right === NO_SIDE) return [];
  const front = sectors[sidedefs[line.right]?.sector];
  if (!front) return [];
  const back = line.left === NO_SIDE ? undefined : sectors[sidedefs[line.left]?.sector];
  const lo = back ? Math.min(front.floorHeight, back.floorHeight) : front.floorHeight;
  const hi = back ? Math.max(front.ceilHeight, back.ceilHeight) : front.ceilHeight;
  if (!back || !world.openingInto(lineIndex, opening) || opening.top <= opening.bottom) {
    return hi > lo ? [{ lo, hi }] : [];
  }
  const bands: Band[] = [];
  if (opening.bottom > lo) bands.push({ lo, hi: opening.bottom });
  if (hi > opening.top) bands.push({ lo: opening.top, hi });
  return bands;
}

/** Where in a band to aim a shot fired from `fireZ`: as flat a shot as the band admits. */
function aimHeightIn(band: Band, fireZ: number): number {
  const lo = band.lo + BAND_INSET;
  const hi = band.hi - BAND_INSET;
  if (lo >= hi) return (band.lo + band.hi) / 2;
  return clamp(fireZ, lo, hi);
}
