import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh, FLAT_GRID_LEN, WALL_CHUNK_LEN } from '../../src/render/mapmesh.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { Transfers } from '../../src/game/specials/transfers.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';
import { polygonArea } from '../fixtures/geometry.ts';

/**
 * A flat is cut up on a world-aligned grid rather than fanned and diced per triangle, so the
 * vertex count follows a leaf's *area* instead of its perimeter. What that must not cost is
 * coverage: the cells have to tile the leaf exactly, or a floor grows a hole.
 * See docs/render.md § Flats are diced on a world grid.
 */

/** Twice a ring's *signed* area — `polygonArea`'s shoelace with the sign kept, for the winding check. */
function signedArea2(points: ArrayLike<number>): number {
  const n = points.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return sum;
}

/** A room `cell` units square, and the one diced floor fan it draws. */
function room(cell: number) {
  const grid = gridMap(['###', '#.#', '###'], { cell });
  const built = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
  const polys = buildSubSectorPolys(grid.map);
  const fans = built.flatSurfaces.filter((f) => !f.isCeiling);
  assert.ok(fans.length > 0, 'the fixture drew no floor');
  return { grid, built, polys, fans };
}

/** Every diced triangle of a fan, as [ax, ay, bx, by, cx, cy] — the vertices come in triples. */
function triangles(xy: Float32Array): number[][] {
  const out: number[][] = [];
  for (let v = 0; v + 2 < xy.length / 2; v += 3) {
    out.push([xy[v * 2], xy[v * 2 + 1], xy[(v + 1) * 2], xy[(v + 1) * 2 + 1], xy[(v + 2) * 2], xy[(v + 2) * 2 + 1]]);
  }
  return out;
}

/** Whether a ring lies inside a single grid cell, in which case no clip runs at all. */
function inOneCell(ring: ArrayLike<number>): boolean {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length / 2; i++) {
    minX = Math.min(minX, ring[i * 2]);
    maxX = Math.max(maxX, ring[i * 2]);
    minY = Math.min(minY, ring[i * 2 + 1]);
    maxY = Math.max(maxY, ring[i * 2 + 1]);
  }
  return (
    Math.floor(minX / FLAT_GRID_LEN) === Math.floor(maxX / FLAT_GRID_LEN) &&
    Math.floor(minY / FLAT_GRID_LEN) === Math.floor(maxY / FLAT_GRID_LEN)
  );
}

describe('render · flats are diced on a world grid', () => {
  test('the cells tile the leaf exactly: no overlap, and no hole', () => {
    // The whole point of the dicing is invisible if it leaks — a missing cell is a gap in the
    // floor with the void showing through, and an overlapping one z-fights.
    const { fans, polys } = room(WALL_CHUNK_LEN * 5);
    for (const fan of fans) {
      const want = polygonArea(polys[fan.subsector].points);
      let got = 0;
      for (const t of triangles(fan.vertexXY)) got += polygonArea(t);
      assert.ok(
        Math.abs(got - want) < Math.max(1, want * 1e-6),
        `diced area ${got} against the leaf's own ${want}`,
      );
    }
  });

  test('every diced vertex sits on the leaf, none outside it', () => {
    const { fans, polys } = room(WALL_CHUNK_LEN * 5);
    for (const fan of fans) {
      const ring = polys[fan.subsector].points;
      const n = ring.length / 2;
      for (let v = 0; v < fan.vertexXY.length / 2; v++) {
        const x = fan.vertexXY[v * 2];
        const y = fan.vertexXY[v * 2 + 1];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          // The leaf is convex and counter-clockwise (`bsp.ts`), so every edge must keep the
          // point on its left. A unit of slack: the clip lands vertices on the edges themselves.
          const cross =
            (ring[j * 2] - ring[i * 2]) * (y - ring[i * 2 + 1]) -
            (ring[j * 2 + 1] - ring[i * 2 + 1]) * (x - ring[i * 2]);
          assert.ok(cross > -1, `vertex ${v} of leaf ${fan.subsector} fell outside the polygon`);
        }
      }
    }
  });

  test('no diced edge outruns the chunk length the fade is sized against', () => {
    // `FLAT_GRID_LEN` is `WALL_CHUNK_LEN / sqrt(2)` for exactly this: a square cell split by its
    // diagonal leaves that diagonal as the longest edge. Widen the grid and the fade coarsens.
    const { fans } = room(WALL_CHUNK_LEN * 5);
    for (const fan of fans) {
      for (const t of triangles(fan.vertexXY)) {
        for (const [ax, ay, bx, by] of [
          [t[0], t[1], t[2], t[3]],
          [t[2], t[3], t[4], t[5]],
          [t[4], t[5], t[0], t[1]],
        ]) {
          // `vertexXY` is single-precision, so a cell diagonal lands a fraction either side of the
          // bound it was derived from — the claim is the bound, not the last bit of the float.
          assert.ok(
            Math.hypot(bx - ax, by - ay) <= WALL_CHUNK_LEN * (1 + 1e-5),
            `a diced edge ran ${Math.hypot(bx - ax, by - ay)} units`,
          );
        }
      }
    }
  });

  test('a leaf inside a single cell is left whole', () => {
    // The cheap case, and the one most of a small map is made of: no clip runs at all, and the
    // fan costs exactly what an undiced polygon costs. A leaf *smaller* than a cell is not
    // enough — the grid is world-aligned, so a small leaf can still straddle one of its lines.
    const { fans, polys } = room(WALL_CHUNK_LEN / 4);
    let whole = 0;
    for (const fan of fans) {
      const ring = polys[fan.subsector].points;
      if (!inOneCell(ring)) continue;
      whole++;
      assert.equal(fan.vertexCount, (ring.length / 2 - 2) * 3, 'a one-cell leaf grew extra vertices');
    }
    assert.ok(whole > 0, 'the fixture put no leaf inside a single cell');
  });

  test('a floor and a ceiling of the same leaf wind opposite ways', () => {
    // Floors face up, ceilings down, and that is the only difference between the two.
    const grid = gridMap(['###', '#.#', '###'], { cell: WALL_CHUNK_LEN * 3 });
    const built = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map), renderCeilings: true });
    const floor = built.flatSurfaces.find((f) => !f.isCeiling)!;
    const ceiling = built.flatSurfaces.find((f) => f.isCeiling && f.subsector === floor.subsector)!;
    assert.equal(floor.vertexCount, ceiling.vertexCount, 'the two halves of one leaf diced differently');
    const up = signedArea2(triangles(floor.vertexXY)[0]);
    const down = signedArea2(triangles(ceiling.vertexXY)[0]);
    assert.ok(up * down < 0, 'floor and ceiling wound the same way');
  });
});
