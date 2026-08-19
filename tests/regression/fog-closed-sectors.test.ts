import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * A sector with no vertical opening — a pillar, a shut door, a block of solid
 * geometry — blocks sight on every line that bounds it, so no sample ray can
 * ever land inside it and the fog left it dark for the whole level: a hole in
 * the view where the geometry plainly is. Reported as a hole in the water
 * around BOOMEDIT MAP01 sector 121, a closed pillar standing in a pool.
 * See docs/fogofwar.md § Closed sectors.
 */
describe('Regressions · fog and closed sectors', () => {
  test('a closed pillar beside the player is revealed, not left as a hole', () => {
    const grid = gridMap(['...', '.#.', '...']);
    const world = new World(grid.map);
    const start = grid.centre(0, 1);
    const fog = new FogOfWar(world, [], start.x, start.y);

    const pillar = grid.centre(1, 1);
    assert.equal(fog.isVisible(world.subsectorAt(pillar.x, pillar.y)), true);
  });

  test('the waiver reaches the closed sector itself and nothing behind it', () => {
    // The far cell is only reachable through the shut door, whose own lines are
    // waived while the *door* is the subsector being sampled — and only then.
    // Anything coarser lights the room behind every closed door on the map.
    const grid = gridMap(['.+.']);
    const world = new World(grid.map);
    const start = grid.centre(0, 0);
    const fog = new FogOfWar(world, [], start.x, start.y);

    const door = grid.centre(1, 0);
    const behind = grid.centre(2, 0);
    assert.equal(fog.isVisible(world.subsectorAt(door.x, door.y)), true, 'the door leaf itself');
    assert.equal(fog.isVisible(world.subsectorAt(behind.x, behind.y)), false, 'the room behind it');
  });

  test('a sector that is merely low still has to be seen into', () => {
    // The waiver keys on *no* opening, not on a small one: a crawlspace is an
    // ordinary subsector, and the wall in front of it still hides it.
    const grid = gridMap(['.#.', '...'], { heights: { '#': { floor: 0, ceil: 8 } } });
    const world = new World(grid.map);
    const start = grid.centre(0, 1);
    const fog = new FogOfWar(world, [], start.x, start.y);

    const low = grid.centre(1, 0);
    assert.equal(fog.isVisible(world.subsectorAt(low.x, low.y)), true, 'a low sector is seen normally');
  });
});
