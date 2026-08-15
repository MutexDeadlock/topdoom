/**
 * Parses the MAPINFO lump family (UMAPINFO/ZMAPINFO/MAPINFO) for the level titles a PWAD defines.
 * See docs/wad.md § Level names.
 */
import type { Wad, WadFile } from './wad.ts';

/**
 * The lump names carrying level definitions, **most preferred first**: a file that ships several
 * means them as alternatives for different engines, not as layers, so only the first one it
 * provides is read. `UMAPINFO` is the Boom-era standard most modern PWADs ship; ZDoom reads
 * `ZMAPINFO` instead of `MAPINFO` when a file provides both (the old lump stays for engines that
 * don't know the newer syntax). All three are parsed by the same reader below — the only syntax
 * difference that matters here is where the level name sits.
 * docs/wad.md § Level names.
 */
export const MAPINFO_LUMPS = ['UMAPINFO', 'ZMAPINFO', 'MAPINFO'];

/** The one MAPINFO-family lump to read out of a file, given every such lump name it carries. */
export function preferredMapInfoLump(present: readonly string[]): string | null {
  return MAPINFO_LUMPS.find((name) => present.includes(name)) ?? null;
}

/** Text lumps are 8-bit, the same as every other string a WAD carries. */
const DECODER = new TextDecoder('latin1');

type Token = { text: string; quoted: boolean };

/**
 * Drops line (`//`) and block comments, leaving quoted strings alone — a title containing a slash
 * must survive, and TNT's "shipping/respawning" really does.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) return out + text.slice(i);
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0) return out;
      i = end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      // Keep the lines joined rather than glued: a block comment can span a line break.
      out += ' ';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

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

/** What one `map` entry in a MAPINFO-family lump tells this engine. Every field is optional: most entries define only a name. */
export interface MapInfoEntry {
  /** The level's own title — see `parseMapInfo`'s list of the syntaxes that carry one. */
  title?: string;
  /** Where the normal exit leads (`next`), as a map lump name. */
  next?: string;
  /** Where the secret exit leads — ZDoom spells the key `secretnext`, UMAPINFO `nextsecret`; both are read. */
  secretNext?: string;
  /** The `D_*` lump this level's music comes from, replacing the vanilla per-map choice (docs/music.md § Which track a level plays). */
  music?: string;
}

/**
 * A `next`/`secretnext` value as a map lump name. ZDoom also accepts finale keywords here
 * (`EndGame`, `EndPic`, `EndBunny`), which normalize to something no map is called — that is
 * deliberate: `LevelProgression` only takes a value that names a map the loaded set actually has,
 * so a finale keyword falls through to the vanilla rules rather than being mistaken for a level.
 */
function exitValue(token: Token | undefined): string | undefined {
  if (!token || token.text === '{' || token.text === '}' || token.text === '=') return undefined;
  return normalizeMapName(token.text);
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

/**
 * Every `map` entry one MAPINFO/ZMAPINFO/UMAPINFO lump's text defines, keyed by map lump name.
 * Covers the three syntaxes that actually name a level:
 *
 * - ZDoom, new and old: `map MAP01 "Entryway"` (with or without a `{ … }` property block).
 * - UMAPINFO: `map MAP01 { levelname = "Entryway" }`.
 * - Hexen numeric: `map 01 "Entryway"`.
 *
 * and, in both the block and the old brace-less form, the properties in `PROPERTY_KEYS`: where a
 * level's exits lead — what lets a PWAD define its own progression instead of inheriting vanilla's
 * (docs/wad.md § Level progression) — and which track it plays.
 *
 * `map MAP01 lookup HUSTR_1` names no literal at all — it defers to the engine's own string table,
 * which is exactly what `levelNameFor` falls back to anyway, so no title is recorded for those.
 * Anything else in the file (skies, music, clusters, `defaultmap`, episode blocks) is not a `map`
 * keyword followed by a name and is simply walked past. See docs/wad.md § Level names.
 */
export function parseMapInfo(text: string): Map<string, MapInfoEntry> {
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
      i += 2; // the `lookup` and the string-table id after it
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

/** Just the titles out of `parseMapInfo` — what the menu's map list and `LevelNames` want. */
export function parseMapInfoNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const [map, entry] of parseMapInfo(text)) {
    if (entry.title !== undefined) names.set(map, entry.title);
  }
  return names;
}

/**
 * Every `map` entry the loaded WAD set defines. Files are read in load order and later ones win,
 * the same rule the merged lump directory itself follows; within one file, exactly one lump is
 * read, per `MAPINFO_LUMPS`. A later file's entry replaces an earlier one outright rather than
 * merging field by field: a PWAD redefining a level defines all of it, and a half-inherited
 * progression (its own `next`, the IWAD's `secretnext`) is not something any file asked for.
 * docs/wad.md § Level names.
 */
export function mapInfoEntries(wad: Wad): Map<string, MapInfoEntry> {
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
    for (const [map, entry] of parseMapInfo(DECODER.decode(wad.data(lump)))) maps.set(map, entry);
  }
  return maps;
}

/** Just the level names out of `mapInfoEntries` — see `parseMapInfoNames`. */
export function mapInfoNames(wad: Wad): Map<string, string> {
  const names = new Map<string, string>();
  for (const [map, entry] of mapInfoEntries(wad)) {
    if (entry.title !== undefined) names.set(map, entry.title);
  }
  return names;
}

/** Just the music lumps out of `mapInfoEntries` — docs/music.md § Which track a level plays. */
export function mapInfoMusic(wad: Wad): Map<string, string> {
  const music = new Map<string, string>();
  for (const [map, entry] of mapInfoEntries(wad)) {
    if (entry.music !== undefined) music.set(map, entry.music);
  }
  return music;
}
