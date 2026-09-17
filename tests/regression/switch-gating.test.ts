import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DoomMap } from '../../src/wad/map.ts';
import type { Pos2 } from '../../src/types.ts';
import type { SpecialsController } from '../../src/game/specials.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, TIC } from '../fixtures/specialsrig.ts';
import { NO_INPUT } from '../fixtures/input.ts';

/**
 * Two rules a switch has to keep, both confirmed against `linuxdoom-1.10` rather than the wiki:
 *
 * - `P_UseSpecialLine` flips a switch (and spends a one-shot line) only when its
 *   EV_ call reported it did something. A no-op press that consumed the line
 *   left an S1 switch dead for the rest of the level.
 * - `P_ChangeSwitchTexture` only starts a revert timer for a repeatable switch, so a one-shot one
 *   stays pressed for good.
 *
 * The crusher half of this pair is `crusher-stasis.test.ts`.
 * See docs/specials.md § A switch only flips when it acts.
 */

/**
 * The rig's controller as these tests drive it: `update` picked off the class so its signature is
 * never re-declared here, plus the two private members they reach for. `SpecialsController &` will
 * not do — TS treats private members nominally, so intersecting over them yields `never`.
 */
type SwitchProbe = Pick<SpecialsController, 'update'> & {
  trigger(i: number, keys: Set<never>): unknown;
  usedOnce: Set<number>;
};

function controller(map: DoomMap, at: Pos2): SwitchProbe {
  return specialsRig(map, at).specials as unknown as SwitchProbe;
}

/**
 * Two rooms either side of a corridor. Both switch lines carry the same tag, so
 * either can drive the target sector — which is what lets one be pressed while
 * the other's effect is still running.
 */
function twoSwitchMap(special: number) {
  const grid = gridMap(['#####', '#...#', '#####'], { heights: { '.': { floor: 0, ceil: 128 } } });
  const map = grid.map;
  const left = grid.index(1, 1);
  const mid = grid.index(2, 1);
  const target = grid.index(3, 1);
  map.sectors[target].tag = 1;
  const lineA = grid.edgeBetween(left, mid);
  const lineB = grid.edgeBetween(mid, target);
  for (const i of [lineA, lineB]) {
    map.linedefs[i].special = special;
    map.linedefs[i].tag = 1;
  }
  return { grid, map, lineA, lineB, target };
}

describe('Regressions · a switch only flips when it acts', () => {
  test('an S1 switch whose effect does nothing is neither flipped nor spent', () => {
    // 23 = S1 lower floor to lowest: one-shot, use-triggered, and slow enough
    // that the second press lands while the first is still running.
    const { grid, map, lineA, lineB } = twoSwitchMap(23);
    const start = grid.centre(1, 1);
    const specials = controller(map, start);

    specials.trigger(lineA, new Set());
    assert.ok(specials.usedOnce.has(lineA), 'the first switch acted, so it is spent');

    // The target sector is now busy, so this one's EV_DoFloor finds nothing to do.
    specials.trigger(lineB, new Set());
    assert.equal(
      specials.usedOnce.has(lineB),
      false,
      'a switch that did nothing must stay usable — vanilla only spends it inside if (EV_DoFloor(...))',
    );

    // Let the floor finish, then the same line works and is spent.
    for (let i = 0; i < 400; i++) specials.update(TIC, { ...start, angle: 0 }, NO_INPUT, new Set());
    specials.trigger(lineB, new Set());
    assert.ok(specials.usedOnce.has(lineB), 'once the sector is free the switch acts and is spent');
  });

  test('a one-shot switch stays pressed; a repeatable one reverts after BUTTONTIME', () => {
    // `P_ChangeSwitchTexture` only calls `P_StartButton` when `useAgain` is set,
    // so an S1 switch has no revert timer at all. Reverting it too made every
    // pressed switch in the game flick back to its unpressed art.
    // Each switch drives its *own* target sector: pointed at the same one, the
    // second press would correctly be a no-op and never flip (§ gating above).
    const grid = gridMap(['#######', '#.....#', '#######'], { heights: { '.': { floor: 0, ceil: 128 } } });
    const map = grid.map;
    map.sectors[grid.index(4, 1)].tag = 1;
    map.sectors[grid.index(5, 1)].tag = 2;

    const once = grid.edgeBetween(grid.index(1, 1), grid.index(2, 1)); // 103 = S1 open door
    const again = grid.edgeBetween(grid.index(2, 1), grid.index(3, 1)); // 61 = SR open door
    map.linedefs[once].special = 103;
    map.linedefs[once].tag = 1;
    map.linedefs[again].special = 61;
    map.linedefs[again].tag = 2;
    for (const i of [once, again]) map.sidedefs[map.linedefs[i].right].middle = 'SW1BRCOM';

    const start = grid.centre(1, 1);
    const specials = controller(map, start);
    const art = (i: number) => map.sidedefs[map.linedefs[i].right].middle;

    specials.trigger(once, new Set());
    specials.trigger(again, new Set());
    assert.equal(art(once), 'SW2BRCOM', 'both flip on the press');
    assert.equal(art(again), 'SW2BRCOM');

    // Well past BUTTONTIME (35 tics).
    for (let i = 0; i < 70; i++) specials.update(TIC, { ...start, angle: 0 }, NO_INPUT, new Set());
    assert.equal(art(once), 'SW2BRCOM', 'the one-shot switch is pressed for good — no P_StartButton');
    assert.equal(art(again), 'SW1BRCOM', 'the repeatable one reverts so it can be pressed again');
  });
});
