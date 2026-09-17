import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, crossingBody, TIC } from '../fixtures/specialsrig.ts';
import { NO_INPUT } from '../fixtures/input.ts';
import { LINE_SPECIALS } from '../../src/game/specials/tables.ts';

/**
 * Which walk lines a monster may set off: per-number data (`SpecialDef.monsterActivate` —
 * vanilla `P_CrossSpecialLine`'s seven-number allow-list, and Boom's generalized trigger bit)
 * rather than a hardcoded set in the crossing path. Split out of the use-press tests
 * (`tests/game/usetrace.test.ts`). See docs/specials.md § Trigger dispatch.
 */

describe('Specials · monster activation', () => {
  /**
   * The two vanilla allow-lists `monsterActivate` carries, audited together
   * because they are one flag: `P_CrossSpecialLine`'s seven walk numbers, and
   * `P_UseSpecialLine`'s four manual doors — the ones a blocked monster pushes
   * (`useMonster`). Boom's own additions live in `BOOM_LINE_SPECIALS` and are
   * deliberately out of this table's audit.
   */
  test("the table's monsterActivate set is exactly the two vanilla allow-lists", () => {
    const allowed = new Set([4, 10, 39, 88, 97, 125, 126, 1, 32, 33, 34]);
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
