import type { DoomMap } from '../wad/map.ts';
import type { Pos2 } from '../types.ts';
import type { World } from './world.ts';
import { MONSTER_HIT_HEIGHT, type ThingLayer } from './things.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from './player.ts';

/**
 * `SpecialsController`'s two obstruction callbacks. It owns the moving
 * geometry but has no idea who is standing in it, so it hands back a sector
 * index and the height its next step would put the plane at, and these answer
 * whether that step has to be refused. See docs/specials.md § Every other
 * mover stops instead.
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
 * step would leave. A flat headroom test against `PLAYER_HEIGHT`/
 * `MONSTER_HIT_HEIGHT`, this engine having no per-thing floor/ceiling clip to
 * do better with.
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
  // The gap check doesn't depend on which monster it is, so one monster in the
  // sector is enough to decide it for all of them — no need to loop.
  if (floorHeight + MONSTER_HIT_HEIGHT <= ceilingHeight) return false;
  const sector = map.sectors[sectorIndex];
  return (things?.monstersInSector(sector).length ?? 0) > 0;
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
