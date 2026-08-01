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
 * Indexes sprite lumps (S_START..S_END) by sprite name and frame letter, so a
 * thing's facing can be turned into the matching lump. DOOM sprite names are
 * SSSSFRfr: a 4-letter sprite, a frame letter, a rotation digit (0 = the only
 * view, used for objects that look the same from every angle; 1-8 = the eight
 * directions DOOM renders directional things from), and optionally a second
 * frame+rotation pair meaning "this same lump, mirrored, is also that other
 * rotation" — the usual way DOOM halves the art needed for symmetric actors.
 */
export class SpriteBank {
  private frames = new Map<string, Map<string, SpriteFrame>>();

  constructor(wad: Wad) {
    for (const lump of wad.markedRange(SPRITE_START, SPRITE_END)) this.index(lump);
  }

  private index(lump: Lump): void {
    const name = lump.name;
    if (name.length < 6) return;
    const sprite = name.slice(0, 4);
    this.addFrame(sprite, name[4], name[5], name, false);
    if (name.length >= 8) this.addFrame(sprite, name[6], name[7], name, true);
  }

  private addFrame(sprite: string, frame: string, rotation: string, lump: string, flip: boolean): void {
    if (!/[A-Z]/.test(frame) || !/[0-8]/.test(rotation)) return;
    const key = sprite + frame;
    let byRotation = this.frames.get(key);
    if (!byRotation) this.frames.set(key, (byRotation = new Map()));
    if (!byRotation.has(rotation)) byRotation.set(rotation, { lump, flip });
  }

  /** Lump for this sprite/frame/rotation digit (1-8); falls back to the omnidirectional "0" frame. */
  lookup(sprite: string, frame: string, rotationDigit: number): SpriteFrame | undefined {
    const byRotation = this.frames.get(sprite.toUpperCase() + frame.toUpperCase());
    if (!byRotation) return undefined;
    return byRotation.get('0') ?? byRotation.get(String(rotationDigit));
  }
}
