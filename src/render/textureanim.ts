/**
 * Vanilla's animated flats and wall textures (`p_spec.c`'s `animdefs[]`), stepped on the tic
 * through `MaterialBank`. See docs/render.md § Animated textures.
 */
import type { GraphicsBank } from '../wad/graphics.ts';
import type { AnimDef } from '../wad/animated.ts';
import type { MaterialBank, SurfaceKind } from './textures.ts';
import { DOOM_TIC } from '../constants.ts';

/**
 * `animdefs[]`, `p_spec.c` (linuxdoom-1.10), verbatim: every flat and wall
 * texture vanilla animates, as (kind, first name, last name, tics/frame) —
 * the in-between frames are resolved from WAD lump order at construction
 * time, not spelled out here. See docs/render.md § Animated textures for
 * why (e.g. `FIREWALA`..`FIREWALL` isn't a naming-pattern mismatch).
 *
 * The built-in table, used when the WAD set ships no `ANIMATED` lump. One
 * that does replaces this outright rather than adding to it — see
 * `wad/animated.ts`.
 */
const ANIM_DEFS: AnimDef[] = [
  { kind: 'flat', start: 'NUKAGE1', end: 'NUKAGE3', speedTics: 8 },
  { kind: 'flat', start: 'FWATER1', end: 'FWATER4', speedTics: 8 },
  { kind: 'flat', start: 'SWATER1', end: 'SWATER4', speedTics: 8 },
  { kind: 'flat', start: 'LAVA1', end: 'LAVA4', speedTics: 8 },
  { kind: 'flat', start: 'BLOOD1', end: 'BLOOD3', speedTics: 8 },
  // DOOM II flat animations.
  { kind: 'flat', start: 'RROCK05', end: 'RROCK08', speedTics: 8 },
  { kind: 'flat', start: 'SLIME01', end: 'SLIME04', speedTics: 8 },
  { kind: 'flat', start: 'SLIME05', end: 'SLIME08', speedTics: 8 },
  { kind: 'flat', start: 'SLIME09', end: 'SLIME12', speedTics: 8 },
  { kind: 'wall', start: 'BLODGR1', end: 'BLODGR4', speedTics: 8 },
  { kind: 'wall', start: 'SLADRIP1', end: 'SLADRIP3', speedTics: 8 },
  { kind: 'wall', start: 'BLODRIP1', end: 'BLODRIP4', speedTics: 8 },
  { kind: 'wall', start: 'FIREWALA', end: 'FIREWALL', speedTics: 8 },
  { kind: 'wall', start: 'GSTFONT1', end: 'GSTFONT3', speedTics: 8 },
  { kind: 'wall', start: 'FIRELAV3', end: 'FIRELAVA', speedTics: 8 },
  { kind: 'wall', start: 'FIREMAG1', end: 'FIREMAG3', speedTics: 8 },
  { kind: 'wall', start: 'FIREBLU1', end: 'FIREBLU2', speedTics: 8 },
  { kind: 'wall', start: 'ROCKRED1', end: 'ROCKRED3', speedTics: 8 },
  { kind: 'wall', start: 'BFALL1', end: 'BFALL4', speedTics: 8 },
  { kind: 'wall', start: 'SFALL1', end: 'SFALL4', speedTics: 8 },
  { kind: 'wall', start: 'WFALL1', end: 'WFALL4', speedTics: 8 },
  { kind: 'wall', start: 'DBRAIN1', end: 'DBRAIN4', speedTics: 8 },
];

interface Sequence {
  kind: SurfaceKind;
  /** Every frame's name, in WAD order, start..end inclusive. */
  names: string[];
  speedSeconds: number;
  /**
   * Last `floor(elapsed / speedSeconds)` this sequence was drawn at, so `update` only touches
   * materials on the tic a frame actually changes.
   */
  lastTic: number;
}

/**
 * Vanilla's `P_UpdateSpecials` "ANIMATE FLATS AND TEXTURES GLOBALLY" pass —
 * the other half of what `render/occlusion.ts: SurfaceScroller` covers for
 * special-48 scrolling. Repoints each affected name's already-built material
 * at a different bitmap every few tics (`MaterialBank.setFrame`); no geometry
 * work needed. Per-frame phase is counted from each sequence's own start
 * rather than vanilla's absolute texture-table index. See docs/render.md §
 * Animated textures for both.
 */
export class AnimatedTextures {
  private bank: MaterialBank;
  private sequences: Sequence[] = [];
  private elapsed = 0;

  /**
   * `defs` is the table to animate: the WAD set's own `ANIMATED` lump when it
   * has one (`wad/animated.ts: readAnimated`), the built-in vanilla table
   * otherwise. Boom's lump *replaces* rather than extends, which is why this
   * takes one table instead of merging two.
   */
  constructor(gfx: GraphicsBank, bank: MaterialBank, defs: readonly AnimDef[] = ANIM_DEFS) {
    this.bank = bank;
    const order: Record<SurfaceKind, string[]> = {
      wall: gfx.textureNamesInOrder(),
      flat: gfx.flatNamesInOrder(),
    };
    for (const def of defs) {
      const names = order[def.kind];
      const startIdx = names.indexOf(def.start);
      const endIdx = names.indexOf(def.end);
      // Missing (an episode-exclusive sequence in the wrong IWAD) or
      // out-of-order (a malformed PWAD) — vanilla itself skips/aborts on the
      // same "different episode?" check (P_InitPicAnims).
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) continue;
      this.sequences.push({
        kind: def.kind,
        names: names.slice(startIdx, endIdx + 1),
        speedSeconds: def.speedTics * DOOM_TIC,
        lastTic: -1,
      });
    }
  }

  update(dt: number): void {
    if (this.sequences.length === 0) return;
    // `elapsed` is what every frame index below is derived from, so it must
    // never run backwards: a negative total floors to a negative `tic`, and
    // JS's `%` keeps the sign, so `names[-1]` comes back undefined and the
    // frame loop dies. `game.ts` already clamps `rawDt` at the source; this
    // keeps the invariant with the accumulator that depends on it.
    this.elapsed = Math.max(0, this.elapsed + dt);
    for (const seq of this.sequences) {
      const tic = Math.floor(this.elapsed / seq.speedSeconds);
      if (tic === seq.lastTic) continue;
      seq.lastTic = tic;
      const n = seq.names.length;
      for (let i = 0; i < n; i++) {
        const name = seq.names[i];
        if (!this.bank.has(seq.kind, name)) continue;
        this.bank.setFrame(seq.kind, name, seq.names[(tic + i) % n]);
      }
    }
  }
}
