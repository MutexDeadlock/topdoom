/**
 * Things as upright sprite billboards: decoded sprite lumps cached as textures
 * ({@link SpriteMaterialCache}), rotation-frame picking, and the per-thing animation/pose state
 * ({@link SpriteAnimator}, {@link SpriteActor}). See docs/sprites.md.
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
  /**
   * Where a frame this skin has no lump for is looked up next, before the animator's own art — a
   * weapon-matching skin's is `PLAY` in the player's colour — or null for the animator's own
   * straight away. Required, so every skin reaches {@link SpriteAnimator.resolve} as one shape.
   */
  fallback: SpriteSkin | null;
}

/**
 * Builds and caches billboard geometry/materials for sprite lumps, one per (lump, mirrored) pair.
 *
 * A thing is a flat plane fixed **upright** in the world, turning only around its vertical axis to
 * track the camera's yaw ({@link SpriteActor.setPose}'s `viewerAngleDeg`) — never a true
 * camera-facing billboard. docs/sprites.md § Why upright planes, not `THREE.Sprite`.
 */
export class SpriteMaterialCache {
  private cache = new Map<string, LumpSprite | null>();
  private gfx: GraphicsBank;
  private maxAnisotropy = 1;
  private atlas: SpriteAtlas | null = null;

  /**
   * @param atlasLumps  the sprite lumps to pack into the atlas the batches draw from, decoded here
   *                    and now; without it every lump draws from its own texture — the player-skin
   *                    cache, whose one reader never batches
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
 * `THREE.Object3D` of its own — the same animation logic serves both a standalone
 * {@link SpriteActor} mesh and `SpriteBatch`'s instances (docs/sprites.md § Batching). Animation is
 * a plain frame-letter cycle; {@link SpriteAnimator.animFrames} defaults to a single held frame.
 */
export class SpriteAnimator {
  private lastKey = '';
  private cached: CachedSprite | null = null;
  /** The inputs {@link SpriteAnimator.cached} came from — see {@link SpriteAnimator.resolve}. */
  private lastLetter = '';
  private lastDigit = 0;
  private lastSpriteName = '';
  private lastSkin: SpriteSkin | null = null;
  /** {@link SpriteAnimator.cached}'s cache: a skin's, a fallback's, or this animator's own. */
  private lastMaterials: SpriteMaterialCache | null = null;
  private animIndex = 0;
  private animTimer = 0;
  /**
   * The cycle {@link SpriteAnimator.animIndex} last indexed: {@link SpriteAnimator.animFrames}, or
   * {@link SpriteAnimator.stand} while standing.
   */
  private base: string[];
  /**
   * A loop to play while still and {@link SpriteAnimator.standing}, and its per-frame rate — see
   * {@link SpriteAnimator.setStand}.
   */
  private stand: string[] | null = null;
  private standDuration = 0;

  /**
   * Whether a still tic plays {@link SpriteAnimator.stand} rather than holding `animFrames[0]` —
   * the owner's to set each tic: a monster stands while dormant.
   */
  standing = false;

  /**
   * The logical `SPRITE + LETTER` the last {@link SpriteAnimator.resolve} drew (`TROOA`, `BEXPC`),
   * for the caller to test against `FULLBRIGHT_FRAMES` when picking the light. Logical, not the
   * lump — docs/sprites.md § Fullbright frames.
   */
  frameKey = '';

  private bank: SpriteBank;
  private materials: SpriteMaterialCache;
  private spriteName: string;
  private animFrames: string[];
  private frameDuration: number;

  /**
   * Permanently overrides the walk cycle with a one-shot sequence that plays forward and then holds
   * its last frame forever — a corpse, not a loop. {@link SpriteAnimator.advance} ignores its own
   * `animating` while this is set: a death has no idle state to fall back to and must never run in
   * reverse or reset. Set via {@link SpriteAnimator.die}.
   */
  private death = new FrameSequence();

  /**
   * A transient one-shot sequence (attack/pain) that plays forward once and then clears itself,
   * handing back to the alive cycle — unlike {@link SpriteAnimator.death}.
   * {@link SpriteAnimator.playOnce} re-arms it unconditionally: a later call replaces whatever was
   * playing, as vanilla's state machine does, with no queueing.
   */
  private override = new FrameSequence();

  /**
   * Sprite name to resolve the death sequence's frames against, when it differs from
   * {@link SpriteAnimator.spriteName} — set only by {@link SpriteAnimator.die}'s optional third
   * argument: null for every monster, whose death reuses its own sprite — the exploding barrel
   * (`BAR1` dying as `BEXP`) is the one thing that needs it.
   */
  private deathSpriteName: string | null = null;

  /**
   * Art drawn instead of this animator's own bank and sprite name, or null for its own. Unlike
   * {@link SpriteAnimator.deathSpriteName} it covers every sequence, death included — a corpse
   * goes on holding the weapon it died with. {@link SpriteAnimator.frameKey} stays this animator's
   * own either way (see {@link SpriteAnimator.resolve}).
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
    this.base = animFrames;
  }

  /**
   * Advances the frame cycle by `dt`. `animating` selects the cycle (the player only cycles legs
   * while moving); while false the actor holds on `animFrames[0]` and the cycle resets, so motion
   * resumes from the first frame — unless it is {@link SpriteAnimator.standing} with a
   * {@link SpriteAnimator.stand} loop, which plays instead.
   */
  advance(dt: number, animating: boolean): void {
    const stand = animating || !this.standing ? null : this.stand;
    // A still thing with nothing playing — most of a map, every tic — lands exactly here through
    // the three steps below; taken first, since this runs per thing per tic.
    if (!animating && !stand && !this.death.frames && !this.override.frames) {
      this.base = this.animFrames;
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
    const base = stand ?? this.animFrames;
    // Walking and standing each start their cycle from its first frame.
    if (base !== this.base) {
      this.base = base;
      this.animTimer = 0;
      this.animIndex = 0;
    }
    if (this.animIndex >= base.length) this.animIndex = 0;
    const duration = stand ? this.standDuration : this.frameDuration;
    if ((animating || stand) && base.length > 1) {
      this.animTimer += dt;
      while (this.animTimer >= duration) {
        this.animTimer -= duration;
        this.animIndex = (this.animIndex + 1) % base.length;
      }
    } else {
      this.animTimer = 0;
      this.animIndex = 0;
    }
  }

  /**
   * The geometry/material for the current frame as seen from `viewerAngleDeg`, or null if the WAD
   * has no such lump.
   */
  resolve(facingDeg: number, viewerAngleDeg: number): CachedSprite | null {
    const frames = this.death.frames ?? this.override.frames ?? this.base;
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
    // A frame the skin has no lump for is looked up along its fallbacks, then in the animator's own
    // art: a partial skin file draws the player's colour, or the set's sprite, rather than nothing.
    // docs/sprites.md § Weapon-matching player sprites.
    let from = skin;
    let found: ReturnType<SpriteBank['lookup']> = undefined;
    for (; from !== null; from = from.fallback) {
      found = from.bank.lookup(from.spriteName, letter, digit);
      if (found) break;
    }
    found ??= this.bank.lookup(spriteName, letter, digit);
    if (!found) {
      this.cached = null;
      this.lastKey = '';
      return null;
    }

    // The cache beside the lump name keeps the memo honest: the same name can exist in several
    // caches, and the pair gates the cached sprite and `frameKey` alike.
    const materials = from !== null ? from.materials : this.materials;
    const key = found.lump + (found.flip ? ':f' : '');
    if (key !== this.lastKey || materials !== this.lastMaterials) {
      this.cached = materials.get(found.lump, found.flip);
      this.lastKey = key;
      this.lastMaterials = materials;
      // Logical, never the skin's name: `FULLBRIGHT_FRAMES` holds `PLAYF` and GLDEFS binds the
      // muzzle flash to that key, so both must keep matching while a skin draws the lump.
      this.frameKey = spriteName + letter;
    }
    return this.cached;
  }

  /**
   * Draws from `skin`'s bank and sprite name from the next {@link SpriteAnimator.resolve} on, or
   * from this animator's own with null. Deliberately touches no sequence state:
   * docs/sprites.md § Weapon-matching player sprites.
   */
  setSkin(skin: SpriteSkin | null): void {
    this.skin = skin;
  }

  /**
   * Gives this sprite a loop to play while still and {@link SpriteAnimator.standing}, in place of
   * holding `animFrames[0]` — a monster's stand art, `MONSTER_STAND_FRAMES`.
   */
  setStand(frames: string[], frameDuration: number): void {
    this.stand = frames;
    this.standDuration = frameDuration;
  }

  /**
   * Switches this sprite permanently into its one-shot death animation
   * ({@link SpriteAnimator.death}); calling it again restarts the sequence.
   *
   * @param spriteName  the sprite the death frames resolve against, where it is not this animator's
   *                    own — {@link SpriteAnimator.deathSpriteName}
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
   * Plays `frames` forward once ({@link SpriteAnimator.override}), then hands back to the alive
   * cycle. No-op while dead.
   *
   * @param durations  one rate for every frame, or a per-frame list (an attack pose, whose frames
   *                   carry vanilla's own uneven state tics)
   */
  playOnce(frames: string[], durations: number | readonly number[]): void {
    if (this.death.frames) return;
    this.override.start(frames, durations, false);
    // Same reason as `die`: keep `animIndex` valid for the sequence `resolve`
    // is about to read, without waiting for an `advance` to clamp it.
    this.animIndex = 0;
    this.animTimer = 0;
  }

  /** Undoes {@link SpriteAnimator.die}, back to the alive cycle — a player brought back to life. */
  revive(): void {
    this.death.stop();
    this.override.stop();
    this.deathSpriteName = null;
    this.animIndex = 0;
    this.animTimer = 0;
  }
}

/** What a {@link SpriteActor} draws, beyond the banks it draws through. */
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
  /** Whether the actor stands under sky — see {@link skyScale}. */
  sky: boolean;
}

/**
 * One sprite drawn as its own upright `THREE.Mesh`. The plane never tilts — see
 * {@link SpriteMaterialCache} — but turns around its vertical axis to keep facing the camera as it
 * orbits, so posing an actor repositions it, yaws it to the current viewer angle, and swaps in the
 * lump the facing angle and animation frame now pick.
 *
 * Used only for the **player**, the one sprite that genuinely wants its own mesh. Everything else
 * goes through `SpriteBatch` — map things via `game/things.ts`, transient effects via
 * `SpriteFxLayer` (`game/spritefx.ts`). docs/sprites.md § Batching.
 */
export class SpriteActor {
  readonly mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
  private anim: SpriteAnimator;

  /**
   * Current translucency (1 = the ordinary opaque material). Anything below 1 draws through a
   * per-actor **clone** of the shared cached material: {@link SpriteMaterialCache} hands out one
   * material per (lump, mirrored) pair for everything that draws that lump, so setting `opacity`
   * on it directly would fade every other user of the same art too. Only the player uses this
   * (partial invisibility, game/inventory.ts's `PINS` powerup), and `PLAY` is the player's alone —
   * but relying on that would make this a trap the first time something else reuses a lump.
   */
  private opacity = 1;
  private translucent = new Map<THREE.MeshBasicMaterial, THREE.MeshBasicMaterial>();
  /** The `(sprite, letter)` keys drawn at full light — {@link SpriteActorOptions.brightFrames}. */
  private brightFrames: ReadonlySet<string>;

  constructor(bank: SpriteBank, materials: SpriteMaterialCache, options: SpriteActorOptions) {
    this.anim = new SpriteAnimator(bank, materials, options.spriteName, options.animFrames);
    this.brightFrames = options.brightFrames;
  }

  /**
   * The `SPRITE+LETTER` this actor last resolved — what `DynamicLights` keys a light off
   * (docs/lights.md § The frame key). Empty until the first {@link SpriteActor.setPose}, and one
   * frame behind during a pose the caller has set but not yet drawn.
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
    // A fullbright frame lights itself, so it takes no tint
    // (docs/render-lighting.md § Outdoor sky tint).
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
   * Draws this actor at `opacity` (1 = normal) from the next {@link SpriteActor.setPose} on — see
   * {@link SpriteActor.opacity}.
   */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  /**
   * Draws this actor's frames from another file's art from the next {@link SpriteActor.setPose} on
   * — the player's weapon-matching skin — or from the loaded set's own with null.
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
   * Releases the translucent clones made by {@link SpriteActor.setOpacity}. Their textures are
   * shared with (and owned by) {@link SpriteMaterialCache}, so only the cloned materials are this
   * actor's to free.
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
 * {@link SpriteMaterialCache}'s {@link CachedSprite}. The atlas rect and
 * {@link LumpSprite.bottomOffset} are settled at lookup; the texture, plane and material behind
 * them are built on the first read that wants them — see {@link CachedSprite.material}. A class
 * rather than an object literal over the lookup's locals, so what a cached lump holds onto is the
 * four fields below and not the whole of {@link SpriteMaterialCache.get}.
 */
class LumpSprite implements CachedSprite {
  readonly atlas: AtlasSprite | null;
  /**
   * The plane's bottom edge sits at the thing's own z rather than at `top`, which this view has
   * no floor clip to cover for; what `top` says is kept here instead — see {@link CachedSprite}.
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
 * A one-shot frame sequence, either holding on its last frame forever once exhausted
 * ({@link SpriteAnimator}'s death slot) or clearing itself and handing control back to the caller
 * (its attack/pain override slot) — the two differ only in that, so both share this bookkeeping.
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
