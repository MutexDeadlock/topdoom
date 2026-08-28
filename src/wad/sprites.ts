/**
 * `SpriteBank`: indexes the WAD's sprite lumps (S_START..S_END) by sprite name, frame letter and
 * rotation, so a thing's facing resolves to a lump — through a DEHACKED `[SPRITES]` rename where a
 * patch made one. See docs/sprites.md.
 */
import type { Lump, Wad } from './wad.ts';

export interface SpriteFrame {
  /** Lump name to read as a Bitmap via GraphicsBank.picture(). */
  lump: string;
  /** True if this rotation is the lump's image mirrored horizontally. */
  flip: boolean;
}

const SPRITE_START = /^(S|SS)_START$/;
const SPRITE_END = /^(S|SS)_END$/;

/**
 * Sprite names a DEHACKED `[SPRITES]` section (or a vanilla `Text 4 4`) has renamed: the pristine
 * `sprnames[]` name to the four characters its lumps now start with, both uppercased. Empty unless
 * a patch said otherwise. Read once, when a `SpriteBank` is built — `game.ts` builds it after
 * `applyDehacked` — so a lookup pays nothing for it. docs/dehacked.md § Sprite renames.
 */
const SPRITE_RENAMES = new Map<string, string>();

/**
 * Redirects one sprite name to another lump prefix — a BEX `[SPRITES]` entry, `d_deh.c`'s
 * `deh_procBexSprites`.
 */
export function setSpriteLump(name: string, to: string): void {
  SPRITE_RENAMES.set(name.toUpperCase(), to.toUpperCase());
}

/** Forgets every `[SPRITES]` rename, back to every sprite drawing its own lumps. */
export function resetSpriteLumps(): void {
  SPRITE_RENAMES.clear();
}

/**
 * Indexes sprite lumps (S_START..S_END) by sprite name and frame letter, so a
 * thing's facing can be turned into the matching lump. DOOM sprite names are
 * SSSSFRfr: a 4-letter sprite, a frame letter, a rotation digit (0 = the only
 * view, used for objects that look the same from every angle; 1-8 = the eight
 * directions DOOM renders directional things from), and optionally a second
 * frame+rotation pair meaning "this same lump, mirrored, is also that other
 * rotation" — the usual way DOOM halves the art needed for symmetric actors.
 *
 * A renamed sprite (`SPRITE_RENAMES`) is indexed under the name things ask for
 * as well as its own: `POSS = ZOMB` files every `ZOMB*` lump under `POSS` too,
 * so `lookup('POSS', …)` finds it with no per-call indirection.
 */
export class SpriteBank {
  private frames = new Map<string, Map<string, SpriteFrame>>();

  constructor(wad: Wad) {
    const aliases = new Map<string, string[]>();
    for (const [from, to] of SPRITE_RENAMES) {
      const under = aliases.get(to) ?? [];
      under.push(from);
      aliases.set(to, under);
    }
    const lumps = wad.markedRange(SPRITE_START, SPRITE_END);
    // Both passes walk newest-first, and the aliases go first: a slot keeps its first claimant, so
    // this order is what makes the last lump in load order win a slot and an alias outrank every
    // own-name lump. `aliases` is empty for all but a `[SPRITES]` patch, so that pass is normally
    // skipped outright. docs/sprites.md § Rotation 0 against directional frames,
    // docs/dehacked.md § Sprite renames.
    if (aliases.size > 0) {
      for (let i = lumps.length - 1; i >= 0; i--) {
        const under = aliases.get(lumps[i].name.slice(0, 4));
        if (under) for (const alias of under) this.index(lumps[i], alias);
      }
    }
    for (let i = lumps.length - 1; i >= 0; i--) this.index(lumps[i], lumps[i].name.slice(0, 4));
  }

  private index(lump: Lump, sprite: string): void {
    const name = lump.name;
    if (name.length < 6) return;
    this.addFrame(sprite, name[4], name[5], name, false);
    if (name.length >= 8) this.addFrame(sprite, name[6], name[7], name, true);
  }

  /**
   * Claims rotation slots for one lump, the first claim on a slot standing: a `rot=0` lump takes
   * every slot still free, and keeps a single `'0'` entry where it reached the frame untouched —
   * which is the overwhelmingly common frame, and why `lookup` needs no ordering state.
   * Callers walk newest-first. docs/sprites.md § Rotation 0 against directional frames.
   */
  private addFrame(sprite: string, frame: string, rotation: string, lump: string, flip: boolean): void {
    if (!/[A-Z]/.test(frame) || !/[0-8]/.test(rotation)) return;
    const key = sprite + frame;
    let byRotation = this.frames.get(key);
    if (!byRotation) this.frames.set(key, (byRotation = new Map()));
    if (byRotation.has('0')) return; // a newer rot=0 lump already took all eight
    if (rotation !== '0') {
      if (!byRotation.has(rotation)) byRotation.set(rotation, { lump, flip });
      return;
    }
    if (byRotation.size === 0) {
      byRotation.set('0', { lump, flip });
      return;
    }
    const shared = { lump, flip };
    for (let digit = 1; digit <= 8; digit++) {
      const slot = String(digit);
      if (!byRotation.has(slot)) byRotation.set(slot, shared);
    }
  }

  /**
   * Lump for this sprite/frame/rotation digit (1-8); falls back to the omnidirectional "0" frame.
   */
  lookup(sprite: string, frame: string, rotationDigit: number): SpriteFrame | undefined {
    const byRotation = this.frames.get(sprite.toUpperCase() + frame.toUpperCase());
    if (!byRotation) return undefined;
    return byRotation.get('0') ?? byRotation.get(String(rotationDigit));
  }
}
