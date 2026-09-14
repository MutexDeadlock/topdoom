/**
 * Decodes the two lumps a Hexen-format map re-encodes — LINEDEFS and THINGS — and
 * normalizes them to the same records and Doom-flavored flag bits a Doom-format map
 * yields, so nothing downstream sees a format difference. Record layouts and flag bits
 * follow gzdoom's `doomdata.h`. See docs/wad.md § Map formats.
 */
import { records } from '../reader.ts';
import type { LineDef, Thing } from './defs.ts';

/** `maplinedef2_t`: two bytes more than Doom's, `special` and `args` where the tag was. */
const LINEDEF_SIZE = 16;
/** `mapthinghexen_t`: a `tid` in front, then `z`, `special` and `args` Doom has no room for. */
const THING_SIZE = 20;

/**
 * `ML_BLOCKING` … `ML_MAPPED` — everything below `ML_REPEAT_SPECIAL`, shared verbatim with Doom.
 */
const SHARED_LINE_FLAGS = 0x01ff;
/** `ML_BLOCK_PLAYERS`, and `ML_BLOCKEVERYTHING` beside it. */
const BLOCK_PLAYERS = 0x4000;
const BLOCK_EVERYTHING = 0x8000;
/** `LF.BLOCKING`, named here because this module states Hexen's own bit layout. */
const BLOCKING = 0x0001;

/** The skill bits and `MTF_AMBUSH`, which Hexen and Doom agree on. */
const SHARED_THING_FLAGS = 0x000f;
/** `MTF_SINGLE` — set when a thing appears in single player, where Doom states the opposite. */
const SINGLE = 0x0100;
/** Doom's `MTF_NOTSINGLE`, the bit {@link SINGLE}'s absence maps onto. */
const NOTSINGLE = 0x0010;

/**
 * {@link LineDef.special} and {@link LineDef.tag} come out 0: a Hexen action special is a ZDoom
 * number in a namespace of its own, so the raw number and its args are parked in
 * {@link LineDef.action} instead of reaching the Doom tables.
 * docs/wad.md § What a Hexen map does not get.
 */
export function readLinedefs(data: Uint8Array | undefined): LineDef[] {
  return records(data, 0, LINEDEF_SIZE, (r) => {
    const v1 = r.u16();
    const v2 = r.u16();
    const flags = r.u16();
    const special = r.u8();
    const args = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
    return {
      v1,
      v2,
      flags: lineFlags(flags),
      special: 0,
      tag: 0,
      right: r.u16(),
      left: r.u16(),
      action: { special, args },
    };
  });
}

/** The `tid`, `z` and per-thing action special are read past — nothing consumes them. */
export function readThings(data: Uint8Array | undefined): Thing[] {
  return records(data, 0, THING_SIZE, (r) => {
    r.u16();
    const x = r.i16();
    const y = r.i16();
    r.i16();
    return {
      x,
      y,
      angle: r.i16(),
      type: r.u16(),
      flags: thingFlags(r.u16()),
    };
  });
}

/**
 * A Hexen line's flags as `LF` bits. From `ML_REPEAT_SPECIAL` (0x0200) up the two
 * layouts disagree, so those bits are dropped rather than copied.
 *
 * Deliberate deviation: `ML_BLOCK_PLAYERS` and `ML_BLOCKEVERYTHING` both become plain
 * {@link BLOCKING}, there being no `LF` bit for "blocks the player but not monsters".
 * docs/wad.md § Flags are translated, not copied.
 */
function lineFlags(flags: number): number {
  const out = flags & SHARED_LINE_FLAGS;
  return flags & (BLOCK_PLAYERS | BLOCK_EVERYTHING) ? out | BLOCKING : out;
}

/**
 * A Hexen thing's flags as Doom's. The single-player gate inverts, and `MTF_DORMANT` —
 * which sits on Doom's `MTF_NOTSINGLE` — and the player-class bits are dropped.
 * docs/wad.md § Flags are translated, not copied.
 */
function thingFlags(flags: number): number {
  const out = flags & SHARED_THING_FLAGS;
  return flags & SINGLE ? out : out | NOTSINGLE;
}
