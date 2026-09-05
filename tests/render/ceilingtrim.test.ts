import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh, buildMoverMesh, type WallOccluder } from '../../src/render/mapmesh.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMoverIndex } from '../../src/game/specials/movergeometry.ts';
import { LF, NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { gridMap, type CellHeights } from '../fixtures/gridmap.ts';
import { BANK, MASKED_TEXTURE } from '../fixtures/specialsrig.ts';

/**
 * Which thin ceiling steps this engine declines to draw, and which it keeps — see
 * docs/render.md § Ceiling trims.
 */

const UPPER = 'UPPER';

/**
 * Two cells side by side, `a` looking at `b` over whatever step their ceilings leave. The fixture
 * gives every cell one sector the width of `cell`, so the neighbour's own size is the grid's.
 * Every side carries the step's texture as its lower too, which is what makes it masonry rather
 * than signage — `texture` overrides that for the one test about the difference.
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
  return buildMapMesh(map, BANK, {}).occluders.filter((o) => o.texName === texture && o.topH === top);
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

  test('a fixture the size of a sign keeps its step, a room-sized neighbour does not', () => {
    assert.equal(uppers(pair(OPEN, TRIM, 64), 240).length, 1);
    assert.equal(uppers(pair(OPEN, TRIM, 65), 240).length, 0);
  });

  /**
   * A row of `cells` alternating between the two ceilings, so every boundary is a trim-shaped step
   * over a fixture-sized neighbour. Long enough, the texture stops reading as a landmark.
   */
  function row(cells: number): DoomMap {
    const art = Array.from({ length: cells }, (_, i) => (i % 2 ? 'b' : 'a')).join('');
    const grid = gridMap([art], { heights: { a: OPEN, b: TRIM }, cell: 64 });
    for (const side of grid.map.sidedefs) {
      side.upper = UPPER;
      side.lower = UPPER;
    }
    return grid.map;
  }

  test('a fixture texture repeated past TRIM_FIXTURE_REPEATS is detailing, not a landmark', () => {
    assert.equal(uppers(row(4), 240).length, 3);
    assert.equal(uppers(row(40), 240).length, 0);
  });

  test('a texture the map paints nowhere else is signage and keeps its step', () => {
    const sign = 'EXITSIGN';
    const kept = uppers(pair(OPEN, TRIM, 128, sign), 240, sign);
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0].botH, kept[0].topH], [232, 240]);
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
