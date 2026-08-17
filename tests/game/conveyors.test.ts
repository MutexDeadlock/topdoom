import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addControlLine, addControlSector, gridMap } from '../fixtures/gridmap.ts';
import { Forces } from '../../src/game/specials/forces.ts';
import { makeTouchCache, World } from '../../src/game/world.ts';
import { PLAYER_RADIUS } from '../../src/game/player.ts';

/**
 * The conveyor half of Boom's scrollers (`T_Scroll`'s `sc_carry`) seen from a
 * body rather than from the sector: which sectors count as underfoot, the
 * standing-on-the-floor gate, and the equilibrium a sustained impulse reaches
 * against the momentum channel's own friction.
 * See docs/specials.md § Scrollers and conveyors.
 */
describe('Conveyors', () => {
  const TICS = 35;
  /** Vanilla's per-tic `FRICTION`, the decay the momentum channel already ran on. */
  const FRICTION = 0.90625;

  /** Three cells in a row, the middle one a 252 conveyor running east at `dx`/32 × 3/32 units per tic. */
  function rig(dx = 128, heights?: Record<string, { floor: number; ceil: number }>) {
    const grid = gridMap(['...'], heights ? { heights } : {});
    grid.map.sectors[grid.index(1, 0)].tag = 7;
    addControlLine(grid.map, dx, 0, 252, 7);
    const forces = new Forces(grid.map, new World(grid.map));
    forces.tick();
    return { grid, forces, cache: makeTouchCache() };
  }

  test('a body on the belt is carried at CARRYFACTOR × the scroll rate', () => {
    const { grid, forces, cache } = rig();
    const at = grid.centre(1, 0);
    const carry = forces.carryForBody({ x: at.x, y: at.y, z: 0 }, PLAYER_RADIUS, cache);
    assert.ok(carry, 'expected the body to be carried');
    // 128/32 = 4 units/tic scroll, × 3/32 = 0.375 units/tic of impulse.
    assert.ok(Math.abs(carry.x - 0.375 * TICS) < 1e-9, `carry.x was ${carry.x}`);
    assert.equal(carry.y, 0);
  });

  test('a body in the next sector over is not', () => {
    const { grid, forces, cache } = rig();
    const at = grid.centre(0, 0);
    assert.equal(forces.carryForBody({ x: at.x - 32, y: at.y, z: 0 }, PLAYER_RADIUS, cache), null);
  });

  test('a body straddling the belt’s edge rides it — the centre point is not the test', () => {
    const { grid, forces, cache } = rig();
    const edgeX = (grid.centre(0, 0).x + grid.centre(1, 0).x) / 2;
    // Centre still in the neighbouring cell, box overlapping the belt.
    const at = { x: edgeX - 4, y: grid.centre(1, 0).y };
    assert.ok(forces.carryForBody({ x: at.x, y: at.y, z: 0 }, PLAYER_RADIUS, cache), 'expected the straddling body to be carried');
  });

  test('a body standing above the belt’s floor is not carried', () => {
    const { grid, forces, cache } = rig();
    const at = grid.centre(1, 0);
    // `T_Scroll`'s own `thing->z > height` skip: on a step inside the sector.
    assert.equal(forces.carryForBody({ x: at.x, y: at.y, z: 8 }, PLAYER_RADIUS, cache), null);
  });

  test('the gate is the belt’s own floor height, not zero', () => {
    const raised = gridMap(['.^.'], { heights: { '.': { floor: 0, ceil: 128 }, '^': { floor: 24, ceil: 128 } } });
    raised.map.sectors[raised.index(1, 0)].tag = 7;
    addControlLine(raised.map, 128, 0, 252, 7);
    const forces = new Forces(raised.map, new World(raised.map));
    forces.tick();
    const at = raised.centre(1, 0);
    const cache = makeTouchCache();
    assert.ok(forces.carryForBody({ x: at.x, y: at.y, z: 24 }, PLAYER_RADIUS, cache), 'resting on a raised belt still rides it');
    assert.equal(forces.carryForBody({ x: at.x, y: at.y, z: 32 }, PLAYER_RADIUS, cache), null, 'hovering above it does not');
  });

  test('a sustained impulse settles at vanilla’s own equilibrium', () => {
    const { grid, forces, cache } = rig();
    const at = grid.centre(1, 0);
    const impulse = forces.carryForBody({ x: at.x, y: at.y, z: 0 }, PLAYER_RADIUS, cache)!.x;
    // The momentum channel: add the impulse each tic, then decay by FRICTION.
    let v = 0;
    for (let i = 0; i < 400; i++) v = (v + impulse) * FRICTION;
    // `v* = a·f/(1−f)`, which for a 0.375 units/tic belt is 3.625 units/tic.
    const expected = (impulse * FRICTION) / (1 - FRICTION);
    assert.ok(Math.abs(v - expected) < 1e-6, `settled at ${v}, expected ${expected}`);
    assert.ok(Math.abs(expected / TICS - 3.625) < 1e-9, `${expected / TICS} units/tic`);
  });

  test('a submerged body rides the belt even off the floor', () => {
    // `sc_carry`'s "Underwater, carry things even w/o gravity": inside a Boom
    // 242 sector, being under the water surface counts as being on the belt.
    // Two separate maps, because the transfer scan is memoized per map.
    const sunkenBelt = (flooded: boolean) => {
      const grid = gridMap(['...'], { heights: { '.': { floor: 0, ceil: 256 } } });
      const belt = grid.index(1, 0);
      grid.map.sectors[belt].tag = 7;
      grid.map.sectors[belt].floorHeight = -64;
      addControlLine(grid.map, 128, 0, 252, 7);
      if (flooded) addControlSector(grid.map, { floorHeight: 0 }, 242, 7);
      const forces = new Forces(grid.map, new World(grid.map));
      forces.tick();
      return { forces, at: grid.centre(1, 0) };
    };

    const dry = sunkenBelt(false);
    const floating = (z: number) => ({ x: dry.at.x, y: dry.at.y, z });
    assert.equal(dry.forces.carryForBody(floating(-32), PLAYER_RADIUS, makeTouchCache()), null, 'off the floor, no water: not carried');

    const wet = sunkenBelt(true);
    assert.ok(wet.forces.carryForBody(floating(-32), PLAYER_RADIUS, makeTouchCache()), 'under the surface: carried');
    assert.equal(wet.forces.carryForBody(floating(64), PLAYER_RADIUS, makeTouchCache()), null, 'above the surface: not carried');
  });
});
