import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpriteFxLayer } from '../../src/game/spritefx.ts';
import { World } from '../../src/game/world.ts';
import { PICKUP_FOG_SCALE } from '../../src/game/spritefx/tables.ts';
import { drawnLumps, drawnSprites, fxLayer, materialsStub } from '../fixtures/spritestubs.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * A sprite spawned in mid-air hangs from its patch's own `topoffset`, the way vanilla's
 * `R_ProjectSprite` places it — not standing on the point it was spawned at. A rocket's own blast
 * (`MISLB0`, 60 tall, hanging 31 units below its origin) is what makes the difference obvious: with
 * the floor anchor this engine gives *floor-standing* art, the whole fireball bloomed upward out of
 * the impact instead of around it. See docs/combat.md § Where a missile starts and
 * docs/sprites.md § Why upright planes, not `THREE.Sprite`.
 */

/** `MISLB0`'s own numbers in DOOM2.WAD: 60 tall, `topoffset` 29. */
const BLAST_BOTTOM = 29 - 60;

/** `IFOGA0`'s own numbers in DOOM2.WAD: 37 tall, `topoffset` 33. */
const ITEM_FOG_BOTTOM = 33 - 37;

const GRID = gridMap(['.', '.'], { cell: 128 });

/** An effects layer whose every sprite hangs from `bottomOffset`. */
function rig(bottomOffset: number): SpriteFxLayer {
  const effects = fxLayer({ fogVisible: () => true, spriteMaterials: materialsStub({ bottomOffset }) });
  effects.beginLevel(new World(GRID.map));
  return effects;
}

/** Where the batch was actually asked to draw, in DOOM z. */
const drawnZ = (effects: SpriteFxLayer): number[] => drawnSprites(effects).map((d) => d.y);

describe('Regressions · an airborne sprite hangs from its own offset', () => {
  test('a blast is drawn straddling the impact, not standing on it', () => {
    const effects = rig(BLAST_BOTTOM);
    const at = { ...GRID.centre(0, 0), z: 40 };
    effects.spawnImpact('MISL', ['B'], 0.1, at);
    assert.deepEqual(drawnZ(effects), [at.z + BLAST_BOTTOM]);
  });

  test('a pickup puff hangs at its own draw scale, so it shrinks around where the item stood', () => {
    // At full length the item fog's first frame would sink its whole hang into the floor under a
    // sprite drawn at a fraction of that size. docs/items.md § The pickup puff.
    const effects = rig(ITEM_FOG_BOTTOM);
    const at = { ...GRID.centre(0, 0), z: 0 };
    effects.spawnPickupFog(at);
    assert.deepEqual(drawnLumps(effects), ['IFOGA0']);
    assert.deepEqual(drawnZ(effects), [at.z + ITEM_FOG_BOTTOM * PICKUP_FOG_SCALE]);
  });
});
