/**
 * The open room the thing layer's player-targeting tests stand in: monsters down its east wall
 * facing west, every one's look rotation restored to 0 over the spawn draw.
 * docs/testing.md § Shared helpers.
 */
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { gridMap, thingAt } from './gridmap.ts';
import { BANK, MATERIALS } from './spritestubs.ts';

/**
 * The room with `types` spawned down column 5, its world, and the thing layer over it.
 *
 * @returns also `kills`, every slot `ThingLayerOptions.onKill` was told of, in order
 */
export function monsterArena(types: readonly number[], options: { netgame?: boolean } = {}) {
  const { netgame = false } = options;
  const kills: number[] = [];
  const grid = gridMap(['#######', '#.....#', '#.....#', '#.....#', '#######'], { cell: 128 });
  types.forEach((type, i) => grid.map.things.push(thingAt(grid, 5, 1 + i, type, 180)));
  const world = new World(grid.map);
  const restore = {
    clock: 0,
    stats: { totalKills: types.length, kills: 0, totalItems: 0, items: 0 },
    changed: [],
    lastlook: '0'.repeat(types.length),
  };
  const onKill = (slot: number) => kills.push(slot);
  const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3, netgame, restore, onKill });
  return { grid, world, layer, kills };
}
