/**
 * The weapon-matching player art this engine ships itself (`public/game/playerskins.wad`), the
 * question of whether a loaded set draws the player its own way, and the setting that decides when
 * the shipped art stands in. See docs/sprites.md § Weapon-matching player sprites.
 */
import { hashBytes } from './checksum.ts';
import { spriteLumpFor } from './sprites.ts';
import { WadFile, type Wad } from './wad.ts';

/**
 * The frames a skin file has to resolve: walk, attack and pain (`PLAY`'s own `A`-`G`) at all eight
 * rotations, and the death chain at rotation 1, as `PLAY`'s death is. One roster, read by both the
 * converter (`scripts/build-playerskins.ts`, before it writes) and `tests/wad/playerskin.test.ts`
 * (against the shipped file).
 */
export const SKIN_ROTATED_FRAMES = 'ABCDEFG';
export const SKIN_FLAT_FRAMES = 'HIJKLMN';

/** Where the shipped art is served from; Vite copies `public/` to the site root. */
const SKIN_URL = '/game/playerskins.wad';

/**
 * When the player's billboard draws the shipped weapon-matching art: only where the loaded set has
 * no player art of its own (`auto`, the default), always, or never.
 */
export type PlayerSpriteMode = 'auto' | 'always' | 'never';

const MODE_STORAGE_KEY = 'topdoom.playerSprites';
const MODES: readonly PlayerSpriteMode[] = ['auto', 'always', 'never'];

/**
 * Read per drawn frame, so a change applies to the level already running. Shaped like every
 * persisted setting — docs/menu.md § Persisted settings.
 */
let playerSpriteMode = readMode();

export function getPlayerSpriteMode(): PlayerSpriteMode {
  return playerSpriteMode;
}

export function setPlayerSpriteMode(mode: PlayerSpriteMode): void {
  playerSpriteMode = mode;
  globalThis.localStorage?.setItem(MODE_STORAGE_KEY, mode);
}

/** Memoized: a fixed asset, and every level load would otherwise re-fetch and re-parse it. */
let stock: Promise<WadFile | null> | null = null;

/**
 * The shipped art, parsed once per session. A fetch or a parse that fails resolves to **null**
 * rather than rejecting: the player then draws the set's own `PLAY` art, which is the game as it
 * was before this file existed rather than a broken one, and it must never keep a level from
 * starting.
 */
export function stockPlayerSkins(): Promise<WadFile | null> {
  stock ??= fetch(SKIN_URL)
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((buffer) => new WadFile(buffer, 'playerskins.wad'))
    .catch((err) => {
      console.warn('Could not load playerskins.wad; the player draws vanilla PLAY instead:', err);
      return null;
    });
  return stock;
}

/** `PLAY` + a frame letter + a rotation digit — a player sprite lump, and not `PLAYPAL`. */
const PLAYER_SPRITE_LUMP = /^PLAY[A-W][0-8]/;

/**
 * `hashBytes` of vanilla's own `PLAYA1` and `PLAYE1` — the walk and attack frames. Both lumps are
 * byte-identical in `DOOM1.WAD` and `DOOM2.WAD` and differ in `freedoom2.wad`, which is what lets
 * this tell an IWAD drawing vanilla's marine from one drawing its own.
 */
const VANILLA_PLAYER_ART: Record<string, string> = {
  PLAYA1: 'f694e36ce2d43dc8',
  PLAYE1: '20cc8ddbbb97ee67',
};

/**
 * Whether the loaded set draws the player its own way: a DEHACKED `[SPRITES]` line pointing `PLAY`
 * elsewhere, a file after the game WAD shipping player sprites of its own, or a game WAD whose own
 * `PLAY` art is not vanilla's (Freedoom's marine). Such a set has made a decision about what the
 * player looks like, so the shipped skins stay out of its way unless the setting overrides.
 *
 * A false positive is the safe direction — it only leaves that set's player alone. Read once per
 * session, in `Game`'s constructor.
 */
export function setDrawsOwnPlayer(wad: Wad): boolean {
  if (spriteLumpFor('PLAY') !== 'PLAY') return true;
  const gameWad = wad.files[0];
  for (const lump of wad.lumps) {
    if (lump.source !== gameWad && PLAYER_SPRITE_LUMP.test(lump.name)) return true;
  }
  for (const [name, digest] of Object.entries(VANILLA_PLAYER_ART)) {
    const lump = wad.find(name);
    if (!lump || hashBytes(wad.data(lump)) !== digest) return true;
  }
  return false;
}

function readMode(): PlayerSpriteMode {
  const stored = globalThis.localStorage?.getItem(MODE_STORAGE_KEY);
  return MODES.find((mode) => mode === stored) ?? 'auto';
}
