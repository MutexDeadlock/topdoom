import type { Plugin } from 'vite';

/** What a manifest plugin brings of its own: where it is served from, and what it lists. */
export interface ManifestPlugin {
  /** Vite's plugin name, `topdoom:`-prefixed. */
  name: string;
  /** Where the JSON is served and emitted, relative to `public/` and without a leading slash. */
  path: string;
  /** The listing itself, rebuilt per request in dev so an edited folder shows up on reload. */
  scan(): unknown;
}

/**
 * A folder's listing published as JSON: served live in dev, baked into the output on build. The two
 * halves are one plugin because a manifest served from one path while the menu fetches another
 * lists files it cannot load — docs/wad.md § The `public/game/` manifest.
 */
export function jsonManifest(plugin: ManifestPlugin): Plugin {
  const { name, path, scan } = plugin;
  return {
    name,

    configureServer(server) {
      // Registered here, so it runs before Vite's static handler would 404.
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/' + path) return next();
        void Promise.resolve(scan()).then((entries) => {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(entries));
        }, next);
      });
    },

    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: path, source: JSON.stringify(await scan()) });
    },
  };
}

/**
 * A per-file memo keyed on the file's mtime and size, which a scan's own `statSync` already has.
 * The dev middleware re-scans on *every* request for the manifest, and describing a file means
 * reading it whole; editing one still re-describes it, reloading the page no longer does.
 *
 * Whatever `describe` hands over is what is kept, a *promise* included: two overlapping requests
 * for the manifest would otherwise both miss and describe every file twice.
 */
export function statMemo<T>(): (path: string, stat: FileStat, describe: () => T) => T {
  const described = new Map<string, FileStat & { value: T }>();
  return (path, stat, describe) => {
    const hit = described.get(path);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
    const value = describe();
    described.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  };
}

/** As much of `node:fs`'s `Stats` as the memo reads. */
interface FileStat {
  mtimeMs: number;
  size: number;
}
