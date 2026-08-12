import type { DoomMap } from '../wad/map.ts';
import type { Pos2 } from '../types.ts';
import type { World } from './world.ts';
import type { ThingLayer } from './things.ts';
import { TALLEST_BODY_HEIGHT } from './monsters/defs.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';
import { CRUSH_DAMAGE } from '../wad/specials.ts';

/**
 * `SpecialsController`'s three "who is standing in this mover" callbacks. It
 * owns the moving geometry but has no idea who is in it, so it hands back a
 * sector index — plus, for the two obstruction tests, the height its next step
 * would put the plane at — and these answer whether that step has to be
 * refused, or who a crusher just caught. See docs/specials.md § Every other
 * mover stops instead and § Crushers.
 */

/**
 * Whether a `radius`-circle at (x, y) overlaps `sectorIndex` at all, not just
 * whichever sector its bare center point resolves to — a rim-sample ring, the
 * same approximation `FogOfWar` uses. A plain point test misses the player
 * standing half in a doorway.
 */
function circleOverlapsSector(world: World, x: number, y: number, radius: number, sectorIndex: number): boolean {
  if (world.sectorIndexAt(x, y) === sectorIndex) return true;
  const RIM_SAMPLES = 8;
  for (let i = 0; i < RIM_SAMPLES; i++) {
    const angle = (i / RIM_SAMPLES) * Math.PI * 2;
    const sx = x + Math.cos(angle) * radius;
    const sy = y + Math.sin(angle) * radius;
    if (world.sectorIndexAt(sx, sy) === sectorIndex) return true;
  }
  return false;
}

/**
 * Vanilla's `T_MovePlane`/`PIT_ChangeSector` "un-crush" rule: whoever's
 * standing in `sectorIndex` doesn't fit in the vertical gap the mover's next
 * step would leave. Each body is measured against its **own**
 * `mobjinfo.height` (`MonsterRef.height`), so a door closes on a cyberdemon
 * well before it would on an imp.
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
    circleOverlapsSector(world, player.x, player.y, PLAYER_RADIUS, sectorIndex) &&
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

/** A closing door or a lowering `CeilingMover`. The sector's floor doesn't move here, so it's read straight off the map. */
export function blocksCeilingLower(
  world: World,
  map: DoomMap,
  things: ThingLayer | null,
  player: Pos2,
  sectorIndex: number,
  ceilingHeight: number,
): boolean {
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
  map: DoomMap,
  things: ThingLayer | null,
  player: Pos2,
  sectorIndex: number,
  floorHeight: number,
): boolean {
  if (headroomBlocked(world, map, things, player, sectorIndex, floorHeight, map.sectors[sectorIndex].ceilHeight)) {
    return true;
  }
  if (circleOverlapsSector(world, player.x, player.y, PLAYER_RADIUS, sectorIndex)) {
    const ceiling = world.groundCeiling(player.x, player.y, PLAYER_RADIUS);
    if (floorHeight + PLAYER_HEIGHT > ceiling) return true;
  }
  return false;
}

/**
 * `SpecialsController`'s `onCrush` callback: deals `CRUSH_DAMAGE` to the player
 * and to every crushable thing in `sectorIndex` that the sector's current
 * headroom doesn't fit. Gated on `PIT_ChangeSector`'s actual "doesn't fit"
 * test, not merely standing in the sector — a crusher parked at the top of its
 * travel, or one that hasn't reached anyone yet, must not deal damage.
 * Monsters and barrels share one loop, matching `PIT_ChangeSector` treating
 * any shootable mobj the same. 2D membership only; the deliberately cheap
 * point test is docs/specials.md § Crushers, which also says why it isn't
 * `circleOverlapsSector`.
 */
export function applyCrushDamage(
  world: World,
  map: DoomMap,
  things: ThingLayer | null,
  player: Pos2,
  sectorIndex: number,
  damagePlayer: (amount: number) => void,
  dealDamage: boolean,
): boolean {
  const sector = map.sectors[sectorIndex];
  const gap = sector.ceilHeight - sector.floorHeight;
  // `nofit`: something shootable is in the sector and doesn't fit the gap. It is
  // reported whether or not this tic is a damage tic, because the crusher
  // slowdown keys off it every tic — see `SpecialsController.tickCrush`.
  let caught = false;
  if (gap < PLAYER_HEIGHT && world.sectorIndexAt(player.x, player.y) === sectorIndex) {
    caught = true;
    if (dealDamage) damagePlayer(CRUSH_DAMAGE);
  }
  if (gap < TALLEST_BODY_HEIGHT) {
    for (const m of things?.crushablesInSector(sector) ?? []) {
      // Per body, not one shared band: a barrel is 42 tall against a
      // cyberdemon's 110, so the ceiling reaches them at very different points
      // of the same descent.
      if (gap >= m.height) continue;
      caught = true;
      if (dealDamage) things?.damage(m.id, CRUSH_DAMAGE);
    }
  }
  return caught;
}
