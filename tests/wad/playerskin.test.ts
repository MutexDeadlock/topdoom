import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GraphicsBank } from '../../src/wad/graphics.ts';
import { SKIN_FLAT_FRAMES, SKIN_ROTATED_FRAMES, setDrawsOwnPlayer } from '../../src/wad/playerskin.ts';
import { resetSpriteLumps, setSpriteLump, SpriteBank } from '../../src/wad/sprites.ts';
import { Wad, WadFile } from '../../src/wad/wad.ts';
import { fixtureWad, wadFile } from '../fixtures/wadfile.ts';
import { PLAYER_WEAPON_SPRITES } from '../../src/render/playerskin.ts';

/**
 * The art the engine ships itself. Nothing else guards `scripts/build-playerskins.ts` — the pack it
 * converts is not in the repo — so these are the assertions that catch a rebuild against a partial
 * or re-encoded copy. docs/sprites.md § Weapon-matching player sprites.
 */
describe('Player skins · the shipped file', () => {
  // The source under `assets/`, which is sprites and nothing else; what the game fetches is the WAD
  // `plugins/game-wad.ts` folds this into (`tests/wad/shipped.test.ts`).
  const SKINS = fileURLToPath(new URL('../../assets/playerskins.wad', import.meta.url));
  const bytes = readFileSync(SKINS);
  const file = new WadFile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    'playerskins.wad',
  );
  const skins = new Wad(file);
  /** Every sprite lump lives between the markers, which is what `SpriteBank` indexes. */
  const marked = skins.markedRange(/^S_START$/, /^S_END$/);

  test('is a PWAD of nothing but sprite lumps, all inside S_START..S_END', () => {
    assert.equal(file.type, 'PWAD');
    assert.equal(marked.length, skins.lumps.length - 2);
    for (const lump of marked) {
      assert.match(lump.name, /^PLA[1-9][A-N][0-8]([A-N][0-8])?$/);
      assert.ok(lump.name.length <= 8, `${lump.name} is past the 8-character lump name limit`);
      assert.ok(lump.size > 8, `${lump.name} is too small to be a patch`);
    }
  });

  test('every weapon resolves at every frame the player animates', () => {
    const bank = new SpriteBank(skins);
    for (const sprite of Object.values(PLAYER_WEAPON_SPRITES)) {
      // Walk, attack and pain are directional; the death chain is rotation 0, as `PLAY`'s is.
      for (const letter of SKIN_ROTATED_FRAMES) {
        for (let digit = 1; digit <= 8; digit++) {
          assert.ok(bank.lookup(sprite, letter, digit), `${sprite}${letter} has no rotation ${digit}`);
        }
      }
      for (const letter of SKIN_FLAT_FRAMES) {
        assert.ok(bank.lookup(sprite, letter, 1), `${sprite}${letter} is missing`);
      }
    }
  });

  test('ships no palette of its own, and decodes through the loaded set’s', () => {
    // What the `GraphicsBank(wad, palette)` argument exists for: this file is palette indices with
    // no PLAYPAL, so a bank over it alone cannot read a thing.
    assert.throws(() => new GraphicsBank(skins), /PLAYPAL missing/);
    const gfx = new GraphicsBank(skins, new Uint8Array(768));
    const pistol = gfx.picture('PLA2A1');
    assert.ok(pistol);
    // The hotspots came out of the PNGs' `grAb` chunks — a sprite centred on its own bounding box
    // instead would stand off to one side of where it walks.
    assert.ok(pistol.left! > 0 && pistol.left! < pistol.width);
    assert.ok(pistol.top! > 0);
  });
});

/**
 * Which sets keep drawing the player themselves. A false positive is the safe direction — it only
 * leaves that set's own art alone — so the assertions that matter are the ones landing on `false`.
 */
describe('Player skins · whether a set draws its own player', () => {
  const vanilla = fixtureWad('doom1_player.wad');

  test('vanilla player art alone is not a set drawing its own player', () => {
    assert.equal(setDrawsOwnPlayer(new Wad(vanilla)), false);
  });

  test('a PWAD shipping PLAY sprites of its own is', () => {
    const pwad = wadFile('PWAD', 'skin.wad', ['S_START', { name: 'PLAYA1', text: 'x' }, 'S_END']);
    assert.equal(setDrawsOwnPlayer(new Wad([vanilla, pwad])), true);
  });

  test('a PWAD shipping only a palette is not — the rotation digit is what keeps PLAYPAL out', () => {
    const pwad = wadFile('PWAD', 'pal.wad', [{ name: 'PLAYPAL', text: 'not really a palette' }]);
    assert.equal(setDrawsOwnPlayer(new Wad([vanilla, pwad])), false);
  });

  test('a game WAD whose own marine is not vanilla’s is — this is what leaves Freedoom alone', () => {
    const own = wadFile('IWAD', 'other.wad', [
      'S_START',
      { name: 'PLAYA1', text: 'its own marine' },
      { name: 'PLAYE1', text: 'its own marine' },
      'S_END',
    ]);
    assert.equal(setDrawsOwnPlayer(new Wad(own)), true);
  });

  test('a DEHACKED [SPRITES] rename of PLAY is', () => {
    try {
      setSpriteLump('PLAY', 'ZOMB');
      assert.equal(setDrawsOwnPlayer(new Wad(vanilla)), true);
    } finally {
      resetSpriteLumps();
    }
  });
});
