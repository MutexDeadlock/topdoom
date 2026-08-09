/** Shown bottom-right on the start menu. */
export const VERSION = '0.10.1';

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
export const BRIGHTNESS_LIFT = 0.12;

/**
 * How far the player can see, in map units: the scene's distance fog (`game.ts`) is fully opaque at
 * this range, so geometry past it is black no matter what the fog of war has revealed. Measured
 * from the camera eye, which hangs `TopDownCamera.distance` back from the player, so the view
 * actually reaches ~480 units less than this out in front. Tuned by feel — it is what keeps a big
 * open map from reading as a floorplan.
 */
export const VIEW_DISTANCE = 12000;

/**
 * `PICKUP_SCALE_TYPES` (ammo, health/armor, keys, powerups) draw at vanilla's native patch size
 * times this factor. Tuned by feel: the far, tilted top-down camera reads a lot worse than DOOM's
 * own ground-level first-person view at the same pixel size, and small collectibles like a clip or
 * a shell box are the ones that suffer most.
 */
export const PICKUP_SCALE = 1.4;
