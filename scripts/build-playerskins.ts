/**
 * Builds `public/game/playerskins.wad` from the WeaponMatchingPlayerSkin pack's PNGs — the art the
 * player's billboard draws for the weapon in hand. Only the frames this engine animates are
 * converted: `A`-`N`, no xdeath (`O`-`W`) and no crouch set (`PL1C`…`PL9C`).
 * See docs/sprites.md § Weapon-matching player sprites.
 *
 *   node scripts/build-playerskins.ts <sprites-dir> [iwad] [out]
 *   node scripts/build-playerskins.ts "~/WeaponMatchingPlayerSkin 1.1.pk3_FILES/Sprites"
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { GraphicsBank, readPalette } from '../src/wad/graphics.ts';
import { SKIN_FLAT_FRAMES, SKIN_ROTATED_FRAMES } from '../src/wad/playerskin.ts';
import { SpriteBank } from '../src/wad/sprites.ts';
import { Wad, WadFile } from '../src/wad/wad.ts';

/** Lump names to convert: the pack's own `SSSSFR`/`SSSSFRfr` names, frames `A`-`N` only. */
const WANTED = /^(PLA[1-9][A-N][0-8]([A-N][0-8])?)\.png$/i;

const [spritesDir, iwadPath = 'public/wads/iwad/DOOM2.WAD', outPath = 'public/game/playerskins.wad'] =
  process.argv.slice(2);

if (!spritesDir) {
  console.error('usage: node scripts/build-playerskins.ts <sprites-dir> [iwad] [out]');
  process.exit(1);
}

// ---------------------------------------------------------------- PNG decoding

interface Image {
  width: number;
  height: number;
  /** The patch hotspot, from the PNG's `grAb` chunk. */
  left: number;
  top: number;
  /** RGBA, row 0 = top. */
  data: Uint8Array;
}

/**
 * The subset of PNG the pack actually uses: 8-bit non-interlaced truecolour, indexed or greyscale,
 * with the ZDoom `grAb` chunk carrying the sprite offsets. Anything else is rejected by name — a
 * half-decoded sprite would ship as wrong art rather than as an error.
 */
function decodePng(bytes: Buffer, what: string): Image {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) throw new Error(`${what}: not a PNG`);

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let grab: { x: number; y: number } | null = null;
  let palette: Buffer | null = null;
  let alpha: Buffer | null = null;
  const idat: Buffer[] = [];

  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (depth !== 8) throw new Error(`${what}: bit depth ${depth}, only 8 is supported`);
      if (data[12] !== 0) throw new Error(`${what}: interlaced PNGs are not supported`);
    } else if (type === 'grAb') {
      grab = { x: data.readInt32BE(0), y: data.readInt32BE(4) };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      alpha = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${what}: colour type ${colorType} is not supported`);
  if (colorType === 3 && !palette) throw new Error(`${what}: indexed PNG with no PLTE`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) throw new Error(`${what}: unknown row filter ${filter}`);
    }
    line.copy(rows, y * stride);
    prev = line;
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (colorType === 3) {
      const index = rows[src];
      r = palette![index * 3];
      g = palette![index * 3 + 1];
      b = palette![index * 3 + 2];
      if (alpha && index < alpha.length) a = alpha[index];
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = rows[src];
      if (colorType === 4) a = rows[src + 1];
    } else {
      r = rows[src];
      g = rows[src + 1];
      b = rows[src + 2];
      if (colorType === 6) a = rows[src + 3];
    }
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }

  // A missing hotspot would centre the sprite on its own bounding box, which is a silent
  // half-pixel-off billboard rather than an error — so it is reported, not assumed away.
  if (!grab) console.warn(`${what}: no grAb chunk, falling back to a centred hotspot`);
  return { width, height, left: grab ? grab.x : width >> 1, top: grab ? grab.y : height, data };
}

// -------------------------------------------------------------- patch encoding

/**
 * The DOOM picture format `wad/graphics.ts: readPatch` reads back: column offsets, then per column
 * a chain of `topdelta`/`length`/pad/pixels/pad posts closed by `0xff`. The pad bytes repeat the
 * post's edge pixels, as every vanilla lump does — this engine's reader skips them, other tools
 * read them. `palette` is packed RGB to palette index — `paletteIndex` below.
 */
function encodePatch(image: Image, palette: Map<number, number>, what: string): Buffer {
  if (image.height >= 254) throw new Error(`${what}: ${image.height}px tall, past the post format's 254`);
  const columns: { top: number; pixels: number[] }[][] = [];
  for (let x = 0; x < image.width; x++) {
    const posts: { top: number; pixels: number[] }[] = [];
    let y = 0;
    while (y < image.height) {
      while (y < image.height && image.data[(y * image.width + x) * 4 + 3] < 128) y++;
      if (y >= image.height) break;
      const top = y;
      const pixels: number[] = [];
      while (y < image.height && image.data[(y * image.width + x) * 4 + 3] >= 128 && pixels.length < 254) {
        const at = (y * image.width + x) * 4;
        const r = image.data[at];
        const g = image.data[at + 1];
        const b = image.data[at + 2];
        const index = palette.get((r << 16) | (g << 8) | b);
        // The pack's art is exact PLAYPAL, so a miss means the wrong IWAD or a re-encoded pack.
        // Guessing the nearest colour here would ship visibly wrong art with no warning.
        if (index === undefined) {
          throw new Error(`${what}: rgb(${r},${g},${b}) at ${x},${y} is not in ${iwadPath}'s PLAYPAL`);
        }
        pixels.push(index);
        y++;
      }
      posts.push({ top, pixels });
    }
    columns.push(posts);
  }

  let size = 8 + 4 * image.width;
  for (const posts of columns) {
    for (const post of posts) size += 4 + post.pixels.length;
    size += 1;
  }

  const out = Buffer.alloc(size);
  out.writeInt16LE(image.width, 0);
  out.writeInt16LE(image.height, 2);
  out.writeInt16LE(image.left, 4);
  out.writeInt16LE(image.top, 6);
  let at = 8 + 4 * image.width;
  for (let x = 0; x < image.width; x++) {
    out.writeInt32LE(at, 8 + 4 * x);
    for (const post of columns[x]) {
      out[at++] = post.top;
      out[at++] = post.pixels.length;
      out[at++] = post.pixels[0];
      for (const pixel of post.pixels) out[at++] = pixel;
      out[at++] = post.pixels[post.pixels.length - 1];
    }
    out[at++] = 0xff;
  }
  return out;
}

// ------------------------------------------------------------------- the build

function wadFileOf(path: string): WadFile {
  const file = readFileSync(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  return new WadFile(buffer, path.split('/').pop()!);
}

const palette = readPalette(new Wad(wadFileOf(iwadPath)));
/** Packed RGB to palette index, the lowest index winning PLAYPAL's duplicate colours. */
const paletteIndex = new Map<number, number>();
for (let i = 255; i >= 0; i--) {
  paletteIndex.set((palette[i * 3] << 16) | (palette[i * 3 + 1] << 8) | palette[i * 3 + 2], i);
}

const sources: { name: string; path: string }[] = [];
for (const entry of readdirSync(spritesDir)) {
  const path = join(spritesDir, entry);
  if (!statSync(path).isDirectory()) continue;
  for (const file of readdirSync(path)) {
    const match = WANTED.exec(file);
    if (match) sources.push({ name: match[1].toUpperCase(), path: join(path, file) });
  }
}
sources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
if (sources.length === 0) throw new Error(`no PLA?[A-N] sprites under ${spritesDir}`);

const lumps: { name: string; bytes: Buffer }[] = [{ name: 'S_START', bytes: Buffer.alloc(0) }];
const perWeapon = new Map<string, number>();
for (const source of sources) {
  const image = decodePng(readFileSync(source.path), source.name);
  const bytes = encodePatch(image, paletteIndex, source.name);
  lumps.push({ name: source.name, bytes });
  perWeapon.set(source.name.slice(0, 4), (perWeapon.get(source.name.slice(0, 4)) ?? 0) + 1);
}
lumps.push({ name: 'S_END', bytes: Buffer.alloc(0) });

const body = lumps.reduce((sum, lump) => sum + lump.bytes.length, 0);
const out = Buffer.alloc(12 + body + lumps.length * 16);
out.write('PWAD', 0, 'latin1');
out.writeInt32LE(lumps.length, 4);
out.writeInt32LE(12 + body, 8);
let offset = 12;
let dir = 12 + body;
for (const lump of lumps) {
  lump.bytes.copy(out, offset);
  out.writeInt32LE(lump.bytes.length ? offset : 12, dir);
  out.writeInt32LE(lump.bytes.length, dir + 4);
  out.write(lump.name.padEnd(8, '\0'), dir + 8, 8, 'latin1');
  offset += lump.bytes.length;
  dir += 16;
}

// The same read path the game takes, before anything is written: a file that cannot resolve every
// frame the player animates is not worth shipping.
const skinWad = new Wad(new WadFile(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer, 'playerskins.wad'));
const bank = new SpriteBank(skinWad);
const gfx = new GraphicsBank(skinWad, palette);
for (const [sprite] of perWeapon) {
  for (const letter of SKIN_ROTATED_FRAMES) {
    for (let digit = 1; digit <= 8; digit++) {
      const frame = bank.lookup(sprite, letter, digit);
      if (!frame) throw new Error(`${sprite}${letter}: rotation ${digit} is missing`);
      if (!gfx.picture(frame.lump)) throw new Error(`${frame.lump}: does not decode`);
    }
  }
  for (const letter of SKIN_FLAT_FRAMES) {
    const frame = bank.lookup(sprite, letter, 1);
    if (!frame) throw new Error(`${sprite}${letter}: missing`);
    if (!gfx.picture(frame.lump)) throw new Error(`${frame.lump}: does not decode`);
  }
}

writeFileSync(outPath, out);
for (const [sprite, count] of [...perWeapon].sort()) console.log(`  ${sprite}  ${count} lumps`);
console.log(`${outPath}: ${lumps.length} lumps, ${out.length} bytes`);
