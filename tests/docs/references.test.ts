import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesUnder } from '../fixtures/files.ts';

/**
 * Every `docs/<name>.md § Heading` pointer in the tree has to resolve — in `docs/` itself as much
 * as in the code, one doc pointing at another's heading being the same pointer. CLAUDE.md's
 * comment rule puts each invariant in exactly one doc and leaves a pointer at the code, so a
 * pointer that misses is a rule nobody can find — which is what splitting the Icon of Sin's own
 * doc out of the monster AI one did to five of them. See docs/testing.md § Doc references.
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

/**
 * The same for a doc: the rest of the paragraph. A blank line, a heading and a table row each end
 * one, and a table row is a cell rather than prose — the next row continues nothing.
 */
function paragraphOf(line: string | undefined): string {
  const next = line ?? '';
  return next.trim() === '' || next.startsWith('#') || next.startsWith('|') ? '' : next;
}

/**
 * What a pointer names, from its `§` to wherever the reference ends. **A closing `)` ends it**:
 * a pointer written inside parentheses stops there, and no pointer repeats the file list a heading
 * carries (`headingCore` drops that), so nothing real is cut. Only a tail left open takes the next
 * line, which is what lets a pointer wrap mid-heading — `docs/savegames.md`'s
 * `§ Slot keys),` would otherwise read the sentence after it as more of the heading.
 */
function headingTail(rest: string, next: string | undefined, inDoc: boolean): string {
  const continued = inDoc ? paragraphOf(next) : continuationOf(next);
  const joined = rest.includes(')') ? rest : `${rest} ${continued}`;
  const end = joined.indexOf(')');
  return (end >= 0 ? joined.slice(0, end) : joined).trim();
}

/**
 * A `§ Heading` written with no file in front of it points *inside its own doc*, and splitting a
 * long doc into a family is exactly what turns those into dangling pointers — `docs/specials.md`
 * kept a `§ Boss death below` for a section that lives in `docs/death.md`, which the scan above
 * never saw because it only reads pointers that name a file.
 */
function localReferences(): Reference[] {
  const found: Reference[] = [];
  /** A file name in front of the `§` — a doc, CLAUDE.md, or a test file whose `describe` it names. */
  const PATH = /([A-Za-z0-9_./-]+\.(?:md|ts))`?\s*$/;
  /** The UDMF spec's own sections are numbered this way; nothing in `docs/` is. */
  const EXTERNAL = /^(?:I|II|III|IV|V)\b/;
  for (const doc of docHeadings.keys()) {
    const lines = readFileSync(doc, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(/§/g)) {
        const before = text.slice(0, m.index);
        if (before.split('`').length % 2 === 0) continue;             // inside a code span
        // The file this `§` resolves against: one written in front of it, one at the end of the
        // line it wrapped from, or the one an earlier `§` named — a list like "docs/x.md § A, § B"
        // states the file once, and only while no `.`, `)` or `;` has closed that clause since.
        const window = `${lines[i - 1] ?? ''}\n${before}`;
        const last = [...window.matchAll(/([A-Za-z0-9_./-]+\.md)`?\s*§/g)].pop();
        const listed = last && !/[.);]/.test(window.slice(last.index + last[0].length));
        const named = PATH.exec(before)?.[1]
          ?? (before.trim() === '' ? PATH.exec(lines[i - 1] ?? '')?.[1] : undefined)
          ?? (listed ? last[1] : undefined);
        if (named && !docHeadings.has(named)) continue;               // a test file's describe name
        const tail = headingTail(text.slice(m.index + 1), lines[i + 1], true);
        if (EXTERNAL.test(tail)) continue;
        found.push({ site: doc, line: i + 1, doc: named ?? doc, heading: tail });
      }
    });
  }
  return found;
}

function references(): Reference[] {
  const scan = (root: string) => filesUnder(root, (path) => CODE.test(path) && path !== SELF);
  const code = ROOTS.flatMap(scan);
  const found: Reference[] = [];
  for (const file of [...code, ...ROOT_DOCS, ...docHeadings.keys()]) {
    const inDoc = docHeadings.has(file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(REFERENCE)) {
        const doc = `docs/${m[1]}.md`;
        if (doc === PLACEHOLDER) continue;
        // A bare `docs/<name>.md` reference names no heading at all; anything after a `§` runs to
        // wherever `headingTail` decides the reference ends.
        const tail = m[2] === undefined ? '' : headingTail(m[2], lines[i + 1], inDoc);
        found.push({ site: file, line: i + 1, doc, heading: tail });
      }
    });
  }
  return found;
}

describe('Suite hygiene · every § pointer resolves', () => {
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

  test('every bare § names a heading in its own doc', () => {
    const local = localReferences();
    assert.ok(local.length > 20, `only ${local.length} bare pointers found — the scan is broken`);
    const missing = local
      .filter((r) => r.heading)
      .filter((r) => {
        const want = words(r.heading);
        return !docHeadings
          .get(r.doc)!
          .some((h) => isPrefix(headingCore(h), want) || (want.length > 1 && isPrefix(want, words(h))));
      })
      .map((r) => `${r.site}:${r.line} -> § ${r.heading}`);
    assert.deepEqual(missing, [], `bare § pointing outside its own doc:\n${missing.join('\n')}`);
  });
});
