import * as THREE from 'three';
import { VIEWER_ANGLE_DEG } from '../../src/render/sprites.ts';
import type { SpriteBank } from '../../src/wad/sprites.ts';
import type { SpriteMaterialCache } from '../../src/render/sprites.ts';
import { SpriteFxLayer, type FogVisibility } from '../../src/game/spritefx.ts';
import { SILENT } from '../../src/audio/sfx.ts';
import type { DynamicLights } from '../../src/render/lights.ts';


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

/**
 * Throwaway three.js objects, with the lump name echoed back on them — `drawnSprites` is what reads
 * it. `bottomOffset` is what a test about where airborne art hangs varies, and `tag` marks which
 * cache answered, for a test running two of them against each other.
 */
export function materialsStub(over: { bottomOffset?: number; tag?: string } = {}): SpriteMaterialCache {
  const { bottomOffset = 0, tag } = over;
  return {
    get: (lump: string) => ({
      tag,
      lump,
      material: new THREE.MeshBasicMaterial(),
      geometry: new THREE.BufferGeometry(),
      quad: { minX: -16, maxX: 16, height: 56 },
      bottomOffset,
    }),
  } as unknown as SpriteMaterialCache;
}

export const MATERIALS = materialsStub();

/**
 * `BANK` with the rotation digit pinned to 0 — the one-shot effects really are
 * rotation-0 only (`TFOGA0`..`TFOGJ0`), so echoing the requested digit would
 * only make the frame letter, which is what a `SpriteFxLayer` test asserts on,
 * harder to see.
 */
export const ROT0_BANK = {
  lookup: (sprite: string, frame: string) => ({ lump: `${sprite}${frame}0`, flip: false }),
} as unknown as SpriteBank;

/** One `batch.add` a frame made: the lump, and the three.js point it was placed at. */
export interface DrawnSprite {
  lump: string;
  x: number;
  /** World Y, which is DOOM z — `mapmesh.doomToWorld`. */
  y: number;
  z: number;
}

/**
 * What one frame of a `SpriteFxLayer` actually draws. Reached through the layer's
 * own `draw` with its batch stubbed to record instead of paint, because that is
 * the only place the animator's current frame surfaces — nothing the layer
 * exposes names it.
 */
export function drawnSprites(layer: SpriteFxLayer, alpha = 1): DrawnSprite[] {
  const drawn: DrawnSprite[] = [];
  const batch = (layer as unknown as {
    batch: { add: (cached: { lump: string }, x: number, y: number, z: number) => void };
  }).batch;
  const realAdd = batch.add;
  batch.add = (cached, x, y, z) => void drawn.push({ lump: cached.lump, x, y, z });
  layer.beginFrame(VIEWER_ANGLE_DEG);
  layer.draw(alpha);
  layer.endFrame();
  batch.add = realAdd;
  return drawn;
}

/** `drawnSprites`, for the tests that only ask which frames a layer drew. */
export function drawnLumps(layer: SpriteFxLayer, alpha = 1): string[] {
  return drawnSprites(layer, alpha).map((d) => d.lump);
}

/**
 * `BANK`, plus what every lump it is asked for was asked as — which is how a test reads back the
 * pose a thing is actually drawn on. `asked` is the frame letter alone, the one part of a lump name
 * the animator rather than the caller chooses; `askedSprites` prefixes the sprite name, for a test
 * whose subject is a pose switching to another sprite's art entirely.
 */
export function recordingBank(): { bank: SpriteBank; asked: string[]; askedSprites: string[] } {
  const asked: string[] = [];
  const askedSprites: string[] = [];
  const bank = {
    lookup(sprite: string, frame: string, digit: number) {
      asked.push(frame);
      askedSprites.push(sprite + frame);
      return { lump: `${sprite}${frame}${digit}`, flip: false };
    },
  } as unknown as SpriteBank;
  return { bank, asked, askedSprites };
}

/**
 * A `SpriteFxLayer` on the stub banks, silent and with no arch-vile flame — the
 * four settings every effects test shares. Callers pass only what they vary, and
 * still `beginLevel` it themselves, since which `World` a layer runs over is part
 * of what those tests are saying.
 */
export function fxLayer(options: {
  fogVisible: FogVisibility;
  lights?: DynamicLights;
  spriteMaterials?: SpriteMaterialCache;
}): SpriteFxLayer {
  return new SpriteFxLayer(new THREE.Scene(), {
    spriteBank: ROT0_BANK,
    spriteMaterials: MATERIALS,
    audio: SILENT,
    resolveVileFlame: () => null,
    ...options,
  });
}
