/**
 * {@link sin}, {@link cos}, {@link atan2}, {@link exp} and {@link log} in software, so that a tic
 * comes out bit-identical on every JavaScript engine — ECMA-262 leaves exactly these five
 * approximated, and V8 rounds a fifth of the simulation's `atan2` calls differently from one Chrome
 * release to the next. A transcription of Sun's fdlibm as FreeBSD's `msun` carries it (`s_sin.c`,
 * `s_cos.c`, `k_sin.c`, `k_cos.c`, `e_rem_pio2.c`, `s_atan.c`, `e_atan2.c`, `e_exp.c`, `e_log.c`),
 * unchanged but for the word access C does with macros. Everything else the simulation computes is
 * `+ - * /` and `sqrt`/`round`/`floor`, which IEEE-754 and ECMA-262 both pin exactly.
 * The render layer keeps the native `Math`. docs/replays.md § What breaks determinism.
 */

/*
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunPro, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */

/** The one buffer every word access goes through — single-threaded, so one is enough. */
const SCRATCH = new Float64Array(1);
const WORDS = new Uint32Array(SCRATCH.buffer);
SCRATCH[0] = 1;
/** Which half of a double the sign and exponent sit in: 1 little-endian, 0 big-endian. */
const HIGH = WORDS[1] === 0x3ff00000 ? 1 : 0;
const LOW = 1 - HIGH;

/**
 * `__ieee754_rem_pio2`'s second return value, which C passes back through a `double y[2]`: the
 * reduced argument and its tail. Written by {@link remPio2}, read by the {@link sin}/{@link cos}
 * that called it.
 */
let remY0 = 0;
let remY1 = 0;

export function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  // |x| <= pi/4 needs no reduction, and under 2**-26 the answer is x itself — which is also what
  // keeps the sign of a negative zero, where the kernel would hand back a positive one.
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e500000) return x;
    return kernelSin(x, 0, 0);
  }
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  switch (n & 3) {
    case 0:
      return kernelSin(remY0, remY1, 1);
    case 1:
      return kernelCos(remY0, remY1);
    case 2:
      return -kernelSin(remY0, remY1, 1);
    default:
      return -kernelCos(remY0, remY1);
  }
}

export function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e46a09e) return 1.0;
    return kernelCos(x, 0);
  }
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  switch (n & 3) {
    case 0:
      return kernelCos(remY0, remY1);
    case 1:
      return -kernelSin(remY0, remY1, 1);
    case 2:
      return -kernelCos(remY0, remY1);
    default:
      return kernelSin(remY0, remY1, 1);
  }
}

export function atan2(y: number, x: number): number {
  // `nan_mix`, which the C spells as a word test on both arguments.
  if (x !== x || y !== y) return x + y;
  const hx = highWord(x);
  const hy = highWord(y);
  const ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;
  if (x === 1) return atan(y);
  // 2*sign(x) + sign(y), the index of the four quadrant answers below.
  const m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
  if (y === 0) {
    switch (m) {
      case 0:
      case 1:
        return y;
      case 2:
        return PI + TINY;
      default:
        return -PI - TINY;
    }
  }
  if (x === 0) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0:
          return PI_O_4 + TINY;
        case 1:
          return -PI_O_4 - TINY;
        case 2:
          return 3.0 * PI_O_4 + TINY;
        default:
          return -3.0 * PI_O_4 - TINY;
      }
    }
    switch (m) {
      case 0:
        return 0;
      case 1:
        return -0;
      case 2:
        return PI + TINY;
      default:
        return -PI - TINY;
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 - TINY : PI_O_2 + TINY;

  const k = (iy - ix) >> 20;
  let z: number;
  let quadrant = m;
  if (k > 60) {
    // |y/x| > 2**60
    z = PI_O_2 + 0.5 * PI_LO;
    quadrant &= 1;
  } else if (hx < 0 && k < -60) {
    z = 0.0;
  } else {
    z = atan(Math.abs(y / x));
  }
  switch (quadrant) {
    case 0:
      return z;
    case 1:
      return -z;
    case 2:
      return PI - (z - PI_LO);
    default:
      return z - PI_LO - PI;
  }
}

export function exp(x: number): number {
  const hxSigned = highWord(x);
  const xsb = (hxSigned >> 31) & 1;
  const hx = hxSigned & 0x7fffffff;
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lowWord(x)) !== 0) return x + x;
      return xsb === 0 ? x : 0.0;
    }
    if (x > EXP_OVERFLOW) return HUGE * HUGE;
    if (x < EXP_UNDERFLOW) return TWO_M1000 * TWO_M1000;
  }

  let k = 0;
  let hi = 0.0;
  let lo = 0.0;
  let r = x;
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = x - LN2_HI[xsb];
      lo = LN2_LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INV_LN2 * x + HALF_SIGNED[xsb]);
      hi = x - k * LN2_HI[0];
      lo = k * LN2_LO[0];
    }
    r = hi - lo;
  } else if (hx < 0x3e300000) {
    // |x| < 2**-28: exp(x) is 1 + x to the last bit.
    return 1.0 + x;
  }

  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1.0 - ((r * c) / (c - 2.0) - r);
  // `twopk` below the `k === 0` return, which never reads it: the reference computes it before the
  // branch, and the exponent the simulation asks for is always the small-argument one.
  const twopk = k >= -1021 ? fromWords((0x3ff + k) << 20, 0) : fromWords((0x3ff + (k + 1000)) << 20, 0);
  const y = 1.0 - ((lo - (r * c) / (2.0 - c)) - hi);
  if (k >= -1021) {
    if (k === 1024) return y * 2.0 * TWO_1023;
    return y * twopk;
  }
  return y * twopk * TWO_M1000;
}

export function log(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  let value = x;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -TWO54 / 0.0;
    if (hx < 0) return (x - x) / 0.0;
    k -= 54;
    value = x * TWO54;
    hx = highWord(value);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  value = withHighWord(value, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const f = value - 1.0;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) {
      if (k === 0) return 0.0;
      return dk * LN2_HI[0] + dk * LN2_LO[0];
    }
    const rSmall = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - rSmall;
    return dk * LN2_HI[0] - (rSmall - dk * LN2_LO[0] - f);
  }
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + r));
    return dk * LN2_HI[0] - (hfsq - (s * (hfsq + r) + dk * LN2_LO[0]) - f);
  }
  if (k === 0) return f - s * (f - r);
  return dk * LN2_HI[0] - (s * (f - r) - dk * LN2_LO[0] - f);
}

const ATAN_HI = [
  4.63647609000806093515e-1, // atan(0.5)hi
  7.85398163397448278999e-1, // atan(1.0)hi
  9.82793723247329054082e-1, // atan(1.5)hi
  1.57079632679489655800e0, // atan(inf)hi
];
const ATAN_LO = [
  2.26987774529616870924e-17, // atan(0.5)lo
  3.06161699786838301793e-17, // atan(1.0)lo
  1.39033110312309984516e-17, // atan(1.5)lo
  6.12323399573676603587e-17, // atan(inf)lo
];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2,
];

/** `s_atan.c`, the arctangent {@link atan2} reduces to. */
function atan(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  let t = x;
  if (ix >= 0x44100000) {
    // |x| >= 2**66
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lowWord(x) !== 0)) return x + x;
    return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3];
  }
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375, and under 2**-27 the answer is x itself.
    if (ix < 0x3e400000) return x;
    id = -1;
  } else {
    t = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0;
        t = (2.0 * t - 1.0) / (2.0 + t);
      } else {
        id = 1;
        t = (t - 1.0) / (t + 1.0);
      }
    } else if (ix < 0x40038000) {
      id = 2;
      t = (t - 1.5) / (1.0 + 1.5 * t);
    } else {
      id = 3;
      t = -1.0 / t;
    }
  }
  const z = t * t;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return t - t * (s1 + s2);
  const r = ATAN_HI[id] - (t * (s1 + s2) - ATAN_LO[id] - t);
  return hx < 0 ? -r : r;
}

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

/** `k_sin.c`: sine of an argument already reduced to [-pi/4, pi/4], `y` carrying its tail. */
function kernelSin(x: number, y: number, iy: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

/** `k_cos.c`, the cosine twin of {@link kernelSin}. */
function kernelCos(x: number, y: number): number {
  const z = x * x;
  const zz = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + zz * zz * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const w = 1.0 - hz;
  return w + (1.0 - w - hz + (z * r - x * y));
}

const TWO_PI = 6.283185307179586;
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417e0;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;

/**
 * `e_rem_pio2.c`: `x` reduced into [-pi/4, pi/4] as {@link remY0} + {@link remY1}, returning how
 * many quarter-turns came off. **Only the paths up to `2**20 * pi/2` are here** — every angle the
 * simulation forms is a heading in radians, and the huge-argument path (`__kernel_rem_pio2`'s
 * multiprecision reduction) exists to keep accuracy where no heading reaches. Past that bound it
 * reduces by `x % TWO_PI` first: less accurate than C, and still the same answer on every engine.
 */
function remPio2(x: number): number {
  // Past `2**20 * pi/2` the C switches to a multiprecision reduction this does not carry (see
  // above). `%` is the one exactly-specified way left to land back in range: the remainder itself
  // is exact on every engine, and what it costs is accuracy against the true 2*pi, out where no
  // heading the simulation forms can reach. Recurses exactly once — the caller filters NaN.
  if ((highWord(x) & 0x7fffffff) >= 0x413921fb) return remPio2(x % TWO_PI);
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  let n: number;
  // An |x| that sits on a multiple of pi/2 cancels in the one-step reduction, so those go to the
  // general path below however small they are — the C's three `goto medium`.
  const cancels = (ix <= 0x400f6a7a && (ix & 0xfffff) === 0x921fb) || ix === 0x4012d97c || ix === 0x401921fb;
  if (!cancels && ix <= 0x401c463b) {
    // |x| <= 9pi/4: one round of a whole number of quarter-turns, good to 85 bits.
    if (ix <= 0x400f6a7a) n = ix <= 0x4002d97c ? 1 : 2;
    else n = ix <= 0x4015fdbc ? 3 : 4;
    if (hx <= 0) n = -n;
    const z = x - n * PIO2_1;
    remY0 = z - n * PIO2_1T;
    remY1 = z - remY0 - n * PIO2_1T;
    return n;
  }
  // `rnint` is round-half-to-even, where `Math.round` is the spec-exact round-half-up: the two
  // differ only on an exact tie, where either choice reduces to |pi/4| and both are valid.
  const fn = Math.round(x * INV_PIO2);
  n = fn | 0;
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T;
  const j = ix >> 20;
  remY0 = r - w;
  let i = j - ((highWord(remY0) >> 20) & 0x7ff);
  if (i > 16) {
    const t1 = r;
    w = fn * PIO2_2;
    r = t1 - w;
    w = fn * PIO2_2T - (t1 - r - w);
    remY0 = r - w;
    i = j - ((highWord(remY0) >> 20) & 0x7ff);
    if (i > 49) {
      const t2 = r;
      w = fn * PIO2_3;
      r = t2 - w;
      w = fn * PIO2_3T - (t2 - r - w);
      remY0 = r - w;
    }
  }
  remY1 = r - remY0 - w;
  return n;
}

const TINY = 1.0e-300;
const PI_O_4 = 7.8539816339744827900e-1;
const PI_O_2 = 1.5707963267948965580e0;
const PI = 3.1415926535897931160e0;
const PI_LO = 1.2246467991473531772e-16;

const EXP_OVERFLOW = 7.09782712893383973096e2;
const EXP_UNDERFLOW = -7.45133219101941108420e2;
const HUGE = 1.0e300;
const TWO_M1000 = 9.33263618503218878990e-302;
const TWO_1023 = 8.98846567431158e307;
const INV_LN2 = 1.44269504088896338700e0;
const HALF_SIGNED = [0.5, -0.5];
const LN2_HI = [6.93147180369123816490e-1, -6.93147180369123816490e-1];
const LN2_LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

const TWO54 = 1.80143985094819840000e16;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

/** `GET_HIGH_WORD`: the sign, exponent and top mantissa bits, signed as the C is. */
function highWord(x: number): number {
  SCRATCH[0] = x;
  return WORDS[HIGH] | 0;
}

/** `GET_LOW_WORD`: the bottom 32 mantissa bits, unsigned as the C is. */
function lowWord(x: number): number {
  SCRATCH[0] = x;
  return WORDS[LOW] >>> 0;
}

/** `INSERT_WORDS`. */
function fromWords(hi: number, lo: number): number {
  WORDS[HIGH] = hi >>> 0;
  WORDS[LOW] = lo >>> 0;
  return SCRATCH[0];
}

/** `SET_HIGH_WORD`: `x` with its high word replaced, the low one kept. */
function withHighWord(x: number, hi: number): number {
  SCRATCH[0] = x;
  WORDS[HIGH] = hi >>> 0;
  return SCRATCH[0];
}
