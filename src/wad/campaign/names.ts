/**
 * Vanilla's level-title tables (`d_englsh.h`) and the IWAD identification they key off, plus the
 * per-WAD-set title resolution that folds MAPINFO in. See docs/wad.md § Level names.
 */
import type { Wad } from '../wad.ts';
import type { MapInfo } from './mapinfo.ts';

/**
 * Which of the four commercial map sets a loaded IWAD is. They all reuse the same `MAP01`-`MAP32`
 * lump names with entirely different level titles, so the lump name alone can't name a level —
 * the IWAD has to be identified first. See docs/wad.md § Level names.
 */
export type LevelMission = 'doom' | 'doom2' | 'plutonia' | 'tnt';

/**
 * Every level title id shipped, from `linuxdoom-1.10/d_englsh.h`: `HUSTR_E1M1`-`E4M9` (36),
 * `HUSTR_1`-`HUSTR_32` (DOOM II), `PHUSTR_*` (Plutonia) and `THUSTR_*` (TNT) — 132 strings,
 * generated from that header rather than typed out, TNT MAP05's "hanger" typo included.
 *
 * Stored bare and capitalized rather than as id wrote them (`"Hangar"`, not `"E1M1: Hangar"`) —
 * two deliberate departures, for the reason in docs/wad.md § Level names.
 */
export const LEVEL_NAMES: Record<LevelMission, Record<string, string>> = {
  doom: {
    E1M1: 'Hangar',
    E1M2: 'Nuclear Plant',
    E1M3: 'Toxin Refinery',
    E1M4: 'Command Control',
    E1M5: 'Phobos Lab',
    E1M6: 'Central Processing',
    E1M7: 'Computer Station',
    E1M8: 'Phobos Anomaly',
    E1M9: 'Military Base',
    E2M1: 'Deimos Anomaly',
    E2M2: 'Containment Area',
    E2M3: 'Refinery',
    E2M4: 'Deimos Lab',
    E2M5: 'Command Center',
    E2M6: 'Halls of the Damned',
    E2M7: 'Spawning Vats',
    E2M8: 'Tower of Babel',
    E2M9: 'Fortress of Mystery',
    E3M1: 'Hell Keep',
    E3M2: 'Slough of Despair',
    E3M3: 'Pandemonium',
    E3M4: 'House of Pain',
    E3M5: 'Unholy Cathedral',
    E3M6: 'Mt. Erebus',
    E3M7: 'Limbo',
    E3M8: 'Dis',
    E3M9: 'Warrens',
    E4M1: 'Hell Beneath',
    E4M2: 'Perfect Hatred',
    E4M3: 'Sever The Wicked',
    E4M4: 'Unruly Evil',
    E4M5: 'They Will Repent',
    E4M6: 'Against Thee Wickedly',
    E4M7: 'And Hell Followed',
    E4M8: 'Unto The Cruel',
    E4M9: 'Fear',
  },
  doom2: {
    MAP01: 'Entryway',
    MAP02: 'Underhalls',
    MAP03: 'The gantlet',
    MAP04: 'The focus',
    MAP05: 'The waste tunnels',
    MAP06: 'The crusher',
    MAP07: 'Dead simple',
    MAP08: 'Tricks and traps',
    MAP09: 'The pit',
    MAP10: 'Refueling base',
    MAP11: "'o' of destruction!",
    MAP12: 'The factory',
    MAP13: 'Downtown',
    MAP14: 'The inmost dens',
    MAP15: 'Industrial zone',
    MAP16: 'Suburbs',
    MAP17: 'Tenements',
    MAP18: 'The courtyard',
    MAP19: 'The citadel',
    MAP20: 'Gotcha!',
    MAP21: 'Nirvana',
    MAP22: 'The catacombs',
    MAP23: "Barrels o' fun",
    MAP24: 'The chasm',
    MAP25: 'Bloodfalls',
    MAP26: 'The abandoned mines',
    MAP27: 'Monster condo',
    MAP28: 'The spirit world',
    MAP29: 'The living end',
    MAP30: 'Icon of sin',
    MAP31: 'Wolfenstein',
    MAP32: 'Grosse',
  },
  plutonia: {
    MAP01: 'Congo',
    MAP02: 'Well of souls',
    MAP03: 'Aztec',
    MAP04: 'Caged',
    MAP05: 'Ghost town',
    MAP06: "Baron's lair",
    MAP07: 'Caughtyard',
    MAP08: 'Realm',
    MAP09: 'Abattoire',
    MAP10: 'Onslaught',
    MAP11: 'Hunted',
    MAP12: 'Speed',
    MAP13: 'The crypt',
    MAP14: 'Genesis',
    MAP15: 'The twilight',
    MAP16: 'The omen',
    MAP17: 'Compound',
    MAP18: 'Neurosphere',
    MAP19: 'Nme',
    MAP20: 'The death domain',
    MAP21: 'Slayer',
    MAP22: 'Impossible mission',
    MAP23: 'Tombstone',
    MAP24: 'The final frontier',
    MAP25: 'The temple of darkness',
    MAP26: 'Bunker',
    MAP27: 'Anti-christ',
    MAP28: 'The sewers',
    MAP29: 'Odyssey of noises',
    MAP30: 'The gateway of hell',
    MAP31: 'Cyberden',
    MAP32: 'Go 2 it',
  },
  tnt: {
    MAP01: 'System control',
    MAP02: 'Human bbq',
    MAP03: 'Power control',
    MAP04: 'Wormhole',
    MAP05: 'Hanger',
    MAP06: 'Open season',
    MAP07: 'Prison',
    MAP08: 'Metal',
    MAP09: 'Stronghold',
    MAP10: 'Redemption',
    MAP11: 'Storage facility',
    MAP12: 'Crater',
    MAP13: 'Nukage processing',
    MAP14: 'Steel works',
    MAP15: 'Dead zone',
    MAP16: 'Deepest reaches',
    MAP17: 'Processing area',
    MAP18: 'Mill',
    MAP19: 'Shipping/respawning',
    MAP20: 'Central processing',
    MAP21: 'Administration center',
    MAP22: 'Habitat',
    MAP23: 'Lunar mining project',
    MAP24: 'Quarry',
    MAP25: "Baron's den",
    MAP26: 'Ballistyx',
    MAP27: 'Mount pain',
    MAP28: 'Heck',
    MAP29: 'River styx',
    MAP30: 'Last call',
    MAP31: 'Pharaoh',
    MAP32: 'Caribbean',
  },
};

/**
 * The file names vanilla's own `D_IdentifyVersion` (`d_main.c`) looks for, each mapped to the title
 * table that IWAD's maps use. Matched on the **whole** name, never a substring —
 * docs/wad.md § Level names.
 */
const IWAD_MISSIONS: Record<string, LevelMission> = {
  'doom2f.wad': 'doom2',
  'doom2.wad': 'doom2',
  'plutonia.wad': 'plutonia',
  'tnt.wad': 'tnt',
  'doomu.wad': 'doom',
  'doom.wad': 'doom',
  'doom1.wad': 'doom',
};

/** Which title table an IWAD's file name selects, or null for anything unrecognised. */
export function missionOf(iwadFileName: string): LevelMission | null {
  return IWAD_MISSIONS[iwadFileName.toLowerCase()] ?? null;
}

/**
 * The graphic vanilla's intermission prints a level's name with, or undefined for a map name
 * outside both schemes. `WI_loadData` (`wi_stuff.c`) builds these itself: `CWILV%2.2d` over a
 * 0-based map index for DOOM II, `WILV%d%d` over 0-based episode and map otherwise — so `MAP07` is
 * `CWILV06` and `E1M1` is `WILV00`.
 */
export function levelNamePatch(mapName: string): string | undefined {
  const doom2 = /^MAP(\d\d)$/.exec(mapName);
  if (doom2) return `CWILV${String(Number(doom2[1]) - 1).padStart(2, '0')}`;
  const doom1 = /^E(\d)M(\d)$/.exec(mapName);
  if (doom1) return `WILV${Number(doom1[1]) - 1}${Number(doom1[2]) - 1}`;
  return undefined;
}

/**
 * The menu graphic naming the episode `mapName` belongs to (`M_EPI1`-`M_EPI4`, `m_menu.c`'s own
 * `EpiDef` patches), or undefined for a map outside the `E<x>M<y>` scheme. The episode's *name*
 * exists nowhere as a string in vanilla — only as these four graphics — which is why the end card
 * blits one rather than printing a title (docs/hud.md § End card).
 */
function episodeNamePatch(mapName: string): string | undefined {
  const doom1 = /^E(\d)M\d$/.exec(mapName);
  return doom1 ? `M_EPI${doom1[1]}` : undefined;
}

/**
 * Strips a `level 1:`, `MAP01:` or `E1M1:` identifier and capitalizes what is left — the two edits
 * `LEVEL_NAMES` was generated with (see its own doc), applied to a title arriving from somewhere
 * else so the two read alike. A value naming none of the three prefixes is kept verbatim:
 * EPIC.WAD's `1 - a fool's paradise` carries no level identifier at all.
 */
export function stripTitlePrefix(text: string): string {
  const bare = text.replace(/^\s*(?:level\s+\d+|MAP\d{1,2}|E\dM\d)\s*:\s*/i, '').trim();
  return bare ? bare[0].toUpperCase() + bare.slice(1) : bare;
}

/** Everything the two resolvers below need about one map, gathered from the loaded WAD set. */
export interface LevelNameSources {
  /** The map's `levelname` from a MAPINFO/UMAPINFO lump, if any file in the set defines one. */
  mapInfoTitle?: string;
  /** The map's title from a DEHACKED/BEX patch in the set — docs/dehacked.md § Strings. */
  dehTitle?: string;
  /** The loaded IWAD's mission, or null if its file name wasn't recognised. */
  mission: LevelMission | null;
  /** File name of the WAD that actually provides this map's lumps. */
  providerName?: string;
  /** Whether that file is a PWAD — an add-on's map is not the IWAD's level of the same name. */
  providerIsPwad: boolean;
}

/**
 * The level's own title, or undefined if nothing knows one: what the WAD set's MAPINFO says, else
 * what a DEHACKED patch says, else the vanilla title — but the vanilla one only for a map the
 * *IWAD* provides, since a PWAD's `MAP01` is a different level from the IWAD's and would otherwise
 * inherit its name.
 *
 * MAPINFO beats DEHACKED, as UMAPINFO's own spec says it does. The "IWAD-provided only" guard is
 * on the vanilla table alone: a DEH title, like a MAPINFO title, applies to any map, because
 * renaming the base game's levels is exactly what such a patch is for.
 */
export function levelTitleFor(mapName: string, sources: LevelNameSources): string | undefined {
  if (sources.mapInfoTitle) return sources.mapInfoTitle;
  if (sources.dehTitle) return sources.dehTitle;
  if (!sources.providerIsPwad && sources.mission) return LEVEL_NAMES[sources.mission][mapName];
  return undefined;
}

/**
 * The mnemonic-keyed half of a DEHACKED patch's strings, projected onto map lump names: `HUSTR_1`
 * is `MAP01` but only under DOOM II, `PHUSTR_*` only under Plutonia, `THUSTR_*` only under TNT,
 * `HUSTR_E1M1` only under DOOM. Titles arrive carrying id's own `level 1: ` / `E1M1: ` prefix, so
 * each is put through `stripTitlePrefix` to read like `LEVEL_NAMES`' own bare values.
 *
 * Keys that are already lump names pass straight through: that is how a vanilla `Text`
 * substitution arrives, having been resolved to its map by `titleLookupFor` at parse time.
 *
 * A null mission would otherwise drop every title, which is the case a PWAD lands in whenever the
 * IWAD's file name isn't one `missionOf` knows — so `HUSTR_*` is accepted there too rather than
 * throwing away the only titles the set has.
 */
export function dehTitlesFor(
  mission: LevelMission | null,
  strings: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of strings) {
    const map = dehTitleKey(key, mission);
    if (map) out.set(map, stripTitlePrefix(value));
  }
  return out;
}

/**
 * A file's level titles: what its own MAPINFO defines, and where that names nothing, what its
 * DEHACKED patch names. **The patch fills gaps, it never overwrites** — the same order
 * `levelTitleFor` applies in-game, stated here once so the menu's uploaded files and the
 * build-time manifest cannot name the same level differently.
 *
 * The mission is projected from the file's own name, which for an IWAD is exactly the mission
 * (`plutonia.wad` picks its `PHUSTR_*` set) and for a PWAD is the plain `HUSTR_*` one.
 * docs/wad.md § Level names.
 */
export function mergeLevelTitles(
  fileName: string,
  mapInfoTitles: Iterable<readonly [string, string]>,
  patchStrings?: ReadonlyMap<string, string>,
): Record<string, string> {
  const levelNames: Record<string, string> = {};
  for (const [map, title] of mapInfoTitles) levelNames[map] = title;
  if (patchStrings) {
    for (const [map, title] of dehTitlesFor(missionOf(fileName), patchStrings)) levelNames[map] ??= title;
  }
  return levelNames;
}

/** Which map lump a `[STRINGS]` mnemonic names under this mission, or undefined for none. */
function dehTitleKey(key: string, mission: LevelMission | null): string | undefined {
  if (/^(MAP\d\d|E\dM\d)$/.test(key)) return key;
  const commercial = /^(P|T)?HUSTR_(\d{1,2})$/.exec(key);
  if (commercial) {
    const want = commercial[1] === 'P' ? 'plutonia' : commercial[1] === 'T' ? 'tnt' : 'doom2';
    // An unrecognised IWAD keeps the plain `HUSTR_*` set, which is the only one it could mean.
    if (mission !== want && !(mission === null && want === 'doom2')) return undefined;
    return `MAP${commercial[2].padStart(2, '0')}`;
  }
  const episodic = /^HUSTR_(E\dM\d)$/.exec(key);
  if (episodic && (mission === 'doom' || mission === null)) return episodic[1];
  return undefined;
}

/**
 * The reverse lookup a vanilla `Text` substitution needs: a normalized level title back to the map
 * lump that carries it. Built over every mission rather than just the loaded one — a `Text` record
 * names no mission, and the four tables' titles don't collide.
 */
export function titleLookupFor(): (title: string) => string | undefined {
  // Built once: `LEVEL_NAMES` is a fixed table, so the index over it never changes. A library scan
  // asks for this per DEH-carrying file (`wad/describe.ts`), which is what made the rebuild show.
  lookup ??= (() => {
    const byTitle = new Map<string, string>();
    for (const table of Object.values(LEVEL_NAMES)) {
      for (const [map, title] of Object.entries(table)) {
        const key = stripTitlePrefix(title).toLowerCase();
        if (!byTitle.has(key)) byTitle.set(key, map);
      }
    }
    return (title: string) => byTitle.get(stripTitlePrefix(title).toLowerCase());
  })();
  return lookup;
}

let lookup: ((title: string) => string | undefined) | null = null;

/**
 * What the level card announces on entering a map: its title where one is known, otherwise — for a
 * map a PWAD supplied — which file it came from, and finally the bare lump name.
 */
export function levelNameFor(mapName: string, sources: LevelNameSources): string {
  const title = levelTitleFor(mapName, sources);
  if (title) return title;
  if (sources.providerIsPwad && sources.providerName) return `${sources.providerName} ${mapName}`;
  return mapName;
}

/**
 * Names the levels of one loaded WAD set. Built once per `Game` (the IWAD identification depends on
 * the file set, not on which map is loaded) and asked per map load.
 */
export class LevelNames {
  private wad: Wad;
  private titles: Map<string, string>;
  private dehTitles: Map<string, string>;
  private mission: LevelMission | null;

  constructor(wad: Wad, mapInfo: MapInfo, dehStrings?: ReadonlyMap<string, string> | null) {
    this.wad = wad;
    this.titles = mapInfo.titles();
    const iwad = wad.files.find((f) => f.type === 'IWAD');
    this.mission = iwad ? missionOf(iwad.name) : null;
    // Projected here rather than by the caller: which mnemonics apply depends on the mission,
    // which is identified two lines up and nowhere else.
    this.dehTitles = dehTitlesFor(this.mission, dehStrings ?? new Map());
  }

  /**
   * Which title table this set's IWAD selected, or null for an unrecognised one. Exposed because
   * par times key off the same identification (docs/wad.md § Par times) and identifying the IWAD
   * twice is how the two would drift.
   */
  get levelMission(): LevelMission | null {
    return this.mission;
  }

  nameFor(mapName: string): string {
    const upper = mapName.toUpperCase();
    const provider = this.wad.providerOf(upper);
    return levelNameFor(upper, {
      mapInfoTitle: this.titles.get(upper),
      dehTitle: this.dehTitles.get(upper),
      mission: this.mission,
      providerName: provider?.name,
      providerIsPwad: provider?.type === 'PWAD',
    });
  }

  /**
   * The `CWILV`/`WILV` lump to show instead of `nameFor`'s text, when the set has one that
   * actually belongs to this map — the level's name as the WAD's own artist drew it beats anything
   * assembled from a table.
   *
   * A patch from a *different* file than the map only counts when the map came from the IWAD,
   * which is what keeps a PWAD's `MAP01` from announcing itself with the IWAD's `CWILV00`.
   * docs/wad.md § Level names.
   */
  graphicFor(mapName: string): string | undefined {
    return this.patchFor(mapName, levelNamePatch(mapName.toUpperCase()));
  }

  /**
   * The `M_EPI` graphic naming this map's episode, under the same provenance rule as `graphicFor`:
   * a PWAD's own `E1M8` must not announce itself with the IWAD's "Knee-Deep in the Dead". DOOM II's
   * IWAD carries `M_EPI1`-`M_EPI3` unused, which costs nothing here — no `MAP<nn>` has an episode
   * to ask about. docs/hud.md § End card.
   */
  episodeGraphicFor(mapName: string): string | undefined {
    return this.patchFor(mapName, episodeNamePatch(mapName.toUpperCase()));
  }

  /**
   * The shared half of the two lookups above: the patch, if the set has it and it belongs to this
   * map.
   */
  private patchFor(mapName: string, patch: string | undefined): string | undefined {
    const lump = patch ? this.wad.find(patch) : undefined;
    if (!lump) return undefined;
    const provider = this.wad.providerOf(mapName.toUpperCase());
    if (provider?.type === 'PWAD' && lump.source !== provider) return undefined;
    return patch;
  }
}
