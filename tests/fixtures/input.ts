/**
 * Fake `Input`s for tests that drive `Player.update`, which asks its input for nothing but `held`.
 * The specials rig has its own `pressed`-shaped stubs (`specialsrig.ts`'s `NO_INPUT`/`USE_INPUT`)
 * for the use key; these are the movement half. See docs/testing.md.
 */
import type { Input } from '../../src/game/input.ts';

/** An input holding exactly `keys` and nothing else, so `getAutorun`'s run speed applies. */
export function heldInput(...keys: string[]): Input {
  return { held: (...asked: string[]) => asked.some((key) => keys.includes(key)) } as unknown as Input;
}

/** Nothing held — a player left to settle under gravity and friction. */
export const IDLE_INPUT = heldInput();
