/**
 * The byte cursor every other `wad/` module reads its lumps through — WAD files are
 * little-endian, so this is where that assumption is made once instead of at each field.
 * See docs/wad.md § Loading and merging.
 */

/**
 * A lump read as a run of fixed-size records. Returns `[]` for a lump that is absent or
 * too short to hold one, so a caller never has to guard the empty case itself; a trailing
 * partial record is ignored, which is how a WAD with a slightly over-long lump still loads.
 */
export function records<T>(
  data: Uint8Array | undefined,
  offset: number,
  size: number,
  fn: (r: Reader) => T,
): T[] {
  if (!data || data.length - offset < size) return [];
  const r = new Reader(data.buffer, data.byteOffset + offset, data.byteLength - offset);
  const n = Math.floor((data.length - offset) / size);
  const out: T[] = new Array(n);
  for (let i = 0; i < n; i++) {
    r.seek(i * size);
    out[i] = fn(r);
  }
  return out;
}
/** Small little-endian cursor over an ArrayBuffer. */
export class Reader {
  private view: DataView;
  pos = 0;

  private buf: ArrayBufferLike;

  constructor(buf: ArrayBufferLike, offset = 0, length?: number) {
    this.buf = buf;
    this.view = new DataView(buf, offset, length ?? buf.byteLength - offset);
  }

  get length(): number {
    return this.view.byteLength;
  }

  get eof(): boolean {
    return this.pos >= this.view.byteLength;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  i16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(this.buf, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return out;
  }

  /**
   * Lump name: 8 bytes, normalised to upper case, ending at the first NUL —
   * everything past it is stale bytes a map editor left behind.
   * docs/wad.md § Loading and merging.
   */
  name8(): string {
    return this.name(8);
  }

  /**
   * {@link Reader.name8}'s normalisation over an arbitrary field width, for Boom's **9**-byte
   * `ANIMATED` and `SWITCHES` names — docs/wad.md § ANIMATED and SWITCHES.
   */
  name(width: number): string {
    let s = '';
    let terminated = false;
    for (let i = 0; i < width; i++) {
      const c = this.u8();
      if (c === 0) terminated = true;
      if (!terminated) s += String.fromCharCode(c);
    }
    return s.toUpperCase();
  }

  seek(p: number): void {
    this.pos = p;
  }
}

