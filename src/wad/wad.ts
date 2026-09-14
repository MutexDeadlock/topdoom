/**
 * {@link WadFile} (one physical .wad: header + directory + bytes) and {@link Wad} (the merged lump
 * directory over an IWAD and its PWADs, later files overriding earlier). See docs/wad.md.
 */
import { Reader } from './reader.ts';

export type WadType = 'IWAD' | 'PWAD';

export interface Lump {
  name: string;
  offset: number;
  size: number;
  /** Index in the merged directory; needed to find a map's lumps by their order. */
  index: number;
  /** File the bytes actually live in. */
  source: WadFile;
}

interface Entry {
  name: string;
  offset: number;
  size: number;
}

/** One physical .wad file: its header, its directory and its bytes. */
export class WadFile {
  readonly type: WadType;
  readonly name: string;
  readonly buffer: ArrayBuffer;
  readonly entries: Entry[] = [];

  constructor(buffer: ArrayBuffer, name = 'wad') {
    this.buffer = buffer;
    this.name = name;

    const r = new Reader(buffer);
    const ident = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
    if (ident !== 'IWAD' && ident !== 'PWAD') {
      throw new Error(`${name}: not a WAD file (signature "${ident}")`);
    }
    this.type = ident;

    const numLumps = r.i32();
    const dirOffset = r.i32();
    if (dirOffset < 0 || dirOffset + numLumps * 16 > buffer.byteLength) {
      throw new Error(`${name}: WAD directory is out of bounds`);
    }
    r.seek(dirOffset);

    for (let i = 0; i < numLumps; i++) {
      const offset = r.i32();
      const size = r.i32();
      const lumpName = r.name8();
      this.entries.push({ name: lumpName, offset, size });
    }
  }

  /** Map markers this file provides, in directory order. */
  mapNames(): string[] {
    return this.entries.filter((e) => MAP_MARKER.test(e.name)).map((e) => e.name);
  }
}

/** What a map lump marker looks like. Exported so `describe.ts` finds maps by the same rule. */
export const MAP_MARKER = /^(E\dM\d|MAP\d\d)$/;

/**
 * The merged lump directory the rest of the engine reads from. Files are
 * concatenated in load order and later ones win on name collisions, which is
 * exactly how a PWAD replaces an IWAD's maps, textures or sprites.
 */
export class Wad {
  readonly files: WadFile[];
  readonly lumps: Lump[] = [];
  private byName = new Map<string, Lump>();

  constructor(files: WadFile | WadFile[]) {
    this.files = Array.isArray(files) ? files : [files];

    for (const file of this.files) {
      for (const entry of file.entries) {
        const lump: Lump = {
          name: entry.name,
          offset: entry.offset,
          size: entry.size,
          index: this.lumps.length,
          source: file,
        };
        this.lumps.push(lump);
        this.byName.set(lump.name, lump);
      }
    }
  }

  find(name: string): Lump | undefined {
    return this.byName.get(name.toUpperCase());
  }

  /** Every lump with this name, in load order — one per file that defines it. */
  findAll(name: string): Lump[] {
    const upper = name.toUpperCase();
    return this.lumps.filter((l) => l.name === upper);
  }

  lumpAt(index: number): Lump | undefined {
    return this.lumps[index];
  }

  data(lump: Lump): Uint8Array {
    return new Uint8Array(lump.source.buffer, lump.offset, lump.size);
  }

  reader(lump: Lump): Reader {
    return new Reader(lump.source.buffer, lump.offset, lump.size);
  }

  /**
   * Lumps inside marker ranges such as F_START..F_END. Ranges nest (F1_START
   * sits inside F_START) and each loaded file may open its own, so this counts
   * depth rather than taking the span between the first and last marker.
   */
  markedRange(start: RegExp, end: RegExp): Lump[] {
    const out: Lump[] = [];
    let depth = 0;
    for (const lump of this.lumps) {
      if (start.test(lump.name)) {
        depth++;
      } else if (end.test(lump.name)) {
        depth = Math.max(0, depth - 1);
      } else if (depth > 0) {
        out.push(lump);
      }
    }
    return out;
  }

  /**
   * All map markers in load order. A map defined by several files appears once,
   * at the position of its first definition, but resolves to the last one.
   */
  mapNames(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const lump of this.lumps) {
      if (MAP_MARKER.test(lump.name) && !seen.has(lump.name)) {
        seen.add(lump.name);
        out.push(lump.name);
      }
    }
    return out;
  }

  /** Which file provides the given map, for display in the menu. */
  providerOf(mapName: string): WadFile | undefined {
    return this.find(mapName)?.source;
  }
}
