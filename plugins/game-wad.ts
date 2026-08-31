import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { SHIPPED_GLDEFS, SHIPPED_SECRET, SHIPPED_WAD_PATH } from '../src/wad/shipped.ts';
import { WadFile } from '../src/wad/wad.ts';
import { writePwad, type LumpSource } from '../src/wad/write.ts';

/** The sources under `assets/`, in the order their lumps are written. */
const GLDEFS_FILE = 'gldefs.txt';
const SECRET_FILE = 'secret.ogg';
const SKINS_FILE = 'playerskins.wad';

function bytesOf(path: string): Uint8Array {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * The shipped WAD, from the three editable sources in `assets/`. The player art comes in whole —
 * its `S_START`..`S_END` block copied lump for lump, in file order — because that block is what
 * `SpriteBank` indexes and the two text/sound lumps must stay outside it.
 *
 * Nothing here is cached: it is read once per build, and once per request in dev, where re-reading
 * is what makes an edited `gldefs.txt` show up on reload.
 */
export function buildGameWad(root = 'assets'): Uint8Array {
  const skins = bytesOf(join(root, SKINS_FILE));
  const file = new WadFile(skins.buffer.slice(skins.byteOffset, skins.byteOffset + skins.byteLength) as ArrayBuffer, SKINS_FILE);

  const lumps: LumpSource[] = [
    { name: SHIPPED_GLDEFS, bytes: bytesOf(join(root, GLDEFS_FILE)) },
    { name: SHIPPED_SECRET, bytes: bytesOf(join(root, SECRET_FILE)) },
    ...file.entries.map((entry) => ({ name: entry.name, bytes: skins.subarray(entry.offset, entry.offset + entry.size) })),
  ];
  return writePwad(lumps);
}

/**
 * Publishes `assets/` as the one WAD the engine fetches at startup (`wad/shipped.ts`). Served live
 * in dev, baked into the output on build — so the sources stay editable text and audio rather than
 * a committed binary. See docs/wad.md § The WAD the engine ships.
 */
export function gameWad(root = 'assets'): Plugin {
  return {
    name: 'topdoom:game-wad',

    configureServer(server) {
      // Registered here, so it runs before Vite's static handler would 404.
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/' + SHIPPED_WAD_PATH) return next();
        try {
          const wad = buildGameWad(root);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.end(Buffer.from(wad.buffer, wad.byteOffset, wad.byteLength));
        } catch (err) {
          next(err);
        }
      });
    },

    generateBundle() {
      this.emitFile({ type: 'asset', fileName: SHIPPED_WAD_PATH, source: buildGameWad(root) });
    },
  };
}
