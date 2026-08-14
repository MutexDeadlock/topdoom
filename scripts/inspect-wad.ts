/**
 * Headless sanity check: parses a WAD set and reports what the renderer will get.
 *
 *   node scripts/inspect-wad.ts <iwad> [map] [pwad ...]
 *   node scripts/inspect-wad.ts public/wads/DOOM.WAD E1M1
 *   node scripts/inspect-wad.ts public/wads/DOOM2.WAD MAP01 ~/wads/scythe.wad
 */
import { readFileSync } from 'node:fs';
import { Wad, WadFile } from '../src/wad/wad.ts';
import { GraphicsBank } from '../src/wad/graphics.ts';
import { loadMap } from '../src/wad/map.ts';
import { buildSubSectorPolys } from '../src/render/bsp.ts';
import { World, positionBlocked } from '../src/game/world.ts';
import { SoundBank } from '../src/wad/sound.ts';
import { SFX_NAMES } from '../src/audio/sfx.ts';
import { PLAYER_RADIUS } from '../src/game/player.ts';

function readWad(path: string): WadFile {
  const file = readFileSync(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  return new WadFile(buffer, path.split('/').pop()!);
}

const [iwadPath = 'public/wads/iwad/DOOM.WAD', mapArg, ...pwadPaths] = process.argv.slice(2);

const files = [readWad(iwadPath), ...pwadPaths.map(readWad)];
const wad = new Wad(files);

for (const file of files) {
  console.log(`${file.name}: ${file.type}, ${file.entries.length} lumps, ${file.mapNames().length} maps`);
}

const allMaps = wad.mapNames();
const mapName = (mapArg ?? allMaps[0]).toUpperCase();
console.log(`merged: ${wad.lumps.length} lumps, ${allMaps.length} maps`);
console.log(`maps: ${allMaps.slice(0, 8).join(' ')}${allMaps.length > 8 ? ' …' : ''}`);

const gfx = new GraphicsBank(wad);
const map = loadMap(wad, mapName);
console.log(
  `\n${mapName} (from ${wad.providerOf(mapName)?.name}): ${map.vertexes.length} verts, ` +
    `${map.linedefs.length} lines, ${map.sidedefs.length} sides,\n` +
    `  ${map.sectors.length} sectors, ${map.segs.length} segs, ${map.subsectors.length} subsectors,\n` +
    `  ${map.nodes.length} nodes, ${map.things.length} things`,
);
console.log(`  bounds x[${map.bounds.minX}..${map.bounds.maxX}] y[${map.bounds.minY}..${map.bounds.maxY}]`);

// --- textures referenced by the map must all resolve ---
const missing = new Set<string>();
for (const s of map.sidedefs) {
  for (const t of [s.upper, s.lower, s.middle]) {
    if (t !== '-' && t !== '' && !gfx.texture(t)) missing.add(`wall:${t}`);
  }
}
for (const s of map.sectors) {
  for (const t of [s.floorTex, s.ceilTex]) {
    if (t !== 'F_SKY1' && t !== '-' && t !== '' && !gfx.flat(t)) missing.add(`flat:${t}`);
  }
}
console.log(`\nmissing textures: ${missing.size === 0 ? 'none' : [...missing].join(', ')}`);

// --- sounds: which of vanilla's sfx this set can actually play ---
// A missing lump is silent rather than substituted (see SoundBank), so this is
// the way to tell a WAD set that simply has fewer sounds (shareware DOOM1.WAD
// carries 49 of the 108) from a decoding bug.
const bank = new SoundBank(wad);
const encoded = bank.encodedNames(SFX_NAMES);
const missingSounds = SFX_NAMES.filter((n) => !bank.has(n));
let pcmSounds = 0;
let sampleSeconds = 0;
for (const name of SFX_NAMES) {
  const lump = bank.get(name);
  if (lump?.kind !== 'pcm') continue;
  pcmSounds++;
  sampleSeconds += lump.samples.length / lump.sampleRate;
}
console.log(
  `sounds: ${pcmSounds} DMX (${sampleSeconds.toFixed(1)}s total)` +
    `${encoded.length > 0 ? `, ${encoded.length} in a browser container (${encoded.join(' ')})` : ''}` +
    `, ${missingSounds.length} of ${SFX_NAMES.length} absent` +
    `${missingSounds.length > 0 ? `: ${missingSounds.join(' ')}` : ''}`,
);

// --- subsector polygons ---
const polys = buildSubSectorPolys(map);
let empty = 0;
let minVerts = Infinity;
let maxVerts = 0;
let flatArea = 0;
for (const p of polys) {
  const n = p.points.length / 2;
  if (n < 3) {
    empty++;
    continue;
  }
  minVerts = Math.min(minVerts, n);
  maxVerts = Math.max(maxVerts, n);
  for (let i = 1; i < n - 1; i++) {
    const ax = p.points[0];
    const ay = p.points[1];
    const bx = p.points[i * 2];
    const by = p.points[i * 2 + 1];
    const cx = p.points[(i + 1) * 2];
    const cy = p.points[(i + 1) * 2 + 1];
    flatArea += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
}
console.log(
  `subsector polys: ${polys.length} total, ${empty} degenerate, ${minVerts}..${maxVerts} verts,\n` +
    `  total floor area ${Math.round(flatArea).toLocaleString('en-US')} map units²`,
);

// --- REJECT: how much sight this map's own table rules out up front ---
// Absent/short/all-zero all arrive here as undefined; see docs/wad.md § REJECT.
if (!map.reject) {
  console.log(`\nREJECT: none usable (absent, short, or all-zero) — every sight check traces`);
} else {
  let set = 0;
  for (const byte of map.reject) {
    for (let bit = byte; bit !== 0; bit >>= 1) set += bit & 1;
  }
  const pairs = map.sectors.length * map.sectors.length;
  console.log(`\nREJECT: ${map.reject.length}B, ${((set / pairs) * 100).toFixed(1)}% of sector pairs blind`);
}

// --- player start and its surroundings ---
const world = new World(map);
const start = world.playerStart();
const sector = world.sectorAt(start.x, start.y);
const floor = sector?.floorHeight ?? 0;
console.log(
  `\nplayer start: (${start.x}, ${start.y}) angle ${Math.round((start.angle * 180) / Math.PI)}°\n` +
    `  sector ${world.sectorIndexAt(start.x, start.y)} floor ${sector?.floorHeight} ceil ${sector?.ceilHeight} light ${sector?.light}`,
);
console.log(`  blocked at spawn: ${positionBlocked(world, start.x, start.y, PLAYER_RADIUS, floor)}`);

// Walk a ring around the spawn to see whether collision behaves sanely.
let free = 0;
const steps = 36;
for (let i = 0; i < steps; i++) {
  const a = (i / steps) * Math.PI * 2;
  if (!positionBlocked(world, start.x + Math.cos(a) * 64, start.y + Math.sin(a) * 64, PLAYER_RADIUS, floor)) free++;
}
console.log(`  free directions at r=64: ${free}/${steps}`);
