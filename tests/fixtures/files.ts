import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every file under `dir`, recursively, whose relative path `keep` accepts — the walker the
 * tree-wide guards in `tests/docs/` and `tests/ui/markup.test.ts` share. Paths come back as
 * `join(dir, …)` builds them, so a caller excluding itself compares against the same shape.
 * See docs/testing.md § Shared helpers.
 */
export function filesUnder(dir: string, keep: (path: string) => boolean = () => true, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}
