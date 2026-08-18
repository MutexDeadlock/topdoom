import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import { LF, NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * Where a two-sided line's masked middle texture hangs: one copy off the pegged
 * anchor, y-offset included, cut by the tiers the side actually draws — never
 * stretched to fill the opening. See docs/render.md § Mesh building.
 */

const GRATE = 'MIDGRATE';
/** Shorter than the fixture's 128-unit opening, so an offset has room to show. */
const TEX_H = 48;

const BANK = {
  size: () => ({ w: 64, h: TEX_H }),
  get: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialBank;

/**
 * EPIC.WAD MAP02's gate in miniature: a cell exactly as tall as the texture,
 * facing a door shut at ceiling 1 — where `g` is that door.
 */
const GATE = ['og'];

/** Two open cells (floor 0, ceiling 128) with a grate hung in the opening between them. */
function grate(setup: (map: DoomMap, line: number) => void, grid: string[] = ['..']) {
  const heights = { o: { floor: 0, ceil: TEX_H }, g: { floor: 0, ceil: 1 } };
  const map = gridMap(grid, { heights }).map;
  const line = map.linedefs.findIndex((l) => l.left !== NO_SIDE);
  map.sidedefs[map.linedefs[line].right].middle = GRATE;
  setup(map, line);
  const built = buildMapMesh(map, BANK, {});
  const quad = built.occluders.find((o) => o.line === line && o.key === 'wall:' + GRATE);
  if (!quad) return { quad: undefined, band: undefined, v: undefined };
  const uv = built.wallMeshes.get(quad.key)!.geometry.getAttribute('uv');
  // A (top-left) is the first vertex addWall pushes, C (bottom-right) the third.
  return {
    quad,
    band: [quad.botH, quad.topH] as const,
    v: [uv.getY(quad.vertexStart), uv.getY(quad.vertexStart + 2)] as const,
  };
}

const round = (v: readonly [number, number]) => [Number(v[0].toFixed(4)), Number(v[1].toFixed(4))];

describe('render · midtexture placement', () => {
  test('top-pegged: the texture hangs from the ceiling, the opening below it stays empty', () => {
    const { band, v } = grate(() => {});
    assert.deepEqual(band, [128 - TEX_H, 128]);
    assert.deepEqual(round(v!), [0, 1]);
  });

  test('lower-unpegged: the texture stands on the floor', () => {
    const { band, v } = grate((map, line) => {
      map.linedefs[line].flags |= LF.LOWER_UNPEGGED;
    });
    assert.deepEqual(band, [0, TEX_H]);
    assert.deepEqual(round(v!), [0, 1]);
  });

  test('the y-offset moves the quad, not just its UVs', () => {
    // BOOMEDIT MAP01 line 726's ICESIGN: a sign hung well below the ceiling.
    const { band, v } = grate((map, line) => {
      map.sidedefs[map.linedefs[line].right].yOffset = -40;
    });
    assert.deepEqual(band, [40, 88], 'one texture height, 40 units down from the ceiling');
    assert.deepEqual(round(v!), [0, 1], 'the whole texture, unwrapped');
  });

  test('an offset that runs the texture past the floor clips it there', () => {
    const { band, v } = grate((map, line) => {
      map.sidedefs[map.linedefs[line].right].yOffset = -100;
    });
    assert.deepEqual(band, [0, 28]);
    assert.deepEqual(round(v!), round([0, 28 / TEX_H]), 'the bottom rows are cut, not rescaled');
  });

  test('an offset that pushes the texture out of the opening draws nothing', () => {
    const { quad } = grate((map, line) => {
      map.sidedefs[map.linedefs[line].right].yOffset = -128;
    });
    assert.equal(quad, undefined, 'vanilla never tiles a masked midtexture, so nothing is left to draw');
  });

  // EPIC.WAD MAP02's gate (sector 14, line 66): the bars hang off the shut
  // door's underside, above an opening 1 unit tall, and only reach the doorway
  // because the untextured upper step draws nothing to cut them.
  // docs/render.md § What cuts a midtexture.
  test('an untextured upper step does not cut the midtexture — the barred gate', () => {
    const { band, v } = grate((map, line) => {
      map.sidedefs[map.linedefs[line].right].yOffset = TEX_H;
    }, GATE);
    assert.deepEqual(band, [1, TEX_H], 'hung off the shut door, cut by this sector rather than by the 1-unit opening');
    assert.deepEqual(round(v!), round([1 / TEX_H, 1]), 'only the row that overshoots the ceiling is cut');
  });

  test('a textured upper step cuts it back to the opening', () => {
    const { quad } = grate((map, line) => {
      const side = map.sidedefs[map.linedefs[line].right];
      side.yOffset = TEX_H;
      side.upper = 'UPPER';
    }, GATE);
    assert.equal(quad, undefined, 'the band now sits wholly above the opening the upper wall leaves');
  });
});
