import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { fixtureWad } from '../fixtures/wadfile.ts';
import { loadMap, NO_LINE } from '../../src/wad/map.ts';
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { pointInConvexPolygon, polygonCentroid } from '../../src/util/geom.ts';

/**
 * A GL BSP as a node builder really wrote one: `doom1_e1m1_xgl.wad` is the
 * `doom1_e1m1.wad` fixture re-nodded by `zdbsp -x -X`, so the two hold the same level
 * under two different BSPs and have to describe the same floor. That is what pins the
 * two things the format leaves implicit — a seg's second vertex and which edges are
 * minisegs. See docs/wad.md § GL nodes.
 */

const load = (file: string) => loadMap(new Wad([fixtureWad(file)]), 'E1M1');

/** How far off its own linedef a seg endpoint may sit: fixed-point rounding, nothing more. */
const ON_LINE = 1 / 64;

describe('WAD parsing · GL nodes', () => {
  const vanilla = load('doom1_e1m1.wad');
  const gl = load('doom1_e1m1_xgl.wad');

  test('the fixture is the same level, with the GL BSP in SSECTORS', () => {
    assert.equal(vanilla.nodeFormat, 'vanilla');
    assert.equal(gl.nodeFormat, 'xgln');
    assert.equal(gl.linedefs.length, vanilla.linedefs.length);
    assert.equal(gl.sectors.length, vanilla.sectors.length);
    assert.deepEqual(gl.bounds, vanilla.bounds);
    assert.ok(gl.nodes.length > 0 && gl.subsectors.length > 0, 'the payload carried a tree');
  });

  test('every seg on a real line runs along that line, both ends of it', () => {
    let minisegs = 0;
    let real = 0;
    for (const seg of gl.segs) {
      if (seg.linedef === NO_LINE) {
        minisegs++;
        continue;
      }
      real++;
      const line = gl.linedefs[seg.linedef];
      const a = gl.vertexes[line.v1];
      const b = gl.vertexes[line.v2];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      // `v2` is not stored — it comes from the next seg in the leaf — so a wrong wrap
      // rule would put this end on some other line entirely.
      for (const v of [gl.vertexes[seg.v1], gl.vertexes[seg.v2]]) {
        const off = Math.abs(dx * (v.y - a.y) - dy * (v.x - a.x)) / length;
        assert.ok(off <= ON_LINE, `seg on line ${seg.linedef} sits ${off} off it`);
        const t = ((v.x - a.x) * dx + (v.y - a.y) * dy) / (length * length);
        assert.ok(t >= -0.001 && t <= 1.001, `seg on line ${seg.linedef} ends past it at ${t}`);
      }
    }
    assert.ok(minisegs > 0, 'a GL BSP closes each leaf with minisegs');
    assert.ok(real > 0);
  });

  test('both BSPs put every leaf in the same sector', () => {
    const vanillaPolys = buildSubSectorPolys(vanilla).filter((p) => p.points.length >= 6);
    const glPolys = buildSubSectorPolys(gl).filter((p) => p.points.length >= 6);

    let checked = 0;
    for (const poly of glPolys) {
      const centre = polygonCentroid(poly.points);
      const host = vanillaPolys.find((q) => pointInConvexPolygon(centre.x, centre.y, q.points));
      // A centroid can land on the seam between two vanilla leaves, where neither owns it.
      if (!host) continue;
      checked++;
      assert.equal(host.sector, poly.sector, `leaf at ${centre.x}, ${centre.y}`);
    }
    assert.ok(checked > glPolys.length * 0.95, `${checked} of ${glPolys.length} leaves landed in a vanilla one`);
  });
});
