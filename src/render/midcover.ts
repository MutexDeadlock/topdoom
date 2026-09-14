/**
 * Which midtextures hide what is past them: one opaque over the whole of a two-sided line's opening
 * is a wall at eye level, whatever gap it hangs in. Built from the set's texture art, so only
 * drawing may ask it — the fog's draw gate. docs/fogofwar.md § Covering midtextures.
 */
import { isTextured, LF, NO_SIDE } from '../wad/map.ts';
import type { Bitmap } from '../wad/graphics.ts';
import type { Transfers } from '../game/specials/transfers.ts';
import type { Opening, World } from '../game/world.ts';

/** A midtexture's rows as {@link MidCover.hides} reads them. */
interface CoverTexture {
  height: number;
  /** How many rows above each row index have a transparent pixel anywhere; `height + 1` long. */
  holes: Int32Array;
}

/** What a {@link MidCover} is built with beyond the map and its art. */
export interface MidCoverOptions {
  /**
   * Which lines Boom's 260 draws translucent or strips of their midtexture; such a line hides
   * nothing.
   */
  transfers?: Pick<Transfers, 'translucentLine' | 'midtexSuppressed'>;
  /**
   * Sectors a special can drive (`scanSectors`' `movable`). A line between two that hold still is
   * answered once at build and never asked again if it cannot hide; absent, every line with a
   * midtexture stays a {@link MidCover.candidate}.
   */
  movableSectors?: ReadonlySet<number>;
}

/**
 * The covering-midtexture table for one map: per side of every two-sided line, the midtexture that
 * could hide its opening. Built once at load; a mover's opening is asked live, as it stands.
 */
export class MidCover {
  /** Per line, whether {@link MidCover.hides} could ever say yes for it — the per-ray reject. */
  private candidates: Uint8Array;
  /** Per side slot (`line * 2 + side`), an index into {@link MidCover.textures}, or -1. */
  private sideTexture: Int32Array;
  /** Per side slot, that sidedef's row offset. */
  private rowOffset: Float64Array;
  private lowerUnpegged: Uint8Array;
  private textures: CoverTexture[] = [];

  /**
   * @param texture  the set's wall texture by name — `GraphicsBank.texture`
   */
  constructor(world: World, texture: (name: string) => Bitmap | null, options: MidCoverOptions = {}) {
    const { transfers, movableSectors } = options;
    const map = world.map;
    const opening: Opening = { top: 0, bottom: 0 };
    const lines = map.linedefs.length;
    this.candidates = new Uint8Array(lines);
    this.sideTexture = new Int32Array(lines * 2).fill(-1);
    this.rowOffset = new Float64Array(lines * 2);
    this.lowerUnpegged = new Uint8Array(lines);
    const byName = new Map<string, number>();
    for (let i = 0; i < lines; i++) {
      const line = map.linedefs[i];
      if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
      if (transfers?.translucentLine(i) || transfers?.midtexSuppressed(i)) continue;
      this.lowerUnpegged[i] = line.flags & LF.LOWER_UNPEGGED ? 1 : 0;
      let textured = false;
      for (let side = 0; side < 2; side++) {
        const sidedef = map.sidedefs[side === 0 ? line.right : line.left];
        if (!sidedef || !isTextured(sidedef.middle)) continue;
        const name = sidedef.middle.toUpperCase();
        let t = byName.get(name);
        if (t === undefined) {
          const rows = coverTexture(texture(name));
          t = rows ? this.textures.push(rows) - 1 : -1;
          byName.set(name, t);
        }
        if (t < 0) continue;
        this.sideTexture[i * 2 + side] = t;
        this.rowOffset[i * 2 + side] = sidedef.yOffset;
        textured = true;
      }
      if (textured && this.mayHide(world, i, movableSectors, opening)) {
        this.candidates[i] = 1;
      }
    }
  }

  /** Whether {@link MidCover.hides} could ever say yes for line `lineIndex`. */
  candidate(lineIndex: number): boolean {
    return this.candidates[lineIndex] === 1;
  }

  /**
   * Whether the midtexture on side `side` of line `lineIndex` hides an opening from `bottom` to
   * `top`: hung where `R_RenderMaskedSegRange` (`r_segs.c`) and `mapmesh/walls.ts` hang it, and
   * opaque across every row that opening shows.
   *
   * @param side  0 front, 1 back — the eye's side, as `World.pointOnLineSide` answers it
   */
  hides(lineIndex: number, side: number, bottom: number, top: number): boolean {
    const slot = lineIndex * 2 + side;
    const t = this.sideTexture[slot];
    if (t < 0) return false;
    const { height, holes } = this.textures[t];
    // Row 0's height: lower-unpegged anchors the bottom edge on the opening's floor, otherwise the
    // top edge hangs from its ceiling; the row offset moves either.
    const texTop = (this.lowerUnpegged[lineIndex] ? bottom + height : top) + this.rowOffset[slot];
    const first = Math.floor(texTop - top);
    const end = Math.ceil(texTop - bottom);
    if (first < 0 || end > height) return false;
    return holes[end] === holes[first];
  }

  /**
   * Whether line `lineIndex` can ever hide its opening: always where a mover may change that
   * opening, otherwise only if a side hides the opening the load left it.
   *
   * @param o  scratch for {@link World.openingInto}
   */
  private mayHide(world: World, lineIndex: number, movable: ReadonlySet<number> | undefined, o: Opening): boolean {
    if (!world.openingInto(lineIndex, o)) return false;
    const { linedefs, sidedefs } = world.map;
    const line = linedefs[lineIndex];
    if (!movable || movable.has(sidedefs[line.right].sector) || movable.has(sidedefs[line.left].sector)) {
      return true;
    }
    return o.top > o.bottom && (this.hides(lineIndex, 0, o.bottom, o.top) || this.hides(lineIndex, 1, o.bottom, o.top));
  }
}

/** A texture's {@link CoverTexture}, or null where the art is missing or no row of it is opaque. */
function coverTexture(bmp: Bitmap | null): CoverTexture | null {
  if (!bmp || bmp.width === 0 || bmp.height === 0) return null;
  const holes = new Int32Array(bmp.height + 1);
  for (let y = 0; y < bmp.height; y++) {
    let hole = 0;
    for (let x = 0; x < bmp.width; x++) {
      if (bmp.data[(y * bmp.width + x) * 4 + 3] < 255) {
        hole = 1;
        break;
      }
    }
    holes[y + 1] = holes[y] + hole;
  }
  return holes[bmp.height] === bmp.height ? null : { height: bmp.height, holes };
}
