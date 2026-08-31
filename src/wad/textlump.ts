/**
 * What the WAD's text lumps share before each grammar takes over. GZDoom's text-lump family
 * (MAPINFO, GLDEFS, …) all carry C-style comments over otherwise unrelated syntaxes, so the
 * comment strip is here and each parser keeps its own tokenizer, and every one of them reaches
 * its text through `decodeTextLump`.
 * See docs/wad.md and docs/lights.md § The grammar.
 */

/** Text lumps are 8-bit, the same as every other string a WAD carries. */
const DECODER = new TextDecoder('latin1');

/**
 * A lump's bytes as text — a view into the merged WAD, or a whole buffer as `shipped.ts` hands
 * one over. Absent bytes decode to `''`: a caller asking for a lump the WAD hasn't got wants an
 * empty grammar, not a crash.
 */
export function decodeTextLump(bytes: Uint8Array | ArrayBuffer | undefined): string {
  return DECODER.decode(bytes);
}

/**
 * Drops line (`//`) and block (`/* *\/`) comments, leaving quoted strings alone.
 *
 * Load-bearing in both callers rather than hygiene: MAPINFO titles contain slashes (TNT's
 * "shipping/respawning") and must survive, and the stock `gldefs.txt` block-comments out its
 * `object Spectre` binding — parsing that would light every spectre in the game.
 */
export function stripComments(text: string): string {
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
