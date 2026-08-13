import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `docs/<name>.md § Heading` pointer in the tree has to resolve. CLAUDE.md's comment rule
 * puts each invariant in exactly one doc and leaves a pointer in the code, so a pointer that misses
 * is a rule nobody can find — which is what splitting the Icon of Sin's own doc out of the monster
 * AI one did to five of them. See docs/testing.md § Doc references.
 */

const ROOTS = ['src', 'tests', 'scripts', 'plugins'];
const CODE = /\.(ts|css)$/;
/** The two markdown files outside `docs/` that link into it — CLAUDE.md carries a whole table of links. */
const ROOT_DOCS = ['README.md', 'CLAUDE.md'];
/** This file's own doc comment quotes pointers as examples; scanning it would flag them. */
const SELF = join('tests', 'docs', 'references.test.ts');

/**
 * `docs/<name>.md`, plus everything after a `§` up to the end of the line. The name allows `-`
 * because related docs are grouped by a shared prefix (`monster-ai`, `monster-attacks`, …) rather
 * than by a subdirectory — a stricter class here would silently stop matching those and quietly
 * disable this whole test.
 */
const REFERENCE = /docs\/([a-z0-9-]+)\.md(?:\s*§\s*([^\n]*))?/g;
/** CLAUDE.md's comment rule spells the shape out as `docs/x.md § heading`; that one names no file. */
const PLACEHOLDER = 'docs/x.md';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(entry) && path !== SELF) out.push(path);
  }
  return out;
}

/** Heading text of every `#`-line in a doc, hashes and trailing whitespace stripped. */
function headingsOf(doc: string): string[] {
  return readFileSync(doc, 'utf8')
    .split('\n')
    .filter((line) => /^#+ /.test(line))
    .map((line) => line.replace(/^#+ /, '').trim());
}

const docHeadings = new Map<string, string[]>();
for (const entry of readdirSync('docs')) {
  if (entry.endsWith('.md')) docHeadings.set(`docs/${entry}`, headingsOf(`docs/${entry}`));
}

type Reference = { site: string; line: number; doc: string; heading: string };

/** Lowercase words, punctuation and comment syntax dropped, so the two sides compare cleanly. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * The words a pointer has to quote: a heading's own leading words, stopping before the parenthetical
 * file list most of them carry (`## Pausing (game.ts: pause, stillFrame, stop)`), which no pointer
 * repeats.
 */
function headingCore(heading: string): string[] {
  return words(heading.split('(')[0]);
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length > 0 && prefix.length <= of.length && prefix.every((w, i) => of[i] === w);
}

/**
 * A wrapped comment line with its leading ` * ` / `//` stripped, or empty when the next line isn't
 * one — a block comment's closing line, or the code after it, continues nothing.
 */
function continuationOf(line: string | undefined): string {
  return (line ?? '').match(/^\s*(?:\*(?!\/)|\/\/)\s?(.*)$/)?.[1] ?? '';
}

function references(): Reference[] {
  const found: Reference[] = [];
  for (const file of [...ROOTS.flatMap((r) => walk(r)), ...ROOT_DOCS]) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(REFERENCE)) {
        const doc = `docs/${m[1]}.md`;
        if (doc === PLACEHOLDER) continue;
        // A pointer regularly wraps mid-heading, so the next line joins the tail — but only when
        // there was a `§` to continue. A bare `docs/<name>.md` reference names no heading at all.
        const tail = m[2] === undefined ? '' : `${m[2]} ${continuationOf(lines[i + 1])}`.trim();
        found.push({ site: file, line: i + 1, doc, heading: tail });
      }
    });
  }
  return found;
}

describe('docs · every § pointer resolves', () => {
  const refs = references();

  test('the scan actually finds pointers', () => {
    // A regex that quietly stopped matching would make every assertion below vacuous.
    assert.ok(refs.length > 100, `only ${refs.length} doc references found — the scan is broken`);
    assert.ok(docHeadings.size > 10, `only ${docHeadings.size} docs found`);
  });

  test('every referenced doc file exists', () => {
    const missing = refs.filter((r) => !docHeadings.has(r.doc)).map((r) => `${r.site}:${r.line} -> ${r.doc}`);
    assert.deepEqual(missing, [], `dead doc references:\n${missing.join('\n')}`);
  });

  test('every § names a real heading', () => {
    // Word-prefix match in both directions, because both sides get shortened in practice: a pointer
    // may truncate a long heading (`§ The lost soul` for "The lost soul: a charge, not a
    // projectile"), and a pointer written mid-sentence trails off into prose. Either way the
    // pointer's leading words must be a real heading's leading words — and it must name a heading,
    // since a bold lead-in paragraph is not addressable.
    const missing = refs
      .filter((r) => r.heading && docHeadings.has(r.doc))
      .filter((r) => {
        const want = words(r.heading);
        // The truncation direction needs two words to mean anything: a pointer that wrapped after
        // "§ The" would otherwise match every heading starting with "The".
        return !docHeadings
          .get(r.doc)!
          .some((h) => isPrefix(headingCore(h), want) || (want.length > 1 && isPrefix(want, words(h))));
      })
      .map((r) => `${r.site}:${r.line} -> ${r.doc} § ${r.heading}`);
    assert.deepEqual(missing, [], `dead heading references:\n${missing.join('\n')}`);
  });
});
