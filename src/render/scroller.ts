/**
 * Applies Boom's scrolling texture offsets to the static batches: the wall quads and flat fans
 * `mapmesh.ts` built, rewritten in place each frame from the offsets `game/specials/forces.ts`
 * accumulates. See docs/render.md § Scrolling textures.
 */
import * as THREE from 'three';
import { FLAT_TEX_SIZE, type FlatSurface, type WallOccluder } from './mapmesh.ts';
import type { MaterialBank } from './textures.ts';

/**
 * The half of `BuiltMap` a scroller indexes: the surfaces it may animate, and the meshes holding
 * them. Taken as one record rather than four parameters, since `BuiltMap` already owns all four
 * (docs/conventions.md § Named arguments) and satisfies this structurally.
 */
export interface ScrollableGeometry {
  occluders: readonly WallOccluder[];
  wallMeshes: Map<string, THREE.Mesh>;
  flatSurfaces: readonly FlatSurface[];
  flatMeshes: Map<string, THREE.Mesh>;
}

/**
 * The accumulated texture offsets this scroller draws, in map units — the read side of
 * `game/specials/forces.ts: Forces`, declared structurally so the render layer keeps no import edge
 * into the game layer (the `SwitchPairLookup` precedent). {@link ScrollOffsets.scrollingLines} and
 * {@link ScrollOffsets.scrollingFlats} are read once, at index time.
 */
export interface ScrollOffsets {
  scrollingLines(): readonly number[];
  scrollingFlats(): readonly { sector: number; isCeiling: boolean }[];
  sideOffset(lineIndex: number): { readonly x: number; readonly y: number };
  flatOffset(sectorIndex: number, isCeiling: boolean): { readonly x: number; readonly y: number };
}

/**
 * One static-batch wall quad a scroller animates, with everything needed to rewrite its UVs each
 * frame without re-deriving them from the linedef.
 */
interface ScrollingWall {
  /**
   * The batch's UV buffer, resolved once at index time. The static meshes are built once per level
   * and this scroller with them, so the attribute cannot go stale — see {@link SurfaceScroller}.
   */
  attr: THREE.BufferAttribute;
  line: number;
  vertexStart: number;
  /**
   * The quad's own original U at its left/right edges and V at its top/bottom (indices 0/1/3 vs.
   * 2/4/5, and 0 vs. 1 — see `addWall`'s fixed `[A, D, C, A, C, B]` push order in mapmesh.ts), read
   * back once from the geometry at index time rather than recomputed, so this doesn't need to know
   * xOffset/yOffset/texture length itself.
   */
  u0: number;
  u1: number;
  vTop: number;
  vBot: number;
  /**
   * UV units per map unit of scroll — `1 / textureWidth` and `1 / textureHeight`, so a narrow
   * texture's pattern visibly cycles faster than a wide one for the same rate, matching vanilla's
   * own offset-over-dimension UV math.
   */
  uPerUnit: number;
  vPerUnit: number;
  /**
   * Last offset written into the buffer, so an unchanged surface costs no rewrite and no re-upload.
   */
  lastDu: number;
  lastDv: number;
}

/**
 * One static-batch flat fan a scroller animates. Flats are arbitrary-length fans, so their
 * untouched UVs are kept whole rather than as two edge values.
 */
interface ScrollingFlat {
  /** The batch's UV buffer, resolved once at index time — see {@link ScrollingWall}. */
  attr: THREE.BufferAttribute;
  sector: number;
  isCeiling: boolean;
  vertexStart: number;
  /** `[u, v]` per vertex as built, the base every frame's offset is added to. */
  base: Float32Array;
  /** Last offset written into the buffer — see {@link ScrollingWall}. */
  lastDu: number;
  lastDv: number;
}

/**
 * Draws Boom's scrolling surfaces — walls (48, 85, 254, 255 and the
 * displacement/accelerative variants) and floor/ceiling flats (250-253) —
 * by rewriting the indexed quads' and fans' UVs from the offsets
 * `game/specials/forces.ts` accumulated. The offsets are simulation state; this
 * only applies them. **Static-batch geometry only** — a sector that both
 * scrolls and moves keeps its mover mesh unscrolled.
 * See docs/render.md § Scrolling textures.
 */
export class SurfaceScroller {
  /**
   * The one source this scroller's index was built against — {@link ScrollOffsets.scrollingLines}
   * and {@link ScrollOffsets.scrollingFlats} were read from it at construction, so a later frame's
   * offsets can only come from the same object.
   */
  private offsets: ScrollOffsets;
  private walls: ScrollingWall[] = [];
  private flats: ScrollingFlat[] = [];

  constructor(offsets: ScrollOffsets, built: ScrollableGeometry, bank: MaterialBank) {
    const { occluders, wallMeshes, flatSurfaces, flatMeshes } = built;
    this.offsets = offsets;

    const lines = new Set(offsets.scrollingLines());
    for (const o of occluders) {
      if (!lines.has(o.line) || !o.frontSide) continue;
      const attr = wallMeshes.get(o.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const dim = bank.size('wall', o.texName);
      if (!dim || dim.w <= 0 || dim.h <= 0) continue;
      this.walls.push({
        attr,
        line: o.line,
        vertexStart: o.vertexStart,
        u0: attr.getX(o.vertexStart), // index 0: one of the quad's two "A" copies (see addWall's push order)
        u1: attr.getX(o.vertexStart + 2), // index 2: one of the quad's two "C" copies
        vTop: attr.getY(o.vertexStart),
        vBot: attr.getY(o.vertexStart + 1), // index 1: "D", the quad's bottom-left
        uPerUnit: 1 / dim.w,
        vPerUnit: 1 / dim.h,
        lastDu: 0,
        lastDv: 0,
      });
    }

    const flats = new Set(offsets.scrollingFlats().map((f) => flatKey(f.sector, f.isCeiling)));
    for (const s of flatSurfaces) {
      if (!flats.has(flatKey(s.sector, s.isCeiling))) continue;
      const attr = flatMeshes.get(s.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const base = new Float32Array(s.vertexCount * 2);
      for (let v = 0; v < s.vertexCount; v++) {
        base[v * 2] = attr.getX(s.vertexStart + v);
        base[v * 2 + 1] = attr.getY(s.vertexStart + v);
      }
      this.flats.push({
        attr,
        sector: s.sector,
        isCeiling: s.isCeiling,
        vertexStart: s.vertexStart,
        base,
        lastDu: 0,
        lastDv: 0,
      });
    }
  }

  update(): void {
    const offsets = this.offsets;
    // Keyed on the buffer, not the batch key: every surface in one batch shares an attribute, so
    // this dedups the re-upload exactly as a key set did.
    const dirty = new Set<THREE.BufferAttribute>();
    for (const w of this.walls) {
      const attr = w.attr;
      const offset = offsets.sideOffset(w.line);
      // Bounded to [0, 1) so the value actually written into the (single-
      // precision) buffer never grows large enough to lose precision over a
      // long session — three.js's RepeatWrapping (see MaterialBank.toTexture)
      // already makes an unwrapped UV outside [0, 1] render correctly on its
      // own, so this wrap is purely a float32-precision safeguard, not a
      // correctness requirement.
      const du = (offset.x * w.uPerUnit) % 1;
      const dv = (offset.y * w.vPerUnit) % 1;
      // A displacement/accelerative scroller sits at rate 0 whenever its control
      // sector is idle, so its offset is unchanged most frames — and a batch key
      // covers every wall sharing a texture, so re-uploading one costs the whole
      // buffer. Same skip-if-unchanged shape as `WallFader.commit`.
      if (du === w.lastDu && dv === w.lastDv) continue;
      w.lastDu = du;
      w.lastDv = dv;
      const u0 = w.u0 + du;
      const u1 = w.u1 + du;
      const vTop = w.vTop + dv;
      const vBot = w.vBot + dv;
      // Matches addWall's fixed [A, D, C, A, C, B] vertex push order:
      // indices 0/1/3 are the quad's left edge (u0), 2/4/5 its right (u1);
      // 0/3/5 its top (vTop), 1/2/4 its bottom (vBot).
      attr.setXY(w.vertexStart, u0, vTop);
      attr.setXY(w.vertexStart + 1, u0, vBot);
      attr.setXY(w.vertexStart + 2, u1, vBot);
      attr.setXY(w.vertexStart + 3, u0, vTop);
      attr.setXY(w.vertexStart + 4, u1, vBot);
      attr.setXY(w.vertexStart + 5, u1, vTop);
      dirty.add(attr);
    }
    for (const attr of dirty) attr.needsUpdate = true;

    dirty.clear();
    for (const f of this.flats) {
      const attr = f.attr;
      const offset = offsets.flatOffset(f.sector, f.isCeiling);
      const du = (offset.x / FLAT_TEX_SIZE) % 1;
      const dv = (offset.y / FLAT_TEX_SIZE) % 1;
      if (du === f.lastDu && dv === f.lastDv) continue;
      f.lastDu = du;
      f.lastDv = dv;
      for (let v = 0; v < f.base.length / 2; v++) {
        attr.setXY(f.vertexStart + v, f.base[v * 2] + du, f.base[v * 2 + 1] + dv);
      }
      dirty.add(attr);
    }
    for (const attr of dirty) attr.needsUpdate = true;
  }
}

function flatKey(sector: number, isCeiling: boolean): number {
  return sector * 2 + (isCeiling ? 1 : 0);
}
