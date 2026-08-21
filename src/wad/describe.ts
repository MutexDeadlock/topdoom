/**
 * What a WAD *is*, read from as few of its bytes as possible: type, maps, lump count, whether it
 * carries a DEHACKED patch, and the level titles it names. The one implementation behind all three
 * callers that need this without loading the file into the engine — the build-time manifest, an
 * uploaded file, and a scan of the player's own library folder.
 * See docs/wad.md § Describing a file without loading it.
 */
import { Reader } from './reader.ts';
import { MAP_MARKER, type WadType } from './wad.ts';
import { MAPINFO_LUMPS, parseMapInfoNames, preferredMapInfoLump } from './campaign/mapinfo.ts';
import { mergeLevelTitles, titleLookupFor } from './campaign/names.ts';
import { parseDehacked } from '../game/dehacked.ts';

/**
 * A file's bytes, addressable by range. Deliberately not "an ArrayBuffer": a library scan reads
 * hundreds of files it will never load, and `describeWad` touches only the header, the directory
 * and two lumps — a few hundred KB even for a 14 MB IWAD — so the source must be able to serve a
 * slice without materializing the whole file. A `File` does this natively (`slice().arrayBuffer()`),
 * `bytesOf` below wraps a buffer that is already in memory.
 */
export interface ByteRanges {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Everything the menu shows about a WAD it has not loaded. */
export interface WadDescription {
  type: WadType;
  /** Map markers the file defines, in directory order. */
  maps: string[];
  /** Total lump count — shown for map-less add-ons so they don't look empty. */
  lumpCount: number;
  /** Whether the file carries a `DEHACKED` lump. Presence only — docs/dehacked.md § The coverage report. */
  dehacked: boolean;
  /** Each map's title: its MAPINFO's, and where that names nothing, its DEHACKED patch's. */
  levelNames: Record<string, string>;
}

const HEADER_BYTES = 12;
const DIRECTORY_ENTRY_BYTES = 16;

/** Text lumps are 8-bit, the same as every other string a WAD carries. */
const DECODER = new TextDecoder('latin1');

/** `ByteRanges` over bytes already in memory — the manifest plugin's file and an upload's buffer. */
export function bytesOf(buffer: ArrayBufferLike | Uint8Array): ByteRanges {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return {
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

/** `ByteRanges` over a `File`, which reads a slice off disk without pulling the rest in. */
export function bytesOfFile(file: Blob): ByteRanges {
  return {
    size: file.size,
    read: async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

/**
 * Describes one WAD. Throws on anything that isn't one, with the same messages `WadFile`'s
 * constructor uses — an upload turns them into the menu's status line, the manifest plugin turns
 * them into "this file doesn't show up".
 *
 * `name` is the file's own name, not a label: `mergeLevelTitles` projects the mission from it, so
 * `plutonia.wad` resolves its `PHUSTR_*` strings (docs/wad.md § Level names).
 */
export async function describeWad(name: string, src: ByteRanges): Promise<WadDescription> {
  if (src.size < HEADER_BYTES) throw new Error(`${name}: not a WAD file (only ${src.size} bytes)`);

  const header = reader(await src.read(0, HEADER_BYTES));
  const ident = String.fromCharCode(header.u8(), header.u8(), header.u8(), header.u8());
  if (ident !== 'IWAD' && ident !== 'PWAD') {
    throw new Error(`${name}: not a WAD file (signature "${ident}")`);
  }
  const lumpCount = header.i32();
  const dirOffset = header.i32();
  if (dirOffset < 0 || lumpCount < 0 || dirOffset + lumpCount * DIRECTORY_ENTRY_BYTES > src.size) {
    throw new Error(`${name}: WAD directory is out of bounds`);
  }

  const maps: string[] = [];
  const dehLumps: Entry[] = [];
  const mapInfoLumps = new Map<string, Entry>();
  const dir = reader(await src.read(dirOffset, lumpCount * DIRECTORY_ENTRY_BYTES));
  for (let i = 0; i < lumpCount; i++) {
    const offset = dir.i32();
    const size = dir.i32();
    const lump = dir.name8();
    if (MAP_MARKER.test(lump)) maps.push(lump);
    else if (lump === 'DEHACKED') dehLumps.push({ offset, size });
    // Last one wins within a file, matching the merged directory.
    else if (MAPINFO_LUMPS.includes(lump)) mapInfoLumps.set(lump, { offset, size });
  }

  // Exactly one MAPINFO lump per file, chosen by `preferredMapInfoLump` — the menu's titles and
  // the in-game ones come from the same rule, or a WAD shipping two flavours gets two names.
  const wanted = preferredMapInfoLump([...mapInfoLumps.keys()]);
  // The directory says where all of these are, and none of them depends on another — so they go out
  // together. Over a library scan that is the difference between one round trip per lump and one
  // per file, on the one wait the player watches (`disk.ts: describeAll`).
  const [mapInfoText, dehBodies] = await Promise.all([
    wanted ? text(src, mapInfoLumps.get(wanted)!) : Promise.resolve(null),
    Promise.all(dehLumps.map((lump) => text(src, lump))),
  ]);
  const mapInfoTitles = mapInfoText === null ? [] : parseMapInfoNames(mapInfoText);

  // Every `DEHACKED` lump in the file, merged in directory order — DEH patches are cumulative,
  // which is the rule `readDehacked` applies across the whole set (docs/wad.md § DEHACKED).
  const strings = new Map<string, string>();
  if (dehBodies.length > 0) {
    const titles = titleLookupFor();
    for (const body of dehBodies) {
      if (body === null) continue;
      for (const [key, title] of parseDehacked(body, titles).strings) strings.set(key, title);
    }
  }

  return {
    type: ident,
    maps,
    lumpCount,
    dehacked: dehLumps.length > 0,
    // `mergeLevelTitles` owns the MAPINFO-then-DEHACKED order, so the same file cannot list
    // differently uploaded, served, or found in the player's library.
    levelNames: mergeLevelTitles(name, mapInfoTitles, strings),
  };
}

interface Entry {
  offset: number;
  size: number;
}

/** A lump's text, or null when its directory entry points outside the file. */
async function text(src: ByteRanges, lump: Entry): Promise<string | null> {
  if (lump.offset < 0 || lump.size < 0 || lump.offset + lump.size > src.size) return null;
  return DECODER.decode(await src.read(lump.offset, lump.size));
}

/** `Reader` over a slice, which may be a view into a larger buffer. */
function reader(bytes: Uint8Array): Reader {
  return new Reader(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
