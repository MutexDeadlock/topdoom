import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapInfoNames } from '../../src/wad/mapinfo.ts';

/**
 * The MAPINFO reader only ever pulls one thing out of a lump — each map's level name — so these
 * cover the four syntaxes that carry one and the ways a lump can hide it: comments, property
 * blocks that have to be walked past, and `lookup` entries that name no literal at all.
 * See docs/wad.md § Level names.
 */
describe('WAD parsing · MAPINFO level names', () => {
  test('reads the ZDoom form, with and without a property block', () => {
    // Verbatim from public/wads/pwad/faulers_first_map.wad, the repo's own MAPINFO sample.
    const names = parseMapInfoNames(`
defaultmap
{
	NoJump
	NoCrouch
}

map map01 "Faulers First"
{
	Sky1 = "SKYANTRA"
	Next = "MAP02"
	Par = 55
}

map MAP02 "Bare Old Syntax"
cluster 1
sky1 SKY1 0
`);
    assert.deepEqual([...names], [
      ['MAP01', 'Faulers First'],
      ['MAP02', 'Bare Old Syntax'],
    ]);
  });

  test('reads UMAPINFO levelname out of a property block', () => {
    const names = parseMapInfoNames('map MAP07 { levelname = "Dead Simple" author = "id" }');
    assert.equal(names.get('MAP07'), 'Dead Simple');
  });

  test('normalizes Hexen-format numeric map names', () => {
    const names = parseMapInfoNames('map 4 "Four"\nmap 12 "Twelve"');
    assert.equal(names.get('MAP04'), 'Four');
    assert.equal(names.get('MAP12'), 'Twelve');
  });

  test('skips lookup entries, which name no literal', () => {
    const names = parseMapInfoNames('map MAP01 lookup HUSTR_1\nmap MAP02 lookup "HUSTR_2"\nmap MAP03 "Real"');
    assert.deepEqual([...names.keys()], ['MAP03'], 'only the literal-named map is known');
  });

  test('ignores comments but not slashes inside a title', () => {
    const names = parseMapInfoNames(`
// map MAP01 "Commented Out"
map MAP19 "shipping/respawning" /* TNT's own title has a slash in it */
/*
map MAP02 "Also Commented Out"
*/
`);
    assert.deepEqual([...names], [['MAP19', 'shipping/respawning']]);
  });

  test('a nested block cannot be mistaken for the next map', () => {
    // `map` appearing as a property name inside a block used to be a plausible way to lose the
    // rest of the file; the block scan walks the braces rather than the keyword.
    const names = parseMapInfoNames(`
map MAP01 "First" { specialaction { map = "MAP02" } }
map MAP03 "Third"
`);
    assert.deepEqual([...names], [
      ['MAP01', 'First'],
      ['MAP03', 'Third'],
    ]);
  });

  test('a lump with no map entries yields nothing', () => {
    assert.equal(parseMapInfoNames('gameinfo { titlepage = "TITLEPIC" }').size, 0);
  });
});
