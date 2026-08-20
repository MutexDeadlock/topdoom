/**
 * The two real DEHACKED lumps the parser is exercised against, as text rather than as WADs: the
 * parser is a pure function of a string, so a committed `.deh` reads in a diff where a WAD does
 * not. Both were lifted out of `public/wads/`, which a test may never read directly.
 * See docs/testing.md § The fixtures.
 */
import { readFileSync } from 'node:fs';

/** `latin1`, matching `readDehacked`: EPIC.WAD's level titles carry bytes above 0x7f. */
export function dehFixture(name: 'epic' | 'freedoom2'): string {
  return readFileSync(new URL(`./dehacked/${name}.deh`, import.meta.url), 'latin1');
}

/** The same bytes, for the tests that put a fixture through `wadFile` as a real lump. */
export function dehFixtureBytes(name: 'epic' | 'freedoom2'): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./dehacked/${name}.deh`, import.meta.url)));
}
