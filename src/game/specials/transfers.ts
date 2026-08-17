/**
 * Boom's render transfers: the parameter lines that change how a sector or a line is *drawn* —
 * lighting borrowed from another sector (213/261), heights borrowed from another sector (242,
 * deep water) and translucent midtextures (260). Scanned once from the map, never ticked.
 * See docs/specials.md § Render transfers.
 */
import type { DoomMap } from '../../wad/map.ts';
import { NO_SIDE } from '../../wad/map.ts';
import { sectorsByTag, linesByTag, sectorLines } from '../world.ts';

/** The WAD's "no texture here" sidedef name, spelled out rather than imported from the render layer. */
const NO_TEXTURE = '-';

/**
 * A Boom translucency map is a 256×256 palette-blend table. The name of one is
 * what a 260 line's sidedef carries in place of a midtexture, and the length is
 * the only thing that tells the two apart (`p_setup.c: P_LoadSideDefs2`).
 */
const TRANMAP_LUMP_SIZE = 65536;

/** A colormap lump is 34 rows of 256 palette indexes — see `wad/colormaps.ts`. */
const COLORMAP_LUMP_SIZE = 34 * 256;

/** The colormap lump names a 242 control line's sidedef carries, by where the eye is. */
export interface ColormapNames {
  /** Below the control sector's floor — submerged. */
  bottom: string;
  /** Between the control sector's floor and ceiling. */
  mid: string;
  /** Above the control sector's ceiling. */
  top: string;
}

/** How many lines of each transfer a level carries — for the inspect-wad coverage report. */
export interface TransferCounts {
  floorLight: number;
  ceilingLight: number;
  water: number;
  translucent: number;
}

/** Looks a lump's byte length up by name, or null when the WAD has no such lump. */
export type LumpSize = (name: string) => number | null;

/**
 * One level's render transfers.
 *
 * Every one of them names its model the same way vanilla does — the control
 * sector is the one behind the special line's front sidedef, and the targets
 * are the sectors carrying its tag (`p_spec.c: P_SpawnSpecials`) — so the scan
 * is four passes over the linedefs with no runtime state to keep afterwards.
 * Reached through `transfersOf`, not constructed directly, except by tests and
 * `scripts/inspect-wad.ts`.
 */
export class Transfers {
  private map: DoomMap;
  /** Control sector per sector, or -1 for "its own". Dense: read per surface at build time. */
  private floorLightSec: Int32Array;
  private ceilingLightSec: Int32Array;
  private heightSecs: Int32Array;
  /**
   * `heightSecs` again, narrowed to the sectors whose neighbours can follow a
   * fake floor down — Boom's invisible-platform idiom, `markFakeFloors`. Dense
   * for the same reason its siblings are. See docs/specials.md § The fake floor.
   */
  private fakeFloorSecs: Int32Array;
  /** Linedef indexes whose midtexture draws translucent (260), and those whose midtexture is a tranmap name. */
  private translucent = new Set<number>();
  private suppressed = new Set<number>();
  /** Colormap names by control sector — only the 242 control sectors that carry any. */
  private colormaps = new Map<number, ColormapNames>();
  /**
   * Sidedef names on a 242 line that turned out to be colormap lumps, so the
   * renderer does not report them as missing textures. Boom decides this per
   * sidedef (`p_setup.c: P_LoadSideDefs2`); this keys on the name across the
   * level instead, which differs only if a WAD ships a wall texture sharing a
   * colormap lump's name — nothing does, since a colormap is a standalone lump
   * and a texture is a TEXTURE1 entry.
   */
  private colormapNames = new Set<string>();
  private tally: TransferCounts = { floorLight: 0, ceilingLight: 0, water: 0, translucent: 0 };
  /**
   * Whether the level has any transfer line at all. Most do not, and every
   * accessor here is read per surface at build time — the `Forces.hasScrollers`
   * cheap-out.
   */
  readonly hasAny: boolean;

  /**
   * `lumpSize` decides 260's midtexture overload, and is optional because only
   * the two callers holding a `Wad` (`game.ts`, `scripts/inspect-wad.ts`) can
   * answer it. Without it every midtexture name is taken as a texture, which is
   * what it is on all but a handful of lines.
   */
  constructor(map: DoomMap, lumpSize?: LumpSize) {
    this.map = map;
    const n = map.sectors.length;
    this.floorLightSec = new Int32Array(n).fill(-1);
    this.ceilingLightSec = new Int32Array(n).fill(-1);
    this.heightSecs = new Int32Array(n).fill(-1);
    this.fakeFloorSecs = new Int32Array(n).fill(-1);
    this.spawnLightTransfers();
    this.spawnHeightTransfers(lumpSize);
    this.markFakeFloors();
    this.spawnTranslucentLines(lumpSize);
    this.hasAny =
      this.tally.floorLight + this.tally.ceilingLight + this.tally.water + this.tally.translucent > 0;
  }

  /** 213 and 261 — `sectors[s].floorlightsec`/`ceilinglightsec`. */
  private spawnLightTransfers(): void {
    for (const [i, line] of this.map.linedefs.entries()) {
      if (line.special !== 213 && line.special !== 261) continue;
      const control = this.frontSector(i);
      if (control < 0) continue;
      const into = line.special === 213 ? this.floorLightSec : this.ceilingLightSec;
      for (const s of sectorsByTag(this.map, line.tag)) into[s] = control;
      if (line.special === 213) this.tally.floorLight++;
      else this.tally.ceilingLight++;
    }
  }

  /**
   * 242 — `sectors[s].heightsec`, plus the colormap names its sidedef carries.
   * Boom stores those names on the *control* sector (`p_setup.c`'s `sd->special
   * == 242` case reads them off the sidedef into `sec->bottommap`/`midmap`/
   * `topmap`), so they are keyed by control sector here too.
   */
  private spawnHeightTransfers(lumpSize?: LumpSize): void {
    for (const [i, line] of this.map.linedefs.entries()) {
      if (line.special !== 242) continue;
      const control = this.frontSector(i);
      if (control < 0) continue;
      for (const s of sectorsByTag(this.map, line.tag)) this.heightSecs[s] = control;
      this.tally.water++;
      const side = this.map.sidedefs[line.right];
      if (side) {
        this.colormaps.set(control, { bottom: side.lower, mid: side.middle, top: side.upper });
        for (const name of [side.lower, side.middle, side.upper]) {
          if (name !== '' && name !== NO_TEXTURE && (lumpSize?.(name) ?? 0) >= COLORMAP_LUMP_SIZE) {
            this.colormapNames.add(name.toUpperCase());
          }
        }
      }
    }
  }

  /**
   * Picks the 242 sectors whose *below-floor* control sector is a fake floor to
   * draw rather than a fake ceiling's leftover — the load-time half of
   * `drawnFloor`. A sector qualifies when every neighbour across a two-sided
   * line can follow it down: the neighbour sits at or below the fake floor, and
   * carries no 242 of its own (so it is drawn at the floor read here, and not at
   * one this scan may not have decided yet). See docs/specials.md § The fake
   * floor for why both clauses keep the substitution from opening a hole.
   *
   * Only the half of the rule that is about **adjacency** is settled here, since
   * nothing moves that; whether the control sector really is the lower of the two
   * is a live comparison `drawnFloor` makes. The heights compared *here* are
   * still load-time ones — a mover that lifts a neighbour above the fake floor
   * afterwards is a case no map this covers has, and re-running the walk per mesh
   * rebuild would put it in `processFlat`'s path.
   */
  private markFakeFloors(): void {
    for (let s = 0; s < this.heightSecs.length; s++) {
      const control = this.heightSecs[s];
      if (control < 0) continue;
      const fake = this.map.sectors[control]?.floorHeight;
      if (fake === undefined || fake >= (this.map.sectors[s]?.floorHeight ?? 0)) continue;
      if (this.neighboursFollow(s, fake)) this.fakeFloorSecs[s] = control;
    }
  }

  /**
   * Whether every sector across a two-sided line from `s` can be drawn against a
   * floor at `fake`: it sits at or below that height, so lowering `s` to it opens
   * no step the map has no lower texture for, and it carries no 242 of its own,
   * so the floor read off it is the one it draws at.
   */
  private neighboursFollow(s: number, fake: number): boolean {
    for (const lineIndex of sectorLines(this.map, s)) {
      const line = this.map.linedefs[lineIndex];
      if (line.right === NO_SIDE || line.left === NO_SIDE) continue;
      const front = this.map.sidedefs[line.right]?.sector;
      const back = this.map.sidedefs[line.left]?.sector;
      // A self-referencing line names `s` on both sides and borders nothing.
      const other = front === s ? back : front;
      if (other === undefined || other === s) continue;
      if ((this.map.sectors[other]?.floorHeight ?? 0) > fake) return false;
      if (this.heightSecs[other] >= 0) return false;
    }
    return true;
  }

  /**
   * 260. Tag 0 marks only the line it sits on; any other tag marks every line
   * carrying it (`p_setup.c: P_LoadLineDefs2`). The same sidedef's midtexture
   * name may be the translucency map rather than a texture — `TRANMAP`
   * literally, or any lump of exactly 65536 bytes — in which case Boom draws no
   * midtexture there at all.
   */
  private spawnTranslucentLines(lumpSize?: LumpSize): void {
    for (const [i, line] of this.map.linedefs.entries()) {
      if (line.special !== 260) continue;
      this.tally.translucent++;
      if (line.tag === 0) this.translucent.add(i);
      else for (const l of linesByTag(this.map, line.tag)) this.translucent.add(l);

      const name = this.map.sidedefs[line.right]?.middle ?? '';
      if (name === '' || name === NO_TEXTURE) continue;
      if (name.toUpperCase() === 'TRANMAP' || lumpSize?.(name) === TRANMAP_LUMP_SIZE) {
        this.suppressed.add(i);
      }
    }
  }

  /** The sector behind a line's front sidedef — Boom's `sides[*l->sidenum].sector` control lookup. */
  private frontSector(lineIndex: number): number {
    const line = this.map.linedefs[lineIndex];
    if (!line || line.right === NO_SIDE) return -1;
    return this.map.sidedefs[line.right]?.sector ?? -1;
  }

  /** The light a sector's floor draws with — 213's control sector, else its own (`R_FakeFlat`). */
  floorLight(sectorIndex: number): number {
    const source = this.floorLightSec[sectorIndex] ?? -1;
    const sector = this.map.sectors[source < 0 ? sectorIndex : source];
    return sector?.light ?? 0;
  }

  /** The light a sector's ceiling draws with — 261's control sector, else its own (`R_FakeFlat`). */
  ceilingLight(sectorIndex: number): number {
    const source = this.ceilingLightSec[sectorIndex] ?? -1;
    const sector = this.map.sectors[source < 0 ? sectorIndex : source];
    return sector?.light ?? 0;
  }

  /**
   * The light a thing standing in a sector draws with: `(floorlightlevel +
   * ceilinglightlevel) / 2`, `R_AddSprites`. With no transfer line in the level
   * both halves are the sector's own light, so this is the same number every
   * sprite read before Boom compat.
   */
  spriteLight(sectorIndex: number): number {
    return (this.floorLight(sectorIndex) + this.ceilingLight(sectorIndex)) / 2;
  }

  /**
   * Which sector a surface's light actually came from — what `MoverGeometry`
   * files its relight indexes under (docs/specials.md § Relighting mover geometry).
   */
  floorLightSector(sectorIndex: number): number {
    const source = this.floorLightSec[sectorIndex] ?? -1;
    return source < 0 ? sectorIndex : source;
  }

  ceilingLightSector(sectorIndex: number): number {
    const source = this.ceilingLightSec[sectorIndex] ?? -1;
    return source < 0 ? sectorIndex : source;
  }

  /** A sector's 242 control sector, or -1 — Boom's `sec->heightsec`. */
  heightSec(sectorIndex: number): number {
    return this.heightSecs[sectorIndex] ?? -1;
  }

  /**
   * The height a sector's ceiling is *drawn* at — its 242 control sector's,
   * else its own (`r_bsp.c: R_FakeFlat`). The ceiling-side counterpart of
   * `waterHeight`, and what sizes the walls across a two-sided line from it —
   * see docs/specials.md § Deep water.
   */
  drawnCeiling(sectorIndex: number): number {
    const own = this.map.sectors[sectorIndex]?.ceilHeight ?? 0;
    const control = this.heightSec(sectorIndex);
    return control < 0 ? own : (this.map.sectors[control]?.ceilHeight ?? own);
  }

  /**
   * The height a sector's floor is *drawn* at when only one floor is drawn for
   * it: its 242 control sector's where `markFakeFloors` cleared the substitution
   * and that sector is still the lower of the two, else its own. The floor-side
   * counterpart of `drawnCeiling`, and what sizes the walls across a two-sided
   * line from it.
   *
   * Vanilla substitutes unconditionally (`r_bsp.c: R_FakeFlat`); this engine
   * draws a pool bottom at the real floor, so it never substitutes *upwards*,
   * which is why the comparison is live: a mover can raise the drawn floor over
   * the real one. See docs/specials.md § The fake floor.
   */
  drawnFloor(sectorIndex: number): number {
    const own = this.map.sectors[sectorIndex]?.floorHeight ?? 0;
    const control = this.fakeFloorSecs[sectorIndex] ?? -1;
    if (control < 0) return own;
    const fake = this.map.sectors[control]?.floorHeight ?? own;
    return fake < own ? fake : own;
  }

  /** Every sector drawing at a fake floor, and the control sector it takes it from. */
  fakeFloorSectors(): { sector: number; control: number }[] {
    const out: { sector: number; control: number }[] = [];
    for (let s = 0; s < this.fakeFloorSecs.length; s++) {
      if (this.fakeFloorSecs[s] >= 0) out.push({ sector: s, control: this.fakeFloorSecs[s] });
    }
    return out;
  }

  /**
   * The height a sector's water surface is drawn at, or null where there is
   * none to draw: no 242, or a control sector at or below the real floor, which
   * is Boom's *fake ceiling* or *fake floor* rather than deep water — see
   * docs/specials.md § Deep water and § The fake floor.
   */
  waterHeight(sectorIndex: number): number | null {
    const control = this.heightSec(sectorIndex);
    if (control < 0) return null;
    const surface = this.map.sectors[control]?.floorHeight;
    const floor = this.map.sectors[sectorIndex]?.floorHeight;
    if (surface === undefined || floor === undefined || surface <= floor) return null;
    return surface;
  }

  /** Whether this linedef's midtexture draws translucent (260). */
  translucentLine(lineIndex: number): boolean {
    return this.translucent.has(lineIndex);
  }

  /** Whether this linedef's midtexture name is a translucency map, so no midtexture is drawn. */
  midtexSuppressed(lineIndex: number): boolean {
    return this.suppressed.has(lineIndex);
  }

  /** Whether this sidedef texture name is really a colormap lump a 242 line named. */
  colormapName(name: string): boolean {
    return this.colormapNames.has(name.toUpperCase());
  }

  /** The colormap names a 242 control sector carries, or null when it has none. */
  colormapsOf(controlSector: number): ColormapNames | null {
    return this.colormaps.get(controlSector) ?? null;
  }

  /** Every sector that borrows another's heights, and the control sector it borrows from. */
  waterSectors(): { sector: number; control: number }[] {
    const out: { sector: number; control: number }[] = [];
    for (let s = 0; s < this.heightSecs.length; s++) {
      if (this.heightSecs[s] >= 0) out.push({ sector: s, control: this.heightSecs[s] });
    }
    return out;
  }

  counts(): TransferCounts {
    return { ...this.tally };
  }
}

/**
 * The level's transfers, built on first use and memoized against the map.
 *
 * Keyed by the `DoomMap` for the same reason `world.ts`'s tag indexes are: this
 * is a pure function of data nothing rewrites at runtime, and its readers span
 * layers that have no path to each other — the mesh builder runs before any
 * controller exists, and the sprite-lighting sites sit in five different
 * modules. See docs/specials.md § Render transfers.
 */
const cache = new WeakMap<DoomMap, { transfers: Transfers; probed: boolean }>();

export function transfersOf(map: DoomMap, lumpSize?: LumpSize): Transfers {
  const cached = cache.get(map);
  // A caller holding a `Wad` upgrades an entry some earlier probe-less caller
  // built: only that caller can resolve 260's midtexture overload, and load
  // order is not something the scattered readers here should have to know.
  if (cached && (cached.probed || !lumpSize)) return cached.transfers;
  const transfers = new Transfers(map, lumpSize);
  cache.set(map, { transfers, probed: lumpSize !== undefined });
  return transfers;
}
