/**
 * Which sky texture a level stands under: what the set's MAPINFO names for it where the set carries
 * it, else vanilla's own choice off the map name — which vanilla reads rather than the WAD, so the
 * rule lives here beside the other tables keyed that way.
 * See docs/wad.md § The sky texture.
 */

/**
 * The art a level's sky is drawn from: `named` (the set's MAPINFO) where `art` resolves it, else
 * `vanillaSkyTexture`. `art` is the caller's lookup, and either name may be a composite texture or
 * the bare patch lump a set can ship one as — vanilla accepts only the first, and a mapper naming
 * the second gets the sky they meant.
 */
export function levelSkyArt<T>(mapName: string, named: string | undefined, art: (name: string) => T | null): T | null {
  return (named ? art(named) : null) ?? art(vanillaSkyTexture(mapName));
}

/** `E<episode>M<mission>`, DOOM's own naming. */
const EPISODIC_MAP = /^E(\d)M\d$/;

/** `MAP<nn>`, DOOM II's. */
const DOOM2_MAP = /^MAP(\d\d)$/;

/** The last episode with a sky of its own — Ultimate DOOM's, which `G_InitNew` clamps to. */
const LAST_EPISODE = 4;

/**
 * The sky `mapName` plays under (`g_game.c: G_InitNew`): DOOM II switches at maps 12 and 21, an
 * episode takes its own number. A name in neither scheme — a PWAD with its own — answers `SKY1`,
 * the one texture every set has; whether the WAD actually carries what this names is the caller's
 * question.
 */
export function vanillaSkyTexture(mapName: string): string {
  const name = mapName.toUpperCase();
  const doom2 = DOOM2_MAP.exec(name);
  if (doom2) {
    const map = Number(doom2[1]);
    return map < 12 ? 'SKY1' : map < 21 ? 'SKY2' : 'SKY3';
  }
  const episodic = EPISODIC_MAP.exec(name);
  if (!episodic) return 'SKY1';
  return `SKY${Math.min(Number(episodic[1]), LAST_EPISODE)}`;
}
