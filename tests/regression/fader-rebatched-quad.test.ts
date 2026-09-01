import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WallFader } from '../../src/render/occlusion.ts';
import type { WallOccluder } from '../../src/render/mapmesh.ts';

/**
 * **A fader must write into the batch its quad belongs to *now*, not the one it was built against.**
 *
 * `WallFader` resolves each quad's colour buffer once and keeps it, rather than looking the mesh up
 * by key on every commit. That is only safe because `invalidateWritten` re-resolves, and it is
 * called on the one path that can move a quad to another batch: `refreshMoverMesh` rewrites a
 * mover's records through `copyRefreshedQuad`, whose `Object.assign` copies `key` along with
 * everything else. A refresh that swaps two quads' textures leaves the batch *set* and every
 * buffer length unchanged, so it is accepted in place — and without the re-resolve the fader would
 * go on writing a door's alpha into the batch it no longer draws in.
 * docs/render.md § Mover meshes.
 */
describe('Regressions · a fader follows its quad to a new batch', () => {
  /** One batch's colour buffer, six vertices' worth — `addWall`'s [A, D, C, A, C, B]. */
  function batchMesh(): THREE.Mesh {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(6 * 4).fill(1), 4));
    return new THREE.Mesh(geom);
  }

  function quad(key: string): WallOccluder {
    return {
      key,
      texName: key.slice(key.indexOf(':') + 1),
      vertexStart: 0,
      vertexCount: 6,
      ax: 0,
      ay: 0,
      bx: 64,
      by: 0,
      botH: 0,
      topH: 64,
      segAx: 0,
      segAy: 0,
      segBx: 64,
      segBy: 0,
      sector: 0,
      line: 0,
      frontSide: true,
      subsector: -1,
      baseAlpha: undefined,
    };
  }

  /** The alpha channel of a batch's first vertex, which every commit here writes. */
  function alphaOf(mesh: THREE.Mesh): number {
    return (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).getW(0);
  }

  test('a quad moved to another batch is written there after invalidateWritten', () => {
    const a = batchMesh();
    const b = batchMesh();
    const meshes = new Map([
      ['wall:A', a],
      ['wall:B', b],
    ]);
    const o = quad('wall:A');
    const fader = new WallFader([o], meshes);

    fader.commit(() => 0.25);
    assert.equal(alphaOf(a), 0.25, 'it starts by writing the batch it was built against');
    assert.equal(alphaOf(b), 1, 'and leaves the other batch alone');

    // What a refresh does: the record is rewritten in place, key and all.
    o.key = 'wall:B';
    fader.invalidateWritten();
    fader.commit(() => 0.5);

    assert.equal(alphaOf(b), 0.5, 'the quad now fades in the batch it moved to');
    assert.equal(alphaOf(a), 0.25, 'and the batch it left keeps whatever it last held');
  });
});
