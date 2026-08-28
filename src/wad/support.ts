/**
 * Whether this engine can actually run what a file ships — the verdict the WAD Library's support
 * column shows. Decided from the lump directory alone, so a file can be judged without being
 * loaded and a whole library folder without being read.
 * See docs/wad.md § Will it run?
 */
import { MAP_LUMPS } from './map.ts';

/** Green, amber, red: it runs, some of it doesn't play right, some of it won't load at all. */
export type SupportLevel = 'ok' | 'partial' | 'broken';

/** Every reason a file is not `ok`. `SUPPORT_ISSUES` says what each one costs and how badly. */
export type SupportCode = 'udmf' | 'noBsp' | 'incomplete' | 'hexen' | 'dehacked';

/**
 * One reason, and the maps that raise it — empty for a file-level reason, which is only `dehacked`.
 */
export interface SupportIssue {
  code: SupportCode;
  maps: string[];
}

/**
 * A file's verdict: every reason it is not fully supported, worst first, and empty when it is.
 *
 * **The level is derived, never stored** (`supportLevel`). This is what both persisted copies hold
 * (`ManifestEntry.support`, `LibraryDescriptor.support`), so a stored level would be a second
 * source of truth that a row written today keeps asserting after `SUPPORT_ISSUES` reclassifies a
 * code — and one a damaged record could contradict outright.
 */
export type WadSupport = SupportIssue[];

/**
 * What each reason costs, and the sentence the tooltip states it in. **Worst first** — the order
 * here is the order `wadSupport` reports issues in, and the `broken` block ends where `hexen`
 * starts.
 *
 * A `broken` map is one `loadMap` cannot produce geometry for: it yields an empty world, which is
 * a level with no floor to stand on. A `partial` one loads and plays, but not the way its author
 * built it.
 */
export const SUPPORT_ISSUES: Record<SupportCode, { level: Exclude<SupportLevel, 'ok'>; text: string }> = {
  udmf: { level: 'broken', text: 'built in UDMF (a TEXTMAP lump), which this engine does not read' },
  noBsp: { level: 'broken', text: 'no BSP nodes — the map expects the port to build them at load' },
  incomplete: { level: 'broken', text: 'missing the map lumps a level is made of' },
  hexen: { level: 'partial', text: 'Hexen format: its doors, lifts, switches and ACS scripts do not run' },
  dehacked: {
    level: 'partial',
    text: 'a DEHACKED patch asking for thing flags or a branching action this engine does not apply',
  },
};

const SUPPORT_ORDER = Object.keys(SUPPORT_ISSUES) as SupportCode[];

/**
 * How bad the worst of them is — the glyph, the colour and the tooltip's headline all key off this.
 */
export function supportLevel(support: WadSupport): SupportLevel {
  if (support.some((issue) => SUPPORT_ISSUES[issue.code].level === 'broken')) return 'broken';
  return support.length > 0 ? 'partial' : 'ok';
}

/**
 * What one map group looks like to this check: the sizes of the lumps that follow its marker.
 * Deliberately not the lumps themselves — the caller reads a directory off a file it will never
 * load, and the sizes are everything the verdict needs from it.
 */
export interface MapLumpSummary {
  name: string;
  /** Lump name to size, for the lumps in `MAP_GROUP_LUMPS` that follow this map's marker. */
  lumps: ReadonlyMap<string, number>;
}

/**
 * The lumps that count as part of a map's group while scanning a directory. `MAP_LUMPS` is what
 * `loadMap` itself reads; the rest are the lumps a UDMF map carries instead, listed here only so
 * the walk keeps stepping over them and reaches `TEXTMAP` rather than reporting a map with no
 * lumps at all.
 */
export const MAP_GROUP_LUMPS: ReadonlySet<string> = new Set([
  ...MAP_LUMPS,
  'TEXTMAP',
  'ENDMAP',
  'ZNODES',
  'DIALOGUE',
  'SCRIPTS',
]);

/** The lumps a level is made of: without any one of them there is nothing to walk around in. */
const REQUIRED_LUMPS = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SECTORS'];

/**
 * The verdict for one file. `dehShortfall` is its `DEHACKED` patch having asked for something this
 * engine deliberately does not apply (`DehSupport`'s `unsupported`) — the MBF thing flags, a
 * re-keyed `ID #`, `A_RandomJump`: things that change how a thing behaves rather than how it reads.
 * `noTarget` and `unknown` are **not** counted: the first is a finale screen or a pickup message,
 * the second a line the parser didn't recognise, and neither changes how the level plays.
 *
 * Pure, so it is testable without a WAD — the reading is `describe.ts`'s.
 */
export function wadSupport(maps: readonly MapLumpSummary[], dehShortfall: boolean): WadSupport {
  const byCode = new Map<SupportCode, string[]>();
  /** The maps raising `code`, created on first mention — empty for a file-level reason. */
  const at = (code: SupportCode): string[] => {
    let maps = byCode.get(code);
    if (!maps) byCode.set(code, (maps = []));
    return maps;
  };

  for (const map of maps) {
    const broken = brokenIssue(map);
    if (broken) at(broken).push(map.name);
    // `map.ts: loadMap` owns the BEHAVIOR-means-Hexen rule and its citation. Only raised on a
    // map that loads: a map that doesn't has already said the worse thing about itself.
    else if (map.lumps.has('BEHAVIOR')) at('hexen').push(map.name);
  }
  if (dehShortfall) at('dehacked');

  return SUPPORT_ORDER.filter((code) => byCode.has(code)).map((code) => ({
    code,
    maps: byCode.get(code)!,
  }));
}

/**
 * Why one map won't load, or null when it will. First match wins: a UDMF map has no LINEDEFS
 * either, and reporting that instead would name the symptom rather than the format.
 */
function brokenIssue(map: MapLumpSummary): SupportCode | null {
  const size = (name: string) => map.lumps.get(name) ?? 0;
  if (map.lumps.has('TEXTMAP')) return 'udmf';
  if (REQUIRED_LUMPS.some((name) => size(name) === 0)) return 'incomplete';
  // Either lump alone is enough: the extended formats put the whole BSP in one of them and leave
  // the other empty — NODES for XNOD/ZNOD, SSECTORS for the GL family — and a map convex enough to
  // be one subsector has no NODES record to write (docs/wad.md § Node formats).
  if (size('NODES') === 0 && size('SSECTORS') === 0) return 'noBsp';
  return null;
}

/**
 * Whether the file has maps and **not one of them** will load — the WAD Library greys such a row
 * out, since picking it could only ever end at a level that isn't there (docs/menu.md § WAD
 * Library).
 *
 * Deliberately *not* `supportLevel(support) === 'broken'`. A megawad with one UDMF map among
 * thirty-one that work is `broken` and stays perfectly pickable: refusing the whole file over one
 * map would lock the player out of the rest of it. A file with no maps at all — a texture or sound
 * pack — has nothing to fail to load and is never refused, whatever its patch asks for.
 */
export function nothingLoads(support: WadSupport, mapCount: number): boolean {
  if (mapCount === 0) return false;
  // A count, not a set: `brokenIssue` returns the first matching code per map, so a map name
  // appears under exactly one broken issue and there is nothing to deduplicate.
  let refused = 0;
  for (const issue of support) {
    if (SUPPORT_ISSUES[issue.code].level === 'broken') refused += issue.maps.length;
  }
  return refused >= mapCount;
}

/** How many map names a tooltip line spells out before it starts counting instead. */
const NAMED_MAPS = 8;

/**
 * The support column's tooltip: the verdict, then one line per reason naming the maps that raise
 * it. `mapCount` is the file's own map count, which is what decides whether the headline says
 * *some* maps or all of them.
 */
export function describeSupport(support: WadSupport, mapCount: number): string {
  const level = supportLevel(support);
  if (level === 'ok') return 'Fully supported';

  // "Some maps" only when the reasons actually single maps out and leave others alone: a file-level
  // reason (a DEHACKED patch) is about the whole WAD however few maps it ships.
  const affected = new Set(support.flatMap((issue) => issue.maps));
  const subject = affected.size > 0 && affected.size < mapCount ? 'Some maps ' : 'This WAD ';
  const head = subject + (level === 'broken' ? 'will not load' : 'may not play as intended');

  const lines = support.map((issue) => {
    const { text } = SUPPORT_ISSUES[issue.code];
    if (issue.maps.length === 0) return `• ${text}`;
    const named = issue.maps.slice(0, NAMED_MAPS).join(', ');
    const rest = issue.maps.length - NAMED_MAPS;
    return `• ${named}${rest > 0 ? ` and ${rest} more` : ''}: ${text}`;
  });
  return [head, ...lines].join('\n');
}

/**
 * A stored verdict read back, or `undefined` when it isn't one — the `besttimes.ts` shape the
 * library memo validates everything else with (`library/store.ts`). Absent is *unknown*, never
 * "supported" (docs/wad.md § Will it run?).
 */
export function asWadSupport(value: unknown): WadSupport | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: SupportIssue[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const issue = raw as Record<string, unknown>;
    if (typeof issue.code !== 'string' || !(issue.code in SUPPORT_ISSUES)) return undefined;
    if (!Array.isArray(issue.maps) || issue.maps.some((m) => typeof m !== 'string')) return undefined;
    issues.push({ code: issue.code as SupportCode, maps: issue.maps as string[] });
  }
  return issues;
}
