/**
 * The blinking line a hitscan shot draws from muzzle to impact, plus the gap, fade and retraction
 * that keep it from hanging behind a shooter who kept moving. See docs/combat.md § Effects and
 * their batching.
 */
import * as THREE from 'three';
import { doomToWorld } from './mapmesh.ts';
import { DOOM_TIC } from '../constants.ts';
import type { Pos3 } from '../types.ts';

/** Total lifetime of a hitscan tracer, in seconds. */
const TRACER_LIFETIME = 0.15;
/** How often the tracer toggles on/off during its lifetime, in seconds per toggle. */
const BLINK_INTERVAL = 0.03;
/**
 * How far past the shooter's own body the line starts, in map units — added to their
 * radius, not compared against it. Tuned by feel; docs/combat.md § Effects and their
 * batching for why it is measured from the body rather than the centre.
 */
const MUZZLE_GAP = 16;
/**
 * The most of a shot's own length `MUZZLE_GAP` may eat, so a point-blank shot still
 * draws a line rather than nothing. Tuned by feel.
 */
const MUZZLE_GAP_MAX_FRACTION = 0.6;
/**
 * Map units per second the muzzle end withdraws toward the impact. Tuned by feel, but
 * bounded from below by the player's own top speed (`game/player.ts`) — docs/combat.md
 * § Effects and their batching.
 */
const RETRACT_SPEED = 1400;
/**
 * How long a tracer has already aged when it is first drawn, since it is spawned and
 * advanced in the same tic — retraction measures from there rather than from spawn.
 * docs/combat.md § Effects and their batching, docs/frameloop.md § What runs in a tic.
 */
const RETRACT_START = DOOM_TIC;
/**
 * Over how many map units the muzzle end ramps from invisible to full brightness. Tuned
 * by feel, and an absolute length for the same reason `RETRACT_SPEED` is — docs/combat.md
 * § Effects and their batching.
 */
const FADE_LENGTH = 160;
/**
 * The alpha ramp every tracer shares, as `vertexColors` data: transparent at the tail,
 * opaque from the fade point on. RGB is all-white because `material.color` supplies it.
 * One shared array, never mutated — but each geometry still wraps it in its own
 * `BufferAttribute`, since disposing a geometry drops the GL buffer its attributes name.
 */
const FADE_COLORS = new Float32Array([1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1]);

/**
 * One material per tracer colour, session-lived, the same ownership split
 * `render/spritebatch.ts`'s `SpriteMaterialCache` makes. Nothing on a tracer's material
 * is per-instance since the fade moved into the vertex attribute, and a material built
 * and disposed per tracer makes three.js relink the shader program every time the live
 * count returns to zero — which it does between every trigger pull.
 */
const materials = new Map<number, THREE.LineBasicMaterial>();

/**
 * A thin line from a hitscan shot's origin to where it struck, blinking for its short lifetime
 * rather than easing out the way `render/occlusion.ts`'s permanent geometry does. **Only the impact
 * end is a real world anchor** — the muzzle end belongs to a shooter who has usually moved on, so
 * it starts short of them, fades in over `FADE_LENGTH`, and retracts toward the impact.
 * docs/combat.md § Effects and their batching.
 */
export class Tracer {
  readonly line: THREE.Line;
  private elapsed = 0;
  /** The impact end, the one real world anchor and the point everything is laid out back from. */
  private readonly impact = new THREE.Vector3();
  /** Unit vector shooter → impact, so laying the vertices out is a multiply-add each. */
  private readonly dir = new THREE.Vector3();
  /** Drawn length at spawn, gap already taken off — what `RETRACT_SPEED` eats into. */
  private readonly length: number;
  private readonly positions: THREE.BufferAttribute;

  constructor(from: Pos3, to: Pos3, color: number, shooterRadius: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    this.length = len - Math.min(shooterRadius + MUZZLE_GAP, len * MUZZLE_GAP_MAX_FRACTION);
    doomToWorld(to.x, to.y, to.z, this.impact);
    // `doomToWorld` is a pure axis permutation with no translation, so it maps this
    // direction as correctly as it maps a point — and mapping it here keeps the one
    // place that knows DOOM-space → three-space the only place that knows it.
    if (len > 0) doomToWorld(dx / len, dy / len, dz / len, this.dir);

    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(9), 3);
    geometry.setAttribute('position', this.positions);
    // Three vertices, not two: the tail, a point `FADE_LENGTH` along from it, and
    // the impact. Alpha interpolates 0 → 1 across the first pair and stays at 1
    // over the second, which buys a fade of fixed *length* out of a two-segment
    // polyline instead of a subdivided line and a per-vertex ramp. Only alpha
    // varies, so `vertexColors` needs the 4-wide attribute three.js reads as
    // `USE_COLOR_ALPHA` — see docs/combat.md § Effects and their batching.
    geometry.setAttribute('color', new THREE.BufferAttribute(FADE_COLORS, 4));
    this.layOut();
    this.line = new THREE.Line(geometry, materialFor(color));
  }

  /**
   * Advances the blink and the tail; returns false once the tracer's lifetime is over and it should
   * be removed.
   */
  update(dt: number): boolean {
    this.elapsed += dt;
    if (this.elapsed >= TRACER_LIFETIME) return false;
    this.layOut();
    this.line.visible = Math.floor(this.elapsed / BLINK_INTERVAL) % 2 === 0;
    return true;
  }

  /**
   * Drops this tracer's own geometry. The material is shared and outlives it — see `materialFor`.
   */
  dispose(): void {
    this.line.geometry.dispose();
  }

  /**
   * Puts the three vertices down for however far the tail has retracted by now: back
   * from the impact by what is left of the line, with the fade point `FADE_LENGTH`
   * ahead of it. Retraction is a constant *speed*, not a fraction of the line — the lag
   * it hides is an absolute distance the shooter has walked, the same on a point-blank
   * shot as on one across the map (docs/combat.md § Effects and their batching).
   *
   * Every vertex only ever moves *toward* the impact, so the bounding sphere three.js
   * computed for the full-length line still contains them — no recompute, nothing
   * culled early.
   */
  private layOut(): void {
    const travelled = Math.max(0, this.elapsed - RETRACT_START) * RETRACT_SPEED;
    const remaining = Math.max(this.length - travelled, 0);
    // Where the fade point sits: `FADE_LENGTH` in from the tail, which on a nearly
    // spent tracer is the impact itself, so it ramps across whatever is left rather
    // than clipping.
    const held = remaining - Math.min(FADE_LENGTH, remaining);
    this.positions.setXYZ(0, this.impact.x - remaining * this.dir.x, this.impact.y - remaining * this.dir.y, this.impact.z - remaining * this.dir.z);
    this.positions.setXYZ(1, this.impact.x - held * this.dir.x, this.impact.y - held * this.dir.y, this.impact.z - held * this.dir.z);
    this.positions.setXYZ(2, this.impact.x, this.impact.y, this.impact.z);
    this.positions.needsUpdate = true;
  }
}

function materialFor(color: number): THREE.LineBasicMaterial {
  let material = materials.get(color);
  if (!material) {
    material = new THREE.LineBasicMaterial({
      color,
      fog: true,
      vertexColors: true,
      transparent: true,
      // One translucent line among opaque geometry, the same trade the translucent
      // sprite materials make (render/spritebatch.ts): not writing depth keeps it
      // from punching a hole in whatever draws after it.
      depthWrite: false,
    });
    materials.set(color, material);
  }
  return material;
}
