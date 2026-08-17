import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type DoomMap } from '../../src/wad/map.ts';
import { buildSubSectorPolys, sectorOfSubSector } from '../../src/render/bsp.ts';
import { bspMap, leaf, plane, seg, twoSided, wall } from '../fixtures/bspmap.ts';

/**
 * A leaf bounded only by self-referencing lines is drawn as the sector
 * enclosing it, while the BSP sector stays the hidden one for gameplay.
 * See docs/render.md § Self-referencing sectors.
 */

/**
 * A 1024-square room (sector 0) with one line lying across its middle whose
 * two sidedefs both point at a hidden sector 1 — the self-referencing trick,
 * the shape of BOOMEDIT MAP01's line 171 inside sector 30. One node splits the
 * room along that line; the lower leaf carries the line's right-side seg as
 * its only seg. `selfRef` false wires the line as an ordinary two-sided border
 * (right side sector 1, left side sector 0) for the control case.
 */
function roomWithIsland(selfRef: boolean): DoomMap {
  return bspMap({
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
    subsectors: [
      [0, 1],
      [0, 0],
    ],
    // Right of the +x partition is y <= 0 — the side the seg's sidedef faces.
    nodes: [plane(0, 0, 1, 0, leaf(0), leaf(1))],
    half: 512,
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
});
