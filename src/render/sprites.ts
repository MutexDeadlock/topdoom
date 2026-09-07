/**
 * Things as upright sprite billboards: decoded sprite lumps cached as textures
 * (`SpriteMaterialCache`), rotation-frame picking, and the per-thing animation/pose state
 * (`SpriteAnimator`, `SpriteActor`). See docs/sprites.md.
 */
import * as THREE from 'three';
import type { Bitmap, GraphicsBank } from '../wad/graphics.ts';
import type { SpriteBank } from '../wad/sprites.ts';
import { doomToWorld } from './mapmesh.ts';
import { litColor, viewDepthAt } from './sectorlight.ts';
import { DOOM_TIC } from '../constants.ts';
import { tinted, type Tint } from './lights.ts';
import { skyScale } from './skytint.ts';
import { ATLAS_PAGE_SIZE, sampleAsSprite, SpriteAtlas } from './sprites/atlas.ts';
import {
  spriteMaterial,
  VIEWER_ANGLE_DEG,
  whiteVertexColors,
  type AtlasSprite,
  type CachedSprite,
} from './sprites/defs.ts';

/** The directory's own surface, handed out here so no importer names an inner file. */
export { SpriteBatch } from './sprites/batch.ts';
export {
  spriteMaterial,
  VIEWER_ANGLE_DEG,
  whiteVertexColors,
  type AtlasSprite,
  type CachedSprite,
} from './sprites/defs.ts';
import type { Pos3 } from '../types.ts';

/**
 * Builds and caches billboard geometry/materials for sprite lumps, one per
 * (lump, mirrored) pair.
 *
 * A thing is a flat plane fixed **upright** in the world, turning only around its vertical axis to
 * track the camera's yaw (`SpriteActor.setPose`'s `viewerAngleDeg`) — never a true camera-facing
 * billboard, which tips flat as this camera tilts toward straight down.
 * docs/sprites.md § Why upright planes, not `THREE.Sprite`.
 */
/**
 * A second bank, its material cache and the sprite name to resolve under: an actor's frames drawn
 * from another file's art. All three travel together because none is usable without the others —
 * the cache reads pictures out of the bank's own wad, and the name only exists in it. The player's
 * weapon-matching skins are the one user (`wad/playerskin.ts`).
 * docs/sprites.md § Weapon-matching player sprites.
 */
export interface SpriteSkin {
  bank: SpriteBank;
  materials: SpriteMaterialCache;
  spriteName: string;
}

export class SpriteMaterialCache {
  private cache = new Map<string, LumpSprite | null>();
  private gfx: GraphicsBank;
  private maxAnisotropy = 1;
  private atlas: SpriteAtlas | null = null;

  /**
   * `atlasLumps` names the sprite lumps to pack into the atlas the batches draw from — every one
   * the set has, decoded here and now (28 ms for DOOM2's 1381). Without it nothing is packed and
   * every lump draws from its own texture: the player-skin cache, whose one reader never batches.
   */
  constructor(gfx: GraphicsBank, renderer?: THREE.WebGLRenderer, atlasLumps?: readonly string[]) {
    this.gfx = gfx;
    if (renderer) this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    if (atlasLumps) {
      const pictures: [string, Bitmap][] = [];
      for (const name of atlasLumps) {
        const bmp = gfx.picture(name);
        if (bmp) pictures.push([name, bmp]);
      }
      this.atlas = new SpriteAtlas(pictures, this.maxAnisotropy);
      // The pages own these pixels now. Without this the whole set stays decoded in the bank for
      // the session on top of them — see `GraphicsBank.forgetPicture`. `get` re-decodes the
      // handful it needs a `left` hotspot for, as it did before there was an atlas.
      for (const name of atlasLumps) gfx.forgetPicture(name);
    }
  }

  get(lump: string, flip: boolean): CachedSprite | null {
    const key = lump + (flip ? ':flip' : '');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const bmp = this.gfx.picture(lump);
    let result: LumpSprite | null = null;
    if (bmp) {
      // Horizontal centring takes the patch's `left` hotspot, mirrored with the art since DOOM
      // reuses one lump for two mirrored rotations. Read by the plane and the atlas quad alike.
      // docs/sprites.md § Why upright planes, not `THREE.Sprite`.
      const left = bmp.left ?? bmp.width / 2;
      const offsetX = (flip ? -1 : 1) * (bmp.width / 2 - left);
      // The same offset the plane is translated by, so the batched quad stands where the lump's
      // own plane does. The V axis runs top-down in the page as in the lump, and is inverted the
      // same way: `v0`, the quad's bottom, is the rect's bottom row.
      const rect = this.atlas?.rectOf(lump);
      const size = ATLAS_PAGE_SIZE;
      const atlas: AtlasSprite | null = rect
        ? {
            page: rect.page,
            u0: (flip ? rect.x + rect.width : rect.x) / size,
            v0: (rect.y + rect.height) / size,
            u1: (flip ? rect.x : rect.x + rect.width) / size,
            v1: rect.y / size,
            width: bmp.width,
            height: bmp.height,
            offsetX,
          }
        : null;
      result = new LumpSprite(bmp, flip, offsetX, this.maxAnisotropy, atlas);
    }
    this.cache.set(key, result);
    return result;
  }

  dispose(): void {
    for (const c of this.cache.values()) c?.dispose();
    this.cache.clear();
    this.atlas?.dispose();
  }
}

/**
 * The frame-cycle state of one animated sprite and its current-lump lookup, with no
 * `THREE.Object3D` of its own — the same animation logic serves both a standalone `SpriteActor`
 * mesh and `SpriteBatch`'s instances (docs/sprites.md § Batching). Animation is a plain
 * frame-letter cycle; `animFrames` defaults to a single held frame.
 */
export class SpriteAnimator {
  private lastKey = '';
  private cached: CachedSprite | null = null;
  /** The inputs `cached` was resolved from — see `resolve`. */
  private lastLetter = '';
  private lastDigit = 0;
  private lastSpriteName = '';
  private lastSkin: SpriteSkin | null = null;
  private animIndex = 0;
  private animTimer = 0;

  /**
   * The logical `SPRITE + LETTER` the last `resolve` drew (`TROOA`, `BEXPC`), for the caller to
   * test against `FULLBRIGHT_FRAMES` when picking the light. Rebuilt only when the resolved lump
   * changes, in the same branch that re-fetches the material, so the steady state pays nothing.
   * Logical, not the lump: a `[SPRITES]` rename changes which lump `SpriteBank` hands back, and
   * the fullbright table is keyed by the name this animator was given.
   */
  frameKey = '';

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

  /**
   * Art drawn instead of this animator's own bank and sprite name, or null for its own. Unlike
   * `deathSpriteName` it covers every sequence, death included — a corpse goes on holding the
   * weapon it died with. `frameKey` stays this animator's own either way (see `resolve`).
   */
  private skin: SpriteSkin | null = null;

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
    // A still thing with nothing playing — most of a map, every tic — lands exactly here through
    // the three steps below; taken first, since this runs per thing per tic.
    if (!animating && !this.death.frames && !this.override.frames) {
      this.animTimer = 0;
      this.animIndex = 0;
      return;
    }
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
    const letter = frames[this.animIndex];
    const spriteName = this.death.frames && this.deathSpriteName ? this.deathSpriteName : this.spriteName;
    const digit = pickRotationDigit(facingDeg, viewerAngleDeg);
    const skin = this.skin;
    // The bank's answer is a function of these four alone and the banks never change under a
    // level, so a sprite holding its frame and rotation — most of a map, every frame — pays
    // neither lookup's string building. docs/sprites.md § Batching.
    if (
      letter === this.lastLetter &&
      digit === this.lastDigit &&
      spriteName === this.lastSpriteName &&
      skin === this.lastSkin
    ) {
      return this.cached;
    }
    this.lastLetter = letter;
    this.lastDigit = digit;
    this.lastSpriteName = spriteName;
    this.lastSkin = skin;
    // A skin with no lump for this frame falls through to the animator's own art, so a partial
    // skin file draws the set's sprite rather than nothing.
    const skinFound = skin ? skin.bank.lookup(skin.spriteName, letter, digit) : undefined;
    const found = skinFound ?? this.bank.lookup(spriteName, letter, digit);
    if (!found) {
      this.cached = null;
      this.lastKey = '';
      return null;
    }

    // The `:s` marker is what keeps the memo honest across two material caches: the same lump name
    // can exist in both, and `lastKey` gates the cached sprite and `frameKey` alike.
    const key = found.lump + (found.flip ? ':f' : '') + (skinFound ? ':s' : '');
    if (key !== this.lastKey) {
      this.cached = (skin && skinFound ? skin.materials : this.materials).get(found.lump, found.flip);
      this.lastKey = key;
      // Logical, never the skin's name: `FULLBRIGHT_FRAMES` holds `PLAYF` and GLDEFS binds the
      // muzzle flash to that key, so both must keep matching while a skin draws the lump.
      this.frameKey = spriteName + letter;
    }
    return this.cached;
  }

  /**
   * Draws from `skin`'s bank and sprite name from the next `resolve` on, or from this animator's
   * own with null. Deliberately touches no sequence state: a weapon swapped mid-stride must not
   * restart the walk cycle, one swapped mid-death must not restart the death chain.
   */
  setSkin(skin: SpriteSkin | null): void {
    this.skin = skin;
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
   * Whether a one-shot attack/pain sequence is still running — what keeps a volley's later shots
   * from restarting the pose they are already inside.
   */
  get posing(): boolean {
    return this.override.frames !== null;
  }

  /**
   * Plays `frames` forward once (see the `override` field doc), then
   * automatically hands back to the alive cycle. No-op while dead — a corpse
   * has no attack/pain animation to interrupt its held last death frame with.
   *
   * `durations` is one rate for every frame, or a per-frame list (an attack pose, whose frames
   * carry vanilla's own uneven state tics).
   */
  playOnce(frames: string[], durations: number | readonly number[]): void {
    if (this.death.frames) return;
    this.override.start(frames, durations, false);
    // Same reason as `die`: keep `animIndex` valid for the sequence `resolve`
    // is about to read, without waiting for an `advance` to clamp it.
    this.animIndex = 0;
    this.animTimer = 0;
  }

  /**
   * Undoes `die`, back to the normal alive animation — used when a level restart brings the player
   * back to life.
   */
  revive(): void {
    this.death.stop();
    this.override.stop();
    this.deathSpriteName = null;
    this.animIndex = 0;
    this.animTimer = 0;
  }
}

/** What a `SpriteActor` draws, beyond the banks it draws through. */
export interface SpriteActorOptions {
  spriteName: string;
  /** Frame letters to cycle, `['A']` for a still sprite. */
  animFrames: string[];
  /** `things/tables.ts`'s `FULLBRIGHT_FRAMES`, handed in so this layer stays free of the tables. */
  brightFrames: ReadonlySet<string>;
}

/** One pose: where the actor stands, and everything about how this frame draws it. */
export interface SpritePose {
  facingDeg: number;
  light: number;
  /** Seconds since the last pose, for the animation clock. */
  dt: number;
  animating: boolean;
  viewerAngleDeg: number;
  tint: Tint | undefined;
  /** Whether the actor stands under sky — see `skyScale` (`render/skytint.ts`). */
  sky: boolean;
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
  /** The `(sprite, letter)` keys drawn at full light — see `SpriteActorOptions.brightFrames`. */
  private brightFrames: ReadonlySet<string>;

  constructor(bank: SpriteBank, materials: SpriteMaterialCache, options: SpriteActorOptions) {
    this.anim = new SpriteAnimator(bank, materials, options.spriteName, options.animFrames);
    this.brightFrames = options.brightFrames;
  }

  /**
   * The `SPRITE+LETTER` this actor last resolved — what `DynamicLights` keys a light off
   * (docs/lights.md § The frame key). Empty until the first `setPose`, and one frame behind
   * during a pose the caller has set but not yet drawn.
   */
  get frameKey(): string {
    return this.anim.frameKey;
  }

  /**
   * Repositions the actor and advances its animation; returns false if no matching lump was found.
   */
  setPose(at: Pos3, pose: SpritePose): boolean {
    const { facingDeg, light, viewerAngleDeg, tint } = pose;
    this.anim.advance(pose.dt, pose.animating);
    const cached = this.anim.resolve(facingDeg, viewerAngleDeg);
    if (!cached) return false;
    if (this.mesh.geometry !== cached.geometry) this.mesh.geometry = cached.geometry;
    // Material and geometry can disagree — a translucent clone stands in for the cached material —
    // so the material is swapped on its own rather than only when the geometry changes.
    const material = this.opacity < 1 ? this.translucentOf(cached.material) : cached.material;
    if (this.mesh.material !== material) this.mesh.material = material;

    doomToWorld(at.x, at.y, at.z, this.mesh.position);
    // The plane's un-rotated pose already faces VIEWER_ANGLE_DEG (see
    // SpriteMaterialCache's doc); turn it by however far the live viewer
    // angle has moved from that default so it keeps facing the camera.
    this.mesh.rotation.y = THREE.MathUtils.degToRad(viewerAngleDeg - VIEWER_ANGLE_DEG);
    const bright = this.brightFrames.has(this.anim.frameKey);
    const at3 = this.mesh.position;
    const lit = bright ? litColor(255) : litColor(light, 0, viewDepthAt(at3.x, at3.y, at3.z));
    // A fullbright frame lights itself, so it takes no tint (docs/render.md § Outdoor sky tint).
    const outdoors = skyScale(pose.sky && !bright);
    const lr = lit * outdoors.r;
    const lg = lit * outdoors.g;
    const lb = lit * outdoors.b;
    // A dynamic light reaching the player adds on top of the sector's own, the same sum the
    // instanced sprites take (docs/lights.md § Two lighting paths).
    if (tint) material.color.setRGB(tinted(lr, tint.r), tinted(lg, tint.g), tinted(lb, tint.b));
    else material.color.setRGB(lr, lg, lb);
    // Only ever written on a clone — the cached material is shared, and its
    // own opacity must stay at the default 1 for everything else drawing it.
    if (this.opacity < 1) material.opacity = this.opacity;
    return true;
  }

  /**
   * Draws this actor at `opacity` (1 = normal) from the next `setPose` on — see the `opacity`
   * field's doc.
   */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  /**
   * Draws this actor's frames from another file's art from the next `setPose` on — the player's
   * weapon-matching skin — or from the loaded set's own with null.
   * docs/sprites.md § Weapon-matching player sprites.
   */
  setSkin(skin: SpriteSkin | null): void {
    this.anim.setSkin(skin);
  }

  die(frames: string[], frameDuration: number): void {
    this.anim.die(frames, frameDuration);
  }

  playOnce(frames: string[], durations: number | readonly number[]): void {
    this.anim.playOnce(frames, durations);
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

  private translucentOf(base: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
    let clone = this.translucent.get(base);
    if (!clone) {
      clone = base.clone();
      clone.transparent = true;
      // Both values: docs/sprites.md § Batching.
      clone.alphaTest = 0.01;
      clone.depthWrite = false;
      this.translucent.set(base, clone);
    }
    return clone;
  }
}

/**
 * `SpriteMaterialCache`'s `CachedSprite`. The atlas rect and `bottomOffset` are settled at
 * lookup; the texture, plane and material behind them are built on the first read that wants
 * them — see `CachedSprite.material`. A class rather than an object literal over the lookup's
 * locals, so what a cached lump holds onto is the four fields below and not the whole of `get`.
 */
class LumpSprite implements CachedSprite {
  readonly atlas: AtlasSprite | null;
  /**
   * The plane's bottom edge sits at the thing's own z rather than at `top`, which this view has
   * no floor clip to cover for; what `top` says is kept here instead — see `CachedSprite`.
   */
  readonly bottomOffset: number;
  private bmp: Bitmap;
  private flip: boolean;
  /** How far the plane's centre sits right of the thing — the `left` hotspot, mirrored with it. */
  private offsetX: number;
  private anisotropy: number;
  private builtMaterial: THREE.MeshBasicMaterial | null = null;
  private builtGeometry: THREE.BufferGeometry | null = null;

  constructor(bmp: Bitmap, flip: boolean, offsetX: number, anisotropy: number, atlas: AtlasSprite | null) {
    this.bmp = bmp;
    this.flip = flip;
    this.offsetX = offsetX;
    this.anisotropy = anisotropy;
    this.atlas = atlas;
    this.bottomOffset = (bmp.top ?? bmp.height) - bmp.height;
  }

  get material(): THREE.MeshBasicMaterial {
    if (!this.builtMaterial) this.builtMaterial = spriteMaterial(this.texture());
    return this.builtMaterial;
  }

  get geometry(): THREE.BufferGeometry {
    if (!this.builtGeometry) {
      const geometry = new THREE.PlaneGeometry(this.bmp.width, this.bmp.height);
      geometry.translate(this.offsetX, this.bmp.height / 2, 0);
      whiteVertexColors(geometry);
      this.builtGeometry = geometry;
    }
    return this.builtGeometry;
  }

  /** Only what was built: reading either getter to dispose it would build it to throw it away. */
  dispose(): void {
    this.builtMaterial?.map?.dispose();
    this.builtMaterial?.dispose();
    this.builtGeometry?.dispose();
  }

  /**
   * The lump's own texture. WAD bitmaps start at their top row and a plane's default UVs put v=0
   * along its bottom edge, so the V axis is inverted through the texture transform — `flipY`
   * cannot do it for a `DataTexture`. A mirrored rotation inverts U the same way.
   * docs/sprites.md § Why upright planes, not `THREE.Sprite`.
   */
  private texture(): THREE.DataTexture {
    const bmp = this.bmp;
    const texture = new THREE.DataTexture(bmp.data, bmp.width, bmp.height, THREE.RGBAFormat);
    sampleAsSprite(texture, this.anisotropy);
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.y = -1;
    texture.offset.y = 1;
    if (this.flip) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.repeat.x = -1;
      texture.offset.x = 1;
    }
    texture.needsUpdate = true;
    return texture;
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
  /**
   * One duration for every frame, or a per-frame list. An attack pose takes the list: its frames
   * are vanilla's own attack states and their tic counts are uneven, which is what puts the firing
   * frame at the moment the shot goes off (docs/sprites.md § Pain, and attack/pain poses).
   */
  private durations: number | readonly number[] = 0;
  private holdLast = false;
  private timer = 0;

  start(frames: string[], durations: number | readonly number[], holdLast: boolean): void {
    this.frames = frames;
    this.durations = durations;
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
    for (;;) {
      const duration = this.durationAt(this.index);
      // A zero-length frame would spin here forever. Vanilla's own zero-tic states are dropped
      // when a pose is built, so this only catches a patch that wrote one.
      if (duration <= 0 || this.timer < duration) break;
      if (this.holdLast && this.index >= this.frames.length - 1) break;
      this.timer -= duration;
      this.index++;
      if (!this.holdLast && this.index >= this.frames.length) {
        this.frames = null;
        break;
      }
    }
  }

  /** This frame's own duration; a list shorter than the sequence holds on its last entry. */
  private durationAt(index: number): number {
    if (typeof this.durations === 'number') return this.durations;
    return this.durations[Math.min(index, this.durations.length - 1)] ?? 0;
  }
}

/**
 * Which of a sprite's 8 rotation frames (1-8) faces this viewer angle, given the thing's own
 * facing.
 */
function pickRotationDigit(facingDeg: number, viewerAngleDeg = VIEWER_ANGLE_DEG): number {
  const diff = (((viewerAngleDeg - facingDeg) % 360) + 360) % 360;
  return (Math.floor((diff + 22.5) / 45) % 8) + 1;
}
