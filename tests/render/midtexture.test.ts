import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import type { MaterialBank } from '../../src/render/textures.ts';
import { LF, NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * Where a two-sided line's masked middle texture hangs: one copy off the pegged
 * anchor, y-offset included, clipped to the opening — never stretched to fill
 * it. See docs/render.md § Mesh building.
 */

const GRATE = 'MIDGRATE';
/** Shorter than the fixture's 128-unit opening, so an offset has room to show. */
const TEX_H = 48;

const BANK = {
  size: () => ({ w: 64, h: TEX_H }),
  get: () => new THREE.MeshBasicMaterial(),
} as unknown as MaterialBank;

/** Two open cells (floor 0, ceiling 128) with a grate hung in the opening between them. */
function grate(setup: (map: DoomMap, line: number) => void) {
  const map = gridMap(['..']).map;
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
});
