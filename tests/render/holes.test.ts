import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMapMesh, buildMoverMesh, NO_TEXTURE, type FlatSurface } from '../../src/render/mapmesh.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMoverIndex } from '../../src/game/specials/movergeometry.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { computeMovableSectors } from '../../src/game/specials/mapscan.ts';
import { loadMap, NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { Wad, WadFile } from '../../src/wad/wad.ts';
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
 * The map the black-pit report was made on, checked against GZDoom: EPIC.WAD
 * MAP01's sector 88 is three 64×64 pits sunk 128 below the grass of sector 14,
 * with no lower textures on any of their twelve lines. It is also tagged, so
 * its flats come from a mover mesh rather than the static batches.
 */
describe('Regressions · EPIC MAP01 black pits', () => {
  const path = new URL('../../public/wads/pwad/EPIC.WAD', import.meta.url);
  const file = readFileSync(path);
  const wad = new Wad([
    new WadFile(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer, 'EPIC.WAD'),
  ]);
  const map = loadMap(wad, 'MAP01');

  test('the WAD still holds the geometry this is about', () => {
    assert.equal(map.sectors[88].floorHeight, -144);
    assert.equal(map.sectors[88].floorTex, 'GRASS1');
    assert.equal(map.sectors[14].floorHeight, -16);
    assert.equal(map.sectors[14].floorTex, 'GRASS1');
    const rim = map.linedefs.flatMap((l, i) =>
      l.left !== NO_SIDE && [l.right, l.left].some((s) => map.sidedefs[s].sector === 88) ? [i] : [],
    );
    assert.equal(rim.length, 12);
    for (const line of rim) {
      assert.equal(sideFacing(map, line, 88).lower, NO_TEXTURE, 'the pit sides draw nothing — that is the bug');
    }
  });

  /** Sector 88's own mover mesh, the one the running game draws its flats from. */
  const moverFans = (m: DoomMap) => {
    const polys = buildSubSectorPolys(m);
    const movableSectors = computeMovableSectors(m);
    assert.ok(movableSectors.has(88), 'sector 88 is tagged by line 585, so it builds a mover mesh');
    const options = { transfers: transfersOf(m), movableSectors };
    return buildMoverMesh(m, polys, 88, BANK, options, buildMoverIndex(m, polys)).flatFans;
  };

  test('each pit is lidded at the grass around it', () => {
    const lids = moverFans(map).filter((f) => f.height === -16);
    assert.equal(lids.length, 3, 'one per pit');
    for (const lid of lids) assert.equal(lid.key, 'flat:GRASS1');
  });

  test('and loses the lid once line 585 has raised the pits flush', () => {
    const raised = { ...map, sectors: map.sectors.map((s, i) => (i === 88 ? { ...s, floorHeight: -16 } : s)) };
    const fans = moverFans(raised).filter((f) => f.height === -16);
    assert.equal(fans.length, 3, 'the real floors, and nothing on top');
  });
});
