import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Wad } from '../../src/wad/wad.ts';
import { LF, loadMap, mapLinedefBytes, NO_SIDE } from '../../src/wad/map.ts';
import { wadFile, type Lump } from '../fixtures/wadfile.ts';
import { isAmbush, isMultiplayerOnly, spawnsAtSkill } from '../../src/game/skill.ts';

/**
 * `wad/map/udmf.ts` and the group walk that reaches it: the TEXTMAP grammar, the § III
 * defaults, the flag translation — the half that fails silently when it is wrong — and the
 * namespace rule deciding whether specials reach the Doom tables or park in `LineDef.action`.
 * A UDMF parser is a pure text one, so the fixtures stay inline text (docs/testing.md).
 * See docs/wad.md § UDMF.
 */

/** A one-map UDMF PWAD: marker, the given TEXTMAP text, any extra lumps, the closing ENDMAP. */
function udmfWad(text: string, extra: Lump[] = []): Wad {
  return new Wad([
    wadFile('PWAD', 'U.WAD', [{ name: 'MAP01' }, { name: 'TEXTMAP', text }, ...extra, 'ENDMAP']),
  ]);
}

const load = (text: string, extra: Lump[] = []) => loadMap(udmfWad(text, extra), 'MAP01');

/** Little-endian byte lists, enough to write an extended-nodes payload. */
const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number): number[] => [...u16(n & 0xffff), ...u16(Math.floor(n / 0x10000))];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/**
 * An XNOD payload for the square below: its four TEXTMAP vertexes, one appended split
 * vertex at (64.5, −32.25) to pin the 16.16 read, one subsector of four segs on lines
 * 0-3, and no nodes.
 */
function squareXnod(): Uint8Array {
  const segs = [0, 1, 2, 3].flatMap((i) => [...u32(i), ...u32((i + 1) % 4), ...u16(i), 0]);
  return Uint8Array.from([
    ...u32(4), // orgVerts
    ...u32(1), // newVerts
    ...u32(Math.round(64.5 * 65536)),
    ...u32(Math.round(-32.25 * 65536) >>> 0),
    ...u32(1), // subsectors
    ...u32(4), // …of four segs
    ...u32(4), // segs
    ...segs,
    ...u32(0), // nodes
  ]);
}

const xnodLump = (): Lump => ({
  name: 'ZNODES',
  bytes: Uint8Array.from([...ascii('XNOD'), ...squareXnod()]),
});

/** A closed 128×128 square in the Doom namespace, one sector, all defaults exercised below. */
const SQUARE = `
namespace = "doom";
vertex { x = 0.0; y = 0.0; }
vertex { x = 128.0; y = 0.0; }
vertex { x = 128.0; y = 128.0; }
vertex { x = 0.0; y = 128.0; }
sector { texturefloor = "flat14"; textureceiling = "F_SKY1"; heightceiling = 128; }
sidedef { sector = 0; texturemiddle = "STARTAN2"; }
sidedef { sector = 0; texturemiddle = "STARTAN2"; }
sidedef { sector = 0; texturemiddle = "STARTAN2"; }
sidedef { sector = 0; texturemiddle = "STARTAN2"; }
linedef { v1 = 0; v2 = 1; sidefront = 0; blocking = true; }
linedef { v1 = 1; v2 = 2; sidefront = 1; blocking = true; }
linedef { v1 = 2; v2 = 3; sidefront = 2; blocking = true; }
linedef { v1 = 3; v2 = 0; sidefront = 3; blocking = true; }
thing { x = 64.5; y = 64.0; angle = 90; type = 1;
        skill1 = true; skill2 = true; skill3 = true; skill4 = true; skill5 = true; single = true; }
`;

describe('WAD parsing · UDMF format', () => {
  test('a TEXTMAP after the marker loads as a UDMF map, BSP off its ZNODES', () => {
    const map = load(SQUARE, [xnodLump()]);
    assert.equal(map.format, 'udmf');
    assert.equal(map.udmfNamespace, 'doom');
    assert.equal(map.nodeFormat, 'xnod');
    assert.equal(map.linedefs.length, 4);
    assert.equal(map.sidedefs.length, 4);
    assert.equal(map.subsectors.length, 1);
    assert.equal(map.segs.length, 4);
    // The split vertex appended in 16.16 fixed point, after the TEXTMAP's own four floats.
    assert.equal(map.vertexes.length, 5);
    assert.deepEqual(map.vertexes[1], { x: 128, y: 0 });
    assert.deepEqual(map.vertexes[4], { x: 64.5, y: -32.25 });
    assert.deepEqual(map.bounds, { minX: 0, minY: -32.25, maxX: 128, maxY: 128 });
  });

  test('a compressed ZNODES payload reads the same as a plain one', () => {
    const znod: Lump = {
      name: 'ZNODES',
      bytes: Uint8Array.from([...ascii('ZNOD'), ...deflateSync(squareXnod())]),
    };
    assert.deepEqual(
      { ...load(SQUARE, [znod]), nodeFormat: 'xnod' },
      load(SQUARE, [xnodLump()]),
    );
  });

  test('a UDMF map without ZNODES loads with no BSP at all', () => {
    const map = load(SQUARE);
    assert.equal(map.nodes.length, 0);
    assert.equal(map.subsectors.length, 0);
    assert.equal(map.segs.length, 0);
  });

  test('a TEXTMAP with no closing ENDMAP is refused — udmf.txt § II.B requires one', () => {
    const wad = new Wad([wadFile('PWAD', 'U.WAD', [{ name: 'MAP01' }, { name: 'TEXTMAP', text: SQUARE }])]);
    assert.throws(() => loadMap(wad, 'MAP01'), /ENDMAP/);
  });

  test('the § III defaults fill everything a minimal map leaves out', () => {
    const map = load(SQUARE, [xnodLump()]);
    const sector = map.sectors[0];
    assert.equal(sector.floorHeight, 0);
    assert.equal(sector.ceilHeight, 128);
    assert.equal(sector.light, 160);
    assert.equal(sector.special, 0);
    assert.equal(sector.tag, 0);
    // Quoted names reach the same upper case every texture lookup keys on.
    assert.equal(sector.floorTex, 'FLAT14');
    const side = map.sidedefs[0];
    assert.equal(side.upper, '-');
    assert.equal(side.lower, '-');
    assert.equal(side.middle, 'STARTAN2');
    assert.equal(side.xOffset, 0);
    const line = map.linedefs[0];
    assert.equal(line.right, 0);
    // sideback defaults to −1 (absent), which is the engine's NO_SIDE — every two-sidedness
    // check reads `left === NO_SIDE` and a bare −1 would make each line two-sided.
    assert.equal(line.left, NO_SIDE);
    assert.equal(line.special, 0);
    assert.equal(line.tag, 0);
    assert.equal(line.action, undefined);
  });

  test('linedef flag keys land on the LINEDEFS bits every consumer reads', () => {
    const line = (fields: string) =>
      load(`namespace = "doom"; linedef { v1 = 0; v2 = 1; sidefront = 0; ${fields} }`).linedefs[0];
    assert.equal(line('blocking = true;').flags, LF.BLOCKING);
    assert.equal(line('blockmonsters = true;').flags, LF.BLOCK_MONSTERS);
    assert.equal(line('dontpegtop = true;').flags, LF.UPPER_UNPEGGED);
    assert.equal(line('dontpegbottom = true;').flags, LF.LOWER_UNPEGGED);
    assert.equal(line('secret = true;').flags, LF.SECRET);
    assert.equal(line('blocksound = true;').flags, LF.BLOCK_SOUND);
    assert.equal(line('passuse = true;').flags, LF.PASSUSE);
    // gzdoom's blockeverything/blockplayers become plain blocking, as Hexen's bits do.
    assert.equal(line('blockeverything = true;').flags, LF.BLOCKING);
    assert.equal(line('blockplayers = true;').flags, LF.BLOCKING);
    assert.equal(line('blocking = false;').flags, 0);
    // Identifiers and keywords are case-insensitive (udmf.txt § I).
    assert.equal(line('BLOCKING = TRUE; SECRET = True;').flags, LF.BLOCKING | LF.SECRET);
  });

  test('thing flags translate to the bits game/skill.ts reads, single inverted', () => {
    const thing = (fields: string) => load(`namespace = "doom"; thing { type = 3001; ${fields} }`).things[0];
    const everywhere = thing('skill1 = true; skill2 = true; skill3 = true; skill4 = true; skill5 = true; single = true;');
    for (const skill of [1, 2, 3, 4, 5] as const) assert.ok(spawnsAtSkill(everywhere.flags, skill));
    assert.equal(isMultiplayerOnly(everywhere.flags), false);
    assert.equal(isAmbush(everywhere.flags), false);

    const hardOnly = thing('skill4 = true; skill5 = true; single = true; ambush = true;');
    assert.equal(spawnsAtSkill(hardOnly.flags, 3), false);
    assert.ok(spawnsAtSkill(hardOnly.flags, 4));
    assert.ok(isAmbush(hardOnly.flags));

    // `single` absent maps onto Doom's NOTSINGLE, exactly as a Hexen thing's does.
    assert.equal(isMultiplayerOnly(thing('skill3 = true;').flags), true);

    const placed = thing('x = 32.5; y = -16.25; angle = 90; single = true;');
    assert.equal(placed.x, 32.5);
    assert.equal(placed.y, -16.25);
    assert.equal(placed.angle, 90);
    assert.equal(placed.type, 3001);
  });

  test('the Doom namespace hands specials and tags to the vanilla/Boom tables', () => {
    const text = `
      namespace = "doom";
      linedef { v1 = 0; v2 = 1; sidefront = 0; special = 88; id = 4; arg0 = 4; }
      linedef { v1 = 1; v2 = 2; sidefront = 0; special = 62; arg0 = 7; }
      sector { texturefloor = "F1"; textureceiling = "F1"; special = 9; id = 4; }
    `;
    const map = load(text);
    assert.equal(map.linedefs[0].special, 88);
    assert.equal(map.linedefs[0].tag, 4);
    // The tag is written as both id and arg0 (udmf.txt § III, Tag / ID Behavior); either serves.
    assert.equal(map.linedefs[1].tag, 7);
    assert.equal(map.linedefs[0].action, undefined);
    assert.equal(map.sectors[0].special, 9);
    assert.equal(map.sectors[0].tag, 4);
    // `ZDoomTranslated` uses Doom-type specials too (udmf_zdoom.txt § II.C).
    const translated = load(text.replace('"doom"', '"ZDoomTranslated"'));
    assert.equal(translated.linedefs[0].special, 88);
  });

  test('any other namespace parks its action specials, exactly as a Hexen map does', () => {
    for (const namespace of ['namespace = "zdoom";', 'namespace = "dsda";', '']) {
      const map = load(`${namespace}
        linedef { v1 = 0; v2 = 1; sidefront = 0; special = 12; arg0 = 3; arg1 = 16; id = 9; }
        sector { texturefloor = "F1"; textureceiling = "F1"; id = 666; }
      `);
      const line = map.linedefs[0];
      assert.equal(line.special, 0, namespace);
      assert.equal(line.tag, 0, namespace);
      assert.deepEqual(line.action, { special: 12, args: [3, 16, 0, 0, 0] }, namespace);
      // Sector tags stay: they feed tag-only rules like the 666/667 boss-death scan.
      assert.equal(map.sectors[0].tag, 666, namespace);
    }
  });

  test('comments, string escapes and unknown fields and blocks all pass over', () => {
    const map = load(`
      /* block comment { linedef */ namespace = "doom"; // line comment
      user_global = 1.5;
      vertex { x = 1.0; y = 2.0; comment = "a \\"quoted\\" note // not a comment"; }
      dialogue { speaker = "who"; nested = true; }
      sidedef { sector = 0; texturemiddle = "star\\"tan"; user_custom = true; }
      thing { type = 1; single = true; unknownflag = true; }
    `);
    assert.deepEqual(map.vertexes, [{ x: 1, y: 2 }]);
    assert.equal(map.sidedefs[0].middle, 'STAR"TAN');
    assert.equal(map.things[0].flags & 0x0007, 0); // unknownflag set no skill bit
  });

  test('records keep TEXTMAP declaration order — the index is the identity', () => {
    const map = load(`
      namespace = "doom";
      sector { texturefloor = "A"; textureceiling = "A"; heightfloor = 1; }
      vertex { x = 5.0; y = 0.0; }
      sector { texturefloor = "B"; textureceiling = "B"; heightfloor = 2; }
    `);
    assert.deepEqual(map.sectors.map((s) => s.floorHeight), [1, 2]);
    assert.equal(map.sectors[1].floorTex, 'B');
  });

  test('malformed text is refused with the line it broke on', () => {
    assert.throws(() => load('namespace = "doom";\nvertex { x = }'), /TEXTMAP line 2/);
    assert.throws(() => load('namespace = "unterminated'), /closing quote/);
  });

  test('the load-cost estimate answers from the TEXTMAP size, off the directory alone', () => {
    const wad = udmfWad(SQUARE);
    assert.ok(mapLinedefBytes(wad, 'MAP01') > 0);
  });
});
