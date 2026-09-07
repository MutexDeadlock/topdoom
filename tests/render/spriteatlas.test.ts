import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ATLAS_GUTTER, ATLAS_PAGE_SIZE, SpriteAtlas } from '../../src/render/sprites/atlas.ts';
import { SpriteMaterialCache } from '../../src/render/sprites.ts';
import { ATLAS_BEGIN_VERTEX_GLSL, ATLAS_UV_VERTEX_GLSL, SpriteBatch } from '../../src/render/sprites/batch.ts';
import type { Bitmap, GraphicsBank } from '../../src/wad/graphics.ts';

/**
 * The sprite atlas: every lump of a set packed into a few page textures, so a frame of ten
 * thousand things is a handful of draw calls rather than one per lump — docs/sprites.md
 * § Batching. These pin the packing, what a cached sprite says about its place, what a batch
 * writes per instance, and the vertex patch that reads it.
 */

/** A `width` x `height` bitmap whose every texel is its own index, so a copy can be told apart. */
function bitmap(width: number, height: number, left = width / 2, top = height): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i & 255;
    data[i * 4 + 1] = (i >> 8) & 255;
    data[i * 4 + 2] = 7;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data, left, top };
}

const PICTURES: Record<string, Bitmap> = {
  TROOA1: bitmap(40, 60, 21),
  TROOA2A8: bitmap(38, 58, 19),
  BAR1A0: bitmap(23, 32, 11),
  HUGE: bitmap(ATLAS_PAGE_SIZE, 10),
};

/** Enough of a `GraphicsBank` for the cache: the pictures above, nothing else. */
const GFX = {
  picture: (name: string) => PICTURES[name] ?? null,
  // The atlas drops each lump it packed; this stub decodes nothing, so forgetting costs it nothing.
  forgetPicture: () => {},
} as unknown as GraphicsBank;

/** The texel at page coordinates, as RGBA. */
function texel(page: THREE.DataTexture, x: number, y: number): number[] {
  const data = page.image.data as Uint8Array;
  const o = (y * ATLAS_PAGE_SIZE + x) * 4;
  return [...data.subarray(o, o + 4)];
}

describe('Sprites · the atlas', () => {
  test('lumps pack without overlapping, a gutter apart, and keep their pixels', () => {
    const atlas = new SpriteAtlas(Object.entries(PICTURES));
    assert.equal(atlas.pages.length, 1);
    const rects = ['TROOA1', 'TROOA2A8', 'BAR1A0'].map((n) => atlas.rectOf(n)!);
    for (const r of rects) assert.ok(r, 'every ordinary lump is packed');
    for (const a of rects) {
      for (const b of rects) {
        if (a === b) continue;
        const apart =
          a.x + a.width + ATLAS_GUTTER <= b.x ||
          b.x + b.width + ATLAS_GUTTER <= a.x ||
          a.y + a.height + ATLAS_GUTTER <= b.y ||
          b.y + b.height + ATLAS_GUTTER <= a.y;
        assert.ok(apart, 'two lumps never touch');
      }
    }
    const r = atlas.rectOf('BAR1A0')!;
    const bmp = PICTURES.BAR1A0;
    for (const [x, y] of [[0, 0], [22, 0], [0, 31], [22, 31], [5, 17]]) {
      const i = y * bmp.width + x;
      assert.deepEqual(texel(r.page, r.x + x, r.y + y), [i & 255, (i >> 8) & 255, 7, 255]);
    }
    // The gutter around it is transparent, which the alpha test discards.
    assert.equal(texel(r.page, r.x - 1, r.y)[3], 0);
    assert.equal(texel(r.page, r.x + r.width, r.y)[3], 0);
    assert.equal(texel(r.page, r.x, r.y + r.height)[3], 0);
  });

  test('a lump too big for a page is left out rather than cropped', () => {
    const atlas = new SpriteAtlas(Object.entries(PICTURES));
    assert.equal(atlas.rectOf('HUGE'), undefined);
  });

  test('packing is the same whatever order the lumps arrive in', () => {
    const forward = new SpriteAtlas(Object.entries(PICTURES));
    const backward = new SpriteAtlas(Object.entries(PICTURES).reverse());
    for (const n of Object.keys(PICTURES)) {
      const a = forward.rectOf(n);
      const b = backward.rectOf(n);
      assert.deepEqual(a && [a.x, a.y], b && [b.x, b.y]);
    }
  });

  test('a cached sprite maps the quad onto its rect, top row at the top, mirrored by swapping U', () => {
    const cache = new SpriteMaterialCache(GFX, undefined, Object.keys(PICTURES));
    const plain = cache.get('TROOA1', false)!.atlas!;
    const flipped = cache.get('TROOA1', true)!.atlas!;
    const size = ATLAS_PAGE_SIZE;
    // The bottom-left corner's V is the row past the lump's last, the top-right's its first.
    assert.ok(plain.v0 > plain.v1);
    assert.equal(Math.round((plain.v0 - plain.v1) * size), 60);
    assert.equal(Math.round((plain.u1 - plain.u0) * size), 40);
    assert.equal(Math.round((flipped.u0 - flipped.u1) * size), 40);
    assert.equal(flipped.u0, plain.u1);
    assert.equal(flipped.v0, plain.v0);
    // The hotspot's offset, the same one the lump's own plane was translated by, mirrors with it.
    assert.equal(plain.offsetX, 40 / 2 - 21);
    assert.equal(flipped.offsetX, -plain.offsetX);
    assert.equal(plain.width, 40);
    assert.equal(plain.height, 60);
    // A lump the atlas holds no rect for draws from its own texture, as with no atlas at all.
    assert.equal(cache.get('HUGE', false)!.atlas, null);
    assert.equal(new SpriteMaterialCache(GFX).get('TROOA1', false)!.atlas, null);
  });

  test('a batch draws every atlas lump through one mesh, and an unpacked one through its own', () => {
    const cache = new SpriteMaterialCache(GFX, undefined, Object.keys(PICTURES));
    const batch = new SpriteBatch();
    batch.begin(0);
    batch.add(cache.get('TROOA1', false)!, 1, 2, 3, 1, 1);
    batch.add(cache.get('BAR1A0', false)!, 4, 5, 6, 1.4, 1);
    batch.add(cache.get('HUGE', false)!, 7, 8, 9, 1, 1);
    batch.end();
    const meshes = batch.group.children as THREE.InstancedMesh[];
    assert.equal(meshes.length, 2);
    const [page, own] = meshes[0].count === 2 ? meshes : [meshes[1], meshes[0]];
    assert.equal(page.count, 2);
    assert.equal(own.count, 1);
    const rect = page.geometry.getAttribute('aSpriteRect') as THREE.InstancedBufferAttribute;
    const uv = page.geometry.getAttribute('aSpriteUv') as THREE.InstancedBufferAttribute;
    const bar = cache.get('BAR1A0', false)!.atlas!;
    assert.deepEqual([...(rect.array as Float32Array).subarray(3, 6)], [23, 32, bar.offsetX]);
    assert.deepEqual([...(uv.array as Float32Array).subarray(4, 8)].map((v) => Math.fround(v)), [bar.u0, bar.v0, bar.u1, bar.v1].map((v) => Math.fround(v)));
    assert.equal(own.geometry.getAttribute('aSpriteRect'), undefined);
    // Only the written part of each lane is flagged for upload.
    assert.deepEqual(rect.updateRanges, [{ start: 0, count: 6 }]);
    assert.deepEqual(page.instanceMatrix.updateRanges, [{ start: 0, count: 32 }]);
    // Hidden once nothing lands in it: the renderer skips the mesh rather than uploading it.
    batch.begin(0);
    batch.end();
    assert.equal(page.visible, false);
  });

  test('the vertex patch sizes the plane and maps its UVs from the instance lanes', () => {
    // The splice into three's own chunk found its line: a rename would leave the chunk whole.
    assert.notEqual(ATLAS_UV_VERTEX_GLSL, THREE.ShaderChunk.uv_vertex);
    assert.match(ATLAS_UV_VERTEX_GLSL, /vMapUv = mix\( aSpriteUv\.xy, aSpriteUv\.zw, uv \);/);
    assert.match(ATLAS_BEGIN_VERTEX_GLSL, /aSpriteRect\.x.*aSpriteRect\.z.*aSpriteRect\.y/);
    const cache = new SpriteMaterialCache(GFX, undefined, Object.keys(PICTURES));
    const batch = new SpriteBatch();
    batch.begin(0);
    batch.add(cache.get('TROOA1', false)!, 0, 0, 0, 1, 1);
    batch.end();
    const material = (batch.group.children[0] as THREE.InstancedMesh).material as THREE.MeshBasicMaterial;
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as never);
    assert.match(shader.vertexShader, /attribute vec3 aSpriteRect;/);
    assert.match(shader.vertexShader, /attribute vec4 aSpriteUv;/);
    assert.doesNotMatch(shader.vertexShader, /#include <uv_vertex>/);
    assert.doesNotMatch(shader.vertexShader, /#include <begin_vertex>/);
    assert.equal(material.customProgramCacheKey(), 'atlas');
  });
});
