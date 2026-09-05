import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh, buildMoverMesh, type WallOccluder } from '../../src/render/mapmesh.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMoverIndex } from '../../src/game/specials/movergeometry.ts';
import { LF, NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { gridMap, type CellHeights } from '../fixtures/gridmap.ts';
import { BANK, MASKED_TEXTURE } from '../fixtures/specialsrig.ts';
import type { MaterialBank } from '../../src/render/textures.ts';

/**
 * Which thin ceiling steps this engine declines to draw, and which it keeps — see
 * docs/render.md § Ceiling trims.
 */

const UPPER = 'UPPER';
/** A sign's texture: 16 tall, the height of DOOM's own `EXITSIGN`, where every other name is 128. */
const SIGN = 'SIGN';
/** `BANK` sizes every texture alike, which no sign test can use — only `SIGN` is drawn whole. */
const SIGN_BANK = {
  ...BANK,
  size: (_kind: string, name: string) => (name === SIGN ? { w: 64, h: 16 } : { w: 64, h: 128 }),
} as unknown as MaterialBank;

/**
 * Two cells side by side, `a` looking at `b` over whatever step their ceilings leave. The fixture
 * gives every cell one sector the width of `cell`, so the neighbour's own size is the grid's.
 * Every side carries the step's texture as its lower too, the way DOOM's editors set all three
 * slots at once — a lower that draws nothing here, since the floors match.
 */
function pair(a: CellHeights, b: CellHeights, cell = 128, texture = UPPER): DoomMap {
  const grid = gridMap(['ab'], { heights: { a, b }, cell });
  for (const side of grid.map.sidedefs) {
    side.upper = texture;
    side.lower = UPPER;
  }
  return grid.map;
}

/**
 * The upper step's quads, of which a trimmed step has none. Matched on the top the step hangs
 * from, since a lower step drawn from the same texture stands somewhere else entirely.
 */
function uppers(map: DoomMap, top: number, texture = UPPER): WallOccluder[] {
  return buildMapMesh(map, SIGN_BANK, {}).occluders.filter((o) => o.texName === texture && o.topH === top);
}

const OPEN = { floor: 0, ceil: 240 };
/** The trim-shaped neighbour: an 8-unit step, well inside `TRIM_MAX_HEIGHT`. */
const TRIM = { floor: 0, ceil: 232 };

describe('Rendering · ceiling trims', () => {
  test('a thin step over a walkable opening is not drawn', () => {
    assert.equal(uppers(pair(OPEN, TRIM), 240).length, 0);
  });

  test('a step past TRIM_MAX_HEIGHT is structure and stays', () => {
    const kept = uppers(pair(OPEN, { floor: 0, ceil: 208 }), 240);
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0].botH, kept[0].topH], [208, 240]);
  });

  test('a sill with less than a player under it stays, however thin', () => {
    // 48 of opening over the higher of the two floors — a window, not something walked under.
    const kept = uppers(pair({ floor: 0, ceil: 56 }, { floor: 0, ceil: 48 }), 56);
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0].botH, kept[0].topH], [48, 56]);
  });

  test('the higher floor is what the opening is measured over', () => {
    // The same 232-unit ceiling, with the neighbour's floor raised to leave 40 under it.
    assert.equal(uppers(pair(OPEN, { floor: 192, ceil: 232 }), 240).length, 1);
  });

  test('a recess the size of a sign is trimmed like any wider one', () => {
    assert.equal(uppers(pair(OPEN, TRIM, 64), 240).length, 0);
    assert.equal(uppers(pair(OPEN, TRIM, 16), 240).length, 0);
  });

  /** A 16-unit step over a sign-sized box, carrying the 16-tall sign texture whole. */
  const SIGN_STEP = { floor: 0, ceil: 224 };

  test('a texture shown whole over a sign-sized box is a sign and keeps its step', () => {
    const kept = uppers(pair(OPEN, SIGN_STEP, 64, SIGN), 240, SIGN);
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0].botH, kept[0].topH], [224, 240]);
  });

  test('the same texture cropped anywhere on the map is material, and its step is trim', () => {
    const map = pair(OPEN, SIGN_STEP, 64, SIGN);
    // Painted on one of the box's own 224-unit walls too: fourteen tiles of a 16-tall texture.
    const wall = map.sidedefs[map.linedefs.find((l) => l.left === NO_SIDE && map.sidedefs[l.right].sector === 1)!.right];
    wall.middle = SIGN;
    assert.equal(uppers(map, 240, SIGN).length, 0);
  });

  test('a sign texture over a room-sized sector is a ribbon, whole or not', () => {
    assert.equal(uppers(pair(OPEN, SIGN_STEP, 65, SIGN), 240, SIGN).length, 0);
  });

  test('a texture the map paints nowhere else is still trim when the step crops it', () => {
    // Every texture but `SIGN` is 128 tall, so an 8-unit step shows a sixteenth of it.
    assert.equal(uppers(pair(OPEN, TRIM, 128, 'EXITSIGN'), 240, 'EXITSIGN').length, 0);
  });

  test('the build counts what it left out, for the level-load line to report', () => {
    assert.equal(buildMapMesh(pair(OPEN, TRIM), BANK, {}).trimmedUppers, 1);
    assert.equal(buildMapMesh(pair(OPEN, { floor: 0, ceil: 208 }), BANK, {}).trimmedUppers, 0);
  });

  test('two sky ceilings draw no upper either way', () => {
    const map = pair(OPEN, TRIM);
    for (const sector of map.sectors) sector.ceilTex = 'F_SKY1';
    assert.equal(uppers(map, 240).length, 0);
  });

  /**
   * The midtexture clip follows vanilla's rule about what the mapper textured, so a trimmed step
   * cuts a grate exactly where the step it stands in for would have.
   */
  test('a trimmed step still cuts the midtexture hung in its opening', () => {
    const map = pair(OPEN, TRIM);
    const line = map.linedefs.findIndex((l) => l.left !== NO_SIDE && l.right !== NO_SIDE);
    const side = map.sidedefs[map.linedefs[line].right];
    side.middle = MASKED_TEXTURE;
    // Carries the texture's top above the neighbour's ceiling, where the cut is the only thing
    // that can bring it back down.
    side.yOffset = 64;
    map.linedefs[line].flags &= ~LF.LOWER_UNPEGGED;

    const built = buildMapMesh(map, BANK, {});
    const grate = built.occluders.filter((o) => o.texName === MASKED_TEXTURE);
    assert.equal(grate.length, 1);
    assert.deepEqual([grate[0].botH, grate[0].topH], [168, 232]);
  });
});

describe('Rendering · ceiling trims and movers', () => {
  /** The trim-shaped pair above, with the lower-ceilinged neighbour pulled out as a mover. */
  function mover(moving: boolean) {
    const map = pair(OPEN, TRIM);
    const polys = buildSubSectorPolys(map);
    const sector = 1;
    const options = {
      movableSectors: new Set([sector]),
      movingSectors: new Set(moving ? [sector] : []),
    };
    const built = buildMoverMesh({ map, polys, bank: BANK, options, index: buildMoverIndex(map, polys) }, sector);
    return built.wallQuads.filter((o) => o.texName === UPPER);
  }

  test('a step a special can move keeps its upper, so a door sheds no header mid-travel', () => {
    assert.equal(mover(true).length, 1);
  });

  test('a mover that only hosts a switch trims like the static geometry it is', () => {
    assert.equal(mover(false).length, 0);
  });
});
