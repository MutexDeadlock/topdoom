import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { loadCorridor } from '../fixtures/corridor.ts';

/**
 * The fog reveal radius used to stop 3000 units out while the camera frames
 * about 5100, so anything between the two sat in the dark. Not merely cosmetic:
 * `ThingLayer` gates rendering, `pickMonster` *and* `raycastMonster` on fog
 * alpha, so a monster standing there was invisible, un-lockable and unhittable
 * while it shot back. See docs/fogofwar.md § Reveal radius.
 */
describe('Regressions · fog reveal radius', () => {
  test('the chaingunner 3584 units out is revealed at spawn', () => {
    const { world, player, monster } = loadCorridor();
    // FogOfWar's constructor runs one uncapped seed update, so the reveal is
    // settled by the time it returns.
    const fog = new FogOfWar(world, [], player.x, player.y);
    assert.equal(fog.alphaOf(world.subsectorAt(player.x, player.y)), 1);
    assert.equal(
      fog.alphaOf(world.subsectorAt(monster.x, monster.y)),
      1,
      'the alcove the chaingunner stands in',
    );
  });

  /**
   * `SIGHT_RADIUS` is module-private, so it is pinned behaviourally from both
   * sides: revealed at 5120 out, dark at 5248. Any radius outside (5120, 5248]
   * fails this — which is the point. A future change to what the camera frames
   * should update these numbers, not delete the test.
   */
  test('the reveal radius covers what the camera frames (~5100 units)', () => {
    const cols = 60;
    const grid = gridMap(['#'.repeat(cols), `#${'.'.repeat(cols - 2)}#`, '#'.repeat(cols)]);
    const world = new World(grid.map);
    const start = grid.centre(1, 1);
    const fog = new FogOfWar(world, [], start.x, start.y);

    const at = (col: number) => {
      const p = grid.centre(col, 1);
      return { dist: p.x - start.x, alpha: fog.alphaOf(world.subsectorAt(p.x, p.y)) };
    };

    assert.deepEqual(at(41), { dist: 5120, alpha: 1 });
    assert.deepEqual(at(42), { dist: 5248, alpha: 0 });
  });

  // Without this, a bug that revealed everything unconditionally would pass the
  // radius test above by accident.
  test('fog does not reveal through a wall', () => {
    const cols = 60;
    const grid = gridMap([
      '#'.repeat(cols),
      `#${'.'.repeat(14)}#${'.'.repeat(cols - 17)}#`, // wall cell at column 15
      '#'.repeat(cols),
    ]);
    const world = new World(grid.map);
    const start = grid.centre(1, 1);
    const fog = new FogOfWar(world, [], start.x, start.y);
    const alpha = (col: number) => fog.alphaOf(world.subsectorAt(grid.centre(col, 1).x, start.y));

    assert.equal(alpha(14), 1, 'up to the wall');
    assert.equal(alpha(16), 0, 'blocked by geometry, well inside SIGHT_RADIUS');
    assert.equal(alpha(29), 0, 'and everything behind it');
  });
});
