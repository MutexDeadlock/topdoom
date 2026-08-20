import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * Reading a DEHACKED patch must not drag the applier in behind it. The menu's WAD library and the
 * build-time manifest plugin want a patch's text — level titles, par times — and have no `Game`;
 * `dehacked/apply.ts` pulls every game table and `structuredClone`s all of them at import. That is
 * why the layer has two entry points instead of one. See docs/dehacked.md § The two entry points.
 *
 * ES re-exports are eager, so this is a property of the import graph rather than of any call: one
 * `export { applyDehacked } from './dehacked/apply.ts'` in `game/dehacked.ts` puts it back.
 */

const APPLIER = normalize('src/game/dehacked/apply.ts');

/** Line and block comments, so a path inside a doc comment is not read as an edge. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every module the given file imports **at runtime**, as tree-relative paths.
 *
 * `import type` / `export type` are dropped: TypeScript erases them, so they cost nothing at load
 * and are exactly how `dehacked/tables.ts` names `WeaponId` without depending on `inventory.ts`.
 * A mixed `import { type A, B }` is still an edge — the module is loaded for `B`.
 */
function edgesOf(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const out: string[] = [];
  // `[^;]` cannot cross a statement end, which keeps a multi-line specifier list from running on.
  for (const [, , isType, spec] of source.matchAll(/\b(import|export)\b(\s+type\b)?[^;]*?\bfrom\s*'([^']+)'/g)) {
    if (isType || !spec.startsWith('.')) continue;
    out.push(normalize(join(dirname(file), spec)));
  }
  // Side-effect imports (`import './x.ts'`) carry no specifier list but still load the module.
  for (const [, spec] of source.matchAll(/\bimport\s*'([^']+)'/g)) {
    if (spec.startsWith('.')) out.push(normalize(join(dirname(file), spec)));
  }
  return out;
}

/** Every module reachable from `entry` through runtime imports, `entry` included. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>([normalize(entry)]);
  const queue = [normalize(entry)];
  while (queue.length) {
    for (const next of edgesOf(queue.pop()!)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe('DEHACKED · the read half does not pull the applier', () => {
  test('nothing that only reads a patch can reach apply.ts', () => {
    // `library.ts` is the menu's; `wad-manifest.ts` is the Vite plugin, which used to reach past
    // the entry point into `dehacked/parse.ts` precisely to dodge this.
    for (const entry of ['src/wad/library.ts', 'plugins/wad-manifest.ts', 'src/wad/campaign/names.ts']) {
      const graph = reachableFrom(entry);
      assert.equal(graph.has(APPLIER), false, `${entry} reaches ${APPLIER}`);
    }
  });

  test('game.ts does reach it, so the walk above is not passing vacuously', () => {
    // The positive control: a walker that resolved nothing would satisfy every assertion above.
    const graph = reachableFrom('src/game.ts');
    assert.equal(graph.has(APPLIER), true, 'game.ts should reach the applier');
    assert.ok(graph.size > 50, `expected a real graph, walked ${graph.size} modules`);
  });

  test("the applier's own heavy tables are what the split keeps out", () => {
    // Names the cost rather than restating the rule: these are the modules `library.ts` would
    // evaluate — and snapshot — if the entry point re-exported the applier again.
    const applier = reachableFrom(APPLIER);
    const menu = reachableFrom('src/wad/library.ts');
    for (const heavy of ['src/game/weapons.ts', 'src/game/monsters/tables.ts', 'src/game/things/tables.ts']) {
      assert.equal(applier.has(normalize(heavy)), true, `${heavy} should be the applier's`);
      assert.equal(menu.has(normalize(heavy)), false, `${heavy} leaked into the menu's graph`);
    }
  });
});
