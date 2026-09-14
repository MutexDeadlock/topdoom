/**
 * Boom's `ANIMATED` lump: a WAD's own replacement for vanilla's hardcoded `animdefs[]` table
 * (`P_InitPicAnims`, `p_spec.c`). Owns the {@link AnimDef} record both it and
 * `render/textureanim.ts`'s built-in table produce. See docs/wad.md § ANIMATED and SWITCHES.
 */
import type { Wad } from './wad.ts';

/**
 * One animation: a kind, the first and last frame name, and the tics each frame holds. The
 * in-between frames come from WAD lump order, resolved by the animator rather than stored here —
 * docs/render.md § Animated textures.
 *
 * {@link AnimDef.kind} is spelled out rather than importing `render/textures.ts`'s `SurfaceKind`,
 * which it must stay assignable to: a WAD parser does not depend on the renderer.
 */
export interface AnimDef {
  kind: 'wall' | 'flat';
  start: string;
  end: string;
  speedTics: number;
}

/** `animdef_t`: `int8 istexture; char endname[9]; char startname[9]; int32 speed`, byte-packed. */
const RECORD_SIZE = 23;

/**
 * The terminator record, vanilla's `istexture == -1` read off a `signed char` — 0xFF in the bytes.
 * Real lumps truncate it to just that byte, so it is tested before the rest of its record is
 * required (docs/wad.md § ANIMATED and SWITCHES).
 */
const TERMINATOR = 0xff;

/**
 * The WAD set's `ANIMATED` table, or `null` when no file in the set defines one (every stock IWAD).
 * {@link Wad.find} returns the **last** definition: Boom's lump replaces the built-in table
 * outright rather than adding to it — see docs/render.md § Animated textures.
 */
export function readAnimated(wad: Wad): AnimDef[] | null {
  const lump = wad.find('ANIMATED');
  if (!lump) return null;
  const r = wad.reader(lump);
  const out: AnimDef[] = [];
  for (let start = 0; start < lump.size; start += RECORD_SIZE) {
    r.seek(start);
    const istexture = r.u8();
    if (istexture === TERMINATOR) break;
    // A record cut short without a terminator is a malformed lump; keep what
    // parsed rather than losing the whole table.
    if (start + RECORD_SIZE > lump.size) break;
    const end = r.name(9);
    const first = r.name(9);
    const speedTics = r.i32();
    // `istexture` is a wall texture when non-zero, a flat when 0 — the inverse
    // sense of `AnimDef.kind`, so it is spelled out rather than cast.
    // A non-positive speed would divide by zero in the animator's own clock.
    if (!first || !end || speedTics <= 0) continue;
    out.push({ kind: istexture !== 0 ? 'wall' : 'flat', start: first, end, speedTics });
  }
  return out;
}
