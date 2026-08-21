import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { LF, loadMap, NO_SIDE } from '../../src/wad/map.ts';
import { fixtureWad, wadFile } from '../fixtures/wadfile.ts';
import { isAmbush, isMultiplayerOnly, spawnsAtSkill } from '../../src/game/skill.ts';

/**
 * `wad/hexen.ts` and the format detection that reaches it: the two re-encoded record
 * layouts, and the flag translation — the half that fails silently when it is wrong.
 * See docs/wad.md § Map formats.
 */

/** One little-endian u16, the only width these two record layouts use for a multi-byte field. */
const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];

/** A Hexen linedef, `maplinedef2_t`'s sixteen bytes (gzdoom `doomdata.h`). */
function hexenLine(o: {
  v1: number;
  v2: number;
  flags: number;
  special?: number;
  args?: readonly number[];
}): number[] {
  return [
    ...u16(o.v1),
    ...u16(o.v2),
    ...u16(o.flags),
    o.special ?? 0,
    ...(o.args ?? [0, 0, 0, 0, 0]),
    ...u16(0), // right sidedef
    ...u16(NO_SIDE), // left
  ];
}

/** A Hexen thing, `mapthinghexen_t`'s twenty bytes. */
function hexenThing(o: { x: number; y: number; type: number; flags: number }): number[] {
  return [
    ...u16(0), // tid
    ...u16(o.x),
    ...u16(o.y),
    ...u16(0), // z above the floor
    ...u16(0), // angle
    ...u16(o.type),
    ...u16(o.flags),
    0, 0, 0, 0, 0, 0, // special + args
  ];
}

/** A one-map PWAD carrying the given Hexen records; BEHAVIOR is what names the format. */
function hexenMap(lines: number[][], things: number[][]) {
  const wad = new Wad([
    wadFile('PWAD', 'H.WAD', [
      { name: 'MAP01' },
      { name: 'THINGS', bytes: new Uint8Array(things.flat()) },
      { name: 'LINEDEFS', bytes: new Uint8Array(lines.flat()) },
      { name: 'BEHAVIOR' }, // empty: its presence is the whole signal
    ]),
  ]);
  return loadMap(wad, 'MAP01');
}

describe('WAD parsing · Hexen format', () => {
  test('a map with no BEHAVIOR lump stays Doom format', () => {
    const wad = new Wad([
      wadFile('PWAD', 'D.WAD', [{ name: 'MAP01' }, { name: 'LINEDEFS', bytes: new Uint8Array(14) }]),
    ]);
    const map = loadMap(wad, 'MAP01');
    assert.equal(map.format, 'doom');
    assert.equal(map.linedefs.length, 1);
    assert.equal(map.linedefs[0].action, undefined);
  });

  test('a BEHAVIOR lump switches both re-encoded lumps to 16- and 20-byte records', () => {
    const map = hexenMap(
      [hexenLine({ v1: 1, v2: 2, flags: LF.BLOCKING }), hexenLine({ v1: 2, v2: 3, flags: LF.BLOCKING })],
      [hexenThing({ x: 5, y: 6, type: 1, flags: 0x0107 })],
    );
    assert.equal(map.format, 'hexen');
    // 32 bytes of LINEDEFS is two Hexen lines, not the two-and-a-bit a 14-byte
    // read would find — the misparse the whole format branch exists to prevent.
    assert.equal(map.linedefs.length, 2);
    assert.deepEqual(
      map.linedefs.map((l) => [l.v1, l.v2]),
      [[1, 2], [2, 3]],
    );
    assert.equal(map.things.length, 1);
    assert.deepEqual({ x: map.things[0].x, y: map.things[0].y, type: map.things[0].type }, { x: 5, y: 6, type: 1 });
  });

  test('the action special and its args are parked, never fed to the Doom tables', () => {
    // 62 is Plat_DownWaitUpStay in ZDoom's namespace and "SR lower floor" in Doom's.
    const map = hexenMap([hexenLine({ v1: 0, v2: 1, flags: 0, special: 62, args: [2, 50, 100, 0, 0] })], []);
    assert.equal(map.linedefs[0].special, 0);
    assert.equal(map.linedefs[0].tag, 0);
    assert.equal(map.linedefs[0].action?.special, 62);
    assert.deepEqual(map.linedefs[0].action?.args, [2, 50, 100, 0, 0]);
  });

  test('linedef flags at and above 0x0200 are dropped rather than read as Boom bits', () => {
    // ML_REPEAT_SPECIAL sits exactly on Boom's ML_PASSUSE, and ML_SPAC_MASK above it.
    const map = hexenMap(
      [hexenLine({ v1: 0, v2: 1, flags: LF.TWO_SIDED | LF.SECRET | 0x0200 | 0x1c00 | 0x2000 })],
      [],
    );
    assert.equal(map.linedefs[0].flags & LF.PASSUSE, 0);
    assert.equal(map.linedefs[0].flags, LF.TWO_SIDED | LF.SECRET);
  });

  test('ML_BLOCK_PLAYERS and ML_BLOCKEVERYTHING both become plain BLOCKING', () => {
    // A deliberate deviation: there is no LF bit for "blocks the player only".
    for (const bit of [0x4000, 0x8000]) {
      const map = hexenMap([hexenLine({ v1: 0, v2: 1, flags: bit })], []);
      assert.equal(map.linedefs[0].flags & LF.BLOCKING, LF.BLOCKING, `flag 0x${bit.toString(16)}`);
    }
  });

  test('the single-player gate inverts: no MTF_SINGLE means the thing is skipped', () => {
    const [withSingle, without] = hexenMap([], [
      hexenThing({ x: 0, y: 0, type: 1, flags: 0x0007 | 0x0100 }),
      hexenThing({ x: 0, y: 0, type: 1, flags: 0x0007 }),
    ]).things;
    assert.equal(isMultiplayerOnly(withSingle.flags), false);
    assert.equal(isMultiplayerOnly(without.flags), true);
  });

  test('skill and ambush bits pass through, MTF_DORMANT and the class bits do not', () => {
    // 0x0010 is MTF_DORMANT in Hexen and MTF_NOTSINGLE in Doom — copied raw it would
    // silently delete every dormant thing from the map.
    const [thing] = hexenMap([], [hexenThing({ x: 0, y: 0, type: 1, flags: 0x0004 | 0x0008 | 0x0010 | 0x00e0 | 0x0100 })]).things;
    assert.equal(isMultiplayerOnly(thing.flags), false);
    assert.equal(isAmbush(thing.flags), true);
    assert.equal(spawnsAtSkill(thing.flags, 4), true);
    assert.equal(spawnsAtSkill(thing.flags, 3), false);
  });
});

/** Mock2.wad MAP02, its twelve lumps lifted out verbatim so the numbering is the WAD's own. */
describe('WAD parsing · Mock2 MAP02', () => {
  const map = loadMap(new Wad([fixtureWad('mock2_map02_hexen.wad')]), 'MAP02');

  test('loads as a Hexen map with vanilla nodes', () => {
    assert.equal(map.format, 'hexen');
    assert.equal(map.nodeFormat, 'vanilla');
  });

  test('the record counts come out of the lump sizes at the Hexen stride', () => {
    assert.equal(map.linedefs.length, 27); // 432 bytes / 16, not / 14
    assert.equal(map.things.length, 86); // 1720 bytes / 20, not / 10
  });

  test('every linedef points at real vertexes and sidedefs', () => {
    for (const [i, line] of map.linedefs.entries()) {
      assert.ok(line.v1 < map.vertexes.length && line.v2 < map.vertexes.length, `line ${i} vertexes`);
      assert.ok(line.right < map.sidedefs.length, `line ${i} front sidedef`);
      assert.ok(line.left === NO_SIDE || line.left < map.sidedefs.length, `line ${i} back sidedef`);
    }
  });

  test('the player start is the one the map places, not a byte-shifted ghost', () => {
    const start = map.things.find((t) => t.type === 1);
    assert.deepEqual({ x: start?.x, y: start?.y, angle: start?.angle }, { x: -192, y: -192, angle: 90 });
  });

  test('its five action specials are carried but left undispatched', () => {
    const actions = map.linedefs.flatMap((l) => (l.action && l.action.special !== 0 ? [l.action.special] : []));
    assert.deepEqual([...new Set(actions)].sort((a, b) => a - b), [21, 62, 80, 130, 243]);
    assert.equal(map.linedefs.every((l) => l.special === 0), true);
  });
});
