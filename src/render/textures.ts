/**
 * {@link MaterialBank}: WAD bitmaps turned into cached three.js materials — every wall texture and
 * flat exists exactly once on the GPU, including the dither-fade variants occlusion asks for.
 * See docs/render-occlusion.md.
 */
import * as THREE from 'three';
import type { Bitmap, GraphicsBank } from '../wad/graphics.ts';
import {
  BIN_HALF,
  BIN_PER_RADIAN,
  EMPTY_SLOT,
  EMPTY_WORD,
  MAX_DYN_LIGHTS,
  MAX_LIGHTS_PER_LEAF,
  SHADOW_BIAS,
  SHADOW_SOFT_BINS,
  SHADOW_STEPS,
  SHADOW_TAPS,
  type DynamicLights,
} from './lights.ts';
import { glslFloat } from '../util/glsl.ts';
import { wallShadeUniform } from './wallshadow.ts';
import { skyTintUniform } from './skytint.ts';
import { DISTANCE_LIGHT_GLSL, diminishUniform } from './sectorlight.ts';

export type SurfaceKind = 'wall' | 'flat';

/** A texture's pixel dimensions, as {@link MaterialBank.size} reports them. */
export interface Size {
  w: number;
  h: number;
}

/**
 * The live uniform objects {@link DynamicLights} mutates each frame.
 * docs/lights.md § Two lighting paths.
 */
type LightUniforms = DynamicLights['uniforms'];

const SOFT_BINS = glslFloat(SHADOW_SOFT_BINS);
const SOFT_SPAN = glslFloat(2 * SHADOW_SOFT_BINS);

/**
 * The dynamic-light term, appended to the `#include <color_fragment>` replacement so it lands while
 * `diffuseColor` is still live. `vColor` is the sector's baked light and `sampledDiffuseColor` the
 * texel: the lights are added to the *multiplier*, not the texel, which reproduces vanilla's
 * fullbright ceiling instead of overbrightening the texture past it. The ceiling is the tone
 * mapper's rather than a clamp here, so what passes it survives to be the bloom's only source.
 * docs/lights.md § Two lighting paths, § Bloom.
 *
 * A light only counts where it can be seen from, tested twice. `aLightCell` is the light cell the
 * surface was filed under and `uLightVis` the per-cell list of the lights that flooded into it,
 * which is all the fragment loop walks; `uLightShadow` then carries, per light and per direction,
 * how far that light gets before a wall stops it, which drops the rest per pixel.
 * `uLightVisWidth` 0 means no level is bound and geometry draws no dynamic light.
 * docs/lights.md § Light stops at walls.
 */
const DYN_LIGHT_FRAGMENT = /* glsl */ `
            // Gated on the light count and the level being bound, both the same for every
            // fragment: a branch that varies per fragment costs a GPU more than it saves unless it
            // rejects nearly all of them, and a bounding sphere around the committed set measured
            // 56% slower on a map where it rejects nothing. docs/lights.md § What reaches the
            // shader. uLightVisWidth 0 (no level bound — tests, tools) draws no dynamic light on
            // geometry: there is no leaf list to walk.
            if (uLightCount > 0 && uLightVisWidth > 0) {
              vec3 dynLight = vec3(0.0);
              // The leaf's light list comes in flat from the vertex stage — see the vertex patch
              // below. The loop walks only the lights that reached this leaf, not the committed
              // set: on a light-saturated map the committed set is 64 while a leaf holds a
              // handful, and the walk over the other 60 was most of the frame
              // (docs/lights.md § How the answer reaches a fragment).
              uvec4 lightVis = vLightVis;
              // Bounded by the live count, not by the leaf capacity with only the break inside: a
              // statically bounded loop is one a driver is free to unroll, and 16 copies of a body
              // carrying an atan and a texelFetch is a shader whose register pressure is paid by
              // every fragment, lit or not.
              int slotLim = min(uLightCount, ${MAX_LIGHTS_PER_LEAF});
              for (int k = 0; k < slotLim; k++) {
                uint slot = (lightVis[k >> 2] >> uint((k & 3) << 3)) & ${EMPTY_SLOT}u;
                if (slot == ${EMPTY_SLOT}u) break;
                int i = int(slot);
                float radius = uLightPos[i].w;
                float dist = distance(uLightPos[i].xyz, vDynWorldPos);
                float att = clamp((radius - dist) / radius, 0.0, 1.0);
                // Ordered so the shadow lookup — an atan and a fetch — is only paid for by the
                // fragments a light actually reaches.
                if (att <= 0.0) continue;
                vec2 rel = vDynWorldPos.xz - uLightPos[i].xz;
                float flatDist = length(rel);
                // The lit fraction of the arc [bin - soft, bin + soft], not the one bin the
                // fragment falls in: each bin weighs what it covers of that interval, which slides
                // continuously with the angle and so ramps a shadow's edge instead of cutting it.
                // The kernel being angular is what widens the penumbra with distance from the
                // light. docs/lights.md § Soft edges.
                float lo = atan(rel.y, rel.x) * ${glslFloat(BIN_PER_RADIAN)} + ${glslFloat(BIN_HALF)} - ${SOFT_BINS};
                int base = int(floor(lo));
                float lit = 0.0;
                for (int t = 0; t < ${SHADOW_TAPS}; t++) {
                  int b = base + t;
                  float w = min(float(b + 1), lo + ${SOFT_SPAN}) - max(float(b), lo);
                  // Wrapped, not clamped: the interval straddles bin 0 due west like any other.
                  b = b < 0 ? b + ${SHADOW_STEPS} : (b >= ${SHADOW_STEPS} ? b - ${SHADOW_STEPS} : b);
                  float blocker = texelFetch(uLightShadow, ivec2(b, i), 0).r;
                  lit += max(w, 0.0) * step(flatDist, blocker + ${glslFloat(SHADOW_BIAS)});
                }
                lit /= ${SOFT_SPAN};
                if (lit <= 0.0) continue;
                dynLight += uLightColor[i] * att * lit;
              }
              // Deliberately unclamped: the fullbright ceiling is three's own tone mapping, the
              // same per-channel saturate, and leaving the excess intact is what the bloom
              // threshold reads (docs/lights.md § Bloom).
              diffuseColor.rgb += sampledDiffuseColor.rgb * dynLight;
            }`;

/**
 * Turns WAD bitmaps into three.js materials and caches them, so every wall
 * texture and flat exists exactly once on the GPU.
 */
export class MaterialBank {
  private materials = new Map<string, THREE.MeshBasicMaterial | null>();
  private maxAnisotropy = 1;

  private gfx: GraphicsBank;
  private lights: LightUniforms | null;

  constructor(gfx: GraphicsBank, renderer?: THREE.WebGLRenderer, lights?: LightUniforms) {
    this.gfx = gfx;
    this.lights = lights ?? null;
    if (renderer) this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  }

  /**
   * Wall texture pixel height, or null if the name doesn't resolve — vanilla's `textureheight[]`,
   * for `raiseToTexture` (`game/specials.ts`). Decodes and caches the full bitmap
   * ({@link GraphicsBank.texture}) rather than reading the `TEXTURE1`/`TEXTURE2` header alone: the
   * caller is a rarely-firing trigger, not worth a second, header-only lookup path.
   */
  textureHeight(name: string): number | null {
    return this.gfx.texture(name)?.height ?? null;
  }

  get(kind: SurfaceKind, name: string): THREE.MeshBasicMaterial | null {
    const key = kind + ':' + name.toUpperCase();
    const hit = this.materials.get(key);
    if (hit !== undefined) return hit;

    const bmp = kind === 'flat' ? this.gfx.flat(name) : this.gfx.texture(name);
    let mat: THREE.MeshBasicMaterial | null = null;
    if (bmp) {
      const holes = this.hasHoles(bmp);
      mat = new THREE.MeshBasicMaterial({
        map: this.toTexture(bmp),
        vertexColors: true,
        side: THREE.FrontSide,
        alphaTest: holes ? 0.5 : 0,
      });
      mat.name = key;
      // Both walls and flats carry a per-vertex alpha: walls for occlusion
      // fading (render/occlusion.ts) and both for fog-of-war reveal
      // (game/fogofwar.ts). It is spent on a dithered discard rather than real
      // alpha blending (`material.transparent`), which keeps geometry in the
      // ordinary opaque, depth-tested pass — docs/render-occlusion.md has why blending
      // cannot work for a map-wide batch.
      const lights = this.lights;
      mat.onBeforeCompile = (shader) => {
        // Three per-vertex amounts written at build time, each with a live uniform beside it so a
        // change reaches the level already running: the shading a wall lays on the floor at its
        // foot (docs/render-lighting.md § Wall contact shading), whether the surface stands under
        // sky (§ Outdoor sky tint), and the sector's light itself as `aLightSeg` — the vertex
        // carries no brightness, so the ramp below is the only thing lighting map geometry
        // (§ Distance lighting). `batchMesh` builds every geometry these materials draw, so all
        // three are
        // always present.
        shader.uniforms.uWallShade = wallShadeUniform;
        shader.uniforms.uSkyTint = skyTintUniform;
        shader.uniforms.uDiminish = diminishUniform;
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            `#include <common>
            attribute float aWallShade;
            attribute float aSkyLit;
            uniform float uWallShade;
            uniform vec3 uSkyTint;
            ${DISTANCE_LIGHT_GLSL.vertexDeclarations}`,
          )
          .replace(
            '#include <color_vertex>',
            `#include <color_vertex>
            vColor.rgb *= 1.0 - aWallShade * uWallShade;
            vColor.rgb *= mix(vec3(1.0), uSkyTint, aSkyLit);`,
          )
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            ${DISTANCE_LIGHT_GLSL.vertexCapture}`,
          );
        // Dynamic lights ride along in this same replacement, and they have to: `diffuseColor` is
        // consumed into `outgoingLight` a few lines below `color_fragment`, so anything added to
        // it after that point is silently thrown away (docs/lights.md § Two lighting paths). The
        // distance term goes first, on the sector's light alone: a dynamic light is added after it
        // and never diminishes, as vanilla has none to diminish.
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
            ${DISTANCE_LIGHT_GLSL.fragmentDeclarations}`,
          )
          .replace(
          '#include <color_fragment>',
          `float texelAlpha = diffuseColor.a;
            #include <color_fragment>
            ${DISTANCE_LIGHT_GLSL.fragmentApply}
            {
              // Interleaved gradient noise (Jimenez) — a cheap, decorrelated
              // per-pixel threshold for screen-door transparency.
              float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
              // The vertex alpha dithers and the texel's own coverage meets the alpha test, each
              // alone: tested as their product, a masked texture faded under its alphaTest is
              // discarded whole. docs/render-occlusion.md § Flats.
              if (diffuseColor.a < dither * texelAlpha) discard;
              diffuseColor.a = texelAlpha;
            }${lights ? DYN_LIGHT_FRAGMENT : ''}`,
        );
        if (!lights) return;
        // Dynamic lights (docs/lights.md). The map and mover groups are added to the scene
        // untransformed, so `position` is already world space — `modelMatrix` costs nothing here
        // and keeps this correct if that ever stops being true.
        shader.uniforms.uLightCount = lights.uLightCount;
        shader.uniforms.uLightPos = lights.uLightPos;
        shader.uniforms.uLightColor = lights.uLightColor;
        shader.uniforms.uLightVis = lights.uLightVis;
        shader.uniforms.uLightVisWidth = lights.uLightVisWidth;
        shader.uniforms.uLightShadow = lights.uLightShadow;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>
            varying vec3 vDynWorldPos;
            attribute float aLightCell;
            flat varying uvec4 vLightVis;
            uniform highp usampler2D uLightVis;
            uniform int uLightVisWidth;`,
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
            vDynWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
            // The leaf's light list, read here rather than in the fragment stage. Every vertex of a
            // quad or a flat's fan carries the same leaf, so the value is constant across the
            // primitive and \`flat\` carries it exactly — while the fetch itself drops from once
            // per drawn pixel to once per vertex. All-ones is the empty list, so an unprobed quad
            // (aLightCell -1) stays unlit. docs/lights.md § How the answer reaches a fragment.
            vLightVis = uvec4(${EMPTY_WORD}u);
            // floor, not a bare cast: GLSL truncates toward zero, which would read the -1 an
            // unprobed quad carries as leaf 0.
            int lightCell = int(floor(aLightCell + 0.5));
            if (uLightVisWidth > 0 && lightCell >= 0) {
              vLightVis = texelFetch(uLightVis, ivec2(lightCell % uLightVisWidth, lightCell / uLightVisWidth), 0);
            }`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
            varying vec3 vDynWorldPos;
            flat varying uvec4 vLightVis;
            uniform int uLightCount;
            uniform vec4 uLightPos[${MAX_DYN_LIGHTS}];
            uniform vec3 uLightColor[${MAX_DYN_LIGHTS}];
            uniform int uLightVisWidth;
            uniform sampler2D uLightShadow;`,
        );
      };
      // three.js keys its program cache on material *parameters*, so a patched material would
      // otherwise be served the program compiled for an unpatched one with the same parameters
      // (the same hazard `SpriteBatch`'s fuzz materials guard against).
      mat.customProgramCacheKey = () => (lights ? 'maplights' : 'map');
    }
    this.materials.set(key, mat);
    return mat;
  }

  /** Pixel size of a texture; needed to convert world units into UVs. */
  size(kind: SurfaceKind, name: string): Size | null {
    const bmp = kind === 'flat' ? this.gfx.flat(name) : this.gfx.texture(name);
    return bmp ? { w: bmp.width, h: bmp.height } : null;
  }

  /**
   * True if `name` already has a live material — i.e. some batch actually uses it.
   * `AnimatedTextures` only bothers swapping frames for names that passed this.
   */
  has(kind: SurfaceKind, name: string): boolean {
    return !!this.materials.get(kind + ':' + name.toUpperCase());
  }

  /**
   * Repoints an already-built material at a different bitmap, in place —
   * `AnimatedTextures` (render/textureanim.ts) calls this once per animation
   * tic. `alphaTest` is deliberately left as whatever the name's *first*
   * frame decided: no vanilla animated sequence has holes partway through,
   * so re-deriving it every swap would only cost a shader recompile for
   * nothing.
   */
  setFrame(kind: SurfaceKind, name: string, frameName: string): void {
    const mat = this.materials.get(kind + ':' + name.toUpperCase());
    if (!mat) return;
    const bmp = kind === 'flat' ? this.gfx.flat(frameName) : this.gfx.texture(frameName);
    if (!bmp) return;
    mat.map?.dispose();
    mat.map = this.toTexture(bmp);
  }

  dispose(): void {
    for (const mat of this.materials.values()) {
      mat?.map?.dispose();
      mat?.dispose();
    }
    this.materials.clear();
  }

  private toTexture(bmp: Bitmap): THREE.DataTexture {
    const tex = new THREE.DataTexture(bmp.data, bmp.width, bmp.height, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // Nearest magnification keeps the chunky DOOM pixels; mipmaps kill the
    // shimmer on floors that stretch far away from the camera.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.maxAnisotropy;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /** True when the bitmap has fully transparent texels (grates, fences, ...). */
  private hasHoles(bmp: Bitmap): boolean {
    for (let i = 3; i < bmp.data.length; i += 4) {
      if (bmp.data[i] === 0) return true;
    }
    return false;
  }
}
