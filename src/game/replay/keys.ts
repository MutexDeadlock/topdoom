/**
 * The key codes a simulation tic can ask `TicInput.held`/`pressed` about, and the bit each one
 * takes in a replay's per-tic masks. A code missing here would be recorded as never pressed —
 * `tests/game/replay-keys.test.ts` pins the table against every literal the tree asks for.
 * docs/replays.md § The record.
 */
import type { TicInput } from '../input.ts';

/** Bit order is the format: never reorder, only append. */
export const BOUND_KEYS: readonly string[] = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
  'KeyQ',
  'KeyE',
  'Space',
  'Enter',
  'KeyR',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'KeyN',
  'KeyP',
  'Equal',
  'NumpadAdd',
  'Minus',
  'NumpadSubtract',
  'BracketLeft',
  'BracketRight',
];

const KEY_BIT: ReadonlyMap<string, number> = new Map(BOUND_KEYS.map((code, i) => [code, i]));

/** Bit `i` set for every `BOUND_KEYS[i]` currently held. */
export function heldMask(input: TicInput): number {
  return mask((code) => input.held(code));
}

/** Bit `i` set for every `BOUND_KEYS[i]` that went down this tic. */
export function pressedMask(input: TicInput): number {
  return mask((code) => input.pressed(code));
}

/** Whether `code`'s bit is set; a code outside the table is never set. */
export function maskHas(mask: number, code: string): boolean {
  const bit = KEY_BIT.get(code);
  return bit !== undefined && (mask & (1 << bit)) !== 0;
}

/** Bit `i` set for every `BOUND_KEYS[i]` that `read` answers true for — the format's bit order. */
function mask(read: (code: string) => boolean): number {
  let mask = 0;
  for (let i = 0; i < BOUND_KEYS.length; i++) {
    if (read(BOUND_KEYS[i])) mask |= 1 << i;
  }
  return mask;
}
