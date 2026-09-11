/**
 * The player's billboard art beyond the loaded set's own `PLAY` in green: the shipped
 * weapon-matching skins and the armour colours, each a `SpriteSkin` the billboard draws through.
 * `wad/playerskin.ts` owns the skin file, its setting and whether the loaded set draws its own
 * player; `wad/playercolor.ts` owns the colours. See docs/sprites.md § Weapon-matching player
 * sprites and § Player colours.
 */
import type * as THREE from 'three';
import { GraphicsBank } from '../wad/graphics.ts';
import { SpriteBank } from '../wad/sprites.ts';
import { Wad, type WadFile } from '../wad/wad.ts';
import { getPlayerSpriteMode } from '../wad/playerskin.ts';
import { translatedPalette, type PlayerColor } from '../wad/playercolor.ts';
import { SpriteMaterialCache, type SpriteSkin } from './sprites.ts';
import { playerSkinWeapon } from '../game/weapons.ts';
import type { WeaponId } from '../game/inventory/defs.ts';

/**
 * Which sprite of the shipped skin file draws the player holding each weapon, over the same frame
 * letters as `PLAY` itself. A deliberate departure from vanilla, which draws one body for all nine:
 * these are the WeaponMatchingPlayerSkin art's own four-character names. Berserk shares the fist's
 * set, the pack drawing no separate one.
 */
export const PLAYER_WEAPON_SPRITES: Record<WeaponId, string> = {
  fist: 'PLA1',
  pistol: 'PLA2',
  shotgun: 'PLA3',
  chaingun: 'PLA4',
  rocketLauncher: 'PLA5',
  plasmaRifle: 'PLA6',
  bfg: 'PLA7',
  chainsaw: 'PLA8',
  supershotgun: 'PLA9',
};

/** What `PlayerSkins` draws from. */
export interface PlayerSkinsOptions {
  /** The shipped weapon-matching art, or null where its fetch failed: the set's `PLAY` then. */
  file: WadFile | null;
  /** The loaded set and its sprite bank, whose `PLAY` a colour other than green redraws. */
  wad: Wad;
  bank: SpriteBank;
  /** The loaded set's PLAYPAL, which the skin file borrows and every colour translates. */
  palette: Uint8Array;
  renderer: THREE.WebGLRenderer;
}

/**
 * The skin file's own banks, and per colour the caches both it and the set's `PLAY` decode through.
 * The skin file is deliberately a `Wad` of its own rather than a file appended to the loaded set:
 * `wadSetId` turns every entry of `wad.files` into a savegame's WAD-set identity, so a set this
 * file joined would refuse every existing save and stamp a phantom file onto every new one
 * (docs/savegames.md § WAD-set identity). It ships no PLAYPAL and borrows the set's, so a WAD with
 * its own palette recolours the skins along with everything else.
 *
 * Built whether or not the setting currently asks for skins — the mode can change mid-session — and
 * a colour's caches only on its first draw; nothing decodes a lump until one is actually drawn.
 */
export class PlayerSkins {
  private skinWad: Wad | null;
  private skinBank: SpriteBank | null;
  private set: Wad;
  private setBank: SpriteBank;
  private palette: Uint8Array;
  private renderer: THREE.WebGLRenderer;
  private byColor = new Map<PlayerColor, ColorSkins>();

  constructor(options: PlayerSkinsOptions) {
    this.skinWad = options.file ? new Wad(options.file) : null;
    this.skinBank = this.skinWad ? new SpriteBank(this.skinWad) : null;
    this.set = options.wad;
    this.setBank = options.bank;
    this.palette = options.palette;
    this.renderer = options.renderer;
  }

  /**
   * The skin the player draws with `weapon` in hand and `color` on, or null for the loaded set's
   * own `PLAY` in green, as its atlas holds it. The setting is read per call rather than captured,
   * so the menu applies it to the level already running; `setDrawsOwnPlayer` is the loaded set's
   * own answer, resolved once per session.
   *
   * Which of the nine is drawn is `playerSkinWeapon`'s, not `weapon`'s: a DEHACKED patch can move
   * a weapon's shot onto another weapon's, and the art follows the shot.
   *
   * The same record comes back every frame for a given weapon and colour, so a caller handing it
   * straight to `SpriteActor.setSkin` allocates nothing.
   */
  skinFor(weapon: WeaponId, color: PlayerColor, setDrawsOwnPlayer: boolean): SpriteSkin | null {
    const skins = this.colorSkins(color);
    const mode = getPlayerSpriteMode();
    const matching = mode === 'always' || (mode === 'auto' && !setDrawsOwnPlayer);
    const drawn = matching ? playerSkinWeapon(weapon) : null;
    return drawn !== null && skins.byWeapon ? skins.byWeapon[drawn] : skins.play;
  }

  dispose(): void {
    for (const skins of this.byColor.values()) {
      for (const cache of skins.caches) cache.dispose();
    }
    this.byColor.clear();
  }

  private colorSkins(color: PlayerColor): ColorSkins {
    let skins = this.byColor.get(color);
    if (!skins) {
      skins = this.buildColor(color);
      this.byColor.set(color, skins);
    }
    return skins;
  }

  private buildColor(color: PlayerColor): ColorSkins {
    const palette = translatedPalette(this.palette, color);
    const caches: SpriteMaterialCache[] = [];
    const cacheOver = (wad: Wad): SpriteMaterialCache => {
      const cache = new SpriteMaterialCache(new GraphicsBank(wad, palette), this.renderer);
      caches.push(cache);
      return cache;
    };
    // Green is the palette itself, and the set's atlas already draws `PLAY` in it.
    const play = palette === this.palette ? null : { bank: this.setBank, materials: cacheOver(this.set), spriteName: 'PLAY' };
    let byWeapon: Record<WeaponId, SpriteSkin> | null = null;
    if (this.skinWad && this.skinBank) {
      const materials = cacheOver(this.skinWad);
      byWeapon = {} as Record<WeaponId, SpriteSkin>;
      for (const [weapon, spriteName] of Object.entries(PLAYER_WEAPON_SPRITES) as [WeaponId, string][]) {
        byWeapon[weapon] = { bank: this.skinBank, materials, spriteName };
      }
    }
    return { play, byWeapon, caches };
  }
}

/** One colour's art, as `PlayerSkins.skinFor` hands it out. */
interface ColorSkins {
  /** The set's `PLAY` in this colour, or null for green, which the set's atlas draws. */
  play: SpriteSkin | null;
  /** The shipped art in this colour, by weapon; null without the file. */
  byWeapon: Record<WeaponId, SpriteSkin> | null;
  /** Every cache built for the colour, for `dispose`. */
  caches: SpriteMaterialCache[];
}
