import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig } from '../fixtures/specialsrig.ts';
import { LINE_SPECIALS } from '../../src/game/specials/tables.ts';

/**
 * The shoot-triggered specials (vanilla's `case 46` and Boom's G-prefixed numbers): a bullet that
 * crosses the line sets it off, and the impact is what carries the activator. Split out of the
 * use-press tests (`tests/game/usetrace.test.ts`). See docs/specials.md § Trigger dispatch.
 */

describe('Specials · shoot triggers', () => {
  /** Two open cells, the middle edge carrying a shoot special that opens the tagged door cell. */
  function shootLineRig(special: number) {
    const grid = gridMap(['..+']);
    const { map } = grid;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = special;
    map.linedefs[line].tag = 5;
    map.sectors[2].tag = 5;
    const rig = specialsRig(map, grid.centre(0, 0));
    return { map, rig, line };
  }

  test('GR (46) flows through trigger/repeatable with no extra mechanism', () => {
    assert.deepEqual(
      { trigger: LINE_SPECIALS[46].trigger, repeatable: LINE_SPECIALS[46].repeatable },
      { trigger: 'shoot', repeatable: true },
    );
    const { map, rig, line } = shootLineRig(46);
    rig.specials.triggerShot(line, new Set());
    for (let i = 0; i < 5; i++) rig.tick();
    assert.ok(map.sectors[2].ceilHeight > 0);
  });

  /**
   * `PTR_ShootTraverse` fires a line's special on the way past, before it tests
   * whether the line blocks — so a bullet triggers what it flies *through*, and
   * only what it reached. docs/combat.md § Shoot-triggered specials.
   */
  test('a shot flying past a shoot line fires it, one beyond where it stopped does not', () => {
    const flownThrough = shootLineRig(46);
    // The line sits at x=128; the trace runs from the first cell well past it.
    flownThrough.rig.specials.triggerShotPath({ x: 64, y: 64 }, { x: 300, y: 64 }, null, new Set());
    for (let i = 0; i < 5; i++) flownThrough.rig.tick();
    assert.ok(flownThrough.map.sectors[2].ceilHeight > 0, 'crossed on the way past');

    const stoppedShort = shootLineRig(46);
    stoppedShort.rig.specials.triggerShotPath({ x: 64, y: 64 }, { x: 100, y: 64 }, null, new Set());
    for (let i = 0; i < 5; i++) stoppedShort.rig.tick();
    assert.equal(stoppedShort.map.sectors[2].ceilHeight, 0, 'never reached');
  });

  test('the line that stopped the shot fires, though the trace ends exactly on it', () => {
    const { map, rig, line } = shootLineRig(46);
    rig.specials.triggerShotPath({ x: 64, y: 64 }, { x: 128, y: 64 }, line, new Set());
    for (let i = 0; i < 5; i++) rig.tick();
    assert.ok(map.sectors[2].ceilHeight > 0);
  });

  test("a monster's shot works on 46 but not on other shoot specials", () => {
    const monster = shootLineRig(46);
    monster.rig.specials.triggerShot(monster.line, new Set(), null);
    for (let i = 0; i < 5; i++) monster.rig.tick();
    assert.ok(monster.map.sectors[2].ceilHeight > 0);

    // 24 is G1 raiseFloor — shoot-triggered, but player-only (no `monsterCanTrigger`).
    const blocked = shootLineRig(24);
    blocked.rig.specials.triggerShot(blocked.line, new Set(), null);
    for (let i = 0; i < 5; i++) blocked.rig.tick();
    assert.equal(blocked.map.sectors[2].floorHeight, 0);
  });
});
