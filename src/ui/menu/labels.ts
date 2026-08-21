/**
 * The strings the menu labels its WAD and level rows with, plus the spans the two WAD lists render
 * them as. Pure formatting over what `wad/library.ts` already resolved — no WAD is read here.
 * See docs/menu.md.
 */
import type { MergedMap, WadSource } from '../../wad/library.ts';

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * The three things a WAD row says about a file, kept apart so the two lists that have room for
 * columns can line them up down the list (docs/menu.md § WAD Library) — `sourceColumnSpans` below
 * is what renders them. `describeSource` joins the same values into one line for the IWAD select,
 * which has room for nothing else, so the two can't disagree about what a file is — only about how
 * much room there is to say it.
 */
export interface SourceColumns {
  size: string;
  /** What the file actually contains: its maps, or its lump count when it has none. */
  content: string;
  /** `DEHACKED` or empty. Presence, not coverage: what a patch lands needs its bytes, and the menu
      lists a server file from the build-time manifest alone. docs/dehacked.md § The coverage report. */
  dehacked: string;
}

export function sourceColumns(src: WadSource): SourceColumns {
  return {
    size: formatSize(src.size),
    content:
      src.maps.length > 0
        ? src.maps.length === 1
          ? src.maps[0]
          : `${src.maps.length} maps`
        : // No maps of its own (a texture/sound add-on) — the lump count is the
          // only sign there's actually something in the file.
          `${src.lumpCount} lump${src.lumpCount === 1 ? '' : 's'}`,
    dehacked: src.dehacked ? 'DEHACKED' : '',
  };
}

/**
 * The same three columns as finished spans, for the two lists that give each its own space — the
 * WAD Library's file pane and the New Game tab's narrower add-on list. Built here rather than at
 * either call site so the `meta size`/`meta content`/`meta deh` class names the two stylesheets
 * target have one definition, and a fourth column costs one edit.
 */
export function sourceColumnSpans(src: WadSource): HTMLSpanElement[] {
  const { size, content, dehacked } = sourceColumns(src);
  return [
    ['size', size],
    ['content', content],
    ['deh', dehacked],
  ].map(([kind, text]) => {
    const span = document.createElement('span');
    span.className = `meta ${kind}`;
    span.textContent = text;
    return span;
  });
}

/** A WAD row's detail line, joined, for the one place too narrow to give each column its own space:
    the IWAD `<select>`, whose options can hold only text. */
export function describeSource(src: WadSource): string {
  const { size, content, dehacked } = sourceColumns(src);
  const parts = [size, src.maps.length > 0 ? content : `no maps (${content})`];
  if (dehacked) parts.push(dehacked);
  // What the file *is*, never where it sits: a library file's folder is already the row it was
  // found under (docs/menu.md § WAD Library), and repeating it in every detail line only crowds
  // the column. An upload belongs to no folder at all, so that one note stays.
  if (src.origin === 'upload') parts.push('from disk');
  return parts.join(' · ');
}

/**
 * How a map is named wherever it is listed — the level select and the save rows,
 * which must agree. Lump name first: it's what the level is picked by, and the
 * only thing every map has. Then its title where the WAD set knows one
 * (docs/wad.md § Level names), and the provider only when an add-on took the map
 * over.
 */
export function describeMap(map: MergedMap, iwadLabel: string): string {
  const parts = [map.name];
  if (map.title) {
    parts.push(map.title);
  } else if (map.provider !== iwadLabel) {
    parts.push(map.provider);
  }
  return parts.join('  —  ');
}
