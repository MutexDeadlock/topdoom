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
import { sectorLines, type World } from '../world.ts';
import type { FogOfWar } from '../fogofwar.ts';
import {
  buildMoverMesh,
  refreshMoverMesh,
  litColor,
  wallContrast,
  type BuiltMap,
  type MapMeshOptions,
  type MoverBuild,
  type MoverIndex,
  type MoverMesh,
} from '../../render/mapmesh.ts';
import type { SubSectorPoly } from '../../render/bsp.ts';
import type { MaterialBank } from '../../render/textures.ts';
import {
  boxesOverlap,
  fadeReach,
  FlatFader,
  stretchBox,
  type FadeBox,
  type FadeCrossings,
  type FadeFrame,
  WallFader,
} from '../../render/occlusion.ts';

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
   * The mesh's own 2D footprint, against which `updateFading` asks whether this
   * frame's fading can reach it at all. Built with the mesh: a refresh moves a
   * mover's heights, never where its quads stand (docs/render.md § Mover
   * meshes), and one that does reshape it builds a fresh entry.
   */
  bounds: FadeBox;
  /**
   * Whether this entry has committed once since it was built. Its faders start
   * with nothing written (`lastCombined` is NaN), so the first pass has to run
   * whatever else says it could be skipped.
   */
  committed: boolean;
  /**
   * Whether this frame's `collectFadeHits` took this entry's pass one, so
   * `updateFading` knows to take its pass two. Set once per frame, since the
   * two halves must agree: a fader that filed no crossings still has to fold
   * the ones every other fader filed.
   */
  fading: boolean;
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

/** What a `MoverGeometry` needs beside the `World` it draws over. */
export interface MoverGeometryOptions {
  bank: MaterialBank;
  scene: THREE.Scene | THREE.Group;
  fog: FogOfWar;
  built: BuiltMap;
  /** Render preferences only — `movableSectors` below is merged in, and wins. */
  meshOptions: MapMeshOptions;
  /**
   * Which sectors get mover-owned geometry — **the same set the caller gave `buildMapMesh`**, so
   * the mesh and this cannot disagree about who owns a sector.
   * docs/savegames.md § Apply order.
   */
  movableSectors: Set<number>;
}

export class MoverGeometry {
  /** Everything a mover mesh is built or refreshed from — the map included. */
  private mover: MoverBuild;
  private scene: THREE.Scene | THREE.Group;
  private fog: FogOfWar;
  private built: BuiltMap;

  private movableSectors: Set<number>;
  /** Movable sectors sharing a linedef with a given movable sector — see `rebuildAround`. */
  private movableNeighbors = new Map<number, Set<number>>();
  private moverMeshes = new Map<number, MoverEntry>();
  /** This frame's fade reach, refilled once per `collectFadeHits` — see `fadeReach`. */
  private reach: FadeBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private sectorOccluders = new Map<number, BuiltMap['occluders']>();
  private sectorFlats = new Map<number, BuiltMap['flatSurfaces']>();
  /**
   * Which mover meshes hold geometry coloured from a given sector's light — see `recolorSector`.
   */
  private moverLightTargets = new Map<number, Set<number>>();

  constructor(world: World, options: MoverGeometryOptions) {
    const { bank, scene, fog, built, meshOptions, movableSectors } = options;
    // Map and polygons are taken off what already owns them rather than passed alongside: `World`
    // holds the map it was built over, and `BuiltMap` the polygons it was built from.
    const map = world.map;
    this.mover = {
      map,
      polys: built.polys,
      bank,
      // buildMoverMesh needs the full set to decide which side of a shared line
      // is its own — see its doc; the caller only passes render preferences.
      options: { ...meshOptions, movableSectors },
      index: buildMoverIndex(map, built.polys),
    };
    this.scene = scene;
    this.fog = fog;
    this.built = built;
    this.movableSectors = movableSectors;
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
   *
   * Split in two so that every mover's pass one lands in the frame's shared bags before any fader
   * dissolves anything — docs/render.md § One hole, whichever mesh it lands in.
   */
  collectFadeHits(frame: FadeFrame, walls: FadeCrossings, flats: FadeCrossings): void {
    fadeReach(frame.camX, frame.camY, frame.targets, this.reach);
    for (const g of this.moverMeshes.values()) {
      // Nothing that reaches this mesh moved, and nothing in it is still
      // relaxing: every call below would write back what is already there. On a
      // map with a couple of thousand movers those calls are the whole cost.
      // A crossing lies inside the sight box and folds nothing further than its
      // own radius, so `reach` is exactly what a shared bag can reach too.
      // docs/render.md § Mover meshes a frame cannot touch.
      g.fading = !(g.walls.idle && g.flats.idle) || this.reachesMesh(g);
      if (!g.fading) continue;
      g.walls.collectCrossings(frame, walls);
      g.flats.collectPierces(frame, flats);
    }
  }

  /**
   * The second half of the pass `collectFadeHits` opens, over the frame's whole
   * bag of stops rather than each mesh's own — plus the fog-of-war combine and
   * the commit into the mover buffers.
   */
  updateFading(frame: FadeFrame, walls: FadeCrossings, flats: FadeCrossings): void {
    const revealed = this.fog.changedBounds();
    for (const g of this.moverMeshes.values()) {
      if (!g.fading && g.committed && !(revealed && boxesOverlap(g.bounds, revealed))) continue;
      if (g.fading) {
        g.walls.applyCrossings(frame, walls);
        g.flats.applyPierces(frame, flats);
      }
      g.committed = true;
      // Mover quads aren't in the static occluder list FogOfWar indexed at
      // load; `mapmesh` resolved each one's leaf when the mesh was built, and a
      // refresh preserves it, so -1 means only that the build was given no probe.
      g.walls.commit((i) => {
        const q = g.mesh.wallQuads[i];
        const s = q.subsector >= 0 ? q.subsector : this.fog.wallSubsectorAt(q.ax, q.ay, q.bx, q.by);
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

  /**
   * Whether this frame's fade reach (`fadeReach`, filled into `reach`) overlaps a mesh's footprint.
   */
  private reachesMesh(g: MoverEntry): boolean {
    return boxesOverlap(g.bounds, this.reach);
  }

  private createMoverMesh(sectorIndex: number): void {
    const mesh = buildMoverMesh(this.mover, sectorIndex);
    this.scene.add(mesh.group);
    // `trackVisibility` on: these are the faders whose verdict `updateFading`
    // reads to skip drawing an invisible mover mesh.
    const walls = new WallFader(mesh.wallQuads, mesh.meshes, true);
    // The wall half of this box is the fader's own footprint, which it boxed
    // over these very quads — so the two cannot drift, and only the fans are
    // left to walk. `reachesMesh` needs both; `applyCrossings` needs the walls.
    const bounds: FadeBox = { ...walls.footprint };
    for (const f of mesh.flatFans) {
      for (let p = 0; p < f.vertexXY.length; p += 2) stretchBox(bounds, f.vertexXY[p], f.vertexXY[p + 1]);
    }
    this.moverMeshes.set(sectorIndex, {
      mesh,
      walls,
      flats: new FlatFader(mesh.flatFans, mesh.meshes, true),
      bounds,
      committed: false,
      fading: false,
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
      if (refreshMoverMesh(old.mesh, this.mover, sectorIndex)) {
        // A refresh rewrites the whole colour attribute, alpha channel and all,
        // so what the faders last wrote is gone from the buffer even though
        // their own record still claims it. Both halves matter: the entry has
        // to be visited again however quiet its surroundings, and the faders
        // have to write rather than recognize their own last value.
        old.walls.invalidateWritten();
        old.flats.invalidateWritten();
        old.committed = false;
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
    const map = this.mover.map;
    for (const line of map.linedefs) {
      if (line.right === NO_SIDE || line.left === NO_SIDE) continue;
      const a = map.sidedefs[line.right]?.sector;
      const b = map.sidedefs[line.left]?.sector;
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
    const transfers = this.mover.options.transfers;
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
    const sector = this.mover.map.sectors[sectorIndex];
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
