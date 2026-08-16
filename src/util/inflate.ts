/**
 * Synchronous zlib (RFC 1950) / DEFLATE (RFC 1951) decoding. Exists because
 * `loadMap` is synchronous all the way up through session start, so ZNOD's
 * compressed BSP cannot await a `DecompressionStream`. The decoder follows
 * zlib's reference implementation `puff.c` (Mark Adler).
 * See docs/wad.md § Node formats.
 */

const MAX_BITS = 15;

// RFC 1951 § 3.2.5: base values and extra bits for length codes 257-285.
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];

// RFC 1951 § 3.2.5: base values and extra bits for distance codes 0-29.
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// RFC 1951 § 3.2.7: the order code lengths for the code-length alphabet arrive in.
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface State {
  data: Uint8Array;
  pos: number;
  bitBuf: number;
  bitCnt: number;
  out: Uint8Array;
  outLen: number;
}

/** Canonical Huffman code: symbol counts per bit length, and symbols sorted by code. */
interface Huffman {
  counts: Int32Array;
  symbols: Int32Array;
}

function bits(s: State, need: number): number {
  let val = s.bitBuf;
  while (s.bitCnt < need) {
    if (s.pos >= s.data.length) throw new Error('inflate: unexpected end of input');
    val |= s.data[s.pos++] << s.bitCnt;
    s.bitCnt += 8;
  }
  s.bitBuf = val >>> need;
  s.bitCnt -= need;
  return val & ((1 << need) - 1);
}

function construct(lengths: ArrayLike<number>): Huffman {
  const counts = new Int32Array(MAX_BITS + 1);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len <= MAX_BITS; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw new Error('inflate: over-subscribed code');
  }
  const offs = new Int32Array(MAX_BITS + 2);
  for (let len = 1; len <= MAX_BITS; len++) offs[len + 1] = offs[len] + counts[len];
  const symbols = new Int32Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym] !== 0) symbols[offs[lengths[sym]]++] = sym;
  }
  return { counts, symbols };
}

function decode(s: State, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code |= bits(s, 1);
    const count = h.counts[len];
    if (code - first < count) return h.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('inflate: invalid code');
}

function ensure(s: State, extra: number): void {
  if (s.outLen + extra <= s.out.length) return;
  let size = s.out.length === 0 ? 1024 : s.out.length;
  while (size < s.outLen + extra) size *= 2;
  const grown = new Uint8Array(size);
  grown.set(s.out.subarray(0, s.outLen));
  s.out = grown;
}

function stored(s: State): void {
  s.bitBuf = 0;
  s.bitCnt = 0;
  if (s.pos + 4 > s.data.length) throw new Error('inflate: unexpected end of input');
  const len = s.data[s.pos] | (s.data[s.pos + 1] << 8);
  const nlen = s.data[s.pos + 2] | (s.data[s.pos + 3] << 8);
  if (len !== (~nlen & 0xffff)) throw new Error('inflate: stored block length mismatch');
  s.pos += 4;
  if (s.pos + len > s.data.length) throw new Error('inflate: unexpected end of input');
  ensure(s, len);
  s.out.set(s.data.subarray(s.pos, s.pos + len), s.outLen);
  s.outLen += len;
  s.pos += len;
}

function codes(s: State, lenCodes: Huffman, distCodes: Huffman): void {
  for (;;) {
    const sym = decode(s, lenCodes);
    if (sym < 256) {
      ensure(s, 1);
      s.out[s.outLen++] = sym;
    } else if (sym === 256) {
      return;
    } else {
      if (sym > 285) throw new Error('inflate: invalid length code');
      const len = LENGTH_BASE[sym - 257] + bits(s, LENGTH_EXTRA[sym - 257]);
      const dSym = decode(s, distCodes);
      if (dSym > 29) throw new Error('inflate: invalid distance code');
      const dist = DIST_BASE[dSym] + bits(s, DIST_EXTRA[dSym]);
      if (dist > s.outLen) throw new Error('inflate: distance beyond output');
      ensure(s, len);
      // Byte-by-byte on purpose: dist < len means the copy overlaps its own output.
      for (let i = 0; i < len; i++) {
        s.out[s.outLen] = s.out[s.outLen - dist];
        s.outLen++;
      }
    }
  }
}

let fixedLen: Huffman | null = null;
let fixedDist: Huffman | null = null;

/** RFC 1951 § 3.2.6: the fixed block's implicit code lengths. */
function fixedTables(): { len: Huffman; dist: Huffman } {
  if (!fixedLen || !fixedDist) {
    const lens = new Uint8Array(288);
    for (let i = 0; i < 144; i++) lens[i] = 8;
    for (let i = 144; i < 256; i++) lens[i] = 9;
    for (let i = 256; i < 280; i++) lens[i] = 7;
    for (let i = 280; i < 288; i++) lens[i] = 8;
    fixedLen = construct(lens);
    fixedDist = construct(new Uint8Array(30).fill(5));
  }
  return { len: fixedLen, dist: fixedDist };
}

/** RFC 1951 § 3.2.7: read the two dynamic code tables of one block. */
function dynamicTables(s: State): { len: Huffman; dist: Huffman } {
  const hlit = bits(s, 5) + 257;
  const hdist = bits(s, 5) + 1;
  const hclen = bits(s, 4) + 4;
  if (hlit > 286 || hdist > 30) throw new Error('inflate: too many codes');

  const clenLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clenLengths[CLEN_ORDER[i]] = bits(s, 3);
  const clen = construct(clenLengths);

  const lengths = new Uint8Array(hlit + hdist);
  let at = 0;
  while (at < lengths.length) {
    const sym = decode(s, clen);
    if (sym < 16) {
      lengths[at++] = sym;
    } else {
      let repeat: number;
      let value = 0;
      if (sym === 16) {
        if (at === 0) throw new Error('inflate: repeat with no previous length');
        value = lengths[at - 1];
        repeat = 3 + bits(s, 2);
      } else if (sym === 17) {
        repeat = 3 + bits(s, 3);
      } else {
        repeat = 11 + bits(s, 7);
      }
      if (at + repeat > lengths.length) throw new Error('inflate: too many lengths');
      while (repeat-- > 0) lengths[at++] = value;
    }
  }
  if (lengths[256] === 0) throw new Error('inflate: missing end-of-block code');

  return { len: construct(lengths.subarray(0, hlit)), dist: construct(lengths.subarray(hlit)) };
}

function inflateState(data: Uint8Array): State {
  const s: State = { data, pos: 0, bitBuf: 0, bitCnt: 0, out: new Uint8Array(0), outLen: 0 };
  let last: number;
  do {
    last = bits(s, 1);
    const type = bits(s, 2);
    if (type === 0) {
      stored(s);
    } else if (type === 1 || type === 2) {
      const { len, dist } = type === 1 ? fixedTables() : dynamicTables(s);
      codes(s, len, dist);
    } else {
      throw new Error('inflate: invalid block type');
    }
  } while (!last);
  return s;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Decodes a zlib stream (RFC 1950): header checks, raw DEFLATE, adler32 verify. */
export function inflateZlib(data: Uint8Array): Uint8Array {
  if (data.length < 6) throw new Error('inflate: zlib stream too short');
  const cmf = data[0];
  const flg = data[1];
  if ((cmf & 0x0f) !== 8) throw new Error('inflate: not a zlib deflate stream');
  if (((cmf << 8) | flg) % 31 !== 0) throw new Error('inflate: bad zlib header check');
  if (flg & 0x20) throw new Error('inflate: preset dictionary not supported');
  const s = inflateState(data.subarray(2));
  const out = s.out.subarray(0, s.outLen);
  if (s.pos + 4 > s.data.length) throw new Error('inflate: missing adler32 trailer');
  const stored32 =
    ((s.data[s.pos] << 24) | (s.data[s.pos + 1] << 16) | (s.data[s.pos + 2] << 8) | s.data[s.pos + 3]) >>> 0;
  if (stored32 !== adler32(out)) throw new Error('inflate: adler32 mismatch');
  return out;
}
