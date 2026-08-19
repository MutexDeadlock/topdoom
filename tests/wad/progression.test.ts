import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LevelProgression, vanillaNextMap, type NextLevel } from '../../src/wad/campaign/progression.ts';
import { MapInfo } from '../../src/wad/campaign/mapinfo.ts';
import { Wad } from '../../src/wad/wad.ts';
import { wadFile } from '../fixtures/wadfile.ts';

/** The map an exit leads to, or null for anything that isn't one — most cases here name a level. */
const leadsTo = (next: NextLevel): string | null => (next.kind === 'map' ? next.name : null);

/** `LevelProgression` takes the set's already-parsed MAPINFO, so each set under test needs one. */
const progressionFor = (wad: Wad, maps: readonly string[]) => new LevelProgression(new MapInfo(wad), maps);

/** The map markers a DOOM II IWAD's worth of levels needs, so `LevelProgression` can find them. */
const DOOM2_MAPS = Array.from({ length: 32 }, (_, i) => ({ name: `MAP${String(i + 1).padStart(2, '0')}` }));
const DOOM_MAPS = [1, 2, 3, 4].flatMap((e) => Array.from({ length: 9 }, (_, m) => ({ name: `E${e}M${m + 1}` })));

/**
 * The tables come from `G_DoCompleted` (`linuxdoom-1.10/g_game.c`) — the two secret levels and the
 * three levels whose exits don't simply lead to the next map are the whole point of them.
 * See docs/wad.md § Level progression.
 */
describe('Vanilla tables · level progression', () => {
  test('DOOM II runs MAP01-MAP30 in order, and ends at MAP30', () => {
    for (let map = 1; map < 30; map++) {
      const name = `MAP${String(map).padStart(2, '0')}`;
      const next = `MAP${String(map + 1).padStart(2, '0')}`;
      assert.equal(leadsTo(vanillaNextMap(name, false)), next, `${name} normal exit`);
    }
    // The Icon of Sin ends the game, and DOOM II has no next episode to carry on into.
    assert.deepEqual(vanillaNextMap('MAP30', false), { kind: 'end', scope: 'campaign', next: null });
  });

  test('DOOM II secret exits lead MAP15 → MAP31 → MAP32, and both come back to MAP16', () => {
    assert.equal(leadsTo(vanillaNextMap('MAP15', true)), 'MAP31');
    assert.equal(leadsTo(vanillaNextMap('MAP31', true)), 'MAP32');
    assert.equal(leadsTo(vanillaNextMap('MAP31', false)), 'MAP16');
    assert.equal(leadsTo(vanillaNextMap('MAP32', false)), 'MAP16');
    // Every other map's secret exit leads nowhere of its own — vanilla's switch has no case for it.
    assert.equal(vanillaNextMap('MAP14', true).kind, 'unknown');
    assert.equal(vanillaNextMap('MAP16', true).kind, 'unknown');
  });

  test('a DOOM episode ends at M8, and its secret exit always leads to M9', () => {
    for (const episode of [1, 2, 3, 4]) {
      for (let mission = 1; mission < 8; mission++) {
        assert.equal(leadsTo(vanillaNextMap(`E${episode}M${mission}`, false)), `E${episode}M${mission + 1}`);
      }
      // The episode ends at M8, naming the next one's first map for the caller to keep or drop.
      assert.deepEqual(
        vanillaNextMap(`E${episode}M8`, false),
        { kind: 'end', scope: 'episode', next: `E${episode + 1}M1` },
        `E${episode}M8 is the episode's end`,
      );
      assert.equal(leadsTo(vanillaNextMap(`E${episode}M1`, true)), `E${episode}M9`);
      // `case 8` returns before `G_DoCompleted` reads `secretexit`, so M8's secret exit — which no
      // stock map has — ends the episode too rather than reaching M9.
      assert.equal(vanillaNextMap(`E${episode}M8`, true).kind, 'end');
    }
  });

  test('M9 returns to the level after the one that hides its entrance', () => {
    // `wminfo.next` is 0-biased in the source: 3, 5, 6, 2 for the four episodes.
    assert.equal(leadsTo(vanillaNextMap('E1M9', false)), 'E1M4');
    assert.equal(leadsTo(vanillaNextMap('E2M9', false)), 'E2M6');
    assert.equal(leadsTo(vanillaNextMap('E3M9', false)), 'E3M7');
    assert.equal(leadsTo(vanillaNextMap('E4M9', false)), 'E4M3');
  });

  test('a name in neither scheme has no vanilla rule', () => {
    // `unknown`, not `end`: `Game` advances in load order here, which is the one case that must
    // not be confused with the campaign being over.
    for (const name of ['TITLEMAP', 'MAP1', 'E1M10', '']) assert.equal(vanillaNextMap(name, false).kind, 'unknown');
  });
});

describe('WAD parsing · level progression', () => {
  const doom2 = () => new Wad(wadFile('IWAD', 'DOOM2.WAD', DOOM2_MAPS));

  test('follows the vanilla tables for a stock IWAD', () => {
    const progression = progressionFor(doom2(), DOOM2_MAPS.map((m) => m.name));
    assert.equal(leadsTo(progression.nextMap('MAP01', false)), 'MAP02');
    assert.equal(leadsTo(progression.nextMap('MAP15', true)), 'MAP31');
    assert.equal(leadsTo(progression.nextMap('MAP31', false)), 'MAP16');
    assert.deepEqual(
      progression.nextMap('MAP30', false),
      { kind: 'end', scope: 'campaign', next: null },
      'nothing follows the Icon of Sin',
    );
  });

  test('a secret exit the set cannot honour exits normally, as in the German edition', () => {
    // `G_SecretExitLevel`: no MAP31 lump, no secret exit — the switch still ends the level.
    const maps = DOOM2_MAPS.slice(0, 20).map((m) => m.name);
    const progression = progressionFor(new Wad(wadFile('IWAD', 'DOOM2.WAD', DOOM2_MAPS.slice(0, 20))), maps);
    assert.equal(leadsTo(progression.nextMap('MAP15', true)), 'MAP16');
  });

  test('MAPINFO overrides the vanilla table, in both spellings of the secret key', () => {
    const pwad = wadFile('PWAD', 'set.wad', [
      { name: 'MAPINFO', text: 'map MAP01 "One" { next = "MAP05" secretnext = "MAP07" }' },
      { name: 'MAP01' },
    ]);
    const umapinfo = wadFile('PWAD', 'other.wad', [
      { name: 'UMAPINFO', text: 'map MAP02 { levelname = "Two" next = MAP09 nextsecret = MAP11 }' },
      { name: 'MAP02' },
    ]);
    const wad = new Wad([wadFile('IWAD', 'DOOM2.WAD', DOOM2_MAPS), pwad, umapinfo]);
    const progression = progressionFor(wad, DOOM2_MAPS.map((m) => m.name));
    assert.equal(leadsTo(progression.nextMap('MAP01', false)), 'MAP05');
    assert.equal(leadsTo(progression.nextMap('MAP01', true)), 'MAP07');
    assert.equal(leadsTo(progression.nextMap('MAP02', false)), 'MAP09');
    assert.equal(leadsTo(progression.nextMap('MAP02', true)), 'MAP11');
    // Untouched maps keep the vanilla progression.
    assert.equal(leadsTo(progression.nextMap('MAP03', false)), 'MAP04');
  });

  test('reads the old brace-less ZDoom form', () => {
    const pwad = wadFile('PWAD', 'old.wad', [
      { name: 'MAPINFO', text: 'map MAP01 "One"\ncluster 1\nnext MAP04\nsecretnext MAP31\n\nmap MAP02 "Two"\nnext MAP03\n' },
      { name: 'MAP01' },
    ]);
    const progression = progressionFor(new Wad([wadFile('IWAD', 'DOOM2.WAD', DOOM2_MAPS), pwad]), DOOM2_MAPS.map((m) => m.name));
    assert.equal(leadsTo(progression.nextMap('MAP01', false)), 'MAP04');
    assert.equal(leadsTo(progression.nextMap('MAP01', true)), 'MAP31');
    assert.equal(leadsTo(progression.nextMap('MAP02', false)), 'MAP03');
  });

  test('ignores a next that names a map the set does not have', () => {
    const pwad = wadFile('PWAD', 'gone.wad', [
      { name: 'MAPINFO', text: 'map MAP02 "Two" { next = "MAP99" }' },
      { name: 'MAP02' },
    ]);
    const progression = progressionFor(new Wad([wadFile('IWAD', 'DOOM2.WAD', DOOM2_MAPS), pwad]), DOOM2_MAPS.map((m) => m.name));
    assert.equal(leadsTo(progression.nextMap('MAP02', false)), 'MAP03', 'falls through to the vanilla table');
  });

  test('a MAPINFO finale keyword ends the campaign, in both dialects', () => {
    const zdoom = wadFile('PWAD', 'zd.wad', [
      { name: 'MAPINFO', text: 'map MAP01 "One" { next = "EndGame" }\nmap MAP02 "Two" { next = EndPic }' },
      { name: 'MAP01' },
    ]);
    const umapinfo = wadFile('PWAD', 'um.wad', [
      { name: 'UMAPINFO', text: 'map MAP03 { levelname = "Three" endgame = true }\nmap MAP04 { next = MAP05 endgame = false }' },
      { name: 'MAP03' },
    ]);
    const progression = progressionFor(
      new Wad([wadFile('IWAD', 'DOOM2.WAD', DOOM2_MAPS), zdoom, umapinfo]),
      DOOM2_MAPS.map((m) => m.name),
    );
    // No map has to exist for a finale: the keyword names none.
    for (const map of ['MAP01', 'MAP02', 'MAP03']) {
      assert.deepEqual(progression.nextMap(map, false), { kind: 'end', scope: 'campaign', next: null }, map);
    }
    assert.equal(leadsTo(progression.nextMap('MAP04', false)), 'MAP05', 'endgame = false ends nothing');
  });

  test('a PWAD map set with no rule of its own runs out rather than guessing', () => {
    const maps = ['MAP01', 'MAP02'];
    const wad = new Wad(wadFile('PWAD', 'two.wad', maps.map((name) => ({ name }))));
    const progression = progressionFor(wad, maps);
    assert.equal(leadsTo(progression.nextMap('MAP01', false)), 'MAP02');
    assert.equal(progression.nextMap('MAP02', false).kind, 'unknown', 'MAP03 is not in the set');
  });

  test('DOOM episodes route through the loaded set', () => {
    const names = DOOM_MAPS.map((m) => m.name);
    const progression = progressionFor(new Wad(wadFile('IWAD', 'DOOM.WAD', DOOM_MAPS)), names);
    assert.equal(leadsTo(progression.nextMap('E1M3', true)), 'E1M9');
    assert.equal(leadsTo(progression.nextMap('E1M9', false)), 'E1M4');
    // The set has all four episodes, so an episode end carries on into the next one's first map.
    assert.deepEqual(progression.nextMap('E1M8', false), { kind: 'end', scope: 'episode', next: 'E2M1' });
    // Nothing follows the last one.
    assert.deepEqual(progression.nextMap('E4M8', false), { kind: 'end', scope: 'episode', next: null });
  });

  test('a one-episode set ends at E1M8 instead of naming an episode it does not have', () => {
    const maps = DOOM_MAPS.filter((m) => m.name.startsWith('E1'));
    const names = maps.map((m) => m.name);
    const progression = progressionFor(new Wad(wadFile('IWAD', 'DOOM1.WAD', maps)), names);
    assert.deepEqual(progression.nextMap('E1M8', false), { kind: 'end', scope: 'episode', next: null });
  });
});
