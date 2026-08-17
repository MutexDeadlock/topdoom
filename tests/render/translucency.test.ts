import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { WallFader } from '../../src/render/occlusion.ts';
import { Transfers } from '../../src/game/specials/transfers.ts';
import { NO_SIDE, type DoomMap } from '../../src/wad/map.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * Boom's 260: a midtexture drawn at 66% through the same vertex-alpha channel
 * occlusion fading and fog of war already share, and the sidedef-name overload
 * that can leave it with no texture at all.
 * See docs/specials.md § Translucent midtextures.
 */

const GRATE = 'MIDGRATE';
const ALPHA = 0.66;

/** Two open cells with a see-through grate hung in the opening between them. */
function grate(setup: (map: DoomMap, line: number) => void, lumpSize?: (n: string) => number | null) {
  const grid = gridMap(['..']);
  const map = grid.map;
  const line = map.linedefs.findIndex((l) => l.left !== NO_SIDE);
  map.sidedefs[map.linedefs[line].right].middle = GRATE;
  setup(map, line);
  const built = buildMapMesh(map, BANK, { transfers: new Transfers(map, lumpSize) });
  return { map, line, built, quads: built.occluders.filter((o) => o.line === line && o.key === 'wall:' + GRATE) };
}

describe('render · translucent midtextures', () => {
  test('a plain midtexture is opaque, a 260 one is not', () => {
    const plain = grate(() => {});
    assert.equal(plain.quads.length, 1);
    assert.equal(plain.quads[0].baseAlpha, undefined);

    const { quads } = grate((map, line) => {
      map.linedefs[line].special = 260;
    });
    assert.equal(quads.length, 1);
    assert.equal(quads[0].baseAlpha, ALPHA);
  });

  test('the base alpha reaches the vertices through the fader, fog included', () => {
    const { built, quads } = grate((map, line) => {
      map.linedefs[line].special = 260;
    });
    const q = quads[0];
    const fader = new WallFader(built.occluders, built.wallMeshes);
    const alphaOf = () => built.wallMeshes.get(q.key)!.geometry.getAttribute('color').getW(q.vertexStart);

    // The attribute is Float32, so compare against the rounded value.
    fader.commit(() => 1);
    assert.equal(alphaOf(), Math.fround(ALPHA));
    fader.commit(() => 0.5);
    assert.equal(alphaOf(), Math.fround(ALPHA * 0.5));
  });

  test('a tagged 260 line makes its whole tag group translucent', () => {
    const grid = gridMap(['...']);
    const map = grid.map;
    const [first, second] = map.linedefs.reduce<number[]>((acc, l, i) => (l.left !== NO_SIDE ? [...acc, i] : acc), []);
    for (const l of [first, second]) map.sidedefs[map.linedefs[l].right].middle = GRATE;
    map.linedefs[first].special = 260;
    map.linedefs[first].tag = 5;
    map.linedefs[second].tag = 5;

    const built = buildMapMesh(map, BANK, { transfers: new Transfers(map) });
    for (const line of [first, second]) {
      const quad = built.occluders.find((o) => o.line === line && o.key === 'wall:' + GRATE);
      assert.equal(quad?.baseAlpha, ALPHA, `line ${line} translucent`);
    }
  });

  test('a midtexture naming a translucency map is not drawn at all', () => {
    const { quads } = grate(
      (map, line) => {
        map.linedefs[line].special = 260;
        map.sidedefs[map.linedefs[line].right].middle = 'HTRANMAP';
      },
      (name) => (name === 'HTRANMAP' ? 65536 : 4096),
    );
    assert.equal(quads.length, 0, 'no quad at all — the name was the tranmap, not a texture');
  });
});
