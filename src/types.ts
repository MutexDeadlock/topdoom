/**
 * Small structural types shared across layers, for shapes that were otherwise
 * spelled out inline (`{ x: number; y: number; z: number }`) in a dozen
 * signatures each, or passed as loose scalar parameter runs.
 *
 * These are **structural**, deliberately: `Player`, `PosedThing`, `MonsterBody` and the WAD's own
 * `Thing` all already carry `x`/`y`(/`z`), so they satisfy {@link Pos2}/{@link Pos3} with no
 * conversion and no allocation at a call site — which is what makes one safe to take even in
 * per-frame code.
 *
 * Cross-cutting, so there is no `docs/` page of its own. The rest of the rule — always DOOM map
 * space, never a direction or a velocity — is CLAUDE.md § Position types; when to take one rather
 * than stay on scalars is docs/conventions.md § Named arguments.
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
 * landing. {@link Placement.angle} is **radians**, matching `Player.angle`/`MonsterBody.angle`
 * rather than the WAD's own degrees: every producer here (`World.playerStart`,
 * `SpecialsController.findTeleportDestination`) already converts on the way
 * out, so a consumer converts again at its peril.
 */
export interface Placement extends Pos2 {
  angle: number;
}
