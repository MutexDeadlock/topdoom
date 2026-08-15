import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { CachedSprite } from '../../src/render/sprites.ts';
import { SpriteBatch } from '../../src/render/spritebatch.ts';
import { FUZZ_TYPES, THING_SPRITES } from '../../src/game/things/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * The spectre draws the demon's own art, so which *batch* poses it is the
 * whole of the difference between the two — docs/sprites.md § The spectre's
 * fuzz. These hold the two halves of that: the type set that routes it, and
 * the material patch the fuzz batch applies (which no headless test can
 * render, but whose shape is exactly what a silent regression would break).
 */

/** A stand-in for a decoded lump, the way `SpriteMaterialCache.get` builds one. */
function sprite(): CachedSprite {
  const map = new THREE.DataTexture(new Uint8Array(64 * 100 * 4), 64, 100, THREE.RGBAFormat);
  return {
    material: new THREE.MeshBasicMaterial({ map, alphaTest: 0.5 }),
    geometry: new THREE.PlaneGeometry(64, 100),
    quad: { minX: -32, maxX: 32, height: 100 },
  };
}

/** The one material a batch built for `cached`, reached the way three.js would. */
function materialOf(batch: SpriteBatch, cached: CachedSprite): THREE.MeshBasicMaterial {
  batch.begin(0);
  batch.add(cached, 0, 0, 0, 1, 1);
  batch.end();
  const mesh = batch.group.children[0] as THREE.InstancedMesh;
  return mesh.material as THREE.MeshBasicMaterial;
}

/** Runs `onBeforeCompile` against a stub of what three.js hands it, returning the result. */
function compile(material: THREE.MeshBasicMaterial): { uniforms: Record<string, { value: number }>; fragmentShader: string } {
  const shader = {
    uniforms: {} as Record<string, { value: number }>,
    vertexShader: '',
    // The chunk the patch hooks, where meshbasic_frag has it.
    fragmentShader: 'void main() {\n#include <map_fragment>\n#include <color_fragment>\n}',
  };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as never);
  return shader;
}

describe('Sprites · the spectre draws as fuzz', () => {
  test('MF_SHADOW is the spectre and nothing else, on the demon’s art', () => {
    assert.deepEqual([...FUZZ_TYPES], [ThingType.spectre]);
    // If these ever diverge the fuzz stops being the only difference, and the
    // set above is no longer the whole story.
    assert.equal(THING_SPRITES[ThingType.spectre], THING_SPRITES[ThingType.demon]);
  });

  test('a fuzz batch patches its materials, an ordinary batch leaves them alone', () => {
    const cached = sprite();
    const plain = materialOf(new SpriteBatch(), cached);
    // No patch, and no cache key of its own — the ordinary sprite program.
    assert.equal(plain.onBeforeCompile.toString(), new THREE.MeshBasicMaterial().onBeforeCompile.toString());
    assert.equal(plain.customProgramCacheKey(), new THREE.MeshBasicMaterial().customProgramCacheKey());

    const fuzzed = materialOf(new SpriteBatch({ fuzz: true }), cached);
    const { fragmentShader, uniforms } = compile(fuzzed);
    // Screen-door, not blending: the fuzz has to stay in the opaque pass.
    assert.equal(fuzzed.blending, plain.blending);
    assert.equal(fuzzed.transparent, false);
    assert.match(fragmentShader, /discard;/);
    assert.match(fragmentShader, /diffuseColor\.rgb \*=/);
    assert.ok(uniforms.uFuzzTime, 'the shimmer clock never reached the shader');
    // Both materials would otherwise key the program cache identically — the
    // fuzzed one has to ask for its own program.
    assert.notEqual(fuzzed.customProgramCacheKey(), plain.customProgramCacheKey());
  });

  test('the shimmer steps once per tic, through the uniform the shader holds', () => {
    const batch = new SpriteBatch({ fuzz: true });
    const { uniforms } = compile(materialOf(batch, sprite()));

    batch.setFuzzTime(10 * DOOM_TIC);
    const atTic = uniforms.uFuzzTime.value;
    // Two frames inside the same tic must not move it, or the shimmer runs at
    // the display's rate instead of vanilla's 35Hz.
    batch.setFuzzTime(10 * DOOM_TIC + DOOM_TIC * 0.4);
    assert.equal(uniforms.uFuzzTime.value, atTic);
    batch.setFuzzTime(11 * DOOM_TIC);
    assert.notEqual(uniforms.uFuzzTime.value, atTic);
  });
});
