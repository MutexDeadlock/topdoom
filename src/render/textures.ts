import * as THREE from 'three';
import type { Bitmap, GraphicsBank } from '../wad/graphics.ts';

export type SurfaceKind = 'wall' | 'flat';

/**
 * Turns WAD bitmaps into three.js materials and caches them, so every wall
 * texture and flat exists exactly once on the GPU.
 */
export class MaterialBank {
  private materials = new Map<string, THREE.MeshBasicMaterial | null>();
  private maxAnisotropy = 1;

  private gfx: GraphicsBank;

  constructor(gfx: GraphicsBank, renderer?: THREE.WebGLRenderer) {
    this.gfx = gfx;
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
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
            {
              // Interleaved gradient noise (Jimenez) — a cheap, decorrelated
              // per-pixel threshold for screen-door transparency.
              float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
              if (diffuseColor.a < dither) discard;
            }`,
        );
      };
    }
    this.materials.set(key, mat);
    return mat;
  }

  /** Pixel size of a texture; needed to convert world units into UVs. */
  size(kind: SurfaceKind, name: string): { w: number; h: number } | null {
    const bmp = kind === 'flat' ? this.gfx.flat(name) : this.gfx.texture(name);
    return bmp ? { w: bmp.width, h: bmp.height } : null;
  }

  dispose(): void {
    for (const mat of this.materials.values()) {
      mat?.map?.dispose();
      mat?.dispose();
    }
    this.materials.clear();
  }
}
