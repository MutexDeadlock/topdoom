/**
 * The sprite atlas: a WAD set's sprite lumps packed into a few page textures, so `SpriteBatch`
 * draws one page per call rather than one lump. Packed once per session, shelf by height; a lump
 * too big for a page stays out and draws from a texture of its own. See docs/sprites.md
 * § Batching.
 */
import * as THREE from 'three';
import type { Bitmap } from '../../wad/graphics.ts';

/** Where a lump's pixels sit in a page, in texels from the page's top-left corner. */
export interface AtlasRect {
  page: THREE.DataTexture;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Page edge in texels: the largest 2D texture WebGL 2 guarantees, so a page never depends on the
 * GPU. DOOM2's 1381 sprite lumps (5.8 MP) fill two.
 */
export const ATLAS_PAGE_SIZE = 2048;

/**
 * Transparent texels kept around every lump. Nearest sampling at a quad's very edge can round into
 * the texel beside it, which must be one the alpha test discards.
 */
export const ATLAS_GUTTER = 1;

/**
 * How every sprite texture is sampled, page and lump alike: hard texels, no mipmaps, the WAD
 * palette's own colour space. One function because atlas-drawn and lump-drawn art must look
 * identical — see `SpriteMaterialCache.get`, the other caller.
 */
export function sampleAsSprite(texture: THREE.DataTexture, anisotropy: number): void {
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
}

export class SpriteAtlas {
  readonly pages: THREE.DataTexture[] = [];
  private rects = new Map<string, AtlasRect>();

  /**
   * Packs `pictures` — lump name and decoded bitmap — tallest first, in shelves. The order is
   * fixed by height, width and then name, so a set packs the same way every session.
   */
  constructor(pictures: readonly (readonly [string, Bitmap])[], anisotropy = 1) {
    const sorted = [...pictures].sort(
      ([an, a], [bn, b]) => b.height - a.height || b.width - a.width || (an < bn ? -1 : an > bn ? 1 : 0),
    );
    const size = ATLAS_PAGE_SIZE;
    const gutter = ATLAS_GUTTER;
    let page: THREE.DataTexture | null = null;
    let x = gutter;
    let y = gutter;
    let shelfHeight = 0;
    for (const [name, bmp] of sorted) {
      const w = bmp.width;
      const h = bmp.height;
      if (w + 2 * gutter > size || h + 2 * gutter > size) continue;
      if (page && x + w + gutter > size) {
        y += shelfHeight + gutter;
        x = gutter;
        shelfHeight = 0;
      }
      if (!page || y + h + gutter > size) {
        page = makePageTexture(new Uint8Array(size * size * 4), size, anisotropy);
        this.pages.push(page);
        x = gutter;
        y = gutter;
        shelfHeight = 0;
      }
      const data = page.image.data as Uint8Array;
      for (let row = 0; row < h; row++) {
        data.set(bmp.data.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * size + x) * 4);
      }
      this.rects.set(name.toUpperCase(), { page, x, y, width: w, height: h });
      x += w + gutter;
      if (h > shelfHeight) shelfHeight = h;
    }
  }

  /** The lump's place, or undefined for one that was not packed (unknown, or too big for a page). */
  rectOf(lump: string): AtlasRect | undefined {
    return this.rects.get(lump.toUpperCase());
  }

  dispose(): void {
    for (const p of this.pages) p.dispose();
    this.pages.length = 0;
    this.rects.clear();
  }
}

function makePageTexture(data: Uint8Array, size: number, anisotropy: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  sampleAsSprite(texture, anisotropy);
  texture.needsUpdate = true;
  return texture;
}
