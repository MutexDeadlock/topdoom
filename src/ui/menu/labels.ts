/**
 * The strings the menu labels its WAD and level rows with, plus the spans the two WAD lists render
 * them as. Pure formatting over what `wad/library.ts` already resolved — no WAD is read here.
 * See docs/menu.md.
 */
import type { MergedMap, WadSource } from '../../wad/library.ts';
import { describeSupport, supportLevel, type SupportLevel } from '../../wad/support.ts';

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
 *
 * The support verdict is deliberately **not** one of these: it is a coloured glyph, not text, and
 * the `<select>` holds only text. A game WAD's verdict is on its WAD Library row instead.
 */
export interface SourceColumns {
  size: string;
  /** What the file actually contains: its maps, or its lump count when it has none. */
  content: string;
  /**
   * `DEH` or empty — abbreviated because the column is worth a hint, not a whole spelled-out
   * word of row width; `sourceColumnSpans` puts the full name in its tooltip. Presence, not
   * coverage: what a patch lands needs its bytes, and the menu lists a server file from the
   * build-time manifest alone.
   * docs/dehacked.md § The coverage report.
   */
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
    dehacked: src.dehacked ? 'DEH' : '',
  };
}

/**
 * Whether this engine can run the file, as one glyph each — `U+FE0E` on all three, the same
 * text-presentation request the folder tree and the save list's wastebasket make, so they render in
 * the row's own colour rather than as colour emoji. `menu.css` gives each level its colour.
 */
const SUPPORT_GLYPHS: Record<SupportLevel, string> = {
  ok: '\u2714\uFE0E',
  partial: '\u26A0\uFE0E',
  broken: '\u2716\uFE0E',
};

/**
 * A file row's badge, in the two lists that render one: the WAD Library's file pane and the New
 * Game tab's narrower add-on list. `'reason'` is why the row can't be picked and is the one thing
 * worth interrupting for, so it is the only kind that carries the accent; `'quiet'` is an aside,
 * and the empty default is the spacer that keeps the columns behind it lined up.
 *
 * Here rather than at either call site for `sourceColumnSpans`' reason: the `badge`/`badge reason`
 * class names both `menu.css` and `library.css` target have one definition.
 */
export function badge(text: string, kind: '' | 'quiet' | 'reason' = ''): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = kind ? `badge ${kind} truncate` : 'badge truncate';
  span.textContent = text;
  return span;
}

/**
 * The info column's control, in the two lists that render one: a WAD shipped with a text file
 * beside it (`WadSource.textFile`) offers it here, anything else gets the empty span that keeps the
 * columns behind it lined up. A `<button>` inside the row's `<label>`, so the click has to be
 * stopped from reaching the row's own control — the same shape the add-on list's `×` has.
 */
function infoColumn(src: WadSource, onInfo?: (src: WadSource) => void): HTMLElement {
  const text = src.textFile;
  if (!text || !onInfo) return metaSpan('info', '');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meta info';
  // The circled `i`, `U+24D8`, and not `U+2139`: that one has an emoji presentation to be talked
  // out of (`U+FE0E`, as the support glyphs do) and still renders as a bare letter when it is.
  button.textContent = '\u24D8';
  button.title = `Read ${text.name}`;
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onInfo(src);
  });
  return button;
}

/** One fixed-width detail column. The class name is what both stylesheets target. */
function metaSpan(kind: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `meta ${kind} truncate`;
  span.textContent = text;
  return span;
}

/**
 * The same five columns as finished spans, for the two lists that give each its own space — the
 * WAD Library's file pane and the New Game tab's narrower add-on list. Built here rather than at
 * either call site so the `meta size`/`meta content`/`meta deh`/`meta info`/`meta support` class
 * names the two stylesheets target have one definition, and a sixth column costs one edit.
 *
 * The support glyph is **last**, at the far right, and is the one column that can be blank: a
 * source carrying no verdict says nothing rather than claiming the file is fine
 * (docs/wad.md § Will it run?). The info column sits in front of it and takes `onInfo`, the one
 * column that is a control rather than a reading: without a handler it is a spacer, so a list that
 * has nowhere to open a text file simply doesn't offer one.
 */
export function sourceColumnSpans(src: WadSource, onInfo?: (src: WadSource) => void): HTMLElement[] {
  const { size, content, dehacked } = sourceColumns(src);
  const support = metaSpan('support', '');
  if (src.support) {
    const level = supportLevel(src.support);
    // Repeats `truncate` because this overwrites what metaSpan set, glyph and all.
    support.className = `meta support ${level} truncate`;
    support.textContent = SUPPORT_GLYPHS[level];
    // The reasons and the maps that raise them, which is the whole point of the column: the glyph
    // says how bad, the tooltip says what and where.
    support.title = describeSupport(src.support, src.maps.length);
    support.setAttribute('role', 'img');
    support.setAttribute('aria-label', support.title);
  }
  const deh = metaSpan('deh', dehacked);
  if (dehacked) deh.title = 'Contains DEHACKED patch';
  return [metaSpan('size', size), metaSpan('content', content), deh, infoColumn(src, onInfo), support];
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
