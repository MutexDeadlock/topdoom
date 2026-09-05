/**
 * The cursor ray auto-aim is handed, for tests that drive a pick directly rather than through
 * `TopDownCamera.rayFor`. Built through `doomToWorld` so the axis permutation is written in the one
 * place that owns it (`render/mapmesh.ts`) — a test that inlines `(x, z, -y)` itself is a second
 * copy of it. docs/combat.md § Auto-aim.
 */
import * as THREE from 'three';
import { doomToWorld } from '../../src/render/mapmesh.ts';
import type { Pos3 } from '../../src/types.ts';

/** The ray from `from` toward `to`, both DOOM points, in the three.js space a pick takes. */
export function rayThrough(from: Pos3, to: Pos3): THREE.Ray {
  const origin = doomToWorld(from.x, from.y, from.z);
  const at = doomToWorld(to.x, to.y, to.z);
  return new THREE.Ray(origin, at.sub(origin).normalize());
}
