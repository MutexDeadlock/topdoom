/**
 * Decodes a UDMF map's TEXTMAP lump — the text encoding of the whole map: vertices,
 * linedefs/sidedefs, sectors and things — into the same records and Doom-flavored flag
 * bits a Doom-format map yields, so nothing downstream sees a format difference. Grammar
 * and field tables follow the UDMF v1.1 spec (udmf.txt § I, § III); which namespaces keep
 * Doom/Boom special numbers follows its § II.C and gzdoom's udmf_zdoom.txt § II.C.
 * See docs/wad.md § UDMF.
 */
import type { LineDef, Sector, SideDef, Thing, Vertex } from './defs.ts';

/** Everything a TEXTMAP lump holds that this engine reads. */
export interface UdmfMap {
  /** The `namespace` global, lowercased — `''` when the lump names none. */
  namespace: string;
  vertexes: Vertex[];
  sectors: Sector[];
  sidedefs: SideDef[];
  linedefs: LineDef[];
  things: Thing[];
}

/**
 * The namespaces whose line and sector specials are Doom's own numbers, safe to hand to
 * the vanilla/Boom tables: `Doom` is defined as v1.9 plus every Boom and MBF special
 * (udmf.txt § II.C), and `ZDoomTranslated` "uses Doom-type specials" (udmf_zdoom.txt
 * § II.C). Heretic and Strife reuse the Doom-shaped fields but number their specials for
 * their own games, and everything Hexen-shaped (`zdoom`, `hexen`, `dsda`, `eternity`)
 * carries ZDoom action specials — all of those park in `LineDef.action` instead.
 */
const DOOM_SPECIALS_NAMESPACES: ReadonlySet<string> = new Set(['doom', 'zdoomtranslated']);

export function udmfDoomSpecials(namespace: string): boolean {
  return DOOM_SPECIALS_NAMESPACES.has(namespace.toLowerCase());
}

/**
 * The namespace named by the opening bytes of a TEXTMAP lump, lowercased, or `''` when
 * they name none. The spec puts `namespace` first in the file (udmf.txt § II.C), so a
 * small head suffices and `describe.ts` can judge a file it will never load. Read through
 * the same parser as the whole lump rather than a regex of its own — one grammar, so a
 * comment or an escape cannot be read two ways. A head cut mid-token throws, and the
 * globals are done at the first block: both answer `''`.
 */
export function sniffUdmfNamespace(head: string): string {
  const p = new TextmapParser(head);
  try {
    while (!p.atEnd()) {
      const key = p.ident();
      if (p.peekIs('{')) return '';
      p.expect('=');
      const v = p.value();
      p.expect(';');
      if (key === 'namespace' && typeof v === 'string') return v.toLowerCase();
    }
  } catch {
    // A truncated head is the normal case, not an error: the caller reads a fixed prefix.
  }
  return '';
}

/**
 * The whole lump, in declaration order — which *is* each record's index (udmf.txt § II.A),
 * the identity linedef/sector references, savegames and the first-match-wins scans key on.
 * Unknown block types and keys are skipped (§ I). Throws on malformed syntax.
 */
export function parseTextmap(text: string): UdmfMap {
  const p = new TextmapParser(text);
  let namespace = '';
  const vertexes: Vertex[] = [];
  const sectors: Sector[] = [];
  const sidedefs: SideDef[] = [];
  const things: Thing[] = [];
  const rawLines: RawLinedef[] = [];

  while (!p.atEnd()) {
    const key = p.ident();
    if (p.peekIs('{')) {
      p.expect('{');
      switch (key) {
        case 'vertex': vertexes.push(readVertex(p)); break;
        case 'linedef': rawLines.push(readLinedef(p)); break;
        case 'sidedef': sidedefs.push(readSidedef(p)); break;
        case 'sector': sectors.push(readSector(p)); break;
        case 'thing': things.push(readThing(p)); break;
        default: fields(p, () => {}); break;
      }
    } else {
      p.expect('=');
      const v = p.value();
      p.expect(';');
      if (key === 'namespace' && namespace === '' && typeof v === 'string') namespace = v.toLowerCase();
    }
  }

  const doomSpecials = udmfDoomSpecials(namespace);
  return {
    namespace,
    vertexes,
    sectors,
    sidedefs,
    linedefs: rawLines.map((raw) => materializeLine(raw, doomSpecials)),
    things,
  };
}

type Value = string | number | boolean;

/**
 * A single-pass cursor over the lump text, one token looked at a time — a TEXTMAP can run
 * to tens of MB, so no token list is built. Comments are consumed here rather than by
 * `textlump.ts: stripComments`: UDMF quoted strings carry `\"` escapes (udmf.txt § I),
 * which that function's quote scan does not know.
 */
class TextmapParser {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  atEnd(): boolean {
    this.skipVoid();
    return this.pos >= this.text.length;
  }

  /** The identifier at the cursor, lowercased — they are case-insensitive (udmf.txt § I). */
  ident(): string {
    this.skipVoid();
    const t = this.text;
    const start = this.pos;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      const word =
        (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (this.pos > start && c >= 48 && c <= 57);
      if (!word) break;
      this.pos++;
    }
    if (this.pos === start) this.fail('an identifier');
    return t.slice(start, this.pos).toLowerCase();
  }

  peekIs(ch: string): boolean {
    this.skipVoid();
    return this.text.charCodeAt(this.pos) === ch.charCodeAt(0);
  }

  expect(ch: string): void {
    if (!this.peekIs(ch)) this.fail(`"${ch}"`);
    this.pos++;
  }

  /** A quoted string (unescaped), `true`/`false`, or a number; a stray keyword stays a string. */
  value(): Value {
    this.skipVoid();
    const t = this.text;
    if (t.charCodeAt(this.pos) === 34 /* " */) return this.quoted();
    const start = this.pos;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      // The token runs to a delimiter — the keyword alphabet of udmf.txt § I.
      if (
        c === 32 || c === 9 || c === 10 || c === 13 ||
        c === 59 /* ; */ || c === 123 /* { */ || c === 125 /* } */ ||
        c === 40 /* ( */ || c === 41 /* ) */ || c === 34 /* " */ || c === 39 /* ' */
      ) {
        break;
      }
      this.pos++;
    }
    if (this.pos === start) this.fail('a value');
    const token = t.slice(start, this.pos);
    if (token.length <= 5) {
      const keyword = token.toLowerCase();
      if (keyword === 'true') return true;
      if (keyword === 'false') return false;
    }
    const n = Number(token);
    return Number.isNaN(n) ? token : n;
  }

  /** Steps over whitespace and both comment forms; an unterminated comment runs to the end. */
  private skipVoid(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        this.pos++;
      } else if (c === 47 /* / */ && t.charCodeAt(this.pos + 1) === 47) {
        const nl = t.indexOf('\n', this.pos + 2);
        this.pos = nl === -1 ? t.length : nl + 1;
      } else if (c === 47 && t.charCodeAt(this.pos + 1) === 42 /* * */) {
        const end = t.indexOf('*/', this.pos + 2);
        this.pos = end === -1 ? t.length : end + 2;
      } else {
        return;
      }
    }
  }

  private quoted(): string {
    const t = this.text;
    let out = '';
    let start = this.pos + 1;
    let i = start;
    while (i < t.length) {
      const c = t.charCodeAt(i);
      if (c === 34 /* " */) {
        this.pos = i + 1;
        return out + t.slice(start, i);
      }
      if (c === 92 /* \ */) {
        // An escape stands for its second character verbatim (udmf.txt § I: quoted_string).
        out += t.slice(start, i) + (t[i + 1] ?? '');
        i += 2;
        start = i;
      } else {
        i++;
      }
    }
    this.fail('a closing quote');
  }

  private fail(wanted: string): never {
    let line = 1;
    for (let i = 0; i < this.pos && i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) line++;
    }
    throw new Error(`TEXTMAP line ${line}: expected ${wanted}`);
  }
}

/**
 * One block's assignments fed to `assign` until the closing brace; unknown keys are the
 * caller's to ignore, as § I requires of a compliant parser.
 */
function fields(p: TextmapParser, assign: (key: string, v: Value) => void): void {
  for (;;) {
    if (p.peekIs('}')) {
      p.expect('}');
      return;
    }
    const key = p.ident();
    p.expect('=');
    const v = p.value();
    p.expect(';');
    assign(key, v);
  }
}

function num(v: Value): number {
  return typeof v === 'number' ? v : 0;
}

function int(v: Value): number {
  return typeof v === 'number' ? Math.trunc(v) : 0;
}

/**
 * Texture and flat lookups key on upper case (`reader.ts: name8`), so quoted names follow. An
 * empty name collapses to `-` here rather than downstream: "no texture" has one spelling past
 * this seam, whichever format the map shipped in.
 */
function tex(v: Value): string {
  return typeof v === 'string' && v !== '' ? v.toUpperCase() : '-';
}

function readVertex(p: TextmapParser): Vertex {
  const out: Vertex = { x: 0, y: 0 };
  fields(p, (key, v) => {
    if (key === 'x') out.x = num(v);
    else if (key === 'y') out.y = num(v);
  });
  return out;
}

/** Defaults per udmf.txt § III: offsets 0, textures `"-"`, which is `NO_TEXTURE` downstream. */
function readSidedef(p: TextmapParser): SideDef {
  const out: SideDef = { xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector: 0 };
  fields(p, (key, v) => {
    switch (key) {
      case 'offsetx': out.xOffset = num(v); break;
      case 'offsety': out.yOffset = num(v); break;
      case 'texturetop': out.upper = tex(v); break;
      case 'texturebottom': out.lower = tex(v); break;
      case 'texturemiddle': out.middle = tex(v); break;
      case 'sector': out.sector = int(v); break;
    }
  });
  return out;
}

/**
 * Defaults per udmf.txt § III: heights 0 and `lightlevel` 160. The light clamps at 0 —
 * UDMF writes it as a signed integer where the binary lump's unsigned read never saw a
 * negative, and `Sector.light`'s consumers expect none.
 */
function readSector(p: TextmapParser): Sector {
  const out: Sector = { floorHeight: 0, ceilHeight: 0, floorTex: '-', ceilTex: '-', light: 160, special: 0, tag: 0 };
  fields(p, (key, v) => {
    switch (key) {
      case 'heightfloor': out.floorHeight = num(v); break;
      case 'heightceiling': out.ceilHeight = num(v); break;
      case 'texturefloor': out.floorTex = tex(v); break;
      case 'textureceiling': out.ceilTex = tex(v); break;
      case 'lightlevel': out.light = Math.max(0, int(v)); break;
      case 'special': out.special = int(v); break;
      case 'id': out.tag = int(v); break;
    }
  });
  return out;
}

/**
 * UDMF linedef flag keys → the LINEDEFS bits every consumer reads, in the spec's own
 * order (udmf.txt § III), which is Doom's `ML_` bit order. `blockplayers` and
 * `blockeverything` (udmf_zdoom.txt § III) fold into plain blocking — the same deliberate
 * deviation `map/hexen.ts` documents for the bits' Hexen form.
 */
const LINE_FLAG_BITS: Record<string, number> = {
  blocking: 0x0001,
  blockmonsters: 0x0002,
  twosided: 0x0004,
  dontpegtop: 0x0008,
  dontpegbottom: 0x0010,
  secret: 0x0020,
  blocksound: 0x0040,
  dontdraw: 0x0080,
  mapped: 0x0100,
  passuse: 0x0200,
  blockplayers: 0x0001,
  blockeverything: 0x0001,
};

/**
 * A linedef's fields kept raw until the whole lump is read: whether `special` reaches the
 * Doom tables or parks in `LineDef.action` depends on the namespace, and only the spec's
 * "should" puts that assignment first in the file (udmf.txt § II.C).
 */
interface RawLinedef {
  v1: number;
  v2: number;
  flags: number;
  id: number;
  special: number;
  args: number[];
  sidefront: number;
  sideback: number;
}

function readLinedef(p: TextmapParser): RawLinedef {
  const out: RawLinedef = { v1: 0, v2: 0, flags: 0, id: 0, special: 0, args: [0, 0, 0, 0, 0], sidefront: 0, sideback: -1 };
  fields(p, (key, v) => {
    const bit = LINE_FLAG_BITS[key];
    if (bit !== undefined) {
      if (v === true) out.flags |= bit;
      return;
    }
    switch (key) {
      case 'v1': out.v1 = int(v); break;
      case 'v2': out.v2 = int(v); break;
      case 'id': out.id = int(v); break;
      case 'special': out.special = int(v); break;
      case 'arg0': out.args[0] = int(v); break;
      case 'arg1': out.args[1] = int(v); break;
      case 'arg2': out.args[2] = int(v); break;
      case 'arg3': out.args[3] = int(v); break;
      case 'arg4': out.args[4] = int(v); break;
      case 'sidefront': out.sidefront = int(v); break;
      case 'sideback': out.sideback = int(v); break;
    }
  });
  return out;
}

/**
 * UDMF thing flag keys → the THINGS bits `game/skill.ts` reads. The skill pairs share a
 * bit because that is all Doom's format can say: skills 1-2 gate on one flag and 4-5 on
 * another (`spawnsAtSkill`), so `skill1`/`skill2` (and `skill4`/`skill5`) are
 * indistinguishable here, as they are in every binary map.
 */
const THING_FLAG_BITS: Record<string, number> = {
  skill1: 0x0001,
  skill2: 0x0001,
  skill3: 0x0002,
  skill4: 0x0004,
  skill5: 0x0004,
  ambush: 0x0008,
};

/** Doom's `MTF_NOTSINGLE`, the bit `single`'s absence maps onto — as in `map/hexen.ts`. */
const NOTSINGLE = 0x0010;

/** The single-player gate inverts exactly as in `map/hexen.ts`: `single` absent → `NOTSINGLE`. */
function readThing(p: TextmapParser): Thing {
  const out: Thing = { x: 0, y: 0, angle: 0, type: 0, flags: 0 };
  let single = false;
  fields(p, (key, v) => {
    const bit = THING_FLAG_BITS[key];
    if (bit !== undefined) {
      if (v === true) out.flags |= bit;
      return;
    }
    switch (key) {
      case 'x': out.x = num(v); break;
      case 'y': out.y = num(v); break;
      case 'angle': out.angle = int(v); break;
      case 'type': out.type = int(v); break;
      case 'single': single = v === true; break;
      // `height`, `id`, `dm`, `coop`, `friend` and the Hexen/Strife flags are dropped, as
      // a Hexen-format map's are — docs/wad.md § Flags are translated, not copied.
    }
  });
  if (!single) out.flags |= NOTSINGLE;
  return out;
}

/**
 * `map.ts`'s `NO_SIDE`, named here to keep the parent import type-only (it imports this module).
 */
const NO_SIDE = 0xffff;

/** A UDMF sidedef index: absent is written −1 (udmf.txt § III), the engine says `NO_SIDE`. */
function sideIndex(v: number): number {
  return v < 0 ? NO_SIDE : v;
}

/**
 * In a Doom-specials namespace the tag is the line's `id`, written as both `id` and
 * `arg0` by every compliant converter (udmf.txt § III, "Tag / ID Behavior"), so either
 * serves. Anywhere else `special` is a ZDoom number in a namespace of its own and parks
 * in `LineDef.action` with `special`/`tag` zeroed, exactly as `map/hexen.ts` does —
 * docs/wad.md § What a Hexen map does not get.
 */
function materializeLine(raw: RawLinedef, doomSpecials: boolean): LineDef {
  // Field order is `map.ts`'s own, shared with the Doom and Hexen readers: `linedefs` is read on
  // the hot path and reaches it as one shape (docs/conventions.md § Named arguments).
  if (doomSpecials) {
    return {
      v1: raw.v1,
      v2: raw.v2,
      flags: raw.flags,
      special: raw.special,
      tag: raw.id !== 0 ? raw.id : raw.args[0],
      right: sideIndex(raw.sidefront),
      left: sideIndex(raw.sideback),
    };
  }
  return {
    v1: raw.v1,
    v2: raw.v2,
    flags: raw.flags,
    special: 0,
    tag: 0,
    right: sideIndex(raw.sidefront),
    left: sideIndex(raw.sideback),
    action: { special: raw.special, args: raw.args },
  };
}
