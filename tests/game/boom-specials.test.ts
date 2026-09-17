import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOM_LINE_SPECIALS,
  LINE_SPECIALS,
  NOOP_LINE_SPECIALS,
  PARAM_LINE_SPECIALS,
  classifyLineSpecial,
  lookupSpecial,
} from '../../src/game/specials/tables.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, TIC } from '../fixtures/specialsrig.ts';
import { NO_INPUT } from '../fixtures/input.ts';

/**
 * Boom's extended (non-generalized) numbers: table sanity, plus the two new
 * mechanisms they introduce — elevators and the motionless change.
 * See docs/specials.md § Scope and § Elevators.
 */
describe('Specials · extended Boom table', () => {
  test('the vanilla table holds all 138 vanilla dispatch cases, gaps closed', () => {
    // The union of P_CrossSpecialLine + P_UseSpecialLine + P_ShootSpecialLine
    // case numbers in linuxdoom-1.10 — verified by a mechanical diff during
    // the Boom audit, which surfaced (and closed) 41/43, 53/54/87/89 and 83.
    assert.equal(Object.keys(LINE_SPECIALS).length, 138);
    for (const n of [41, 43, 53, 54, 83, 87, 89]) assert.ok(LINE_SPECIALS[n], `vanilla special ${n} present`);
  });

  test('the three number sets never overlap each other or the vanilla table', () => {
    for (const key of Object.keys(BOOM_LINE_SPECIALS)) {
      assert.equal(LINE_SPECIALS[Number(key)], undefined, `${key} in both tables`);
    }
    for (const n of PARAM_LINE_SPECIALS) {
      assert.ok(!LINE_SPECIALS[n] && !BOOM_LINE_SPECIALS[n] && !NOOP_LINE_SPECIALS.has(n), `param ${n} unique`);
    }
    for (const n of NOOP_LINE_SPECIALS) {
      assert.ok(!LINE_SPECIALS[n] && !BOOM_LINE_SPECIALS[n], `no-op ${n} unique`);
    }
  });

  test('lookupSpecial serves the extended numbers', () => {
    assert.equal(lookupSpecial(227)?.effect.kind, 'elevator');
    assert.equal(lookupSpecial(78)?.effect.kind, 'changeOnly');
    assert.equal(lookupSpecial(197)?.effect.kind, 'exit');
    assert.equal(lookupSpecial(207)?.effect.kind, 'teleport');
    assert.equal(lookupSpecial(211)?.effect.kind, 'lift');
    // The render transfers are parameter lines, classified `param` and owned by
    // `specials/transfers.ts`, which `lookupSpecial` is still right to answer
    // null for.
    for (const n of [213, 242, 260, 261]) {
      assert.equal(classifyLineSpecial(n), 'param', `${n} is a parameter line`);
      assert.equal(lookupSpecial(n), null, `param ${n} is not a trigger`);
    }
    // MBF's sky transfer: settled as a no-op, since this engine draws no sky
    // for it to transfer (docs/specials.md § Scope).
    for (const n of [271, 272]) {
      assert.equal(classifyLineSpecial(n), 'noop', `${n} is a settled no-op`);
      assert.equal(lookupSpecial(n), null, `no-op ${n} is not a trigger`);
      assert.ok(!PARAM_LINE_SPECIALS.has(n), `${n} is only a no-op`);
    }
    assert.equal(lookupSpecial(300), null, 'an unassigned number is still unknown');
    assert.equal(classifyLineSpecial(300), 'unknown', 'and still reports as unknown');
  });
});

describe('Specials · elevators and motionless changes', () => {
  test('an elevator moves floor and ceiling in lockstep to the next floor', () => {
    const grid = gridMap(['amb'], {
      heights: {
        a: { floor: 0, ceil: 192 },
        m: { floor: 64, ceil: 192 },
        b: { floor: 32, ceil: 192 },
      },
    });
    const { map } = grid;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = 231; // W1 elevator down to next floor
    map.linedefs[line].tag = 1;
    map.sectors[1].tag = 1;
    const rig = specialsRig(map, grid.centre(0, 0));
    const gap = map.sectors[1].ceilHeight - map.sectors[1].floorHeight;
    rig.specials.update(TIC, { ...grid.centre(1, 0), angle: 0 }, NO_INPUT, new Set());
    for (let i = 0; i < 30; i++) {
      rig.tick();
      assert.equal(map.sectors[1].ceilHeight - map.sectors[1].floorHeight, gap, 'gap preserved mid-travel');
    }
    assert.equal(map.sectors[1].floorHeight, 32, 'next lower neighbor floor');
    assert.equal(map.sectors[1].ceilHeight, 32 + gap);
  });

  test('a changeOnly line copies flat and special instantly, no movement', () => {
    const grid = gridMap(['..']);
    const { map } = grid;
    map.sectors[0].floorTex = 'GRASS1';
    map.sectors[0].special = 4;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = 153; // W1 change, trigger model
    map.linedefs[line].tag = 2;
    map.sectors[1].tag = 2;
    const rig = specialsRig(map, grid.centre(0, 0));
    rig.specials.update(TIC, { ...grid.centre(1, 0), angle: 0 }, NO_INPUT, new Set());
    assert.equal(map.sectors[1].floorTex, 'GRASS1');
    assert.equal(map.sectors[1].special, 4);
    assert.equal(map.sectors[1].floorHeight, 0, 'nothing moved');
    rig.tick();
    assert.equal(map.sectors[1].floorHeight, 0);
  });
});
