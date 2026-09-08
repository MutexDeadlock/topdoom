import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addControlLine, gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, TIC } from '../fixtures/specialsrig.ts';
import { NO_SIDE, type DoomMap } from '../../src/wad/map.ts';

/**
 * A **self-referencing** line — one whose two sidedefs name the same sector — used to come back
 * from `getNextSector` as the sector itself, so a sector fenced off by them was its own highest and
 * lowest neighbour and every mover aimed at a neighbour height had nowhere to go. Boom fixes this
 * (docs/world.md § Self-referencing lines); the repro is NoSp2.wad MAP04's platform, sector 102,
 * which the switch on linedef 445 (special 71) is supposed to drop into the room below it.
 *
 * Second defect on the same press, and the reason the platform *rose*: vanilla's `turboLower` adds
 * its 8 only when the search found a height other than the sector's own (docs/specials-movers.md §
 * The turboLower quad).
 */

/**
 * A two-sided line both of whose sides name `sectorIndex`, appended outside the playfield. Only its
 * membership in the sector's own line list matters to `getNextSector` — that is the whole of what a
 * real self-referencing fence contributes to a neighbour search — and keeping it off the map proper
 * leaves the fixture's BSP alone.
 */
function addSelfReferencingLine(map: DoomMap, sectorIndex: number): void {
  const v = map.vertexes.length;
  map.vertexes.push({ x: -8192, y: -8192 }, { x: -8192, y: -8128 });
  const side = () =>
    map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector: sectorIndex }) - 1;
  map.linedefs.push({ v1: v, v2: v + 1, flags: 0, special: 0, tag: 0, right: side(), left: side() });
  assert.notEqual(map.linedefs.at(-1)!.left, NO_SIDE, 'the fence line is two-sided');
}

/**
 * One platform cell between two cells at floor 0, tagged 1, with `special` on a control line — and
 * a self-referencing fence line of its own, the way a Boom map hides a platform's edge.
 */
function rig(special: number, platformFloor: number) {
  const grid = gridMap(['.p.'], {
    heights: { '.': { floor: 0, ceil: 128 }, p: { floor: platformFloor, ceil: 184 } },
  });
  const { map } = grid;
  const platform = grid.index(1, 0);
  map.sectors[platform].tag = 1;
  addSelfReferencingLine(map, platform);
  addControlLine(map, 64, 0, special, 1);
  const line = map.linedefs.length - 1;
  const r = specialsRig(map, grid.centre(0, 0));
  const s = r.specials as unknown as { trigger(lineIndex: number, keys: Set<never>): unknown };
  return {
    map,
    world: r.world,
    platform,
    press: () => s.trigger(line, new Set()),
    run: (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / TIC); i++) r.tick();
    },
    floor: () => map.sectors[platform].floorHeight,
  };
}

describe('Regressions · self-referencing lines and the neighbour search', () => {
  test('a self-referencing line does not make a sector its own neighbour', () => {
    const d = rig(71, 64);
    assert.equal(d.world.highestNeighborFloor(d.platform), 0, "the room's floor, not the platform's own 64");
    assert.equal(d.world.lowestNeighborFloor(d.platform), 0);
  });

  test('an S1 turboLower drops the fenced platform to 8 above the room', () => {
    const d = rig(71, 64);
    d.press();
    d.run(5);
    // `P_FindHighestFloorSurrounding` is 0 and differs from the platform's own 64, so the 8
    // applies.
    assert.equal(d.floor(), 8);
  });

  test('a turboLower already level with its highest neighbour stays put instead of rising 8', () => {
    const d = rig(71, 0);
    d.press();
    d.run(5);
    assert.equal(d.floor(), 0, 'the conditional +8: a lowering mover is never handed a target above its floor');
  });
});
