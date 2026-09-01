import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addControlLine, gridMap } from '../fixtures/gridmap.ts';
import { crushSources, specialsRig, TIC } from '../fixtures/specialsrig.ts';
import { Forces } from '../../src/game/specials/forces.ts';
import { VoodooDolls } from '../../src/game/voodoo.ts';
import { SectorEffects } from '../../src/game/specials/sectoreffects.ts';
import { applyCrushDamage } from '../../src/game/specials/moverblocking.ts';
import { createInventory, PICKUP_RANGE } from '../../src/game/inventory.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { World } from '../../src/game/world.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { DoomMap } from '../../src/wad/map.ts';

/**
 * Voodoo dolls: which player starts become one, being carried across a walk
 * line, and the two ways damage to a doll reaches the real player.
 * See docs/specials.md § Voodoo dolls.
 */
describe('Specials · voodoo dolls', () => {
  function addStart(map: DoomMap, x: number, y: number): void {
    map.things.push({ x, y, angle: 0, type: ThingType.playerStart, flags: 0 });
  }

  test('every player start but the last becomes a doll', () => {
    const grid = gridMap(['...']);
    addStart(grid.map, grid.centre(0, 0).x, grid.centre(0, 0).y);
    addStart(grid.map, grid.centre(1, 0).x, grid.centre(1, 0).y);
    addStart(grid.map, grid.centre(2, 0).x, grid.centre(2, 0).y); // the real one
    const world = new World(grid.map);
    const dolls = new VoodooDolls(world);
    assert.equal(dolls.dolls.length, 2);
    assert.equal(dolls.dolls[0].x, grid.centre(0, 0).x);
    // The last start is where the player spawns, so it is never a doll.
    assert.equal(world.playerStart().x, grid.centre(2, 0).x);
  });

  test('a map with a single start has no dolls at all', () => {
    const grid = gridMap(['...']);
    addStart(grid.map, grid.centre(1, 0).x, grid.centre(1, 0).y);
    assert.equal(new VoodooDolls(new World(grid.map)).empty, true);
  });

  test('a conveyor carries a doll, and the walk line it crosses fires', () => {
    // Three open cells and a shut door; the doll starts in cell 0 on a belt
    // running east, and cell 2's west edge is the W1 line that opens the door.
    const grid = gridMap(['...+']);
    const start = grid.centre(0, 0);
    addStart(grid.map, start.x, start.y);
    addStart(grid.map, grid.centre(0, 0).x, grid.centre(0, 0).y);
    for (const col of [0, 1, 2]) grid.map.sectors[grid.index(col, 0)].tag = 7;
    const door = grid.index(3, 0);
    grid.map.sectors[door].tag = 99;
    // A long control line so the belt is brisk: 512/32 × 3/32 = 1.5 units/tic.
    addControlLine(grid.map, 512, 0, 252, 7);
    // Vanilla 2: W1 open door, on a boundary the doll will be carried across.
    grid.map.linedefs[grid.westEdge(2, 0)].special = 2;
    grid.map.linedefs[grid.westEdge(2, 0)].tag = 99;

    const rig = specialsRig(grid.map, start);
    const forces = new Forces(grid.map, rig.world);
    const dolls = new VoodooDolls(rig.world);
    const keys = new Set<never>();
    assert.equal(grid.map.sectors[door].ceilHeight, 0, 'the door starts shut');
    for (let i = 0; i < 200; i++) {
      forces.tick();
      dolls.update(TIC, forces, (prev, doll) => rig.specials.crossVoodoo(prev, doll, keys), () => {});
      rig.tick();
    }
    assert.ok(dolls.dolls[0].x > start.x + 128, `the doll only reached ${dolls.dolls[0].x - start.x} units`);
    assert.ok(grid.map.sectors[door].ceilHeight > 0, 'the doll’s crossing should have opened the door');
  });

  test('the same crossing does nothing when no doll is there to make it', () => {
    const grid = gridMap(['...+']);
    addStart(grid.map, grid.centre(0, 0).x, grid.centre(0, 0).y); // one start: no dolls
    const door = grid.index(3, 0);
    grid.map.sectors[door].tag = 99;
    grid.map.linedefs[grid.westEdge(2, 0)].special = 2;
    grid.map.linedefs[grid.westEdge(2, 0)].tag = 99;
    const rig = specialsRig(grid.map, grid.centre(0, 0));
    for (let i = 0; i < 200; i++) rig.tick();
    assert.equal(grid.map.sectors[door].ceilHeight, 0);
  });

  test('a doll carried over an item collects it for the real player', () => {
    // `MT_PLAYER` carries `MF_PICKUP` (info.c), so `PIT_CheckThing` hands what a
    // *moving* doll's box touches to `P_TouchSpecialThing`, which credits
    // `toucher->player` — the real player. docs/items.md § Collecting things.
    const grid = gridMap(['...']);
    const start = grid.centre(0, 0);
    addStart(grid.map, start.x, start.y);
    addStart(grid.map, start.x, start.y);
    for (const col of [0, 1, 2]) grid.map.sectors[grid.index(col, 0)].tag = 7;
    addControlLine(grid.map, 512, 0, 252, 7);
    const item = grid.centre(2, 0);
    grid.map.things.push({ x: item.x, y: item.y, angle: 0, type: ThingType.stimpack, flags: 7 });

    const rig = specialsRig(grid.map, start);
    const forces = new Forces(grid.map, rig.world);
    const dolls = new VoodooDolls(rig.world);
    const layer = buildThingSprites(rig.world, { bank: BANK, materials: MATERIALS, skill: 3 });
    let taken = 0;
    for (let i = 0; i < 200; i++) {
      forces.tick();
      dolls.update(TIC, forces, () => null, (doll, attempted) =>
        layer.tryPickup(doll, attempted, PICKUP_RANGE, () => (taken++, true)),
      );
      rig.tick();
    }
    assert.ok(dolls.dolls[0].x > item.x - PICKUP_RANGE, 'the belt should have carried the doll onto the item');
    assert.equal(taken, 1, 'the doll ran over it, so the player has it');
  });

  test('a doll parked on an item never collects it', () => {
    // Vanilla only reaches the pickup through `P_XYMovement`, which a doll with
    // no momentum never enters — so an item under a parked doll stays put.
    const grid = gridMap(['...']);
    const under = grid.centre(0, 0);
    addStart(grid.map, under.x, under.y);
    addStart(grid.map, grid.centre(2, 0).x, grid.centre(2, 0).y);
    grid.map.things.push({ x: under.x, y: under.y, angle: 0, type: ThingType.stimpack, flags: 7 });
    const world = new World(grid.map);
    const forces = new Forces(grid.map, world);
    const dolls = new VoodooDolls(world);
    const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
    let taken = 0;
    for (let i = 0; i < 50; i++) {
      forces.tick();
      dolls.update(TIC, forces, () => null, (doll, attempted) =>
        layer.tryPickup(doll, attempted, PICKUP_RANGE, () => (taken++, true)),
      );
    }
    assert.equal(taken, 0);
  });

  test('a doll sitting still on no conveyor never moves', () => {
    const grid = gridMap(['...']);
    addStart(grid.map, grid.centre(0, 0).x, grid.centre(0, 0).y);
    addStart(grid.map, grid.centre(2, 0).x, grid.centre(2, 0).y);
    const world = new World(grid.map);
    const forces = new Forces(grid.map, world);
    const dolls = new VoodooDolls(world);
    const at = { x: dolls.dolls[0].x, y: dolls.dolls[0].y };
    for (let i = 0; i < 50; i++) {
      forces.tick();
      dolls.update(TIC, forces, () => null, () => {});
    }
    assert.deepEqual({ x: dolls.dolls[0].x, y: dolls.dolls[0].y }, at);
  });

  test('a crusher over a doll damages the real player', () => {
    const grid = gridMap(['...'], { heights: { '.': { floor: 0, ceil: 128 } } });
    addStart(grid.map, grid.centre(1, 0).x, grid.centre(1, 0).y);
    addStart(grid.map, grid.centre(2, 0).x, grid.centre(2, 0).y);
    const world = new World(grid.map);
    const dolls = new VoodooDolls(world);
    const middle = grid.index(1, 0);
    // The ceiling has come down far enough that a player-height body is caught.
    grid.map.sectors[middle].ceilHeight = 8;
    let dealt = 0;
    const caught = applyCrushDamage(
      world,
      crushSources({
        // The player is somewhere else entirely.
        player: { ...grid.centre(2, 0), z: 0 },
        dolls: dolls.dolls,
        damagePlayer: (amount) => (dealt += amount),
        sprayBlood: () => assert.fail('a doll is drawn as nothing and sprays nothing'),
      }),
      middle,
      true,
    );
    assert.equal(caught, true);
    assert.ok(dealt > 0, 'the doll’s crushing should have hurt the player');
  });

  test('a doll on a damage floor costs the player nothing', () => {
    const grid = gridMap(['...']);
    addStart(grid.map, grid.centre(1, 0).x, grid.centre(1, 0).y);
    addStart(grid.map, grid.centre(2, 0).x, grid.centre(2, 0).y);
    // Vanilla 7: nukage, 5 HP a pulse — for whoever the *player* is standing on it.
    grid.map.sectors[grid.index(1, 0)].special = 7;
    const world = new World(grid.map);
    const dolls = new VoodooDolls(world);
    assert.equal(dolls.dolls.length, 1);
    const effects = new SectorEffects(grid.map);
    const inv = createInventory();
    // The player stands on clean floor throughout; only the doll is in the nukage.
    const player = { ...grid.centre(2, 0), z: 0 };
    let dealt = 0;
    for (let i = 0; i < 210; i++) {
      effects.update(TIC, world, player, inv, (amount) => (dealt += amount));
    }
    // `P_PlayerInSpecialSector` reads `player->mo`, and only `P_PlayerThink` calls it, so a doll
    // never runs it — Sunder 2512 MAP20 parks one in slime and would otherwise bleed the player
    // from the first second of the level. docs/specials.md § Voodoo dolls.
    assert.equal(dealt, 0, 'a doll is not the body the damage floor checks');
  });

  test('doll positions survive a save round-trip, and an old save leaves them put', () => {
    const grid = gridMap(['...']);
    addStart(grid.map, grid.centre(0, 0).x, grid.centre(0, 0).y);
    addStart(grid.map, grid.centre(2, 0).x, grid.centre(2, 0).y);
    const world = new World(grid.map);
    const dolls = new VoodooDolls(world);
    dolls.dolls[0].x += 64;
    dolls.dolls[0].momX = 12;
    const saved = dolls.snapshot();

    const restored = new VoodooDolls(world);
    restored.restore(saved);
    assert.equal(restored.dolls[0].x, dolls.dolls[0].x);
    assert.equal(restored.dolls[0].momX, 12);

    const fresh = new VoodooDolls(world);
    fresh.restore(undefined);
    assert.equal(fresh.dolls[0].x, grid.centre(0, 0).x, 'a pre-voodoo save leaves dolls on their starts');
  });
});
