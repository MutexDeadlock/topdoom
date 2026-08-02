import * as THREE from 'three';
import { doomToWorld } from './mapmesh.ts';

/** Total lifetime of a hitscan tracer, in seconds. */
export const TRACER_LIFETIME = 0.15;
/** How often the tracer toggles on/off during its lifetime, in seconds per toggle. */
const BLINK_INTERVAL = 0.03;

/**
 * A thin line from a hitscan shot's origin to where it struck, that blinks
 * rapidly for its short lifetime rather than fading smoothly. The wall/flat
 * fading elsewhere (render/occlusion.ts) is an exponential lerp because it's
 * tracking *permanent* geometry that needs to ease in and out without
 * popping; a tracer is a one-shot effect gone in a fraction of a second, so a
 * literal flash/blink reads as a muzzle flash rather than a fade.
 */
export class Tracer {
  readonly line: THREE.Line;
  private elapsed = 0;

  constructor(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, color: number) {
    const a = doomToWorld(x1, y1, z1);
    const b = doomToWorld(x2, y2, z2);
    const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
    const material = new THREE.LineBasicMaterial({ color, fog: true });
    this.line = new THREE.Line(geometry, material);
  }

  /** Advances the blink; returns false once the tracer's lifetime is over and it should be removed. */
  update(dt: number): boolean {
    this.elapsed += dt;
    if (this.elapsed >= TRACER_LIFETIME) return false;
    this.line.visible = Math.floor(this.elapsed / BLINK_INTERVAL) % 2 === 0;
    return true;
  }

  dispose(): void {
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}
