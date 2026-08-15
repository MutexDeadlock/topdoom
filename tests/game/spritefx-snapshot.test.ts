import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../../src/game/world.ts';
import { SpriteFxLayer } from '../../src/game/spritefx.ts';
import { TFOG_FRAME_SECONDS, TFOG_FRAMES } from '../../src/game/spritefx/tables.ts';
import { VIEWER_ANGLE_DEG } from '../../src/render/sprites.ts';
import type { SpriteBank } from '../../src/wad/sprites.ts';
import type { SpriteMaterialCache } from '../../src/render/sprites.ts';
import type { AudioEngine } from '../../src/audio/audio.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * The teleport fog is the one `SpriteFxLayer` transient a save carries: at 10
 * frames of 6 tics it runs ~1.7 s, long enough to save inside, where every
 * other effect here is gone in a fraction of that. What this pins is that a
 * restore resumes the *same frame* rather than restarting the animation — the
 * fast-forward is the whole point. See docs/savegames.md § What is saved and
 * what is deliberately not.
 */

/**
 * Every lump "exists", and the rotation digit is always 0 — `TFOG` really is
 * rotation-0 only (TFOGA0..TFOGJ0), so echoing the requested digit the way a
 * fully-rotated sprite's bank would would make the frame letter, which is what
 * the assertions read back, harder to see.
 */
const BANK = {
  lookup: (sprite: string, frame: string) => ({ lump: `${sprite}${frame}0`, flip: false }),
} as unknown as SpriteBank;

const MATERIALS = {
  get: (lump: string) => ({
    lump,
    material: new THREE.MeshBasicMaterial(),
    geometry: new THREE.BufferGeometry(),
    quad: { minX: -16, maxX: 16, height: 56 },
  }),
} as unknown as SpriteMaterialCache;

const SILENT = { play: () => {} } as unknown as AudioEngine;

function layerOn(): { layer: SpriteFxLayer; world: World } {
  const world = new World(gridMap(['######', '#....#', '#....#', '######'], { cell: 128 }).map);
  const layer = new SpriteFxLayer(new THREE.Scene(), BANK, MATERIALS, SILENT, () => null);
  layer.beginLevel(world);
  return { layer, world };
}

/** The frame letter a fog is drawing, read the way `drawList` does. */
function framesOf(layer: SpriteFxLayer): string[] {
  const lumps: string[] = [];
  // `snapshotTeleportFogs` is positions only, so the animator is reached the
  // way drawing reaches it — through the layer's own draw, with the batch
  // stubbed out to record instead of paint.
  const batch = (layer as unknown as { batch: { add: (c: { lump: string }) => void; begin: () => void; end: () => void } })
    .batch;
  const realAdd = batch.add;
  batch.add = (cached: { lump: string }) => void lumps.push(cached.lump);
  layer.beginFrame(VIEWER_ANGLE_DEG);
  layer.draw(1);
  layer.endFrame();
  batch.add = realAdd;
  return lumps;
}

describe('Savegames · teleport fogs round-trip', () => {
  test('a fog mid-animation restores on the frame it was saved on', () => {
    const { layer } = layerOn();
    layer.spawnTeleportFog({ x: 100, y: 200, z: 8 });
    // Mid-frame rather than on a boundary (4.5 frames in): far enough that a
    // restart would be obvious, well short of the ~1.7 s lifetime, and clear of
    // the float-rounding edge where the frame a boundary lands on is a coin toss.
    const elapsed = TFOG_FRAME_SECONDS * 4.5;
    layer.updateTeleportFogs(elapsed);
    const before = framesOf(layer);
    assert.deepEqual(before, [`TFOG${TFOG_FRAMES[4]}0`], 'frame E, four and a half frames in');

    const saved = layer.snapshotTeleportFogs();
    assert.deepEqual(saved, [{ x: 100, y: 200, z: 8, elapsed }]);

    // A fresh layer, as a load builds: the fog comes back from the save alone.
    const restored = layerOn().layer;
    restored.restoreTeleportFogs(saved);
    assert.deepEqual(framesOf(restored), before, 'same frame, not restarted');
  });

  test('a restored fog finishes on time instead of running the full length again', () => {
    const { layer } = layerOn();
    layer.spawnTeleportFog({ x: 0, y: 0, z: 0 });
    layer.updateTeleportFogs(TFOG_FRAME_SECONDS * 9);

    const restored = layerOn().layer;
    restored.restoreTeleportFogs(layer.snapshotTeleportFogs());
    assert.equal(framesOf(restored).length, 1, 'still playing, one frame left');

    restored.updateTeleportFogs(TFOG_FRAME_SECONDS * 1.5);
    assert.deepEqual(framesOf(restored), [], 'expired on its own schedule');
  });

  test('nothing else in the layer is saved', () => {
    const { layer } = layerOn();
    layer.spawnTeleportFog({ x: 0, y: 0, z: 0 });
    layer.spawnPuff({ x: 50, y: 50, z: 0 });
    layer.addTracer({ x: 0, y: 0, z: 0 }, { x: 90, y: 0, z: 0 }, 0xffffff);
    assert.equal(layer.snapshotTeleportFogs().length, 1, 'the fog alone — puffs and tracers stay transient');
  });

  test('an empty list round-trips to an empty layer', () => {
    const { layer } = layerOn();
    assert.deepEqual(layer.snapshotTeleportFogs(), []);
    layer.restoreTeleportFogs([]);
    assert.deepEqual(framesOf(layer), []);
  });
});
