import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { callsIn, filesUnder } from '../fixtures/files.ts';

/**
 * Nothing a tic runs may reach the platform's approximated `Math` functions: ECMA-262 lets an
 * engine round `sin`, `cos`, `tan`, the inverse trig, `exp`, `log`, `pow` and `hypot` either way,
 * and one such call in the simulation is a replay that plays differently in another browser —
 * `util/fdlibm.ts` is where the five with replacements come from instead.
 *
 * Two scopes, because a simulation file reaches the platform through a helper just as easily as
 * directly. The whole of `src/game/` and `src/game.ts`, rather than the tic's own call graph,
 * because the draw helpers living beside the tic in those files are what a next edit reaches for;
 * and `src/util/`, where anything `src/game/` imports lives — there only the five, since
 * `damping.ts`'s `Math.pow` has no replacement and is held off the tic by its own test
 * (docs/random.md § What this does not buy). `src/render/` is not in either: it draws.
 * docs/replays.md § What breaks determinism.
 */

/** The five `util/fdlibm.ts` answers, which nothing shared with the simulation may ask `Math` for. */
const REPLACED = /\bMath\.(sin|cos|atan2|exp|log)\s*\(/g;
/** Every function ECMA-262 leaves approximated: what a simulation file may not reach for at all. */
const APPROXIMATED = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt)\s*\(/g;

describe('Simulation determinism · the tic does not call the platform Math', () => {
  test('no approximated Math call anywhere under src/game', () => {
    const files = ['src/game.ts', ...filesUnder('src/game', (p) => p.endsWith('.ts'))];
    const offenders = callsIn(files, APPROXIMATED);
    assert.deepEqual(offenders, [], `use util/fdlibm.ts instead — a tic that calls these plays differently on another engine:\n${offenders.join('\n')}`);
  });

  test('nor through a helper in src/util, which the simulation imports', () => {
    const files = filesUnder('src/util', (p) => p.endsWith('.ts') && !p.endsWith('fdlibm.ts'));
    const offenders = callsIn(files, REPLACED);
    assert.deepEqual(offenders, [], `use util/fdlibm.ts instead — src/game reaches these:\n${offenders.join('\n')}`);
  });
});
