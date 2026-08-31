/**
 * The shipped weapon-matching player art in drawable form: the skin file's own banks, and which
 * `SpriteSkin` the player's billboard draws for the weapon in hand. `wad/playerskin.ts` owns the
 * file itself, the setting and the question of whether the loaded set draws its own player.
 * See docs/sprites.md § Weapon-matching player sprites.
 */
import type * as THREE from 'three';
import { GraphicsBank } from '../wad/graphics.ts';
import { SpriteBank } from '../wad/sprites.ts';
import { Wad, type WadFile } from '../wad/wad.ts';
import { getPlayerSpriteMode } from '../wad/playerskin.ts';
import { SpriteMaterialCache, type SpriteSkin } from './sprites.ts';
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

/**
 * The skin file's own banks and the one `SpriteSkin` per weapon they resolve — deliberately a `Wad`
 * of its own rather than a file appended to the loaded set: `wadSetId` turns every entry of
 * `wad.files` into a savegame's WAD-set identity, so a set this file joined would refuse every
 * existing save and stamp a phantom file onto every new one (docs/savegames.md § WAD-set identity).
 * It ships no PLAYPAL and borrows the set's, so a WAD with its own palette recolours the skins along
 * with everything else.
 *
 * Built whether or not the setting currently asks for skins — the mode can change mid-session, and
 * nothing here decodes a lump until one is actually drawn.
 */
export class PlayerSkins {
  private materials: SpriteMaterialCache;
  private byWeapon: Record<WeaponId, SpriteSkin>;

  constructor(file: WadFile, palette: Uint8Array, renderer: THREE.WebGLRenderer) {
    const wad = new Wad(file);
    const bank = new SpriteBank(wad);
    this.materials = new SpriteMaterialCache(new GraphicsBank(wad, palette), renderer);
    this.byWeapon = {} as Record<WeaponId, SpriteSkin>;
    for (const [weapon, spriteName] of Object.entries(PLAYER_WEAPON_SPRITES) as [WeaponId, string][]) {
      this.byWeapon[weapon] = { bank, materials: this.materials, spriteName };
    }
  }

  /**
   * The skin the player draws with `weapon` in hand, or null for the loaded set's own `PLAY` art.
   * The setting is read per call rather than captured, so the menu applies it to the level already
   * running; `setDrawsOwnPlayer` is the loaded set's own answer, resolved once per session.
   *
   * The same record comes back every frame for a given weapon, so a caller handing it straight to
   * `SpriteActor.setSkin` allocates nothing.
   */
  skinFor(weapon: WeaponId, setDrawsOwnPlayer: boolean): SpriteSkin | null {
    const mode = getPlayerSpriteMode();
    if (mode === 'never') return null;
    if (mode === 'auto' && setDrawsOwnPlayer) return null;
    return this.byWeapon[weapon];
  }

  dispose(): void {
    this.materials.dispose();
  }
}
