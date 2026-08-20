/**
 * Vanilla's `S_music[]` and the per-map choice `S_Start` makes out of it — which track a level
 * plays, before a WAD's own MAPINFO gets a say. See docs/music.md § Which track a level plays.
 */

/**
 * `sounds.c`'s `S_music[]`, DOOM 1's own 27 level tracks in `mus_e1m1` order.
 * Lump names are these prefixed with `D_` (`i_sound.c`'s `sprintf(buf, "d_%s", …)`).
 */
export const DOOM1_MUSIC = [
  'e1m1', 'e1m2', 'e1m3', 'e1m4', 'e1m5', 'e1m6', 'e1m7', 'e1m8', 'e1m9',
  'e2m1', 'e2m2', 'e2m3', 'e2m4', 'e2m5', 'e2m6', 'e2m7', 'e2m8', 'e2m9',
  'e3m1', 'e3m2', 'e3m3', 'e3m4', 'e3m5', 'e3m6', 'e3m7', 'e3m8', 'e3m9',
];

/**
 * `S_Start`'s `spmus[]`: episode 4 has no music of its own and replays nine of
 * the first three episodes' tracks, in this order.
 */
const EPISODE4_MUSIC = ['e3m4', 'e3m2', 'e3m3', 'e1m5', 'e2m7', 'e2m4', 'e2m6', 'e2m5', 'e1m9'];

/** `S_music[]` continued: DOOM 2's 32 level tracks, `mus_runnin` (MAP01) onward. */
export const DOOM2_MUSIC = [
  'runnin', 'stalks', 'countd', 'betwee', 'doom', 'the_da', 'shawn', 'ddtblu',
  'in_cit', 'dead', 'stlks2', 'theda2', 'doom2', 'ddtbl2', 'runni2', 'dead2',
  'stlks3', 'romero', 'shawn2', 'messag', 'count2', 'ddtbl3', 'ampie', 'theda3',
  'adrian', 'messg2', 'romer2', 'tense', 'shawn3', 'openin', 'evil', 'ultima',
];

/**
 * The intermission's and finale's tracks. Held as `mus_*` mnemonics, like every other row in this
 * file, so they resolve through `musicLumpName` and a BEX `[MUSIC]` redirect reaches them too —
 * as literal `D_*` lump names they were the one path that silently ignored one.
 */
const INTERMISSION_MUSIC = 'inter';
const INTERMISSION_MUSIC_COMMERCIAL = 'dm2int';

/** `F_StartFinale`'s two: `mus_victor` after a DOOM episode, `mus_read_m` after DOOM II. */
const FINALE_MUSIC = 'victor';
const FINALE_MUSIC_COMMERCIAL = 'read_m';

/**
 * DMX's own volume curve, from Chocolate Doom's `i_oplmusic.c`
 * (`volume_mapping_table`) — the only place it is written down, since DMX
 * itself was never released. Both note velocity and channel volume go through
 * it before they are multiplied together into a carrier level, which is what
 * gives OPL music its particular loudness curve. See docs/music.md § Volume.
 */
export const DMX_VOLUME_CURVE = [
  0, 1, 3, 5, 6, 8, 10, 11, 13, 14, 16, 17, 19, 20, 22, 23,
  25, 26, 27, 29, 30, 32, 33, 34, 36, 37, 39, 41, 43, 45, 47, 49,
  50, 52, 54, 55, 57, 59, 60, 61, 63, 64, 66, 67, 68, 69, 71, 72,
  73, 74, 75, 76, 77, 79, 80, 81, 82, 83, 84, 84, 85, 86, 87, 88,
  89, 90, 91, 92, 92, 93, 94, 95, 96, 96, 97, 98, 99, 99, 100, 101,
  101, 102, 103, 103, 104, 105, 105, 106, 107, 107, 108, 109, 109, 110, 110, 111,
  112, 112, 113, 113, 114, 114, 115, 115, 116, 117, 117, 118, 118, 119, 119, 120,
  120, 121, 121, 122, 122, 123, 123, 123, 124, 124, 125, 125, 126, 126, 127, 127,
];

/** `ExMy` and `MAPxx`, the two level-name shapes the table is keyed by. */
const EPISODE_MAP = /^E(\d)M(\d)$/;
const COMMERCIAL_MAP = /^MAP(\d\d)$/;

/**
 * Lump names a DEHACKED/BEX `[MUSIC]` section has redirected, keyed by the `mus_*` mnemonic (the
 * lump name without its `D_`). Empty unless a patch said otherwise.
 * docs/dehacked.md § Sounds and music.
 */
const MUSIC_LUMP_OVERRIDES = new Map<string, string>();

/** The lump a `mus_*` mnemonic resolves to — `i_sound.c`'s `sprintf(buf, "d_%s", …)`, unless patched. */
function musicLumpName(mnemonic: string): string {
  return MUSIC_LUMP_OVERRIDES.get(mnemonic) ?? `D_${mnemonic.toUpperCase()}`;
}

/** Redirects one track — a BEX `[MUSIC]` entry, or a `Music N` record. */
export function setMusicLump(mnemonic: string, lump: string): void {
  const upper = lump.toUpperCase();
  MUSIC_LUMP_OVERRIDES.set(mnemonic, upper.startsWith('D_') ? upper : `D_${upper}`);
}

/** Drops every redirect, before a new patch is applied. docs/dehacked.md § Applying: reset, then patch. */
export function resetMusicLumps(): void {
  MUSIC_LUMP_OVERRIDES.clear();
}

/**
 * The `D_*` lump `S_Start` would play on this map, or null for a map name in
 * neither of vanilla's two shapes (a PWAD is free to call a map anything).
 *
 * One deviation, and it is about maps vanilla never had: a megawad's MAP33+ or
 * a sixth episode runs off the end of the table, which vanilla reads straight
 * past into whatever follows in memory. The index wraps instead, so those maps
 * play a track from the same game rather than nothing or a crash.
 */
export function vanillaMusicFor(mapName: string): string | null {
  const commercial = COMMERCIAL_MAP.exec(mapName);
  if (commercial) {
    const index = Number(commercial[1]) - 1;
    if (index < 0) return null;
    return musicLumpName(DOOM2_MUSIC[index % DOOM2_MUSIC.length]);
  }
  const episode = EPISODE_MAP.exec(mapName);
  if (episode) {
    const e = Number(episode[1]);
    const m = Number(episode[2]);
    if (e < 1 || m < 1) return null;
    if (e === 4) return musicLumpName(EPISODE4_MUSIC[(m - 1) % EPISODE4_MUSIC.length]);
    const index = ((e - 1) * 9 + (m - 1)) % DOOM1_MUSIC.length;
    return musicLumpName(DOOM1_MUSIC[index]);
  }
  return null;
}

/**
 * The intermission's track, `S_ChangeMusic(mus_inter)` / `mus_dm2int`: vanilla
 * keys the choice on `gamemode == commercial`, which this engine — having no
 * gamemode — reads off the map-name shape, the same approximation
 * `vanillaMusicFor` makes.
 */
export function intermissionMusicFor(mapName: string): string {
  return musicLumpName(COMMERCIAL_MAP.test(mapName) ? INTERMISSION_MUSIC_COMMERCIAL : INTERMISSION_MUSIC);
}

/**
 * The track the campaign's last screen plays — `F_StartFinale`'s own `S_ChangeMusic`, keyed on the
 * map-name shape for the same want-of-a-gamemode reason as `intermissionMusicFor`. This engine's
 * end card is not vanilla's finale (docs/hud.md § End card), but it is the screen that stands in
 * for it, so it takes the same music.
 */
export function finaleMusicFor(mapName: string): string {
  return musicLumpName(COMMERCIAL_MAP.test(mapName) ? FINALE_MUSIC_COMMERCIAL : FINALE_MUSIC);
}
