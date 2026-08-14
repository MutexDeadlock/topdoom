import * as THREE from 'three';
import type { SpriteBank } from '../../src/wad/sprites.ts';
import type { SpriteMaterialCache } from '../../src/render/sprites.ts';

/**
 * The two stubs that get `ThingLayer`/`SpriteFxLayer` running headless: both
 * layers only ever *key* their batches by lump name during a tic, so a bank
 * that says every lump exists and a material cache that hands back throwaway
 * three.js objects are enough to tick and draw a real layer in Node.
 * docs/testing.md § What is and isn't covered.
 */

/** Every lump "exists" — the layer only needs a name to key its batches by. */
export const BANK = {
  lookup: (sprite: string, frame: string, digit: number) => ({ lump: `${sprite}${frame}${digit}`, flip: false }),
} as unknown as SpriteBank;

export const MATERIALS = {
  get: () => ({
    material: new THREE.MeshBasicMaterial(),
    geometry: new THREE.BufferGeometry(),
    quad: { minX: -16, maxX: 16, height: 56 },
  }),
} as unknown as SpriteMaterialCache;

/**
 * `BANK`, plus the frame letter of every lump it is asked for — which is how a
 * test reads back the pose a thing is actually drawn on, the frame letter being
 * the one part of a lump name that the animator, not the caller, chooses.
 */
export function recordingBank(): { bank: SpriteBank; asked: string[] } {
  const asked: string[] = [];
  const bank = {
    lookup(sprite: string, frame: string, digit: number) {
      asked.push(frame);
      return { lump: `${sprite}${frame}${digit}`, flip: false };
    },
  } as unknown as SpriteBank;
  return { bank, asked };
}
