/**
 * Cross-cutting values and the tuned-by-feel dials. CLAUDE.md's constants rule says what may live
 * here — nothing identity-coupled to one module, however often it's imported.
 *
 * Cross-cutting, so there is no `docs/` page of its own: each dial is documented where it takes
 * effect — docs/render.md § View distance, docs/render-lighting.md § Sector lighting,
 * docs/sprites.md § Pickup scale, docs/devmode.md § Dev mode, docs/frameloop.md.
 */
import { ThingType } from './game/things/doomednums.ts';

/** Shown on the start menu. */
export const VERSION = '0.19.1';

/**
 * Set VITE_DEVMODE=true in .env.local to default the three Debug / Dev settings on. It gates
 * nothing else: no key and no game behavior is behind it — docs/devmode.md § Dev mode.
 */
export const DEVMODE = import.meta.env?.VITE_DEVMODE === 'true';

/**
 * One vanilla tic in seconds. DOOM's whole game clock runs at 35 Hz
 */
export const DOOM_TIC = 1 / 35;

/**
 * How much `render/sectorlight.ts` brightens dark sectors above vanilla's own ramp
 * (`lightToColor`), which is accurate to vanilla but reads too dark for this game's top-down
 * camera. Applied by `litColor` for the sprites and by `liftedGain` in the map shader, so it is
 * the one dial for how bright the game reads. docs/render-lighting.md § Sector lighting.
 */
export const BRIGHTNESS_LIFT = 0.06;

/**
 * How far the player can see, in map units.
 * docs/render.md § View distance, docs/fogofwar.md § Reveal radius.
 */
export const VIEW_DISTANCE = 16000;

/**
 * Where that fog starts hazing, as a fraction of {@link VIEW_DISTANCE} (fully opaque at 1.0), so
 * moving the one dial above keeps the fade band in proportion — which is why it lives beside it
 * rather than with the `game.ts` line that reads it.
 * docs/render.md § View distance.
 */
export const FOG_START_FRACTION = 0.54;

/**
 * {@link PICKUP_SCALE_TYPES} (ammo, health/armor, keys, powerups) draw at vanilla's native patch
 * size times this factor. Tuned by feel: the far, tilted top-down camera reads a lot worse than
 * DOOM's own ground-level first-person view at the same pixel size, and small collectibles like a
 * clip or a shell box are the ones that suffer most.
 */
export const PICKUP_SCALE = 1.25;

/**
 * Which things {@link PICKUP_SCALE} applies to.
 * docs/sprites.md § Pickup scale.
 */
export const PICKUP_SCALE_TYPES: Set<number> = new Set([
  // Ammo
  ThingType.clip,
  ThingType.boxOfBullets,
  ThingType.rocket,
  ThingType.cellCharge,
  ThingType.shells,
  ThingType.boxOfShells,
  ThingType.backpack,

  // Health & armor
  ThingType.stimpack,
  ThingType.medikit,
  ThingType.soulsphere,
  ThingType.healthBonus,
  ThingType.armorBonus,
  ThingType.greenArmor,
  ThingType.blueArmor,
  ThingType.megasphere,

  // Keys
  ThingType.blueKeycard,
  ThingType.blueSkullKey,
  ThingType.redKeycard,
  ThingType.redSkullKey,
  ThingType.yellowKeycard,
  ThingType.yellowSkullKey,

  // Powerups
  ThingType.invulnerability,
  ThingType.berserk,
  ThingType.invisibility,
  ThingType.radiationSuit,
  ThingType.lightAmpVisor,
]);

/**
 * **The WAD set a player sees on their very first start** — nothing stored, no `?wad=` in the URL.
 * Without it the menu falls to whatever game WAD the manifest happens to list first, which is a
 * curator's decision left to file order. A name no `public/game/` file answers to is skipped, so a
 * stripped deployment falls back to that first-listed WAD as before.
 * docs/menu-wads.md § The first start.
 */
export const FIRST_RUN_WADS: { iwad: string; pwads: {
  /** a served `WadSource.key`, matched case-insensitively  */
  file: string;
  on: boolean;
}[] } = {
  iwad: 'freedoom2.wad',
  pwads: [
    { file: 'GoingDown.wad', on: false },
    { file: 'NUTS.WAD', on: false },
  ],
};

/**
 * How solid a Boom deep-water surface draws over the pool bottom beneath it
 * (0 = invisible, 1 = opaque, tuned by feel).
 * docs/specials-transfers.md § Deep water.
 */
export const WATER_SURFACE_ALPHA = 0.5;
