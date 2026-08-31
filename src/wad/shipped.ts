/**
 * The one WAD this engine ships itself — the light definitions, the secret chime and the
 * weapon-matching player art, none of which any game WAD provides. Built from `assets/` at build
 * time by `plugins/game-wad.ts`, fetched once per session, and never merged into the loaded set.
 * See docs/wad.md § The WAD the engine ships.
 */
import { WadFile } from './wad.ts';

/**
 * Where the built file is served from, without the leading `/`: also the name the Vite plugin emits
 * it under, so producer and consumer cannot drift. Its first segment is deliberately `library.ts`'s
 * `WAD_DIR` — one `Disallow:` in `robots.txt` covers everything served under it, this included —
 * but it is not built from it: this is the engine's own asset, not a served WAD folder.
 */
export const SHIPPED_WAD_PATH = 'game/topdoom.wad';

/** The two lumps that are not sprites. The player art keeps its own `S_START`..`S_END` block. */
export const SHIPPED_GLDEFS = 'GLDEFS';
export const SHIPPED_SECRET = 'SECRET';

/** What `shippedLump` may be asked for — the file's own two, not any name a caller invents. */
export type ShippedLump = typeof SHIPPED_GLDEFS | typeof SHIPPED_SECRET;

/** Memoized: a fixed asset, and every level load would otherwise re-fetch and re-parse it. */
let shipped: Promise<WadFile | null> | null = null;

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
 * One lump out of it, for the two readers that want a lump rather than the file. A **copy**, not a
 * view: the one buffer behind it also backs the player skins, and `decodeAudioData` detaches what
 * it is handed — a view would take lights and skins down with the chime. Both lumps are tens of KB
 * and both callers memoize what they decode, so the copy is paid twice a session.
 */
export function shippedLump(name: ShippedLump): Promise<ArrayBuffer | null> {
  return shippedWad().then((file) => {
    const entry = file?.entries.find((e) => e.name === name);
    return file && entry ? file.buffer.slice(entry.offset, entry.offset + entry.size) : null;
  });
}
