import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addControlLine, addControlSector, gridMap } from '../fixtures/gridmap.ts';
import { Forces } from '../../src/game/specials/forces.ts';
import { World } from '../../src/game/world.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { PLAYER_RADIUS } from '../../src/game/player.ts';

/**
 * Boom's wind, current and point pushers (`Add_Pusher`/`T_Pusher`/
 * `PIT_PushThing`): where the force comes from, how being off the floor
 * changes it, and the two gates — the sector's own push bit and, for a point
 * source, line of sight. See docs/specials.md § Pushers.
 */
describe('Boom pushers', () => {
  const TICS = 35;
  /** `PUSH_FACTOR` 7: a constant pusher's impulse is its line vector over 128, per tic. */
  const PUSH_DIVISOR = 128;
  /** Boom's generalized push bit, `p_spec.h`'s `PUSH_MASK`. */
  const PUSH_MASK = 0x200;

  /** Three open cells in a row; the middle one is tagged 7 and carries the push bit. */
  function rig(special: number, dx: number, dy: number) {
    const grid = gridMap(['...']);
    const middle = grid.index(1, 0);
    grid.map.sectors[middle].tag = 7;
    grid.map.sectors[middle].special = PUSH_MASK;
    addControlLine(grid.map, dx, dy, special, 7);
    const world = new World(grid.map);
    return { grid, middle, forces: new Forces(grid.map, world), out: [] as number[] };
  }

  test('a current pushes at full force on the floor and not at all above it', () => {
    const { grid, forces, out } = rig(225, 128, 0);
    const at = grid.centre(1, 0);
    const onFloor = forces.pushForBody({ ...at, z: 0 }, PLAYER_RADIUS, true, out);
    assert.ok(onFloor, 'expected a current on the floor');
    assert.ok(Math.abs(onFloor.x - (128 / PUSH_DIVISOR) * TICS) < 1e-9, `x was ${onFloor.x}`);
    assert.equal(onFloor.y, 0);
    assert.equal(forces.pushForBody({ ...at, z: 40 }, PLAYER_RADIUS, false, out), null);
  });

  test('wind is the other way round — full force in the air, half on the floor', () => {
    const { grid, forces, out } = rig(224, 128, 0);
    const at = grid.centre(1, 0);
    // Copied, not held: `pushForBody` hands back scratch its next call reuses.
    const airborne = forces.pushForBody({ ...at, z: 40 }, PLAYER_RADIUS, false, out)!.x;
    assert.ok(Math.abs(airborne - (128 / PUSH_DIVISOR) * TICS) < 1e-9, `x was ${airborne}`);
    const grounded = forces.pushForBody({ ...at, z: 0 }, PLAYER_RADIUS, true, out)!.x;
    assert.ok(Math.abs(grounded - airborne / 2) < 1e-9, `x was ${grounded}`);
  });

  test('the direction is the control line’s own vector', () => {
    const { grid, forces, out } = rig(225, 0, -256);
    const push = forces.pushForBody({ ...grid.centre(1, 0), z: 0 }, PLAYER_RADIUS, true, out)!;
    assert.equal(push.x, 0);
    assert.ok(Math.abs(push.y + (256 / PUSH_DIVISOR) * TICS) < 1e-9, `y was ${push.y}`);
  });

  test('a sector whose push bit is cleared stops pushing', () => {
    const { grid, middle, forces, out } = rig(225, 128, 0);
    grid.map.sectors[middle].special = 0;
    assert.equal(forces.pushForBody({ ...grid.centre(1, 0), z: 0 }, PLAYER_RADIUS, true, out), null);
  });

  test('a body in a neighbouring sector feels nothing from a constant pusher', () => {
    const { grid, forces, out } = rig(225, 128, 0);
    // Far side of cell 0, well clear of the tagged cell's edge.
    const at = { x: grid.centre(0, 0).x - 32, y: grid.centre(0, 0).y, z: 0 };
    assert.equal(forces.pushForBody(at, PLAYER_RADIUS, true, out), null);
  });

  test('a body straddling the boundary is inside the pusher’s sector', () => {
    const { grid, forces, out } = rig(225, 128, 0);
    // Standing exactly on the edge between cells 0 and 1: the box spans both.
    const edgeX = (grid.centre(0, 0).x + grid.centre(1, 0).x) / 2;
    const at = { x: edgeX, y: grid.centre(1, 0).y, z: 0 };
    assert.ok(forces.pushForBody(at, PLAYER_RADIUS, true, out), 'expected the straddling body to be pushed');
  });

  describe('point sources', () => {
    /** Cell (1, 0) tagged and pushable, with a push/pull thing at its centre. */
    function pointRig(thingType: number, magnitudeLine = 64) {
      const grid = gridMap(['...']);
      const middle = grid.index(1, 0);
      grid.map.sectors[middle].tag = 7;
      grid.map.sectors[middle].special = PUSH_MASK;
      const source = grid.centre(1, 0);
      grid.map.things.push({ x: source.x, y: source.y, angle: 0, type: thingType, flags: 0 });
      addControlLine(grid.map, magnitudeLine, 0, 226, 7);
      const world = new World(grid.map);
      return { grid, source, forces: new Forces(grid.map, world), out: [] as number[] };
    }

    test('an MT_PUSH shoves away from its thing, an MT_PULL draws toward it', () => {
      const east = { dx: 32, dy: 0 };
      const pushRig = pointRig(ThingType.pointPusher);
      const at = { x: pushRig.source.x + east.dx, y: pushRig.source.y, z: 0 };
      const away = pushRig.forces.pushForBody(at, PLAYER_RADIUS, true, pushRig.out)!.x;
      assert.ok(away > 0, `expected a push east, got ${away}`);

      const pullRig = pointRig(ThingType.pointPuller);
      const toward = pullRig.forces.pushForBody(
        { x: pullRig.source.x + east.dx, y: pullRig.source.y, z: 0 },
        PLAYER_RADIUS,
        true,
        pullRig.out,
      )!.x;
      assert.ok(toward < 0, `expected a pull west, got ${toward}`);
    });

    test('the force falls off with distance and reaches zero at twice the magnitude', () => {
      const { source, forces, out } = pointRig(ThingType.pointPusher, 64);
      const near = forces.pushForBody({ x: source.x + 16, y: source.y, z: 0 }, PLAYER_RADIUS, true, out)!.x;
      const far = forces.pushForBody({ x: source.x + 96, y: source.y, z: 0 }, PLAYER_RADIUS, true, out)!.x;
      assert.ok(near > far, `expected falloff, got ${near} then ${far}`);
      // Magnitude 64, so the radius is 128 — nothing at all beyond it.
      assert.equal(forces.pushForBody({ x: source.x + 200, y: source.y, z: 0 }, PLAYER_RADIUS, true, out), null);
    });

    test('the force crosses sector boundaries, unlike wind and current', () => {
      const { grid, forces, out } = pointRig(ThingType.pointPusher, 256);
      // Cell 0 is a different sector entirely, and untagged.
      const at = { x: grid.centre(0, 0).x, y: grid.centre(0, 0).y, z: 0 };
      assert.ok(forces.pushForBody(at, PLAYER_RADIUS, true, out), 'expected the point source to reach across');
    });

    test('a wall between body and source blocks it', () => {
      const grid = gridMap(['.#.']);
      const right = grid.index(2, 0);
      grid.map.sectors[right].tag = 7;
      grid.map.sectors[right].special = PUSH_MASK;
      const source = grid.centre(2, 0);
      grid.map.things.push({ x: source.x, y: source.y, angle: 0, type: ThingType.pointPusher, flags: 0 });
      addControlLine(grid.map, 512, 0, 226, 7);
      const forces = new Forces(grid.map, new World(grid.map));
      const out: number[] = [];
      // Same distance, but the middle cell is a solid wall in between.
      const blocked = { x: grid.centre(0, 0).x, y: grid.centre(0, 0).y, z: 0 };
      assert.equal(forces.pushForBody(blocked, PLAYER_RADIUS, true, out), null);
    });
  });

  test('in a 242 sector the water surface stands in for the floor', () => {
    // `T_Pusher`'s special-water branch: a current runs on anything under the
    // surface, and wind drops to half while wading and to nothing once the eye
    // goes under. The pool floor is at -64 and the surface at 0.
    const flooded = (special: number) => {
      const grid = gridMap(['...'], { heights: { '.': { floor: 0, ceil: 256 } } });
      const middle = grid.index(1, 0);
      grid.map.sectors[middle].tag = 7;
      grid.map.sectors[middle].special = PUSH_MASK;
      grid.map.sectors[middle].floorHeight = -64;
      addControlLine(grid.map, 128, 0, special, 7);
      addControlSector(grid.map, { floorHeight: 0 }, 242, 7);
      return { forces: new Forces(grid.map, new World(grid.map)), at: grid.centre(1, 0) };
    };
    const full = (128 / PUSH_DIVISOR) * TICS;

    const current = flooded(225);
    const swimming = current.forces.pushForBody({ ...current.at, z: -32 }, PLAYER_RADIUS, false, []);
    assert.ok(swimming, 'a current reaches a body floating under the surface');
    assert.ok(Math.abs(swimming.x - full) < 1e-9, `x was ${swimming.x}`);
    assert.equal(
      current.forces.pushForBody({ ...current.at, z: 64 }, PLAYER_RADIUS, false, []),
      null,
      'and stops above it',
    );

    const wind = flooded(224);
    const wading = wind.forces.pushForBody({ ...wind.at, z: -8 }, PLAYER_RADIUS, true, []);
    assert.ok(wading && Math.abs(wading.x - full / 2) < 1e-9, 'wading takes half the wind');
    assert.equal(
      wind.forces.pushForBody({ ...wind.at, z: -64 }, PLAYER_RADIUS, true, []),
      null,
      'fully submerged takes none',
    );
    const above = wind.forces.pushForBody({ ...wind.at, z: 64 }, PLAYER_RADIUS, false, []);
    assert.ok(above && Math.abs(above.x - full) < 1e-9, 'above the surface takes all of it');
  });
});
