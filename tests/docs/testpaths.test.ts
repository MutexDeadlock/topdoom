import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { filesUnder } from '../fixtures/files.ts';

/**
 * Every `<name>.test.ts` a doc or a comment names has to exist, and where the pointer spells the
 * directory out that path has to be the real one. The docs name test files constantly — which
 * fixture a suite uses, which file pins a rule, which regression a repro belongs to — and moving a
 * suite between `tests/regression/` and the directory it mirrors leaves every one of those
 * pointing at nothing, with nothing to notice. The sibling of
 * `tests/docs/references.test.ts`, for file paths rather than `§` headings.
 * See docs/testing.md § Doc references.
 */

const ROOTS = ['src', 'tests', 'scripts', 'plugins', 'docs'];
const SCANNED = /\.(ts|css|md)$/;
/** The two markdown files outside `docs/` that name test files. */
const ROOT_DOCS = ['README.md', 'CLAUDE.md'];
/** This file's own doc comment names a test file as an example; scanning it would flag it. */
const SELF = join('tests', 'docs', 'testpaths.test.ts');

/** A test file, with the directory it was named with where the pointer spelled one out. */
const POINTER = /(tests\/[a-z0-9-]+\/)?([a-z0-9-]+\.test\.ts)/g;

interface Pointer {
  site: string;
  line: number;
  /** As written, so the failure message is greppable. */
  text: string;
  dir: string | undefined;
  file: string;
}

describe('Suite hygiene · every test file a pointer names exists', () => {
  const tests = filesUnder('tests', (path) => path.endsWith('.test.ts'));
  const byName = new Map<string, string[]>();
  for (const path of tests) {
    const name = basename(path);
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }

  const pointers: Pointer[] = [];
  for (const file of [...ROOTS.flatMap((root) => filesUnder(root, SCANNED.test.bind(SCANNED))), ...ROOT_DOCS]) {
    if (file === SELF) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        for (const m of text.matchAll(POINTER)) {
          pointers.push({ site: file, line: i + 1, text: m[0], dir: m[1], file: m[2] });
        }
      });
  }

  test('the scan actually finds pointers', () => {
    // A regex that quietly stopped matching would make both assertions below vacuous.
    assert.ok(pointers.length > 50, `only ${pointers.length} test-file pointers found — the scan is broken`);
    assert.ok(byName.size > 100, `only ${byName.size} test files found`);
  });

  test('every named test file exists somewhere under tests/', () => {
    const missing = pointers
      .filter((p) => !byName.has(p.file))
      .map((p) => `${p.site}:${p.line} -> ${p.text}`);
    assert.deepEqual(missing, [], `pointers at test files that do not exist:\n${missing.join('\n')}`);
  });

  test('a pointer that spells out the directory names the real one', () => {
    const moved = pointers
      .filter((p) => p.dir !== undefined && byName.has(p.file))
      .filter((p) => !byName.get(p.file)!.includes(p.dir + p.file))
      .map((p) => `${p.site}:${p.line} -> ${p.text}, which lives at ${byName.get(p.file)!.join(', ')}`);
    assert.deepEqual(moved, [], `pointers naming the wrong directory:\n${moved.join('\n')}`);
  });
});
