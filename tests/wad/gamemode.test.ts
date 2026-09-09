import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gameModeOf } from '../../src/wad/campaign/gamemode.ts';

/**
 * Vanilla's `gamemode` off the set's map list, `IdentifyVersion` having no file name to read here.
 * See docs/wad.md § What game mode a set is.
 */
describe('WAD parsing · game mode', () => {
  test('a MAPxx anywhere is DOOM 2', () => {
    assert.equal(gameModeOf(['MAP01', 'MAP02']), 'commercial');
    // A DOOM 2 set an ExMy PWAD was added to is still DOOM 2.
    assert.equal(gameModeOf(['E1M1', 'MAP01']), 'commercial');
  });

  test('an episode past the first is the registered DOOM 1', () => {
    assert.equal(gameModeOf(['E1M1', 'E2M1', 'E3M9']), 'registered');
    assert.equal(gameModeOf(['E4M1']), 'registered', "Ultimate DOOM's fourth folds in");
  });

  test('episode 1 and nothing else is shareware', () => {
    assert.equal(gameModeOf(['E1M1', 'E1M2', 'E1M9']), 'shareware');
  });

  test('a set naming its maps neither way withholds nothing', () => {
    assert.equal(gameModeOf(['TITLEMAP', 'HUB1']), 'registered');
    assert.equal(gameModeOf([]), 'registered');
  });
});
