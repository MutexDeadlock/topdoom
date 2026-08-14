/**
 * Builds a `WadFile` in memory from a lump list, for the tests that only need a
 * directory (name resolution, content ids) or a lump or two of real text (a
 * MAPINFO the progression reader has to parse). Real WADs belong in
 * `tests/fixtures/wads/`; docs/wad.md's warning that synthetic WADs won't catch
 * parser regressions still stands, and none of these callers is testing the
 * parser. See docs/testing.md § WAD-backed tests.
 */
import { WadFile } from '../../src/wad/wad.ts';

/** A lump: a bare name for an empty one, or a name with the text or raw bytes it holds. */
export type Lump = string | { name: string; text?: string; bytes?: Uint8Array };

const nameOf = (lump: Lump): string => (typeof lump === 'string' ? lump : lump.name);
const textOf = (lump: Lump): string => (typeof lump === 'string' ? '' : (lump.text ?? ''));
const bytesOf = (lump: Lump): Uint8Array | undefined => (typeof lump === 'string' ? undefined : lump.bytes);

/**
 * Lump payloads are laid down first and the directory after them, so an
 * empty-lump WAD comes out byte-identical to a hand-built directory-only one.
 */
export function wadFile(type: 'IWAD' | 'PWAD', name: string, lumps: readonly Lump[]): WadFile {
  const encoder = new TextEncoder();
  const payloads = lumps.map((lump) => bytesOf(lump) ?? encoder.encode(textOf(lump)));
  const dirOffset = 12 + payloads.reduce((sum, p) => sum + p.length, 0);
  const buffer = new ArrayBuffer(dirOffset + lumps.length * 16);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  for (let i = 0; i < 4; i++) bytes[i] = type.charCodeAt(i);
  view.setInt32(4, lumps.length, true);
  view.setInt32(8, dirOffset, true);

  let at = 12;
  payloads.forEach((payload, i) => {
    bytes.set(payload, at);
    const entry = dirOffset + i * 16;
    view.setInt32(entry, at, true);
    view.setInt32(entry + 4, payload.length, true);
    const lumpName = nameOf(lumps[i]);
    for (let c = 0; c < lumpName.length; c++) bytes[entry + 8 + c] = lumpName.charCodeAt(c);
    at += payload.length;
  });
  return new WadFile(buffer, name);
}
