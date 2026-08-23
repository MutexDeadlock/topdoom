import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MaterialBank } from '../../src/render/textures.ts';
import { DynamicLights, MAX_DYN_LIGHTS } from '../../src/render/lights.ts';
import { SHADOW_STEPS } from '../../src/render/lightvis.ts';
import { parseGldefs } from '../../src/wad/gldefs.ts';
import type { GraphicsBank } from '../../src/wad/graphics.ts';

/** Enough of a `GraphicsBank` for `MaterialBank.get` to build a material from. */
const GFX = {
  texture: () => ({ width: 2, height: 2, data: new Uint8Array(16).fill(255) }),
  flat: () => null,
} as unknown as GraphicsBank;

/**
 * three expands `#include <...>` **after** `onBeforeCompile` (`WebGLProgram.resolveIncludes`), so
 * resolve them the same way before asking what is in scope where.
 */
function resolveIncludes(src: string): string {
  let out = src;
  for (let guard = 0; guard < 20 && /^[ \t]*#include +<([\w\d./]+)>/m.test(out); guard++) {
    out = out.replace(
      /^[ \t]*#include +<([\w\d./]+)>/gm,
      (_m, name: string) => (THREE.ShaderChunk as Record<string, string>)[name] ?? '',
    );
  }
  return out;
}

/** Runs the bank's `onBeforeCompile` against three's real `meshbasic` source. */
function patched(lights?: DynamicLights): {
  vertex: string;
  fragment: string;
  uniforms: Record<string, unknown>;
  material: THREE.MeshBasicMaterial;
} {
  const bank = new MaterialBank(GFX, undefined, lights?.uniforms);
  const material = bank.get('wall', 'ANY')!;
  const lib = THREE.ShaderLib.basic;
  const shader = {
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    uniforms: {} as Record<string, unknown>,
  };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null!);
  return {
    vertex: resolveIncludes(shader.vertexShader),
    fragment: resolveIncludes(shader.fragmentShader),
    uniforms: shader.uniforms,
    material,
  };
}

/**
 * The dynamic-light patch `MaterialBank` puts in every map material. It is anchored on three.js's
 * own shader chunk names and on where `map_fragment` leaves `sampledDiffuseColor`, so a three
 * upgrade that moves either would silently stop lighting the level — this is what catches that.
 * docs/lights.md § Two lighting paths.
 */
describe('Dynamic lights · the geometry shader patch', () => {
  test('every anchor it replaces is really there, and the patch lands', () => {
    const lights = new DynamicLights(parseGldefs(''));
    const { vertex, fragment } = patched(lights);
    assert.ok(vertex.includes('varying vec3 vDynWorldPos;'), 'no world-position varying declared');
    assert.ok(vertex.includes('vDynWorldPos = (modelMatrix'), 'the varying is never written');
    assert.ok(fragment.includes('varying vec3 vDynWorldPos;'), 'the varying never reaches the fragment stage');
    assert.ok(fragment.includes(`uniform vec4 uLightPos[${MAX_DYN_LIGHTS}]`), 'no light uniforms');
    assert.ok(fragment.includes('dynLight += uLightColor[i] * att;'), 'no accumulation loop');
  });

  test('the visibility gate is wired: attribute, flat varying, integer sampler and the bit test', () => {
    // Without this the shader lights every surface in radius, wall or no wall — the reported bug
    // (docs/lights.md § Light stops at walls). `flat` matters: an interpolated leaf index is a
    // different index.
    const { vertex, fragment } = patched(new DynamicLights(parseGldefs('')));
    assert.ok(vertex.includes('attribute float aLightCell;'), 'the leaf index never enters the vertex stage');
    assert.ok(vertex.includes('vLightCell = aLightCell;'), 'the leaf index is never passed on');
    assert.ok(fragment.includes('flat varying float vLightCell;'), 'the leaf index must not be interpolated');
    assert.ok(fragment.includes('uniform highp usampler2D uLightVis;'), 'the mask must be an integer sampler');
    assert.ok(fragment.includes('texelFetch(uLightVis'), 'the mask is never read');
    const test = fragment.indexOf('lightVis[i >> 5]');
    const accumulate = fragment.indexOf('dynLight += uLightColor');
    assert.ok(test >= 0, 'no bit test');
    assert.ok(test < accumulate, 'the bit test must gate the accumulation, not follow it');
  });

  test('the shadow lookup is wired, indexed the way the controller writes it, and gated behind the falloff', () => {
    const { fragment } = patched(new DynamicLights(parseGldefs('')));
    assert.ok(fragment.includes('uniform sampler2D uLightShadow;'), 'no shadow map');
    // `angle / 2pi + 0.5`, the one convention `castShadows` and `unshadowed` also index with —
    // reading it half a turn out still looks plausible on symmetric geometry.
    assert.ok(fragment.includes('0.15915494 + 0.5'), 'the shadow map is indexed on another convention');
    assert.ok(fragment.includes(`ivec2(clamp(bin, 0, ${SHADOW_STEPS - 1}), i)`), 'a light must read its own row');
    const falloff = fragment.indexOf('if (att <= 0.0) continue;');
    const lookup = fragment.indexOf('texelFetch(uLightShadow');
    assert.ok(falloff >= 0 && falloff < lookup, 'only fragments a light reaches should pay for the atan');
  });

  test('the uniforms are the controller\'s own live objects, not copies', () => {
    // Mutated in place every frame, so a copy here would freeze the lights at frame zero.
    const lights = new DynamicLights(parseGldefs(''));
    const { uniforms } = patched(lights);
    assert.equal(uniforms.uLightPos, lights.uniforms.uLightPos);
    assert.equal(uniforms.uLightColor, lights.uniforms.uLightColor);
    assert.equal(uniforms.uLightCount, lights.uniforms.uLightCount);
    assert.equal(uniforms.uLightVis, lights.uniforms.uLightVis);
    assert.equal(uniforms.uLightVisWidth, lights.uniforms.uLightVisWidth);
    assert.equal(uniforms.uLightShadow, lights.uniforms.uLightShadow);
  });

  test('the light term lands while diffuseColor is still live', () => {
    // The bug this pins: `diffuseColor.rgb` is folded into `outgoingLight` a few lines below
    // `color_fragment`, and `opaque_fragment` then writes `gl_FragColor` from *that*. A light term
    // added any later — at `fog_fragment`, say — compiles, runs, and is thrown away, which reads on
    // screen as sprites lighting each other while the level around them stays dark.
    const { fragment } = patched(new DynamicLights(parseGldefs('')));
    const ours = fragment.indexOf('dynLight += uLightColor');
    const consumed = fragment.indexOf('reflectedLight.indirectDiffuse *= diffuseColor.rgb');
    assert.ok(ours >= 0, 'no light term at all');
    assert.ok(consumed >= 0, 'three no longer consumes diffuseColor the way this patch assumes');
    assert.ok(ours < consumed, 'the light term is added after diffuseColor stops being read');
  });

  test('it sits after the texel and the dither, and the fog mix still runs last', () => {
    const { fragment } = patched(new DynamicLights(parseGldefs('')));
    const sampled = fragment.indexOf('vec4 sampledDiffuseColor');
    const dither = fragment.indexOf('if (diffuseColor.a < dither)');
    const ours = fragment.indexOf('dynLight += uLightColor');
    const fog = fragment.indexOf('fogColor, fogFactor');
    assert.ok(sampled >= 0 && sampled < ours, 'sampledDiffuseColor must be assigned before it is read');
    assert.ok(dither >= 0 && dither < ours, 'the occlusion dither must still run first');
    assert.ok(fog >= 0 && ours < fog, 'a lit surface must still fog');
  });

  test('the dither fade the patch shares its hook with is untouched', () => {
    // Both tenants live in one `#include <color_fragment>` replacement — docs/render.md
    // § Wall occlusion fading.
    const { fragment } = patched(new DynamicLights(parseGldefs('')));
    assert.ok(fragment.includes('if (diffuseColor.a < dither) discard;'));
  });

  test('a patched material carries a program cache key; an unpatched one does not', () => {
    // three keys its program cache on material parameters, so without this a patched material can
    // be served the program compiled for an unpatched one.
    const lit = patched(new DynamicLights(parseGldefs('')));
    assert.equal(lit.material.customProgramCacheKey(), 'maplights');
    const unlit = patched();
    assert.notEqual(unlit.material.customProgramCacheKey(), 'maplights');
  });

  test('a bank built without lights emits no light code at all', () => {
    const { vertex, fragment, uniforms } = patched();
    assert.ok(!vertex.includes('vDynWorldPos'));
    assert.ok(!fragment.includes('uLightCount'));
    assert.ok(!vertex.includes('aLightCell'));
    assert.ok(!fragment.includes('uLightVis'));
    assert.ok(!fragment.includes('uLightShadow'));
    assert.deepEqual(Object.keys(uniforms), []);
    // …but still fades, which is the other tenant of the same hook.
    assert.ok(fragment.includes('if (diffuseColor.a < dither) discard;'));
  });
});
