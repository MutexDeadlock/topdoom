import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import {
  ANY_HEIGHT,
  World,
  bodyFloor,
  positionBlocked,
  setInfiniteTallActors,
  type ThingBlocker,
} from '../../src/game/world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS, Player } from '../../src/game/player.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { Input } from '../../src/game/input.ts';

/**
 * Solid bodies carry their real height by default, so a mover clearing one
 * entirely — over or under — walks past it, and the player lands *on* a body it
 * drops onto rather than inside it. The "Infinite tall actors (vanilla)"
 * setting puts vanilla's `PIT_CheckThing` back, where a body blocks over its
 * whole vertical extent. See docs/movement.md § Collision.
 */

const BODY_HEIGHT = 56;

// One open cell in a walled room. Nothing here mutates the map, so every test
// shares the one build.
const grid = gridMap(['###', '#.#', '###']);
const world = new World(grid.map);
const at = grid.centre(1, 1);

function body(z: number, height = BODY_HEIGHT): ThingBlocker {
  return { x: at.x, y: at.y, z, radius: 20, height };
}

/** The mover is the player's box unless a case says otherwise. */
function blocked(z: number, blockers: ThingBlocker[], moverHeight = PLAYER_HEIGHT): boolean {
  return positionBlocked(world, at.x, at.y, PLAYER_RADIUS, z, moverHeight, false, blockers);
}

/** `Player.update` asks its input for nothing but `held`. */
const IDLE_INPUT = { held: () => false } as unknown as Input;

function settle(player: Player, blockers: ThingBlocker[]): void {
  for (let tic = 0; tic < Math.round(2 / DOOM_TIC); tic++) {
    player.update(DOOM_TIC, IDLE_INPUT, null, 0, blockers);
  }
}

// The flag is module state in `world.ts`, so a test that sets it must put it
// back: the fake-localStorage trick can't reach it, the module having been
// evaluated long before any test ran.
afterEach(() => setInfiniteTallActors(false));

describe('Collision · body height', () => {
  test('a body cleared entirely is walked past, over or under, unless actors are infinitely tall', () => {
    const overhead = [body(100)];
    const below = [body(-100)];
    assert.equal(blocked(0, overhead), false, 'walk under a hovering body');
    assert.equal(blocked(0, below), false, 'walk over one far below');

    setInfiniteTallActors(true);
    assert.equal(blocked(0, overhead), true, 'vanilla: it blocks from overhead');
    assert.equal(blocked(0, below), true, 'vanilla: and from below');
  });

  test('a body at the same height blocks under either setting — the change is vertical only', () => {
    const level = [body(0)];
    assert.equal(blocked(0, level), true);

    setInfiniteTallActors(true);
    assert.equal(blocked(0, level), true);
  });

  test('exact touch clears the body, so standing on one is being over it', () => {
    const level = [body(0)];
    assert.equal(blocked(BODY_HEIGHT, level), false, 'feet exactly on its top');
    assert.equal(blocked(BODY_HEIGHT - 1, level), true, 'one unit into it');
  });

  test('an ANY_HEIGHT mover keeps vanilla blocking — it has no span to clear one with', () => {
    // `testStep`'s floatok probe, which passes the real body height alongside
    // an `ANY_HEIGHT` z and must answer exactly what it answered before bodies
    // had heights.
    assert.equal(blocked(ANY_HEIGHT, [body(100)], BODY_HEIGHT), true);
  });
});

describe('Collision · bodies as floor', () => {
  test('the highest body below the mover is the one stood on', () => {
    assert.equal(bodyFloor(at.x, at.y, PLAYER_RADIUS, 100, [body(24, 8), body(0)]), BODY_HEIGHT);
  });

  test('a body the mover is not above holds nothing up', () => {
    assert.equal(bodyFloor(at.x, at.y, PLAYER_RADIUS, 0, [body(100)]), -Infinity);
  });

  test('infinitely tall actors have no top to stand on', () => {
    setInfiniteTallActors(true);
    assert.equal(bodyFloor(at.x, at.y, PLAYER_RADIUS, 100, [body(0)]), -Infinity);
  });

  test('a player dropping onto a body lands on it, and falls the rest when it leaves', () => {
    const player = new Player(world);
    player.restore({ x: at.x, y: at.y, z: 200, angle: 0, velX: 0, velY: 0, velZ: 0, knockVelX: 0, knockVelY: 0 });

    const blockers = [body(0)];
    settle(player, blockers);
    assert.equal(player.z, BODY_HEIGHT, 'rests on the body rather than inside it');

    blockers.length = 0; // it walked away, or died
    settle(player, blockers);
    assert.equal(player.z, 0, 'falls to the sector floor once nothing holds it up');
  });
});
