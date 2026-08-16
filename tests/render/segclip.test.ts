import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_SIDE, SUBSECTOR_BIT, type DoomMap, type Vertex } from '../../src/wad/map.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { polygonArea } from '../fixtures/geometry.ts';

/**
 * `segClipTolerance`: a seg only bounds the cell it is clipping as tightly as its own
 * length pins its angle. See docs/render.md § Cracks between subsectors.
 */

/**
 * Two cells split by one partition from `(0, 0)` along `dir`, each holding one
 * subsector of the same sector. The right cell carries `wall` as its only (one-sided)
 * seg; the left has no segs, so its cell survives whole and the pair has to tile the
 * padded map quad between them. Everything else is the minimum `buildSubSectorPolys`
 * reads.
 */
function twoCellMap(dir: Vertex, wall: [Vertex, Vertex], half: number): DoomMap {
  return {
    name: 'TEST',
    nodeFormat: 'vanilla',
    vertexes: [wall[0], wall[1]],
    sectors: [{ floorHeight: 0, ceilHeight: 128, floorTex: 'FLAT1', ceilTex: 'FLAT1', light: 160, special: 0, tag: 0 }],
    sidedefs: [{ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: 'WALL', sector: 0 }],
    linedefs: [{ v1: 0, v2: 1, flags: 0, special: 0, tag: 0, right: 0, left: NO_SIDE }],
    segs: [{ v1: 0, v2: 1, angle: 0, linedef: 0, direction: 0, offset: 0 }],
    subsectors: [
      { count: 0, first: 0 },
      { count: 1, first: 0 },
    ],
    nodes: [{ x: 0, y: 0, dx: dir.x, dy: dir.y, rightChild: (SUBSECTOR_BIT | 1) >>> 0, leftChild: (SUBSECTOR_BIT | 0) >>> 0 }],
    things: [],
    reject: undefined,
    bounds: { minX: -half, minY: -half, maxX: half, maxY: half },
  };
}

/** `buildSubSectorPolys` starts from the map bounds padded by 512 on every side. */
const quadArea = (half: number) => (2 * (half + 512)) ** 2;

describe('Rendering · seg clip slack', () => {
  test('a short seg a degree off its partition does not shave a wedge off its own cell', () => {
    // `oku2_mancubus_cliff.wad` MAP01's crack, reduced: partition `d(64, 320)` — slope
    // 5 — against linedef 101, a 6-unit seg running `d(1, 6)`. One unit of endpoint
    // rounding on a seg that short is a degree of angle, and the line it implies is
    // then carried most of a 1500-unit cell. Laid on the partition's own slope the
    // same wall cuts nothing, whatever the tolerance; it is the extrapolation that
    // opened the crack.
    const half = 256;
    const polys = buildSubSectorPolys(twoCellMap({ x: 64, y: 320 }, [{ x: 0, y: 0 }, { x: 1, y: 6 }], half));

    // The two cells still tile the quad exactly, as the node clip alone would: whatever
    // the seg's line says about the far end of the cell, none of it is floor lost.
    const covered = polygonArea(polys[0].points) + polygonArea(polys[1].points);
    assert.equal(covered, quadArea(half));
  });

  test('a long seg still clips its cell, so floor does not run past a wall', () => {
    // A 1448-unit wall diagonally across a cell it spans end to end: reach/length is
    // about 1, so this clips with the plain 4-unit slack and really does cut.
    const half = 512;
    const polys = buildSubSectorPolys(twoCellMap({ x: 0, y: 1 }, [{ x: -half, y: -half }, { x: half, y: half }], half));
    const cell = polygonArea(polys[1].points);

    assert.ok(cell > 0, 'the cell is not clipped away entirely');
    assert.ok(cell < (quadArea(half) / 2) * 0.8, `expected the wall to cut the cell down, got ${cell}`);
  });
});
