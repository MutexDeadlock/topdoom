import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * A sector with no vertical opening blocks sight on every line that bounds it, so no sample ray
 * can ever land inside it and the fog left it dark for the whole level: a hole in the view where
 * the geometry plainly is. Reported as a hole in the water around BOOMEDIT MAP01 sector 121, a
 * closed pillar standing in a pool.
 *
 * The waiver that fixes it applies only to sectors that are *permanently* solid. One a mover can
 * open is space, not geometry, and lighting it while it is shut draws the room behind its own
 * door — reported on E1M3 sector 51, a 512-unit secret corridor lit from the far side of the
 * door that opens it. See docs/fogofwar.md § Closed sectors.
 */
describe('Regressions · fog and closed sectors', () => {
  test('a closed pillar beside the player is revealed, not left as a hole', () => {
    const grid = gridMap(['...', '.#.', '...']);
    const world = new World(grid.map);
    const start = grid.centre(0, 1);
    const fog = new FogOfWar(world, [], start);

    const pillar = grid.centre(1, 1);
    assert.equal(fog.isVisible(world.subsectorAt(pillar.x, pillar.y)), true);
  });

  test('the waiver reaches the solid block itself and nothing behind it', () => {
    const grid = gridMap(['.#.']);
    const world = new World(grid.map);
    const start = grid.centre(0, 0);
    const fog = new FogOfWar(world, [], start);

    const block = grid.centre(1, 0);
    const behind = grid.centre(2, 0);
    assert.equal(fog.isVisible(world.subsectorAt(block.x, block.y)), true, 'the block itself');
    assert.equal(fog.isVisible(world.subsectorAt(behind.x, behind.y)), false, 'the room behind it');
  });

  test('a shut door is space, not geometry, and stays hidden until it opens', () => {
    const grid = gridMap(['.+.']);
    const { map } = grid;
    const door = grid.index(1, 0);
    const useLine = grid.westEdge(1, 0);
    map.linedefs[useLine].special = 1;
    assert.equal(map.sidedefs[map.linedefs[useLine].left].sector, door, 'the manual line’s back sector is the door');

    const world = new World(map);
    const start = grid.centre(0, 0);
    const fog = new FogOfWar(world, [], start);

    const leaf = grid.centre(1, 0);
    const behind = grid.centre(2, 0);
    assert.equal(fog.isVisible(world.subsectorAt(leaf.x, leaf.y)), false, 'the door leaf itself');
    assert.equal(fog.isVisible(world.subsectorAt(behind.x, behind.y)), false, 'the room behind it');
  });

  test('a door that has opened is sampled like any other subsector', () => {
    const grid = gridMap(['.+.']);
    const { map } = grid;
    const door = grid.index(1, 0);
    map.linedefs[grid.westEdge(1, 0)].special = 1;

    const world = new World(map);
    const start = grid.centre(0, 0);
    const fog = new FogOfWar(world, [], start);

    // The opening test is live, so raising the ceiling is all it takes.
    map.sectors[door].ceilHeight = 128;
    fog.tick(start.x, start.y);

    const leaf = grid.centre(1, 0);
    assert.equal(fog.isVisible(world.subsectorAt(leaf.x, leaf.y)), true);
  });

  test('a sector that is merely low still has to be seen into', () => {
    // The waiver keys on *no* opening, not on a small one: a crawlspace is an
    // ordinary subsector, and the wall in front of it still hides it.
    const grid = gridMap(['.#.', '...'], { heights: { '#': { floor: 0, ceil: 8 } } });
    const world = new World(grid.map);
    const start = grid.centre(0, 1);
    const fog = new FogOfWar(world, [], start);

    const low = grid.centre(1, 0);
    assert.equal(fog.isVisible(world.subsectorAt(low.x, low.y)), true, 'a low sector is seen normally');
  });
});
