/**
 * Small structural types shared across layers, for shapes that were otherwise
 * spelled out inline (`{ x: number; y: number; z: number }`) in a dozen
 * signatures each, or passed as loose scalar parameter runs.
 *
 * These are **structural**, deliberately: `Player`, `PosedThing`, `MonsterBody`
 * and the WAD's own `Thing` all already carry `x`/`y`(/`z`) fields, so they
 * satisfy `Pos2`/`Pos3` without any conversion or allocation at a call site.
 * That's what makes it safe to take one of these as a parameter even in
 * per-frame code — the caller passes the object it already has.
 *
 * Coordinates here are always **DOOM map space** (x east, y north, z up =
 * feet height), never three.js space — `render/mapmesh.ts: doomToWorld` is
 * the one place the two meet, and `THREE.Vector3` is used on the other side
 * of it. Nothing in this file is a direction or a velocity: those are stored
 * as separate `velX`/`velY`/`velZ` fields by everything that has them, and
 * headings are plain `angle` numbers.
 */

/** A point on the DOOM map plane. */
export interface Pos2 {
  x: number;
  y: number;
}

/** A point in the world: map plane plus feet height. */
export interface Pos3 extends Pos2 {
  z: number;
}

/**
 * A spot plus which way to face on arrival — a player start, a teleport
 * landing. `angle` is **radians**, matching `Player.angle`/`MonsterBody.angle`
 * rather than the WAD's own degrees: every producer here (`World.playerStart`,
 * `SpecialsController.findTeleportDestination`) already converts on the way
 * out. Two consumers used to convert a second time on the way back in, which
 * this type existing is what caught.
 */
export interface Placement extends Pos2 {
  angle: number;
}
