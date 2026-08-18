/**
 * Which level an exit leads to. Vanilla's own progression is a pair of hard-coded tables in
 * `G_DoCompleted` (`g_game.c`) rather than anything the WAD carries, so it lives here beside the
 * level-title tables it keeps company with; a WAD set that ships MAPINFO can override it per map.
 * See docs/wad.md § Level progression.
 */
import type { MapInfo } from './mapinfo.ts';

/** `E<episode>M<mission>`, DOOM's own naming — the only map names the episode rules below apply to. */
const DOOM1_MAP = /^E(\d)M(\d)$/;
/** `MAP<nn>`, DOOM II's. */
const DOOM2_MAP = /^MAP(\d\d)$/;

/**
 * Where a normal exit out of `E<episode>M9` leads: vanilla's `G_DoCompleted` sends the player back
 * to the level *after* the one whose secret exit reaches M9, and each episode hides that exit
 * somewhere different. The source writes these 0-biased (`wminfo.next = 3` for episode 1); these
 * are the map numbers themselves.
 */
const SECRET_LEVEL_RETURN: Record<string, number> = { '1': 4, '2': 6, '3': 7, '4': 3 };

/** DOOM II's own secret levels, and the map each one's normal exit returns to (`MAP16`). */
const DOOM2_SECRET_LEVELS = ['MAP31', 'MAP32'];
const DOOM2_SECRET_RETURN = 'MAP16';
/** The only DOOM II level whose secret exit leads anywhere, and where it leads. */
const DOOM2_SECRET_EXITS: Record<string, string> = { MAP15: 'MAP31', MAP31: 'MAP32' };

function doom2Name(number: number): string {
  return `MAP${String(number).padStart(2, '0')}`;
}

/**
 * Vanilla's next level for `mapName`, or null where vanilla ends the game instead (`E<x>M8`,
 * `MAP30`) or where the name follows neither naming scheme. Pure table lookup — whether the level
 * it names actually exists in the loaded set is `LevelProgression`'s question, not this one.
 */
export function vanillaNextMap(mapName: string, secret: boolean): string | null {
  const doom2 = DOOM2_MAP.exec(mapName);
  if (doom2) {
    const number = Number(doom2[1]);
    if (secret) return DOOM2_SECRET_EXITS[mapName] ?? null;
    if (DOOM2_SECRET_LEVELS.includes(mapName)) return DOOM2_SECRET_RETURN;
    // `G_DoCompleted` has no MAP30 case: MAP30 is the Icon of Sin, and killing it ends the game.
    if (number >= 30) return null;
    return doom2Name(number + 1);
  }

  const doom1 = DOOM1_MAP.exec(mapName);
  if (!doom1) return null;
  const [episode, mission] = [doom1[1], Number(doom1[2])];
  if (secret) return `E${episode}M9`;
  if (mission === 9) {
    const back = SECRET_LEVEL_RETURN[episode];
    return back ? `E${episode}M${back}` : null;
  }
  // `case 8: gameaction = ga_victory` — the episode ends here rather than continuing to M9, which
  // is only ever reached through a secret exit.
  if (mission >= 8) return null;
  return `E${episode}M${mission + 1}`;
}

/**
 * Where each of a level's two exits leads, for one loaded WAD set. Built once per `Game` for the
 * same reason `LevelNames` is: which maps the set provides depends on the file set, not on which
 * map is loaded.
 */
export class LevelProgression {
  private mapInfo: MapInfo;
  /** The loaded set's maps, upper-cased for lookup but kept in their own spelling: what `nextMap` returns has to be a name `Game` can find in its own list. */
  private known: Map<string, string>;

  constructor(mapInfo: MapInfo, mapNames: readonly string[]) {
    this.mapInfo = mapInfo;
    this.known = new Map(mapNames.map((name) => [name.toUpperCase(), name]));
  }

  /**
   * The map an exit out of `mapName` leads to, or null when nothing knows one — the WAD set names
   * no successor and vanilla either ends the game here (`MAP30`, `E<x>M8`) or has no rule for a
   * name in neither of its two schemes. `Game` falls back to the loaded set's own order there,
   * since this engine has no finale to run instead (docs/wad.md § Level progression).
   *
   * A map named by MAPINFO wins over the vanilla table, and a name neither the set nor the table
   * can place is skipped rather than trusted: a `next` the loaded WADs don't provide would
   * otherwise strand the player on a level with no way out.
   */
  nextMap(mapName: string, secret: boolean): string | null {
    const upper = mapName.toUpperCase();
    const declared = this.mapInfo.entry(upper);
    const wanted = secret ? declared?.secretNext : declared?.next;
    if (wanted && this.known.has(wanted)) return this.known.get(wanted)!;

    const vanilla = vanillaNextMap(upper, secret);
    if (vanilla && this.known.has(vanilla)) return this.known.get(vanilla)!;
    // A secret exit the set can't honour still has to exit: fall back to the normal one, which is
    // `G_SecretExitLevel`'s own no-MAP31 behavior.
    if (secret) return this.nextMap(upper, false);
    return null;
  }
}
