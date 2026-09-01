import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, NO_INPUT, TIC } from '../fixtures/specialsrig.ts';
import type { DoomMap } from '../../src/wad/map.ts';

/**
 * The perpetual plat family (53/87) and its stop line (54/89) — vanilla
 * numbers this engine gained only with the Boom work.
 * See docs/specials.md § Perpetual lifts and the stop line.
 */
describe('Specials · perpetual lifts', () => {
  /**
   * Three cells: floors 64 / 0 / 32, so the middle sector's perpetual travel
   * is 0..64. The a|middle edge carries the perpetual trigger (87, WR), the
   * middle|b edge carries the stop (89, WR), both tag 1.
   */
  function rigWithPerpetual() {
    const grid = gridMap(['a.b'], {
      heights: { a: { floor: 64, ceil: 192 }, b: { floor: 32, ceil: 192 } },
    });
    const { map } = grid;
    const perpetualLine = grid.westEdge(1, 0);
    const stopLine = grid.westEdge(2, 0);
    map.linedefs[perpetualLine].special = 87;
    map.linedefs[perpetualLine].tag = 1;
    map.linedefs[stopLine].special = 89;
    map.linedefs[stopLine].tag = 1;
    map.sectors[1].tag = 1;
    const rig = specialsRig(map, grid.centre(0, 0));
    const cross = (line: number) => {
      const [a, b] = [map.vertexes[map.linedefs[line].v1], map.vertexes[map.linedefs[line].v2]];
      const x = a.x; // vertical edge
      const y = (a.y + b.y) / 2;
      rig.specials.update(TIC, { x: x - 8, y, angle: 0 }, NO_INPUT, new Set());
      rig.specials.update(TIC, { x: x + 8, y, angle: 0 }, NO_INPUT, new Set());
    };
    return { map, rig, cross, perpetualLine, stopLine };
  }

  function heightsOver(map: DoomMap, rig: { tick: (dt?: number) => void }, tics: number): number[] {
    const seen: number[] = [];
    for (let i = 0; i < tics; i++) {
      rig.tick();
      seen.push(map.sectors[1].floorHeight);
    }
    return seen;
  }

  test('a perpetual plat bounces between the lowest and highest neighbor floor forever', () => {
    const { map, rig, cross, perpetualLine } = rigWithPerpetual();
    cross(perpetualLine);
    const seen = heightsOver(map, rig, 4000);
    assert.ok(seen.includes(0), 'reached the lowest neighbor floor');
    assert.ok(seen.includes(64), 'reached the highest neighbor floor');
    // Still bouncing at the end, not settled: the last second of travel moves.
    const tail = seen.slice(-70);
    assert.ok(new Set(tail).size > 1, 'still moving after many cycles');
  });

  test('the stop line freezes it in place; only a perpetual re-trigger resumes it', () => {
    const { map, rig, cross, perpetualLine, stopLine } = rigWithPerpetual();
    cross(perpetualLine);
    // Let it get properly underway, away from both ends.
    for (let i = 0; i < 20; i++) rig.tick();
    cross(stopLine);
    const frozen = map.sectors[1].floorHeight;
    for (let i = 0; i < 200; i++) rig.tick();
    assert.equal(map.sectors[1].floorHeight, frozen, 'in stasis, nothing moves');

    // The mover snapshot carries the stasis, so a save taken now restores it.
    const saved = rig.specials.snapshot();
    const savedLift = saved.movers.find(([i]) => i === 1)?.[1];
    assert.equal(savedLift?.kind, 'lift');
    assert.equal(savedLift?.kind === 'lift' && savedLift.state, 'stasis');

    cross(perpetualLine);
    const seen = heightsOver(map, rig, 300);
    assert.ok(new Set(seen).size > 1, 'reactivated by the perpetual trigger');
  });
});
