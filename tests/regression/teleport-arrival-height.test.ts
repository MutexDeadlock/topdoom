import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThingSprites } from '../../src/game/things.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { specialsRig, TIC } from '../fixtures/specialsrig.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';
import { changedThing } from '../fixtures/snapshot.ts';

/**
 * **A teleported monster stands on the floor it arrives at, it does not fall to it.**
 *
 * `EV_Teleport` ends on `thing->z = thing->floorz` — the *arrival* floor.
 * `arriveAt` used to leave `z` alone, so a monster walking out of a closet
 * raised above the arena it teleports into kept the closet's height and then
 * fell the difference under gravity: the "monsters dropping out of the sky"
 * every teleport ambush read as. docs/specials-teleporters.md § Teleporters.
 */

const CLOSET_FLOOR = 192;

describe('Regressions · teleport arrival height', () => {
  /**
   * A corridor whose first two cells are a closet raised `CLOSET_FLOOR` above
   * the rest. An imp starts in cell 1; cell 2's west edge is a WR teleport
   * (97) onto the pad at cell 4, down in the arena, with the player past it so
   * the imp chases east across the line.
   */
  function rig() {
    const grid = gridMap(['#######', '#CC...#', '#######'], {
      cell: 128,
      heights: { C: { floor: CLOSET_FLOOR, ceil: CLOSET_FLOOR + 128 } },
    });
    const map = grid.map;
    const crossed = grid.westEdge(2, 1);
    map.linedefs[crossed].special = 97;
    map.linedefs[crossed].tag = 9;
    map.sectors[grid.index(4, 1)].tag = 9;
    map.things.push(
      thingAt(grid, 1, 1, ThingType.imp),
      thingAt(grid, 4, 1, ThingType.teleportDest),
      thingAt(grid, 5, 1, ThingType.playerStart),
    );

    const start = grid.centre(5, 1);
    const rigged = specialsRig(map, start);
    const layer = buildThingSprites(rigged.world, { bank: BANK, materials: MATERIALS, skill: 3 });
    // A hit alerts the monster, which is all a closet monster needs to start
    // chasing — sight through a doorway would do it in a real map.
    layer.damage(0, 1, { from: start });
    const player = { x: start.x, y: start.y, z: 0 };
    const step = () => {
      layer.update(TIC, [player], { crossLines: (prev, mover) => rigged.specials.crossMonster(prev, mover, new Set()) });
      rigged.tick();
    };
    return { grid, layer, step, pad: grid.centre(4, 1) };
  }

  test('a monster teleported down into the arena arrives standing on its floor', () => {
    const { layer, step, pad } = rig();
    let arrivalZ: number | null = null;
    for (let i = 0; i < 300 && arrivalZ === null; i++) {
      step();
      const imp = changedThing(layer.snapshot(), 0);
      // The tic it lands: the pad is a whole cell away from where it walked.
      if (Math.hypot(imp.x - pad.x, imp.y - pad.y) < 64) arrivalZ = imp.z;
    }
    assert.notEqual(arrivalZ, null, 'the imp never reached the pad');
    assert.equal(arrivalZ, 0, `expected the arena floor on arrival, found z=${arrivalZ}`);
  });
});
