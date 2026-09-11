import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_COLOR_RAMPS,
  PLAYER_COLORS,
  asPlayerColor,
  slotColor,
  translatedPalette,
} from '../../src/wad/playercolor.ts';

/**
 * A player's armour colour is vanilla's translation of the green ramp onto another PLAYPAL ramp,
 * applied to the palette a bank decodes through. docs/sprites.md § Player colours.
 */

/** A palette whose entry `i` is `(i, i, i)`, so each index reads straight off its colour. */
const INDEXED = Uint8Array.from({ length: 768 }, (_, k) => Math.floor(k / 3));

describe('Player colours · the translated armour ramp', () => {
  test("gray, brown and red are R_InitTranslationTables' ramps for players 2-4", () => {
    for (const [color, base] of [['gray', 0x60], ['brown', 0x40], ['red', 0x20]] as const) {
      const palette = translatedPalette(INDEXED, color);
      for (let i = 0; i < 256; i++) {
        // `r_draw.c`: `translationtables[i] = 0x60 + (i&0xf)` over `0x70`-`0x7f`, `i` elsewhere.
        const want = i >= 0x70 && i <= 0x7f ? base + (i & 0xf) : i;
        assert.deepEqual([...palette.subarray(i * 3, i * 3 + 3)], [want, want, want], `${color}: index ${i}`);
      }
    }
    assert.equal(translatedPalette(INDEXED, 'green'), INDEXED, 'green is the palette itself');
  });

  test('every colour is a whole ramp inside the palette', () => {
    for (const color of PLAYER_COLORS) {
      assert.ok(PLAYER_COLOR_RAMPS[color] + 15 <= 0xff, color);
    }
  });

  test("a slot nobody picked for wears its player number's vanilla colour; an unknown name falls back", () => {
    assert.deepEqual([0, 1, 2, 3].map(slotColor), ['green', 'gray', 'brown', 'red']);
    assert.equal(asPlayerColor('blue', 'green'), 'blue');
    assert.equal(asPlayerColor('toString', 'red'), 'red', 'not a property of the ramp table');
    assert.equal(asPlayerColor(undefined, 'gray'), 'gray');
  });
});
