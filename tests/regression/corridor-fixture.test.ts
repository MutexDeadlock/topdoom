import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorridor } from '../fixtures/corridor.ts';

/**
 * Both chaingunner regression tests are built on this one map, so a fixture
 * that quietly stopped being what it claims would weaken every assertion in
 * them without failing anything. It gets pinned here instead.
 * See docs/testing.md § Writing a new test.
 */
describe('Regressions · the corridor fixture itself', () => {
  test('long_corridor_with_chaingunner.wad loads, and holds the geometry it claims', () => {
    const { world, player, monster } = loadCorridor();

    assert.deepEqual(player, { x: 0, y: 32, z: 0 }, 'player start');
    assert.deepEqual(monster, { x: 0, y: 3616, z: 0 }, 'chaingunner (doomednum 65)');
    assert.equal(
      Math.hypot(monster.x - player.x, monster.y - player.y),
      3584,
      'the separation both regression tests assert against',
    );

    // The corridor and the chaingunner's alcove are separate BSP leaves — which
    // is what let fog light the whole corridor while leaving him in the dark.
    assert.equal(world.map.subsectors.length, 2);
    assert.notEqual(
      world.subsectorAt(player.x, player.y),
      world.subsectorAt(monster.x, monster.y),
    );
  });
});
