/**
 * Boom's `SWITCHES` lump: a WAD's own switch-texture pair list, replacing the
 * `SW1xxx`/`SW2xxx` name convention this engine otherwise derives pairs from
 * (`P_InitSwitchList`, `p_switch.c`). See docs/wad.md § ANIMATED and SWITCHES.
 */
import type { Wad } from './wad.ts';

/** `switchlist_t`: `char name1[9]; char name2[9]; short episode`, byte-packed. */
const RECORD_SIZE = 20;

/** One off/on texture pair, in the lump's own order. */
export interface SwitchPair {
  off: string;
  on: string;
}

/**
 * Resolves a switch texture to its opposite state, in either direction.
 * `switchPairTexture` (`game/specials/defs.ts`) is the name-convention
 * implementation; `switchPairs` below builds the lump-driven one.
 */
export type SwitchPairLookup = (name: string) => string | null;

/**
 * The WAD set's `SWITCHES` pairs, or `null` when no file in the set defines
 * the lump (every stock IWAD). Terminated by a record whose `episode` is 0.
 *
 * **The episode field is deliberately ignored.** Vanilla filters on it to keep
 * switches whose textures the current IWAD doesn't have out of the list, but
 * PrBoom+ already drops unknown-texture entries outright
 * (`p_switch.c: "Ignore switches referencing unknown texture names"`), and
 * existence is the only thing the number was ever a proxy for. Honouring it
 * here would make switch behavior depend on the IWAD's *file name*
 * (`missionOf`, already null for any renamed IWAD) — a worse signal than
 * asking the graphics bank. The caller applies the existence check.
 */
export function readSwitches(wad: Wad): SwitchPair[] | null {
  const lump = wad.find('SWITCHES');
  if (!lump) return null;
  const r = wad.reader(lump);
  const out: SwitchPair[] = [];
  for (let start = 0; start + RECORD_SIZE <= lump.size; start += RECORD_SIZE) {
    r.seek(start);
    const off = r.name(9);
    const on = r.name(9);
    if (r.i16() === 0) break;
    if (off && on) out.push({ off, on });
  }
  return out;
}

/**
 * A bidirectional lookup over `pairs`, keeping only those whose textures both
 * exist (`has`) — vanilla's own "add only if both are valid" rule. Boom pairs
 * need not share a suffix, which is exactly why a table beats the convention.
 */
export function switchPairs(pairs: readonly SwitchPair[], has: (name: string) => boolean): SwitchPairLookup {
  const map = new Map<string, string>();
  for (const { off, on } of pairs) {
    if (!has(off) || !has(on)) continue;
    // First definition wins in each direction, matching the linear
    // `switchlist[i^1]` scan, which stops at its first hit.
    if (!map.has(off)) map.set(off, on);
    if (!map.has(on)) map.set(on, off);
  }
  return (name) => map.get(name.toUpperCase()) ?? null;
}
