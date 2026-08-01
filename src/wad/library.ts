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
    parts.push('no maps');
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
