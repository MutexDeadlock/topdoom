import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, type ThingLayer } from '../../src/game/things.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { MATERIALS, recordingBank } from '../fixtures/spritestubs.ts';
import { stepFor } from '../fixtures/tics.ts';
import { changedThing } from '../fixtures/snapshot.ts';

/**
 * Knockback shoved a monster out over a ledge its own walk step refuses, and the
 * straddled opening then held it at the high floor — half its sprite on the
 * platform, half hanging over the drop. `applyKnockback` tested geometry alone,
 * where `P_XYMovement` reaches the world through the same `P_TryMove` the walk
 * step does, dropoff refusal included. docs/movement.md § Knockback.
 *
 * Reported on nosp4.wad MAP02: a spider mastermind stands on a 256-unit pedestal
 * 64 units above the room, sized to its own box so it can never walk off. Sixty
 * seconds of infighting shoved it off anyway. The fixture is that shape one cell
 * wider all round, so a monster refused for any *other* reason fails the second
 * assertion instead of passing the first.
 */

const SPIDER = ThingType.spiderMastermind;
const CELL = 128;
const PIT_FLOOR = -64;
/** Non-lethal against 3000 hit points, and far past the momentum clamp at mass 1000. */
const SHOVE = MONSTER_HEALTH[SPIDER] - 100;

/** A 3×3-cell pedestal ringed by a pit, the spider dead centre of it. */
function pedestal(): { things: ThingLayer; at: { x: number; y: number }; east: number } {
  const grid = gridMap(
    ['#######', '#vvvvv#', '#v...v#', '#v...v#', '#v...v#', '#vvvvv#', '#######'],
    { cell: CELL, heights: { v: { floor: PIT_FLOOR, ceil: 128 } } },
  );
  const thing = thingAt(grid, 3, 3, SPIDER);
  grid.map.things.push(thing);
  const world = new World(grid.map);
  const { bank } = recordingBank();
  return {
    things: buildThingSprites(world, { bank, materials: MATERIALS, skill: 3 }),
    at: { x: thing.x, y: thing.y },
    east: 5 * CELL, // the pedestal's east edge, where the pit starts
  };
}

/** One shove from the west, then two seconds of it playing out. */
function shove(things: ThingLayer, at: { x: number; y: number }, damage: number): { x: number; z: number } {
  things.damage(0, damage, { from: { x: at.x - 60, y: at.y } });
  stepFor(2, () => things.update(DOOM_TIC, null));
  return changedThing(things.snapshot(), 0);
}

describe('Regressions · knockback over a ledge', () => {
  test('a shove cannot push a monster off the pedestal it stands on', () => {
    const { things, at, east } = pedestal();
    const p = shove(things, at, SHOVE);
    const radius = MONSTER_STATS[SPIDER].radius;
    assert.equal(things.snapshot().stats.kills, 0, 'it survived the shove');
    assert.ok(p.x + radius <= east, `its box stays on the pedestal (east edge ${p.x + radius})`);
    assert.ok(p.x > at.x, 'and the ledge is what stopped it, not knockback going missing');
  });

  test('a corpse still slides off — P_KillMobj hands it MF_DROPOFF', () => {
    const { things, at, east } = pedestal();
    const p = shove(things, at, MONSTER_HEALTH[SPIDER] + 100);
    assert.equal(things.snapshot().stats.kills, 1, 'that killed it');
    assert.ok(p.x + MONSTER_STATS[SPIDER].radius > east, `and the corpse was pushed out over the pit (x ${p.x})`);
  });
});
