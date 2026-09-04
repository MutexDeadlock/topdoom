/**
 * Reading a `ThingsSnapshot` in a test. A save carries only the things the run moved on from
 * (docs/savegames.md § The format and its version), so a test that wants one asks by id rather
 * than indexing a list.
 */
import type { ThingsSnapshot, ThingState } from '../../src/game/snapshot.ts';

/** What the save says about thing `id`, or undefined where it is still as the map spawned it. */
export function savedThing(things: ThingsSnapshot, id: number): ThingState | undefined {
  return things.changed.find(([i]) => i === id)?.[1];
}

/** The same, for a thing the test has already established the run changed. */
export function changedThing(things: ThingsSnapshot, id: number): ThingState {
  const state = savedThing(things, id);
  if (!state) throw new Error(`thing ${id} is still exactly as the map spawned it`);
  return state;
}
