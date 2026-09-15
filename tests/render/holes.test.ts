import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh, buildMoverMesh, type FlatSurface } from '../../src/render/mapmesh.ts';
import { underHoleLid } from '../../src/render/mapmesh/flats.ts';
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

  test('a body under the lid is reported as buried, one poking out above it or on the rim is not', () => {
    const { grid, centre, rim, lids } = pit();
    assert.equal(lids().length, 1, 'the pass has run');
    const body = 56;
    assert.equal(underHoleLid(grid.map, centre, -DEPTH + body / 2), true, 'a monster on the pit floor');
    assert.equal(underHoleLid(grid.map, centre, 32), false, 'a middle above the lid is what vanilla shows');
    assert.equal(underHoleLid(grid.map, rim[0], body / 2), false, 'the rim is ordinary floor');
  });

  test('a textured step buries nobody — there is no lid to hide behind', () => {
    const { grid, centre, lids } = pit();
    sideFacing(grid.map, grid.westEdge(1, 1), centre).lower = 'STEP1';
    assert.equal(lids().length, 0);
    assert.equal(underHoleLid(grid.map, centre, -DEPTH + 28), false);
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
    return buildMoverMesh({ map, polys, bank: BANK, options, index: buildMoverIndex(map, polys) }, sector).flatFans;
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

/**
 * What the per-sector test could not see. A hole is a region of *leaves*, so it may span sectors at
 * several depths, and a sector's leaves may fall into pieces that have nothing to do with each
 * other. Repro: overboard.wad MAP02's sunken boat, 16 sectors between −272 and −160 under a sea at
 * 0, two of whose sectors also own a walled closet parked off the map.
 * docs/render.md § Closed holes.
 */
describe('Rendering · a closed hole spanning several sectors', () => {
  const DEEP = -128;
  const SHELF = -64;

  /** A 5×5 grid whose two middle cells are a two-step hole in an otherwise flat floor. */
  function trench(): { grid: GridMap; deep: number; shelf: number; lids: () => FlatSurface[] } {
    const grid = gridMap(['.....', '.....', '.....', '.....', '.....']);
    const deep = grid.index(2, 2);
    const shelf = grid.index(2, 1);
    grid.map.sectors[deep].floorHeight = DEEP;
    grid.map.sectors[deep].floorTex = OWN_FLAT;
    grid.map.sectors[shelf].floorHeight = SHELF;
    grid.map.sectors[shelf].floorTex = OWN_FLAT;
    for (const sector of grid.map.sectors) {
      if (sector.floorHeight === 0) sector.floorTex = RIM_FLAT;
    }
    const lids = () =>
      buildMapMesh(grid.map, BANK, { transfers: transfersOf(grid.map) }).flatSurfaces.filter(
        (f) => (f.subsector === deep || f.subsector === shelf) && f.height === 0,
      );
    return { grid, deep, shelf, lids };
  }

  test('both floors are lidded, at the one height the rim stands at', () => {
    const { deep, shelf, lids } = trench();
    const lid = lids();
    assert.deepEqual(
      lid.map((f) => f.subsector).sort((a, b) => a - b),
      [shelf, deep].sort((a, b) => a - b),
      'the shelf is inside the hole, not its rim',
    );
    assert.deepEqual(new Set(lid.map((f) => f.key)), new Set(['flat:' + RIM_FLAT]));
  });

  test('a textured step anywhere on the rim is enough to make it ordinary geometry', () => {
    const { grid, deep, lids } = trench();
    sideFacing(grid.map, grid.westEdge(2, 2), deep).lower = 'STEP1';
    assert.deepEqual(lids(), []);
  });

  test('a wall inside the region says it is a room, not a hole', () => {
    const { grid, lids } = trench();
    // The shelf's own north side walled off: a one-sided line, reached only through the deep cell.
    const wall = grid.map.linedefs[grid.westEdge(2, 1)];
    wall.left = NO_SIDE;
    assert.deepEqual(lids(), []);
  });

  test('the lid goes once the region has risen flush', () => {
    const { grid, deep, shelf } = trench();
    grid.map.sectors[deep].floorHeight = 0;
    grid.map.sectors[shelf].floorHeight = 0;
    const fans = buildMapMesh(grid.map, BANK, { transfers: transfersOf(grid.map) }).flatSurfaces.filter(
      (f) => f.subsector === deep || f.subsector === shelf,
    );
    assert.deepEqual(
      fans.map((f) => f.height),
      [0, 0],
      'one real floor each, and nothing on top of them',
    );
  });

  test('a walled second piece of a hole’s sector does not veto it', () => {
    const { grid, deep, shelf, lids } = trench();
    // The corner cell, whose outer sides are the map's own one-sided walls, made part of the deep
    // sector — a piece of it the hole never touches, and so no evidence about the hole.
    const closet = grid.index(0, 0);
    for (const side of grid.map.sidedefs) {
      if (side.sector === closet) side.sector = deep;
    }
    grid.map.sectors[closet].floorHeight = DEEP;
    assert.deepEqual(
      lids()
        .map((f) => f.subsector)
        .sort((a, b) => a - b),
      [shelf, deep].sort((a, b) => a - b),
    );
  });
});
