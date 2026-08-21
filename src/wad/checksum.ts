/**
 * Content id for a WAD file: a hash of its bytes, stable across renames and across however the
 * page was opened. Keys per-level records today and is meant to validate a save's WAD set later —
 * see docs/wad.md § Content id.
 */
import type { Wad, WadFile } from './wad.ts';

/**
 * One file's id, keyed by the *bytes* rather than by the `WadFile` wrapping
 * them: the same buffer is wrapped more than once — an uploaded source hashes
 * its own `WadFile`, then `loadWadFiles` builds another over the same
 * `ArrayBuffer`, and a restart re-wraps the memoized fetch — and a wrapper-keyed
 * memo misses every time, re-walking ~14 MB on the level-start path.
 */
const ids = new WeakMap<ArrayBuffer, string>();

// FNV-1a 32-bit's own basis and prime, then a second pair (the golden-ratio constant and murmur3's
// finalizer multiplier) so the two lanes mix differently rather than only starting apart.
const BASIS_A = 0x811c9dc5;
const PRIME_A = 0x01000193;
const BASIS_B = 0x9e3779b9;
const PRIME_B = 0x85ebca6b;

/**
 * Two FNV-1a-shaped lanes over the same bytes, concatenated to 16 hex chars. Deliberately *not*
 * the FNV-64 spec: a real 64-bit FNV needs BigInt or per-byte 32x32 multiply juggling, and this
 * runs over ~14M bytes for an IWAD. Two lanes buy the collision headroom the wider width was
 * wanted for at one `Math.imul` pair per byte.
 */
export function hashBytes(bytes: Uint8Array): string {
  let a = BASIS_A;
  let b = BASIS_B;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    a = Math.imul(a ^ byte, PRIME_A);
    b = Math.imul(b ^ byte, PRIME_B);
  }
  // Length is folded in too: a buffer that is a prefix of another would otherwise be distinguished
  // only by whatever the trailing bytes happened to do to the lanes.
  a = Math.imul(a ^ bytes.length, PRIME_A);
  b = Math.imul(b ^ bytes.length, PRIME_B);
  return hex32(a) + hex32(b);
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * A buffer's content id, computed once and memoized against the buffer itself. Everything that
 * needs an id goes through here rather than calling `hashBytes` directly — the menu hashes an
 * upload's bytes long before `loadWadFiles` wraps that same `ArrayBuffer` in a `WadFile`, and a
 * direct call would leave the memo empty for the wrapper to miss on the level-start path.
 */
export function idOf(buffer: ArrayBuffer): string {
  let id = ids.get(buffer);
  if (id === undefined) {
    id = hashBytes(new Uint8Array(buffer));
    ids.set(buffer, id);
  }
  return id;
}

/** The file's content id, computed once and memoized. */
export function wadId(file: WadFile): string {
  return idOf(file.buffer);
}

/**
 * Every loaded file's name and id, in load order — the shape a saved game embeds so it can name
 * *which* WAD is missing or different rather than only reporting that something is.
 */
export function wadSetId(wad: Wad): { name: string; id: string }[] {
  return wad.files.map((file) => ({ name: file.name, id: wadId(file) }));
}

/**
 * The file providing `map`, in the same `{ name, id }` shape — what a saved game stores as its
 * `mapWad` and compares a reassembled set against (docs/savegames.md § WAD-set identity). Null when
 * the set has no such map at all.
 */
export function mapProvider(wad: Wad, map: string): { name: string; id: string } | null {
  const file = wad.providerOf(map);
  return file ? { name: file.name, id: wadId(file) } : null;
}
