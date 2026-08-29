import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, crossingBody, soundLog, NO_INPUT, USE_INPUT, TIC } from '../fixtures/specialsrig.ts';
import { LINE_SPECIALS } from '../../src/game/specials/tables.ts';
import { LF } from '../../src/wad/map.ts';

/**
 * Boom's PASSUSE flag and the activator model behind `crossLines`/`trigger`:
 * a use press passes through a flagged line to the ones behind it, and monster
 * activation of walk lines is per-number data (`SpecialDef.monsterActivate`)
 * rather than a hardcoded set. See docs/specials.md § Scope.
 */

describe('specials · PASSUSE', () => {
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

describe('specials · monster walk activation', () => {
  test("the table's monsterActivate set is exactly vanilla P_CrossSpecialLine's allow-list", () => {
    const allowed = new Set([4, 10, 39, 88, 97, 125, 126]);
    for (const [num, def] of Object.entries(LINE_SPECIALS)) {
      assert.equal(
        def.monsterActivate === true,
        allowed.has(Number(num)),
        `special ${num} monsterActivate mismatch`,
      );
    }
  });

  /** Two open cells and a shut-door cell; the edge between the open cells triggers the door by tag. */
  function doorRig(special: number) {
    const grid = gridMap(['..+']);
    const { map } = grid;
    const crossing = grid.westEdge(1, 0);
    map.linedefs[crossing].special = special;
    map.linedefs[crossing].tag = 5;
    map.sectors[2].tag = 5;
    const rig = specialsRig(map, grid.centre(0, 0));
    return { map, rig, prev: grid.centre(0, 0), pos: grid.centre(1, 0) };
  }

  test('a monster crossing special 4 opens the door', () => {
    const { map, rig, prev, pos } = doorRig(4);
    rig.specials.crossMonster(prev, crossingBody(pos), new Set());
    for (let i = 0; i < 5; i++) rig.tick();
    assert.ok(map.sectors[2].ceilHeight > 0);
  });

  test('a monster crossing special 2 does nothing, but the player crossing it works', () => {
    const { map, rig, prev, pos } = doorRig(2);
    rig.specials.crossMonster(prev, crossingBody(pos), new Set());
    for (let i = 0; i < 5; i++) rig.tick();
    assert.equal(map.sectors[2].ceilHeight, 0);
    // Same crossing as the player: prev seeded by the rig's start, one update at the far side.
    rig.specials.update(TIC, { ...pos, angle: 0 }, NO_INPUT, new Set());
    for (let i = 0; i < 5; i++) rig.tick(TIC, pos.x, pos.y);
    assert.ok(map.sectors[2].ceilHeight > 0);
  });
});

describe('specials · shoot triggers', () => {
  /** Two open cells, the middle edge carrying a shoot special that opens the tagged door cell. */
  function shotRig(special: number) {
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
    const { map, rig, line } = shotRig(46);
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
    const flownThrough = shotRig(46);
    // The line sits at x=128; the trace runs from the first cell well past it.
    flownThrough.rig.specials.triggerShotPath({ x: 64, y: 64 }, { x: 300, y: 64 }, null, new Set());
    for (let i = 0; i < 5; i++) flownThrough.rig.tick();
    assert.ok(flownThrough.map.sectors[2].ceilHeight > 0, 'crossed on the way past');

    const stoppedShort = shotRig(46);
    stoppedShort.rig.specials.triggerShotPath({ x: 64, y: 64 }, { x: 100, y: 64 }, null, new Set());
    for (let i = 0; i < 5; i++) stoppedShort.rig.tick();
    assert.equal(stoppedShort.map.sectors[2].ceilHeight, 0, 'never reached');
  });

  test('the line that stopped the shot fires, though the trace ends exactly on it', () => {
    const { map, rig, line } = shotRig(46);
    rig.specials.triggerShotPath({ x: 64, y: 64 }, { x: 128, y: 64 }, line, new Set());
    for (let i = 0; i < 5; i++) rig.tick();
    assert.ok(map.sectors[2].ceilHeight > 0);
  });

  test("a monster's shot works on 46 but not on other shoot specials", () => {
    const monster = shotRig(46);
    monster.rig.specials.triggerShot(monster.line, new Set(), true);
    for (let i = 0; i < 5; i++) monster.rig.tick();
    assert.ok(monster.map.sectors[2].ceilHeight > 0);

    // 24 is G1 raiseFloor — shoot-triggered, but player-only (no `monsterCanTrigger`).
    const blocked = shotRig(24);
    blocked.rig.specials.triggerShot(blocked.line, new Set(), true);
    for (let i = 0; i < 5; i++) blocked.rig.tick();
    assert.equal(blocked.map.sectors[2].floorHeight, 0);
  });
});

/**
 * `PTR_UseTraverse`'s other half: the trace walks *every* line in front of the
 * player, and a line with no opening ends the press where it stands.
 * See docs/specials.md § The use trace.
 */
describe('specials · the use trace stops at walls', () => {
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
