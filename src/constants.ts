/**
 * Cross-cutting values and the tuned-by-feel dials. CLAUDE.md's constants rule says what may live
 * here — nothing identity-coupled to one module, however often it's imported.
 *
 * Cross-cutting, so there is no `docs/` page of its own: each dial is documented where it takes
 * effect — docs/render.md § View distance, docs/render.md § Sector lighting,
 * docs/sprites.md § Pickup scale, docs/menu.md § Dev mode, docs/frameloop.md.
 */
import { ThingType } from './game/things/doomednums.ts';

/** Shown on the start menu. */
export const VERSION = '0.13.0';

/**
 * Set VITE_DEVMODE=true in .env.local to enable in-game debug info and dev hotkeys.
 */
export const DEVMODE = import.meta.env?.VITE_DEVMODE === 'true';

/**
 * One vanilla tic in seconds. DOOM's whole game clock runs at 35 Hz, so every duration lifted from
 * `info.c`'s state tables, `p_pspr.c`'s weapon chains or `p_spec.c`'s wait counts is quoted in tics
 * and reaches this engine's dt-scaled model as `<tics> * DOOM_TIC`.
 */
export const DOOM_TIC = 1 / 35;

/**
 * How much `render/mapmesh.ts: litColor` brightens dark sectors above vanilla's own ramp
 * (`lightToColor`), which is accurate to vanilla but reads too dark for this game's top-down
 * camera.
 */
export const BRIGHTNESS_LIFT = 0.06;

/**
 * How far the player can see through explored territory, in map units: the scene's distance fog
 * (`game.ts`) is fully opaque at this range, and `TopDownCamera`'s far plane follows it. Tuned by
 * feel — it is what keeps a big open map from reading as a floorplan. What bounds an *unexplored*
 * view is `game/fogofwar.ts: SIGHT_RADIUS`, a much shorter and separately derived number.
 * docs/render.md § View distance.
 */
export const VIEW_DISTANCE = 12000;

/**
 * Where that fog starts hazing, as a fraction of `VIEW_DISTANCE` (fully opaque at 1.0), so moving
 * the one dial above keeps the fade band in proportion — which is why it lives beside it rather
 * than with the `game.ts` line that reads it. Tuned by feel: wide enough that distant geometry
 * dissolves instead of meeting a wall of black, narrow enough that the room the player is actually
 * fighting in stays at full brightness. docs/render.md § View distance.
 */
export const FOG_START_FRACTION = 0.54;

/**
 * `PICKUP_SCALE_TYPES` (ammo, health/armor, keys, powerups) draw at vanilla's native patch size
 * times this factor. Tuned by feel: the far, tilted top-down camera reads a lot worse than DOOM's
 * own ground-level first-person view at the same pixel size, and small collectibles like a clip or
 * a shell box are the ones that suffer most.
 */
export const PICKUP_SCALE = 1.25;

/**
 * Which things `PICKUP_SCALE` applies to.
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
