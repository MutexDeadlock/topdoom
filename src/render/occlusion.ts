import * as THREE from 'three';
import type { FlatSurface, WallOccluder } from './mapmesh.ts';
import type { MaterialBank } from './textures.ts';
import type { DoomMap } from '../wad/map.ts';
import { pointNearConvexPolygon, segmentIntersect } from '../util/geom.ts';
import { dampen } from '../util/damping.ts';
import { PLAYER_RADIUS } from '../game/player.ts';
import type { Opening } from '../game/world.ts';
import { SCROLL_LINE_SPECIAL, SCROLL_SPEED } from '../wad/specials.ts';

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
export interface FadeTarget {
  x: number;
  y: number;
  z: number;
}

/**
 * Fades the specific wall quad(s) currently between the camera and the
 * player, rather than the coarser fix of drawing the player on top of
 * everything (which would also show it through walls that genuinely
 * separate it from the camera). Wall quads are already backface-culled when
 * their front faces away from the camera (see mapmesh.ts's dollhouse
 * comment) — this covers what's left: quads that legitimately face the
 * camera but happen to sit on the line of sight to the player.
 *
 * `update` only computes this sightline factor; it does not touch geometry.
 * A wall's on-screen alpha is actually the *product* of this factor and
 * `FogOfWar`'s per-sector reveal factor (game/fogofwar.ts) — two independent
 * systems driving the same vertex-alpha channel — so `commit` writes the
 * combined value once both are known, instead of each system overwriting
 * the other's work.
 */
export class WallFader {
  private occluders: WallOccluder[];
  private meshes: Map<string, THREE.Mesh>;
  private occlusionAlpha: Float32Array;

  constructor(occluders: WallOccluder[], meshes: Map<string, THREE.Mesh>) {
    this.occluders = occluders;
    this.meshes = meshes;
    this.occlusionAlpha = new Float32Array(occluders.length).fill(1);
  }

  /**
   * Camera position in DOOM (x, y, height) coordinates, and every point a
   * wall between the camera and it should fade for — the player plus every
   * currently-awake monster (`ThingLayer.awakeMonsters`, game.ts), so a
   * chasing monster stays visible through walls the same way the player
   * does, while one that hasn't noticed the player yet stays hidden.
   *
   * `openingOf` (`World.openingOf`, threaded through as a callback so this
   * class doesn't need a `World` reference of its own) is what tells a
   * genuinely solid quad apart from one that only *renders* solid — a masked
   * middle texture (grate, fence, barred window) is built (`mapmesh.ts:
   * addTwoSidedSide`) to span exactly its line's own vertical opening, so a
   * quad whose `[botH, topH]` sits inside that opening is the passable gap
   * itself, not something blocking it: a shot (and a look) already passes
   * straight through it, same as `World.blocksSight`/`blocksShot` already
   * treat it elsewhere, so fading it too has nothing left to usefully
   * reveal. This has to be a per-*quad* check, not a per-*line* one: the
   * same two-sided line's upper/lower step quads sit *outside* that opening
   * (they're the riser exposed where the neighbouring sector's floor/ceiling
   * doesn't reach as far) and are genuinely solid regardless of whether the
   * line has an opening elsewhere — gating on the line as a whole made an
   * ordinary step in a corridor stop fading too, which is what broke an
   * approaching zombieman staying hidden behind it. DOOM2 MAP01's east imp
   * closet (sector 38) is the concrete case the *quad*-level version of this
   * fixes — its fence's masked-middle quad used to fade to near-invisible
   * the moment the imp inside woke up, which read as the closet wall itself
   * vanishing rather than "you can see the imp through the bars."
   *
   * Note there is deliberately no "only fade if this is the *sole* wall in
   * the way" rule: whether fading a wall actually reveals its monster is
   * settled upstream by `ThingLayer.awakeMonsters`, which already drops any
   * monster fog of war isn't currently drawing (see its doc). A version of
   * this method that counted blockers per target instead was written first,
   * for the same symptom, and fixed nothing — the wall in question had only
   * one blocker; its monster simply wasn't rendered.
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
   * Writes occlusion × fog-of-war combined alpha into each wall's vertex-colour
   * alpha channel. `fogAlphaOf` is keyed by the wall's index in this list, not
   * by sector: which subsector a wall quad faces into is geometry FogOfWar
   * works out for itself (see its `wallAlpha`), so the mesh builder doesn't
   * have to carry a fog-specific field around.
   */
  commit(fogAlphaOf: (occluderIndex: number) => number): void {
    const dirty = new Set<string>();

    for (let i = 0; i < this.occluders.length; i++) {
      const o = this.occluders[i];
      const combined = this.occlusionAlpha[i] * fogAlphaOf(i);
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
 * Fades a raised floor (a room "further up") when it sits between the camera
 * and the player on the way down — the same problem `WallFader` solves for
 * vertical walls, but for a horizontal plane: an elevated room's floor is
 * solid geometry too, and the tilted top-down camera can easily be looking
 * *through* the space above a lower room, past the underside of a floor it
 * doesn't clip, at a player standing beneath it.
 *
 * Only floors above the player's own eye height are considered (`s.height >
 * targetZ`), which is what keeps this from flagging the player's own current
 * floor: standing on a floor means that floor's height is at or below the
 * player's centre height, so it's excluded by construction rather than by
 * tracking "which subsector is the player in" separately. Ceilings
 * (`isCeiling`) are left out for now — `renderCeilings` is an off-by-default
 * debug toggle, and a room's own ceiling sitting directly above the player
 * would otherwise flag itself the same way every frame.
 *
 * The sightline only ever crosses a given height at one exact (x, y) point,
 * but a single physical floor (e.g. a raised platform) routinely gets split
 * into several adjacent subsector polygons by the BSP — that's a rendering
 * detail, invisible to the player. Testing the crossing point with plain
 * point-in-polygon would flag only whichever one fragment happens to contain
 * it, leaving the other fragments of the same platform solid right next to
 * the one that faded (confirmed on DOOM2 MAP05's rocket-ammo balcony, whose
 * sector is split into 3 subsectors at the same height). `pointNearConvexPolygon`
 * inflates the test by the player's own radius so neighbouring fragments the
 * player's width would also be behind fade together.
 */
export class FlatFader {
  private surfaces: FlatSurface[];
  private meshes: Map<string, THREE.Mesh>;
  private alpha: Float32Array;

  constructor(surfaces: FlatSurface[], meshes: Map<string, THREE.Mesh>) {
    this.surfaces = surfaces;
    this.meshes = meshes;
    this.alpha = new Float32Array(surfaces.length).fill(1);
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

  /** Same combined occlusion × fog-of-war write as `WallFader.commit`. */
  commit(fogAlphaOf: (subsector: number) => number): void {
    const dirty = new Set<string>();

    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      const combined = this.alpha[i] * fogAlphaOf(s.subsector);
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

/** One static-batch wall quad animated by `TextureScroller`, with everything needed to recompute its U each frame without re-deriving it from the linedef. */
interface ScrollingWall {
  key: string;
  vertexStart: number;
  /** The quad's own original U at its left/right edges (indices 0/1/3 vs. 2/4/5 — see `addWall`'s fixed `[A, D, C, A, C, B]` push order in mapmesh.ts), read back once from the geometry at index time rather than recomputed, so this doesn't need to know xOffset/texture length itself. */
  u0: number;
  u1: number;
  /** UV units per map unit of scroll — `1 / textureWidth`, so a fixed 35 map-units/sec (vanilla's `FRACUNIT`/tic) scrolls a narrow texture's pattern past faster than a wide one, same as vanilla's own offset-over-width UV math. */
  uPerUnit: number;
}

/**
 * Vanilla's `P_UpdateSpecials` scroll effect (linedef special 48,
 * `SCROLL_LINE_SPECIAL`): continuously scrolls a line's front-sidedef
 * texture, forever, with no trigger — see `SCROLL_LINE_SPECIAL`'s doc in
 * wad/specials.ts for why this lives outside `SpecialsController`'s
 * trigger/mover machinery entirely. Mechanically this is the same
 * "index each affected quad's vertex range once, rewrite one attribute on it
 * every frame" shape `WallFader`/`FlatFader` already use for vertex-alpha —
 * here it's the `uv` attribute's U component instead.
 *
 * **Static-batch geometry only.** A scroll-48 line whose sector also happens
 * to be a specials mover has its geometry rebuilt wholesale by
 * `SpecialsController` instead of living in the shared static batch this
 * class indexes — the same pre-existing limitation already accepted for
 * `SpecialsController.recolorSector`'s light changes (see its doc), not a
 * new one. In practice this never actually excludes anything: a mapper only
 * has a reason to put 48 on a *static* wall — it's a decorative treatment
 * (waterfalls, lava streams, conveyor-look walls), never a line whose own
 * sector also needs to move.
 */
export class TextureScroller {
  private meshes: Map<string, THREE.Mesh>;
  private walls: ScrollingWall[] = [];
  private scrollUnits = 0;

  constructor(map: DoomMap, occluders: WallOccluder[], wallMeshes: Map<string, THREE.Mesh>, bank: MaterialBank) {
    this.meshes = wallMeshes;
    for (const [lineIndex, line] of map.linedefs.entries()) {
      if (line.special !== SCROLL_LINE_SPECIAL) continue;
      for (const o of occluders) {
        if (o.line !== lineIndex || !o.frontSide) continue;
        const attr = wallMeshes.get(o.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
        if (!attr) continue;
        const texName = o.key.slice(o.key.indexOf(':') + 1);
        const dim = bank.size('wall', texName);
        if (!dim || dim.w <= 0) continue;
        this.walls.push({
          key: o.key,
          vertexStart: o.vertexStart,
          u0: attr.getX(o.vertexStart), // index 0: one of the quad's two "A" copies (see addWall's push order)
          u1: attr.getX(o.vertexStart + 2), // index 2: one of the quad's two "C" copies
          uPerUnit: 1 / dim.w,
        });
      }
    }
  }

  update(dt: number): void {
    if (this.walls.length === 0) return;
    this.scrollUnits += SCROLL_SPEED * dt;
    const dirty = new Set<string>();
    for (const w of this.walls) {
      const attr = this.meshes.get(w.key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      // Bounded to [0, 1) so the value actually written into the (single-
      // precision) buffer never grows large enough to lose precision over a
      // long session — three.js's RepeatWrapping (see MaterialBank.toTexture)
      // already makes an unwrapped UV outside [0, 1] render correctly on its
      // own, so this wrap is purely a float32-precision safeguard, not a
      // correctness requirement.
      const delta = (this.scrollUnits * w.uPerUnit) % 1;
      const u0 = w.u0 + delta;
      const u1 = w.u1 + delta;
      // Matches addWall's fixed [A, D, C, A, C, B] vertex push order:
      // indices 0/1/3 are the quad's left edge (u0), 2/4/5 its right (u1).
      attr.setX(w.vertexStart, u0);
      attr.setX(w.vertexStart + 1, u0);
      attr.setX(w.vertexStart + 2, u1);
      attr.setX(w.vertexStart + 3, u0);
      attr.setX(w.vertexStart + 4, u1);
      attr.setX(w.vertexStart + 5, u1);
      dirty.add(w.key);
    }
    for (const key of dirty) {
      const attr = this.meshes.get(key)?.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
  }
}
