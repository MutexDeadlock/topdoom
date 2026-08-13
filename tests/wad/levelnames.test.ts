import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL_NAMES, LevelNames, levelNameFor, levelNamePatch, levelTitleFor, missionOf } from '../../src/wad/levelnames.ts';
import { Wad } from '../../src/wad/wad.ts';
import { wadFile } from '../fixtures/wadfile.ts';

/**
 * The title table is generated from `linuxdoom-1.10/d_englsh.h` rather than typed, so what's worth
 * pinning is its shape (nothing dropped, nothing misfiled) and the resolution order around it.
 * See docs/wad.md § Level names.
 */
describe('Vanilla tables · level names', () => {
  test('every mission has its full set of maps, and no others', () => {
    assert.equal(Object.keys(LEVEL_NAMES.doom).length, 36, 'E1M1-E4M9');
    for (const mission of ['doom2', 'plutonia', 'tnt'] as const) {
      assert.equal(Object.keys(LEVEL_NAMES[mission]).length, 32, `${mission} MAP01-MAP32`);
    }
    for (const [mission, table] of Object.entries(LEVEL_NAMES)) {
      const pattern = mission === 'doom' ? /^E\dM\d$/ : /^MAP\d\d$/;
      for (const [map, title] of Object.entries(table)) {
        assert.match(map, pattern, `${mission} key ${map}`);
        assert.ok(title.length > 0, `${mission} ${map} has a title`);
      }
    }
  });

  test('the three MAP01s are three different levels', () => {
    assert.equal(LEVEL_NAMES.doom2.MAP01, 'Entryway');
    assert.equal(LEVEL_NAMES.plutonia.MAP01, 'Congo');
    assert.equal(LEVEL_NAMES.tnt.MAP01, 'System control');
  });

  test('titles are stripped of their level identifier but otherwise verbatim', () => {
    assert.equal(LEVEL_NAMES.doom.E1M1, 'Hangar');
    // TNT MAP05 really is spelled "hanger" in d_englsh.h.
    assert.equal(LEVEL_NAMES.tnt.MAP05, 'Hanger');
    for (const table of Object.values(LEVEL_NAMES)) {
      for (const [map, title] of Object.entries(table)) {
        assert.doesNotMatch(title, /^(E\dM\d|level \d+):/i, `${map} still carries its identifier`);
      }
    }
  });
});

describe('WAD parsing · level name resolution', () => {
  test('an IWAD is identified by its whole file name, not a substring', () => {
    assert.equal(missionOf('DOOM2.WAD'), 'doom2');
    assert.equal(missionOf('doom1.wad'), 'doom');
    assert.equal(missionOf('plutonia.wad'), 'plutonia');
    assert.equal(missionOf('tnt.wad'), 'tnt');
    // The reason the match isn't a substring one: Freedoom names its levels nothing like DOOM II.
    assert.equal(missionOf('freedoom2.wad'), null);
  });

  test('MAPINFO outranks the vanilla table', () => {
    const sources = {
      mapInfoTitle: 'Faulers First',
      mission: 'doom2',
      providerName: 'faulers_first_map.wad',
      providerIsPwad: true,
    } as const;
    assert.equal(levelTitleFor('MAP01', sources), 'Faulers First');
    assert.equal(levelNameFor('MAP01', sources), 'Faulers First');
  });

  test('the vanilla table names an IWAD map', () => {
    const sources = { mission: 'doom', providerName: 'DOOM1.WAD', providerIsPwad: false } as const;
    assert.equal(levelTitleFor('E1M1', sources), 'Hangar');
    assert.equal(levelNameFor('E1M1', sources), 'Hangar');
  });

  test('a PWAD map has no vanilla title to inherit, even where the IWAD has one', () => {
    const title = levelTitleFor('MAP01', { mission: 'doom2', providerName: 'SCYTHE.WAD', providerIsPwad: true });
    assert.equal(title, undefined, 'the menu shows no title rather than the wrong one');
  });

  test("a PWAD's map is named after its file, never after the IWAD level it replaced", () => {
    const name = levelNameFor('MAP01', {
      mission: 'doom2',
      providerName: 'SCYTHE.WAD',
      providerIsPwad: true,
    });
    assert.equal(name, 'SCYTHE.WAD MAP01');
  });

  test('an unrecognised IWAD falls back to the bare lump name', () => {
    const name = levelNameFor('MAP01', { mission: null, providerName: 'freedoom2.wad', providerIsPwad: false });
    assert.equal(name, 'MAP01');
  });

  test("the level-name graphic follows vanilla's own lump naming", () => {
    // wi_stuff.c's WI_loadData: CWILV%2.2d over a 0-based map index, WILV%d%d over 0-based
    // episode and map.
    assert.equal(levelNamePatch('MAP01'), 'CWILV00');
    assert.equal(levelNamePatch('MAP07'), 'CWILV06');
    assert.equal(levelNamePatch('MAP32'), 'CWILV31');
    assert.equal(levelNamePatch('E1M1'), 'WILV00');
    assert.equal(levelNamePatch('E4M9'), 'WILV38');
    assert.equal(levelNamePatch('TITLEMAP'), undefined);
  });

  test('a level-name graphic is used only when it belongs to the map', () => {
    const iwad = wadFile('IWAD', 'DOOM2.WAD', ['MAP01', 'MAP02', 'CWILV00', 'CWILV01']);
    assert.equal(new LevelNames(new Wad(iwad)).graphicFor('MAP01'), 'CWILV00');

    // A PWAD that brings its own name graphics: its map, its patch.
    const withArt = wadFile('PWAD', 'SCYTHE.WAD', ['MAP01', 'CWILV00']);
    assert.equal(new LevelNames(new Wad([iwad, withArt])).graphicFor('MAP01'), 'CWILV00');

    // One that doesn't must not announce itself with the IWAD's name for a different level.
    const noArt = wadFile('PWAD', 'NUTS.WAD', ['MAP01']);
    const names = new LevelNames(new Wad([iwad, noArt]));
    assert.equal(names.graphicFor('MAP01'), undefined);
    assert.equal(names.graphicFor('MAP02'), 'CWILV01', "the IWAD's own maps still get theirs");
  });

  test('a map the mission table has no entry for falls back too', () => {
    // SIGIL's E5M1 with SIGIL loaded as a PWAD, and the same map with no provider at all.
    assert.equal(
      levelNameFor('E5M1', { mission: 'doom', providerName: 'SIGIL.WAD', providerIsPwad: true }),
      'SIGIL.WAD E5M1',
    );
    assert.equal(levelNameFor('E5M1', { mission: 'doom', providerIsPwad: false }), 'E5M1');
  });
});
