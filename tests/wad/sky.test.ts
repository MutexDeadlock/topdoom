import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { vanillaSkyTexture } from '../../src/wad/campaign/sky.ts';
import { MapInfo } from '../../src/wad/campaign/mapinfo.ts';
import { Wad } from '../../src/wad/wad.ts';
import { wadFile } from '../fixtures/wadfile.ts';

/**
 * Which sky a level stands under — `g_game.c: G_InitNew`, where DOOM II switches by map number and
 * DOOM by episode. See docs/wad.md § The sky texture.
 */

describe('WAD parsing · the sky texture', () => {
  test('DOOM II switches sky at maps 12 and 21', () => {
    for (const name of ['MAP01', 'MAP07', 'MAP11']) assert.equal(vanillaSkyTexture(name), 'SKY1');
    for (const name of ['MAP12', 'MAP15', 'MAP20']) assert.equal(vanillaSkyTexture(name), 'SKY2');
    for (const name of ['MAP21', 'MAP30', 'MAP32']) assert.equal(vanillaSkyTexture(name), 'SKY3');
  });

  test('an episode takes its own number', () => {
    assert.equal(vanillaSkyTexture('E1M1'), 'SKY1');
    assert.equal(vanillaSkyTexture('E2M9'), 'SKY2');
    assert.equal(vanillaSkyTexture('E3M4'), 'SKY3');
    assert.equal(vanillaSkyTexture('E4M2'), 'SKY4');
  });

  test('an episode past the last one clamps rather than naming a texture no WAD has', () => {
    assert.equal(vanillaSkyTexture('E5M1'), 'SKY4');
    assert.equal(vanillaSkyTexture('E9M9'), 'SKY4');
  });

  test("a PWAD's own naming falls back to the one texture every set has", () => {
    assert.equal(vanillaSkyTexture('LEVEL01'), 'SKY1');
    assert.equal(vanillaSkyTexture(''), 'SKY1');
  });

  test('the name is read case-insensitively, as lump names are', () => {
    assert.equal(vanillaSkyTexture('map21'), 'SKY3');
    assert.equal(vanillaSkyTexture('e2m1'), 'SKY2');
  });
});

/** The set's own MAPINFO overrides the name rule above — `game.ts` prefers it where the WAD has it. */
describe('WAD parsing · a MAPINFO sky', () => {
  const skiesOf = (text: string, lump = 'MAPINFO') =>
    new MapInfo(new Wad([wadFile('PWAD', 'set.wad', [{ name: lump, text }, 'MAP01'])])).skies();

  test("ZDoom's sky1 is read, scroll speed and all", () => {
    // Quoted from GoingDown.wad's own MAPINFO, whose brace-less form writes the speed after the
    // name — and whose value is the key's own name, which a token-by-token walk reads twice.
    const skies = skiesOf('map MAP01 "Going Up"\nnext MAP02\nsky1 SKY1 0\nmusic D_RUNNIN');
    assert.equal(skies.get('MAP01'), 'SKY1');
  });

  test('the value after a key is not read as a key of its own', () => {
    const skies = skiesOf('map MAP01 "One"\nsky1 SKY1 0\nmusic D_E1M1');
    assert.equal(skies.get('MAP01'), 'SKY1', 'the scroll speed must not become the sky');
    const entry = new MapInfo(
      new Wad([wadFile('PWAD', 'set.wad', [{ name: 'MAPINFO', text: 'map MAP01 "One"\nsky1 SKY1 0\nmusic D_E1M1' }, 'MAP01'])]),
    ).entry('MAP01');
    assert.equal(entry?.music, 'D_E1M1', 'and the property after it still reads');
  });

  test('the block form and quoted values read the same', () => {
    assert.equal(skiesOf('map MAP01 "One" { Sky1 = "SKYANTRA" Next = "MAP02" }').get('MAP01'), 'SKYANTRA');
  });

  test("UMAPINFO's skytexture is the same field", () => {
    assert.equal(skiesOf('map MAP01 { levelname = "One" skytexture = "RSKY1" }', 'UMAPINFO').get('MAP01'), 'RSKY1');
  });

  test('a set that names no sky leaves the vanilla rule alone', () => {
    assert.equal(skiesOf('map MAP01 "One" { next = "MAP02" }').get('MAP01'), undefined);
  });

  test('a finale key still stands on its own', () => {
    // `endgame` takes no value, so the property after it must not be swallowed as one.
    const entry = new MapInfo(
      new Wad([wadFile('PWAD', 'set.wad', [{ name: 'UMAPINFO', text: 'map MAP01 { endgame = true music = D_END }' }, 'MAP01'])]),
    ).entry('MAP01');
    assert.equal(entry?.music, 'D_END');
  });
});
