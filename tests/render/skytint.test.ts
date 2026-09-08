import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { skyTintOf, STRENGTH } from '../../src/render/skytint.ts';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { SKY_FLAT } from '../../src/wad/map.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';
import type { Bitmap } from '../../src/wad/graphics.ts';
import type * as THREE from 'three';

/**
 * What a sky lends the ground under it. The tint only ever shifts colour — a level's outdoor half
 * must not come out brighter or darker than its indoor one — and no sky may wash the level in its
 * own. See docs/render-lighting.md § Outdoor sky tint.
 */

const LUMA = [0.2126, 0.7152, 0.0722];

/** A one-pixel sky of this colour, which is all `skyTintOf` reads. */
function sky(r: number, g: number, b: number): Bitmap {
  return { width: 1, height: 1, data: new Uint8Array([r, g, b, 255]) };
}

function luminance(tint: readonly number[]): number {
  return LUMA[0] * tint[0] + LUMA[1] * tint[1] + LUMA[2] * tint[2];
}

describe('Rendering · the outdoor sky tint', () => {
  test('a warm sky pulls warm, a cold one cold', () => {
    const dusk = skyTintOf(sky(160, 90, 40));
    assert.ok(dusk[0] > 1 && dusk[2] < 1, 'a red-orange sky lends red and takes blue');
    const night = skyTintOf(sky(40, 90, 160));
    assert.ok(night[2] > 1 && night[0] < 1);
  });

  test('the tint shifts colour without brightening', () => {
    for (const bitmap of [sky(160, 90, 40), sky(40, 90, 160), sky(20, 20, 20), sky(200, 200, 210)]) {
      const tint = skyTintOf(bitmap);
      assert.ok(Math.abs(luminance(tint) - 1) < 0.08, `${tint.join(',')} moves overall brightness`);
    }
  });

  test('a colourless sky still reads as outdoors', () => {
    // DOOM's own SKY1 averages to flat grey, and "no tint at all" is not an outdoor cue.
    const tint = skyTintOf(sky(143, 143, 142));
    assert.ok(tint[2] - tint[0] > 0.1, `grey sky lent nothing: ${tint.join(', ')}`);
  });

  test('a sky with a colour of its own overrides the colourless default', () => {
    const own = skyTintOf(sky(160, 90, 40));
    assert.ok(own[0] > own[2], 'the sky, not the default, decides');
  });

  test('no sky can wash the level in its own colour', () => {
    // DOOM II's SKY3 is the case: 2.6 times as much red as green over the lump.
    for (const c of skyTintOf(sky(255, 0, 0))) {
      assert.ok(c >= 0.6 && c <= 1.4, `${c} is past any sane clamp`);
    }
  });

  test('a level with no sky texture is left alone', () => {
    assert.deepEqual(skyTintOf(null), [1, 1, 1]);
    assert.deepEqual(skyTintOf({ width: 1, height: 1, data: new Uint8Array([9, 9, 9, 0]) }), [1, 1, 1]);
    assert.deepEqual(skyTintOf(sky(0, 0, 0)), [1, 1, 1]);
  });

  test('the strength dial scales the whole shift', () => {
    // The test sizes itself from the dial rather than mirroring it, so a retune stays green.
    const tint = skyTintOf(sky(160, 90, 40));
    const shift = Math.max(...tint.map((c) => Math.abs(c - 1)));
    assert.ok(shift <= STRENGTH + 1e-6, 'no channel travels further than the dial allows');
    assert.ok(shift > STRENGTH / 4, 'and a saturated sky uses most of it');
  });
});

describe('Rendering · what the sky tint reaches', () => {
  /**
   * Two open cells, only the left one roofed with sky: everything drawn facing it is marked, and
   * nothing facing its neighbour is — the marking is what keeps the tint off indoor geometry.
   */
  function level() {
    const grid = gridMap(['..'], { cell: 256 });
    for (const side of grid.map.sidedefs) {
      side.upper = 'UPPER';
      side.lower = 'LOWER';
      side.middle = 'MIDDLE';
    }
    grid.map.sectors[grid.index(0, 0)].ceilTex = SKY_FLAT;
    // A step, so the shared line draws a tier on each side rather than nothing at all.
    grid.map.sectors[grid.index(1, 0)].floorHeight = 64;
    const built = buildMapMesh(grid.map, BANK as never);
    return { grid, built };
  }

  /**
   * Every `aSkyLit` value the given vertex range carries. A batch with nothing under sky carries no
   * attribute at all, which the shader reads back as 0.
   */
  function marks(mesh: THREE.Mesh | undefined, start: number, count: number): number[] {
    const attr = mesh!.geometry.getAttribute('aSkyLit');
    return Array.from({ length: count }, (_, i) => (attr ? attr.getX(start + i) : 0));
  }

  test('a floor under sky is marked and its neighbour is not', () => {
    const { grid, built } = level();
    for (const fan of built.flatSurfaces) {
      const sky = grid.map.sectors[fan.sector].ceilTex === SKY_FLAT;
      const drawn = marks(built.flatMeshes.get(fan.key), fan.vertexStart, fan.vertexCount);
      assert.deepEqual(new Set(drawn), new Set([sky ? 1 : 0]), `sector ${fan.sector} marked wrong`);
    }
  });

  test('a wall carries the marking of the room it faces into, not of the one behind it', () => {
    const { grid, built } = level();
    const seen = new Set<string>();
    for (const quad of built.occluders) {
      const sky = grid.map.sectors[quad.sector].ceilTex === SKY_FLAT;
      const drawn = marks(built.wallMeshes.get(quad.key), quad.vertexStart, quad.vertexCount);
      assert.deepEqual(new Set(drawn), new Set([sky ? 1 : 0]), `line ${quad.line} marked wrong`);
      seen.add(sky ? 'outdoor' : 'indoor');
    }
    assert.deepEqual([...seen].sort(), ['indoor', 'outdoor'], 'the fixture must draw both');
  });
});
