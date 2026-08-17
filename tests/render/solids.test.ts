import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { findSolidCaps, pointInPolygon } from '../../src/render/solids.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { FlatFader } from '../../src/render/occlusion.ts';
import { loadMap, NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { Wad, WadFile } from '../../src/wad/wad.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * The lids over a map's solid structures — the rings of one-sided linedefs
 * enclosing no sector, which a camera looking down would otherwise see straight
 * through. See docs/render.md § Solid structures.
 */

const WALL = 'STARTAN2';

/** A map made of `rings` of vertexes, each ring one closed loop of one-sided lines. */
function mapWith(rings: { points: [number, number][]; sector?: number; reversed?: boolean }[], sectors = 1): DoomMap {
  const map: DoomMap = {
    name: 'TEST',
    vertexes: [],
    sectors: Array.from({ length: sectors }, () => ({
      floorHeight: 0,
      ceilHeight: 128,
      floorTex: 'FLOOR0_1',
      ceilTex: 'CEIL1_1',
      light: 160,
      special: 0,
      tag: 0,
    })),
    sidedefs: [],
    linedefs: [],
    segs: [],
    subsectors: [],
    nodes: [],
    things: [],
    reject: undefined,
    nodeFormat: 'vanilla',
    bounds: { minX: -1024, minY: -1024, maxX: 1024, maxY: 1024 },
  } as unknown as DoomMap;

  for (const ring of rings) {
    const base = map.vertexes.length;
    for (const [x, y] of ring.points) map.vertexes.push({ x, y });
    for (let i = 0; i < ring.points.length; i++) {
      const a = base + i;
      const b = base + ((i + 1) % ring.points.length);
      const side = map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: WALL, sector: ring.sector ?? 0 }) - 1;
      // A linedef's front (right) side is the one its sidedef faces; reversing
      // the ring's winding is what flips which side the sector is on.
      const [v1, v2] = ring.reversed ? [b, a] : [a, b];
      map.linedefs.push({ v1, v2, flags: 0, special: 0, tag: 0, right: side, left: NO_SIDE });
    }
  }
  return map;
}

/**
 * A square wound so that every linedef's front side faces *away* from its
 * middle — the sector is outside, which is how a mapper draws a pillar.
 */
const square = (cx: number, cy: number, r: number): [number, number][] => [
  [cx - r, cy - r],
  [cx + r, cy - r],
  [cx + r, cy + r],
  [cx - r, cy + r],
];

describe('render · solid structure lids', () => {
  test('a pillar gets one lid, at the ceiling, in its own wall texture', () => {
    const map = mapWith([{ points: square(0, 0, 64) }]);
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].height, 128, 'the ceiling of the sector it stands in');
    assert.equal(caps[0].texture, WALL);
    assert.equal(caps[0].sector, 0);
    assert.ok(pointInPolygon(caps[0].points, 0, 0), 'and it covers the structure');
  });

  test('the lid takes the lowest ceiling the ring borders', () => {
    const map = mapWith([{ points: square(0, 0, 64) }], 2);
    map.sectors[1].ceilHeight = 72;
    // One of the four walls faces the lower room.
    map.sidedefs[2].sector = 1;
    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].height, 72, 'never above a wall top, or the gap reopens');
    assert.equal(caps[0].sector, 1);
  });

  test('a room’s own outer wall is not a structure', () => {
    // Same square wound the other way: now the sector is *inside* the ring.
    const map = mapWith([{ points: square(0, 0, 64), reversed: true }]);
    assert.deepEqual(findSolidCaps(map, []), []);
  });

  test('a ring enclosing floor is a building, and is left alone', () => {
    const map = mapWith([{ points: square(0, 0, 256) }]);
    // One subsector's worth of room inside the ring — a courtyard or a hall.
    const polys = [{ sector: 0, points: new Float64Array([-64, -64, -64, 64, 64, 64, 64, -64]) }];
    assert.deepEqual(findSolidCaps(map, polys), [], 'roofing this would bury the rooms inside it');
    // The same ring with the floor outside it is still a structure.
    const outside = [{ sector: 0, points: new Float64Array([512, 512, 512, 576, 576, 576, 576, 512]) }];
    assert.equal(findSolidCaps(map, outside).length, 1);
  });

  test('a structure welded to other geometry is lidded from its own void face', () => {
    const map = mapWith([{ points: square(0, 0, 64) }]);
    // A stub line off the (-64, 64) corner: that vertex now joins three one-sided
    // lines, so which one continues the pillar's outline is a real choice. The
    // simple walk gives up here; the void face keeps to the pillar by taking the
    // rightmost turn — the stub is the leftward one, 154° against the corner's 90°.
    const v = map.vertexes.push({ x: 200, y: -64 }) - 1;
    const side = map.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: WALL, sector: 0 }) - 1;
    map.linedefs.push({ v1: 3, v2: v, flags: 0, special: 0, tag: 0, right: side, left: NO_SIDE });

    const caps = findSolidCaps(map, []);
    assert.equal(caps.length, 1, 'the weld no longer costs the structure its lid');
    assert.equal(caps[0].points.length / 2, 4, 'and the lid is the pillar itself, not a walk off down the stub');
    assert.ok(pointInPolygon(caps[0].points, 0, 0));
  });

  test('an open chain of one-sided lines is still left alone', () => {
    // Two lines meeting at a corner and going nowhere: no face to close, so
    // there is nothing to lid and nothing to guess at.
    const map = mapWith([{ points: square(0, 0, 64) }]);
    map.linedefs.length = 2;
    assert.deepEqual(findSolidCaps(map, []), []);
  });

  test('lids reach the geometry as fadeable, fog-aware flat surfaces', () => {
    // A real map: DOOM1 E1M1's pillars, through the whole builder.
    const bytes = readFileSync('public/wads/iwad/DOOM1.WAD');
    const file = new WadFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'DOOM1.WAD');
    const map = loadMap(new Wad([file]), 'E1M1');
    const caps = findSolidCaps(map, buildSubSectorPolys(map));
    assert.ok(caps.length > 0, 'E1M1 has solid structures');
    // A ring is traced from an arbitrary direction, so every footprint must
    // come out counter-clockwise: wound the other way the lid faces down, is
    // culled, and the hole it exists to close stays open.
    for (const cap of caps) {
      let area = 0;
      const n = cap.points.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += cap.points[i * 2] * cap.points[j * 2 + 1] - cap.points[j * 2] * cap.points[i * 2 + 1];
      }
      assert.ok(area > 0, 'lid footprint faces up');
    }
    // None of them may sit over a thing: that would mean a room got roofed.
    for (const cap of caps) {
      for (const thing of map.things) {
        assert.ok(!pointInPolygon(cap.points, thing.x, thing.y), `lid over thing ${thing.type}`);
      }
    }

    const built = buildMapMesh(map, BANK, {});
    const lids = built.flatSurfaces.filter((f) => f.key.startsWith('wall:'));
    assert.ok(lids.length >= caps.length, 'every lid is emitted, one surface per triangle');
    for (const lid of lids) {
      assert.equal(lid.points.length, 6, 'triangles only — FlatFader’s footprint test is convex-only');
      assert.ok(built.flatMeshes.has(lid.key), 'and its mesh is reachable as a flat');
    }

    // Fog of war must be able to hide one: it is written through the same
    // vertex alpha every other flat uses.
    const fader = new FlatFader(built.flatSurfaces, built.flatMeshes);
    const lid = lids[0];
    const attr = built.flatMeshes.get(lid.key)!.geometry.getAttribute('color') as THREE.BufferAttribute;
    fader.commit(() => 0);
    assert.equal(attr.getW(lid.vertexStart), 0, 'unseen: hidden');
    fader.commit(() => 1);
    assert.equal(attr.getW(lid.vertexStart), 1, 'seen: drawn');
  });
});
