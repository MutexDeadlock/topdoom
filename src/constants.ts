/** Shown bottom-right on the start menu. */
export const VERSION = '0.9.1';

/**
 * Set VITE_DEVMODE=true in .env.local to enable in-game debug info and dev hotkeys.
 * `env` is Vite-injected and absent under plain `node script.ts` (`?.` guards that) —
 * this file didn't use to matter there, but now that `BRIGHTNESS_LIFT` below lives
 * here too, anything importing `render/mapmesh.ts` pulls this in transitively,
 * including the headless synthetic-map scripts this project's own docs recommend.
 */
export const DEVMODE = import.meta.env?.VITE_DEVMODE === 'true';

/**
 * How much `render/mapmesh.ts: litColor` brightens dark sectors above vanilla's own ramp
 * (`lightToColor`), which is accurate to vanilla but reads too dark for this game's top-down
 * camera — vanilla assumes a first-person view a few dozen units from what it's lighting,
 * broken up by nearby bright surfaces and real depth cues; this camera looks down on an entire
 * dim room at once with neither. 0 = vanilla-exact, 1 = flattens everything to full bright.
 * Found by feel via a temporary in-HUD slider; kept here, on its own, so it stays easy to find
 * and retune without hunting through render code.
 */
export const BRIGHTNESS_LIFT = 0.12;
