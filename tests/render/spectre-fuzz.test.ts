import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { CachedSprite } from '../../src/render/sprites.ts';
import { SpriteBatch } from '../../src/render/spritebatch.ts';
import { MaterialBank } from '../../src/render/textures.ts';
import type { GraphicsBank } from '../../src/wad/graphics.ts';
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
    bottomOffset: 0,
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
    // Blended, not a screen-door discard — the whole point of the fix that
    // stopped the spectre strobing behind a faded wall (docs/sprites.md § Why
    // the fuzz can't share the wall dither's noise).
    assert.equal(fuzzed.transparent, true);
    assert.equal(fuzzed.depthWrite, false);
    assert.doesNotMatch(fragmentShader, /discard/);
    assert.match(fragmentShader, /diffuseColor\.a \*= mix\(/);
    assert.match(fragmentShader, /diffuseColor\.rgb \*=/);
    assert.ok(uniforms.uFuzzTime, 'the shimmer clock never reached the shader');
    // Both materials would otherwise key the program cache identically — the
    // fuzzed one has to ask for its own program.
    assert.notEqual(fuzzed.customProgramCacheKey(), plain.customProgramCacheKey());
  });

  test('the fuzz noise shares no constant with the wall fade\u2019s dither', () => {
    // Both are read at gl_FragCoord, and the wall the spectre stands behind is
    // faded by a dither of its own. Drawn from the same generator the two masks
    // are not independent however the second is seeded, and the spectre's
    // visibility becomes a function of how they line up — measured swinging
    // between the whole silhouette and a tenth of it between consecutive tics.
    const fuzz = compile(materialOf(new SpriteBatch({ fuzz: true }), sprite())).fragmentShader;
    const gfx = {
      texture: () => ({ width: 2, height: 2, data: new Uint8Array(16) }),
      flat: () => null,
    } as unknown as GraphicsBank;
    const wall = new MaterialBank(gfx).get('wall', 'ANY')!;
    const dither = compile(wall).fragmentShader;

    const constantsOf = (glsl: string) =>
      new Set((glsl.match(/\d+\.\d{4,}/g) ?? []).map(Number));
    const shared = [...constantsOf(dither)].filter((n) => constantsOf(fuzz).has(n));
    assert.deepEqual(shared, [], `the fuzz reuses the wall dither's noise constants: ${shared}`);
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
