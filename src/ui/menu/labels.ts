/**
 * The one-line strings the menu labels its WAD and level rows with. Pure formatting over what
 * `wad/library.ts` already resolved — no WAD is read here. See docs/menu.md.
 */
import type { MergedMap, WadSource } from '../../wad/library.ts';

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** A WAD row's detail line: size, then what the file actually contains, then where it came from. */
export function describeSource(src: WadSource): string {
  const parts = [formatSize(src.size)];
  if (src.maps.length > 0) {
    parts.push(src.maps.length === 1 ? src.maps[0] : `${src.maps.length} maps`);
  } else {
    // No maps of its own (a texture/sound add-on) — the lump count is the
    // only sign there's actually something in the file.
    parts.push(`no maps (${src.lumpCount} lump${src.lumpCount === 1 ? '' : 's'})`);
  }
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
