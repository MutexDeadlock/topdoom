/**
 * Cross-cutting values, the tuned-by-feel dials and the deployment's defaults. CLAUDE.md's
 * constants rule says what may live here — nothing identity-coupled to one module, however often
 * it's imported.
 *
 * Cross-cutting, so there is no `docs/` page of its own: each dial is documented where it takes
 * effect — docs/render.md § View distance, docs/render-lighting.md § Sector lighting,
 * docs/sprites.md § Pickup scale, docs/devmode.md § Dev mode, docs/frameloop.md.
 */
import { ThingType } from './game/things/doomednums.ts';

/** Shown on the start menu. */
export const VERSION = '0.20.0-test1';

/**
 * Set VITE_DEVMODE=true in .env.local to default the three Debug / Dev settings on. It gates
 * nothing else: no key and no game behavior is behind it — docs/devmode.md § Dev mode.
 */
export const DEVMODE = import.meta.env?.VITE_DEVMODE === 'true';

/**
 * **The relay the Multiplayer tab offers before a player enters one** — nothing stored. This
 * deployment's Cloudflare Worker; a local `npm run relay` is `ws://localhost:8765`.
 * docs/multiplayer-net.md § The relay on Cloudflare.
 */
export const DEFAULT_RELAY_URL = 'wss://relay.topdoom.workers.dev';

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
 * The factor a {@link PICKUP_SCALE} entry takes unless it is tuned on its own. Tuned by feel: the
 * far, tilted top-down camera reads a lot worse than DOOM's own ground-level first-person view at
 * the same pixel size, and small collectibles like a clip or a shell box are the ones that suffer
 * most.
 */
export const DEFAULT_PICKUP_SCALE = 1.25;

/**
 * Which things draw larger than vanilla's native patch size, and by how much — a type missing here
 * draws at 1. Every factor is tuned by feel.
 * docs/sprites.md § Pickup scale.
 */
export const PICKUP_SCALE: Partial<Record<number, number>> = {
  // Ammo
  [ThingType.clip]: DEFAULT_PICKUP_SCALE,
  [ThingType.boxOfBullets]: 1.1,
  [ThingType.rocket]: DEFAULT_PICKUP_SCALE,
  [ThingType.cellCharge]: DEFAULT_PICKUP_SCALE,
  [ThingType.shells]: DEFAULT_PICKUP_SCALE,
  [ThingType.boxOfShells]: DEFAULT_PICKUP_SCALE,
  [ThingType.backpack]: DEFAULT_PICKUP_SCALE,

  // Health & armor
  [ThingType.stimpack]: DEFAULT_PICKUP_SCALE,
  [ThingType.medikit]: DEFAULT_PICKUP_SCALE,
  [ThingType.soulsphere]: DEFAULT_PICKUP_SCALE,
  [ThingType.healthBonus]: 1.1,
  [ThingType.armorBonus]: DEFAULT_PICKUP_SCALE,
  [ThingType.greenArmor]: DEFAULT_PICKUP_SCALE,
  [ThingType.blueArmor]: DEFAULT_PICKUP_SCALE,
  [ThingType.megasphere]: DEFAULT_PICKUP_SCALE,

  // Keys
  [ThingType.blueKeycard]: DEFAULT_PICKUP_SCALE,
  [ThingType.blueSkullKey]: DEFAULT_PICKUP_SCALE,
  [ThingType.redKeycard]: DEFAULT_PICKUP_SCALE,
  [ThingType.redSkullKey]: DEFAULT_PICKUP_SCALE,
  [ThingType.yellowKeycard]: DEFAULT_PICKUP_SCALE,
  [ThingType.yellowSkullKey]: DEFAULT_PICKUP_SCALE,

  // Powerups
  [ThingType.invulnerability]: DEFAULT_PICKUP_SCALE,
  [ThingType.berserk]: DEFAULT_PICKUP_SCALE,
  [ThingType.invisibility]: DEFAULT_PICKUP_SCALE,
  [ThingType.radiationSuit]: DEFAULT_PICKUP_SCALE,
  [ThingType.lightAmpVisor]: DEFAULT_PICKUP_SCALE,
};

/**
 * **The WAD set a player sees on their very first start** — nothing stored, no `?wad=` in the URL.
 * Without it the menu falls to whatever game WAD the manifest happens to list first, which is a
 * curator's decision left to file order. A name no `public/game/` file answers to is skipped, so a
 * stripped deployment falls back to that first-listed WAD.
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
