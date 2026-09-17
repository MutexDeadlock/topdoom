import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filesUnder } from '../fixtures/files.ts';

/**
 * Every top-level `describe` is named `Subject area · what it covers`, subject uppercase-first —
 * the shape that groups the run's output by subject. docs/testing.md § Layout and suite names.
 */

/** A top-level `describe(` and its quoted name; nested blocks, indented, may name themselves freely. */
const TOP_LEVEL = /^describe\((['"`])(.*?)\1/;

describe('Suite hygiene · describe names', () => {
  const named: string[] = [];
  const offenders: string[] = [];
  for (const path of filesUnder('tests', (p) => p.endsWith('.test.ts'))) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = TOP_LEVEL.exec(line);
        if (!m) return;
        named.push(m[2]);
        if (!/^[A-Z][^·]* · ./.test(m[2])) offenders.push(`${path}:${i + 1}  ${m[2]}`);
      });
  }

  test('the scan actually finds describes', () => {
    // A regex that quietly stopped matching would make the assertion below vacuous, and an empty
    // walk would too — this suite is the only thing holding the naming shape.
    assert.ok(named.length > 200, `only ${named.length} top-level describes found — the scan is broken`);
  });

  test('every top-level describe reads Subject · what, subject uppercase-first', () => {
    assert.deepEqual(offenders, [], 'name it `Subject · what it covers`');
  });
});
