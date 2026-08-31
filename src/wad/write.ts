/**
 * Writing a PWAD — the inverse of `wad.ts`'s reader, and the only thing here that produces WAD
 * bytes rather than consuming them. Used off the browser path, by `plugins/game-wad.ts` and
 * `scripts/build-playerskins.ts`. See docs/wad.md § The WAD the engine ships.
 */

/** One directory entry to write. Names are upper-cased and truncated to the 8-character limit. */
export interface LumpSource {
  name: string;
  bytes: Uint8Array;
}

/**
 * A PWAD holding `lumps` in the given order: 12-byte header, the bodies back to back, then the
 * directory. A zero-length lump — every marker is one — gets offset 12 rather than its own place in
 * the body, which is what vanilla writes and what `deutex` and every editor since expect.
 */
export function writePwad(lumps: readonly LumpSource[]): Uint8Array {
  let body = 0;
  for (const lump of lumps) body += lump.bytes.length;

  const out = new Uint8Array(12 + body + lumps.length * 16);
  const view = new DataView(out.buffer);
  out[0] = 0x50; // P
  out[1] = 0x57; // W
  out[2] = 0x41; // A
  out[3] = 0x44; // D
  view.setInt32(4, lumps.length, true);
  view.setInt32(8, 12 + body, true);

  let offset = 12;
  let dir = 12 + body;
  for (const lump of lumps) {
    out.set(lump.bytes, offset);
    view.setInt32(dir, lump.bytes.length ? offset : 12, true);
    view.setInt32(dir + 4, lump.bytes.length, true);
    const name = lump.name.toUpperCase().slice(0, 8);
    for (let i = 0; i < name.length; i++) out[dir + 8 + i] = name.charCodeAt(i) & 0xff;
    offset += lump.bytes.length;
    dir += 16;
  }
  return out;
}
