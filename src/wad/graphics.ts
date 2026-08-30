/**
 * Decodes the WAD's graphics into RGBA `Bitmap`s: PLAYPAL, the column/post picture format, raw
 * flats, and TEXTURE1/2 + PNAMES patch composition (`GraphicsBank`).
 * See docs/wad.md § Loading and merging.
 */
import { Reader } from './reader.ts';
import type { Lump, Wad, WadFile } from './wad.ts';

/** In-memory RGBA image, row 0 = top (same as in the WAD). */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, w*h*4
  /** Patch hotspot, in pixels from the left/top edge (standalone pictures only). */
  left?: number;
  top?: number;
}

/** Flat markers: `F_START`, the `F1_`/`F2_` sub-ranges in it, and the `FF_` ranges PWADs open. */
const FLAT_START = /^(F|FF|F\d)_START$/;
const FLAT_END = /^(F|FF|F\d)_END$/;

/** 256 RGB entries from PLAYPAL (palette 0 only). */
export function readPalette(wad: Wad): Uint8Array {
  const lump = wad.find('PLAYPAL');
  if (!lump) throw new Error('PLAYPAL missing from WAD');
  return wad.data(lump).slice(0, 768);
}

/**
 * All image sources of a WAD in one place: wall textures (composed from TEXTURE1/2),
 * flats and standalone graphics. Bitmaps are built lazily and cached.
 */
export class GraphicsBank {
  readonly palette: Uint8Array;
  private texDefs: Map<string, TextureDef>;
  private flats = new Map<string, number>(); // name -> lump index
  private cache = new Map<string, Bitmap | null>();

  private wad: Wad;

  constructor(wad: Wad) {
    this.wad = wad;
    this.palette = readPalette(wad);
    this.texDefs = readAllTextures(wad);

    // The ranges nest and later entries win — docs/wad.md § Loading and merging.
    for (const l of wad.markedRange(FLAT_START, FLAT_END)) {
      if (l.size === 4096) this.flats.set(l.name, l.index);
    }
  }

  hasTexture(name: string): boolean {
    return this.texDefs.has(name.toUpperCase());
  }

  /**
   * Wall texture names in `TEXTURE1`/`TEXTURE2` definition order — vanilla's
   * own texture-index order (`r_data.c`'s `textures[]`, built by reading
   * TEXTURE1 then TEXTURE2 in lump order). `render/textureanim.ts` uses this
   * to resolve an animdef's start..end name range into the actual in-between
   * frames, the same way `P_InitPicAnims` does.
   */
  textureNamesInOrder(): string[] {
    return [...this.texDefs.keys()];
  }

  /**
   * Flat names in `F_START`..`F_END` lump order — same role as `textureNamesInOrder`, for flats.
   */
  flatNamesInOrder(): string[] {
    return [...this.flats.keys()];
  }

  /** Wall texture by name; composes the patches as described by TEXTUREx. */
  texture(name: string): Bitmap | null {
    const key = 'T:' + name.toUpperCase();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const def = this.texDefs.get(name.toUpperCase());
    let result: Bitmap | null = null;
    if (def) {
      const bmp: Bitmap = {
        width: def.width,
        height: def.height,
        data: new Uint8Array(def.width * def.height * 4),
      };
      for (const p of def.patches) {
        const lump = this.wad.find(p.patch);
        if (!lump) continue;
        try {
          blitPatch(bmp, readPatch(this.wad.reader(lump)), p, this.palette);
        } catch {
          // Skip broken patches instead of losing the whole texture.
        }
      }
      result = bmp;
    }
    this.cache.set(key, result);
    return result;
  }

  /** Flat (64x64, uncompressed) by name. */
  flat(name: string): Bitmap | null {
    const key = 'F:' + name.toUpperCase();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const idx = this.flats.get(name.toUpperCase());
    let result: Bitmap | null = null;
    if (idx !== undefined) {
      const lump = this.wad.lumpAt(idx)!;
      const src = this.wad.data(lump);
      const data = new Uint8Array(64 * 64 * 4);
      for (let i = 0; i < 4096; i++) {
        const c = src[i];
        data[i * 4] = this.palette[c * 3];
        data[i * 4 + 1] = this.palette[c * 3 + 1];
        data[i * 4 + 2] = this.palette[c * 3 + 2];
        data[i * 4 + 3] = 255;
      }
      result = { width: 64, height: 64, data };
    }
    this.cache.set(key, result);
    return result;
  }

  picture(name: string): Bitmap | null {
    const key = 'P:' + name.toUpperCase();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const result = readPicture(this.wad, name, this.palette);
    this.cache.set(key, result);
    return result;
  }
}

/** Standalone graphic (sprite, HUD element) as a bitmap. */
function readPicture(wad: Wad, name: string, pal: Uint8Array): Bitmap | null {
  const lump = wad.find(name);
  if (!lump || lump.size < 8) return null;
  try {
    const patch = readPatch(wad.reader(lump));
    const bmp: Bitmap = {
      width: patch.width,
      height: patch.height,
      data: new Uint8Array(patch.width * patch.height * 4),
      left: patch.left,
      top: patch.top,
    };
    blitPatch(bmp, patch, { originX: 0, originY: 0 }, pal);
    return bmp;
  } catch {
    return null;
  }
}

interface Patch {
  width: number;
  height: number;
  left: number;
  top: number;
  /** Posts per column. */
  columns: { top: number; pixels: Uint8Array }[][];
}

/** DOOM picture format: column-wise posts with transparent gaps. */
function readPatch(r: Reader): Patch {
  const width = r.i16();
  const height = r.i16();
  const left = r.i16();
  const top = r.i16();

  const offsets: number[] = [];
  for (let i = 0; i < width; i++) offsets.push(r.i32());

  const columns: Patch['columns'] = [];
  for (let x = 0; x < width; x++) {
    const posts: { top: number; pixels: Uint8Array }[] = [];
    r.seek(offsets[x]);
    // Tall patches (>254px) use cumulative topdelta; this handles those too.
    let lastTop = -1;
    for (;;) {
      const rawTop = r.u8();
      if (rawTop === 0xff) break;
      const length = r.u8();
      r.u8(); // padding byte before the pixels
      const pixels = r.bytes(length).slice();
      r.u8(); // padding byte after the pixels
      const yTop = rawTop <= lastTop ? lastTop + rawTop : rawTop;
      lastTop = yTop;
      posts.push({ top: yTop, pixels });
    }
    columns.push(posts);
  }

  return { width, height, left, top, columns };
}

/** Where a patch's top-left corner lands in the bitmap it is drawn into, in pixels. */
interface PatchOrigin {
  originX: number;
  originY: number;
}

/** Draws one patch into a bitmap at `origin`, skipping whatever falls outside it. */
function blitPatch(dst: Bitmap, patch: Patch, origin: PatchOrigin, pal: Uint8Array): void {
  const { originX, originY } = origin;
  for (let px = 0; px < patch.width; px++) {
    const x = originX + px;
    if (x < 0 || x >= dst.width) continue;
    for (const post of patch.columns[px]) {
      for (let i = 0; i < post.pixels.length; i++) {
        const y = originY + post.top + i;
        if (y < 0 || y >= dst.height) continue;
        const c = post.pixels[i];
        const di = (y * dst.width + x) * 4;
        dst.data[di] = pal[c * 3];
        dst.data[di + 1] = pal[c * 3 + 1];
        dst.data[di + 2] = pal[c * 3 + 2];
        dst.data[di + 3] = 255;
      }
    }
  }
}

interface TextureDef {
  name: string;
  width: number;
  height: number;
  /** Patch lump names, already resolved through the right file's PNAMES, and where each lands. */
  patches: (PatchOrigin & { patch: string })[];
}

function readPnamesLump(wad: Wad, lump: Lump): string[] {
  const r = wad.reader(lump);
  const count = r.i32();
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(r.name8());
  return out;
}

function readTextureLump(wad: Wad, lump: Lump, pnames: string[]): TextureDef[] {
  const r = wad.reader(lump);
  const count = r.i32();
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(r.i32());

  const out: TextureDef[] = [];
  for (const off of offsets) {
    r.seek(off);
    const texName = r.name8();
    r.i32(); // masked (unused)
    const width = r.i16();
    const height = r.i16();
    r.i32(); // columndirectory (unused)
    const patchCount = r.i16();
    const patches: TextureDef['patches'] = [];
    for (let i = 0; i < patchCount; i++) {
      const originX = r.i16();
      const originY = r.i16();
      const patchIndex = r.i16();
      r.i16(); // stepdir
      r.i16(); // colormap
      const patch = pnames[patchIndex];
      if (patch) patches.push({ originX, originY, patch });
    }
    out.push({ name: texName, width, height, patches });
  }
  return out;
}

/**
 * Collects TEXTURE1/TEXTURE2 from every loaded file, later definitions winning by name. Merging
 * rather than taking a PWAD's TEXTURE1 as vanilla's full replacement is a deliberate deviation, and
 * patch indices resolve through the defining file's own PNAMES here rather than being stored raw.
 * See docs/wad.md § Loading and merging.
 */
function readAllTextures(wad: Wad): Map<string, TextureDef> {
  const pnamesByFile = new Map<WadFile, string[]>();
  let latestPnames: string[] = [];
  for (const lump of wad.findAll('PNAMES')) {
    latestPnames = readPnamesLump(wad, lump);
    pnamesByFile.set(lump.source, latestPnames);
  }

  const defs = new Map<string, TextureDef>();
  for (const lump of wad.lumps) {
    if (lump.name !== 'TEXTURE1' && lump.name !== 'TEXTURE2') continue;
    // A file with textures but no PNAMES of its own borrows the last one seen; that fallback and
    // the catch below are silent by design — docs/wad.md § Art a WAD set doesn't have.
    const pnames = pnamesByFile.get(lump.source) ?? latestPnames;
    try {
      for (const def of readTextureLump(wad, lump, pnames)) defs.set(def.name, def);
    } catch {
      // A malformed TEXTUREx costs that file's textures, not the whole set.
    }
  }
  return defs;
}
