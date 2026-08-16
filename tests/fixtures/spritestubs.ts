import * as THREE from 'three';
import { VIEWER_ANGLE_DEG } from '../../src/render/sprites.ts';
import type { SpriteBank } from '../../src/wad/sprites.ts';
import type { SpriteMaterialCache } from '../../src/render/sprites.ts';
import type { SpriteFxLayer } from '../../src/game/spritefx.ts';

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

/** Throwaway three.js objects, with the lump name echoed back on them — `drawnLumps` is what reads it. */
export const MATERIALS = {
  get: (lump: string) => ({
    lump,
    material: new THREE.MeshBasicMaterial(),
    geometry: new THREE.BufferGeometry(),
    quad: { minX: -16, maxX: 16, height: 56 },
  }),
} as unknown as SpriteMaterialCache;

/**
 * `BANK` with the rotation digit pinned to 0 — the one-shot effects really are
 * rotation-0 only (`TFOGA0`..`TFOGJ0`), so echoing the requested digit would
 * only make the frame letter, which is what a `SpriteFxLayer` test asserts on,
 * harder to see.
 */
export const ROT0_BANK = {
  lookup: (sprite: string, frame: string) => ({ lump: `${sprite}${frame}0`, flip: false }),
} as unknown as SpriteBank;

/**
 * The lumps one frame of a `SpriteFxLayer` actually draws. Reached through the
 * layer's own `draw` with its batch stubbed to record instead of paint, because
 * that is the only place the animator's current frame surfaces — nothing the
 * layer exposes names it.
 */
export function drawnLumps(layer: SpriteFxLayer, alpha = 1): string[] {
  const lumps: string[] = [];
  const batch = (layer as unknown as { batch: { add: (cached: { lump: string }) => void } }).batch;
  const realAdd = batch.add;
  batch.add = (cached: { lump: string }) => void lumps.push(cached.lump);
  layer.beginFrame(VIEWER_ANGLE_DEG);
  layer.draw(alpha);
  layer.endFrame();
  batch.add = realAdd;
  return lumps;
}

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
