import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOM_LINE_SPECIALS, LINE_SPECIALS, lookupSpecial } from '../../src/game/specials/tables.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, type SpecialsRigOptions } from '../fixtures/specialsrig.ts';

/**
 * A floor or ceiling mover whose resolved target sits on the far side of its
 * vanilla direction: `T_MovePlane` takes it in one step and reverts it whole if
 * a body no longer fits, rather than travelling there at mover speed. See
 * docs/specials-movers.md § Inverted plane moves.
 */
describe('Specials · inverted plane moves', () => {
  /**
   * Two cells: the tagged one at floor `start`, its neighbor at floor 128. WR
   * 83 ("lower floor to highest floor") on the boundary, triggered directly —
   * what is under test is the mover, not the crossing.
   */
  function rig(start: number, blocksFloorRise?: SpecialsRigOptions['blocksFloorRise']) {
    const grid = gridMap(['ab'], {
      heights: { a: { floor: start, ceil: 256 }, b: { floor: 128, ceil: 256 } },
    });
    const { map } = grid;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = 83;
    map.linedefs[line].tag = 1;
    map.sectors[0].tag = 1;
    const r = specialsRig(map, grid.centre(0, 0), { blocksFloorRise });
    const s = r.specials as unknown as { floorMovers: Map<number, { state: string }> };
    const pull = () => {
      r.trigger(line);
      r.tick();
    };
    return { map, rig: r, s, pull };
  }

  test('a target above a lowering floor is reached inside one tic', () => {
    const { map, s, pull } = rig(0);
    pull();
    assert.equal(map.sectors[0].floorHeight, 128, 'snapped straight to the highest neighbor floor');
    assert.equal(s.floorMovers.get(0)?.state, 'done', 'and reported pastdest — no mover left crawling');
  });

  test('a body without headroom there refuses the jump whole', () => {
    const { map, s, pull } = rig(0, () => true);
    pull();
    assert.equal(map.sectors[0].floorHeight, 0, 'put straight back where it was, not left partway');
    assert.equal(s.floorMovers.get(0)?.state, 'done');
  });

  test('a ceiling raise whose target is below it drops there in one tic', () => {
    // 40, `raiseToHighest`, on a sector already taller than every neighbor —
    // the ceiling's own easiest route to an inverted target.
    const grid = gridMap(['ab'], {
      heights: { a: { floor: 0, ceil: 256 }, b: { floor: 0, ceil: 128 } },
    });
    const { map } = grid;
    const line = grid.westEdge(1, 0);
    map.linedefs[line].special = 40;
    map.linedefs[line].tag = 1;
    map.sectors[0].tag = 1;
    const r = specialsRig(map, grid.centre(0, 0));
    r.trigger(line);
    r.tick();
    assert.equal(map.sectors[0].ceilHeight, 128, 'snapped down to the highest neighbor ceiling');
  });

  test('the ordinary direction still travels at mover speed', () => {
    const { map, rig: r, pull } = rig(256);
    pull();
    assert.ok(map.sectors[0].floorHeight > 128, 'still on its way down after one tic');
    for (let i = 0; i < 130; i++) r.tick();
    assert.equal(map.sectors[0].floorHeight, 128);
  });
});

/**
 * Every floor number in the tables, split by the direction its vanilla
 * `EV_DoFloor` case fixes — read off the **case** (`p_floor.c`), which is where
 * vanilla hangs `floor->direction`, never off the target height.
 * `tables.ts: FLOOR_TARGET_DIRECTION` derives the same answer from the target,
 * which is only safe while the two agree; this is what checks they do, and what
 * makes a new number answer the question independently. One whose case
 * disagrees passes `floor()`'s `direction` option instead — none does today.
 */
describe('Specials · plane directions', () => {
  /** `lowerFloor`, `lowerFloorToLowest`, `turboLower`, and Boom's `lowerFloorToNearest`. */
  const LOWERING = [19, 45, 83, 102, 23, 38, 60, 82, 36, 70, 71, 98, 219, 220, 221, 222];
  /**
   * `raiseFloor` (+`Crush`), `raiseFloorToNearest` (+`Turbo`, +`AndChange`),
   * `raiseFloor24` (+`AndChange`), `raiseFloor512`, and the 14/15/66/67 family's
   * `EV_DoPlat(raiseAndChange)`, which is a plat rather than a floor in vanilla
   * but is just as firmly one-directional.
   */
  const RAISING = [
    5, 24, 64, 91, 101, 55, 56, 65, 94, 18, 69, 119, 128, 129, 130, 131, 132, 20, 22, 47, 68, 95, 58,
    59, 92, 93, 140, 14, 15, 66, 67, 142, 143, 144, 147, 148, 149, 160, 161, 178, 179, 180,
  ];

  test('every number moves the way its vanilla case does', () => {
    for (const [numbers, direction] of [
      [LOWERING, 'down'],
      [RAISING, 'up'],
    ] as const) {
      for (const n of numbers) {
        const effect = lookupSpecial(n)?.effect;
        assert.equal(effect?.kind, 'floor', `special ${n} is a floor mover`);
        assert.equal(effect.kind === 'floor' && effect.direction, direction, `special ${n} direction`);
      }
    }
  });

  /** `EV_DoCeiling`: `raiseToHighest` is the only +1 case; every other ceiling number lowers. */
  const CEILINGS_UP = [40, 151, 166, 186];
  /** `lowerToFloor`, `lowerAndCrush`, and Boom's `lowerToLowest`/`lowerToMaxFloor`. */
  const CEILINGS_DOWN = [41, 43, 44, 72, 145, 152, 167, 187, 199, 200, 201, 202, 203, 204, 205, 206];

  test('every ceiling number does too', () => {
    for (const [numbers, direction] of [
      [CEILINGS_DOWN, 'down'],
      [CEILINGS_UP, 'up'],
    ] as const) {
      for (const n of numbers) {
        const effect = lookupSpecial(n)?.effect;
        assert.equal(effect?.kind, 'ceiling', `special ${n} is a ceiling mover`);
        assert.equal(effect.kind === 'ceiling' && effect.direction, direction, `special ${n} direction`);
      }
    }
  });

  test('and no floor or ceiling number escapes the split', () => {
    const listed = new Set([...LOWERING, ...RAISING, ...CEILINGS_UP, ...CEILINGS_DOWN]);
    for (const table of [LINE_SPECIALS, BOOM_LINE_SPECIALS]) {
      for (const [key, def] of Object.entries(table)) {
        if (def.effect.kind !== 'floor' && def.effect.kind !== 'ceiling') continue;
        assert.ok(listed.has(Number(key)), `${def.effect.kind} special ${key} has no stated vanilla-case direction`);
      }
    }
  });
});
