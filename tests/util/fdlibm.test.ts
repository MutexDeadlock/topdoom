import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { atan2, cos, exp, log, sin } from '../../src/util/fdlibm.ts';

/**
 * The software `sin`/`cos`/`atan2`/`exp`/`log` the simulation runs on: close enough to the
 * platform's own that no behavior moves, and pinned to the bit so a later edit can't quietly shift
 * every recorded replay. docs/replays.md § What breaks determinism.
 */

const SCRATCH = new Float64Array(1);
const BITS = new BigUint64Array(SCRATCH.buffer);

/** A double's bit pattern, which is what "the same answer everywhere" means here. */
function bitsOf(x: number): bigint {
  SCRATCH[0] = x;
  return BITS[0];
}

/** How many representable doubles lie between two results — 0 is bit-identical. */
function ulpsApart(a: number, b: number): number {
  if (Object.is(a, b)) return 0;
  const ordered = (v: number): bigint => {
    const raw = bitsOf(v);
    return raw & 0x8000000000000000n ? -0x8000000000000000n - (raw & 0x7fffffffffffffffn) : raw;
  };
  const d = ordered(a) - ordered(b);
  return Number(d < 0n ? -d : d);
}

/** A repeatable spread of arguments, since a random one that fails is a failure nobody can rerun. */
function samples(count: number, from: number, to: number): number[] {
  const out: number[] = [];
  let seed = 20260907;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.push(from + (seed / 0x7fffffff) * (to - from));
  }
  return out;
}

describe('Deterministic math · within a ULP of the platform', () => {
  const within = (name: string, mine: (x: number) => number, native: (x: number) => number, args: number[]): void => {
    let worst = 0;
    let worstAt = 0;
    for (const x of args) {
      const d = ulpsApart(mine(x), native(x));
      if (d > worst) {
        worst = d;
        worstAt = x;
      }
    }
    assert.ok(worst <= 1, `${name} is ${worst} ULP out at ${worstAt}`);
  };

  test('sine and cosine over the headings a tic forms', () => {
    const angles = [...samples(20000, -Math.PI * 2, Math.PI * 2), 0, Math.PI, -Math.PI, Math.PI / 2, 1e-9];
    within('sin', sin, Math.sin, angles);
    within('cos', cos, Math.cos, angles);
  });

  test('atan2 over map-sized coordinates', () => {
    const ys = samples(10000, -8192, 8192);
    const xs = samples(10000, -8192, 8192).reverse();
    let worst = 0;
    for (let i = 0; i < ys.length; i++) worst = Math.max(worst, ulpsApart(atan2(ys[i], xs[i]), Math.atan2(ys[i], xs[i])));
    assert.ok(worst <= 1, `atan2 is ${worst} ULP out`);
  });

  test('exp over the acceleration ramp and log over the friction range', () => {
    within('exp', exp, Math.exp, samples(10000, -20, 0));
    within('log', log, Math.log, samples(10000, 1e-6, 1));
  });

  test('the zeroes, infinities and NaN answer as the platform does', () => {
    for (const v of [0, -0, Infinity, -Infinity, NaN, 5e-324, 1e308]) {
      for (const [name, mine, native] of [
        ['sin', sin, Math.sin],
        ['cos', cos, Math.cos],
        ['exp', exp, Math.exp],
        ['log', log, Math.log],
      ] as const) {
        // Beyond 2**20*(pi/2) the reduction is deliberately not the C's, so only the finite
        // arguments a heading can take are compared — see `remPio2`.
        if ((name === 'sin' || name === 'cos') && Number.isFinite(v) && Math.abs(v) > 1e6) continue;
        const a = mine(v);
        const b = native(v);
        assert.ok(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)), `${name}(${v}) = ${a}, platform ${b}`);
      }
    }
    for (const y of [0, -0, 1, -1, Infinity, -Infinity, NaN]) {
      for (const x of [0, -0, 1, -1, Infinity, -Infinity, NaN]) {
        const a = atan2(y, x);
        const b = Math.atan2(y, x);
        assert.ok(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)), `atan2(${y}, ${x}) = ${a}, platform ${b}`);
      }
    }
  });

  test('a huge angle still answers something finite, rather than poisoning the tic', () => {
    for (const v of [1e20, 1e308, -1e308]) {
      assert.ok(Number.isFinite(sin(v)) && Math.abs(sin(v)) <= 1, `sin(${v}) = ${sin(v)}`);
      assert.ok(Number.isFinite(cos(v)) && Math.abs(cos(v)) <= 1, `cos(${v}) = ${cos(v)}`);
    }
  });
});

/**
 * `[fn, args, bits]` — what this build answers, to the bit. A change here is a change to every
 * replay ever recorded, so it belongs in a commit that says so.
 */
const PINNED: [keyof typeof FNS, number[], bigint][] = [
  ['sin', [0.5], 0x3fdeaee8744b05f0n],
  ['sin', [1], 0x3feaed548f090ceen],
  ['sin', [-2.7], 0xbfdb5a312424a70cn],
  ['sin', [3.14159], 0x3ec6428a6aa44cd0n],
  ['sin', [12.566370614359172], 0xbcc1a62633145c07n],
  ['cos', [0.5], 0x3fec1528065b7d50n],
  ['cos', [1], 0x3fe14a280fb5068cn],
  ['cos', [-2.7], 0xbfecee28b36603a6n],
  ['cos', [1.5707963267948966], 0x3c91a62633145c07n],
  ['cos', [12.566370614359172], 0x3ff0000000000000n],
  ['atan2', [1, 1], 0x3fe921fb54442d18n],
  ['atan2', [-236.67968570286394, 2613.960940624569], 0xbfb71dc8fcc5d21an],
  ['atan2', [3, -4], 0x4003fc176b7a8560n],
  ['atan2', [-0.5, -0.25], 0xc000468a8ace4df6n],
  ['exp', [-0.5714285714285714], 0x3fe2122bbd2f6b6en],
  ['exp', [1], 0x4005bf0a8b14576an],
  ['exp', [-12.3], 0x3ed31765fdaf4f37n],
  ['log', [0.90625], 0xbfb9335e5d594989n],
  ['log', [0.5], 0xbfe62e42fefa39efn],
  ['log', [7], 0x3fff2272ae325a57n],
];

const FNS = { sin, cos, atan2, exp, log };

describe('Deterministic math · the bits are pinned', () => {
  test('every function answers the pattern this build recorded replays against', () => {
    for (const [name, args, expected] of PINNED) {
      const got = bitsOf((FNS[name] as (...xs: number[]) => number)(...args));
      assert.equal(got, expected, `${name}(${args.join(', ')}) is 0x${got.toString(16)}, pinned 0x${expected.toString(16)}`);
    }
  });
});
