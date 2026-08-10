import * as THREE from 'three';
import type { GraphicsBank } from '../wad/graphics.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import { doomToWorld, litColor } from './mapmesh.ts';
import { DOOM_TIC } from '../constants.ts';

/**
 * Default viewer angle (DOOM-space, 0 = east, 90 = north, counter-clockwise):
 * due south, matching TopDownCamera's yaw=0. The camera can orbit (see
 * TopDownCamera.viewerAngleDeg), so this constant is only the fallback for
 * callers that don't pass a live angle; SpriteActor.setPose is re-called
 * every frame with the camera's actual current viewer angle.
 */
export const VIEWER_ANGLE_DEG = -90;

/** Which of a sprite's 8 rotation frames (1-8) faces this viewer angle, given the thing's own facing. */
export function pickRotationDigit(facingDeg: number, viewerAngleDeg = VIEWER_ANGLE_DEG): number {
  const diff = (((viewerAngleDeg - facingDeg) % 360) + 360) % 360;
  return (Math.floor((diff + 22.5) / 45) % 8) + 1;
}

export interface CachedSprite {
  material: THREE.MeshBasicMaterial;
  geometry: THREE.BufferGeometry;
  /**
   * The quad `geometry` spans, in the sprite's own local units and with the
   * hotspot shift already folded in (see `SpriteMaterialCache.get`): x runs
   * `minX`..`maxX` across the plane, y from 0 at the feet — the plane's bottom
   * edge, anchored to the thing's own z — up to `height`.
   *
   * Carried alongside the geometry so a caller can intersect the billboard
   * *analytically*, with no mesh and no render state to raycast against:
   * `intersectBillboard`, for `ThingLayer.pickMonster`.
   */
  quad: { minX: number; maxX: number; height: number };
}

/**
 * How far a billboard can reach from its own anchor point, in local units
 * before `scale` — a conservative bound for a caller that wants to reject a
 * sprite *before* resolving which lump it currently draws
 * (`ThingLayer.pickMonster`'s broad phase, which is what keeps that from
 * being a `SpriteBank` lookup per thing per tic).
 *
 * Measured across every world sprite lump in the bundled IWADs (the player's
 * own HUD weapon art excluded, since nothing draws it in the world): the
 * furthest reach is 130 units sideways of the hotspot (`SPID`, the spider
 * mastermind) and 134 up (`CYBR`, the cyberdemon), i.e. 187 from the anchor.
 * This is double that, so a PWAD carrying outsized monster art doesn't quietly
 * go unclickable around its edges. Only ever a rejection test —
 * `intersectBillboard` is what decides an actual hit.
 */
export const BILLBOARD_MAX_REACH = 384;

/**
 * Where `ray` crosses the billboard `cached` is drawn at, as a distance along
 * the ray, or -1 for a miss. The plane is upright and turned only about its
 * vertical axis (see `SpriteMaterialCache`'s class doc), so `cos`/`sin` are
 * the shared yaw every sprite is drawn at — `Math.cos/sin` of
 * `viewerAngleDeg - VIEWER_ANGLE_DEG` in radians, exactly what
 * `SpriteBatch.begin` computes once per batch and for the same reason.
 *
 * `pos` is the sprite's world-space anchor (`doomToWorld` of its map position,
 * i.e. its feet) and `scale` its size multiplier, matching what the batch is
 * handed. Deliberately the plain quad, transparent corners included, the same
 * silhouette a mesh raycast would have hit. docs/combat.md § Auto-aim.
 */
export function intersectBillboard(
  ray: THREE.Ray,
  cached: CachedSprite,
  pos: THREE.Vector3,
  scale: number,
  cos: number,
  sin: number,
): number {
  // The plane's own basis: local +x runs (cos, 0, -sin) in world space and
  // local +y is straight up, so the normal is their cross product. Mirrors
  // the instance matrix `SpriteBatch.add` writes — the two have to agree, and
  // tests/render/billboard-pick.test.ts holds them to it.
  const nx = sin;
  const nz = cos;
  const denom = ray.direction.x * nx + ray.direction.z * nz;
  // Edge-on: a plane of zero apparent width can't be clicked, and dividing
  // through would hand back an arbitrarily distant hit.
  if (denom > -1e-6 && denom < 1e-6) return -1;
  const t = ((pos.x - ray.origin.x) * nx + (pos.z - ray.origin.z) * nz) / denom;
  if (t < 0) return -1;

  const wy = ray.origin.y + ray.direction.y * t - pos.y;
  const ly = wy / scale;
  if (ly < 0 || ly > cached.quad.height) return -1;
  const wx = ray.origin.x + ray.direction.x * t - pos.x;
  const wz = ray.origin.z + ray.direction.z * t - pos.z;
  const lx = (wx * cos - wz * sin) / scale;
  if (lx < cached.quad.minX || lx > cached.quad.maxX) return -1;
  return t;
}

/**
 * Builds and caches billboard geometry/materials for sprite lumps, one per
 * (lump, mirrored) pair.
 *
 * Things are rendered as flat planes fixed upright in the world rather than
 * as THREE.Sprite billboards, which fully face the camera on every axis. A
 * camera-facing billboard tips flat whenever the camera tilts toward looking
 * straight down, making a standing DOOM sprite read as a figure lying on the
 * floor. Since this game's camera only ever tilts a fixed amount off
 * vertical (it can orbit in yaw, but never pitches further down or up), the
 * plane only ever needs to turn around its vertical axis to track the
 * camera's azimuth (see SpriteActor.setPose's viewerAngleDeg), never tilt —
 * a cheaper, always-upright approximation instead of a true billboard.
 */
export class SpriteMaterialCache {
  private cache = new Map<string, CachedSprite | null>();
  private gfx: GraphicsBank;
  private maxAnisotropy = 1;

  constructor(gfx: GraphicsBank, renderer?: THREE.WebGLRenderer) {
    this.gfx = gfx;
    if (renderer) this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  }

  get(lump: string, flip: boolean): CachedSprite | null {
    const key = lump + (flip ? ':flip' : '');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const bmp = this.gfx.picture(lump);
    let result: CachedSprite | null = null;
    if (bmp) {
      const texture = new THREE.DataTexture(bmp.data, bmp.width, bmp.height, THREE.RGBAFormat);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.maxAnisotropy;

      // WAD bitmaps start at their top row, but a plane's default UVs put v=0
      // along its bottom edge, so the art arrives upside down. Texture.flipY
      // cannot fix it: WebGL only honours UNPACK_FLIP_Y_WEBGL for image
      // sources, not for the typed-array uploads every DataTexture uses —
      // hence the V axis is inverted through the texture transform instead.
      // (The map meshes dodge this by building their own UVs with V running
      // downward.)
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.y = -1;
      texture.offset.y = 1;

      // Horizontal centring uses the patch's `left` hotspot, DOOM's usual
      // convention. Vertically, DOOM instead trusts `top` (world position =
      // thing.z + top, i.e. the top edge sits `top` units above the floor)
      // and gets away with whatever slack that leaves beneath the sprite
      // because its software renderer floor-clips every column and the
      // camera sits near floor height anyway. Neither safety net exists
      // here — a tilted-down 3D view over an unclipped plane — so any patch
      // whose `top` is less than its full height would draw with its feet
      // below the floor. Anchoring the bottom edge to the floor outright
      // sidesteps that instead of trusting the offset.
      const left = bmp.left ?? bmp.width / 2;
      let offsetX = bmp.width / 2 - left;
      const offsetY = bmp.height / 2;

      if (flip) {
        // Mirrors the U axis: DOOM reuses one lump for two mirrored
        // rotations. The hotspot mirrors with it.
        texture.wrapS = THREE.RepeatWrapping;
        texture.repeat.x = -1;
        texture.offset.x = 1;
        offsetX = -offsetX;
      }
      texture.needsUpdate = true;

      const geometry = new THREE.PlaneGeometry(bmp.width, bmp.height);
      geometry.translate(offsetX, offsetY, 0);
      // An all-white per-vertex color, purely so the *instanced* path
      // (render/spritebatch.ts) can tint each instance by its own sector
      // light. three.js's fragment shader only multiplies `vColor` in under
      // `USE_COLOR` — i.e. `material.vertexColors` — and `USE_INSTANCING_COLOR`
      // alone populates `vColor` in the vertex shader but is then ignored
      // downstream, so an InstancedMesh's per-instance color needs
      // `vertexColors: true`, which in turn needs this attribute to exist or
      // WebGL's default (0,0,0) generic attribute renders every sprite black.
      // White here means the instanced path's tint is exactly its instanceColor.
      // Ignored entirely by the non-instanced material below (`vertexColors`
      // stays false there), which tints via `material.color` instead.
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(1), 3));

      const material = new THREE.MeshBasicMaterial({
        map: texture,
        alphaTest: 0.5,
        transparent: false,
        fog: true,
        // The fixed-orientation approximation can put the camera behind a
        // thing far from the player (see class doc); a single-sided plane
        // would simply vanish there.
        side: THREE.DoubleSide,
      });
      // Read off the same two offsets the geometry was translated by, so the
      // analytic pick can never drift from what is actually drawn.
      result = {
        material,
        geometry,
        quad: { minX: offsetX - bmp.width / 2, maxX: offsetX + bmp.width / 2, height: bmp.height },
      };
    }
    this.cache.set(key, result);
    return result;
  }

  dispose(): void {
    for (const c of this.cache.values()) {
      c?.material.map?.dispose();
      c?.material.dispose();
      c?.geometry.dispose();
    }
    this.cache.clear();
  }
}

/**
 * A one-shot frame sequence, either holding on its last frame forever once
 * exhausted (`SpriteAnimator`'s death slot) or clearing itself and handing
 * control back to the caller (its attack/pain override slot) — the two only
 * differ in that one behavior, so both share this bookkeeping instead of each
 * carrying their own {frames, duration, index, timer} quadruple.
 */
class FrameSequence {
  frames: string[] | null = null;
  index = 0;
  private frameDuration = 0;
  private holdLast = false;
  private timer = 0;

  start(frames: string[], frameDuration: number, holdLast: boolean): void {
    this.frames = frames;
    this.frameDuration = frameDuration;
    this.holdLast = holdLast;
    this.index = 0;
    this.timer = 0;
  }

  stop(): void {
    this.frames = null;
    this.index = 0;
    this.timer = 0;
  }

  advance(dt: number): void {
    if (!this.frames) return;
    this.timer += dt;
    while (this.timer >= this.frameDuration) {
      if (this.holdLast && this.index >= this.frames.length - 1) break;
      this.timer -= this.frameDuration;
      this.index++;
      if (!this.holdLast && this.index >= this.frames.length) {
        this.frames = null;
        break;
      }
    }
  }
}

/**
 * The frame-cycle state of one animated sprite, and the lookup from that
 * state to the geometry/material actually drawn — with **no `THREE.Object3D`
 * of its own**. That split is what lets the same animation logic serve both
 * ways this engine draws a sprite: `SpriteActor` below (one `THREE.Mesh` per
 * sprite, for the handful of standalone actors — the player, teleport fog,
 * projectiles, impacts) and `render/spritebatch.ts`'s `SpriteBatch` (one
 * `InstancedMesh` per lump, for `game/things.ts`'s map things, of which a
 * stress-test map like NUTS.WAD has over ten thousand — see SpriteBatch's own
 * doc for why those must not be one mesh each).
 *
 * Animation is a plain frame-letter cycle, e.g. DOOM's own PLAY sprite reuses
 * A, B, C, D as a 4-step leg cycle while walking and simply holds frame A
 * while idle — there is no separate "idle" art, just the walk cycle stopped
 * on its first frame. `animFrames` defaults to a single held frame, which is
 * every non-animated actor.
 */
export class SpriteAnimator {
  private lastKey = '';
  private cached: CachedSprite | null = null;
  private animIndex = 0;
  private animTimer = 0;

  private bank: SpriteBank;
  private materials: SpriteMaterialCache;
  private spriteName: string;
  private animFrames: string[];
  private frameDuration: number;

  /**
   * Permanently overrides the normal walk-cycle animation with a one-shot
   * sequence that advances forward and then holds on its last frame forever
   * — a corpse, not a loop. `advance` ignores its own `animating` parameter
   * entirely while this is set: unlike the alive cycle (which idles by
   * holding frame 0 and resumes from the start once moving again), a death
   * animation has no "idle" state to fall back to and must never run in
   * reverse or reset. Set via `die`.
   */
  private death = new FrameSequence();

  /**
   * A transient one-shot sequence (attack/pain) that plays forward over its
   * own frames and then clears itself, handing back to the alive cycle —
   * unlike `death`, which is permanent. `playOnce` re-arms it
   * unconditionally, so a later call (e.g. a pain flinch landing mid-attack)
   * simply replaces whatever was already playing, matching vanilla's own
   * state machine: a new state transition always wins, there's no queueing.
   */
  private override = new FrameSequence();

  /**
   * Sprite name to resolve the death sequence's frames against, when it
   * differs from `spriteName` — set only by `die`'s optional third argument.
   * Every monster's death states reuse the same sprite name as its walk/
   * attack states, so this is `null` for all of them; the exploding barrel
   * is the one thing in the game whose death art (`BEXP`) is a genuinely
   * different lump than its own idle art (`BAR1`), which `spriteName` alone
   * can't express since it's fixed for this animator's whole life.
   */
  private deathSpriteName: string | null = null;

  constructor(
    bank: SpriteBank,
    materials: SpriteMaterialCache,
    spriteName: string,
    animFrames: string[] = ['A'],
    frameDuration = 4 * DOOM_TIC,
  ) {
    this.bank = bank;
    this.materials = materials;
    this.spriteName = spriteName;
    this.animFrames = animFrames;
    this.frameDuration = frameDuration;
  }

  /**
   * Advances the frame cycle by `dt`. `animating` selects the cycle (e.g. the
   * player only cycles legs while actually moving); while false the actor
   * holds on `animFrames[0]` and the cycle resets, so motion always resumes
   * from the first frame instead of wherever it happened to stop.
   */
  advance(dt: number, animating: boolean): void {
    this.death.advance(dt);
    if (this.death.frames) {
      this.animIndex = this.death.index;
      return;
    }
    this.override.advance(dt);
    if (this.override.frames) {
      this.animIndex = this.override.index;
      return;
    }
    // this.animIndex is one field shared across three domains (death,
    // override, this base cycle) rather than each owning its own — cheaper
    // day to day, but it means a value left over from a *longer* death/
    // override sequence can still be sitting there the instant control falls
    // through to here, and nothing below would touch it if this call's own
    // animTimer hasn't yet built up enough to reach the while loop. Clamping
    // here covers a sequence *ending*; `die`/`playOnce` reset the index
    // themselves to cover one *starting*, since `resolve` can be reached
    // between a state change and the next `advance` (docs/frameloop.md § What
    // runs in a tic) and must never see an index past the end of its array.
    if (this.animIndex >= this.animFrames.length) this.animIndex = 0;
    if (animating && this.animFrames.length > 1) {
      this.animTimer += dt;
      while (this.animTimer >= this.frameDuration) {
        this.animTimer -= this.frameDuration;
        this.animIndex = (this.animIndex + 1) % this.animFrames.length;
      }
    } else {
      this.animTimer = 0;
      this.animIndex = 0;
    }
  }

  /**
   * The geometry/material for the current frame as seen from `viewerAngleDeg`,
   * or null if the WAD has no such lump. Memoized on the resolved lump name,
   * so the steady state (a sprite whose frame and rotation digit haven't
   * changed) costs one `SpriteBank` lookup and nothing else.
   */
  resolve(facingDeg: number, viewerAngleDeg: number): CachedSprite | null {
    const frames = this.death.frames ?? this.override.frames ?? this.animFrames;
    const spriteName = this.death.frames && this.deathSpriteName ? this.deathSpriteName : this.spriteName;
    const digit = pickRotationDigit(facingDeg, viewerAngleDeg);
    const found = this.bank.lookup(spriteName, frames[this.animIndex], digit);
    if (!found) return null;

    const key = found.lump + (found.flip ? ':f' : '');
    if (key !== this.lastKey) {
      this.cached = this.materials.get(found.lump, found.flip);
      this.lastKey = key;
    }
    return this.cached;
  }

  /**
   * Switches this sprite permanently into its one-shot death animation (see
   * the `death` field doc). Idempotent-ish: calling it again just
   * restarts the sequence, which nothing currently does since a monster/the
   * player only dies once per life.
   *
   * `spriteName`, when given, resolves the death frames against that lump
   * instead of this animator's own `spriteName` — see `deathSpriteName`'s
   * doc for the one case (the exploding barrel) that needs it.
   */
  die(frames: string[], frameDuration: number, spriteName?: string): void {
    this.death.start(frames, frameDuration, true);
    this.deathSpriteName = spriteName ?? null;
    // Onto the new sequence's first frame *now*, not at the next `advance`.
    // `resolve` reads `animFrames[animIndex]` against whichever sequence is
    // live, so a switch that leaves the old index in place dangles past the end
    // of a shorter one — see this method's rule in `animIndex`'s own doc.
    this.animIndex = 0;
    this.animTimer = 0;
  }

  /**
   * Plays `frames` forward once (see the `override` field doc), then
   * automatically hands back to the alive cycle. No-op while dead — a corpse
   * has no attack/pain animation to interrupt its held last death frame with.
   */
  playOnce(frames: string[], frameDuration: number): void {
    if (this.death.frames) return;
    this.override.start(frames, frameDuration, false);
    // Same reason as `die`: keep `animIndex` valid for the sequence `resolve`
    // is about to read, without waiting for an `advance` to clamp it.
    this.animIndex = 0;
    this.animTimer = 0;
  }

  /** Undoes `die`, back to the normal alive animation — used when a level restart brings the player back to life. */
  revive(): void {
    this.death.stop();
    this.override.stop();
    this.deathSpriteName = null;
    this.animIndex = 0;
    this.animTimer = 0;
  }
}

/**
 * One sprite drawn as its own upright `THREE.Mesh`. The plane never tilts —
 * see SpriteMaterialCache's class doc — but does turn around its vertical
 * axis to keep facing the camera as it orbits, so posing an actor
 * repositions it, yaws it to the current viewer angle, and, if the facing
 * angle or animation frame now picks a different rotation frame, swaps in
 * that lump's geometry/material.
 *
 * Used only for the **player**, the one sprite that genuinely wants its own
 * mesh. Everything else goes through `SpriteBatch` — map things via
 * `game/things.ts`, transient effects via `SpriteFxLayer` (`game/spritefx.ts`).
 * docs/sprites.md § Batching.
 */
export class SpriteActor {
  readonly mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
  private anim: SpriteAnimator;

  /**
   * Current translucency (1 = the ordinary opaque material). Anything below 1
   * draws through a per-actor **clone** of the shared cached material rather
   * than the cached one itself: `SpriteMaterialCache` hands out one material
   * per (lump, mirrored) pair for everything that draws that lump, so setting
   * `opacity` on it directly would fade every other user of the same art too.
   * Only the player ever uses this (partial invisibility, game/inventory.ts's
   * `PINS` powerup), and `PLAY` happens to be the player's alone — but relying
   * on that would make this a trap the first time something else reuses a lump.
   */
  private opacity = 1;
  private translucent = new Map<THREE.MeshBasicMaterial, THREE.MeshBasicMaterial>();

  constructor(
    bank: SpriteBank,
    materials: SpriteMaterialCache,
    spriteName: string,
    animFrames: string[] = ['A'],
    frameDuration = 4 * DOOM_TIC,
  ) {
    this.anim = new SpriteAnimator(bank, materials, spriteName, animFrames, frameDuration);
  }

  /** Repositions the actor and advances its animation; returns false if no matching lump was found. */
  setPose(
    x: number,
    y: number,
    z: number,
    facingDeg: number,
    light: number,
    dt = 0,
    animating = false,
    viewerAngleDeg = VIEWER_ANGLE_DEG,
  ): boolean {
    this.anim.advance(dt, animating);
    const cached = this.anim.resolve(facingDeg, viewerAngleDeg);
    if (!cached) return false;
    if (this.mesh.geometry !== cached.geometry) this.mesh.geometry = cached.geometry;
    // Material and geometry can now disagree (a translucent clone stands in for
    // the cached material), so it's swapped on its own rather than only when
    // the geometry changes.
    const material = this.opacity < 1 ? this.translucentOf(cached.material) : cached.material;
    if (this.mesh.material !== material) this.mesh.material = material;

    doomToWorld(x, y, z, this.mesh.position);
    // The plane's un-rotated pose already faces VIEWER_ANGLE_DEG (see
    // SpriteMaterialCache's doc); turn it by however far the live viewer
    // angle has moved from that default so it keeps facing the camera.
    this.mesh.rotation.y = THREE.MathUtils.degToRad(viewerAngleDeg - VIEWER_ANGLE_DEG);
    material.color.setScalar(litColor(light));
    // Only ever written on a clone — the cached material is shared, and its
    // own opacity must stay at the default 1 for everything else drawing it.
    if (this.opacity < 1) material.opacity = this.opacity;
    return true;
  }

  /** Draws this actor at `opacity` (1 = normal) from the next `setPose` on — see the `opacity` field's doc. */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  private translucentOf(base: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
    let clone = this.translucent.get(base);
    if (!clone) {
      clone = base.clone();
      clone.transparent = true;
      // The shared material alpha-tests at 0.5 against `texture.a * opacity`,
      // which would discard the *whole* sprite at any opacity below that. A WAD
      // sprite's alpha is binary (0 or 255, and NearestFilter never blends
      // between them), so any threshold under the lowest opacity used cuts
      // exactly the same silhouette the 0.5 test does.
      clone.alphaTest = 0.01;
      // One translucent plane among opaque geometry: not writing depth keeps it
      // from punching a hole in whatever is drawn after it.
      clone.depthWrite = false;
      this.translucent.set(base, clone);
    }
    return clone;
  }

  die(frames: string[], frameDuration: number): void {
    this.anim.die(frames, frameDuration);
  }

  playOnce(frames: string[], frameDuration: number): void {
    this.anim.playOnce(frames, frameDuration);
  }

  revive(): void {
    this.anim.revive();
  }

  /**
   * Releases the translucent clones made by `setOpacity`. Their textures are
   * shared with (and owned by) `SpriteMaterialCache`, so those are deliberately
   * left alone — only the cloned materials are this actor's to free.
   */
  dispose(): void {
    for (const m of this.translucent.values()) m.dispose();
    this.translucent.clear();
  }
}
