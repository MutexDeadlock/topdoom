import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * `<!-- @include ./path/to/part.html -->` in `index.html`, so each UI module's markup can
 * sit beside its `.ts` and `.css` the way `styles.css`'s `@import`s already let its rules.
 * HTML has no include of its own; this is the build-time stand-in. See docs/styles.md §
 * One owner per element.
 */
const INCLUDE = /^([ \t]*)<!--\s*@include\s+(\S+)\s*-->[ \t]*$/gm;

/**
 * Expands every directive in `html`, depth-first, recording what it read into `seen` (which the
 * dev server watches). `stack` is the chain of files currently open — both the cycle check and
 * the error message, since an include cycle otherwise recurses until the stack blows.
 */
function expand(html: string, from: string, seen: Set<string>, stack: string[]): string {
  return html.replace(INCLUDE, (_all, indent: string, spec: string) => {
    const path = resolve(dirname(from), spec);
    if (stack.includes(path)) {
      const chain = [...stack, path].map((p) => relative(process.cwd(), p)).join(' → ');
      throw new Error(`[topdoom] @include cycle: ${chain}`);
    }
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      throw new Error(`[topdoom] ${relative(process.cwd(), from)}: @include ${spec} not found`);
    }
    seen.add(path);
    // The directive's own indentation carries to every line of what replaces it, so the
    // assembled page reads like it was written as one file — partials are authored at column 0.
    return expand(source.trimEnd(), path, seen, [...stack, path])
      .split('\n')
      .map((line) => (line === '' ? line : indent + line))
      .join('\n');
  });
}

/**
 * The whole page as the build assembles it, plus every partial that went into it. Exported
 * for `tests/ui/markup.test.ts`, which checks the ids modules look up against the result —
 * with the markup spread over one file per module, a dropped `@include` is otherwise silent
 * until a field initializer hands back `null`.
 */
export function assemblePage(entry = 'index.html'): { html: string; included: Set<string> } {
  const from = resolve(entry);
  const included = new Set<string>();
  return { html: expand(readFileSync(from, 'utf8'), from, included, [from]), included };
}

/**
 * Assembles `index.html` from the per-module partials it `@include`s. Runs before Vite's own
 * index processing, so anything a partial contributes is still resolved normally.
 *
 * Editing a partial is a full page reload rather than an HMR patch: partials aren't in the
 * module graph, and the elements they carry are looked up by id in module field initializers
 * anyway — swapping the markup under a live `Menu`/`Hud` would leave it holding dead nodes.
 */
export function htmlPartials(): Plugin {
  const included = new Set<string>();

  return {
    name: 'topdoom:html-partials',

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const from = resolve(ctx.filename);
        return expand(html, from, included, [from]);
      },
    },

    configureServer(server) {
      server.watcher.on('change', (path) => {
        if (included.has(resolve(path))) server.ws.send({ type: 'full-reload' });
      });
    },
  };
}
