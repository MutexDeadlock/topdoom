/**
 * The one WAD this engine ships itself — the light definitions, the secret chime and the
 * weapon-matching player art, none of which any game WAD provides. Built from `assets/` at build
 * time by `plugins/game-wad.ts`, fetched once per session, and never merged into the loaded set.
 * See docs/wad.md § The WAD the engine ships.
 */
import { Wad, WadFile } from './wad.ts';

/**
 * Where the built file is served from, without the leading `/`: also the name the Vite plugin emits
 * it under, so producer and consumer cannot drift.
 */
export const SHIPPED_WAD_PATH = 'game/topdoom.wad';

/** The two lumps that are not sprites. The player art keeps its own `S_START`..`S_END` block. */
export const SHIPPED_GLDEFS = 'GLDEFS';
export const SHIPPED_SECRET = 'SECRET';

/** Memoized: a fixed asset, and every level load would otherwise re-fetch and re-parse it. */
let shipped: Promise<WadFile | null> | null = null;
let index: Promise<Wad | null> | null = null;

/**
 * The shipped WAD, parsed once per session. A fetch or a parse that fails resolves to **null**
 * rather than rejecting: every reader has a fallback that costs the game a feature, not a level,
 * and none of them may keep one from starting.
 */
export function shippedWad(): Promise<WadFile | null> {
  shipped ??= fetch(`/${SHIPPED_WAD_PATH}`)
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((buffer) => new WadFile(buffer, 'topdoom.wad'))
    .catch((err: unknown) => {
      console.warn(`Could not load ${SHIPPED_WAD_PATH}; lights, player skins and the secret chime are off:`, err);
      return null;
    });
  return shipped;
}

/**
 * One lump out of it, as bytes — for the two readers that want a single lump rather than the file.
 * The returned view is into the shared buffer, so a caller handing it to an API that takes
 * ownership (`decodeAudioData`) must copy first.
 */
export function shippedLump(name: string): Promise<Uint8Array | null> {
  index ??= shippedWad().then((file) => (file ? new Wad(file) : null));
  return index.then((wad) => {
    const lump = wad?.find(name);
    return wad && lump ? wad.data(lump) : null;
  });
}
