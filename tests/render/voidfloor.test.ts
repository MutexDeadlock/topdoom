import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { voidFloorBounds, voidFloorHeight } from '../../src/render/voidfloor.ts';
import { VIEW_DISTANCE } from '../../src/constants.ts';
import type { DoomMap, Sector, Vertex } from '../../src/wad/map.ts';

/**
 * The plane has one job the rest of the renderer depends on: never to sit at or above a real floor,
 * and always to reach past the fog. See docs/render.md § The void floor.
 */

/** `bounds` mirrors `wad/map.ts`'s `boundsOf`, ±Infinity on an empty vertex list included. */
function mapWith(floorHeights: number[], vertexes: Vertex[]): DoomMap {
  const sectors = floorHeights.map((floorHeight) => ({ floorHeight }) as Sector);
  const bounds = {
    minX: Math.min(...vertexes.map((v) => v.x)),
    minY: Math.min(...vertexes.map((v) => v.y)),
    maxX: Math.max(...vertexes.map((v) => v.x)),
    maxY: Math.max(...vertexes.map((v) => v.y)),
  };
  return { sectors, vertexes, bounds } as DoomMap;
}

describe('Rendering · the void floor', () => {
  test('a floor lowered by a generalized 32 still clears the plane', () => {
    const map = mapWith([0, -64, 128], []);
    assert.ok(voidFloorHeight(map) < -64 - 32);
  });

  test('follows the lowest floor rather than sitting at a fixed height', () => {
    const shallow = voidFloorHeight(mapWith([0], []));
    const deep = voidFloorHeight(mapWith([-1024], []));
    assert.equal(shallow - deep, 1024);
  });

  test('a map with no sectors still answers a finite height', () => {
    assert.ok(Number.isFinite(voidFloorHeight(mapWith([], []))));
  });

  test('reaches VIEW_DISTANCE past the map on every side', () => {
    const map = mapWith([0], [
      { x: -100, y: 200 },
      { x: 500, y: -300 },
      { x: 40, y: 40 },
    ] as Vertex[]);
    assert.deepEqual(voidFloorBounds(map), [
      -100 - VIEW_DISTANCE,
      -300 - VIEW_DISTANCE,
      500 + VIEW_DISTANCE,
      200 + VIEW_DISTANCE,
    ]);
  });

  test("a map with no vertexes answers a finite footprint, not map.bounds' infinities", () => {
    const [minX, minY, maxX, maxY] = voidFloorBounds(mapWith([0], []));
    assert.ok(Number.isFinite(minX) && Number.isFinite(minY));
    assert.ok(maxX > minX && maxY > minY);
  });
});
