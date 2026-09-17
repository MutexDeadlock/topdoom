import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import { AutoCamera, setCameraMode } from '../../src/game/autocamera.ts';
import { TopDownCamera } from '../../src/render/camera.ts';
import { at, lowWallToTheSouth, room, wallToTheSouth } from '../fixtures/camerarooms.ts';
import { addControlSector } from '../fixtures/gridmap.ts';
import { transfersOf } from '../../src/game/specials/transfers.ts';
import { AUTO_OCCLUDED_DISTANCE, nearestObstruction } from '../../src/game/autocamera.ts';
import { MIN_RESCUE_DISTANCE } from '../../src/render/camera.ts';

/**
 * Framing past an occluder: only a wall the camera can actually see counts — a room's own wall
 * between the player inside it and a camera hanging outside hides nothing — and the framing backs
 * off only as far as the wall it does find. Split from the openness probe
 * (`tests/game/autocamera.test.ts`). See docs/camera.md § Framing past an occluder.
 */

describe('Auto camera · framing past an occluder', () => {
  const TILT = 60;
  /** The tilt the auto camera reaches over open ground — what the far-wall case is framed at. */
  const WIDE_TILT = 70;
  const SOUTH_YAW = 0;
  const NORTH_YAW = 180;

  test('open floor obstructs nothing', () => {
    const grid = room();
    const world = new World(grid.map);
    const look = { tiltDeg: TILT, yawDeg: SOUTH_YAW, distance: 600 };
    assert.equal(nearestObstruction(world, at(grid.centre(6, 6)), look), Infinity);
  });

  test('a wall the camera hangs behind hides the player, and says how far off it is', () => {
    const grid = wallToTheSouth();
    const world = new World(grid.map);
    // From row 4 the camera at 600u clears the wall's far side, so it looks at
    // the face the wall draws for it.
    const at4 = at(grid.centre(2, 4));
    const d = nearestObstruction(world, at4, { tiltDeg: TILT, yawDeg: SOUTH_YAW, distance: 600 });
    assert.ok(Number.isFinite(d), 'the wall is found');
    // The wall stands one and a half cells south, and the ray reaches it along
    // the horizontal leg of its own tilt.
    // The face it draws for a camera to the south is the block's own south
    // side, a cell and a half out, reached along the horizontal leg of the tilt.
    const expected = (1.5 * grid.cell) / Math.sin((TILT * Math.PI) / 180);
    assert.ok(Math.abs(d - expected) < grid.cell / 2, `found at ${d}, expected about ${expected}`);
  });

  test('the same wall with the camera on the player’s own side hides nothing', () => {
    const grid = wallToTheSouth();
    const world = new World(grid.map);
    const look = { tiltDeg: TILT, yawDeg: NORTH_YAW, distance: 600 };
    assert.equal(nearestObstruction(world, at(grid.centre(2, 4)), look), Infinity);
  });

  test('a wall the camera hangs well over is left to the fade, and the framing decides which', () => {
    const grid = lowWallToTheSouth();
    const world = new World(grid.map);
    const from = at(grid.centre(2, 4));
    // Same wall, same place: near in the eye is still under its top, far out it
    // is over it and what little the wall covers is the fade's to dissolve.
    const near = { tiltDeg: TILT, yawDeg: SOUTH_YAW, distance: 400 };
    assert.ok(Number.isFinite(nearestObstruction(world, from, near)), 'near in, under the top');
    const far = { tiltDeg: TILT, yawDeg: SOUTH_YAW, distance: 800 };
    assert.equal(nearestObstruction(world, from, far), Infinity, 'far out, over the top');
  });

  test('a framing that stops short of the wall is unobstructed', () => {
    const grid = wallToTheSouth();
    const world = new World(grid.map);
    const look = { tiltDeg: TILT, yawDeg: SOUTH_YAW, distance: 300 };
    assert.equal(nearestObstruction(world, at(grid.centre(2, 0)), look), Infinity);
  });

  test('a tick behind an occluder pulls the zoom nearer than the openness alone would', () => {
    setCameraMode('auto');
    const grid = wallToTheSouth();
    const world = new World(grid.map);
    const from = at(grid.centre(2, 4));
    const camera = new TopDownCamera(16 / 9, { tiltDeg: TILT });
    camera.yawDeg = SOUTH_YAW;
    const auto = new AutoCamera(world);
    auto.seed(from, camera);
    const behind = camera.targetDistance;

    // The same place, looking the other way: nothing drawn faces the camera.
    const clear = new TopDownCamera(16 / 9, { tiltDeg: TILT });
    clear.yawDeg = NORTH_YAW;
    const other = new AutoCamera(world);
    other.seed(from, clear);
    assert.ok(behind < clear.targetDistance, 'the occluded framing is the nearer of the two');
    assert.ok(behind >= MIN_RESCUE_DISTANCE);
  });

  test('it stops just inside a far wall rather than diving all the way in', () => {
    setCameraMode('auto');
    // Open ground with one wall well beyond the floor: the case where backing
    // off is enough and collapsing onto the player would be pure loss.
    const grid = gridMap(
      [...Array.from({ length: 6 }, () => '.'.repeat(16)), '#'.repeat(16), ...Array.from({ length: 5 }, () => '.'.repeat(16))],
      { heights: { '.': { floor: 0, ceil: 512 } } },
    );
    const world = new World(grid.map);
    const from = at(grid.centre(8, 3));
    const camera = new TopDownCamera(16 / 9, { tiltDeg: WIDE_TILT });
    camera.yawDeg = SOUTH_YAW;
    const auto = new AutoCamera(world);
    auto.seed(from, camera);

    const look = { tiltDeg: camera.tiltDeg, yawDeg: camera.yawDeg, distance: 1e9 };
    const wall = nearestObstruction(world, from, look);
    assert.ok(wall - AUTO_OCCLUDED_DISTANCE > 100, `fixture: the wall at ${wall} must sit well beyond the floor`);
    assert.ok(camera.targetDistance < wall, 'inside the wall it found');
    assert.ok(
      camera.targetDistance > AUTO_OCCLUDED_DISTANCE,
      `stopped at ${camera.targetDistance} for a wall at ${wall} — the floor is a floor, not the answer`,
    );
  });

  test('the cap eases in rather than switching', () => {
    setCameraMode('auto');
    const grid = wallToTheSouth();
    const world = new World(grid.map);
    const from = at(grid.centre(2, 4));
    const camera = new TopDownCamera(16 / 9, { tiltDeg: TILT });
    camera.yawDeg = NORTH_YAW;
    const auto = new AutoCamera(world);
    auto.seed(from, camera); // seeds unoccluded
    const open = auto.occluded;

    camera.yawDeg = SOUTH_YAW;
    auto.tick(from, camera);
    const afterOneTic = auto.occluded;
    assert.ok(afterOneTic < open, 'one tic moves part of the way in');
    for (let i = 0; i < 200; i++) auto.tick(from, camera);
    assert.ok(auto.occluded < afterOneTic, 'and keeps going while the occluder stands');
  });
});

/**
 * The occlusion trace counts the bands the *mesh* drew, not the ones the two
 * sectors' raw heights imply. Boom's 242 is where those part company: a deep
 * water sector's upper is sized down to its control sector's ceiling
 * (`mapmesh.ts`'s `twoSidedBands`, docs/specials-transfers.md § Deep water), so the wall
 * across from one reaches far lower than `ceilHeight` says. Reading the raw
 * heights here made the camera blind to exactly that stretch.
 */
describe('Auto camera · framing past an occluder drawn by a render transfer', () => {
  const TILT = 60;
  const SOUTH_YAW = 0;

  /**
   * A row of deep water with the player in it, looking out at an ordinary room
   * to the south. The water's real ceiling is 192; its control sector's is 32,
   * which is where the room's upper is actually drawn down to.
   */
  function waterToTheNorth() {
    const grid = gridMap(['.....', '.....', '.....', '.....', 'wwwww', '.....', '.....'], {
      heights: { '.': { floor: 0, ceil: 512 }, w: { floor: 0, ceil: 192 } },
    });
    // Every `w` cell is its own sector, and all of them share the tag.
    for (let col = 0; col < grid.cols; col++) grid.map.sectors[grid.index(col, 4)].tag = 9;
    addControlSector(grid.map, { floorHeight: 0, ceilHeight: 32 }, 242, 9);
    return grid;
  }

  test('the wall across from deep water is found down at the drawn ceiling, not the real one', () => {
    const grid = waterToTheNorth();
    const transfers = transfersOf(grid.map);
    const world = new World(grid.map);
    // The player stands in the water; the camera hangs south, in the room.
    const from = at(grid.centre(2, 4));

    // The crossing sits well below the water's own 192 ceiling — inside the
    // stretch of upper that only the control sector's 32 accounts for.
    const look = { tiltDeg: TILT, yawDeg: SOUTH_YAW, distance: 600 };
    const found = nearestObstruction(world, from, look, transfers);
    assert.ok(Number.isFinite(found), `the drawn upper is found, got ${found}`);

    // And the same trace told the sectors' raw heights misses it outright,
    // which is what this used to do.
    assert.equal(
      nearestObstruction(world, from, { tiltDeg: TILT, yawDeg: SOUTH_YAW, distance: 600 }),
      Infinity,
      'read off raw ceilings the same wall is invisible',
    );
  });
});
