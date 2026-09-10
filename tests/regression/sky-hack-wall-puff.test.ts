import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { PUFF_FRAMES } from '../../src/game/spritefx/tables.ts';
import { drawnLumps, fxLayer } from '../fixtures/spritestubs.ts';
import { gridMap, type CellHeights } from '../fixtures/gridmap.ts';

/**
 * A two-sided line with sky on both sides ate the bullet puff over its whole
 * face, so on a map roofed with `F_SKY1` throughout no shot at any wall left a
 * mark — GoingDown MAP01, 439 of its 485 sectors, where every step and wall
 * around the player start is such a line. Only the band actually drawn as sky
 * eats it now, which is Boom's own narrowing of vanilla's test.
 * See docs/combat.md § Bullet puffs.
 */


const SHOT_Z = 36;
const EAST = 0;
const PUFF = `PUFF${PUFF_FRAMES[0]}0`;

/** Shooter's cell west of `back`, both roofed with sky. Returns what the shot drew. */
function puffAgainst(back: CellHeights): string[] {
  const grid = gridMap(['.b'], { cell: 256, heights: { '.': { floor: 0, ceil: 512 }, b: back } });
  for (const sector of grid.map.sectors) sector.ceilTex = 'F_SKY1';
  const world = new World(grid.map);
  const effects = fxLayer({ fogVisible: () => true });
  effects.beginLevel(world);

  const at = grid.centre(0, 0);
  const path = world.shotPath({ x: at.x, y: at.y, z: SHOT_Z }, EAST, null, 2048, null);
  assert.notEqual(path.lineIndex, null, 'the shot has to stop on the shared line for this to test anything');
  effects.spawnWallPuff(path, EAST);
  return drawnLumps(effects);
}

describe('Regressions · the bullet puff on a sky-hack wall', () => {
  test('a step between two open-air sectors takes the puff', () => {
    assert.deepEqual(puffAgainst({ floor: 96, ceil: 512 }), [PUFF], 'lower texture, a real wall');
  });

  test('the sky band above a lowered ceiling still eats it', () => {
    assert.deepEqual(puffAgainst({ floor: 0, ceil: 16 }), [], 'shot passed over the back ceiling');
  });
});
