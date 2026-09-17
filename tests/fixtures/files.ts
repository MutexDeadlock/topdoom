import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The file walker the tree-wide guards in `tests/docs/` and `tests/ui/markup.test.ts` share, and
 * the source scanner the four "nothing in `src/` calls this" guards share.
 * See docs/testing.md § Shared helpers.
 */

/**
 * Every file under `dir`, recursively, whose relative path `keep` accepts. Paths come back as
 * `join(dir, …)` builds them, so a caller excluding itself compares against the same shape.
 */
export function filesUnder(dir: string, keep: (path: string) => boolean = () => true, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

/**
 * `file:line Math.x(` for every match of `pattern` in `files`, so a guard's failure names the call
 * site rather than just the file it is in. `pattern` must carry `g`.
 */
export function callsIn(files: readonly string[], pattern: RegExp): string[] {
  const out: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      out.push(`${file}:${source.slice(0, match.index).split('\n').length} ${match[0].trim()}`);
    }
  }
  return out;
}
