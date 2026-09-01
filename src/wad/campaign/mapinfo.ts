/**
 * Parses the MAPINFO lump family (UMAPINFO/ZMAPINFO/MAPINFO) for what a WAD set says about its own
 * levels: titles, where each exit leads, which track plays. `MapInfo` reads the set's lumps once
 * and the three consumers in this directory project it. See docs/wad.md § Level names.
 */
import type { Wad, WadFile } from '../wad.ts';
import { decodeTextLump, stripComments } from '../textlump.ts';

/**
 * What one `map` entry in a MAPINFO-family lump tells this engine. Every field is optional: most
 * entries define only a name.
 */
export interface MapInfoEntry {
  /** The level's own title — see `parseMapInfo`'s list of the syntaxes that carry one. */
  title?: string;
  /** Where the normal exit leads (`next`), as a map lump name — or `MAPINFO_END` for a finale. */
  next?: string;
  /** Where the secret exit leads — `secretnext` (ZDoom) or `nextsecret` (UMAPINFO). */
  secretNext?: string;
  /**
   * The `D_*` lump this level's music comes from, replacing the vanilla per-map choice
   * (docs/music.md § Which track a level plays).
   */
  music?: string;
}

/**
 * The lump names carrying level definitions, **most preferred first**: a file shipping several
 * means them as alternatives for different engines, so only the first is read. One reader parses
 * all three. See docs/wad.md § Level names.
 */
export const MAPINFO_LUMPS = ['UMAPINFO', 'ZMAPINFO', 'MAPINFO'];

/**
 * The `next`/`secretNext` value meaning "the campaign ends here" rather than naming a level — every
 * finale keyword of both syntaxes reads as this one value (docs/wad.md § Level progression). No map
 * can collide with it: `@` is not a character a lump name carries.
 */
export const MAPINFO_END = '@END';

/** The one MAPINFO-family lump to read out of a file, given every such lump name it carries. */
export function preferredMapInfoLump(present: readonly string[]): string | null {
  return MAPINFO_LUMPS.find((name) => present.includes(name)) ?? null;
}

/** Just the titles out of `parseMapInfo` — what the menu's map list and `LevelNames` want. */
export function parseMapInfoNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const [map, entry] of parseMapInfo(text)) {
    if (entry.title !== undefined) names.set(map, entry.title);
  }
  return names;
}

/**
 * What a loaded WAD set's MAPINFO lumps say about its levels, read once on construction and
 * projected for the three consumers rather than re-parsed per consumer. Built once per `Game`:
 * which lumps apply depends on the file set, not on which map is loaded. docs/wad.md § Level names.
 */
export class MapInfo {
  private entries: Map<string, MapInfoEntry>;

  constructor(wad: Wad) {
    this.entries = readEntries(wad);
  }

  /**
   * What the set defines for one map, or undefined for a map no file names. Keys are upper-case.
   */
  entry(mapName: string): MapInfoEntry | undefined {
    return this.entries.get(mapName);
  }

  /** The map-name → title projection — see `parseMapInfoNames`. */
  titles(): Map<string, string> {
    return this.project((entry) => entry.title);
  }

  /** The map-name → `D_*` lump projection — docs/music.md § Which track a level plays. */
  music(): Map<string, string> {
    return this.project((entry) => entry.music);
  }

  private project(field: (entry: MapInfoEntry) => string | undefined): Map<string, string> {
    const picked = new Map<string, string>();
    for (const [map, entry] of this.entries) {
      const value = field(entry);
      if (value !== undefined) picked.set(map, value);
    }
    return picked;
  }
}

/**
 * Every `map` entry the loaded WAD set defines: one lump per file (`MAPINFO_LUMPS`), files in load
 * order, a later file's entry replacing an earlier one outright rather than merging field by field.
 * See docs/wad.md § Level names.
 */
function readEntries(wad: Wad): Map<string, MapInfoEntry> {
  // Keyed by source file, in first-appearance order, which is load order.
  const perFile = new Map<WadFile, string[]>();
  for (const lump of wad.lumps) {
    if (!MAPINFO_LUMPS.includes(lump.name)) continue;
    const seen = perFile.get(lump.source);
    if (seen) seen.push(lump.name);
    else perFile.set(lump.source, [lump.name]);
  }

  const maps = new Map<string, MapInfoEntry>();
  for (const [file, present] of perFile) {
    const wanted = preferredMapInfoLump(present);
    const lump = wad.lumps.find((l) => l.source === file && l.name === wanted);
    if (!lump) continue;
    for (const [map, entry] of parseMapInfo(decodeTextLump(wad.data(lump)))) maps.set(map, entry);
  }
  return maps;
}

type Token = { text: string; quoted: boolean };

/** Quoted strings, braces and `=` as tokens of their own; everything else splits on whitespace. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      tokens.push({ text: text.slice(i + 1, end < 0 ? text.length : end), quoted: true });
      i = end < 0 ? text.length : end + 1;
    } else if (ch === '{' || ch === '}' || ch === '=' || ch === ',') {
      tokens.push({ text: ch, quoted: false });
      i++;
    } else {
      let end = i;
      while (end < text.length && !/[\s{}=,"]/.test(text[end])) end++;
      tokens.push({ text: text.slice(i, end), quoted: false });
      i = end;
    }
  }
  return tokens;
}

/** `map01` → `MAP01`, and Hexen-format MAPINFO's bare `map 1` / `map 01` → `MAP01`. */
function normalizeMapName(name: string): string {
  if (/^\d{1,2}$/.test(name)) return `MAP${name.padStart(2, '0')}`;
  return name.toUpperCase();
}

/**
 * The property keys `parseMapInfo` reads: each maps onto its `MapInfoEntry` field through its own
 * value normalizer. One table for both syntax walkers below, so a new key can't end up read in the
 * block form but forgotten in the brace-less one.
 */
const PROPERTY_KEYS: Record<
  string,
  { field: 'next' | 'secretNext' | 'music'; value: (token: Token | undefined) => string | undefined }
> = {
  next: { field: 'next', value: exitValue },
  secretnext: { field: 'secretNext', value: exitValue },
  nextsecret: { field: 'secretNext', value: exitValue },
  music: { field: 'music', value: musicValue },
  endgame: { field: 'next', value: endValue },
  endpic: { field: 'next', value: endValue },
  endbunny: { field: 'next', value: endValue },
  endcast: { field: 'next', value: endValue },
};

/** One `PROPERTY_KEYS` read at `keyIndex`, applied to `entry` — shared by both syntax walkers. */
function readProperty(entry: MapInfoEntry, tokens: Token[], keyIndex: number): void {
  const prop = PROPERTY_KEYS[tokens[keyIndex].text.toLowerCase()];
  if (!prop) return;
  // `=` is optional in both syntaxes: UMAPINFO always writes it, ZDoom's newer
  // form usually does, and neither requires it.
  const value = prop.value(tokens[keyIndex + 1]?.text === '=' ? tokens[keyIndex + 2] : tokens[keyIndex + 1]);
  if (value !== undefined) entry[prop.field] = value;
}

/** ZDoom's finale keywords as an exit value; anything else there is a map name. */
const FINALE_KEYWORD = /^end(game|pic|bunny|cast|demon|title)/i;

/**
 * A `next`/`secretnext` value as a map lump name, or `MAPINFO_END` for a finale keyword. Anything
 * unrecognised is left to fall through — `LevelProgression` only takes a name the loaded set
 * provides (docs/wad.md § Level progression).
 */
function exitValue(token: Token | undefined): string | undefined {
  if (!token || token.text === '{' || token.text === '}' || token.text === '=') return undefined;
  if (FINALE_KEYWORD.test(token.text)) return MAPINFO_END;
  return normalizeMapName(token.text);
}

/**
 * UMAPINFO's own end keys, which override whatever `next` said. The key alone is the statement, so
 * its value is only read to spot an explicit `false`/`0` (docs/wad.md § Level progression).
 */
function endValue(token: Token | undefined): string | undefined {
  const off = token && /^(false|0)$/i.test(token.text);
  return off ? undefined : MAPINFO_END;
}

/**
 * A `music` value as a lump name. Quoted or not (both syntaxes are in the wild), and ZDoom's
 * `$MUSIC_…` string-table indirection is left alone: it names no lump, and a track that doesn't
 * resolve simply falls back to the vanilla per-map choice.
 */
function musicValue(token: Token | undefined): string | undefined {
  if (!token || token.text === '{' || token.text === '}' || token.text === '=') return undefined;
  return token.text.toUpperCase();
}

/**
 * Every `map` entry one MAPINFO/ZMAPINFO/UMAPINFO lump's text defines, keyed by map lump name:
 * the three syntaxes that name a level, plus the `PROPERTY_KEYS` properties in both the `{ … }`
 * block form and the old brace-less one. Anything else in the file is not a `map` keyword followed
 * by a name and is walked past. See docs/wad.md § Level names for the syntaxes and for why a
 * `lookup` title records nothing.
 */
function parseMapInfo(text: string): Map<string, MapInfoEntry> {
  const maps = new Map<string, MapInfoEntry>();
  const tokens = tokenize(stripComments(text));
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].quoted || tokens[i].text.toLowerCase() !== 'map') continue;
    const nameToken = tokens[i + 1];
    if (!nameToken || nameToken.text === '{') continue;
    const mapName = normalizeMapName(nameToken.text);
    i++;

    const entry: MapInfoEntry = {};
    const next = tokens[i + 1];
    if (next && !next.quoted && next.text.toLowerCase() === 'lookup') {
      i += 2; // the `lookup` and the string-table ID after it
    } else if (next && next.quoted) {
      entry.title = next.text;
      i++;
    }

    // A property block may still hold the name (UMAPINFO) — and has to be walked past either way
    // so a nested `map` property can't be mistaken for the next level.
    if (tokens[i + 1]?.text === '{') {
      i += 2;
      for (let depth = 1; i < tokens.length && depth > 0; i++) {
        const token = tokens[i];
        if (token.quoted) continue;
        if (token.text === '{') depth++;
        else if (token.text === '}') depth--;
        else if (depth !== 1) continue;
        else if (token.text.toLowerCase() === 'levelname' && tokens[i + 1]?.text === '=' && tokens[i + 2]?.quoted) {
          entry.title = tokens[i + 2].text;
        } else {
          readProperty(entry, tokens, i);
        }
      }
      i--; // the loop above stopped one past the closing brace
    } else {
      // Old brace-less ZDoom form: the level's properties are the bare lines between this `map`
      // and the next one. Read-only lookahead — the outer loop still walks these tokens itself.
      for (let j = i + 1; j < tokens.length; j++) {
        const token = tokens[j];
        if (token.quoted) continue;
        if (token.text.toLowerCase() === 'map' || token.text === '{') break;
        readProperty(entry, tokens, j);
      }
    }

    if (Object.keys(entry).length > 0) maps.set(mapName, entry);
  }
  return maps;
}
