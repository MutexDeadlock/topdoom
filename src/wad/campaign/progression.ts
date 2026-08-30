/**
 * Which level an exit leads to. Vanilla's own progression is a pair of hard-coded tables in
 * `G_DoCompleted` (`g_game.c`) rather than anything the WAD carries, so it lives here beside the
 * level-title tables it keeps company with; a WAD set that ships MAPINFO can override it per map.
 * See docs/wad.md § Level progression.
 */
import { MAPINFO_END, type MapInfo } from './mapinfo.ts';

/**
 * Where one of a level's two exits leads. The three cases are deliberately distinct: vanilla
 * *ending the game* and vanilla *having no rule for this name* were both a bare null once, and the
 * load-order fallback that is right for a PWAD's own naming sent MAP30 to MAP31.
 * See docs/wad.md § Level progression.
 */
export type NextLevel =
  /** A level to load next. */
  | { kind: 'map'; name: string }
  /**
   * The run ends here — `G_DoCompleted`'s `case 8: gameaction = ga_victory` and its missing MAP30
   * case. `scope` is which of the two it was: DOOM's episodes end one at a time, DOOM II's single
   * campaign ends outright. `next` is the following episode's first map (`E1M8` → `E2M1`) where
   * the naming scheme has one at all, which this engine carries on into rather than dropping to
   * the title screen; null where it doesn't (docs/hud.md § End card).
   */
  | { kind: 'end'; scope: 'episode' | 'campaign'; next: string | null }
  /** Neither MAPINFO nor either vanilla table knows: `Game` falls back to the set's load order. */
  | { kind: 'unknown' };

/**
 * `E<episode>M<mission>`, DOOM's own naming — the only map names the episode rules below apply to.
 */
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

/** The two trivial `NextLevel`s, so the table below reads as a table. */
const toMap = (name: string): NextLevel => ({ kind: 'map', name });
const UNKNOWN: NextLevel = { kind: 'unknown' };

/**
 * Vanilla's next level for `mapName`: a map, the end of the campaign (`E<x>M8`, `MAP30`), or
 * nothing at all for a name in neither naming scheme. Pure table lookup — whether the level it
 * names actually exists in the loaded set is `LevelProgression`'s question, not this one, and that
 * includes the following episode an episode end names.
 */
export function vanillaNextMap(mapName: string, secret: boolean): NextLevel {
  const doom2 = DOOM2_MAP.exec(mapName);
  if (doom2) {
    const number = Number(doom2[1]);
    if (secret) {
      const exit = DOOM2_SECRET_EXITS[mapName];
      return exit ? toMap(exit) : UNKNOWN;
    }
    if (DOOM2_SECRET_LEVELS.includes(mapName)) return toMap(DOOM2_SECRET_RETURN);
    // `G_DoCompleted` has no MAP30 case: MAP30 is the Icon of Sin, and killing it ends the game.
    // DOOM II is one campaign rather than episodes, so nothing follows it.
    if (number >= 30) return { kind: 'end', scope: 'campaign', next: null };
    return toMap(doom2Name(number + 1));
  }

  const doom1 = DOOM1_MAP.exec(mapName);
  if (!doom1) return UNKNOWN;
  const [episode, mission] = [doom1[1], Number(doom1[2])];
  // `case 8: gameaction = ga_victory; return;` — **before** `G_DoCompleted` looks at `secretexit`
  // at all, so either exit out of M8 ends the episode. The next episode's M1 is named
  // unconditionally and uncapped: vanilla has four episodes, but a set carrying a fifth is exactly
  // what the caller's own "only a map the set has" rule is there to decide.
  if (mission === 8) return { kind: 'end', scope: 'episode', next: `E${Number(episode) + 1}M1` };
  // M9 is the episode's secret level and ends nothing: `case 9` only sets `didsecret`.
  if (secret) return toMap(`E${episode}M9`);
  if (mission === 9) {
    const back = SECRET_LEVEL_RETURN[episode];
    return back ? toMap(`E${episode}M${back}`) : UNKNOWN;
  }
  return toMap(`E${episode}M${mission + 1}`);
}

/**
 * Where each of a level's two exits leads, for one loaded WAD set. Built once per `Game` for the
 * same reason `LevelNames` is: which maps the set provides depends on the file set, not on which
 * map is loaded.
 */
export class LevelProgression {
  private mapInfo: MapInfo;
  /**
   * The loaded set's maps, upper-cased for lookup but kept in their own spelling: what `nextMap`
   * returns has to be a name `Game` can find in its own list.
   */
  private known: Map<string, string>;

  constructor(mapInfo: MapInfo, mapNames: readonly string[]) {
    this.mapInfo = mapInfo;
    this.known = new Map(mapNames.map((name) => [name.toUpperCase(), name]));
  }

  /**
   * Where an exit out of `mapName` leads, resolved against the maps the loaded set actually
   * provides (docs/wad.md § Level progression).
   *
   * A map named by MAPINFO wins over the vanilla table, and a name neither the set nor the table
   * can place is skipped rather than trusted: a `next` the loaded WADs don't provide would
   * otherwise strand the player on a level with no way out.
   */
  nextMap(mapName: string, secret: boolean): NextLevel {
    const upper = mapName.toUpperCase();
    const declared = this.mapInfo.entry(upper);
    const wanted = secret ? declared?.secretNext : declared?.next;
    // The set's MAPINFO saying the game ends here needs no map to exist for it.
    if (wanted === MAPINFO_END) return { kind: 'end', scope: 'campaign', next: null };
    const named = wanted ? this.provided(wanted) : undefined;
    if (named) return { kind: 'map', name: named };

    const vanilla = vanillaNextMap(upper, secret);
    if (vanilla.kind === 'map') {
      const provided = this.provided(vanilla.name);
      if (provided) return { kind: 'map', name: provided };
    } else if (vanilla.kind === 'end') {
      // The following episode is offered only when the set has it — Ultimate DOOM's E1M8 leads on
      // to E2M1, shareware's ends the game there.
      return { ...vanilla, next: (vanilla.next && this.provided(vanilla.next)) ?? null };
    }
    // A secret exit the set can't honour still has to exit: fall back to the normal one, which is
    // `G_SecretExitLevel`'s own no-MAP31 behavior.
    if (secret) return this.nextMap(upper, false);
    return { kind: 'unknown' };
  }

  /** The set's own spelling of `name` when it provides that map, else undefined. */
  private provided(name: string): string | undefined {
    return this.known.get(name.toUpperCase());
  }
}

function doom2Name(number: number): string {
  return `MAP${String(number).padStart(2, '0')}`;
}
