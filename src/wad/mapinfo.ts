import type { Wad } from './wad.ts';

/**
 * The lump names carrying level definitions, in the order a file's own lumps are preferred:
 * ZDoom reads `ZMAPINFO` instead of `MAPINFO` when a file provides both (the old lump stays
 * for engines that don't know the newer syntax), and `UMAPINFO` is the Boom-era standard that
 * most modern PWADs ship. All three are parsed by the same reader below — the only syntax
 * difference that matters here is where the level name sits.
 */
const MAPINFO_LUMPS = ['UMAPINFO', 'ZMAPINFO', 'MAPINFO'];

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

/**
 * Level names out of one MAPINFO/ZMAPINFO/UMAPINFO lump's text, keyed by map lump name. Covers the
 * three syntaxes that actually name a level:
 *
 * - ZDoom, new and old: `map MAP01 "Entryway"` (with or without a `{ … }` property block).
 * - UMAPINFO: `map MAP01 { levelname = "Entryway" }`.
 * - Hexen numeric: `map 01 "Entryway"`.
 *
 * `map MAP01 lookup HUSTR_1` names no literal at all — it defers to the engine's own string table,
 * which is exactly what `levelNameFor` falls back to anyway, so those entries are skipped.
 * Anything else in the file (skies, music, clusters, `defaultmap`, episode blocks) is not a `map`
 * keyword followed by a name and is simply walked past. See docs/wad.md § Level names.
 */
export function parseMapInfoNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  const tokens = tokenize(stripComments(text));
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].quoted || tokens[i].text.toLowerCase() !== 'map') continue;
    const nameToken = tokens[i + 1];
    if (!nameToken || nameToken.text === '{') continue;
    const mapName = normalizeMapName(nameToken.text);
    i++;

    let title: string | undefined;
    const next = tokens[i + 1];
    if (next && !next.quoted && next.text.toLowerCase() === 'lookup') {
      i += 2; // the `lookup` and the string-table id after it
    } else if (next && next.quoted) {
      title = next.text;
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
        else if (depth === 1 && token.text.toLowerCase() === 'levelname' && tokens[i + 1]?.text === '=' && tokens[i + 2]?.quoted) {
          title = tokens[i + 2].text;
        }
      }
      i--; // the loop above stopped one past the closing brace
    }

    if (title) names.set(mapName, title);
  }
  return names;
}

/**
 * Every level name the loaded WAD set defines. Files are read in load order and later ones win,
 * the same rule the merged lump directory itself follows (docs/wad.md); within one file `ZMAPINFO`
 * suppresses that file's `MAPINFO`, which is what ZDoom does with the pair.
 */
export function mapInfoNames(wad: Wad): Map<string, string> {
  const zdoomFiles = new Set(wad.lumps.filter((l) => l.name === 'ZMAPINFO').map((l) => l.source));
  const names = new Map<string, string>();
  for (const lump of wad.lumps) {
    if (!MAPINFO_LUMPS.includes(lump.name)) continue;
    if (lump.name === 'MAPINFO' && zdoomFiles.has(lump.source)) continue;
    for (const [map, title] of parseMapInfoNames(DECODER.decode(wad.data(lump)))) names.set(map, title);
  }
  return names;
}
