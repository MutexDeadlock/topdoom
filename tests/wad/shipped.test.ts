import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGameWad } from '../../plugins/game-wad.ts';
import { SHIPPED_GLDEFS, SHIPPED_SECRET } from '../../src/wad/shipped.ts';
import { SpriteBank } from '../../src/wad/sprites.ts';
import { Wad, WadFile } from '../../src/wad/wad.ts';
import { PLAYER_WEAPON_SPRITES } from '../../src/render/playerskin.ts';

/**
 * The WAD the engine ships, as `plugins/game-wad.ts` builds it out of `assets/`. Nothing else
 * guards that build step — the file is generated, never committed — so these are the assertions
 * that catch a source the plugin folds in wrong. docs/wad.md § The WAD the engine ships.
 */
describe('The shipped WAD · what the build folds together', () => {
  const ASSETS = fileURLToPath(new URL('../../assets/', import.meta.url));
  const bytes = buildGameWad(ASSETS);
  const file = new WadFile(bytes.slice().buffer, 'topdoom.wad');
  const wad = new Wad(file);

  test('is a PWAD holding both text/sound lumps and the sprite block', () => {
    assert.equal(file.type, 'PWAD');
    assert.ok(wad.find(SHIPPED_GLDEFS));
    assert.ok(wad.find(SHIPPED_SECRET));
    for (const lump of wad.lumps) {
      assert.ok(lump.name.length <= 8, `${lump.name} is past the 8-character lump name limit`);
      assert.ok(lump.offset + lump.size <= bytes.length, `${lump.name} runs past the end of the file`);
    }
  });

  test('the sprite block holds the player art and nothing else', () => {
    // What keeps `SpriteBank` from ever indexing GLDEFS or the chime as a sprite frame: everything
    // but those two, and the two markers themselves, is inside the block.
    const marked = wad.markedRange(/^S_START$/, /^S_END$/);
    const outside = [SHIPPED_GLDEFS, SHIPPED_SECRET, 'S_START', 'S_END'];
    assert.equal(marked.length, wad.lumps.length - outside.length);
    for (const lump of marked) assert.match(lump.name, /^PLA[1-9][A-N][0-8]([A-N][0-8])?$/);

    const bank = new SpriteBank(wad);
    for (const sprite of Object.values(PLAYER_WEAPON_SPRITES)) {
      assert.ok(bank.lookup(sprite, 'A', 1), `${sprite}A has no rotation 1`);
    }
  });

  test('GLDEFS survives the round trip', () => {
    // Byte-identical to the source is the whole claim; that the source itself parses is
    // `tests/wad/gldefs.test.ts`'s.
    const source = readFileSync(new URL('gldefs.txt', `file://${ASSETS}`), 'latin1');
    assert.equal(new TextDecoder('latin1').decode(wad.data(wad.find(SHIPPED_GLDEFS)!)), source);
  });

  test('the secret chime is the Ogg file, byte for byte', () => {
    const source = readFileSync(new URL('secret.ogg', `file://${ASSETS}`));
    const lump = wad.data(wad.find(SHIPPED_SECRET)!);
    assert.equal(new TextDecoder('latin1').decode(lump.subarray(0, 4)), 'OggS');
    assert.deepEqual(Buffer.from(lump), source);
  });
});
