import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemblePage } from '../../plugins/html-partials.ts';
import { filesUnder } from '../fixtures/files.ts';

/**
 * Every id a module looks up has to exist in the assembled page, and every id in the markup has
 * to be reached by something. The markup is one `.html` per owning module now (docs/styles.md §
 * One owner per element), so a dropped `@include` takes a whole panel out of the page while the
 * build stays green — the failure only shows up as a `null` field in a module's initializers,
 * which is exactly where it is hardest to read.
 */

const SRC = 'src';
/** `document.getElementById('x')`, and the `el<T>('x')` helper `menu.ts`/`savegames.ts` wrap it in. */
const LOOKUP = /(?:getElementById|\bel)\s*(?:<[^()]*?>)?\s*\(\s*'([^']+)'/g;
const ID = /\bid="([^"]+)"/g;
/** `#some-id` anywhere in a stylesheet, and `'#some-id ...'` selectors in code. */
const SELECTOR = /#([a-zA-Z][\w-]*)/g;

function matches(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]);
}

const { html, included } = assemblePage();
const markupIds = new Set(matches(html, ID));

const code = filesUnder(SRC, (path) => /\.ts$/.test(path)).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const styles = filesUnder(SRC, (path) => /\.css$/.test(path)).map((path) => readFileSync(path, 'utf8'));

describe('UI markup · ids and partials', () => {
  test('every id a module looks up exists in the assembled page', () => {
    const missing: string[] = [];
    for (const { path, text } of code) {
      for (const id of matches(text, LOOKUP)) {
        if (!markupIds.has(id)) missing.push(`${path}: #${id}`);
      }
    }
    assert.deepEqual(missing, [], `looked up but not in the markup:\n${missing.join('\n')}`);
  });

  test('every id in the markup is reached from code or a stylesheet', () => {
    const reached = new Set([
      ...code.flatMap(({ text }) => [...matches(text, LOOKUP), ...matches(text, SELECTOR)]),
      ...styles.flatMap((text) => matches(text, SELECTOR)),
    ]);
    const orphans = [...markupIds].filter((id) => !reached.has(id));
    assert.deepEqual(orphans, [], `in the markup but nothing reaches them:\n${orphans.join('\n')}`);
  });

  test('every partial beside a UI module is included in the page', () => {
    const onDisk = filesUnder('src/ui', (path) => /\.html$/.test(path)).map((path) => join(process.cwd(), path));
    const pulled = [...included];
    const dropped = onDisk.filter((path) => !pulled.includes(path));
    assert.deepEqual(dropped, [], `partials nothing @includes:\n${dropped.join('\n')}`);
  });
});
