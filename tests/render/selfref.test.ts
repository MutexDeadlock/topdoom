import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type DoomMap } from '../../src/wad/map.ts';
import { buildSubSectorPolys, sectorOfSubSector } from '../../src/render/bsp.ts';
import { bspMap, leaf, plane, seg, twoSided, wall, type BspMapParts } from '../fixtures/bspmap.ts';
import { polygonArea } from '../fixtures/geometry.ts';

/**
 * A leaf bounded only by self-referencing lines is drawn as the sector
 * enclosing it, while the BSP sector stays the hidden one for gameplay.
 * See docs/render.md § Self-referencing sectors.
 */

/**
 * A 1024-square room (sector 0) with one line lying across its middle whose two
 * sidedefs both point at a hidden sector 1 — the self-referencing trick, the
 * shape of BOOMEDIT MAP01's line 171 inside sector 30. `selfRef` false wires
 * the line as an ordinary two-sided border (right side sector 1, left side
 * sector 0) for the control case. The two fixtures below differ only in the BSP
 * they hang on this geometry.
 */
function islandGeometry(selfRef: boolean): Omit<BspMapParts, 'subsectors' | 'nodes'> {
  return {
    // Room ring wound clockwise so each wall's right side faces the interior.
    vertexes: [
      { x: 512, y: -512 },
      { x: -512, y: -512 },
      { x: -512, y: 512 },
      { x: 512, y: 512 },
      { x: -64, y: 0 },
      { x: 64, y: 0 },
    ],
    floors: [0, -96],
    sidedefs: [0, 0, 0, 0, 1, selfRef ? 1 : 0],
    linedefs: [wall(0, 1, 0), wall(1, 2, 1), wall(2, 3, 2), wall(3, 0, 3), twoSided(4, 5, 4, 5)],
    segs: [seg(4, 5, 4)],
    half: 512,
  };
}

/** One node splits the room along the island line; the lower leaf carries the line's right-side seg as its only seg. */
function roomWithIsland(selfRef: boolean): DoomMap {
  return bspMap({
    ...islandGeometry(selfRef),
    subsectors: [
      [0, 1],
      [0, 0],
    ],
    // Right of the +x partition is y <= 0 — the side the seg's sidedef faces.
    nodes: [plane(0, 0, 1, 0, leaf(0), leaf(1))],
  });
}

/** The cell four node planes box the island leaf into, which the sparing has to leave whole. */
const ISLAND_CELL_AREA = 256 * 128;

/**
 * The same island line, but with the leaf carrying its seg boxed north of it by
 * four node planes: the seg's sidedef faces south, so the leaf is filed on the
 * wrong side of its own line — ksutra.wad MAP05's subsector 2832.
 */
function boxedIsland(selfRef: boolean): DoomMap {
  return bspMap({
    ...islandGeometry(selfRef),
    // Only leaf 0 holds a seg; the four the planes below split off are empty.
    subsectors: [
      [0, 1],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    // Read root-first: x >= -128, then x <= 128, then y >= 0, then y <= 128.
    nodes: [
      plane(0, 128, 1, 0, leaf(0), leaf(1)),
      plane(0, 0, -1, 0, 0, leaf(2)),
      plane(128, 0, 0, -1, 1, leaf(3)),
      plane(-128, 0, 0, 1, 2, leaf(4)),
    ],
  });
}

describe('Rendering · self-referencing sectors', () => {
  test('a leaf bounded only by self-referencing lines draws as the sector enclosing it', () => {
    const map = roomWithIsland(true);
    const polys = buildSubSectorPolys(map);
    assert.equal(sectorOfSubSector(map, 0), 1, 'the BSP still resolves the leaf to the hidden sector');
    assert.equal(polys[0].sector, 0, 'but it is drawn as the room around it');
  });

  test('an ordinary two-sided border keeps its own sector', () => {
    const polys = buildSubSectorPolys(roomWithIsland(false));
    assert.equal(polys[0].sector, 1);
  });

  test('gameplay keeps the hidden sector even where the seg is filed on the wrong side', () => {
    const map = boxedIsland(true);
    const polys = buildSubSectorPolys(map);
    assert.equal(polygonArea(polys[0].points), ISLAND_CELL_AREA, 'the wrong-side sparing ran, leaving the cell whole');
    assert.equal(polys[0].sector, 0, 'so the leaf draws as the room around it');
    assert.equal(polys[0].physicalSector, sectorOfSubSector(map, 0), 'but gameplay still stands in the hidden sector');
  });

  test('the same misfiling on an ordinary border does move gameplay', () => {
    const polys = buildSubSectorPolys(boxedIsland(false));
    assert.equal(polygonArea(polys[0].points), ISLAND_CELL_AREA);
    assert.equal(polys[0].physicalSector, 0, 'a leaf really filed under the wrong sector is repaired for gameplay too');
  });
});
