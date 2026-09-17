/**
 * What a test driving `buildMoverMesh`/`refreshMoverMesh` by hand needs around it: every sidedef
 * textured, so the builder has quads to emit at all, and the four-field argument the builders take.
 * docs/render.md § Mover meshes, docs/testing.md § Shared helpers.
 */
import { buildSubSectorPolys } from '../../src/render/bsp.ts';
import { buildMoverIndex } from '../../src/game/specials/movergeometry.ts';
import type { MapMeshOptions } from '../../src/render/mapmesh.ts';
import type { DoomMap } from '../../src/wad/map.ts';
import { BANK } from './specialsrig.ts';

/**
 * Textures every slot of every sidedef. An unset slot draws no quad at all, so a fixture that
 * leaves them alone gives the mesh builder nothing to build and a test about what it built passes
 * vacuously. Callers that care which slot drew pass their own names.
 */
export function textureEverySide(map: DoomMap, names: { upper?: string; lower?: string; middle?: string } = {}): void {
  const { upper = 'UPPER', lower = 'LOWER', middle = 'MIDDLE' } = names;
  for (const side of map.sidedefs) {
    side.upper = upper;
    side.lower = lower;
    side.middle = middle;
  }
}

/**
 * The argument `buildMoverMesh` and `refreshMoverMesh` take, over a map whose sidedefs are already
 * textured. `options` is merged onto `movableSectors: {sector}`, which is what makes the sector a
 * mover in the first place.
 */
export function moverSource(map: DoomMap, sector: number, options: MapMeshOptions = {}) {
  const polys = buildSubSectorPolys(map);
  return {
    map,
    polys,
    bank: BANK,
    options: { movableSectors: new Set([sector]), ...options },
    index: buildMoverIndex(map, polys),
  };
}
