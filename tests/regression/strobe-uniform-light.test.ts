import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { darkestNeighborLight } from '../../src/game/world.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, TIC } from '../fixtures/specialsrig.ts';

/**
 * A strobe with nothing darker around it blinks to black rather than standing
 * still (`P_SpawnStrobeFlash`'s `minlight == maxlight` rule), and the dark
 * level it starts from is `P_FindMinSurroundingLight` — seeded with the
 * sector's own level, so it never resolves *upward*. Reported against EPIC.WAD
 * MAP02 sector 0, a type-2 sector at light 240 whose one neighbour is also 240:
 * the strobe was invisible. See docs/specials.md § Lights.
 */

const LIGHT = 240;

/** Two open cells, the left one strobing (sector type 2), with the lights a test picks. */
function strobe(own: number, neighbor: number) {
  const grid = gridMap(['..']);
  const map = grid.map;
  const lit = grid.index(0, 0);
  map.sectors[lit].special = 2;
  map.sectors[lit].light = own;
  map.sectors[grid.index(1, 0)].light = neighbor;
  const rig = specialsRig(map, grid.centre(0, 0));
  return { map, lit, tick: (dt: number) => rig.tick(dt) };
}

describe('Regressions · a strobe with no darker neighbour', () => {
  test('blinks to black instead of to its own level', () => {
    const { map, lit, tick } = strobe(LIGHT, LIGHT);
    assert.equal(map.sectors[lit].light, LIGHT, 'starts lit');
    tick(TIC);
    assert.equal(map.sectors[lit].light, 0, 'vanilla forces minlight to 0 when it matches maxlight');
  });

  test('a real darker neighbour is still what it dims to', () => {
    const { map, lit, tick } = strobe(LIGHT, 96);
    tick(TIC);
    assert.equal(map.sectors[lit].light, 96);
  });

  test('a brighter neighbour never raises the dark level', () => {
    const grid = gridMap(['..']);
    const map = grid.map;
    map.sectors[grid.index(0, 0)].light = 96;
    map.sectors[grid.index(1, 0)].light = LIGHT;
    assert.equal(
      darkestNeighborLight(map, grid.index(0, 0)),
      96,
      'P_FindMinSurroundingLight seeds with the sector itself and only lowers',
    );
  });
});
