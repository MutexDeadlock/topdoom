import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { targetOfSlot } from '../../src/game/things/defs.ts';
import { MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { applyPickup, createInventory, leftInNetgame } from '../../src/game/inventory.ts';
import { SectorEffects } from '../../src/game/specials.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { isLoadableState } from '../../src/game/savegames.ts';
import { IDLE_TIC_INPUT, respawnPressed } from '../../src/game/input.ts';
import { BOUND_KEYS } from '../../src/game/replay.ts';
import { RowInput } from '../../src/game/replay/row.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { monsterArena } from '../fixtures/arena.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { specialsRig } from '../fixtures/specialsrig.ts';

/**
 * The rules a netgame changes, and the per-slot state a coop save carries.
 * docs/multiplayer-coop.md.
 */

/** `THINGS` flag bit 16, `MTF_NOTSINGLE`. */
const MULTIPLAYER_ONLY = 16;

/** `monsterArena`, with its cells as floor positions. */
function room(netgame: boolean, ...types: number[]) {
  const arena = monsterArena(types, { netgame });
  const at = (col: number, row: number) => ({ ...arena.grid.centre(col, row), z: 0 });
  return { ...arena, at };
}

/** A monster's saved block — every field still at its default is elided. */
function monsterBlock(layer: ReturnType<typeof room>['layer'], id: number) {
  return layer.snapshot().changed.find(([i]) => i === id)?.[1].monster;
}

describe('Coop · netgame things', () => {
  test('a multiplayer-only thing spawns in a netgame and nowhere else', () => {
    const spawned = (netgame: boolean) => {
      const grid = gridMap(['#####', '#...#', '#####'], { cell: 128 });
      grid.map.things.push({ ...thingAt(grid, 2, 1, ThingType.zombieman), flags: 7 | MULTIPLAYER_ONLY });
      return buildThingSprites(new World(grid.map), { bank: BANK, materials: MATERIALS, skill: 3, netgame }).stats
        .totalKills;
    };
    assert.equal(spawned(false), 0);
    assert.equal(spawned(true), 1);
  });

  test("a monster's kill counts only in single player; a player's counts in both", () => {
    for (const netgame of [false, true]) {
      const { layer } = room(netgame, ThingType.zombieman, ThingType.imp);
      layer.damage(0, MONSTER_HEALTH[ThingType.zombieman], { source: { id: 1, type: ThingType.imp } });
      assert.equal(layer.stats.kills, netgame ? 0 : 1, `netgame ${netgame}: killed by the imp`);
      layer.damage(1, MONSTER_HEALTH[ThingType.imp], { slot: 0 });
      assert.equal(layer.stats.kills, netgame ? 1 : 2, `netgame ${netgame}: killed by a player`);
    }
  });

  test("a kill counts as its player's own; single player counts none apart", () => {
    const types = [ThingType.zombieman, ThingType.imp, ThingType.demon];
    const killAll = (layer: ReturnType<typeof room>['layer'], slot: number) => {
      layer.damage(0, MONSTER_HEALTH[ThingType.zombieman], { slot });
      layer.damage(1, MONSTER_HEALTH[ThingType.imp], { source: { id: 2, type: ThingType.demon } });
      layer.damage(2, MONSTER_HEALTH[ThingType.demon]);
    };
    const net = room(true, ...types);
    killAll(net.layer, 1);
    assert.deepEqual(net.kills, [1], "the demon's and the crusher's are nobody's");

    const single = room(false, ...types);
    killAll(single.layer, 0);
    assert.deepEqual(single.kills, [], "player 1's are the level's own count");
  });

  test("a barrel's blast carries whoever killed it, player or monster, through a save", () => {
    const { layer, grid } = room(true, ThingType.barrel, ThingType.barrel);
    const imp = { id: 7, type: ThingType.imp };
    layer.damage(0, 10_000, { slot: 1 });
    layer.damage(1, 10_000, { source: imp });
    assert.deepEqual(monsterBlock(layer, 0)?.explodeSource, { id: targetOfSlot(1), type: 0 }, 'as a projectile holds its shooter');
    const restored = buildThingSprites(new World(grid.map), {
      bank: BANK,
      materials: MATERIALS,
      skill: 3,
      netgame: true,
      restore: layer.snapshot(),
    });
    let blasts: { source?: { id: number; type: number }; slot?: number }[] = [];
    for (let tic = 0; tic < 70 && blasts.length === 0; tic++) blasts = restored.update(DOOM_TIC, [null]).barrelExplosions;
    assert.deepEqual(
      blasts.map(({ source, slot }) => ({ source, slot })),
      [
        { source: undefined, slot: 1 },
        { source: imp, slot: undefined },
      ],
    );
  });
});

describe('Coop · target choice', () => {
  test('a player’s hit takes over a monster hunting a player, and leaves one infighting alone', () => {
    const { layer } = room(true, ThingType.zombieman, ThingType.imp);
    layer.damage(0, 1, { slot: 1 });
    assert.equal(monsterBlock(layer, 0)?.targetId, targetOfSlot(1));
    layer.damage(1, 1, { source: { id: 0, type: ThingType.zombieman } });
    layer.damage(1, 1, { slot: 1 });
    assert.equal(monsterBlock(layer, 1)?.targetId, 0, 'still after the zombieman');
  });

  test('a monster whose player dies goes after another it can see', () => {
    const { layer, at } = room(true, ThingType.zombieman);
    layer.damage(0, 1, { slot: 1 });
    const one = at(1, 1);
    const two = at(1, 3);
    layer.update(DOOM_TIC, [one, two]);
    assert.equal(monsterBlock(layer, 0)?.targetId, targetOfSlot(1));
    layer.update(DOOM_TIC, [one, null]);
    assert.equal(monsterBlock(layer, 0)?.targetId, undefined, 'player 1, the elided default');
    assert.equal(monsterBlock(layer, 0)?.alerted, true);
  });

  test("a sector remembers whose noise last reached it, and the save carries it", () => {
    const { grid, world, at } = room(true);
    const one = at(1, 1);
    world.noiseAlert(one.x, one.y, 2);
    const sector = world.sectorAt(one.x, one.y)!;
    assert.equal(world.soundTargetOf(sector), 2);
    world.noiseAlert(one.x, one.y, 1);
    assert.equal(world.soundTargetOf(sector), 1, 'the later noise wins');
    const restored = new World(grid.map);
    restored.restoreSoundAlerted(JSON.parse(JSON.stringify(world.snapshotSoundAlerted())));
    assert.equal(restored.soundTargetOf(restored.sectorAt(one.x, one.y)!), 1);
  });
});

describe('Coop · netgame pickups', () => {
  test('a placed weapon gives a player who owns it nothing, not even its ammo', () => {
    const inv = createInventory();
    assert.equal(applyPickup(inv, ThingType.shotgun, { weaponsStay: true }), true, 'the first one');
    assert.equal(inv.currentWeapon, 'shotgun');
    const shells = inv.ammo.shells;
    assert.equal(applyPickup(inv, ThingType.shotgun, { weaponsStay: true }), false);
    assert.equal(inv.ammo.shells, shells);
    assert.equal(applyPickup(inv, ThingType.shotgun, { weaponsStay: true, dropped: true }), true, 'a drop still gives');
  });

  test('keys and, where weapons stay, placed weapons stay where they lie; drops and everything else go', () => {
    assert.equal(leftInNetgame(ThingType.redSkullKey, false, true), true);
    assert.equal(leftInNetgame(ThingType.redSkullKey, false, false), true, 'a key stays in any netgame');
    assert.equal(leftInNetgame(ThingType.shotgun, false, true), true);
    assert.equal(leftInNetgame(ThingType.shotgun, false, false), false, 'a deathmatch takes it');
    assert.equal(leftInNetgame(ThingType.shotgun, true, true), false);
    assert.equal(leftInNetgame(ThingType.clip, false, true), false);
  });
});

describe('Coop · respawn', () => {
  test("a corpse's own row respawns it on R or use, on every browser that runs the row", () => {
    const row = (code: string) => {
      const input = new RowInput({ rightMouse: 'previousweapon' });
      input.row.pressed = 1 << BOUND_KEYS.indexOf(code);
      return input;
    };
    // Read only for the local slot, a guest's R respawned them on their own browser alone: a
    // desync, and the host's resync laid the body down again.
    assert.equal(respawnPressed(row('KeyR')), true, "another browser's player pressing R");
    assert.equal(respawnPressed(row('Space')), true);
    assert.equal(respawnPressed(row('KeyW')), false);
    assert.equal(respawnPressed(IDLE_TIC_INPUT), false, 'a slot nobody drives stays down');
  });
});

describe('Coop · per-slot saves', () => {
  test('damage-floor timers save and restore per slot', () => {
    const { grid } = room(true);
    const effects = new SectorEffects(grid.map, 2);
    effects.restore({ secretsFound: 1, timers: [0.5, 0.25] });
    assert.deepEqual(JSON.parse(JSON.stringify(effects.snapshot())), { secretsFound: 1, timers: [0.5, 0.25] });
  });

  test("every slot's walk-trigger start saves and restores", () => {
    const { grid, at } = room(true);
    const rig = specialsRig(grid.map, at(1, 1));
    const saved = rig.specials.snapshot();
    assert.deepEqual(saved.prev, [[at(1, 1).x, at(1, 1).y]]);
    rig.specials.restore({ ...saved, prev: [[10, 20]] });
    assert.deepEqual(rig.specials.snapshot().prev, [[10, 20]]);
  });

  test('a snapshot of the one-player shape before coop is refused', () => {
    const rng = { p: 0, m: 0 };
    assert.equal(isLoadableState({ player: { x: 0 }, rng }), false);
    assert.equal(isLoadableState({ players: [], rng }), false);
    assert.equal(isLoadableState({ players: [{ player: { x: 0 } }], rng }), true);
    assert.equal(isLoadableState({ players: Array(5).fill({ player: { x: 0 } }), rng }), false, 'more slots than starts');
  });
});

describe('Coop · shared fog', () => {
  test('what another player sees is revealed for everyone', () => {
    // Two rooms behind one wall, joined along the bottom row: one island, out of each other's
    // sight.
    const grid = gridMap(['#########', '#...#...#', '#...#...#', '#.......#', '#########'], { cell: 128 });
    const world = new World(grid.map);
    const a = grid.centre(1, 1);
    const b = grid.centre(7, 1);
    const far = world.subsectorAt(b.x, b.y);
    const alone = new FogOfWar(world, [], [a], 0);
    for (let tic = 0; tic < 20; tic++) alone.tick([a]);
    assert.equal(alone.isVisible(far), false, 'out of sight from the local player');
    const shared = new FogOfWar(world, [], [a], 0);
    for (let tic = 0; tic < 20; tic++) shared.tick([a, b]);
    assert.equal(shared.isVisible(far), true);
  });
});
