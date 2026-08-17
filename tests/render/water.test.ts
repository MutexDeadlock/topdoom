import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh, litColor, type FlatSurface } from '../../src/render/mapmesh.ts';
import { FlatFader } from '../../src/render/occlusion.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { WATER_SURFACE_ALPHA } from '../../src/constants.ts';
import { LF, NO_SIDE } from '../../src/wad/map.ts';
import { gridMap, addControlSector } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * Boom's 242 as geometry: the two fans this engine draws where vanilla picks
 * one of them by eye height, the alpha that keeps a submerged player visible
 * through the surface, and the fake ceiling the walls across from one are sized
 * against. See docs/specials.md § Deep water.
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

const FALL = 'SFALL1';

/**
 * BOOMEDIT MAP01's waterfall box in miniature: a room at ceiling 256 looking at
 * a 242 sector whose real ceiling is 192 and whose control sector's is 32, with
 * the fall's texture in both the upper and the middle slot at the map's own
 * −32 y-offset. `viewerIsWater` gives the room a 242 of its own, which is the
 * case vanilla resolves through `R_FakeFlat`'s above-ceiling branch instead.
 */
function fakeCeiling({ viewerIsWater = false } = {}) {
  const map = gridMap(['..']).map;
  const line = map.linedefs.findIndex((l) => l.left !== NO_SIDE);
  const side = map.sidedefs[map.linedefs[line].right];
  const far = map.sidedefs[map.linedefs[line].left].sector;
  map.sectors[side.sector].ceilHeight = 256;
  map.sectors[far].ceilHeight = 192;
  map.sectors[far].tag = 7;
  side.upper = FALL;
  side.middle = FALL;
  side.yOffset = -32;
  addControlSector(map, { floorHeight: 0, ceilHeight: 32 }, 242, 7);
  if (viewerIsWater) {
    map.sectors[side.sector].tag = 8;
    addControlSector(map, { floorHeight: 0, ceilHeight: 256 }, 242, 8);
  }
  const built = buildMapMesh(map, BANK, { transfers: transfersOf(map) });
  const quads = built.occluders.filter((o) => o.line === line && o.frontSide);
  return { map, line, built, quads };
}

const STEP = 'STEP1';
const SIGN = 'MIDGRATE';

/**
 * BOOMEDIT MAP01 sector 110 in miniature: a platform raised `platformFloor`
 * above the room it sits in, tagged to a 242 control sector at the room's own
 * floor so vanilla draws it flush and invisible. The room's side of the shared
 * line carries a lower texture here that the real map leaves unset — the map
 * needs none, which is exactly why an unsubstituted floor shows through as a
 * band of nothing. Both sides carry the map's own midtexture, which hangs off
 * the opening and so reads back whichever floor each side was sized against.
 * `unpegged` is the real map's `0x14`, which hangs that midtexture off the
 * bottom of the opening rather than the top. `neighbourFloor` lifts the room
 * above the fake floor, the case the substitution has to decline.
 */
function invisiblePlatform({ platformFloor = 32, neighbourFloor = 0, unpegged = false } = {}) {
  const map = gridMap(['..']).map;
  const line = map.linedefs.findIndex((l) => l.left !== NO_SIDE);
  const side = map.sidedefs[map.linedefs[line].right];
  const far = map.sidedefs[map.linedefs[line].left];
  const platform = far.sector;
  const room = side.sector;
  if (unpegged) map.linedefs[line].flags |= LF.LOWER_UNPEGGED;
  map.sectors[room].floorHeight = neighbourFloor;
  map.sectors[platform].floorHeight = platformFloor;
  map.sectors[platform].tag = 11;
  side.lower = STEP;
  side.middle = SIGN;
  far.middle = SIGN;
  const control = addControlSector(map, { floorHeight: 0, ceilHeight: 128 }, 242, 11);
  const transfers = transfersOf(map);
  const built = buildMapMesh(map, BANK, { transfers });
  const quads = built.occluders.filter((o) => o.line === line);
  return {
    platform,
    control,
    /** What `markFakeFloors` decided, rather than what the fans made of it. */
    eligible: transfers.fakeFloorSectors(),
    fan: built.flatSurfaces.find((f) => f.sector === platform && !f.isCeiling)!,
    /** The room's side of the shared line — where a step up to the platform would be drawn. */
    quads: quads.filter((o) => o.frontSide),
    /** The platform's own side, which has to agree with it. */
    back: quads.filter((o) => !o.frontSide),
  };
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

  test('a control sector below the real ceiling still reaches the walls across from it', () => {
    // BOOMEDIT MAP01 lines 677-680: sector 111 (real ceiling 192) draws at
    // control sector 112's ceiling of 32, so the SFALL1 fall facing it runs
    // 256..32 as one band. Sized against the real 192 instead, the upper stops
    // short and the midtexture's own y-offset drops it clear of the opening,
    // leaving a 32-unit hole between the two halves of the waterfall.
    const { quads } = fakeCeiling();
    assert.equal(quads.length, 1, 'the upper alone — the opening is too short to hold the midtexture');
    assert.deepEqual([quads[0].botH, quads[0].topH], [32, 256]);
  });

  test('a sector with a 242 of its own keeps the real ceiling it looks out with', () => {
    // Standing inside a 242 sector is `R_FakeFlat`'s above-ceiling branch,
    // which hands the real ceiling straight back — which is what keeps
    // BOOMEDIT MAP01's colormap room (444-452, control ceilings at floor
    // level) from losing every wall it has.
    const { quads } = fakeCeiling({ viewerIsWater: true });
    assert.equal(quads.length, 2, 'the upper, and a midtexture hung in the full opening');
    assert.deepEqual([quads[0].botH, quads[0].topH], [192, 256], 'the neighbour’s real ceiling');
  });

  test('a 242 platform drawn at a control sector below it takes the walls down with it', () => {
    // BOOMEDIT MAP01 sector 110: a 32-unit platform tagged to a control sector
    // at the surrounding room's floor, so vanilla draws it flush and the mapper
    // left lines 673-676 with no lower texture. Drawn at its real height the
    // rim it exposes has nothing to cover it, and the room looks into a black
    // band under the platform's edge.
    const { fan, quads, back, eligible, platform, control } = invisiblePlatform();
    assert.deepEqual(eligible, [{ sector: platform, control }], 'the rule accepts it');
    assert.equal(fan.height, 0, 'the control sector’s floor, as `R_FakeFlat` hands it back');
    assert.deepEqual(
      quads.map((q) => [q.botH, q.topH]),
      [[0, 128]],
      'the midtexture hung off the drawn floor, and no step up to it',
    );
    // Vanilla fakes front and back sector alike (`r_bsp.c: R_AddLine`), so the
    // sector's own side of the line hangs from the same opening as the room's.
    // Sized against its real floor instead, the midtexture on whichever of the
    // four sides faces the camera sits `platformFloor` clear of its neighbours,
    // and re-seats itself as the camera orbits past the corner.
    assert.deepEqual(
      back.map((q) => [q.botH, q.topH]),
      quads.map((q) => [q.botH, q.topH]),
      'both sides of the line agree',
    );
  });

  test('a midtexture over a fake floor hangs from the real floor, not the drawn one', () => {
    // `R_RenderMaskedSegRange` pegs off `curline->frontsector`/`->backsector`,
    // the seg's own sectors, and runs `R_FakeFlat` only for the light level
    // (r_segs.c) — so only the opening the band is *clipped* to follows a 242.
    // Pegged off the drawn floor instead, BOOMEDIT MAP01's four `242TEXTA`
    // signs sit on the floor of the room whatever height the platform is at.
    const up = invisiblePlatform({ unpegged: true });
    assert.equal(up.fan.height, 0, 'the platform is still drawn flush');
    assert.deepEqual(
      up.quads.map((q) => [q.botH, q.topH]),
      [[32, 128]],
      'while the sign hangs off the platform’s real floor',
    );
    assert.deepEqual(up.back.map((q) => [q.botH, q.topH]), up.quads.map((q) => [q.botH, q.topH]));

    // Sector 110 is a lift (lines 673-675 are a turbo lift on its own tag), so
    // the anchor has to ride the real floor down with it while the drawn floor
    // stays where the control sector put it.
    const down = invisiblePlatform({ unpegged: true, platformFloor: 0 });
    assert.deepEqual(
      down.quads.map((q) => [q.botH, q.topH]),
      [[0, 128]],
      'lowered flush, the sign comes down with it',
    );
  });

  test('a fake floor a neighbour sits above keeps the real floor', () => {
    // The other reading of a below-floor control sector: junk left by a fake
    // ceiling or a colormap transfer (literalism.wad MAP18 hangs 661 sectors off
    // one such control). Following it would drop the floor out from under walls
    // the neighbour has to cover, so the substitution declines.
    const { fan, quads, back, eligible } = invisiblePlatform({ neighbourFloor: 16 });
    assert.deepEqual(eligible, [], 'the rule declines it');
    assert.equal(fan.height, 32, 'its own floor');
    assert.deepEqual(
      quads.map((q) => [q.botH, q.topH]),
      [[16, 32], [32, 128]],
      'and the step the map does texture stays exactly as tall as it was',
    );
    assert.deepEqual(
      back.map((q) => [q.botH, q.topH]),
      [[32, 128]],
      'with the sector’s own side hung off the same real floor',
    );
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
