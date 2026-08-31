import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { SHIPPED_GLDEFS, SHIPPED_SECRET, SHIPPED_WAD_PATH } from '../src/wad/shipped.ts';
import { Wad, WadFile } from '../src/wad/wad.ts';
import { writePwad, type LumpSource } from '../src/wad/write.ts';

/** Node pools small reads into a shared buffer, which `WadFile` must never be handed. */
function readBytes(path: string): Uint8Array {
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
  const skins = new Wad(new WadFile(readBytes(join(root, 'playerskins.wad')).slice().buffer, 'playerskins.wad'));
  return writePwad([
    { name: SHIPPED_GLDEFS, bytes: readBytes(join(root, 'gldefs.txt')) },
    { name: SHIPPED_SECRET, bytes: readBytes(join(root, 'secret.ogg')) },
    ...skins.lumps.map((lump): LumpSource => ({ name: lump.name, bytes: skins.data(lump) })),
  ]);
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
      // Registered in `configureServer` for the reason `wad-manifest.ts` gives.
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
