import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type DoomMap, type Vertex } from '../../src/wad/map.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { pointInConvexPolygon } from '../../src/util/geom.ts';
import { bspMap, leaf, plane, seg, wall } from '../fixtures/bspmap.ts';
import { polygonArea } from '../fixtures/geometry.ts';

/**
 * The two rules that decide how hard a subsector's own segs cut its cell:
 * `segClipTolerance` — a seg only bounds the cell as tightly as its own length
 * pins its angle — and `wallBoundsCell`, which spares the cut where the wall
 * ends inside the cell. See docs/render-bsp.md § Cracks between subsectors.
 */

/**
 * Two cells split by one partition from `(0, 0)` along `dir`, each holding one
 * subsector of the same sector. The right cell carries `wall` as its only (one-sided)
 * seg — running the wall's whole length, or `segEdge` where given, on its `direction`
 * side; the left has no segs, so its cell survives whole and the pair has to tile the
 * padded map quad between them. Everything else is the minimum `buildSubSectorPolys`
 * reads.
 */
function twoCellMap(dir: Vertex, edge: [Vertex, Vertex], half: number, segEdge?: [Vertex, Vertex], direction = 0): DoomMap {
  return bspMap({
    vertexes: [...edge, ...(segEdge ?? [])],
    sidedefs: [0],
    linedefs: [wall(0, 1)],
    segs: [segEdge ? seg(2, 3, 0, direction) : seg(0, 1, 0)],
    subsectors: [
      [0, 0],
      [0, 1],
    ],
    nodes: [plane(0, 0, dir.x, dir.y, leaf(1), leaf(0))],
    half,
  });
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

  test('a wall the cell is not already cut along clips exactly', () => {
    // DOOM1 E1M6's closet at (3448, -1536), reduced: the last partition runs along
    // one wall and nothing bounds the cell on the other three, so the reach the
    // slack scales on is the whole map. Slack there is not a rounding error between
    // a partition and its linedef — it is floor standing in the void, which this
    // camera sees over a 72-unit wall — and even a flat 4 units of it shows, as a
    // step where such a leaf meets a partition-cut one along the same wall.
    const half = 512;
    const polys = buildSubSectorPolys(
      bspMap({
        vertexes: [{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 64, y: 128 }, { x: 0, y: 128 }],
        sidedefs: [0],
        // Wound so the box's inside is on the right of every wall, the side a clip keeps.
        linedefs: [wall(0, 3), wall(3, 2), wall(2, 1), wall(1, 0)],
        segs: [seg(0, 3, 0), seg(3, 2, 1), seg(2, 1, 2), seg(1, 0, 3)],
        subsectors: [
          [0, 4],
          [0, 0],
        ],
        nodes: [plane(0, 0, 0, 1, leaf(0), leaf(1))],
        half,
      }),
    );

    for (let i = 0; i < polys[0].points.length; i += 2) {
      const x = polys[0].points[i];
      const y = polys[0].points[i + 1];
      assert.ok(x >= 0 && x <= 64 && y >= 0 && y <= 128, `floor stands at (${x}, ${y}), past the box`);
    }
    assert.equal(polygonArea(polys[0].points), 64 * 128, 'the floor is the box, and all of it');
  });

  test('a split seg clips along its linedef, not its rounded endpoints', () => {
    // A wall of slope 3, and on it a seg the node builder split at y = 64 and y = 128 —
    // split vertexes rounded to the integer grid, and rounded the way that tilts the
    // seg's own line toward the floor. Nothing else bounds the leaf along the wall, so
    // the clip is exact; carried down the cell, the seg's own line would run 18 units
    // into the floor by the bottom of the map. Once with the wall drawn south to north
    // and the seg on its front, once drawn the other way with the seg on its back: the
    // floor stays east either way, which only `Seg.direction` can say.
    const half = 256;
    const a = { x: 0, y: 0 };
    const b = { x: 64, y: 192 };
    const sa = { x: 22, y: 64 };
    const sb = { x: 42, y: 128 };
    for (const [edge, segEdge, direction] of [
      [[a, b], [sa, sb], 0],
      [[b, a], [sb, sa], 1],
    ] as [[Vertex, Vertex], [Vertex, Vertex], number][]) {
      const polys = buildSubSectorPolys(twoCellMap({ x: 1, y: 0 }, edge, half, segEdge, direction));

      // The wall passes (-253.3, -760); the floor is on its east.
      assert.ok(pointInConvexPolygon(-240, -760, polys[1].points), `floor 13 units inside the wall is drawn (direction ${direction})`);
      assert.ok(!pointInConvexPolygon(-260, -760, polys[1].points), `void 7 units past the wall is not (direction ${direction})`);
    }
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

/**
 * A 1024-square room with a 64-square block standing in the middle of it, and one
 * subsector whose only seg is the block's east wall — the shape of BOOMEDIT MAP01's
 * leaf 206, where a node builder left a wall stub inside a leaf that has the same
 * sector's floor on both sides of it. `box` is the cell four node planes leave that
 * leaf. Everything is one-sided: the room's walls face in, the block's face out.
 */
function blockInRoom(box: number): DoomMap {
  return bspMap({
    vertexes: [
      { x: -512, y: -512 },
      { x: 512, y: -512 },
      { x: 512, y: 512 },
      { x: -512, y: 512 },
      { x: 0, y: 0 },
      { x: 64, y: 0 },
      { x: 64, y: 64 },
      { x: 0, y: 64 },
    ],
    sidedefs: [0],
    // The room's four walls face in, the block's four face out; all of one sector.
    linedefs: [wall(0, 3), wall(3, 2), wall(2, 1), wall(1, 0), wall(4, 5), wall(5, 6), wall(6, 7), wall(7, 4)],
    segs: [seg(5, 6, 5)],
    subsectors: [
      [0, 1],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    nodes: [
      plane(0, box, 1, 0, leaf(0), leaf(1)), // y <= box
      plane(0, -box, -1, 0, 0, leaf(2)), //     y >= -box
      plane(box, 0, 0, -1, 1, leaf(3)), //      x <= box
      plane(-box, 0, 0, 1, 2, leaf(4)), //      x >= -box
    ],
    half: 512,
  });
}

describe('Rendering · walls that stop inside their cell', () => {
  test('a leaf keeps the floor past the end of a wall stub', () => {
    // The block's east wall is 64 units long and the leaf's cell is 512 across, so
    // clipping by the wall's infinite line would take the whole western half of the
    // cell — floor the player walks on, south and north of a block they can walk
    // round. Vanilla never notices: a one-sided wall masks the floor behind it only
    // over the columns it occupies.
    const polys = buildSubSectorPolys(blockInRoom(256));
    assert.equal(polygonArea(polys[0].points), 512 * 512, 'the cell survives whole');
    assert.ok(pointInConvexPolygon(0, -128, polys[0].points), 'including the floor south of the block');
  });

  test('a cell reaching past its own sector does not get the cut spared', () => {
    // Same room, same wall, a cell four times as wide — wider than the sector it
    // belongs to. Sparing a cut spares the *whole* overhang, so it is only ever
    // spared where the overhang could be this sector's floor at all; without that,
    // one wall stub hands a small sector a floor the size of the map.
    const polys = buildSubSectorPolys(blockInRoom(1024));
    const cell = polygonArea(polys[0].points);
    assert.ok(cell > 0, 'the cell is not clipped away entirely');
    assert.ok(cell < 2048 * 2048 * 0.6, `expected the wall to cut the cell down, got ${cell}`);
  });
});
