import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { ITEM_RESPAWN_QUEUE, ITEM_RESPAWN_TICS } from '../../src/game/things/defs.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { CEILING_HUNG_HEIGHT } from '../../src/game/things/tables.ts';
import { applyPickup, createInventory, giveAllKeys } from '../../src/game/inventory.ts';
import { KEY_SLOTS } from '../../src/game/inventory/defs.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Pos3 } from '../../src/types.ts';
import type { ThingsSnapshot } from '../../src/game/snapshot.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { savedThing } from '../fixtures/snapshot.ts';

/**
 * What a deathmatch changes in the thing layer and the inventory: the spawn filter, the item
 * respawn queue, every key. docs/multiplayer-deathmatch.md § Rules, § Item respawn.
 */

/** Boom's `MTF_NOTDM`, `MTF_NOTCOOP` and `MTF_RESERVED` (`doomdef.h`), over the three skill bits. */
const NOT_DM = 32;
const NOT_COOP = 64;
const RESERVED = 256;

/** A room of `things`, built under the given netgame/deathmatch, and every spawned type. */
function spawned(things: [type: number, flags?: number][], options: { netgame?: boolean; deathmatch?: boolean }) {
  const grid = gridMap(['########', '#......#', '########'], { cell: 128 });
  things.forEach(([type, flags = 7], i) => grid.map.things.push({ ...thingAt(grid, 1 + i, 1, type), flags }));
  const layer = buildThingSprites(new World(grid.map), { bank: BANK, materials: MATERIALS, skill: 3, ...options });
  return { layer, grid };
}

describe('Deathmatch · what spawns', () => {
  test('no monster, no lost soul, no key; everything else as in coop', () => {
    const { layer } = spawned(
      [[ThingType.imp], [ThingType.lostSoul], [ThingType.blueKeycard], [ThingType.shotgun], [ThingType.barrel]],
      { netgame: true, deathmatch: true },
    );
    assert.equal(layer.count, 2, 'the shotgun and the barrel');
    assert.equal(layer.stats.totalKills, 0);
  });

  test("Boom's not-in-deathmatch and not-in-coop flags, void under the reserved bit", () => {
    const types: [number, number][] = [
      [ThingType.shotgun, 7 | NOT_DM],
      [ThingType.chaingun, 7 | NOT_COOP],
      [ThingType.plasmaRifle, 7 | NOT_DM | NOT_COOP | RESERVED],
    ];
    assert.equal(spawned(types, { netgame: true, deathmatch: true }).layer.count, 2, 'deathmatch: the chaingun and the reserved one');
    assert.equal(spawned(types, { netgame: true }).layer.count, 2, 'coop: the shotgun and the reserved one');
    assert.equal(spawned(types, {}).layer.count, 3, 'single player reads neither bit');
  });
});

describe('Deathmatch · every key', () => {
  test('a spawn holds all six keys, and a placed weapon is taken like any other pickup', () => {
    const inv = createInventory();
    giveAllKeys(inv);
    assert.deepEqual([...inv.keys].sort(), [...KEY_SLOTS].sort());
    assert.equal(applyPickup(inv, ThingType.shotgun, { weaponsStay: false }), true);
    assert.equal(applyPickup(inv, ThingType.shotgun, { weaponsStay: false }), true, 'again: its ammo');
    assert.equal(applyPickup(inv, ThingType.shotgun, { weaponsStay: true }), false, 'coop leaves it');
  });
});

describe('Deathmatch · item respawn', () => {
  /** A stimpack, a shotgun and a berserk in a row, and the player standing on whichever is asked. */
  function rig(deathmatch = true) {
    const returned: Pos3[] = [];
    const grid = gridMap(['########', '#......#', '########'], { cell: 128 });
    const items = [ThingType.stimpack, ThingType.shotgun, ThingType.berserk, ThingType.invulnerability];
    items.forEach((type, i) => grid.map.things.push(thingAt(grid, 1 + i, 1, type)));
    const world = new World(grid.map);
    const layer = buildThingSprites(world, {
      bank: BANK,
      materials: MATERIALS,
      skill: 3,
      netgame: true,
      deathmatch,
      onItemRespawn: (at) => returned.push(at),
    });
    const player: Pos3 = { ...grid.centre(6, 1), z: 0 };
    const take = (id: number) => {
      const at = { ...grid.centre(1 + id, 1), z: 0 };
      layer.tryPickup(at, at, 24, (type) => type === items[id]);
    };
    const tics = (n: number) => {
      for (let i = 0; i < n; i++) layer.update(DOOM_TIC, [player]);
    };
    return { layer, returned, take, tics, grid };
  }

  test('a taken item comes back at its spawn point after 30 seconds, with its fog', () => {
    const { layer, returned, take, tics, grid } = rig();
    take(0);
    assert.equal(savedThing(layer.snapshot(), 0)?.picked, true);
    assert.deepEqual(layer.snapshot().itemRespawn, [[0, 0]]);
    tics(ITEM_RESPAWN_TICS - 1);
    assert.equal(returned.length, 0, 'not a tic early');
    tics(1);
    assert.equal(returned.length, 1);
    assert.deepEqual(returned[0], { ...grid.centre(1, 1), z: 0 });
    assert.equal(savedThing(layer.snapshot(), 0), undefined, 'as the map spawned it again');
    assert.equal(layer.snapshot().itemRespawn, undefined, 'the queue is elided when empty');
  });

  test("a ceiling-hung item's fog stands on the floor, as P_RespawnSpecials spawns it", () => {
    CEILING_HUNG_HEIGHT[ThingType.stimpack] = 16;
    try {
      // Hung 16 below the room's 128 ceiling at spawn (`CEILING_HUNG_HEIGHT`'s spawn rule), so the
      // fog's z below tells the floor from the item's own height.
      const { layer, returned, take, tics, grid } = rig();
      take(0);
      assert.equal(savedThing(layer.snapshot(), 0)?.picked, true);
      tics(ITEM_RESPAWN_TICS);
      assert.deepEqual(returned, [{ ...grid.centre(1, 1), z: 0 }]);
    } finally {
      delete CEILING_HUNG_HEIGHT[ThingType.stimpack];
    }
  });

  test('one item a tic, oldest first; the two spheres never queue; coop queues nothing', () => {
    const { layer, returned, take, tics } = rig();
    take(1);
    tics(5);
    take(0);
    take(3);
    assert.deepEqual(layer.snapshot().itemRespawn, [[1, 0], [0, 5]], 'the invulnerability is not remembered');
    tics(ITEM_RESPAWN_TICS - 5);
    assert.equal(returned.length, 1, 'the shotgun, taken first');
    tics(5);
    assert.equal(returned.length, 2);
    const coop = rig(false);
    coop.take(0);
    assert.equal(coop.layer.snapshot().itemRespawn, undefined);
    coop.tics(ITEM_RESPAWN_TICS + 1);
    assert.equal(coop.returned.length, 0);
  });

  test('the ring keeps the newest 128; a restore continues the queue', () => {
    const grid = gridMap(['#'.repeat(140), '#' + '.'.repeat(138) + '#', '#'.repeat(140)], { cell: 64 });
    for (let i = 0; i < ITEM_RESPAWN_QUEUE + 1; i++) grid.map.things.push(thingAt(grid, 1 + i, 1, ThingType.stimpack));
    const world = new World(grid.map);
    const build = (restore?: ThingsSnapshot) =>
      buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3, netgame: true, deathmatch: true, restore });
    const layer = build();
    for (let i = 0; i < ITEM_RESPAWN_QUEUE + 1; i++) {
      const at = { ...grid.centre(1 + i, 1), z: 0 };
      layer.tryPickup(at, at, 24, () => true);
    }
    const queue = layer.snapshot().itemRespawn!;
    assert.equal(queue.length, ITEM_RESPAWN_QUEUE);
    assert.equal(queue[0][0], 1, 'the first taken was dropped off the end');
    const back = build(JSON.parse(JSON.stringify(layer.snapshot())));
    assert.deepEqual(back.snapshot().itemRespawn, queue);
  });
});
