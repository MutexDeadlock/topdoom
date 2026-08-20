import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No test reads `public/wads/`. That directory is the game's own content — what
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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith('.ts') && path !== SELF) out.push(path);
  }
  return out;
}

describe('Suite hygiene · WAD fixtures', () => {
  test('no test file mentions public/wads', () => {
    const offenders: string[] = [];
    for (const path of walk('tests')) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes('public/wads') && !COMMENT.test(line)) offenders.push(`${path}:${i + 1}`);
        });
    }
    assert.deepEqual(offenders, [], 'read WAD bytes from tests/fixtures/wads/ instead');
  });

  test('every committed fixture is loaded by something', () => {
    const sources = walk('tests').map((path) => readFileSync(path, 'utf8'));
    // Both directories a test takes real bytes from: WAD fixtures, and the DEHACKED patches
    // lifted out as text (docs/testing.md § The DEHACKED fixtures).
    for (const dir of ['wads', 'dehacked']) {
      for (const file of readdirSync(join('tests', 'fixtures', dir))) {
        // Matched without the extension: `pinky.ts` builds its two names from a union, and
        // `dehFixture` takes `'epic' | 'freedoom2'`.
        const stem = file.replace(/\.(wad|deh)$/i, '');
        assert.ok(
          sources.some((source) => source.includes(stem)),
          `${dir}/${file} is committed but nothing loads it`,
        );
      }
    }
  });
});
