import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { type ThingLayer } from '../../src/game/things.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { MAX_MOMENTUM_SPEED, Player } from '../../src/game/player.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { recordingBank, thingLayer } from '../fixtures/spritestubs.ts';
import { IDLE_INPUT } from '../fixtures/input.ts';
import { changedThing } from '../fixtures/snapshot.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { MONSTER_HEALTH } from '../../src/game/things/tables.ts';
import { stepFor } from '../fixtures/tics.ts';
/**
 * `P_XYMovement`'s two guards on a momentum move: each axis held to `MAXMOVE` (30 units/tic),
 * and a thing's move taken in halves until no step exceeds `MAXMOVE/2`. Without them a BFG ball's
 * 800-damage contact hit is a 100-unit step, probed only at its far end — through a wall.
 * docs/movement.md § Knockback.
 */

const CELL = 128;
const MAX_STEP = MAX_MOMENTUM_SPEED * DOOM_TIC;
const IMP_RADIUS = 20;
const BARREL_RADIUS = 10;

/** A one-cell room spanning CELL..2*CELL on both axes, `type` standing at `x` (default centred). */
function room(type: number, x?: number): { things: ThingLayer; world: World; at: { x: number; y: number } } {
  const grid = gridMap(['###', '#.#', '###'], { cell: CELL });
  const thing = thingAt(grid, 1, 1, type);
  if (x !== undefined) thing.x = x;
  grid.map.things.push(thing);
  const world = new World(grid.map);
  const { bank } = recordingBank();
  const things = thingLayer(world, { bank });
  return { things, world, at: { x: thing.x, y: thing.y } };
}

function x(things: ThingLayer): number {
  return changedThing(things.snapshot(), 0).x;
}

describe('Knockback · momentum clamp', () => {
  test("a thing's thrust is held to MAXMOVE per tic", () => {
    const { things, at } = room(ThingType.imp);
    // A BFG ball's top contact roll, from the west: 100 units/tic unclamped.
    things.damage(0, 800, { from: { x: at.x - 60, y: at.y } });
    things.update(DOOM_TIC, [null]);
    assert.equal(x(things) - at.x, MAX_STEP, 'one tic moves it MAXMOVE, no more');
  });

  test('a thing hit that hard stays inside the room', () => {
    const { things, at } = room(ThingType.imp);
    things.damage(0, 800, { from: { x: at.x - 60, y: at.y } });
    for (let tic = 0; tic < 35; tic++) things.update(DOOM_TIC, [null]);
    assert.ok(x(things) + IMP_RADIUS <= 2 * CELL, `east wall at ${2 * CELL} holds it (x ${x(things)})`);
    assert.ok(x(things) > at.x, 'and it did get shoved');
  });

  test('a thing whose box is narrower than MAXMOVE cannot skip a wall', () => {
    // A barrel 15 units short of the east wall: its 20-unit box clears the wall
    // both where it stands and at the far end of a full 30-unit step, so only a
    // half-step lands on the wall. 240 damage is exactly MAXMOVE for mass 100.
    const { things, at } = room(ThingType.barrel, 2 * CELL - 15);
    things.damage(0, 240, { from: { x: at.x - 60, y: at.y } });
    things.update(DOOM_TIC, [null]);
    assert.ok(x(things) + BARREL_RADIUS <= 2 * CELL, `still inside the room (x ${x(things)})`);
  });

  test("the player's channel is held to MAXMOVE per axis too", () => {
    const { world, at } = room(ThingType.imp);
    const player = new Player(world);
    player.restore({ x: at.x, y: at.y, z: 0, angle: 0, velX: 0, velY: 0, velZ: 0, knockVelX: 0, knockVelY: 0 });
    player.applyKnockback(3 * MAX_MOMENTUM_SPEED, 0);
    player.update(DOOM_TIC, IDLE_INPUT, null, 0, []);
    assert.equal(player.x - at.x, MAX_STEP, 'one tic moves it MAXMOVE, no more');
  });
});

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
    things: thingLayer(world, { bank }),
    at: { x: thing.x, y: thing.y },
    east: 5 * CELL, // the pedestal's east edge, where the pit starts
  };
}

/** One shove from the west, then two seconds of it playing out. */
function shove(things: ThingLayer, at: { x: number; y: number }, damage: number): { x: number; z: number } {
  things.damage(0, damage, { from: { x: at.x - 60, y: at.y } });
  stepFor(2, () => things.update(DOOM_TIC, [null]));
  return changedThing(things.snapshot(), 0);
}

describe('Knockback · over a ledge', () => {
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
