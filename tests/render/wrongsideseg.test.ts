import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type DoomMap } from '../../src/wad/map.ts';
import { buildSubSectorPolys, sectorOfSubSector } from '../../src/render/bsp.ts';
import { World } from '../../src/game/world.ts';
import { bspMap, leaf, plane, seg, twoSided, wall } from '../fixtures/bspmap.ts';
import { polygonArea } from '../fixtures/geometry.ts';

/**
 * A seg the node builder filed into the child on the wrong side of its own line
 * would clip its leaf's whole cell down to the tolerance band, leaving the rest
 * a hole; its clip is spared, and the drawn sector re-resolved, where the cell
 * is real floor. See docs/render.md § Segs on the wrong side of their leaf.
 */

/** The south leaf's whole cell, which the spared clip has to leave standing. */
const SOUTH_CELL_AREA = 512 * 256;

/**
 * A 512-square room split at y = 0: sector 1 north, sector 0 south, the border
 * facing north. One node splits along the border; the south leaf carries the
 * border's *front*-side seg — the shape ksutra.wad MAP04's subsector 902 has,
 * where linedef 75's north-facing seg sits in a leaf south of it. `wrongSide`
 * false files the border's back-side seg there instead, the correct tree.
 */
function splitRoom(wrongSide: boolean): DoomMap {
  return bspMap({
    vertexes: [
      { x: 256, y: -256 },
      { x: -256, y: -256 },
      { x: -256, y: 256 },
      { x: 256, y: 256 },
      { x: 256, y: 0 },
      { x: -256, y: 0 },
    ],
    floors: [0, 32],
    sidedefs: [0, 0, 1, 1, 1, 0, 1, 0],
    // Room ring wound clockwise so each wall's right side faces the interior,
    // the side walls split at y = 0 so every sidedef names one sector.
    linedefs: [
      wall(0, 1, 0),
      wall(1, 5, 1),
      wall(5, 2, 2),
      wall(2, 3, 3),
      wall(3, 4, 4),
      wall(4, 0, 5),
      // The border runs west, so its right side — sidedef 6, sector 1 — faces north.
      twoSided(4, 5, 6, 7),
    ],
    segs: [
      seg(5, 2, 2),
      seg(2, 3, 3),
      seg(3, 4, 4),
      seg(4, 5, 6),
      wrongSide ? seg(4, 5, 6) : seg(5, 4, 6, 1),
      seg(0, 1, 0),
      seg(1, 5, 1),
      seg(4, 0, 5),
    ],
    subsectors: [
      [0, 4],
      [4, 4],
    ],
    // Right of the westward partition is y >= 0 — the north leaf.
    nodes: [plane(256, 0, -1, 0, leaf(0), leaf(1))],
    half: 256,
  });
}

/**
 * A 512-square room (sector 0) beside 512 units of void: the node splits along
 * the east wall's line, and the void leaf east of it carries that wall's
 * front-side seg. The same wrong-side shape as above, but the cell it would
 * spare is void — the reality check has to refuse it.
 */
function roomBesideVoid(): DoomMap {
  return bspMap({
    vertexes: [
      { x: 256, y: -256 },
      { x: -256, y: -256 },
      { x: -256, y: 256 },
      { x: 256, y: 256 },
    ],
    sidedefs: [0, 0, 0, 0],
    linedefs: [wall(0, 1, 0), wall(1, 2, 1), wall(2, 3, 2), wall(3, 0, 3)],
    segs: [seg(0, 1, 0), seg(1, 2, 1), seg(2, 3, 2), seg(3, 0, 3), seg(3, 0, 3)],
    subsectors: [
      [0, 4],
      [4, 1],
    ],
    // Right of the southward partition is x <= 256 — the room.
    nodes: [plane(256, 256, 0, -1, leaf(0), leaf(1))],
    half: 512,
  });
}

describe('Rendering · segs on the wrong side of their leaf', () => {
  test('a wrong-side seg is spared its clip and the leaf drawn as the sector around it', () => {
    const map = splitRoom(true);
    const polys = buildSubSectorPolys(map);
    assert.equal(sectorOfSubSector(map, 1), 1, 'the BSP still resolves the leaf through the misfiled seg');
    assert.equal(polys[1].sector, 0, 'but it is drawn as the sector its cell sits in');
    assert.ok(polygonArea(polys[1].points) > SOUTH_CELL_AREA * 0.99, 'and its cell survives whole instead of a tolerance strip');
  });

  test('gameplay follows the repair, so the floor underfoot is the one drawn', () => {
    const map = splitRoom(true);
    const polys = buildSubSectorPolys(map);
    assert.equal(polys[1].physicalSector, polys[1].sector, 'a misfiled leaf is in the wrong sector for every purpose');
    // Sector 1's floor is 32 and sector 0's is 0; the BSP's own answer would
    // stand the player 32 units above the flat the same cell draws.
    const world = new World(map);
    assert.equal(world.sectorIndexAt(0, -128), 0);
    assert.equal(world.floorAt(0, -128), 0);
  });

  test('a correctly filed back-side seg changes nothing', () => {
    const map = splitRoom(false);
    const polys = buildSubSectorPolys(map);
    assert.equal(polys[1].sector, 0);
    assert.ok(polygonArea(polys[1].points) > SOUTH_CELL_AREA * 0.99);
  });

  test('a wrong-side seg bounding a void cell keeps its clip', () => {
    const map = roomBesideVoid();
    const polys = buildSubSectorPolys(map);
    assert.equal(polys[1].sector, 0, 'the drawn sector stays the seg\'s own');
    assert.equal(polys[1].physicalSector, sectorOfSubSector(map, 1), 'and gameplay keeps the BSP answer with it');
    for (let i = 0; i < polys[1].points.length; i += 2) {
      assert.ok(polys[1].points[i] <= 256 + 32, 'no floor stands out into the void past the clip tolerances');
    }
  });
});
