/**
 * DOOM's random numbers, which are not random: a fixed 256-byte table and two
 * cursors that walk it. Everything in this engine that fuzzes a value — damage
 * dice, pellet spread, pain chance, an AI decision, a light's dark period —
 * draws from here and nowhere else — through the two cursors below, or through
 * the shared draw *shapes* at the bottom of this file (`rollDamage`,
 * `triangularDraw`, `triangularSpread`), which every layer from weapons to the
 * Icon of Sin's spitter reuses rather than rewriting the arithmetic.
 *
 * docs/random.md § The table and the two cursors.
 */

/**
 * `m_random.c`'s `rndtable`, verbatim, kept in the source's own 14-per-row
 * layout so it can be diffed against the C file line by line. Exported for the
 * test that checks that transcription — read it through `pRandom`/`mRandom`,
 * never by index, or the draw won't advance a cursor.
 */
export const RNDTABLE = new Uint8Array([
  0, 8, 109, 220, 222, 241, 149, 107, 75, 248, 254, 140, 16, 66,
  74, 21, 211, 47, 80, 242, 154, 27, 205, 128, 161, 89, 77, 36,
  95, 110, 85, 48, 212, 140, 211, 249, 22, 79, 200, 50, 28, 188,
  52, 140, 202, 120, 68, 145, 62, 70, 184, 190, 91, 197, 152, 224,
  149, 104, 25, 178, 252, 182, 202, 182, 141, 197, 4, 81, 181, 242,
  145, 42, 39, 227, 156, 198, 225, 193, 219, 93, 122, 175, 249, 0,
  175, 143, 70, 239, 46, 246, 163, 53, 163, 109, 168, 135, 2, 235,
  25, 92, 20, 145, 138, 77, 69, 166, 78, 176, 173, 212, 166, 113,
  94, 161, 41, 50, 239, 49, 111, 164, 70, 60, 2, 37, 171, 75,
  136, 156, 11, 56, 42, 146, 138, 229, 73, 146, 77, 61, 98, 196,
  135, 106, 63, 197, 195, 86, 96, 203, 113, 101, 170, 247, 181, 113,
  80, 250, 108, 7, 255, 237, 129, 226, 79, 107, 112, 166, 103, 241,
  24, 223, 239, 120, 198, 58, 60, 82, 128, 3, 184, 66, 143, 224,
  145, 224, 81, 206, 163, 45, 63, 90, 168, 114, 59, 33, 159, 95,
  28, 139, 123, 98, 125, 196, 15, 70, 194, 253, 54, 14, 109, 226,
  71, 17, 161, 93, 186, 87, 244, 138, 20, 52, 123, 251, 26, 36,
  17, 46, 52, 231, 232, 76, 31, 221, 84, 37, 216, 165, 212, 106,
  197, 242, 98, 43, 39, 175, 254, 145, 190, 84, 118, 222, 187, 136,
  120, 163, 236, 249,
]);

/**
 * The two cursors into the table, module-level exactly as vanilla's `prndindex`/`rndindex` are —
 * docs/random.md § Why the cursors are global.
 */
let prndindex = 0;
let rndindex = 0;

/**
 * `P_Random`: the next table entry, 0-255, off the **play simulation's** cursor.
 * Every gameplay draw goes through this one — a draw taken here shifts what
 * every later gameplay draw sees, which is the property the two-cursor split
 * exists to protect. docs/random.md § The table and the two cursors.
 */
export function pRandom(): number {
  prndindex = (prndindex + 1) & 0xff;
  return RNDTABLE[prndindex];
}

/**
 * `M_Random`: the same table, off a **separate** cursor reserved for draws
 * outside the simulation. `audio/sfx.ts`'s pitch wobble is its only caller,
 * exactly as in vanilla. docs/random.md § The table and the two cursors.
 */
export function mRandom(): number {
  rndindex = (rndindex + 1) & 0xff;
  return RNDTABLE[rndindex];
}

/**
 * `M_ClearRandom`: both cursors back to 0, called at level load. Note this does
 * *not* make a run reproducible in this engine — docs/random.md § What this
 * does not buy.
 */
export function clearRandom(): void {
  prndindex = 0;
  rndindex = 0;
}

/** Both cursors, for a savegame. docs/random.md § Why the cursors are global. */
export function getRandomCursors(): { p: number; m: number } {
  return { p: prndindex, m: rndindex };
}

/**
 * Restores saved cursors. A savegame applies this *after* every other restore
 * step, since rebuilding the level draws from the table on the way —
 * docs/savegames.md § Apply order.
 */
export function setRandomCursors(cursors: { p: number; m: number }): void {
  prndindex = cursors.p & 0xff;
  rndindex = cursors.m & 0xff;
}

/**
 * `((P_Random() % sides) + 1) * multiplier` — vanilla's own damage-roll shape. 0 sides means
 * "always 0".
 */
export function rollDamage(sides: number, multiplier: number): number {
  return sides > 0 ? ((pRandom() % sides) + 1) * multiplier : 0;
}

/**
 * Vanilla's `P_Random()-P_Random()` shape: a triangular draw centred on 0 and
 * `width` wide at its extremes, in whatever unit the caller counts in. Every
 * random fuzz in the game is this one distribution.
 *
 * The `/255` is what makes `width` mean what every caller's constant already
 * says it means — the value at vanilla's `255 << shift` extreme — while keeping
 * the draw on the table's own integer grid. Two separate `pRandom()` calls, and
 * subtracting *adjacent* table entries is the point: see docs/random.md
 * § The triangular draw.
 */
export function triangularDraw(width: number): number {
  return ((pRandom() - pRandom()) / 255) * width;
}

/**
 * `triangularDraw` in degrees, returned as radians off-aim — the angular half
 * of it: the player's pellet spread and melee swing, a monster bullet's
 * `<<20`, `A_FaceTarget`'s `MF_SHADOW` `<<21`. The super shotgun's *slope*
 * jitter (`game/weapons.ts`'s `WeaponDef.slopeSpread`) is the one that isn't an
 * angle.
 */
export function triangularSpread(deg: number): number {
  return (triangularDraw(deg) * Math.PI) / 180;
}
