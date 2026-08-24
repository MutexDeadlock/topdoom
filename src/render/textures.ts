/**
 * `MaterialBank`: WAD bitmaps turned into cached three.js materials — every wall texture and flat
 * exists exactly once on the GPU, including the dither-fade variants occlusion asks for.
 * See docs/render.md § Wall occlusion fading.
 */
import * as THREE from 'three';
import type { Bitmap, GraphicsBank } from '../wad/graphics.ts';
import { MAX_DYN_LIGHTS, SHADOW_BIAS, type DynamicLights } from './lights.ts';
import { SHADOW_STEPS } from './lightvis.ts';

export type SurfaceKind = 'wall' | 'flat';

/** The live uniform objects `DynamicLights` mutates each frame; see docs/lights.md § Two lighting paths. */
type LightUniforms = DynamicLights['uniforms'];

/**
 * The dynamic-light term, appended to the `#include <color_fragment>` replacement below so it lands
 * while `diffuseColor` is still live. `vColor` is the sector's baked light and `sampledDiffuseColor`
 * the texel: the lights are added to the *multiplier* and clamped there, which reproduces vanilla's
 * fullbright ceiling instead of overbrightening the texture past it. Fog is applied later, to
 * `gl_FragColor`, so a lit surface still fogs. docs/lights.md § Two lighting paths.
 *
 * A light only counts where it can be seen from, tested twice. `vLightCell` is the surface's own
 * BSP leaf and `uLightVis` the per-leaf bitmask of the lights that flooded into it, which drops a
 * light a whole room away; `uLightShadow` then carries, per light and per direction, how far that
 * light gets before a wall stops it, which drops the rest per pixel. `uLightVisWidth` 0 means no
 * level is bound and nothing is gated. docs/lights.md § Light stops at walls.
 */
const DYN_LIGHT_FRAGMENT = /* glsl */ `
            // Gated on the light count alone, which is the same for every fragment: a branch that
            // varies per fragment costs a GPU more than it saves unless it rejects nearly all of
            // them, and a bounding sphere around the committed set measured 56% slower on a map
            // where it rejects nothing. docs/lights.md § What reaches the shader.
            if (uLightCount > 0) {
              vec3 dynLight = vec3(0.0);
              // The mask comes in flat from the vertex stage — see the vertex patch below.
              uvec4 lightVis = vLightVis;
              // Bounded by the live count, not by MAX_DYN_LIGHTS with a break inside: a
              // statically bounded loop is one a driver is free to unroll, and 64 copies of a body
              // carrying an atan and a texelFetch is a shader whose register pressure is paid by
              // every fragment, lit or not.
              for (int i = 0; i < uLightCount; i++) {
                if ((lightVis[i >> 5] & (1u << uint(i & 31))) == 0u) continue;
                float radius = uLightPos[i].w;
                float dist = distance(uLightPos[i].xyz, vDynWorldPos);
                float att = clamp((radius - dist) / radius, 0.0, 1.0);
                // Ordered so the shadow lookup — an atan and a fetch — is only paid for by the
                // fragments a light actually reaches.
                if (att <= 0.0) continue;
                if (uLightVisWidth > 0) {
                  vec2 rel = vDynWorldPos.xz - uLightPos[i].xz;
                  int bin = int(floor((atan(rel.y, rel.x) * 0.15915494 + 0.5) * ${SHADOW_STEPS}.0));
                  float blocker = texelFetch(uLightShadow, ivec2(clamp(bin, 0, ${SHADOW_STEPS - 1}), i), 0).r;
                  if (length(rel) > blocker + ${SHADOW_BIAS}.0) continue;
                }
                dynLight += uLightColor[i] * att;
              }
              diffuseColor.rgb = min(diffuseColor.rgb + sampledDiffuseColor.rgb * dynLight, vec3(1.0));
            }`;

/** A texture's pixel dimensions, as `MaterialBank.size` reports them. */
export interface Size {
  w: number;
  h: number;
}

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

  /**
   * Wall texture pixel height, or null if the name doesn't resolve — vanilla's
   * `textureheight[]` lookup, needed by `raiseToTexture` (`game/specials.ts`)
   * to find the shortest bottom-texture height among a sector's neighboring
   * lines. Decodes (and caches, via `GraphicsBank.texture`'s own cache) the
   * full bitmap rather than reading just the `TEXTURE1`/`TEXTURE2` header,
   * since this is only ever called from a rarely-firing trigger, not a hot
   * path — not worth a second, header-only lookup path just to skip
   * compositing patches that would otherwise never get decoded anyway.
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
      // fading (render/occlusion.ts) and both walls and flats for
      // fog-of-war reveal (game/fogofwar.ts). This is deliberately NOT real
      // alpha blending (material.transparent): geometry is batched one mesh
      // per texture across the *whole* map, and three.js sorts transparent
      // objects back-to-front per mesh — with a mesh spanning the entire
      // level that order is meaningless, and since both meshes still
      // write depth by default, whichever one draws first can win the
      // depth test and blank out the other (this is exactly how a faded
      // pillar could hide the wall behind it). Discarding a dithered
      // fraction of fragments instead keeps geometry fully in the ordinary
      // opaque, depth-tested/written pass — no batch, no sort order, no
      // blending, just fewer pixels — so it composites correctly
      // regardless of draw order. Same caveat as before applies to
      // `holes` textures: alphaTest above already tests the *combined*
      // (texture × vertex) alpha, so a faded grate discards outright
      // instead of dithering.
      const lights = this.lights;
      mat.onBeforeCompile = (shader) => {
        // Dynamic lights ride along in this same replacement, and they have to: `diffuseColor` is
        // consumed into `outgoingLight` a few lines below `color_fragment`, so anything added to
        // it after that point is silently thrown away (docs/lights.md § Two lighting paths).
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
            {
              // Interleaved gradient noise (Jimenez) — a cheap, decorrelated
              // per-pixel threshold for screen-door transparency.
              float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
              if (diffuseColor.a < dither) discard;
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
            // The leaf's light mask, read here rather than in the fragment stage. Every vertex of
            // a quad or a flat's fan carries the same leaf, so the value is constant across the
            // primitive and \`flat\` carries it exactly — while the fetch itself drops from once per
            // drawn pixel to once per vertex. docs/lights.md § How the answer reaches a fragment.
            vLightVis = uvec4(0xFFFFFFFFu);
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
            uniform highp usampler2D uLightVis;
            uniform int uLightVisWidth;
            uniform sampler2D uLightShadow;`,
        );
      };
      // three.js keys its program cache on material *parameters*, so a patched material would
      // otherwise be served the program compiled for an unpatched one with the same parameters
      // (the same hazard `SpriteBatch`'s fuzz materials guard against).
      if (this.lights) mat.customProgramCacheKey = () => 'maplights';
    }
    this.materials.set(key, mat);
    return mat;
  }

  /** Pixel size of a texture; needed to convert world units into UVs. */
  size(kind: SurfaceKind, name: string): Size | null {
    const bmp = kind === 'flat' ? this.gfx.flat(name) : this.gfx.texture(name);
    return bmp ? { w: bmp.width, h: bmp.height } : null;
  }

  /** True if `name` already has a live material — i.e. some batch actually uses it. `AnimatedTextures` only bothers swapping frames for names that passed this. */
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
}
