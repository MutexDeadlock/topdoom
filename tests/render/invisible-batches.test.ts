import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapMesh } from '../../src/render/mapmesh.ts';
import { WallFader, FlatFader } from '../../src/render/occlusion.ts';
import { Transfers } from '../../src/game/specials/transfers.ts';
import { NO_SIDE } from '../../src/wad/map.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { BANK } from '../fixtures/specialsrig.ts';

/**
 * `maxAlphaByKey`: what lets `MoverGeometry.updateFading` skip drawing a mesh
 * whose every quad has faded to nothing. See docs/render-occlusion.md § Skipping
 * invisible mover meshes — a Boom map's per-sector mover meshes are numerous
 * enough (973 on literalism.wad MAP18) that drawing the invisible ones was the
 * bulk of the frame's draw calls.
 */
const WALLTEX = 'MIDGRATE';

/** Three open cells, with a midtexture hung in each opening so there are wall quads to fade. */
function walled() {
  const grid = gridMap(['...']);
  const map = grid.map;
  for (const l of map.linedefs) {
    if (l.left !== NO_SIDE && l.right !== NO_SIDE) map.sidedefs[l.right].middle = WALLTEX;
  }
  return buildMapMesh(map, BANK, { transfers: new Transfers(map) });
}

describe('Rendering · invisible batches report themselves', () => {
  test('a wall batch reports its fog alpha, and zero only when everything is hidden', () => {
    const b = walled();
    assert.ok(b.occluders.length > 1, 'the fixture should build several wall quads in one batch');
    const fader = new WallFader(b.occluders, b.wallMeshes, true);
    const key = b.occluders[0].key;

    fader.commit(() => 1);
    assert.equal(fader.maxAlphaByKey.get(key), 1);

    fader.commit(() => 0);
    assert.equal(fader.maxAlphaByKey.get(key), 0);
  });

  test('one still-lit quad keeps its whole batch drawn', () => {
    const b = walled();
    const fader = new WallFader(b.occluders, b.wallMeshes, true);
    // Everything hidden but a single quad — the batch it lives in must not be
    // reported invisible, or that quad vanishes with it.
    fader.commit((i) => (i === 0 ? 1 : 0));
    assert.equal(fader.maxAlphaByKey.get(b.occluders[0].key), 1);
  });

  test('an unchanged alpha still reports visible on the next frame', () => {
    // The regression this guards: `commit` skips writing a quad whose alpha has
    // not moved, so accumulating the max *after* that early-out would report a
    // steady, fully visible batch as invisible on every frame but the first —
    // blinking the level out one frame after it settled.
    const b = walled();
    const fader = new WallFader(b.occluders, b.wallMeshes, true);
    const key = b.occluders[0].key;
    fader.commit(() => 1);
    assert.equal(fader.maxAlphaByKey.get(key), 1, 'first frame writes and reports');
    fader.commit(() => 1);
    assert.equal(fader.maxAlphaByKey.get(key), 1, 'second frame writes nothing but still reports visible');
  });

  test('flats report the same way, on the same rules', () => {
    const grid = gridMap(['...', '...']);
    const b = buildMapMesh(grid.map, BANK, { transfers: new Transfers(grid.map) });
    const fader = new FlatFader(b.flatSurfaces, b.flatMeshes, true);
    const key = b.flatSurfaces[0].key;
    fader.commit(() => 1);
    assert.equal(fader.maxAlphaByKey.get(key), 1);
    fader.commit(() => 1);
    assert.equal(fader.maxAlphaByKey.get(key), 1, 'unchanged alpha still reports visible');
    fader.commit(() => 0);
    assert.equal(fader.maxAlphaByKey.get(key), 0);
  });
});
