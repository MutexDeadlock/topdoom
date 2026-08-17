/**
 * Fades the walls (and overhanging flats) that sit between the camera and the player, as a
 * dithered discard rather than alpha blending — plus `SurfaceScroller`, which walks the same
 * static-batch geometry to apply Boom's scrolling texture offsets.
 * See docs/render.md § Wall occlusion fading and § Scrolling textures.
 */
import * as THREE from 'three';
import type { FlatSurface, WallOccluder } from './mapmesh.ts';
import type { MaterialBank } from './textures.ts';
import { pointNearConvexPolygon, segmentIntersect } from '../util/geom.ts';
import { dampen } from '../util/damping.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../game/player.ts';
import type { Opening } from '../game/world.ts';
import type { Pos3 } from '../types.ts';

/**
 * Target coverage (0..1) once a wall sits on the camera-player sightline —
 * rendered as a dithered discard (see MaterialBank.get), not real alpha
 * blending, so this reads as "fraction of pixels kept," not translucency.
 */
const FADE_ALPHA = 0.2;
/** Exponential smoothing rate (1/seconds) so fades don't pop in/out per frame. */
const FADE_SPEED = 10;
/** Snap-to-target threshold for `dampen` — see its doc for why this matters. */
const SNAP_EPS = 0.004;

/** A point occlusion is tested against — the player, or an awake monster (see `update`'s doc). */
export type FadeTarget = Pos3;

/**
 * How far an awake monster can be and still count as a fade target.
 * **Tuned by feel** to roughly a room's length, not converted from vanilla.
 * Deliberately a plain distance cap rather than a `hasLineOfSight` gate, which
 * would make the fade a no-op for the case it exists for — docs/render.md §
 * Wall occlusion fading.
 */
const MONSTER_FADE_RANGE = 768;

/**
 * Most awake monsters that can be fade targets at once, nearest first. Purely
 * a cost bound (`WallFader` cost is quads × targets): past a couple of dozen
 * nearby monsters, every wall any of them stands behind is already faded by a
 * nearer one. See docs/monster-ai.md § Spatial indexing.
 */
const MAX_FADE_TARGETS = 48;

/**
 * The player plus the awake monsters near enough to fade walls for, nearest
 * first and capped at `MAX_FADE_TARGETS`. A wall/flat hiding a monster only
 * fades once that monster is alerted — an unseen sleeping one is supposed to
 * stay hidden — so the caller passes `ThingLayer.awakeMonsters()`, not every
 * monster. Both reuse `PLAYER_HEIGHT / 2` as the target height, same as
 * `hasLineOfSight`, there being no per-species table.
 */
export function collectFadeTargets(player: Pos3, awakeMonsters: readonly Pos3[]): FadeTarget[] {
  const nearby = awakeMonsters
    .map((m) => ({ m, d: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((e) => e.d <= MONSTER_FADE_RANGE);
  nearby.sort((a, b) => a.d - b.d);
  return [
    { x: player.x, y: player.y, z: player.z + PLAYER_HEIGHT / 2 },
    ...nearby.slice(0, MAX_FADE_TARGETS).map((e) => ({ x: e.m.x, y: e.m.y, z: e.m.z + PLAYER_HEIGHT / 2 })),
  ];
}

/**
 * Fades the wall quads currently sitting on a camera→target sightline. `update` only computes
 * that factor; a wall's on-screen alpha is its *product* with fog of war's reveal — two systems
 * driving the same vertex-alpha channel — so `commit` writes the combined value once both are
 * known. See docs/render.md § Wall occlusion fading.
 */
export class WallFader {
  private occluders: WallOccluder[];
  private meshes: Map<string, THREE.Mesh>;
  private occlusionAlpha: Float32Array;
  /**
   * The highest combined alpha the last `commit` resolved for each mesh key —
   * zero means every quad that mesh draws is currently invisible, which is what
   * lets a caller skip drawing it entirely (`MoverGeometry.updateFading`).
   * Only filled when `trackVisibility` is on, since maintaining it costs a map
   * lookup per quad per frame and the static batches have tens of thousands of
   * them with no use for the answer.
   * See docs/render.md § Skipping invisible mover meshes.
   */
  readonly maxAlphaByKey = new Map<string, number>();
  private trackVisibility: boolean;

  constructor(occluders: WallOccluder[], meshes: Map<string, THREE.Mesh>, trackVisibility = false) {
    this.occluders = occluders;
    this.meshes = meshes;
    this.occlusionAlpha = new Float32Array(occluders.length).fill(1);
    this.trackVisibility = trackVisibility;
  }

  /**
   * Camera position in DOOM (x, y, height) coordinates, and every point a wall
   * between the camera and it should fade for — the player plus the nearest
   * awake monsters (`collectFadeTargets`).
   *
   * `openingOf` (`World.openingOf`, threaded in as a callback so this class
   * needs no `World` of its own) tells a genuinely solid quad from one that
   * only *renders* solid. That test is per **quad**, not per line, and the
   * distinction is load-bearing: docs/render.md § Wall occlusion fading.
   */
  update(
    dt: number,
    camX: number,
    camY: number,
    camZ: number,
    targets: FadeTarget[],
    openingOf: (line: number) => Opening | null,
  ): void {
    for (let i = 0; i < this.occluders.length; i++) {
      const o = this.occluders[i];
      const opening = openingOf(o.line);
      const isPassableGap = opening !== null && o.botH >= opening.bottom && o.topH <= opening.top;
      let occluding = false;
      if (!isPassableGap) {
        for (const t of targets) {
          const cross = segmentIntersect(camX, camY, t.x, t.y, o.ax, o.ay, o.bx, o.by);
          if (!cross) continue;
          const height = camZ + (t.z - camZ) * cross.t;
          if (height > o.botH && height < o.topH) {
            occluding = true;
            break;
          }
        }
      }

      const target = occluding ? FADE_ALPHA : 1;
      this.occlusionAlpha[i] = dampen(this.occlusionAlpha[i], target, FADE_SPEED, dt, SNAP_EPS);
    }
  }

  /**
   * Writes base × occlusion × fog-of-war combined alpha into each wall's
   * vertex-colour alpha channel. `fogAlphaOf` is keyed by the wall's index in
   * this list, not by sector: which subsector a wall quad faces into is
   * geometry FogOfWar works out for itself (see its `wallAlpha`), so the mesh
   * builder doesn't have to carry a fog-specific field around.
   *
   * The base is the quad's own permanent translucency (a Boom 260 midtexture)
   * — a *third* input to this one channel, and the only one that never changes
   * after the build. docs/render.md § Wall occlusion fading.
   */
  commit(fogAlphaOf: (occluderIndex: number) => number): void {
    const dirty = new Set<string>();
    if (this.trackVisibility) this.maxAlphaByKey.clear();

    for (let i = 0; i < this.occluders.length; i++) {
      const o = this.occluders[i];
      const combined = (o.baseAlpha ?? 1) * this.occlusionAlpha[i] * fogAlphaOf(i);
      // Before the unchanged-alpha early-out below, not after: a mesh whose
      // alpha happens not to have moved this frame is still as visible as it
      // was, and skipping it here would report it as invisible.
      if (this.trackVisibility) {
        const seen = this.maxAlphaByKey.get(o.key);
        if (seen === undefined || combined > seen) this.maxAlphaByKey.set(o.key, combined);
      }
      const attr = this.meshes.get(o.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      if (attr.getW(o.vertexStart) === combined) continue;
      for (let v = 0; v < o.vertexCount; v++) attr.setW(o.vertexStart + v, combined);
      dirty.add(o.key);
    }

    for (const key of dirty) {
      const attr = this.meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}

/**
 * Fades a raised floor sitting between the camera and a fade target below it — `WallFader` for a
 * horizontal plane. Ceilings are left out (`renderCeilings` is a debug toggle, and a room's own
 * ceiling would flag itself). See docs/render.md § Wall occlusion fading.
 */
export class FlatFader {
  private surfaces: FlatSurface[];
  private meshes: Map<string, THREE.Mesh>;
  private alpha: Float32Array;
  /** `WallFader.maxAlphaByKey`'s twin, same opt-in — the two are read together, since one mesh can hold both kinds. */
  readonly maxAlphaByKey = new Map<string, number>();
  private trackVisibility: boolean;

  constructor(surfaces: FlatSurface[], meshes: Map<string, THREE.Mesh>, trackVisibility = false) {
    this.surfaces = surfaces;
    this.meshes = meshes;
    this.alpha = new Float32Array(surfaces.length).fill(1);
    this.trackVisibility = trackVisibility;
  }

  /**
   * Camera position in DOOM (x, y, height) coordinates, and every point a
   * floor between the camera and it should fade for — see `WallFader.update`'s
   * doc for why this is a list rather than just the player.
   */
  update(dt: number, camX: number, camY: number, camZ: number, targets: FadeTarget[]): void {
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      let occluding = false;
      for (const pt of targets) {
        if (s.isCeiling || s.height <= pt.z || s.height >= camZ) continue;
        const t = (s.height - camZ) / (pt.z - camZ);
        if (t <= 0 || t >= 1) continue;
        const x = camX + (pt.x - camX) * t;
        const y = camY + (pt.y - camY) * t;
        if (pointNearConvexPolygon(x, y, s.points, PLAYER_RADIUS)) {
          occluding = true;
          break;
        }
      }

      const target = occluding ? FADE_ALPHA : 1;
      this.alpha[i] = dampen(this.alpha[i], target, FADE_SPEED, dt, SNAP_EPS);
    }
  }

  /** Same base × occlusion × fog-of-war write as `WallFader.commit` — here the base is a water surface's. */
  commit(fogAlphaOf: (subsector: number) => number): void {
    const dirty = new Set<string>();
    if (this.trackVisibility) this.maxAlphaByKey.clear();

    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      const combined = (s.baseAlpha ?? 1) * this.alpha[i] * fogAlphaOf(s.subsector);
      // Ahead of the early-out, for the reason `WallFader.commit` gives.
      if (this.trackVisibility) {
        const seen = this.maxAlphaByKey.get(s.key);
        if (seen === undefined || combined > seen) this.maxAlphaByKey.set(s.key, combined);
      }
      const attr = this.meshes.get(s.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      if (attr.getW(s.vertexStart) === combined) continue;
      for (let v = 0; v < s.vertexCount; v++) attr.setW(s.vertexStart + v, combined);
      dirty.add(s.key);
    }

    for (const key of dirty) {
      const attr = this.meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}

/**
 * The accumulated texture offsets this scroller draws, in map units — the read
 * side of `game/specials/forces.ts: Forces`, declared structurally so the
 * render layer keeps no import edge into the game layer (the `SwitchPairLookup`
 * precedent). `scrollingLines`/`scrollingFlats` are read once, at index time.
 */
export interface ScrollOffsets {
  scrollingLines(): readonly number[];
  scrollingFlats(): readonly { sector: number; isCeiling: boolean }[];
  sideOffset(lineIndex: number): { readonly x: number; readonly y: number };
  flatOffset(sectorIndex: number, isCeiling: boolean): { readonly x: number; readonly y: number };
}

/** One static-batch wall quad a scroller animates, with everything needed to rewrite its UVs each frame without re-deriving them from the linedef. */
interface ScrollingWall {
  key: string;
  line: number;
  vertexStart: number;
  /** The quad's own original U at its left/right edges and V at its top/bottom (indices 0/1/3 vs. 2/4/5, and 0 vs. 1 — see `addWall`'s fixed `[A, D, C, A, C, B]` push order in mapmesh.ts), read back once from the geometry at index time rather than recomputed, so this doesn't need to know xOffset/yOffset/texture length itself. */
  u0: number;
  u1: number;
  vTop: number;
  vBot: number;
  /** UV units per map unit of scroll — `1 / textureWidth` and `1 / textureHeight`, so a narrow texture's pattern visibly cycles faster than a wide one for the same rate, matching vanilla's own offset-over-dimension UV math. */
  uPerUnit: number;
  vPerUnit: number;
  /** Last offset written into the buffer, so an unchanged surface costs no rewrite and no re-upload. */
  lastDu: number;
  lastDv: number;
}

/** One static-batch flat fan a scroller animates. Flats are arbitrary-length fans, so their untouched UVs are kept whole rather than as two edge values. */
interface ScrollingFlat {
  key: string;
  sector: number;
  isCeiling: boolean;
  vertexStart: number;
  /** `[u, v]` per vertex as built, the base every frame's offset is added to. */
  base: Float32Array;
  /** Last offset written into the buffer — see `ScrollingWall`. */
  lastDu: number;
  lastDv: number;
}

/**
 * Every flat is 64×64 and aligned to the world grid (`mapmesh.ts: processFlat`
 * divides by the same 64), so a flat scroller's offset converts with this
 * rather than a per-texture size lookup.
 */
const FLAT_SIZE = 64;

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
  private wallMeshes: Map<string, THREE.Mesh>;
  private flatMeshes: Map<string, THREE.Mesh>;
  private walls: ScrollingWall[] = [];
  private flats: ScrollingFlat[] = [];

  constructor(
    offsets: ScrollOffsets,
    occluders: readonly WallOccluder[],
    wallMeshes: Map<string, THREE.Mesh>,
    flatSurfaces: readonly FlatSurface[],
    flatMeshes: Map<string, THREE.Mesh>,
    bank: MaterialBank,
  ) {
    this.wallMeshes = wallMeshes;
    this.flatMeshes = flatMeshes;

    const lines = new Set(offsets.scrollingLines());
    for (const o of occluders) {
      if (!lines.has(o.line) || !o.frontSide) continue;
      const attr = wallMeshes.get(o.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const dim = bank.size('wall', textureOf(o.key));
      if (!dim || dim.w <= 0 || dim.h <= 0) continue;
      this.walls.push({
        key: o.key,
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
        key: s.key,
        sector: s.sector,
        isCeiling: s.isCeiling,
        vertexStart: s.vertexStart,
        base,
        lastDu: 0,
        lastDv: 0,
      });
    }
  }

  update(offsets: ScrollOffsets): void {
    const dirty = new Set<string>();
    for (const w of this.walls) {
      const attr = this.wallMeshes.get(w.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
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
      dirty.add(w.key);
    }
    for (const key of dirty) {
      const attr = this.wallMeshes.get(key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }

    dirty.clear();
    for (const f of this.flats) {
      const attr = this.flatMeshes.get(f.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const offset = offsets.flatOffset(f.sector, f.isCeiling);
      const du = (offset.x / FLAT_SIZE) % 1;
      const dv = (offset.y / FLAT_SIZE) % 1;
      if (du === f.lastDu && dv === f.lastDv) continue;
      f.lastDu = du;
      f.lastDv = dv;
      for (let v = 0; v < f.base.length / 2; v++) {
        attr.setXY(f.vertexStart + v, f.base[v * 2] + du, f.base[v * 2 + 1] + dv);
      }
      dirty.add(f.key);
    }
    for (const key of dirty) {
      const attr = this.flatMeshes.get(key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}

/** A batch key is `<kind>:<texture>` — see `BatchSet.get` in mapmesh.ts. */
function textureOf(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

function flatKey(sector: number, isCeiling: boolean): number {
  return sector * 2 + (isCeiling ? 1 : 0);
}
