import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, type ThingLayer } from '../../src/game/things.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { MAX_MOMENTUM_SPEED, Player } from '../../src/game/player.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { MATERIALS, recordingBank } from '../fixtures/spritestubs.ts';
import { IDLE_INPUT } from '../fixtures/input.ts';

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
  const things = buildThingSprites(world, { bank, materials: MATERIALS, skill: 3 });
  return { things, world, at: { x: thing.x, y: thing.y } };
}

function x(things: ThingLayer): number {
  return things.snapshot().things[0].x;
}

describe('Knockback · momentum clamp', () => {
  test("a thing's thrust is held to MAXMOVE per tic", () => {
    const { things, at } = room(ThingType.imp);
    // A BFG ball's top contact roll, from the west: 100 units/tic unclamped.
    things.damage(0, 800, { from: { x: at.x - 60, y: at.y } });
    things.update(DOOM_TIC, null);
    assert.equal(x(things) - at.x, MAX_STEP, 'one tic moves it MAXMOVE, no more');
  });

  test('a thing hit that hard stays inside the room', () => {
    const { things, at } = room(ThingType.imp);
    things.damage(0, 800, { from: { x: at.x - 60, y: at.y } });
    for (let tic = 0; tic < 35; tic++) things.update(DOOM_TIC, null);
    assert.ok(x(things) + IMP_RADIUS <= 2 * CELL, `east wall at ${2 * CELL} holds it (x ${x(things)})`);
    assert.ok(x(things) > at.x, 'and it did get shoved');
  });

  test('a thing whose box is narrower than MAXMOVE cannot skip a wall', () => {
    // A barrel 15 units short of the east wall: its 20-unit box clears the wall
    // both where it stands and at the far end of a full 30-unit step, so only a
    // half-step lands on the wall. 240 damage is exactly MAXMOVE for mass 100.
    const { things, at } = room(ThingType.barrel, 2 * CELL - 15);
    things.damage(0, 240, { from: { x: at.x - 60, y: at.y } });
    things.update(DOOM_TIC, null);
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
