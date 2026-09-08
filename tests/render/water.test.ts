import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh, type FlatSurface } from '../../src/render/mapmesh.ts';
import { lightSegment } from '../../src/render/sectorlight.ts';
import { FlatFader } from '../../src/render/occlusion.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { WATER_SURFACE_ALPHA } from '../../src/constants.ts';
import { LF, NO_SIDE } from '../../src/wad/map.ts';
import { gridMap, addControlSector } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';
import { fadeFrame, targetAt } from '../fixtures/fade.ts';

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

/**
 * How lit a fan is. The vertex colour carries no brightness (docs/render-lighting.md § Distance
 * lighting) — `aLightSeg` is the whole record, and what the shader samples the ramp at.
 */
const lightOf = (built: ReturnType<typeof pool>['built'], f: FlatSurface) => {
  const attr = built.flatMeshes.get(f.key)!.geometry.getAttribute('aLightSeg');
  return attr.getX(f.vertexStart);
};

/**
 * The lowest alpha anywhere on a fan. A fan is diced finer than its outline now
 * (docs/render-occlusion.md § The fade is a hole, not a wall), so vertex 0 is a corner and
 * says nothing about the hole in the middle.
 */
const lowestAlphaOf = (built: ReturnType<typeof pool>['built'], f: FlatSurface) => {
  const attr = built.flatMeshes.get(f.key)!.geometry.getAttribute('color');
  let lowest = 1;
  for (let v = 0; v < f.vertexCount; v++) lowest = Math.min(lowest, attr.getW(f.vertexStart + v));
  return lowest;
};

describe('Rendering · deep water planes', () => {
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
    assert.equal(lightOf(built, bottom), lightSegment(90));
    assert.equal(bottom.baseAlpha, undefined, 'the bottom is solid');

    // Above-water view: the control sector's height, wearing the sector's own
    // flat and light — and translucent, which vanilla's never is.
    assert.equal(surface.key, 'flat:' + WATER_FLAT);
    assert.equal(surface.lightSector, 0);
    assert.equal(lightOf(built, surface), lightSegment(200));
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

    fader.commit(() => 1);
    assert.equal(lowestAlphaOf(built, surface), WATER_SURFACE_ALPHA, 'unoccluded and fully revealed: the base alone');

    fader.commit(() => 0.5);
    assert.equal(lowestAlphaOf(built, surface), WATER_SURFACE_ALPHA * 0.5, 'half-revealed by fog: the product');
  });

  /**
   * BOOMEDIT MAP01's stairs inside sector 35's pool: the transfers are resolved
   * at the authored heights (as `Game.beginLevel` does, ahead of any restore),
   * then a mover raises the step's floor to `floorHeight`.
   */
  function risenStep(floorHeight: number) {
    const map = gridMap(['..']).map;
    map.sectors[0].tag = 3;
    map.sectors[0].floorHeight = -64;
    map.sectors[0].floorTex = WATER_FLAT;
    map.sectors[0].light = 200;
    const control = addControlSector(
      map,
      { floorHeight: 0, ceilHeight: 128, floorTex: POOL_FLAT, light: 90 },
      242,
      3,
    );
    const transfers = transfersOf(map);
    map.sectors[0].floorHeight = floorHeight;
    const built = buildMapMesh(map, BANK, { transfers });
    return { built, control, fans: built.flatSurfaces.filter((f) => f.sector === 0) };
  }

  test('a pool bottom raised to the water line keeps the pool bottom’s flat', () => {
    // BOOMEDIT MAP01's stair steps are 242 sectors of sector 35's pool, and its
    // top step comes to rest exactly at the surface. Drawn with the sector's own
    // flat it wears FWATER1 — a patch of water on a dry step, beside steps still
    // showing the rock they are built from.
    const { built, control, fans } = risenStep(0);
    assert.equal(fans.length, 1, 'no water left over it, so no surface fan');
    assert.equal(fans[0].height, 0);
    assert.equal(fans[0].key, 'flat:' + POOL_FLAT, 'the control sector’s flat, as while it was submerged');
    assert.equal(fans[0].baseAlpha, undefined, 'and solid — it is dry ground now');
    assert.equal(fans[0].lightSector, control, 'lit like the pool bottom it is, not like the surface');
    assert.equal(lightOf(built, fans[0]), lightSegment(90));
  });

  test('a pool bottom raised clear of the water line keeps it too', () => {
    const { fans } = risenStep(32);
    assert.equal(fans.length, 1);
    assert.equal(fans[0].height, 32, 'at its real floor — the drawn floor never substitutes upwards');
    assert.equal(fans[0].key, 'flat:' + POOL_FLAT);
  });

  test('a sector that never had water over it is untouched by that rule', () => {
    // BOOMEDIT MAP01 sectors 449-452: a 242 whose control sector sits at the
    // sector's own floor from the start (a colormap room, not a pool). Its own
    // flat is the one to draw — the control's is only a pool bottom's.
    const map = gridMap(['..']).map;
    map.sectors[0].tag = 3;
    map.sectors[0].floorHeight = 0;
    map.sectors[0].floorTex = WATER_FLAT;
    addControlSector(map, { floorHeight: 0, ceilHeight: 128, floorTex: POOL_FLAT }, 242, 3);
    const built = buildMapMesh(map, BANK, { transfers: transfersOf(map) });
    const fans = built.flatSurfaces.filter((f) => f.sector === 0);
    assert.equal(fans.length, 1);
    assert.equal(fans[0].key, 'flat:' + WATER_FLAT, 'its own flat, not the control sector’s');
  });

  /**
   * BOOMEDIT MAP01 sector 121 in miniature: a sector walled in on every side by
   * one pool and left out of its tag. `untagged` leaves one cell out of the
   * pool — passed a *neighbouring* cell, that makes the middle one an ordinary
   * sector bordering water rather than an island in it.
   */
  function island({ floor = -32, ceil = -32, untagged = [-1, -1] } = {}) {
    const grid = gridMap(['...', '...', '...']);
    const map = grid.map;
    const centre = grid.index(1, 1);
    const dry = untagged[0] < 0 ? -1 : grid.index(untagged[0], untagged[1]);
    for (let i = 0; i < 9; i++) {
      if (i === centre || i === dry) continue;
      map.sectors[i].tag = 3;
      map.sectors[i].floorHeight = -64;
      map.sectors[i].floorTex = WATER_FLAT;
    }
    map.sectors[centre].floorHeight = floor;
    map.sectors[centre].ceilHeight = ceil;
    map.sectors[centre].floorTex = POOL_FLAT;
    addControlSector(map, { floorHeight: 0, ceilHeight: 128, floorTex: WATER_FLAT }, 242, 3);
    const built = buildMapMesh(map, BANK, { transfers: transfersOf(map) });
    return { grid, centre, fans: built.flatSurfaces.filter((f) => f.sector === centre) };
  }

  test('the pool’s surface runs over an island the mapper left out of its tag', () => {
    // BOOMEDIT MAP01 sector 121: a closed sky pillar standing in sector 93's
    // pool, 64 units under the surface and carrying none of its tag. Boom draws
    // no surface over it — from overhead that is a square hole in the water.
    const { fans } = island();
    // Below the surface only: the pillar is a solid block, so `findSolidBlocks` caps its top at
    // the room's ceiling as well, across as many leaves as the BSP split it into.
    const under = fans.filter((fan) => fan.height <= 0);
    assert.equal(under.length, 2, 'its own top, and the pool’s surface over it');
    assert.equal(fans[0].height, -32, 'the island’s own floor');
    assert.equal(fans[0].key, 'flat:' + POOL_FLAT, 'wearing its own flat, seen through the water');
    assert.equal(fans[1].height, 0, 'the pool’s surface, at the control sector’s floor');
    assert.equal(fans[1].key, 'flat:' + WATER_FLAT, 'wearing the pool sector’s flat, not the island’s');
    assert.equal(fans[1].baseAlpha, WATER_SURFACE_ALPHA);
  });

  test('an island standing out of the water gets no surface over it', () => {
    // A chamber whose ceiling clears the surface is dry inside whatever is
    // around it, so the sheet has to stop at its wall.
    const { fans } = island({ floor: -32, ceil: 64 });
    assert.equal(fans.length, 1, 'its own floor alone');
  });

  test('a sector bordering water but not walled in by it is not an island', () => {
    // The cell north of it is not water, so the sheet around it is not one pool
    // closing over it — the same test `markPoolIslands` makes.
    const { fans } = island({ untagged: [1, 0] });
    assert.equal(fans.filter((fan) => fan.height <= 0).length, 1);
  });

  test('the surface over a submerged player is never faded away', () => {
    // The camera stays above the water while the player wades under it, so the
    // sightline crosses the surface — but it is already see-through, and fading
    // only the fans the line crosses punches a hole in the sheet.
    const { built, fans } = pool();
    const surface = fans.find((f) => f.height === 0)!;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < surface.points.length; i += 2) {
      sx += surface.points[i];
      sy += surface.points[i + 1];
    }
    const cx = sx / (surface.points.length / 2);
    const cy = sy / (surface.points.length / 2);
    const submerged = targetAt(cx, cy, -32);

    const fader = new FlatFader(built.flatSurfaces, built.flatMeshes);
    fader.update(fadeFrame(1, cx, cy, 500, [submerged]));
    fader.commit(() => 1);
    assert.equal(lowestAlphaOf(built, surface), WATER_SURFACE_ALPHA, 'still the base alpha, not dithered away');

    // The same fan on the same sightline without its base alpha: an ordinary
    // floor there does fade, so it is the exemption sparing the surface.
    const opaque = new FlatFader([{ ...surface, baseAlpha: undefined }], built.flatMeshes);
    opaque.update(fadeFrame(1, cx, cy, 500, [submerged]));
    opaque.commit(() => 1);
    // Any fade at all is the control this needs — how deep it goes is a feel
    // dial (`FADE_ALPHA`), and pinning a number here would pin that.
    assert.ok(lowestAlphaOf(built, surface) < 1, 'the sightline really does cross this fan');
  });

  test('a control sector below the real ceiling still reaches the walls across from it', () => {
    // BOOMEDIT MAP01 lines 677-680: sector 111 (real ceiling 192) draws at
    // control sector 112's ceiling of 32, so the SFALL1 fall facing it runs
    // 256..32 as one band. Sized against the real 192 instead, the upper stops
    // short and the midtexture's own y-offset drops it clear of the opening,
    // leaving a 32-unit hole between the two halves of the waterfall.
    const { quads } = fakeCeiling();
    // One unbroken run of wall rather than one quad: 224 units is tall enough
    // that `addWall` bands it for the fade (docs/render-occlusion.md § The fade is a hole,
    // not a wall), so what says "the upper alone" is that the pieces meet with
    // no gap — a midtexture would hang as a separate span inside the opening.
    const spans = quads.map((q) => [q.botH, q.topH]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      assert.equal(spans[i][0], spans[i - 1][1], 'the bands meet, so this is one tier');
    }
    assert.deepEqual([spans[0][0], spans[spans.length - 1][1]], [32, 256]);
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
