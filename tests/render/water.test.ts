import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh, litColor, type FlatSurface } from '../../src/render/mapmesh.ts';
import { FlatFader } from '../../src/render/occlusion.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { WATER_SURFACE_ALPHA } from '../../src/constants.ts';
import { gridMap, addControlSector } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * Boom's 242 as geometry: the two fans this engine draws where vanilla picks
 * one of them by eye height, and the alpha that keeps a submerged player
 * visible through the surface. See docs/specials.md § Deep water.
 */

const POOL_FLAT = 'FLAT14';
const WATER_FLAT = 'FWATER1';

/** A one-cell pool with a 242 control sector above its floor. */
function pool({ surfaceHeight = 0, poolLight = 90, ownLight = 200 } = {}) {
  const grid = gridMap(['..']);
  const map = grid.map;
  map.sectors[0].tag = 3;
  map.sectors[0].floorHeight = -64;
  map.sectors[0].floorTex = WATER_FLAT;
  map.sectors[0].light = ownLight;
  const control = addControlSector(
    map,
    { floorHeight: surfaceHeight, ceilHeight: 128, floorTex: POOL_FLAT, light: poolLight },
    242,
    3,
  );
  const built = buildMapMesh(map, BANK, { transfers: transfersOf(map) });
  const fans = built.flatSurfaces.filter((f) => f.sector === 0);
  return { map, control, built, fans };
}

const colorOf = (built: ReturnType<typeof pool>['built'], f: FlatSurface) => {
  const attr = built.flatMeshes.get(f.key)!.geometry.getAttribute('color');
  return attr.getX(f.vertexStart);
};

describe('render · deep water planes', () => {
  test('a water sector draws a pool bottom and a translucent surface over it', () => {
    const { control, built, fans } = pool();
    assert.equal(fans.length, 2, 'two fans, one subsector');

    const bottom = fans.find((f) => f.height === -64)!;
    const surface = fans.find((f) => f.height === 0)!;
    assert.ok(bottom && surface);

    // Underwater view (`R_FakeFlat`): the real floor, wearing the control
    // sector's flat and light.
    assert.equal(bottom.key, 'flat:' + POOL_FLAT);
    assert.equal(bottom.lightSector, control);
    assert.equal(colorOf(built, bottom), Math.fround(litColor(90)));
    assert.equal(bottom.baseAlpha, undefined, 'the bottom is solid');

    // Above-water view: the control sector's height, wearing the sector's own
    // flat and light — and translucent, which vanilla's never is.
    assert.equal(surface.key, 'flat:' + WATER_FLAT);
    assert.equal(surface.lightSector, 0);
    assert.equal(colorOf(built, surface), Math.fround(litColor(200)));
    assert.equal(surface.baseAlpha, WATER_SURFACE_ALPHA);
    assert.equal(surface.isCeiling, false, 'it fades like a floor, not a ceiling');
    assert.equal(surface.subsector, bottom.subsector, 'same subsector, so fog of war covers both');
  });

  test('water too shallow to see into is drawn vanilla-style, as one floor at the surface', () => {
    // BOOMEDIT MAP01 sector 405 is a map unit deep; a bottom fan that close to
    // the surface z-fights it into a shimmer. Below `WATER_MIN_DEPTH` this
    // falls back to `R_FakeFlat`'s plain above-water view.
    const { fans } = pool({ surfaceHeight: -60 }); // floor -64, so 4 units deep
    assert.equal(fans.length, 1, 'one fan, no pool bottom under it');
    assert.equal(fans[0].height, -60, 'drawn at the control sector height, as vanilla does');
    assert.equal(fans[0].key, 'flat:' + WATER_FLAT, 'wearing the sector’s own flat');
    assert.equal(fans[0].baseAlpha, undefined, 'and solid — there is nothing behind it to show');
  });

  test('a control sector at or below the real floor draws no surface', () => {
    // Boom's fake *ceiling* setup. Nothing to draw with ceilings unrendered,
    // and sinking the visible floor into it would be worse than ignoring it.
    const { fans } = pool({ surfaceHeight: -64 });
    assert.equal(fans.length, 1);
    assert.equal(fans[0].height, -64);
    assert.equal(fans[0].baseAlpha, undefined);
  });

  test('the surface alpha multiplies with occlusion fade and fog of war', () => {
    const { built, fans } = pool();
    const surface = fans.find((f) => f.height === 0)!;
    const fader = new FlatFader(built.flatSurfaces, built.flatMeshes);
    const alphaOf = () => built.flatMeshes.get(surface.key)!.geometry.getAttribute('color').getW(surface.vertexStart);

    fader.commit(() => 1);
    assert.equal(alphaOf(), WATER_SURFACE_ALPHA, 'unoccluded and fully revealed: the base alone');

    fader.commit(() => 0.5);
    assert.equal(alphaOf(), WATER_SURFACE_ALPHA * 0.5, 'half-revealed by fog: the product');
  });

  test('a map with no 242 line builds exactly one fan per subsector, as before', () => {
    const { map } = gridMap(['..']);
    const built = buildMapMesh(map, BANK, { transfers: transfersOf(map) });
    assert.equal(built.flatSurfaces.length, 2);
    for (const f of built.flatSurfaces) {
      assert.equal(f.baseAlpha, undefined);
      assert.equal(f.lightSector, f.sector);
    }
  });
});
