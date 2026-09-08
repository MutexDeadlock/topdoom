import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap, addControlLine } from '../fixtures/gridmap.ts';
import { specialsRig, TIC } from '../fixtures/specialsrig.ts';

/**
 * `EV_DoPlat` (`p_plats.c`) — what a second trigger does to a lift that has
 * already finished its stroke. See docs/specials-movers.md § Retriggering a door,
 * whose rule the lift shares.
 */
describe('Specials · lifts', () => {
  /**
   * Three cells in a row: the middle one is the lift, tagged 1, with a low
   * neighbour west (floor 0) and a higher one east (floor 48), so
   * `lowestNeighborFloor` has somewhere to move to when the test changes it.
   * Each `special` becomes a control line on the same tag.
   */
  function rig(...specials: number[]) {
    const grid = gridMap(['lab'], {
      heights: { l: { floor: 0, ceil: 128 }, a: { floor: 64, ceil: 128 }, b: { floor: 48, ceil: 128 } },
    });
    const { map } = grid;
    const lift = grid.index(1, 0);
    const low = grid.index(0, 0);
    map.sectors[lift].tag = 1;
    const lines = specials.map((special) => {
      addControlLine(map, 64, 0, special, 1);
      return map.linedefs.length - 1;
    });
    const r = specialsRig(map, grid.centre(2, 0));
    const s = r.specials as unknown as {
      trigger(lineIndex: number, keys: Set<never>): unknown;
      floorMovers: Map<number, { state: string }>;
    };
    const run = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / TIC); i++) r.tick();
    };
    return {
      lines,
      run,
      trigger: (lineIndex: number) => s.trigger(lineIndex, new Set()),
      floor: () => map.sectors[lift].floorHeight,
      state: () => s.floorMovers.get(lift)?.state,
      /** Move the west neighbour, the way a floor mover on it would. */
      setLowNeighbour: (height: number) => {
        map.sectors[low].floorHeight = height;
      },
    };
  }

  /** One full down-wait-up stroke leaves the lift settled back where it started. */
  test('a lift comes to rest at its starting floor', () => {
    const d = rig(62); // SR lift
    d.trigger(d.lines[0]);
    d.run(5);
    assert.equal(d.floor(), 64, 'back up');
    assert.equal(d.state(), 'rest');
  });

  /**
   * `EV_DoPlat` builds a new thinker for a sector whose plat has been removed
   * (`P_RemoveActivePlat`), so the second line's speed is the one that runs —
   * the settled record's is spent. Restarting it in place ran a blazing lift
   * at the slow line's speed.
   */
  test('a rested lift re-triggers at the new line’s speed', () => {
    const d = rig(62, 123); // SR lift, then SR blazing lift
    d.trigger(d.lines[0]);
    d.run(5);
    assert.equal(d.state(), 'rest');
    d.trigger(d.lines[1]);
    d.run(0.2);
    // 8 u/tic covers 56 units in 0.2s, 4 u/tic only 28.
    assert.ok(d.floor() <= 64 - 50, `blazing speed, not the first line’s (fell to ${d.floor()})`);
  });

  /**
   * And its down-target is re-read: `plat->low = P_FindLowestFloorSurrounding`
   * runs per trigger, so a neighbour that moved in between changes where the
   * next stroke stops. The cached `downHeight` sent it to the old floor.
   */
  test('a rested lift re-reads its down-target', () => {
    const d = rig(62);
    d.trigger(d.lines[0]);
    d.run(5);
    assert.equal(d.floor(), 64);
    d.setLowNeighbour(56); // the 48-high neighbour is now the lowest
    d.trigger(d.lines[0]);
    d.run(5);
    assert.equal(d.floor(), 64, 'back up again');
    d.trigger(d.lines[0]);
    d.run(1);
    assert.equal(d.floor(), 48, 'stopped at the new lowest neighbour, not the old one');
  });
});
