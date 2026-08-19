import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh, buildMoverMesh, type FlatSurface } from '../../src/render/mapmesh.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMoverIndex } from '../../src/game/specials/movergeometry.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { gridMap, type GridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * The lid over a leaf whose every side is an untextured drop — GZDoom's
 * missing-lower-texture hack, which this camera needs because it looks into
 * every pit. See docs/render.md § Closed holes.
 */

const OWN_FLAT = 'FLAT5_4';
const RIM_FLAT = 'FLOOR0_1';
const DEPTH = 128;

/** A 3×3 grid whose middle cell is a pit: floor `DEPTH` below the ring around it, no lower textures. */
function pit(): {
  grid: GridMap;
  centre: number;
  rim: number[];
  lids: (movable?: Set<number>) => FlatSurface[];
} {
  const grid = gridMap(['...', '...', '...']);
  const map = grid.map;
  const centre = grid.index(1, 1);
  const rim = [grid.index(0, 1), grid.index(2, 1), grid.index(1, 0), grid.index(1, 2)];
  map.sectors[centre].floorHeight = -DEPTH;
  map.sectors[centre].floorTex = OWN_FLAT;
  for (const r of rim) {
    map.sectors[r].floorTex = RIM_FLAT;
    map.sectors[r].light = 200;
  }
  const lids = (movableSectors?: Set<number>) =>
    buildMapMesh(map, BANK, { transfers: transfersOf(map), movableSectors }).flatSurfaces.filter(
      (f) => f.subsector === centre && f.height !== -DEPTH,
    );
  return { grid, centre, rim, lids };
}

/** The sidedef of `line` that faces `sector` — which side that is depends on the map's winding. */
function sideFacing(map: DoomMap, line: number, sector: number) {
  const l = map.linedefs[line];
  const own = [l.right, l.left].find((s) => s !== NO_SIDE && map.sidedefs[s].sector === sector);
  assert.notEqual(own, undefined, 'line does not border that sector');
  return map.sidedefs[own!];
}

describe('Rendering · closed holes', () => {
  test('a leaf ringed by untextured drops is lidded with the surrounding floor', () => {
    const { centre, rim, lids } = pit();
    const lid = lids();
    assert.equal(lid.length, 1);
    assert.equal(lid[0].height, 0, 'the lid sits at the neighbours’ floor, not its own');
    assert.equal(lid[0].key, 'flat:' + RIM_FLAT, 'and wears their flat, not the pit’s');
    assert.ok(rim.includes(lid[0].lightSector), 'lit from the sector it borrowed the plane from, not the pit');
    assert.equal(lid[0].isCeiling, false);
    assert.equal(lid[0].subsector, centre, 'it fades with the leaf it covers');
  });

  test('the pit’s own floor is still drawn under the lid', () => {
    const { grid, centre } = pit();
    const fans = buildMapMesh(grid.map, BANK, { transfers: transfersOf(grid.map) }).flatSurfaces.filter(
      (f) => f.subsector === centre,
    );
    assert.deepEqual(
      fans.map((f) => f.height).sort((a, b) => a - b),
      [-128, 0],
    );
  });

  test('one textured step is enough to make it ordinary geometry', () => {
    const { grid, centre, lids } = pit();
    sideFacing(grid.map, grid.westEdge(1, 1), centre).lower = 'STEP1';
    assert.equal(lids().length, 0);
  });

  test('neighbours at different heights get no lid — the plane has no one height', () => {
    const { grid, lids } = pit();
    grid.map.sectors[grid.index(1, 0)].floorHeight = 32;
    assert.equal(lids().length, 0);
  });

  test('a leaf that is merely lower on one side is not a hole', () => {
    const { grid, lids } = pit();
    grid.map.sectors[grid.index(1, 0)].floorHeight = -128;
    assert.equal(lids().length, 0);
  });

  test('no lid over a movable neighbour, whose height the lid would go stale against', () => {
    const { grid, lids } = pit();
    assert.equal(lids().length, 1);
    assert.equal(lids(new Set([grid.index(1, 0)])).length, 0);
  });
});

/**
 * The same pit, but as a *mover* — the shape EPIC.WAD MAP01's sector 88 has,
 * the map this was reported on (docs/render.md § Closed holes): a tagged sector
 * whose flats come from its own mover mesh rather than the static batches, and
 * whose lid has to come and go with its floor.
 */
describe('Regressions · a pit that is also a mover', () => {
  /** The pit sector's own mover mesh, the one the running game would draw its flats from. */
  function moverFans(map: DoomMap, sector: number) {
    const polys = buildSubSectorPolys(map);
    const options = { transfers: transfersOf(map), movableSectors: new Set([sector]) };
    return buildMoverMesh(map, polys, sector, BANK, options, buildMoverIndex(map, polys)).flatFans;
  }

  test('the mover mesh lids it too, not just the static batches', () => {
    const { grid, centre } = pit();
    const fans = moverFans(grid.map, centre);
    assert.deepEqual(
      fans.map((f) => f.height).sort((a, b) => a - b),
      [-DEPTH, 0],
      'its own floor, and the lid over it',
    );
    assert.equal(fans.find((f) => f.height === 0)?.key, 'flat:' + RIM_FLAT);
  });

  test('and drops the lid once the floor has risen flush', () => {
    const { grid, centre } = pit();
    grid.map.sectors[centre].floorHeight = 0;
    assert.deepEqual(
      moverFans(grid.map, centre).map((f) => f.height),
      [0],
      'the real floor, and nothing on top of it',
    );
  });
});

/**
 * The false positive the per-leaf test used to have: vanilla SEGS carry no
 * minisegs, so a BSP leaf's splits into the rest of its own sector are invisible
 * here, and a leaf left with a single seg reads as fully enclosed by it.
 * Repro: DOOM2 MAP01 subsector 22, one seg on line 335 (the barred alcove's
 * higher floor), which lidded 23,000 map units² of the courtyard's grass with
 * the alcove's flat. docs/render.md § Closed holes.
 */
describe('Regressions · a leaf of an open room is not a hole', () => {
  /**
   * Three cells in a row: the west one raised, the other two one room, whose
   * east leaf keeps only the seg on the drop — the shape a node split leaves.
   */
  function room(): { grid: GridMap; leaf: number } {
    const grid = gridMap(['...']);
    const map = grid.map;
    const raised = grid.index(0, 0);
    const leaf = grid.index(1, 0);
    const rest = grid.index(2, 0);
    map.sectors[raised].floorHeight = 128;
    map.sectors[raised].floorTex = RIM_FLAT;
    // One room over both open cells, so the line between them has it on both sides.
    for (const side of map.sidedefs) {
      if (side.sector === rest) side.sector = leaf;
    }
    const drop = map.subsectors[leaf].first;
    assert.equal(map.segs[drop].linedef, grid.westEdge(1, 0), 'the west edge is the leaf’s first seg');
    map.subsectors[leaf] = { first: drop, count: 1 };
    return { grid, leaf };
  }

  test('a leaf whose one seg is an untextured drop gets no lid', () => {
    const { grid, leaf } = room();
    const lids = buildMapMesh(grid.map, BANK, { transfers: transfersOf(grid.map) }).flatSurfaces.filter(
      (f) => f.subsector === leaf && f.height !== 0,
    );
    assert.deepEqual(lids, [], 'the room has one-sided walls elsewhere, so it is not a pit');
  });
});
