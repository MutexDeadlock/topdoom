import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, type SpecialsRigOptions } from '../fixtures/specialsrig.ts';

/**
 * A floor mover whose resolved target sits on the far side of its vanilla
 * direction: `T_MovePlane` takes it in one step and reverts it whole if a body
 * no longer fits, rather than travelling there at mover speed. See
 * docs/specials.md § Inverted floor moves.
 */
describe('specials · inverted floor moves', () => {
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
    const s = r.specials as unknown as {
      trigger(lineIndex: number, keys: Set<never>): unknown;
      floorMovers: Map<number, { state: string }>;
    };
    const pull = () => {
      s.trigger(line, new Set());
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

  test('the ordinary direction still travels at mover speed', () => {
    const { map, rig: r, pull } = rig(256);
    pull();
    assert.ok(map.sectors[0].floorHeight > 128, 'still on its way down after one tic');
    for (let i = 0; i < 130; i++) r.tick();
    assert.equal(map.sectors[0].floorHeight, 128);
  });
});
