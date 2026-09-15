/**
 * A deathmatch map's backstage — monster closets, control sectors, the storage a mapper walls off —
 * found once at load, so the fog keeps it off the screen while everything a player can get to is
 * shown. docs/fogofwar.md § Arena.
 */
import {
  buildLeafGraph,
  buildSubSectorPolys,
  forEachSegCrossing,
  probeBeside,
  subsectorAtPoint,
} from '../../render/bsp.ts';
import type { MidCover } from '../../render/midcover.ts';
import type { Pos2 } from '../../types.ts';
import { UnionFind } from '../../util/unionfind.ts';
import { NO_SIDE, type DoomMap } from '../../wad/map.ts';
import { isPickup } from '../inventory.ts';
import { START_TYPES } from '../playerstarts.ts';
import { isNotDeathmatch } from '../skill.ts';
import { resolveTargets } from '../specials/mapscan.ts';
import { lookupSpecial } from '../specials/tables.ts';
import { ThingType } from '../things/doomednums.ts';
import { NOT_DEATHMATCH_TYPES } from '../things/tables.ts';
import { linesByTag, type Opening, type World } from '../world.ts';

/** What {@link findBackstage} reads beyond the level. */
export interface BackstageOptions {
  /** Sectors a special can drive (`scanSectors`' `movable`). */
  movableSectors: ReadonlySet<number>;
  /** The midtextures that hide what is past them; a line one covers parts two places. */
  cover: MidCover | null;
  /** Where the players stand, reached like the map's own starts. */
  starts: readonly Pos2[];
  /**
   * Whether a leaf is permanently solid (`FogOfWar.closedTarget`): seen whole from beside it.
   * docs/fogofwar.md § Closed sectors.
   */
  closed: (leaf: number) => boolean;
}

/** A two-sided line sight passes and no midtexture covers. */
const OPEN = 0;
/** A two-sided line with no vertical opening — {@link World.blocksSight}. */
const SHUT = 1;
/** A two-sided line sight passes and a midtexture hides from one side. */
const COVERED = 2;

/**
 * The leaves no player is meant to see: every place (a region sight flows through) not reached from
 * a player or deathmatch start across a mover opened on purpose or a player teleporter, and not on
 * the way to one holding a pickup; a solid block beside a reached place is not backstage.
 * docs/fogofwar.md § Arena.
 *
 * @returns per leaf, 1 for backstage — degenerate leaves included, which draw nothing anyway
 */
export function findBackstage(world: World, options: BackstageOptions): Uint8Array {
  const map = world.map;
  const places = placesOf(world, options.cover);
  const { place, crossings } = places;
  const stage = stageOf(world, places, options.movableSectors);

  const seeds: number[] = [];
  const pickups = new Uint8Array(places.count);
  for (const t of map.things) {
    const ss = subsectorAtPoint(map, t.x, t.y);
    if (ss < 0) continue;
    if (START_TYPES.includes(t.type) || t.type === ThingType.deathmatchStart) {
      seeds.push(place[ss]);
    } else if (isPickup(t.type) && !NOT_DEATHMATCH_TYPES.has(t.type) && !isNotDeathmatch(t.flags)) {
      pickups[place[ss]] = 1;
    }
  }
  for (const at of options.starts) {
    const ss = subsectorAtPoint(map, at.x, at.y);
    if (ss >= 0) seeds.push(place[ss]);
  }
  const reached = reachedPlaces(stage, seeds, pickups);

  const backstage = new Uint8Array(place.length);
  for (let ss = 0; ss < place.length; ss++) backstage[ss] = reached[place[ss]] ? 0 : 1;
  // Seeing a solid block from outside is all there is to seeing it.
  // docs/fogofwar.md § Closed sectors.
  for (let k = 0; k < crossings.length; k += 3) {
    const a = crossings[k + 1];
    const b = crossings[k + 2];
    if (reached[place[b]] && options.closed(a)) {
      backstage[a] = 0;
    }
    if (reached[place[a]] && options.closed(b)) {
      backstage[b] = 0;
    }
  }
  return backstage;
}

/** The map parted into places, and the lines between them. */
interface Places {
  /** Per leaf, its place as a dense id. */
  place: Int32Array;
  /** How many places there are. */
  count: number;
  /** Every two-sided seg with a different leaf either side: flat `line, leaf, leaf` triples. */
  crossings: number[];
  /** Per line, {@link OPEN}, {@link SHUT} or {@link COVERED}. */
  kinds: Uint8Array;
}

/**
 * The places and the ways between them. Lists may repeat an entry: a line is crossed once per seg,
 * and the walk skips what it has already reached.
 */
interface Stage {
  /** Per place, the places a shut or covered line borders — any way at all. */
  joined: number[][];
  /** Per place, the places a mover opened on purpose leads to. */
  opened: number[][];
  /** Per place, where its player teleporters land. */
  leads: number[][];
}

/**
 * Leaves joined across {@link OPEN} lines and across the BSP splits inside one sector, as the level
 * stands now.
 */
function placesOf(world: World, cover: MidCover | null): Places {
  const map = world.map;
  const polys = buildSubSectorPolys(map);
  const kinds = lineKinds(world, cover);
  const crossings: number[] = [];
  const sets = new UnionFind(polys.length);
  forEachSegCrossing(map, (_leaf, line, left, right) => {
    if (left < 0 || right < 0 || left === right) return;
    crossings.push(line, left, right);
    if (kinds[line] === OPEN) sets.union(left, right);
  });
  const graph = buildLeafGraph(map);
  for (let i = 0; i < polys.length; i++) {
    for (let k = graph.starts[i]; k < graph.starts[i + 1]; k++) {
      const j = graph.leaves[k];
      if (polys[i].physicalSector === polys[j].physicalSector) sets.union(i, j);
    }
  }
  return { place: sets.ids(), count: sets.count, crossings, kinds };
}

/** Per line, {@link OPEN}, {@link SHUT} or {@link COVERED}, as the level stands now. */
function lineKinds(world: World, cover: MidCover | null): Uint8Array {
  const map = world.map;
  const kinds = new Uint8Array(map.linedefs.length);
  const opening: Opening = { top: 0, bottom: 0 };
  for (let i = 0; i < kinds.length; i++) {
    const line = map.linedefs[i];
    if (line.left === NO_SIDE || line.right === NO_SIDE) continue;
    if (world.blocksSight(i)) {
      kinds[i] = SHUT;
    } else if (cover !== null && cover.candidate(i) && world.openingInto(i, opening)) {
      if (cover.hidesEitherSide(i, opening.bottom, opening.top)) kinds[i] = COVERED;
    }
  }
  return kinds;
}

/** The ways between places: shut and covered lines, movers opened on purpose, player teleporters. */
function stageOf(world: World, places: Places, movable: ReadonlySet<number>): Stage {
  const map = world.map;
  const { place, count, crossings, kinds } = places;
  const stage: Stage = {
    joined: Array.from({ length: count }, () => []),
    opened: Array.from({ length: count }, () => []),
    leads: Array.from({ length: count }, () => []),
  };
  const onPurpose = openedOnPurpose(map, movable);
  for (let k = 0; k < crossings.length; k += 3) {
    const kind = kinds[crossings[k]];
    const from = place[crossings[k + 1]];
    const to = place[crossings[k + 2]];
    if (kind === OPEN || from === to) continue;
    stage.joined[from].push(to);
    stage.joined[to].push(from);
    const line = map.linedefs[crossings[k]];
    const front = map.sidedefs[line.right]?.sector ?? -1;
    const back = map.sidedefs[line.left]?.sector ?? -1;
    if (kind === SHUT && (onPurpose.has(front) || onPurpose.has(back))) {
      stage.opened[from].push(to);
      stage.opened[to].push(from);
    }
  }

  const beside = (lineIndex: number): number[] => {
    const line = map.linedefs[lineIndex];
    const a = map.vertexes[line.v1];
    const b = map.vertexes[line.v2];
    const left = probeBeside(map, a, b, 1);
    const right = probeBeside(map, a, b, -1);
    return left < 0 || right < 0 || left === right ? [] : [place[left], place[right]];
  };
  // Filed once, in map order, rather than every thing scanned per teleporter.
  const markers: { sector: number; place: number }[] = [];
  for (const t of world.thingsOfType(ThingType.teleportDest)) {
    const ss = subsectorAtPoint(map, t.x, t.y);
    if (ss >= 0) markers.push({ sector: world.sectorIndexAt(t.x, t.y), place: place[ss] });
  }
  for (let i = 0; i < map.linedefs.length; i++) {
    const line = map.linedefs[i];
    const def = lookupSpecial(line.special);
    if (!def) continue;
    const effect = def.effect;
    if (effect.kind !== 'teleport' || effect.monsterOnly) continue;
    const landings: number[] = [];
    if (effect.destination === 'line') {
      for (const j of linesByTag(map, line.tag)) {
        const exit = map.linedefs[j];
        if (j === i || exit.left === NO_SIDE || exit.right === NO_SIDE) continue;
        landings.push(...beside(j));
      }
    } else {
      const sectors = new Set(resolveTargets(map, line, def));
      for (const marker of markers) {
        if (sectors.has(marker.sector)) landings.push(marker.place);
      }
    }
    for (const from of beside(i)) {
      for (const to of landings) {
        if (from !== to) stage.leads[from].push(to);
      }
    }
  }
  return stage;
}

/**
 * The movable sectors a player opens on purpose: by a use or shoot line anywhere, or by any line on
 * the mover's own boundary. A walk line elsewhere is an ambush's trigger and opens nothing here.
 */
function openedOnPurpose(map: DoomMap, movable: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const line of map.linedefs) {
    const def = lookupSpecial(line.special);
    if (!def || def.effect.kind === 'teleport') continue;
    const front = map.sidedefs[line.right]?.sector ?? -1;
    const back = line.left === NO_SIDE ? -1 : (map.sidedefs[line.left]?.sector ?? -1);
    for (const target of resolveTargets(map, line, def)) {
      if (!movable.has(target)) continue;
      if (def.trigger !== 'walk' || target === front || target === back) {
        out.add(target);
      }
    }
  }
  return out;
}

/**
 * Which places the players reach: from the seeds across {@link Stage.opened} and
 * {@link Stage.leads}, then every place holding a pickup along the shortest way of any kind, with
 * what opens from there.
 *
 * @param pickups  per place, 1 where a pickup that spawns in a deathmatch lies
 */
function reachedPlaces(stage: Stage, seeds: readonly number[], pickups: Uint8Array): Uint8Array {
  const reached = new Uint8Array(stage.joined.length);
  const stack: number[] = [];
  for (const seed of seeds) {
    if (reached[seed]) continue;
    reached[seed] = 1;
    stack.push(seed);
  }
  spread(stage, reached, stack);

  const from = new Int32Array(reached.length).fill(-1);
  const queue: number[] = [];
  for (let p = 0; p < reached.length; p++) {
    if (!reached[p]) continue;
    from[p] = p;
    queue.push(p);
  }
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    for (const ways of [stage.joined[p], stage.leads[p]]) {
      for (const q of ways) {
        if (from[q] >= 0) continue;
        from[q] = p;
        queue.push(q);
        if (!pickups[q]) continue;
        for (let x = q; !reached[x]; x = from[x]) {
          reached[x] = 1;
          stack.push(x);
        }
      }
    }
  }
  spread(stage, reached, stack);
  return reached;
}

/** Marks everything the places on `stack` open onto or teleport to, emptying it. */
function spread(stage: Stage, reached: Uint8Array, stack: number[]): void {
  while (stack.length > 0) {
    const p = stack.pop()!;
    for (const ways of [stage.opened[p], stage.leads[p]]) {
      for (const q of ways) {
        if (reached[q]) continue;
        reached[q] = 1;
        stack.push(q);
      }
    }
  }
}
