import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_NAMES,
  LevelNames,
  dehTitlesFor,
  levelNameFor,
  levelNamePatch,
  levelTitleFor,
  missionOf,
  stripTitlePrefix,
  titleLookupFor,
  type TitleFrom,
} from '../../src/wad/campaign/names.ts';
import { MapInfo } from '../../src/wad/campaign/mapinfo.ts';
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
      mapInfoTitle: { title: 'Faulers First', fromIwad: false },
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
    /** `LevelNames` takes the set's already-parsed MAPINFO alongside the set itself. */
    const namesOf = (wad: Wad) => new LevelNames(wad, new MapInfo(wad));
    const iwad = wadFile('IWAD', 'DOOM2.WAD', ['MAP01', 'MAP02', 'CWILV00', 'CWILV01']);
    assert.equal(namesOf(new Wad(iwad)).graphicFor('MAP01'), 'CWILV00');

    // A PWAD that brings its own name graphics: its map, its patch.
    const withArt = wadFile('PWAD', 'SCYTHE.WAD', ['MAP01', 'CWILV00']);
    assert.equal(namesOf(new Wad([iwad, withArt])).graphicFor('MAP01'), 'CWILV00');

    // One that doesn't must not announce itself with the IWAD's name for a different level.
    const noArt = wadFile('PWAD', 'NUTS.WAD', ['MAP01']);
    const names = namesOf(new Wad([iwad, noArt]));
    assert.equal(names.graphicFor('MAP01'), undefined);
    assert.equal(names.graphicFor('MAP02'), 'CWILV01', "the IWAD's own maps still get theirs");
  });

  test("an IWAD's MAPINFO title does not name a map an add-on replaced", () => {
    // The same rule the vanilla table has, for a set whose IWAD names its levels in MAPINFO: after
    // the add-on takes MAP01 over, the IWAD's title is for a level that is no longer there.
    const mapinfo = { name: 'MAPINFO', text: 'map MAP01 "Base"\nmap MAP02 "Plant"' };
    const iwad = wadFile('IWAD', 'game.wad', ['MAP01', 'MAP02', mapinfo]);
    const pwad = wadFile('PWAD', 'NUTS.WAD', ['MAP01']);
    const wad = new Wad([iwad, pwad]);
    const names = new LevelNames(wad, new MapInfo(wad));
    assert.equal(names.nameFor('MAP01'), 'NUTS.WAD MAP01');
    assert.equal(names.nameFor('MAP02'), 'Plant', "the maps it still provides keep theirs");

    // An add-on's own MAPINFO names the map it brought, and any other in the set.
    const named = wadFile('PWAD', 'NUTS.WAD', ['MAP01', { name: 'MAPINFO', text: 'map MAP01 "Nuts"\nmap MAP02 "Renamed"' }]);
    const withNames = new Wad([iwad, named]);
    const renamed = new LevelNames(withNames, new MapInfo(withNames));
    assert.equal(renamed.nameFor('MAP01'), 'Nuts');
    assert.equal(renamed.nameFor('MAP02'), 'Renamed');
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

/**
 * How a DEHACKED patch's titles reach the level card, and where they sit against the two sources
 * that were already there. See docs/dehacked.md § Strings.
 */
describe('WAD parsing · DEHACKED level titles', () => {
  /** A projection's map → title pairs, dropping the provenance the assertions here don't test. */
  const titlesOf = (titles: Map<string, TitleFrom>) => [...titles].map(([map, from]) => [map, from.title]);

  test('stripTitlePrefix applies the two edits LEVEL_NAMES was generated with', () => {
    assert.equal(stripTitlePrefix('level 1: entryway'), 'Entryway');
    assert.equal(stripTitlePrefix('MAP01: Hydroelectric Plant'), 'Hydroelectric Plant');
    assert.equal(stripTitlePrefix('E1M1: Hangar'), 'Hangar');
    // A title naming no level identifier is kept verbatim — EPIC.WAD's form.
    assert.equal(stripTitlePrefix("1 - a fool's paradise"), "1 - a fool's paradise");
  });

  test('a mnemonic only names a map under the mission it belongs to', () => {
    const strings = new Map([
      ['HUSTR_1', 'MAP01: Doom II One'],
      ['PHUSTR_1', 'MAP01: Plutonia One'],
      ['THUSTR_1', 'MAP01: TNT One'],
      ['HUSTR_E1M1', 'E1M1: Doom One'],
    ]);
    assert.deepEqual(titlesOf(dehTitlesFor('doom2', strings)), [['MAP01', 'Doom II One']]);
    assert.deepEqual(titlesOf(dehTitlesFor('plutonia', strings)), [['MAP01', 'Plutonia One']]);
    assert.deepEqual(titlesOf(dehTitlesFor('tnt', strings)), [['MAP01', 'TNT One']]);
    assert.deepEqual(titlesOf(dehTitlesFor('doom', strings)), [['E1M1', 'Doom One']]);
  });

  test('an unrecognised IWAD keeps the plain HUSTR_ set rather than dropping every title', () => {
    // The case EPIC.WAD lands in whenever the IWAD is not literally named `doom2.wad`.
    const strings = new Map([['HUSTR_1', 'MAP01: Kept'], ['PHUSTR_1', 'MAP01: Dropped']]);
    assert.deepEqual(titlesOf(dehTitlesFor(null, strings)), [['MAP01', 'Kept']]);
  });

  test('a lump name passes straight through, which is how a Text substitution arrives', () => {
    assert.deepEqual(titlesOf(dehTitlesFor('doom2', new Map([['MAP07', 'Renamed']]))), [['MAP07', 'Renamed']]);
  });

  test('MAPINFO beats DEHACKED, and DEHACKED beats the vanilla table', () => {
    const base = { mission: 'doom2' as const, providerIsPwad: false };
    const mapInfoTitle = { title: 'From MAPINFO', fromIwad: false };
    const dehTitle = { title: 'From DEH', fromIwad: false };
    assert.equal(levelTitleFor('MAP01', { ...base, mapInfoTitle, dehTitle }), 'From MAPINFO');
    assert.equal(levelTitleFor('MAP01', { ...base, dehTitle }), 'From DEH');
    assert.equal(levelTitleFor('MAP01', base), 'Entryway');
  });

  test("an add-on's title applies to a PWAD's own map, where the vanilla table deliberately does not", () => {
    // Renaming the base game's levels is what such a lump is for, so an add-on's title reaches any
    // map — the IWAD-provided guard is on the vanilla table and on the IWAD's own titles.
    const pwad = { mission: 'doom2' as const, providerIsPwad: true };
    assert.equal(levelTitleFor('MAP01', pwad), undefined);
    assert.equal(levelTitleFor('MAP01', { ...pwad, dehTitle: { title: 'From DEH', fromIwad: false } }), 'From DEH');
  });

  test("the IWAD's own title does not name a map an add-on provides", () => {
    // freedoom2 + NUTS.WAD: the IWAD's DEHACKED names every MAP01-MAP32, and MAP01 is now a
    // different level. Repro: the card announced "Hydroelectric Plant" over NUTS.
    const iwadTitle = { title: 'Hydroelectric Plant', fromIwad: true };
    const pwad = { mission: null, providerName: 'NUTS.WAD', providerIsPwad: true } as const;
    assert.equal(levelTitleFor('MAP01', { ...pwad, dehTitle: iwadTitle }), undefined);
    assert.equal(levelTitleFor('MAP01', { ...pwad, mapInfoTitle: iwadTitle }), undefined);
    assert.equal(levelNameFor('MAP01', { ...pwad, dehTitle: iwadTitle }), 'NUTS.WAD MAP01');
    // Its own maps still get it, and an add-on's title still outranks it where both name the map.
    const iwad = { mission: null, providerName: 'freedoom2.wad', providerIsPwad: false } as const;
    assert.equal(levelTitleFor('MAP01', { ...iwad, dehTitle: iwadTitle }), 'Hydroelectric Plant');
    assert.equal(
      levelTitleFor('MAP01', { ...pwad, dehTitle: iwadTitle, mapInfoTitle: { title: 'Nuts', fromIwad: false } }),
      'Nuts',
    );
  });

  test("a PWAD's DEH title survives the IWAD's name graphic, by the provenance rule already there", () => {
    // EPIC.WAD provides MAP01 but no CWILV00, so `graphicFor` already declines the IWAD's — and
    // the card falls through to the text, which is where the DEH title is. No new rule needed.
    // The strings carry no sources either, which is the permissive case: they count as an add-on's.
    const iwad = wadFile('IWAD', 'doom2.wad', ['MAP01', 'MAP02', 'CWILV00']);
    const pwad = wadFile('PWAD', 'EPIC.WAD', ['MAP01']);
    const wad = new Wad([iwad, pwad]);
    const names = new LevelNames(wad, new MapInfo(wad), { strings: new Map([['MAP01', "1 - a fool's paradise"]]) });
    assert.equal(names.graphicFor('MAP01'), undefined);
    assert.equal(names.nameFor('MAP01'), "1 - a fool's paradise");
  });

  test("the IWAD's DEH titles reach only the maps it still provides", () => {
    // freedoom2's real shape: no MAPINFO, a file name `missionOf` doesn't know, and a DEHACKED
    // naming all 32 maps. With NUTS.WAD loaded the card announced the IWAD's MAP01 title.
    const iwad = wadFile('IWAD', 'freedoom2.wad', ['MAP01', 'MAP02']);
    const pwad = wadFile('PWAD', 'NUTS.WAD', ['MAP01']);
    const wad = new Wad([iwad, pwad]);
    const strings = new Map([
      ['HUSTR_1', 'MAP01: Hydroelectric Plant'],
      ['HUSTR_2', 'MAP02: Filtration Complex'],
    ]);
    const names = new LevelNames(wad, new MapInfo(wad), {
      strings,
      stringSources: new Map([['HUSTR_1', iwad], ['HUSTR_2', iwad]]),
    });
    assert.equal(names.nameFor('MAP01'), 'NUTS.WAD MAP01');
    assert.equal(names.nameFor('MAP02'), 'Filtration Complex');

    // The add-on's own patch names its own map, which is what the rule must not cost.
    const own = new LevelNames(wad, new MapInfo(wad), {
      strings: new Map([['HUSTR_1', 'MAP01: Nuts']]),
      stringSources: new Map([['HUSTR_1', pwad]]),
    });
    assert.equal(own.nameFor('MAP01'), 'Nuts');
  });

  test('the reverse lookup resolves a vanilla title back to the map that carries it', () => {
    const lookup = titleLookupFor();
    assert.equal(lookup('level 1: entryway'), 'MAP01');
    assert.equal(lookup('Entryway'), 'MAP01');
    assert.equal(lookup('E1M1: Hangar'), 'E1M1');
    assert.equal(lookup('Not A Level'), undefined);
  });
});
