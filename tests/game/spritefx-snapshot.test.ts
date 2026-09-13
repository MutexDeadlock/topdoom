import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpriteFxLayer } from '../../src/game/spritefx.ts';
import { World } from '../../src/game/world.ts';
import { TELEPORT_FOG } from '../../src/game/spritefx/tables.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { drawnLumps, fxLayer, teleportFogLump } from '../fixtures/spritestubs.ts';

/**
 * The teleport fog is the one `SpriteFxLayer` transient a save carries: at 12
 * states of 6 tics it runs ~2 s, long enough to save inside, where every
 * other effect here is gone in a fraction of that. What this pins is that a
 * restore resumes the *same frame* rather than restarting the animation — the
 * fast-forward is the whole point. See docs/savegames.md § What is saved and
 * what is deliberately not.
 */

const FRAME = TELEPORT_FOG.frameSeconds;

function layerOn(): { layer: SpriteFxLayer; world: World } {
  const world = new World(gridMap(['######', '#....#', '#....#', '######'], { cell: 128 }).map);
  // Everything revealed: what this file pins is the animation clock, and the
  // fog-of-war draw gate is `tests/regression/effects-in-unseen-rooms.test.ts`'.
  const layer = fxLayer({ fogVisible: () => true });
  layer.beginLevel(world);
  return { layer, world };
}

describe('Savegames · teleport fogs round-trip', () => {
  test('a fog mid-animation restores on the frame it was saved on', () => {
    const { layer } = layerOn();
    layer.spawnTeleportFog({ x: 100, y: 200, z: 8 });
    // Mid-frame rather than on a boundary (4.5 frames in): far enough that a
    // restart would be obvious, well short of the ~2 s lifetime, and clear of
    // the float-rounding edge where the frame a boundary lands on is a coin toss.
    const elapsed = FRAME * 4.5;
    layer.updateTeleportFogs(elapsed);
    const before = drawnLumps(layer);
    assert.deepEqual(before, [teleportFogLump(4)], 'the fifth frame, four and a half frames in');

    const saved = layer.snapshotTeleportFogs();
    assert.deepEqual(saved, [{ x: 100, y: 200, z: 8, elapsed }]);

    // A fresh layer, as a load builds: the fog comes back from the save alone.
    const restored = layerOn().layer;
    restored.restoreTeleportFogs(saved);
    assert.deepEqual(drawnLumps(restored), before, 'same frame, not restarted');
  });

  test('a restored fog finishes on time instead of running the full length again', () => {
    const { layer } = layerOn();
    layer.spawnTeleportFog({ x: 0, y: 0, z: 0 });
    layer.updateTeleportFogs(FRAME * (TELEPORT_FOG.frames.length - 1));

    const restored = layerOn().layer;
    restored.restoreTeleportFogs(layer.snapshotTeleportFogs());
    assert.equal(drawnLumps(restored).length, 1, 'still playing, one frame left');

    restored.updateTeleportFogs(FRAME * 1.5);
    assert.deepEqual(drawnLumps(restored), [], 'expired on its own schedule');
  });

  test('nothing else in the layer is saved', () => {
    const { layer } = layerOn();
    layer.spawnTeleportFog({ x: 0, y: 0, z: 0 });
    layer.spawnPuff({ x: 50, y: 50, z: 0 });
    layer.addTracer({ x: 0, y: 0, z: 0 }, { x: 90, y: 0, z: 0 }, 0xffffff, 16);
    assert.equal(layer.snapshotTeleportFogs().length, 1, 'the fog alone — puffs and tracers stay transient');
  });

  test('an empty list round-trips to an empty layer', () => {
    const { layer } = layerOn();
    assert.deepEqual(layer.snapshotTeleportFogs(), []);
    layer.restoreTeleportFogs([]);
    assert.deepEqual(drawnLumps(layer), []);
  });
});
