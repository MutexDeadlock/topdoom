/**
 * Fake `Input`s, in the two shapes the engine asks for. `Player.update` asks its input for nothing
 * but `held`: `heldInput`/`IDLE_INPUT`. `SpecialsController.update` and
 * `WeaponSystem.handleSwitching` ask for `pressed`/`rightMousePressed`: `NO_INPUT`, `USE_INPUT`,
 * `PREV_WEAPON_INPUT`. A test takes one of these rather than casting its own object literal. See
 * docs/testing.md § The specials rig.
 */
import type { Input } from '../../src/game/input.ts';

/** An input holding exactly `keys` and nothing else, so `getAutorun`'s run speed applies. */
export function heldInput(...keys: string[]): Input {
  return { held: (...asked: string[]) => asked.some((key) => keys.includes(key)) } as unknown as Input;
}

/** Nothing held — a player left to settle under gravity and friction. */
export const IDLE_INPUT = heldInput();

/** Nothing pressed, nothing clicked — the input a test that isn't about the use key wants. */
export const NO_INPUT = { pressed: () => false, rightMousePressed: () => false } as unknown as Input;

/** The use key held — what a test drives a switch or manual door with. */
export const USE_INPUT = { pressed: (k: string) => k === 'Space', rightMousePressed: () => false } as unknown as Input;

/** The right button on its "switch to previous weapon" binding, nothing else pressed. */
export const PREV_WEAPON_INPUT = {
  pressed: () => false,
  rightMousePressed: (a: string) => a === 'previousweapon',
} as unknown as Input;
