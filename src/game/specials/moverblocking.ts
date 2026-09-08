/**
 * The "who is standing in this mover" answers `SpecialsController` reaches the level's bodies
 * through (`Occupancy`): crush damage, the corpse squish, and the two obstruction tests that stall
 * or reverse a mover. The controller owns the moving geometry and knows only a sector index — plus,
 * for the two obstruction tests, the height its next step would put the plane at. See
 * docs/specials-crushers.md § Crushers, § Crushed corpses and § Every other mover stops instead.
 */
import type { DoomMap, Sector } from '../../wad/map.ts';
import type { Pos2, Pos3 } from '../../types.ts';
import type { World } from '../world.ts';
import type { ThingLayer } from '../things.ts';
import { TALLEST_BODY_HEIGHT } from '../monsters/tables.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../player.ts';
import { neighborSectorIndices } from '../world.ts';
import { CORPSE_HEIGHT_FRACTION, CRUSH_DAMAGE } from './defs.ts';

/**
 * The three "who is in this mover" answers `SpecialsController` asks per tic, plus the corpse
 * squish it commands. It owns the moving geometry and reaches the level's bodies through this; the
 * rig in `tests/fixtures/specialsrig.ts` supplies its own to drive a mover into an obstruction with
 * no body anywhere near the sector.
 * docs/specials-crushers.md § Crushers, § Crushed corpses and § Every other mover stops instead.
 */
export interface Occupancy {
  /** A closing door or lowering ceiling — see `blocksCeilingLower`. */
  blocksCeilingLower(sectorIndex: number, ceilingHeight: number): boolean;
  /** A rising lift or floor — see `blocksFloorRise`. */
  blocksFloorRise(sectorIndex: number, floorHeight: number): boolean;
  /**
   * Deals `CRUSH_DAMAGE` when `dealDamage`, and reports vanilla's `nofit` either way — the crusher
   * slowdown keys off it every tic, not only on a damage one. See `applyCrushDamage`.
   */
  crush(sectorIndex: number, dealDamage: boolean): boolean;
  /**
   * Crunches to giblets whatever corpse the sector's planes have left no room for —
   * `squashCorpses`.
   */
  squash(sectorIndex: number): void;
}

/** Where `MoverOccupancy` finds the bodies a mover could catch. */
export interface OccupancySources {
  /**
   * The thing layer, as a getter: `game.ts`'s `loadMap` builds it *after* the
   * `SpecialsController`, so an instance passed at construction would be the null one forever.
   */
  things: () => ThingLayer | null;
  /**
   * The live player position — read every tic, so it must be the player object itself. `z` is the
   * feet height the crusher's spray is measured up from.
   */
  player: Pos3;
  /** The level's voodoo dolls (`game/voodoo.ts`): a crusher catching one hurts the real player. */
  dolls: readonly Pos2[];
  /** Crush damage to the player. The cause is fixed per wiring site, so the caller binds it. */
  damagePlayer: (amount: number) => void;
  /**
   * `PIT_ChangeSector`'s blood spray, at the caught body's middle —
   * `SpriteFxLayer.spawnCrushBlood`, which lives in `game.ts` like every other effect.
   */
  sprayBlood: (at: Pos3) => void;
}

/** The `Occupancy` of a level with nothing in it — `SpecialsOptions.occupants`' default. */
export const NOBODY: Occupancy = {
  blocksCeilingLower: () => false,
  blocksFloorRise: () => false,
  crush: () => false,
  squash: () => {},
};

/** Per map, per sector: `crushNeighborhood`'s answer, memoized as `world.ts`'s `sectorLines` is. */
const neighborhoods = new WeakMap<DoomMap, Map<number, Set<Sector>>>();

/**
 * What `Occupancy.crush` does: deals `CRUSH_DAMAGE` to the player and to every crushable body the
 * sector's moving plane has left without the headroom to stand in, and sprays blood out of each.
 * Gated on `crushed` rather than on merely standing in the sector, so a crusher parked at the top
 * of its travel deals none. Monsters and barrels share one loop, matching `PIT_ChangeSector`
 * treating any shootable mobj the same. docs/specials-crushers.md § Crushers.
 */
export function applyCrushDamage(
  world: World,
  sources: OccupancySources,
  sectorIndex: number,
  dealDamage: boolean,
): boolean {
  const { player, dolls, damagePlayer, sprayBlood } = sources;
  const things = sources.things();
  const map = world.map;
  const sector = map.sectors[sectorIndex];
  const gap = sector.ceilHeight - sector.floorHeight;
  // `nofit`: something shootable is in the sector and doesn't fit the gap. It is
  // reported whether or not this tic is a damage tic, because the crusher
  // slowdown keys off it every tic — see `SpecialsController.tickCrush`.
  let caught = false;
  // Both gates are the mover's own gap, and are the cheap "could this plane be
  // squeezing anyone at all" pre-filter for the per-body measurement below:
  // headroom shorter than a body's height somewhere *next* to the mover is that
  // neighbor's business, not this mover's.
  if (gap < PLAYER_HEIGHT) {
    // The doll and the player are the same mobj as far as `PIT_ChangeSector` is
    // concerned — and a crusher over a doll is the classic instant-death script,
    // so this is not an edge case. Damage is dealt once per body caught, exactly
    // as vanilla's per-mobj loop does. A doll sprays no blood, unlike the player it stands for:
    // `dolls` carries no height to spray it at, and a doll is drawn as nothing anyway.
    // docs/specials-forces.md § Voodoo dolls.
    for (const body of dolls) {
      if (!crushed(world, body.x, body.y, PLAYER_RADIUS, PLAYER_HEIGHT, sectorIndex, false)) continue;
      caught = true;
      if (dealDamage) damagePlayer(CRUSH_DAMAGE);
    }
    if (crushed(world, player.x, player.y, PLAYER_RADIUS, PLAYER_HEIGHT, sectorIndex, false)) {
      caught = true;
      if (dealDamage) {
        damagePlayer(CRUSH_DAMAGE);
        sprayBlood({ x: player.x, y: player.y, z: player.z + PLAYER_HEIGHT / 2 });
      }
    }
  }
  if (gap < TALLEST_BODY_HEIGHT) {
    for (const m of things?.crushablesInSectors(crushNeighborhood(map, sectorIndex)) ?? []) {
      // Per body, not one shared band: a barrel is 42 tall against a
      // cyberdemon's 110, so the ceiling reaches them at very different points
      // of the same descent.
      if (!crushed(world, m.x, m.y, m.radius, m.height, sectorIndex, true)) continue;
      caught = true;
      if (!dealDamage) continue;
      // Before the damage, as `PTR_ShootTraverse` does it: whatever this blow kills still
      // bleeds. `bleeds` is `MF_NOBLOOD`, so a barrel takes the pulse without spraying —
      // vanilla checks no flag here at all (docs/specials-crushers.md § Crushers).
      if (things?.bleeds(m.id)) sprayBlood({ x: m.x, y: m.y, z: m.z + m.height / 2 });
      things?.damage(m.id, CRUSH_DAMAGE);
    }
  }
  return caught;
}

/**
 * `PIT_ChangeSector`'s corpse branch: every corpse the sector's planes have left less room than a
 * corpse's own height is crunched to a pool of blood. Unlike crush damage this is not rationed on
 * the damage clock and not the crushers' alone — vanilla runs it from `P_ChangeSector` after *any*
 * plane move, which is what squashes a body under an ordinary closing door.
 * docs/specials-crushers.md § Crushed corpses.
 */
export function squashCorpses(world: World, things: ThingLayer | null, sectorIndex: number): void {
  if (!things) return;
  const map = world.map;
  const sector = map.sectors[sectorIndex];
  // The same cheap pre-filter `applyCrushDamage` opens with, against the shortest corpse this
  // mover could be squeezing rather than the tallest body.
  if (sector.ceilHeight - sector.floorHeight >= TALLEST_BODY_HEIGHT * CORPSE_HEIGHT_FRACTION) return;
  for (const m of things.corpsesInSectors(crushNeighborhood(map, sectorIndex))) {
    if (!crushed(world, m.x, m.y, m.radius, m.height * CORPSE_HEIGHT_FRACTION, sectorIndex, true)) continue;
    things.crushCorpse(m.id);
  }
}

/** `Occupancy` over a real level: the functions above, bound to whoever is in it. */
export class MoverOccupancy implements Occupancy {
  private world: World;
  private sources: OccupancySources;

  constructor(world: World, sources: OccupancySources) {
    this.world = world;
    this.sources = sources;
  }

  blocksCeilingLower(sectorIndex: number, ceilingHeight: number): boolean {
    const { things, player } = this.sources;
    return blocksCeilingLower(this.world, things(), player, sectorIndex, ceilingHeight);
  }

  blocksFloorRise(sectorIndex: number, floorHeight: number): boolean {
    const { things, player } = this.sources;
    return blocksFloorRise(this.world, things(), player, sectorIndex, floorHeight);
  }

  crush(sectorIndex: number, dealDamage: boolean): boolean {
    return applyCrushDamage(this.world, this.sources, sectorIndex, dealDamage);
  }

  squash(sectorIndex: number): void {
    squashCorpses(this.world, this.sources.things(), sectorIndex);
  }
}

/**
 * A closing door or a lowering `CeilingMover`. The sector's floor doesn't move here, so it's read
 * straight off the map.
 */
function blocksCeilingLower(
  world: World,
  things: ThingLayer | null,
  player: Pos2,
  sectorIndex: number,
  ceilingHeight: number,
): boolean {
  const floorHeight = world.map.sectors[sectorIndex].floorHeight;
  return headroomBlocked(world, things, player, { sectorIndex, floorHeight, ceilingHeight });
}

/**
 * A rising lift or non-crushing `FloorMover`. Every body here is measured against
 * `groundCeiling`'s straddle-aware overhead — the lowest ceiling its *box* meets — and never
 * against the rising sector's own: standing half on the rising sector and half in a
 * lower-ceilinged neighbor, `groundFloor` already pins the body's `z` to this sector's rising
 * floor, so the neighbor's own (unmoving) ceiling is what would actually crush it. Without this
 * the mover carries the body up into that neighbor and pins it there.
 * docs/specials-movers.md § Every other mover stops instead.
 */
function blocksFloorRise(
  world: World,
  things: ThingLayer | null,
  player: Pos2,
  sectorIndex: number,
  floorHeight: number,
): boolean {
  // Voodoo dolls deliberately do **not** obstruct movers. Vanilla's
  // `PIT_ChangeSector` would let one stall a rising floor, but a doll is parked
  // by the mapper precisely where the script needs it and is usually meant to be
  // crushed there — having it silently jam the level's own machinery is the
  // worse failure. Crush *damage* still reaches it (`applyCrushDamage`).
  const map = world.map;
  if (
    boxOverlapsSector(world, player.x, player.y, PLAYER_RADIUS, sectorIndex) &&
    floorHeight + PLAYER_HEIGHT > world.groundCeiling(player.x, player.y, PLAYER_RADIUS)
  ) {
    return true;
  }
  // `headroomBlocked`'s early-out, widened to the sectors a box walk can actually reach: this
  // sector's own gap clearing the tallest body says nothing about a neighbor's.
  if (floorHeight + TALLEST_BODY_HEIGHT <= lowestCeilingAround(map, sectorIndex)) return false;
  for (const m of things?.monstersInSector(map.sectors[sectorIndex]) ?? []) {
    if (floorHeight + m.height > world.groundCeiling(m.x, m.y, m.radius, true)) return true;
  }
  return false;
}

/**
 * The lowest ceiling `World.groundCeiling` could return for a body standing in `sectorIndex`: the
 * sector's own and every one across a two-sided line from it, which is exactly how far the box
 * walk reaches. `blocksFloorRise`'s pre-filter alone.
 */
function lowestCeilingAround(map: DoomMap, sectorIndex: number): number {
  let lowest = Infinity;
  for (const sector of crushNeighborhood(map, sectorIndex)) {
    if (sector.ceilHeight < lowest) lowest = sector.ceilHeight;
  }
  return lowest;
}

/**
 * The eight points of a `radius`-box's rim that `boxOverlapsSector` samples —
 * its four corners and its four edge midpoints, as multiples of `radius`.
 */
const BOX_RIM = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
] as const;

/**
 * Whether a `radius`-box at (x, y) overlaps `sectorIndex` at all, not just
 * whichever sector its bare centre point resolves to. A plain point test misses
 * the player standing half in a doorway.
 *
 * Still a rim approximation where vanilla walks the sector's own blockmap, but
 * sampling the same box the movement code clips (docs/movement.md § Collision)
 * rather than a circle.
 */
function boxOverlapsSector(world: World, x: number, y: number, radius: number, sectorIndex: number): boolean {
  if (world.sectorIndexAt(x, y) === sectorIndex) return true;
  for (const [dx, dy] of BOX_RIM) {
    if (world.sectorIndexAt(x + dx * radius, y + dy * radius) === sectorIndex) return true;
  }
  return false;
}

/** The gap one sector's moving plane would leave: which sector, and the two heights around it. */
interface SectorSlot {
  sectorIndex: number;
  floorHeight: number;
  ceilingHeight: number;
}

/**
 * Whether someone standing in `sectorIndex` doesn't fit in the vertical gap the
 * mover's next step would leave — `blocksCeilingLower`'s test, where the plane
 * coming down is this sector's own. Each body is measured against its **own**
 * height (`MonsterRef.height`), so a door closes on a cyberdemon well before it
 * would on an imp. docs/specials-movers.md § Every other mover stops instead.
 */
function headroomBlocked(world: World, things: ThingLayer | null, player: Pos2, slot: SectorSlot): boolean {
  const { sectorIndex, floorHeight, ceilingHeight } = slot;
  const map = world.map;
  if (
    boxOverlapsSector(world, player.x, player.y, PLAYER_RADIUS, sectorIndex) &&
    floorHeight + PLAYER_HEIGHT > ceilingHeight
  ) {
    return true;
  }
  // Nothing in the game is taller than this, so a gap that clears it clears
  // everyone — worth the early-out because it skips the sector query entirely,
  // which is the expensive half and runs per mover per tic.
  if (floorHeight + TALLEST_BODY_HEIGHT <= ceilingHeight) return false;
  const sector = map.sectors[sectorIndex];
  for (const m of things?.monstersInSector(sector) ?? []) {
    if (floorHeight + m.height > ceilingHeight) return true;
  }
  return false;
}

/**
 * The sectors a body caught by the mover in `sectorIndex` can be standing in:
 * that sector and everything across a two-sided line from it. Vanilla's
 * `P_ChangeSector` walks the blockmap blocks covering the sector's *bounding
 * box*, so a body next door is a candidate there too — and a collision box is
 * narrower than any sector, so one that reaches into the moving sector from
 * outside it is standing in a sector bordering it.
 */
function crushNeighborhood(map: DoomMap, sectorIndex: number): ReadonlySet<Sector> {
  let perMap = neighborhoods.get(map);
  if (!perMap) {
    perMap = new Map();
    neighborhoods.set(map, perMap);
  }
  let sectors = perMap.get(sectorIndex);
  if (!sectors) {
    sectors = new Set([map.sectors[sectorIndex]]);
    for (const i of neighborSectorIndices(map, sectorIndex)) sectors.add(map.sectors[i]);
    perMap.set(sectorIndex, sectors);
  }
  return sectors;
}

/**
 * `PIT_ChangeSector`'s two questions about one body: does the headroom `P_ThingHeightClip` gives it
 * here fall short of its own height, and is the mover's sector what took that headroom away.
 * Measured against the openings its box spans (`World.headroom`), never the sector's gap at its
 * centre point — a body pinned half under a descending ceiling is crushed. Height first: it rejects
 * everyone in an ordinary room for one box walk. docs/specials-crushers.md § Crushers.
 *
 * The box stays **scalars**, matching `world.headroom` and `boxOverlapsSector` — the
 * coordinate exception in docs/conventions.md § Named arguments; a record here would only move the
 * boundary one call deeper.
 */
function crushed(
  world: World,
  x: number,
  y: number,
  radius: number,
  height: number,
  sectorIndex: number,
  forMonster: boolean,
): boolean {
  return world.headroom(x, y, radius, forMonster) < height && boxOverlapsSector(world, x, y, radius, sectorIndex);
}
