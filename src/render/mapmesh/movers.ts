/**
 * One moving sector's own mesh, built and then refreshed in place while it runs — the geometry the
 * static batches leave out. See docs/render.md § Mover meshes.
 */
import { markRelit, relightRange, type Build } from './build.ts';
import type { MoverIndex, MoverMesh, WallOccluder } from './defs.ts';
import { beginHoleFills, closedHoleFill, flatArt, flatSpecs, flatSpecsOf, processFlat } from './flats.ts';
import { processLine } from './walls.ts';

/**
 * What one fan of a refreshed mover is to be moved to — `planFlatRefresh` decides it,
 * `applyFlatRefresh` writes it.
 */
interface FlatPlan {
  height: number;
  light: number;
  lightSector: number;
}

/** `planFlatRefresh`'s output, reused: a mover refresh happens per moving sector per frame. */
const flatPlan: FlatPlan[] = [];

/**
 * Whether a mover's flats can be moved in place, and where to — one entry per `mesh.flatFans`;
 * null is a refusal. A tic can lift a fan's plane and relight it but never change its footprint,
 * so the specs are re-decided without emitting geometry and matched against the fans the mesh
 * holds. docs/render.md § Mover meshes.
 */
export function planFlatRefresh(build: Build, mesh: MoverMesh, sectorIndex: number, index: MoverIndex): FlatPlan[] | null {
  const fans = mesh.flatFans;
  beginHoleFills(build);
  let at = 0;
  for (const ss of index.subsectorsOf(sectorIndex)) {
    const count = flatSpecsOf(build, build.polys[ss], ss, closedHoleFill(ss), flatSpecs);
    // A leaf too degenerate to have produced a vertex produced no fan either, and never will.
    // `buildMoverFlats` appended the rest in this same order.
    if (fans[at]?.subsector !== ss) continue;
    for (let i = 0; i < count; i++) {
      const spec = flatSpecs[i];
      if (!flatArt(spec.kind, spec.texName, build.size)) continue;
      const fan = fans[at];
      if (
        fan === undefined ||
        fan.subsector !== ss ||
        fan.texName !== spec.texName ||
        fan.isCeiling !== spec.isCeiling ||
        fan.baseAlpha !== spec.baseAlpha
      ) {
        return null;
      }
      const plan = (flatPlan[at] ??= { height: 0, light: 0, lightSector: 0 });
      plan.height = spec.height;
      plan.light = spec.light;
      plan.lightSector = spec.lightSector;
      at++;
    }
    // A fan of this leaf the specs did not account for: the set changed, which is a refusal.
    if (fans[at]?.subsector === ss) return null;
  }
  return at === fans.length ? flatPlan : null;
}

/** `applyFlatRefresh`'s set of keys to re-upload — module scratch, one mover refresh at a time. */
const touchedFlatKeys = new Set<string>();

/** Lifts every fan of a refreshed mover to the plane and colour `planFlatRefresh` settled on. */
export function applyFlatRefresh(mesh: MoverMesh, plan: FlatPlan[]): void {
  const touched = touchedFlatKeys;
  touched.clear();
  for (let i = 0; i < mesh.flatFans.length; i++) {
    const fan = mesh.flatFans[i];
    const { height, light, lightSector } = plan[i];
    fan.lightSector = lightSector;
    // Nothing moved and nothing relit — the common case for a mover's ceiling while its floor
    // runs. Both halves read the fan's own record, before the mesh is looked up at all.
    if (fan.height === height && fan.light === light) continue;
    const geom = mesh.meshes.get(fan.key)?.geometry;
    if (!geom) continue;
    const pos = geom.getAttribute('position').array as Float32Array;
    fan.height = height;
    fan.light = light;
    const end = fan.vertexStart + fan.vertexCount;
    // Only the plane: x and z are the footprint, which never moves.
    for (let v = fan.vertexStart; v < end; v++) pos[v * 3 + 1] = height;
    relightRange(geom, fan.vertexStart, fan.vertexCount, light);
    touched.add(fan.key);
  }
  for (const key of touched) {
    const geom = mesh.meshes.get(key)!.geometry;
    geom.getAttribute('position').needsUpdate = true;
    markRelit(geom);
    geom.computeBoundingSphere();
  }
}

/**
 * Copies a rebuilt quad over the live one, preserving what a rebuild cannot know: a mover changes
 * heights, never a footprint, so `subsector` keeps the leaf the build-time probe resolved rather
 * than the -1 `buildMoverWalls` emits — re-probing would be a BSP descent per quad per
 * refresh. Same rule as `aLightCell` above, stated here so the next footprint-fixed field on
 * `WallOccluder` is
 * handled where the exception already lives.
 */
export function copyRefreshedQuad(dst: WallOccluder, src: WallOccluder): void {
  const subsector = dst.subsector;
  Object.assign(dst, src);
  dst.subsector = subsector;
}

/**
 * The flat half of a mover's geometry: its own sector's leaves, lids included. A refresh
 * re-decides these without emitting any (`planFlatRefresh`), because a mover changes a flat's
 * plane and its light but never its footprint — docs/render.md § Mover meshes.
 */
export function buildMoverFlats(build: Build, sectorIndex: number, index: MoverIndex): void {
  // No `movableSectors` here on purpose: a mover is rebuilt alongside its
  // movable neighbours, so its lids cannot go stale against one.
  beginHoleFills(build);
  for (const ss of index.subsectorsOf(sectorIndex)) processFlat(build, build.polys[ss], ss, closedHoleFill(ss));
}

/**
 * The wall half, alone — the half `refreshMoverMesh` must rebuild on every refresh, because a
 * moving height changes not just where a quad's corners sit but *which* tiers exist (an upper step
 * shrinks to nothing as a door opens).
 */
export function buildMoverWalls(build: Build, sectorIndex: number, index: MoverIndex): void {
  for (const lineIndex of index.linesOf(sectorIndex)) {
    processLine(build, build.map.linedefs[lineIndex], lineIndex);
  }
}
