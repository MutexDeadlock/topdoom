import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Transfers, transfersOf } from '../../src/game/specials/transfers.ts';
import { gridMap, addControlSector } from '../fixtures/gridmap.ts';
import { NO_SIDE } from '../../src/wad/map.ts';

/**
 * Boom's render transfers as data: which sector or line each parameter number
 * marks, and what it resolves to. The rendering of them lives in
 * tests/render/water.test.ts and tests/render/translucency.test.ts.
 * See docs/specials.md § Render transfers.
 */
describe('specials · render transfer scan', () => {
  test('213 and 261 point a sector at the control sector behind the line', () => {
    const { map } = gridMap(['..']);
    map.sectors[0].tag = 4;
    map.sectors[1].tag = 4;
    const control = addControlSector(map, { light: 250 }, 213, 4);

    const t = new Transfers(map);
    assert.ok(t.hasAny);
    assert.equal(t.floorLight(0), 250, 'floor takes the control sector light');
    assert.equal(t.floorLight(1), 250);
    assert.equal(t.ceilingLight(0), map.sectors[0].light, 'ceiling is untouched by 213');
    assert.equal(t.floorLightSector(0), control);
    assert.equal(t.ceilingLightSector(0), 0, 'an untransferred surface is its own source');

    const ceiling = addControlSector(map, { light: 32 }, 261, 4);
    const t2 = new Transfers(map);
    assert.equal(t2.ceilingLight(1), 32);
    assert.equal(t2.ceilingLightSector(1), ceiling);
    // R_AddSprites: (floorlightlevel + ceilinglightlevel) / 2.
    assert.equal(t2.spriteLight(1), (250 + 32) / 2);
  });

  test('a map with no transfer line lights every sprite exactly as its sector does', () => {
    const { map } = gridMap(['..']);
    map.sectors[1].light = 96;
    const t = new Transfers(map);
    assert.equal(t.hasAny, false);
    assert.equal(t.spriteLight(1), 96);
    assert.equal(t.floorLight(1), 96);
    assert.equal(t.heightSec(1), -1);
    assert.equal(t.waterHeight(1), null);
  });

  test('242 records the control sector, its colormaps, and only draws water above the floor', () => {
    const { map } = gridMap(['..']);
    map.sectors[0].tag = 7;
    map.sectors[0].floorHeight = -64;
    map.sectors[1].tag = 8;
    map.sectors[1].floorHeight = 32;
    const deep = addControlSector(map, { floorHeight: 0, ceilHeight: 128 }, 242, 7, {
      lower: 'BLUMAP',
      middle: 'WATERMAP',
      upper: 'SKYMAP',
    });
    // A control sector at or below the real floor is Boom's fake *ceiling*:
    // recorded, but nothing to draw against a camera that skips ceilings.
    addControlSector(map, { floorHeight: 0, ceilHeight: 64 }, 242, 8);

    const t = new Transfers(map);
    assert.equal(t.heightSec(0), deep);
    assert.equal(t.waterHeight(0), 0, 'surface sits at the control sector floor');
    assert.equal(t.waterHeight(1), null, 'no surface below the real floor');
    assert.deepEqual(t.colormapsOf(deep), { bottom: 'BLUMAP', mid: 'WATERMAP', top: 'SKYMAP' });
    assert.equal(t.colormapsOf(0), null);
    assert.deepEqual(
      t.waterSectors().map((w) => w.sector),
      [0, 1],
    );
    assert.deepEqual(t.counts(), { floorLight: 0, ceilingLight: 0, water: 2, translucent: 0 });
  });

  test('260 marks its own line at tag 0 and the whole tag group otherwise', () => {
    const { map } = gridMap(['...']);
    const own = map.linedefs.findIndex((l) => l.left !== NO_SIDE);
    map.linedefs[own].special = 260;
    map.linedefs[own].tag = 0;

    const t = new Transfers(map);
    assert.ok(t.translucentLine(own));
    assert.equal(t.translucentLine(own + 1), false);

    // Tagged: every line carrying the tag, including ones with no special.
    const other = map.linedefs.findIndex((l, i) => i !== own && l.left !== NO_SIDE);
    map.linedefs[own].tag = 12;
    map.linedefs[own].special = 260;
    map.linedefs[other].tag = 12;
    const t2 = new Transfers(map);
    assert.ok(t2.translucentLine(own));
    assert.ok(t2.translucentLine(other), 'the tag group goes translucent too');
  });

  test("a 260 sidedef naming a translucency map draws no midtexture", () => {
    const { map } = gridMap(['...']);
    const line = map.linedefs.findIndex((l) => l.left !== NO_SIDE);
    map.linedefs[line].special = 260;
    map.sidedefs[map.linedefs[line].right].middle = 'HTRANMAP';

    // Without a lump probe the name is just a texture, which is what it is on
    // every 260 line in the wild bar a handful.
    assert.equal(new Transfers(map).midtexSuppressed(line), false);
    const probed = new Transfers(map, (name) => (name === 'HTRANMAP' ? 65536 : 4096));
    assert.ok(probed.midtexSuppressed(line));
    assert.ok(probed.translucentLine(line), 'still translucent, just textureless');

    map.sidedefs[map.linedefs[line].right].middle = 'TRANMAP';
    assert.ok(new Transfers(map).midtexSuppressed(line), 'the literal name needs no probe');
  });

  test('transfersOf memoizes against the map', () => {
    const { map } = gridMap(['..']);
    assert.equal(transfersOf(map), transfersOf(map));
    assert.notEqual(transfersOf(map), transfersOf(gridMap(['..']).map));
  });
});
