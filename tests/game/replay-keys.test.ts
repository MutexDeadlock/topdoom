import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOUND_KEYS, heldMask, maskHas, pressedMask } from '../../src/game/replay/keys.ts';
import type { TicInput } from '../../src/game/input.ts';
import { filesUnder } from '../fixtures/files.ts';

/**
 * A replay records held and pressed keys as bit masks over `BOUND_KEYS`; a code the simulation
 * asks about that is missing from the table would be recorded as never pressed.
 * See docs/replays.md § The record.
 */

describe('Replays · the key table', () => {
  test('every code the tree asks held() or pressed() about is in the table', () => {
    const asked = new Set<string>();
    for (const path of filesUnder('src', (p) => p.endsWith('.ts'))) {
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(/\.(?:held|pressed)\(([^)]*)\)/g)) {
        for (const literal of m[1].matchAll(/'([A-Za-z0-9]+)'/g)) asked.add(literal[1]);
      }
    }
    assert.ok(asked.size > 5, 'the scan found the movement keys');
    const missing = [...asked].filter((code) => !BOUND_KEYS.includes(code));
    assert.deepEqual(missing, [], 'add to BOUND_KEYS (append — the bit order is the format)');
  });

  test('the weapon slots are listed even though weapons.ts builds their codes from a template', () => {
    for (let i = 1; i <= 7; i++) assert.ok(BOUND_KEYS.includes(`Digit${i}`));
  });

  test('the table fits one signed 32-bit mask', () => {
    assert.ok(BOUND_KEYS.length <= 31);
    assert.equal(new Set(BOUND_KEYS).size, BOUND_KEYS.length, 'no code twice');
  });

  test('a mask round-trips exactly the codes that were held or pressed', () => {
    const input = {
      held: (...codes: string[]) => codes.some((c) => c === 'KeyW' || c === 'BracketRight'),
      pressed: (code: string) => code === 'Space',
    } as unknown as TicInput;
    const held = heldMask(input);
    const pressed = pressedMask(input);
    for (const code of BOUND_KEYS) {
      assert.equal(maskHas(held, code), code === 'KeyW' || code === 'BracketRight', code);
      assert.equal(maskHas(pressed, code), code === 'Space', code);
    }
    assert.equal(maskHas(held, 'KeyZ'), false, 'a code outside the table is never set');
  });
});
