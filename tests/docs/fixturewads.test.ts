import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesUnder } from '../fixtures/files.ts';

/**
 * No test reads `public/game/`. That directory is the game's own content — what
 * a player drops WADs into — so a test reaching into it couples the suite to
 * the shipped set, and a WAD added or removed there for gameplay reasons breaks
 * tests that have nothing to do with it. Real WAD bytes come from
 * `tests/fixtures/wads/`. See docs/testing.md § WAD-backed tests.
 *
 * What is banned is a *read*, so comment lines are skipped: naming the
 * directory in prose is how a fixture records what it was lifted out of.
 */

/** A line whose first non-space character opens or continues a comment — prose, not a path a test reads. */
const COMMENT = /^\s*(\/\/|\/?\*)/;

/** This file spells the banned path out in code; scanning it would flag itself, as `references.test.ts` is too. */
const SELF = join('tests', 'docs', 'fixturewads.test.ts');

/** Every `.ts` under `tests/`, this file excepted. */
const testSources = (): string[] => filesUnder('tests', (path) => path.endsWith('.ts') && path !== SELF);

describe('Suite hygiene · WAD fixtures', () => {
  test('no test file mentions public/game', () => {
    const offenders: string[] = [];
    for (const path of testSources()) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes('public/game') && !COMMENT.test(line)) {
            offenders.push(`${path}:${i + 1}`);
          }
        });
    }
    assert.deepEqual(offenders, [], 'read WAD bytes from tests/fixtures/wads/ instead');
  });

  test('every committed fixture is loaded by something', () => {
    // Code lines only, on the same rule as the test above: a fixture named in a comment as where
    // something was lifted out of is not a fixture anything loads.
    const code = testSources().map((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !COMMENT.test(line))
        .join('\n'),
    );
    const unloaded: string[] = [];
    // Both directories a test takes real bytes from: WAD fixtures, and the DEHACKED patches
    // lifted out as text (docs/testing.md § The DEHACKED fixtures).
    for (const dir of ['wads', 'dehacked']) {
      const files = readdirSync(join('tests', 'fixtures', dir));
      for (const file of files) {
        // Matched without the extension: `pinky.ts` builds its two names from a union, and
        // `dehFixture` takes `'epic' | 'freedoom2'`. A stem that is a prefix of another fixture's
        // (`doom1_e1m1` of `doom1_e1m1_xgl`) would otherwise be satisfied by that one alone, so
        // those are matched with the extension the loader would have written.
        const stem = file.replace(/\.(wad|deh)$/i, '');
        const nested = files.some((other) => other !== file && other.startsWith(stem));
        const want = nested ? file : stem;
        if (!code.some((source) => source.includes(want))) unloaded.push(`${dir}/${file}`);
      }
    }
    assert.deepEqual(unloaded, [], `committed but nothing loads them:\n${unloaded.join('\n')}`);
  });
});
