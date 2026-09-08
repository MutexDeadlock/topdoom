import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites } from '../../src/game/things.ts';
import { Forces } from '../../src/game/specials/forces.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { addControlLine, gridMap, thingAt } from '../fixtures/gridmap.ts';
import { specialsRig, TIC } from '../fixtures/specialsrig.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { PLAYER_RADIUS } from '../../src/game/player.ts';
import { changedThing, savedThing } from '../fixtures/snapshot.ts';

/**
 * **A decoration riding a Boom conveyor over a teleport line must teleport.**
 *
 * Reported against BOOMEDIT.WAD: its 252/253 belts (and the 216/217
 * accelerative pair) each carry an evil eye into a **267** line-to-line
 * teleporter that loops it back to the start. Here the eye rode off the end and
 * was gone, because walk triggers only ever fired for the player, monsters and
 * voodoo dolls.
 *
 * `P_CrossSpecialLine` fires for **every** non-player mobj that moves — its only
 * exclusions are the six projectile types — and the "monster only" numbers mean
 * "not the player", not "monsters only". So a decoration counts, and the only
 * reason one never triggered anything in vanilla is that nothing but a conveyor
 * ever moves it. docs/specials-forces.md § Scrollers and conveyors.
 */
describe('Regressions · a conveyor carries a thing over a teleporter', () => {
  /**
   * A four-cell corridor. Cells 1-2 are a conveyor running east into the
   * teleport line on cell 3's near edge, and cell 3 is the landing pad; an evil
   * eye — a decoration, no AI, no momentum of its own — starts on the belt.
   */
  function rig(carrySpecial: number) {
    const grid = gridMap(['######', '#....#', '######'], { cell: 128 });
    const map = grid.map;
    for (const col of [1, 2]) map.sectors[grid.index(col, 1)].tag = 7;
    // 512/32 × 3/32 = 1.5 units/tic east — brisk enough to cross in a few tics.
    addControlLine(map, 512, 0, carrySpecial, 7);
    // Vanilla 97: WR teleport, on the allow-list for every non-player mobj.
    const crossed = grid.westEdge(3, 1);
    map.linedefs[crossed].special = 97;
    map.linedefs[crossed].tag = 9;
    map.sectors[grid.index(3, 1)].tag = 9;
    map.things.push(
      thingAt(grid, 1, 1, ThingType.evilEye),
      thingAt(grid, 3, 1, ThingType.teleportDest),
      thingAt(grid, 4, 1, ThingType.playerStart),
    );

    const rigged = specialsRig(map, grid.centre(4, 1));
    const forces = new Forces(map, rigged.world);
    const layer = buildThingSprites(rigged.world, { bank: BANK, materials: MATERIALS, skill: 3 });
    const step = () => {
      forces.tick();
      layer.update(
        TIC,
        null,
        undefined,
        (prev, mover) => rigged.specials.crossMonster(prev, mover, new Set()),
        undefined,
        (pos, radius, cache) => forces.carryForBody(pos, radius, cache),
      );
      rigged.tick();
    };
    return { grid, layer, step, pad: grid.centre(3, 1), start: grid.centre(1, 1) };
  }

  for (const special of [252, 253]) {
    test(`a decoration on a ${special} belt reaches the teleport pad instead of riding off the end`, () => {
      const { layer, step, pad, start } = rig(special);
      // Nothing has moved it yet, so the save carries no entry — its spawn is where the map put it.
      const startX = savedThing(layer.snapshot(), 0)?.x ?? start.x;
      for (let i = 0; i < 200; i++) step();
      const eye = changedThing(layer.snapshot(), 0);
      assert.ok(eye.x > startX, 'the belt should have moved it at all');
      assert.ok(
        Math.hypot(eye.x - pad.x, eye.y - pad.y) < PLAYER_RADIUS,
        `expected the eye at the pad (${pad.x}, ${pad.y}), found it at (${eye.x}, ${eye.y})`,
      );
    });
  }

  test('a corpse rides the belt too', () => {
    // `P_KillMobj` strips `MF_NOGRAVITY`, so `sc_carry`'s gate admits a corpse
    // exactly as it does a living body — docs/movement.md § Knockback.
    const grid = gridMap(['######', '#....#', '######'], { cell: 128 });
    const map = grid.map;
    for (const col of [1, 2]) map.sectors[grid.index(col, 1)].tag = 7;
    addControlLine(map, 512, 0, 252, 7);
    map.things.push(thingAt(grid, 1, 1, ThingType.imp), thingAt(grid, 4, 1, ThingType.playerStart));
    const world = new World(map);
    const forces = new Forces(map, world);
    const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
    layer.damage(0, 1000); // dead where it stands, before the belt has run
    const startX = changedThing(layer.snapshot(), 0).x;
    for (let i = 0; i < 100; i++) {
      forces.tick();
      layer.update(TIC, null, undefined, undefined, undefined, (pos, radius, cache) => forces.carryForBody(pos, radius, cache));
    }
    const after = layer.snapshot();
    assert.equal(after.stats.kills, 1, 'the imp should have died before the belt ran');
    const corpse = changedThing(after, 0);
    assert.ok(corpse.x > startX + 64, `the corpse only moved ${corpse.x - startX} units`);
  });

  test('the same belt with no teleport line just carries it to the wall', () => {
    const grid = gridMap(['######', '#....#', '######'], { cell: 128 });
    const map = grid.map;
    map.sectors[grid.index(1, 1)].tag = 7;
    addControlLine(map, 512, 0, 252, 7);
    map.things.push(thingAt(grid, 1, 1, ThingType.evilEye), thingAt(grid, 4, 1, ThingType.playerStart));
    const world = new World(map);
    const forces = new Forces(map, world);
    const layer = buildThingSprites(world, { bank: BANK, materials: MATERIALS, skill: 3 });
    for (let i = 0; i < 200; i++) {
      forces.tick();
      layer.update(TIC, null, undefined, undefined, undefined, (pos, radius, cache) => forces.carryForBody(pos, radius, cache));
    }
    const eye = changedThing(layer.snapshot(), 0);
    // Carried east out of the belt sector and stopped by the corridor's end wall.
    assert.ok(eye.x > grid.centre(2, 1).x, `the eye only reached ${eye.x}`);
    assert.ok(eye.x < grid.centre(5, 1).x, 'it should not have left the corridor');
  });
});
