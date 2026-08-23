/**
 * The render-side half of the specials system: the per-sector meshes that
 * moving geometry is drawn from, their occlusion faders, and rewriting vertex
 * colours when a sector's light changes.
 *
 * `SpecialsController` mutates `Sector.floorHeight`/`ceilHeight`/`light` on
 * the `DoomMap` directly and everything else in the engine picks that up on
 * its next query — this class exists for the one thing that doesn't just
 * work, which is that a sector's *drawn* geometry was baked at load time and
 * has to be rebuilt or recoloured. Nothing here knows what a door or a
 * crusher is; it takes sector indices.
 *
 * See docs/render.md § Mover meshes for what a rebuild costs and when it can be
 * done in place, and docs/specials.md § Relighting mover geometry and § Light
 * changes for the colour half.
 */
import * as THREE from 'three';
import { NO_SIDE, type DoomMap } from '../../wad/map.ts';
import { sectorLines, type Opening, type World } from '../world.ts';
import type { FogOfWar } from '../fogofwar.ts';
import {
  buildMoverMesh,
  refreshMoverMesh,
  litColor,
  wallContrast,
  type BuiltMap,
  type MapMeshOptions,
  type MoverIndex,
  type MoverMesh,
} from '../../render/mapmesh.ts';
import type { SubSectorPoly } from '../../render/bsp.ts';
import type { MaterialBank } from '../../render/textures.ts';
import { FlatFader, type FadeTarget, WallFader } from '../../render/occlusion.ts';

/**
 * One movable sector's geometry plus the two faders that own its vertex
 * alpha, exactly as `game.ts` runs them over the static batches. Mover walls
 * need the camera-player sightline fade for the same reason static ones do —
 * a lift's front wall or a door frame sits between camera and player just as
 * readily as any other wall — and rebuilding the mesh drops the faders'
 * smoothing state with it, which only ever happens while the mover is in
 * motion.
 */
interface MoverEntry {
  mesh: MoverMesh;
  walls: WallFader;
  flats: FlatFader;
  /**
   * Memoized fog probe per wall quad, parallel to `mesh.wallQuads`:
   * `FogOfWar.wallSubsectorAt` is a BSP descent whose answer is fixed by the
   * quad's endpoints, which vertical movement never touches. Cleared by
   * `rebuild` whenever it refreshes or replaces the mesh — the only events
   * that can repoint a quad slot at different geometry.
   * docs/fogofwar.md § Mover wall quads.
   */
  fogSubsectors: (number | undefined)[];
}

const NO_SUBSECTORS: readonly number[] = [];

/**
 * The renderer's `MoverIndex`: the subsectors grouped once from `polys` (their
 * *drawn* sector, which a self-referencing sector redirects — render/bsp.ts),
 * and the linedefs straight off `World`'s memoized `sec->lines[]`.
 */
export function buildMoverIndex(map: DoomMap, polys: SubSectorPoly[]): MoverIndex {
  const subsectors: number[][] = Array.from({ length: map.sectors.length }, () => []);
  for (let ss = 0; ss < polys.length; ss++) subsectors[polys[ss].sector]?.push(ss);
  return {
    subsectorsOf: (sectorIndex) => subsectors[sectorIndex] ?? NO_SUBSECTORS,
    linesOf: (sectorIndex) => sectorLines(map, sectorIndex),
  };
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
}

export class MoverGeometry {
  private map: DoomMap;
  private world: World;
  private bank: MaterialBank;
  private scene: THREE.Scene | THREE.Group;
  private fog: FogOfWar;
  private polys: SubSectorPoly[];
  private built: BuiltMap;
  private meshOptions: MapMeshOptions;
  /** See `buildMoverIndex`. */
  private moverIndex: MoverIndex;

  private movableSectors: Set<number>;
  /** Movable sectors sharing a linedef with a given movable sector — see `rebuildAround`. */
  private movableNeighbors = new Map<number, Set<number>>();
  private moverMeshes = new Map<number, MoverEntry>();

  private sectorOccluders = new Map<number, BuiltMap['occluders']>();
  private sectorFlats = new Map<number, BuiltMap['flatSurfaces']>();
  /** Which mover meshes hold geometry coloured from a given sector's light — see `recolorSector`. */
  private moverLightTargets = new Map<number, Set<number>>();

  constructor(
    map: DoomMap,
    world: World,
    bank: MaterialBank,
    scene: THREE.Scene | THREE.Group,
    fog: FogOfWar,
    polys: SubSectorPoly[],
    built: BuiltMap,
    meshOptions: MapMeshOptions,
    movableSectors: Set<number>,
  ) {
    this.map = map;
    this.world = world;
    this.bank = bank;
    this.scene = scene;
    this.fog = fog;
    this.polys = polys;
    this.built = built;
    this.movableSectors = movableSectors;
    // buildMoverMesh needs the full set to decide which side of a shared line
    // is its own — see its doc; the caller only passes render preferences.
    this.meshOptions = { ...meshOptions, movableSectors };
    this.moverIndex = buildMoverIndex(map, polys);
    this.indexMovableNeighbors();
    this.indexWaterDependents();
    for (const sectorIndex of movableSectors) this.createMoverMesh(sectorIndex);
    this.indexLightGeometry();
  }

  dispose(): void {
    for (const g of this.moverMeshes.values()) {
      this.scene.remove(g.mesh.group);
      disposeGroup(g.mesh.group);
    }
  }

  /**
   * `sectorOccluders`/`sectorFlats` point at every sector's own occluder/flat
   * objects, pulled out of `built.occluders`/`built.flatSurfaces` once at
   * construction time so `recolorSector` never has to re-scan the whole map.
   * **Every sector, not just the ones with a load-time blink pattern**: the
   * `lightChange` line specials (`triggerLightChange`) can recolor any
   * tag-matched sector on demand — a one-time, load-only cost.
   * Static batches only: geometry living in a mover mesh is reached by
   * `moverLightTargets` instead — see docs/specials.md § Relighting mover
   * geometry.
   */
  private indexLightGeometry(): void {
    this.sectorOccluders.clear();
    this.sectorFlats.clear();
    for (const o of this.built.occluders) {
      const arr = this.sectorOccluders.get(o.sector) ?? [];
      arr.push(o);
      this.sectorOccluders.set(o.sector, arr);
    }
    for (const f of this.built.flatSurfaces) {
      const arr = this.sectorFlats.get(f.lightSector) ?? [];
      arr.push(f);
      this.sectorFlats.set(f.lightSector, arr);
    }
  }

  /**
   * Per-frame vertex-alpha pass over the mover geometry, mirroring what
   * `game.ts` runs over the static batches: camera sightline occlusion
   * (player plus every awake monster — see `WallFader.update`'s doc) combined
   * with fog-of-war reveal. Separate from `SpecialsController.update` because
   * it needs the camera position, which is only settled after the player has
   * moved.
   */
  updateFading(dt: number, camX: number, camY: number, camZ: number, targets: FadeTarget[]): void {
    // Hoisted out of the loop: a level can hold a couple of thousand mover
    // meshes, and this closure captures nothing that varies between them.
    const openingInto = (line: number, out: Opening) => this.world.openingInto(line, out);
    for (const g of this.moverMeshes.values()) {
      g.walls.update(dt, camX, camY, camZ, targets, openingInto);
      g.flats.update(dt, camX, camY, camZ, targets);
      // Mover quads aren't in the static occluder list FogOfWar indexed at
      // load, so their subsector is probed from the quad itself.
      g.walls.commit((i) => {
        // Memoized — see `MoverEntry.fogSubsectors`.
        let s = g.fogSubsectors[i];
        if (s === undefined) {
          const q = g.mesh.wallQuads[i];
          s = g.fogSubsectors[i] = this.fog.wallSubsectorAt(q.ax, q.ay, q.bx, q.by);
        }
        return this.fog.alphaOf(s);
      });
      g.flats.commit((subsector) => this.fog.alphaOf(subsector));
      // A mover mesh every quad of which resolved to alpha 0 — fog of war has
      // not revealed it, or view distance has faded it out — draws nothing, so
      // it is skipped outright. One mesh can hold both walls and flats, so both
      // faders' verdicts count. This runs immediately before the frame's render
      // (`game.ts: draw`), so the flag is always this frame's.
      // docs/render.md § Skipping invisible mover meshes.
      for (const [key, mesh] of g.mesh.meshes) {
        const wall = g.walls.maxAlphaByKey.get(key) ?? 0;
        const flat = g.flats.maxAlphaByKey.get(key) ?? 0;
        mesh.visible = wall > 0 || flat > 0;
      }
    }
  }

  private createMoverMesh(sectorIndex: number): void {
    const mesh = buildMoverMesh(this.map, this.polys, sectorIndex, this.bank, this.meshOptions, this.moverIndex);
    this.scene.add(mesh.group);
    this.moverMeshes.set(sectorIndex, {
      mesh,
      // `trackVisibility` on: these are the faders whose verdict `updateFading`
      // reads to skip drawing an invisible mover mesh.
      walls: new WallFader(mesh.wallQuads, mesh.meshes, true),
      flats: new FlatFader(mesh.flatFans, mesh.meshes, true),
      fogSubsectors: [],
    });
    // A mover mesh holds its own sector's flats plus wall quads from *both*
    // sides of every bordering line, so the sectors it must be relit for are
    // not just `sectorIndex` — see `recolorSector`. Rebuilding a mesh never
    // changes which sectors those are, so the sets only ever grow once.
    for (const q of mesh.wallQuads) this.trackMoverLight(q.sector, sectorIndex);
    for (const f of mesh.flatFans) this.trackMoverLight(f.lightSector, sectorIndex);
  }

  private trackMoverLight(sectorIndex: number, moverIndex: number): void {
    const set = this.moverLightTargets.get(sectorIndex) ?? new Set<number>();
    set.add(moverIndex);
    this.moverLightTargets.set(sectorIndex, set);
  }

  /**
   * Brings exactly one sector's mesh up to date. Private, and the whole reason
   * is the doc on `rebuildAround`: the set of meshes a changed sector
   * invalidates is never just its own, so nothing outside may pick a sector to
   * rebuild without going through the closure. Only a sector whose set of drawn
   * quads changed pays for a fresh mesh — docs/render.md § Mover meshes.
   */
  private rebuild(sectorIndex: number): void {
    const old = this.moverMeshes.get(sectorIndex);
    if (old) {
      if (refreshMoverMesh(old.mesh, this.map, this.polys, sectorIndex, this.bank, this.meshOptions, this.moverIndex)) {
        // A refresh may repoint a quad slot at different geometry — drop the
        // fog memos and let the next fading pass re-probe.
        old.fogSubsectors.length = 0;
        return;
      }
      this.scene.remove(old.mesh.group);
      disposeGroup(old.mesh.group);
    }
    this.createMoverMesh(sectorIndex);
  }

  /**
   * Rebuilds every mesh invalidated by a set of sectors having changed —
   * whether that change was a height, a flat or a wall texture, and **the only
   * way in**. It is never just those sectors: a two-sided line's *other* side
   * is drawn from both sectors' heights, so a movable neighbour's own quads on
   * a shared line go stale too (a switch mounted on the wall of the lift it
   * operates is the common case — the switch's own sector owns that quad, but
   * its height comes from the lift), and a Boom 242 sector draws from a control
   * sector it shares no line with at all (`indexWaterDependents`). Static
   * neighbours need no entry here: their side of such a line is built into this
   * mover's mesh, not the static batch.
   */
  rebuildAround(dirty: Set<number>): void {
    if (dirty.size === 0) return;
    const rebuild = new Set(dirty);
    for (const sectorIndex of dirty) {
      for (const n of this.movableNeighbors.get(sectorIndex) ?? []) rebuild.add(n);
    }
    for (const sectorIndex of rebuild) this.rebuild(sectorIndex);
  }

  private indexMovableNeighbors(): void {
    for (const line of this.map.linedefs) {
      if (line.right === NO_SIDE || line.left === NO_SIDE) continue;
      const a = this.map.sidedefs[line.right]?.sector;
      const b = this.map.sidedefs[line.left]?.sector;
      if (a === undefined || b === undefined || a === b) continue;
      if (!this.movableSectors.has(a) || !this.movableSectors.has(b)) continue;
      this.link(a, b);
      this.link(b, a);
    }
  }

  /**
   * The rebuild edges that aren't adjacency: a Boom 242 sector draws from its
   * *control* sector, which it shares no linedef with — and so do the
   * dependent's own movable neighbours, whose upper steps are sized against the
   * ceiling it draws rather than the one it has. Linked one way only (control →
   * dependent): moving the water does not move the control sector.
   * docs/specials.md § Deep water.
   */
  private indexWaterDependents(): void {
    const transfers = this.meshOptions.transfers;
    if (!transfers) return;
    // Collected first, applied after: `link` writes the very sets this reads.
    const edges: [number, number][] = [];
    for (const sectorIndex of this.movableSectors) {
      const control = transfers.heightSec(sectorIndex);
      if (control < 0 || control === sectorIndex || !this.movableSectors.has(control)) continue;
      edges.push([control, sectorIndex]);
      for (const n of this.movableNeighbors.get(sectorIndex) ?? []) {
        if (n !== control) edges.push([control, n]);
      }
    }
    for (const [from, to] of edges) this.link(from, to);
  }

  private link(from: number, to: number): void {
    const set = this.movableNeighbors.get(from) ?? new Set<number>();
    set.add(to);
    this.movableNeighbors.set(from, set);
  }

  /**
   * Rewrites the vertex colours of every surface lit by `sectorIndex` to that
   * sector's current `light` — both the static batches (indexed once by
   * `indexLightGeometry`) and any mover meshes holding its geometry. Only the
   * RGB channels are touched; alpha belongs to the faders (render/occlusion.ts).
   * See docs/specials.md § Light changes.
   */
  recolorSector(sectorIndex: number): void {
    const sector = this.map.sectors[sectorIndex];
    const dirty = new Set<string>();

    for (const o of this.sectorOccluders.get(sectorIndex) ?? []) {
      const c = litColor(sector.light, wallContrast(o.ax, o.ay, o.bx, o.by));
      const attr = this.built.wallMeshes.get(o.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      for (let v = 0; v < o.vertexCount; v++) attr.setXYZ(o.vertexStart + v, c, c, c);
      dirty.add(o.key);
    }
    for (const f of this.sectorFlats.get(sectorIndex) ?? []) {
      // Indexed by the sector the fan's *light* came from, so this is that
      // sector's level even where the fan belongs to another one (a 213
      // transfer, a deep-water bottom).
      const c = litColor(sector.light);
      const attr = this.built.flatMeshes.get(f.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      for (let v = 0; v < f.vertexCount; v++) attr.setXYZ(f.vertexStart + v, c, c, c);
      dirty.add(f.key);
    }

    for (const key of dirty) {
      const attr = (this.built.wallMeshes.get(key) ?? this.built.flatMeshes.get(key))?.geometry.getAttribute('color') as
        | THREE.BufferAttribute
        | undefined;
      if (attr) attr.needsUpdate = true;
    }

    this.recolorMoverGeometry(sectorIndex, sector.light);
  }

  /**
   * `recolorSector`'s mover-mesh half. A sector that is *also* a mover (a
   * strobing lift — DOOM1 E1M5 sectors 2 and 32) has its flats and walls in
   * its own `moverMeshes` entry rather than the static batch, and a static
   * sector bordering a mover has its side of the shared line built there too,
   * so neither is reachable through `sectorOccluders`/`sectorFlats`. Without
   * this pass such a sector only ever picked up its light while it happened
   * to be moving, since a height change rebuilds the mesh from the live
   * `sector.light` anyway.
   */
  private recolorMoverGeometry(sectorIndex: number, light: number): void {
    for (const moverIndex of this.moverLightTargets.get(sectorIndex) ?? []) {
      const g = this.moverMeshes.get(moverIndex);
      if (!g) continue;
      const dirty = new Set<string>();

      for (const q of g.mesh.wallQuads) {
        if (q.sector !== sectorIndex) continue;
        const attr = g.mesh.meshes.get(q.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (!attr) continue;
        const c = litColor(light, wallContrast(q.ax, q.ay, q.bx, q.by));
        for (let v = 0; v < q.vertexCount; v++) attr.setXYZ(q.vertexStart + v, c, c, c);
        dirty.add(q.key);
      }
      for (const f of g.mesh.flatFans) {
        if (f.lightSector !== sectorIndex) continue;
        const attr = g.mesh.meshes.get(f.key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (!attr) continue;
        const c = litColor(light);
        for (let v = 0; v < f.vertexCount; v++) attr.setXYZ(f.vertexStart + v, c, c, c);
        dirty.add(f.key);
      }

      for (const key of dirty) {
        const attr = g.mesh.meshes.get(key)?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (attr) attr.needsUpdate = true;
      }
    }
  }
}
