/**
 * Headless sanity check: parses a WAD set and reports what the renderer will get — the support
 * verdict, the map and node formats, the geometry, and the specials and DEHACKED coverage reports.
 * See docs/wad.md and docs/dehacked.md § The coverage report.
 *
 *   node scripts/inspect-wad.ts <iwad> [map] [pwad ...]
 *   node scripts/inspect-wad.ts public/game/iwad/DOOM.WAD E1M1
 *   node scripts/inspect-wad.ts public/game/iwad/DOOM2.WAD MAP05 public/game/pwad/SCYTHE.WAD
 */
import { readFileSync } from 'node:fs';
import { Wad, WadFile } from '../src/wad/wad.ts';
import { GraphicsBank } from '../src/wad/graphics.ts';
import { readAnimated } from '../src/wad/animated.ts';
import { readSwitches } from '../src/wad/switches.ts';
import { loadMap, NO_SIDE } from '../src/wad/map.ts';
import { bytesOf, describeWad } from '../src/wad/describe.ts';
import { describeSupport, supportLevel } from '../src/wad/support.ts';
import {
  describeDehacked,
  readDehacked,
  type DehShortfall,
  type DehWarning,
} from '../src/game/dehacked.ts';
import { titleLookupFor } from '../src/wad/campaign/names.ts';
import { classifyLineSpecial, type SpecialClass } from '../src/game/specials/tables.ts';
import { Forces } from '../src/game/specials/forces.ts';
import { Transfers } from '../src/game/specials/transfers.ts';
import { VoodooDolls } from '../src/game/voodoo.ts';
import { decodeSectorType, sectorTypeUnderstood } from '../src/game/specials/sectortypes.ts';
import { buildSubSectorPolys, sectorOfSubSector } from '../src/render/bsp.ts';
import { findSolidBlocks, findSolidCaps, pocketsOf } from '../src/render/solids.ts';
import { makeCollider, World } from '../src/game/world.ts';
import { SoundBank } from '../src/wad/sound.ts';
import { SFX_NAMES } from '../src/audio/sfx.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/game/player.ts';

function readWad(path: string): WadFile {
  const file = readFileSync(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  return new WadFile(buffer, path.split('/').pop()!);
}

const [iwadPath = 'public/game/iwad/DOOM.WAD', mapArg, ...pwadPaths] = process.argv.slice(2);

const files = [readWad(iwadPath), ...pwadPaths.map(readWad)];
const wad = new Wad(files);

for (const file of files) {
  console.log(`${file.name}: ${file.type}, ${file.entries.length} lumps, ${file.mapNames().length} maps`);
  // The same verdict the WAD Library's support column shows (docs/wad.md § Will it run?), so a
  // file's row in the menu can be reproduced here rather than guessed at.
  const { support } = await describeWad(file.name, bytesOf(file.buffer));
  if (supportLevel(support) !== 'ok') {
    const text = describeSupport(support, file.mapNames().length);
    console.log(text.split('\n').map((line) => `  ${line}`).join('\n'));
  }
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
    `  ${map.nodes.length} nodes (${map.nodeFormat}), ${map.things.length} things,\n` +
    `  ${map.format} map format` +
    (map.format === 'udmf' ? ` (namespace "${map.udmfNamespace}")` : ''),
);
console.log(`  bounds x[${map.bounds.minX}..${map.bounds.maxX}] y[${map.bounds.minY}..${map.bounds.maxY}]`);

// Textures referenced by the map must all resolve.
// Boom overloads sidedef texture names on two parameter lines: a 242 control
// line names colormaps and a 260 line can name a translucency map. Neither is a
// texture, and neither is missing art (docs/specials-transfers.md § Render transfers).
const transfers = new Transfers(map, (name) => wad.find(name)?.size ?? null);
const lineOfSide = new Map<number, number>();
for (const [i, l] of map.linedefs.entries()) {
  if (l.right !== NO_SIDE) lineOfSide.set(l.right, i);
}
const missing = new Set<string>();
for (const [i, s] of map.sidedefs.entries()) {
  const line = lineOfSide.get(i);
  const tranmapNamed = line !== undefined && transfers.midtexSuppressed(line);
  for (const [slot, t] of [
    ['upper', s.upper],
    ['lower', s.lower],
    ['middle', s.middle],
  ] as const) {
    if (t === '-' || t === '' || gfx.texture(t)) continue;
    // A 242 control line's slots name colormaps; a 260 line's middle can name
    // the translucency map. Neither is missing art.
    if (transfers.colormapName(t)) continue;
    if (slot === 'middle' && tranmapNamed) continue;
    missing.add(`wall:${t}`);
  }
}
console.log(`\nmissing textures: ${missing.size === 0 ? 'none' : [...missing].join(', ')}`);

// Boom's two table lumps, each replacing a built-in table when present.
// docs/wad.md § ANIMATED and SWITCHES.
const animated = readAnimated(wad);
const switches = readSwitches(wad);
const unknownPairs = switches?.filter((p) => !gfx.hasTexture(p.off) || !gfx.hasTexture(p.on)).length ?? 0;
console.log(
  `ANIMATED: ${animated ? `${animated.length} sequences` : 'absent (built-in table)'}` +
    `, SWITCHES: ${switches ? `${switches.length - unknownPairs} of ${switches.length} pairs usable` : 'absent (SW1/SW2 convention)'}`,
);

// Sounds: which of vanilla's sfx this set can actually play.
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

// Subsector polygons.
const polys = buildSubSectorPolys(map);
let empty = 0;
let redirected = 0;
let refiled = 0;
let minVerts = Infinity;
let maxVerts = 0;
let flatArea = 0;
for (const [ssIndex, p] of polys.entries()) {
  // Drawn as another sector than the BSP resolves: a self-referencing construct
  // or a spared wrong-side seg (docs/render-bsp.md § Segs on the wrong side of their
  // leaf) — both worth seeing when a floor draws unexpectedly.
  const bspSector = sectorOfSubSector(map, ssIndex);
  if (p.sector !== bspSector) redirected++;
  // Moved for gameplay too, not just for drawing: a leaf the node builder filed
  // under its neighbour's sector, where the player's floor was the wrong one.
  if (p.physicalSector !== bspSector) refiled++;
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
const solidCaps = findSolidCaps(map, polys);
const blocks = findSolidBlocks(map);
console.log(
  `subsector polys: ${polys.length} total, ${empty} degenerate, ${redirected} drawn as another sector` +
    `${refiled > 0 ? ` (${refiled} refiled for gameplay too)` : ''}, ${minVerts}..${maxVerts} verts,\n` +
    `  total floor area ${Math.round(flatArea).toLocaleString('en-US')} map units²,\n` +
    `  ${solidCaps.length} solid structures lidded, ${blocks.length} blocks built out of roomless sectors capped,\n` +
    `  ${pocketsOf(map, polys, [...solidCaps, ...blocks]).roofs.size} pockets in them roofed`,
);

// REJECT: how much sight this map's own table rules out up front.
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

// Player start and its surroundings.
const world = new World(map);
const start = world.playerStart();
const sector = world.sectorAt(start.x, start.y);
const floor = sector?.floorHeight ?? 0;
console.log(
  `\nplayer start: (${start.x}, ${start.y}) angle ${Math.round((start.angle * 180) / Math.PI)}°\n` +
    `  sector ${world.sectorIndexAt(start.x, start.y)} floor ${sector?.floorHeight} ceil ${sector?.ceilHeight} light ${sector?.light}`,
);
const asPlayer = makeCollider({ radius: PLAYER_RADIUS, z: floor, height: PLAYER_HEIGHT });
console.log(`  blocked at spawn: ${world.positionBlocked(start.x, start.y, asPlayer)}`);

// Walk a ring around the spawn to see whether collision behaves sanely.
let free = 0;
const steps = 36;
for (let i = 0; i < steps; i++) {
  const a = (i / steps) * Math.PI * 2;
  if (!world.positionBlocked(start.x + Math.cos(a) * 64, start.y + Math.sin(a) * 64, asPlayer)) free++;
}
console.log(`  free directions at r=64: ${free}/${steps}`);

// The always-on parameter lines: what `specials/forces.ts` found here.
{
  const forces = new Forces(map, world);
  const scrollers = forces.counts();
  const dolls = new VoodooDolls(world).dolls.length;
  console.log(
    `forces: ${scrollers.side} wall + ${scrollers.floorTex} floor + ${scrollers.ceilTex} ceiling scrollers, ` +
      `${scrollers.carry} conveyors, ${forces.frictionSectors} friction sectors, ${forces.pusherCount} pushers, ` +
      `${dolls} voodoo doll${dolls === 1 ? '' : 's'}`,
  );
}

// The render transfers: what `specials/transfers.ts` found here.
{
  const t = transfers.counts();
  const water = transfers.waterSectors();
  const surfaces = water.filter((w) => transfers.waterHeight(w.sector) !== null).length;
  const fakeFloors = transfers.fakeFloorSectors().length;
  const islands = transfers.poolIslands().length;
  console.log(
    `transfers: ${t.floorLight} floor-light + ${t.ceilingLight} ceiling-light lines, ` +
      `${t.water} fake-height lines (${water.length} sectors, ${surfaces} drawing water, ` +
      `${fakeFloors} drawn at a fake floor, ${islands} enclosed by a pool), ` +
      `${t.translucent} translucent lines`,
  );
}

// Specials coverage: which linedef/sector special numbers this engine knows.
// The acceptance gate for the Boom work: a target map "loads fully" when
// nothing lands in `unknown` (docs/specials.md § Scope).
{
  // The classification itself is `tables.ts`'s (`classifyLineSpecial`), so this
  // report can't drift out of step with what the engine actually resolves.
  // A Hexen/ZDoom action special is a different number namespace, not a `SpecialClass` — the
  // synthetic row stays local to this report rather than widening the engine's classifier.
  // A UDMF map outside the Doom-specials namespaces parks its actions the same way.
  type ReportClass = SpecialClass | 'hexen';
  const LABELS: Record<ReportClass, string> = {
    hexen: 'HEXEN/ZDOOM ACTION (unsupported, nothing dispatches these)',
    none: 'none',
    vanilla: 'vanilla',
    boom: 'boom',
    generalized: 'generalized',
    param: 'param (spawn-time)',
    noop: 'no-op here (nothing this renderer draws)',
    unknown: 'UNKNOWN',
  };
  const lineClasses = new Map<ReportClass, Map<number, number>>();
  for (const line of map.linedefs) {
    // A Hexen map's action specials live in `LineDef.action` and never reach
    // `classifyLineSpecial`, so they would otherwise pass as "no specials".
    const action = line.action;
    const cls: ReportClass = action && action.special !== 0 ? 'hexen' : classifyLineSpecial(line.special);
    if (cls === 'none') continue;
    const special = cls === 'hexen' ? action!.special : line.special;
    const bucket = lineClasses.get(cls) ?? new Map<number, number>();
    bucket.set(special, (bucket.get(special) ?? 0) + 1);
    lineClasses.set(cls, bucket);
  }
  console.log('\nlinedef specials:');
  for (const cls of ['vanilla', 'boom', 'generalized', 'param', 'noop', 'hexen', 'unknown'] as const) {
    const bucket = lineClasses.get(cls);
    if (!bucket) continue;
    const total = [...bucket.values()].reduce((a, b) => a + b, 0);
    const numbers = [...bucket.keys()].sort((a, b) => a - b);
    const list = cls === 'vanilla' ? '' : ` — ${numbers.map((n) => (n >= 0x2f80 ? '0x' + n.toString(16) : n)).join(' ')}`;
    console.log(`  ${LABELS[cls]}: ${total} lines, ${bucket.size} distinct${list}`);
  }

  const sectorUnknown = new Map<number, number>();
  let sectorSpecials = 0;
  for (const sector of map.sectors) {
    if (sector.special === 0) continue;
    sectorSpecials++;
    if (!sectorTypeUnderstood(decodeSectorType(sector.special))) {
      sectorUnknown.set(sector.special, (sectorUnknown.get(sector.special) ?? 0) + 1);
    }
  }
  const unknownList = [...sectorUnknown.keys()].sort((a, b) => a - b).join(' ');
  console.log(
    `sector specials: ${sectorSpecials} non-zero` +
      (sectorUnknown.size > 0 ? `, UNKNOWN: ${unknownList}` : ', all understood'),
  );
}

// DEHACKED coverage: what a patch in this set asks for, and how far each ask gets.
{
  const patch = readDehacked(wad, titleLookupFor());
  if (!patch) {
    console.log('\nDEHACKED: no lump in this set');
  } else {
    const LABELS: Record<DehShortfall, string> = {
      noTarget: 'no target here (nothing this engine has)',
      unsupported: 'UNSUPPORTED (deliberately out of scope)',
      unknown: 'UNKNOWN',
    };
    const { files, applied, states } = describeDehacked(patch);
    console.log(`\n${applied || `DEHACKED (${files}): nothing applied`}`);
    if (states) console.log(`  ${states}`);

    const byClass = new Map<DehShortfall, DehWarning[]>();
    for (const w of patch.warnings) {
      const rows = byClass.get(w.support) ?? [];
      if (rows.length === 0) byClass.set(w.support, rows);
      rows.push(w);
    }
    for (const cls of ['unknown', 'unsupported', 'noTarget'] as const) {
      const rows = byClass.get(cls);
      if (!rows) continue;
      const total = rows.reduce((a, w) => a + w.count, 0);
      console.log(`  ${LABELS[cls]}: ${total} across ${rows.length} distinct`);
      for (const w of rows) {
        const where = w.field ? `${w.record}/${w.field}` : w.record;
        console.log(`    ${where} x${w.count} — ${w.detail}`);
      }
    }
  }
}
