/**
 * The "who is standing in this mover" callbacks `SpecialsController` calls back into: crush
 * damage, and the two obstruction tests that stall or reverse a mover. It owns the moving
 * geometry but has no idea who is in it, so it hands back a sector index — plus, for the two
 * obstruction tests, the height its next step would put the plane at. See docs/specials.md
 * § Crushers and § Every other mover stops instead.
 */
import type { DoomMap, Sector } from '../../wad/map.ts';
import type { Pos2 } from '../../types.ts';
import type { World } from '../world.ts';
import type { ThingLayer } from '../things.ts';
import { TALLEST_BODY_HEIGHT } from '../monsters/tables.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../player.ts';
import { neighborSectorIndices } from '../world.ts';
import { CRUSH_DAMAGE } from './defs.ts';

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

/**
 * Whether someone standing in `sectorIndex` doesn't fit in the vertical gap the
 * mover's next step would leave — the shared test behind both obstruction
 * callbacks. Each body is measured against its **own** height
 * (`MonsterRef.height`), so a door closes on a cyberdemon well before it would
 * on an imp. docs/specials.md § Every other mover stops instead.
 */
function headroomBlocked(
  world: World,
  map: DoomMap,
  things: ThingLayer | null,
  player: Pos2,
  sectorIndex: number,
  floorHeight: number,
  ceilingHeight: number,
): boolean {
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
 * A closing door or a lowering `CeilingMover`. The sector's floor doesn't move here, so it's read
 * straight off the map.
 */
export function blocksCeilingLower(
  world: World,
  things: ThingLayer | null,
  player: Pos2,
  sectorIndex: number,
  ceilingHeight: number,
): boolean {
  const map = world.map;
  return headroomBlocked(world, map, things, player, sectorIndex, map.sectors[sectorIndex].floorHeight, ceilingHeight);
}

/**
 * A rising lift or non-crushing `FloorMover`. The sector's ceiling doesn't move
 * here, so it's read straight off the map for the monster fallback. The player
 * additionally gets `groundCeiling`'s straddle-aware overhead: standing half on
 * the rising sector and half in a lower-ceilinged neighbor, `groundFloor`
 * already pins the player's `z` to this sector's rising floor, so the
 * neighbor's own (unmoving) ceiling — not this sector's — is what would
 * actually crush them. Without this the player could be carried up into it.
 */
export function blocksFloorRise(
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
  if (headroomBlocked(world, map, things, player, sectorIndex, floorHeight, map.sectors[sectorIndex].ceilHeight)) {
    return true;
  }
  if (boxOverlapsSector(world, player.x, player.y, PLAYER_RADIUS, sectorIndex)) {
    const ceiling = world.groundCeiling(player.x, player.y, PLAYER_RADIUS);
    if (floorHeight + PLAYER_HEIGHT > ceiling) return true;
  }
  return false;
}

/** Per map, per sector: `crushNeighborhood`'s answer, memoized as `world.ts`'s `sectorLines` is. */
const neighborhoods = new WeakMap<DoomMap, Map<number, Set<Sector>>>();

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
 * `PIT_ChangeSector`'s own two questions about one body: does the headroom
 * `P_ThingHeightClip` gives it here fall short of its own height, and is the
 * mover's sector what took that headroom away. Measured against the openings
 * its box spans (`World.headroom`), never against the sector's own gap at its
 * centre point — the body pinned half under a descending ceiling is the case
 * that distinguishes the two, and it is crushed.
 *
 * Height first: it rejects everyone standing in an ordinary room for one box
 * walk, leaving the eight-point sector sampling to the few actually squeezed.
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

/**
 * `SpecialsController`'s `onCrush` callback: deals `CRUSH_DAMAGE` to the player
 * and to every crushable body the sector's own moving plane has left without
 * the headroom to stand in. Gated on `PIT_ChangeSector`'s actual "doesn't fit"
 * test, not merely standing in the sector — a crusher parked at the top of its
 * travel, or one that hasn't reached anyone yet, must not deal damage — and
 * that test is each body's clipped headroom, so a body straddling the sector's
 * edge is crushed like one standing squarely in it (docs/specials.md §
 * Crushers). Monsters and barrels share one loop, matching `PIT_ChangeSector`
 * treating any shootable mobj the same.
 */
export function applyCrushDamage(
  world: World,
  things: ThingLayer | null,
  player: Pos2,
  sectorIndex: number,
  damagePlayer: (amount: number) => void,
  dealDamage: boolean,
  /**
   * The level's voodoo dolls: each is a player mobj, so a crusher catching one hurts the real
   * player.
   */
  dolls: readonly Pos2[] = [],
): boolean {
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
    // as vanilla's per-mobj loop does. docs/specials.md § Voodoo dolls.
    for (const body of dolls) {
      if (!crushed(world, body.x, body.y, PLAYER_RADIUS, PLAYER_HEIGHT, sectorIndex, false)) continue;
      caught = true;
      if (dealDamage) damagePlayer(CRUSH_DAMAGE);
    }
    if (crushed(world, player.x, player.y, PLAYER_RADIUS, PLAYER_HEIGHT, sectorIndex, false)) {
      caught = true;
      if (dealDamage) damagePlayer(CRUSH_DAMAGE);
    }
  }
  if (gap < TALLEST_BODY_HEIGHT) {
    for (const m of things?.crushablesInSectors(crushNeighborhood(map, sectorIndex)) ?? []) {
      // Per body, not one shared band: a barrel is 42 tall against a
      // cyberdemon's 110, so the ceiling reaches them at very different points
      // of the same descent.
      if (!crushed(world, m.x, m.y, m.radius, m.height, sectorIndex, true)) continue;
      caught = true;
      if (dealDamage) things?.damage(m.id, CRUSH_DAMAGE);
    }
  }
  return caught;
}
