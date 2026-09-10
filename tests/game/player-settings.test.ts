import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { getAutorun, Player } from '../../src/game/player.ts';
import { GLOBAL_PLAYER_SETTINGS } from '../../src/game/replay/settings.ts';
import { overrideRightMouseAction } from '../../src/game/input.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { vecLength } from '../../src/util/geom.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { heldInput } from '../fixtures/input.ts';

/**
 * A player's settings belong to their slot: the body runs under the value pushed onto it, never the
 * stored one — and the local slot reads the stored values live. docs/multiplayer.md § Player
 * settings.
 */

/** How far a player holding forward gets in four tics, under `autorun`. */
function forwardDistance(autorun: boolean): number {
  const grid = gridMap(['#####', '#...#', '#...#', '#...#', '#####'], { cell: 128 });
  const world = new World(grid.map);
  const start = grid.centre(2, 2);
  const player = new Player(world, { x: start.x, y: start.y, angle: 0 });
  player.autorun = autorun;
  const input = heldInput('KeyW');
  for (let tic = 0; tic < 4; tic++) player.update(DOOM_TIC, input, null, 90);
  return vecLength(player.x - start.x, player.y - start.y);
}

describe('Player settings · per slot', () => {
  test('the body runs under its own autorun, whatever the stored setting says', () => {
    assert.equal(getAutorun(), true, 'the stored setting in a fresh profile');
    const running = forwardDistance(true);
    const walking = forwardDistance(false);
    assert.ok(walking > 0, 'it walks');
    assert.ok(running > walking * 1.5, `running ${running} outpaces walking ${walking}`);
  });

  test("the local slot's settings follow the owners live, a playback's pin included", () => {
    assert.equal(GLOBAL_PLAYER_SETTINGS.rightMouse, 'previousweapon');
    overrideRightMouseAction('use');
    try {
      assert.equal(GLOBAL_PLAYER_SETTINGS.rightMouse, 'use');
    } finally {
      overrideRightMouseAction(null);
    }
    assert.equal(GLOBAL_PLAYER_SETTINGS.rightMouse, 'previousweapon');
  });
});
