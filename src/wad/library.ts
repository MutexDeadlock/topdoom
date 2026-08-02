import { WadFile, type WadType } from './wad.ts';

const MANIFEST_URL = '/wads/index.json';

/**
 * A WAD the menu can offer, whether it sits on the server or was picked from
 * the user's disk. Bytes are only pulled in when something actually needs them.
 */
export interface WadSource {
  /** Stable id used in the UI and in ?wad= / ?pwad= parameters. */
  key: string;
  label: string;
  type: WadType;
  /** Map markers this file defines. */
  maps: string[];
  /** Total lump count — shown for map-less add-ons so they don't look empty. */
  lumpCount: number;
  size: number;
  origin: 'server' | 'upload';
  bytes(): Promise<ArrayBuffer>;
}

type WadFolder = 'iwad' | 'pwad';

interface ManifestEntry {
  file: string;
  folder: WadFolder;
  size: number;
  type: WadType;
  maps: string[];
  lumpCount: number;
}

/** Which DOOM's map-naming convention a WAD's maps follow, if any. */
export type MapStyle = 'doom1' | 'doom2' | null;

/**
 * DOOM names maps `E<episode>M<mission>`, DOOM II `MAP<nn>` — the two schemes
 * never mix within one game, so a WAD's own maps (if it has any) say which
 * game it belongs to. A WAD with no maps of its own (a texture/sound add-on)
 * has no style and is compatible with either.
 */
export function mapStyle(source: WadSource): MapStyle {
  if (source.maps.some((m) => /^E\dM\d$/.test(m))) return 'doom1';
  if (source.maps.some((m) => /^MAP\d\d$/.test(m))) return 'doom2';
  return null;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

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

/** Wraps a server-side file; the fetched bytes are kept so restarts are instant. */
function serverSource(entry: ManifestEntry): WadSource {
  let cached: Promise<ArrayBuffer> | null = null;
  return {
    key: entry.file,
    label: entry.file,
    type: entry.type,
    maps: entry.maps,
    lumpCount: entry.lumpCount,
    size: entry.size,
    origin: 'server',
    bytes() {
      cached ??= fetch(`/wads/${entry.folder}/${encodeURIComponent(entry.file)}`).then(async (res) => {
        if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
        return res.arrayBuffer();
      });
      return cached;
    },
  };
}

/** Parses an uploaded file far enough to categorise it, then keeps it in memory. */
export function uploadedSource(name: string, buffer: ArrayBuffer): WadSource {
  const file = new WadFile(buffer, name);
  return {
    key: `upload:${name}:${buffer.byteLength}`,
    label: name,
    type: file.type,
    maps: file.mapNames(),
    lumpCount: file.entries.length,
    size: buffer.byteLength,
    origin: 'upload',
    bytes: () => Promise.resolve(buffer),
  };
}

/** WADs the server offers under public/wads/. Empty if the manifest is missing. */
export async function fetchLibrary(): Promise<WadSource[]> {
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) return [];
    const entries = (await res.json()) as ManifestEntry[];
    if (!Array.isArray(entries)) return [];
    return entries.map(serverSource);
  } catch {
    return [];
  }
}

/**
 * Map list for an IWAD plus its add-ons: the IWAD's own maps in order, then any
 * extra maps a PWAD introduces. Each map is attributed to the file that wins.
 */
export function mergedMaps(iwad: WadSource, pwads: WadSource[]): { name: string; provider: string }[] {
  const provider = new Map<string, string>();
  for (const map of iwad.maps) provider.set(map, iwad.label);

  const order = [...iwad.maps];
  for (const pwad of pwads) {
    for (const map of pwad.maps) {
      if (!provider.has(map)) order.push(map);
      provider.set(map, pwad.label);
    }
  }
  return order.map((name) => ({ name, provider: provider.get(name)! }));
}

/** Loads the selected files in the order the engine has to merge them. */
export async function loadWadFiles(iwad: WadSource, pwads: WadSource[]): Promise<WadFile[]> {
  const sources = [iwad, ...pwads];
  const buffers = await Promise.all(sources.map((s) => s.bytes()));
  return sources.map((s, i) => new WadFile(buffers[i], s.label));
}
