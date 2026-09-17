import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, soundLog, TIC } from '../fixtures/specialsrig.ts';
import { USE_INPUT } from '../fixtures/input.ts';
import { LF } from '../../src/wad/map.ts';

/**
 * What one use press reaches. Boom's PASSUSE flag lets it pass through a flagged line to the ones
 * behind it, and `PTR_UseTraverse`'s other half walks *every* line in front of the player, so a
 * line with no opening ends the press where it stands.
 * See docs/specials.md § Scope and § The use trace.
 */

describe('Specials · PASSUSE', () => {
  /**
   * Four cells in a row, cell size 32, the player near cell 0's east edge
   * facing east. The edge at x=32 carries 138 (light -> 255, tag 7) and the
   * edge at x=64 carries 139 (light -> 35, tag 8) — both inside USE_RANGE.
   */
  function useRig(passuse: boolean) {
    const grid = gridMap(['....'], { cell: 32 });
    const { map } = grid;
    const front = grid.westEdge(1, 0);
    const back = grid.westEdge(2, 0);
    map.linedefs[front].special = 138;
    map.linedefs[front].tag = 7;
    if (passuse) map.linedefs[front].flags |= LF.PASSUSE;
    map.linedefs[back].special = 139;
    map.linedefs[back].tag = 8;
    map.sectors[3].tag = 7;
    map.sectors[2].tag = 8;
    const rig = specialsRig(map, { x: 28, y: 16 });
    rig.specials.update(TIC, { x: 28, y: 16, angle: 0 }, USE_INPUT, new Set());
    return map;
  }

  test('without the flag, the nearest use line shadows the one behind it', () => {
    const map = useRig(false);
    assert.equal(map.sectors[3].light, 255);
    assert.equal(map.sectors[2].light, 160);
  });

  test('with the flag, one press fires both lines, nearest first', () => {
    const map = useRig(true);
    assert.equal(map.sectors[3].light, 255);
    assert.equal(map.sectors[2].light, 35);
  });
});

/**
 * `PTR_UseTraverse`'s other half: the trace walks *every* line in front of the
 * player, and a line with no opening ends the press where it stands.
 * See docs/specials.md § The use trace.
 */
describe('Specials · the use trace stops at walls', () => {
  /**
   * Three cells in a row, cell size 32, the player near cell 0's east edge facing
   * east. Cell 2's west edge (x=64) carries 138 (light -> 255, tag 7) on the cell
   * behind it; `middle` says whether the cell between the two is open floor or a
   * zero-opening wall. Both edges are inside USE_RANGE either way.
   */
  function wallRig(middle: '.' | '#', options: { nearSpecial?: number } = {}) {
    const grid = gridMap([`.${middle}.`], { cell: 32 });
    const { map } = grid;
    map.linedefs[grid.westEdge(2, 0)].special = 138;
    map.linedefs[grid.westEdge(2, 0)].tag = 7;
    map.sectors[2].tag = 7;
    if (options.nearSpecial) map.linedefs[grid.westEdge(1, 0)].special = options.nearSpecial;
    const log = soundLog();
    const rig = specialsRig(map, { x: 28, y: 16 }, { sfx: log.sfx });
    rig.specials.update(TIC, { x: 28, y: 16, angle: 0 }, USE_INPUT, new Set());
    return { map, played: log.played };
  }

  test('a wall between the player and a switch swallows the press', () => {
    const { map, played } = wallRig('#');
    assert.equal(map.sectors[2].light, 160);
    assert.deepEqual(played, ['noway']);
  });

  test('with the wall open, the same press reaches the switch', () => {
    const { map, played } = wallRig('.');
    assert.equal(map.sectors[2].light, 255);
    assert.ok(!played.includes('noway'));
  });

  test('a walk-only special in the way shadows the switch behind it, silently', () => {
    // 2 is W1 open door: `P_UseSpecialLine` has no case for it, so vanilla fires
    // nothing and still stops the trace — and the line is special, so no `noway`.
    const { map, played } = wallRig('.', { nearSpecial: 2 });
    assert.equal(map.sectors[2].light, 160);
    assert.deepEqual(played, []);
  });
});
