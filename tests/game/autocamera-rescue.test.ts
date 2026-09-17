import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import { AutoCamera, setCameraMode } from '../../src/game/autocamera.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import { TopDownCamera } from '../../src/render/camera.ts';
import { at, cliffEdge, eyeAt, plateau, room, wallToTheSouth } from '../fixtures/camerarooms.ts';
import {
  AUTO_OCCLUDED_DISTANCE,
  measureClearance,
  NEAR_TILT_LEAN,
  nearTiltLean,
  rescueFraming,
  type RescueFraming,
  AUTO_NARROW_DISTANCE,
} from '../../src/game/autocamera.ts';
import { MAX_TILT_DEG, MIN_RESCUE_DISTANCE, MIN_TILT_DEG } from '../../src/render/camera.ts';

/**
 * The buried-eye rescue: the camera backs off until its eye is out of the ground, and stays put
 * whenever it already is — which on ordinary geometry is every time. Its two neighbours are the
 * openness probe (`tests/game/autocamera.test.ts`) and the occluder framing
 * (`tests/game/autocamera-occluder.test.ts`). See docs/camera.md § The buried-eye rescue.
 */

describe('Auto camera · the buried-eye rescue', () => {
  const TILT = 60;
  const SOUTH_YAW = 0;
  const NORTH_YAW = 180;

  test('open floor never moves the framing', () => {
    const grid = room();
    const world = new World(grid.map);
    const from = at(grid.centre(6, 6));
    assert.equal(measureClearance(world, from, TILT, SOUTH_YAW, 600), 600);
  });

  test('a framing that would bury the eye is pulled in until it is not', () => {
    const grid = plateau();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 5));

    // The wanted framing puts the eye over the plateau and well below its floor.
    const wanted = eyeAt(from, TILT, 600);
    assert.ok(wanted.h < world.floorAt(wanted.x, wanted.y), 'fixture: 600u should bury the eye');

    const clear = measureClearance(world, from, TILT, SOUTH_YAW, 600);
    assert.ok(clear < 600, 'the rescue should have fired');
    assert.ok(clear >= MIN_RESCUE_DISTANCE);
    const eye = eyeAt(from, TILT, clear);
    assert.ok(eye.h > world.floorAt(eye.x, eye.y), 'the eye it settles on is above the ground');
  });

  test('the same plateau leaves a framing that never reaches it alone', () => {
    const grid = plateau();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 5));
    assert.equal(measureClearance(world, from, TILT, SOUTH_YAW, 300), 300);
  });

  test('it reads the direction the camera hangs in, not just the place', () => {
    const grid = plateau();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 5));
    assert.ok(measureClearance(world, from, TILT, SOUTH_YAW, 600) < 600, 'south, over the plateau');
    assert.equal(measureClearance(world, from, TILT, NORTH_YAW, 600), 600, 'north, over open floor');
  });

  test('geometry too close to escape stops at the rescue floor, never under it', () => {
    const grid = cliffEdge();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 1));
    assert.equal(measureClearance(world, from, TILT, SOUTH_YAW, 600), MIN_RESCUE_DISTANCE);
  });

  test('a tick over a plateau caps the zoom below what the openness alone asks for', () => {
    setCameraMode('auto');
    const grid = plateau();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 5));
    const camera = new TopDownCamera(16 / 9, { tiltDeg: TILT });
    camera.yawDeg = SOUTH_YAW;
    const auto = new AutoCamera(world);
    auto.seed(from, camera);

    const framed = measureClearance(world, from, camera.tiltDeg, camera.yawDeg, 1e9);
    assert.ok(camera.targetDistance <= framed, 'the cap, not the openness, decides here');
    assert.ok(camera.targetDistance >= MIN_RESCUE_DISTANCE);
    const eye = eyeAt(from, camera.tiltDeg, camera.targetDistance);
    assert.ok(eye.h > world.floorAt(eye.x, eye.y));
  });
});

/**
 * The mouth of a lift shaft: the player on a floor-0 pad with a high
 * neighbouring floor under where the camera hangs — the shape of DOOM E1M2's
 * lift at (-1534, 1584), where the framing's eye ends up beneath that floor
 * but a few steps further out along the same ray clear it and keep the whole
 * view. See docs/camera.md § The buried-eye rescue.
 */
const shaftMouth = () =>
  gridMap(['.......', '.......', 'HHHHHHH', 'HHHHHHH', 'HHHHHHH'], {
    heights: { '.': { floor: 0, ceil: 512 }, H: { floor: 320, ceil: 512 } },
  });

describe('Auto camera · a framing pulled in leans further over', () => {
  const SOUTH_YAW = 0;

  test('the lean is nothing at the openness mapping’s own narrow end and full at the occluded floor', () => {
    assert.equal(nearTiltLean(AUTO_NARROW_DISTANCE), 0);
    assert.equal(nearTiltLean(AUTO_NARROW_DISTANCE + 200), 0, 'and stays nothing wider still');
    assert.equal(nearTiltLean(AUTO_OCCLUDED_DISTANCE), NEAR_TILT_LEAN);
    assert.equal(nearTiltLean(MIN_RESCUE_DISTANCE), NEAR_TILT_LEAN, 'and stays full nearer still');
    const half = nearTiltLean((AUTO_NARROW_DISTANCE + AUTO_OCCLUDED_DISTANCE) / 2);
    assert.ok(half > 0 && half < NEAR_TILT_LEAN, 'and eases between the two');
  });

  test('a tick pulled to the floor leans, an open one does not', () => {
    setCameraMode('auto');
    const shutIn = wallToTheSouth();
    const shutInWorld = new World(shutIn.map);
    const from = at(shutIn.centre(2, 4));
    const camera = new TopDownCamera(16 / 9, { tiltDeg: 60 });
    camera.yawDeg = SOUTH_YAW;
    const auto = new AutoCamera(shutInWorld);
    auto.seed(from, camera);
    // The shift is a difference of two angles, so it carries float noise.
    const asked = nearTiltLean(camera.targetDistance);
    assert.ok(Math.abs(auto.tiltShift - asked) < 1e-9, `leaned ${auto.tiltShift}, the framing asks ${asked}`);
    assert.ok(auto.tiltShift > 0, 'fixture: the cap must have pulled it in for this to prove anything');

    const open = room();
    const openCamera = new TopDownCamera(16 / 9, { tiltDeg: 60 });
    openCamera.yawDeg = SOUTH_YAW;
    const openAuto = new AutoCamera(new World(open.map));
    openAuto.seed(at(open.centre(6, 6)), openCamera);
    assert.equal(openAuto.tiltShift, 0, 'an open room is framed at the mapped tilt exactly');
  });

  test('the framing is deaf to the tilt the camera is currently at, so it cannot hunt', () => {
    // The rescue steers the tilt; if anything deciding the framing read that
    // tilt back, the loop would close around a step function and limit-cycle.
    setCameraMode('auto');
    const grid = wallToTheSouth();
    const world = new World(grid.map);
    const from = at(grid.centre(2, 4));

    const poseAt = (tiltDeg: number) => {
      const camera = new TopDownCamera(16 / 9, { tiltDeg: 60 });
      camera.yawDeg = SOUTH_YAW;
      const auto = new AutoCamera(world);
      auto.seed(from, camera);
      // Drag the *current* pose somewhere else entirely and take one more tic.
      camera.snapFraming(MIN_RESCUE_DISTANCE, tiltDeg);
      auto.tick(from, camera);
      return { distance: camera.targetDistance, tiltDeg: camera.targetTiltDeg };
    };
    assert.deepEqual(poseAt(MIN_TILT_DEG), poseAt(MAX_TILT_DEG));
  });
});

describe('Auto camera · the buried-eye rescue searches both dials', () => {
  const TILT = 60;
  const SOUTH_YAW = 0;
  const LIMIT = 720;
  const out: RescueFraming = { distance: 0, tiltDeg: 0 };

  /** How far a candidate sits from the framing the openness asked for, in the rescue's own units. */
  const cost = (d: number, tilt: number, wanted: number, mapped: number) =>
    Math.abs(d - wanted) / 370 + Math.abs(tilt - mapped) / 20;

  test('a framing that is already clear is returned untouched', () => {
    const grid = room();
    const world = new World(grid.map);
    const ask = { mappedTilt: TILT, yawDeg: SOUTH_YAW, wanted: 400, limit: LIMIT };
    rescueFraming(world, at(grid.centre(6, 6)), ask, out);
    assert.deepEqual(out, { distance: 400, tiltDeg: TILT });
  });

  test('at a shaft mouth it finds a clear framing rather than collapsing the zoom', () => {
    const grid = shaftMouth();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 1));
    // Fixture: pulling in at the mapped tilt would fall under the occluded floor.
    assert.ok(measureClearance(world, from, TILT, SOUTH_YAW, 400) < AUTO_OCCLUDED_DISTANCE);

    rescueFraming(world, from, { mappedTilt: TILT, yawDeg: SOUTH_YAW, wanted: 400, limit: LIMIT }, out);
    const eye = eyeAt(from, out.tiltDeg, out.distance);
    assert.ok(eye.h > 320, 'the framing it picks hangs clear of the high floor');
    assert.ok(out.distance > AUTO_OCCLUDED_DISTANCE, 'and is not a collapse');
  });

  test('it takes the nearest clear framing, weighing a degree against a unit by each dial’s span', () => {
    const grid = shaftMouth();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 1));
    const wanted = 400;
    rescueFraming(world, from, { mappedTilt: TILT, yawDeg: SOUTH_YAW, wanted, limit: LIMIT }, out);
    const won = cost(out.distance, out.tiltDeg, wanted, TILT);

    // Nothing else the search could have reached is both clear and nearer.
    // Its reach starts at the tilt it was given: it leans over, never back.
    for (let tilt = TILT; tilt <= MAX_TILT_DEG; tilt += 5) {
      for (let d = MIN_RESCUE_DISTANCE; d <= LIMIT; d += 24) {
        const eye = eyeAt(from, tilt, d);
        if (eye.h <= world.floorAt(eye.x, eye.y) + 32) continue;
        assert.ok(
          cost(d, tilt, wanted, TILT) >= won - 1e-9,
          `${d}u at ${tilt}° is clear and nearer than the ${out.distance}u at ${out.tiltDeg}° it took`,
        );
      }
    }
  });

  test('it leans over, never back toward top-down — even where turning overhead would clear', () => {
    // This cliff buries every framing the search may reach, and turning toward
    // overhead would lift the eye straight over it. That escape is refused:
    // it buys height by spending the sight of what the player walks into.
    const grid = cliffEdge();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 1));
    let overheadClears = false;
    for (let tilt = MIN_TILT_DEG; tilt < TILT && !overheadClears; tilt += 5) {
      for (let d = MIN_RESCUE_DISTANCE; d <= LIMIT && !overheadClears; d += 24) {
        const eye = eyeAt(from, tilt, d);
        overheadClears = eye.h > world.floorAt(eye.x, eye.y) + 32;
      }
    }
    assert.ok(overheadClears, 'fixture: turning toward overhead would clear this cliff');

    rescueFraming(world, from, { mappedTilt: TILT, yawDeg: SOUTH_YAW, wanted: 600, limit: LIMIT }, out);
    assert.ok(out.tiltDeg >= TILT, 'the tilt never goes back toward top-down');
    assert.equal(out.tiltDeg, TILT, 'and here nothing leaning over clears either');
    assert.equal(out.distance, measureClearance(world, from, TILT, SOUTH_YAW, 600), 'so pulling in decides');
  });

  test('an occluder at the player’s shoulder leaves nothing to reach, and pulling in decides', () => {
    // `limit` is the occlusion cap's own distance, so a wall right beside the
    // player can put it under the rescue floor: the search has no candidate.
    const grid = cliffEdge();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 1));
    const ask = { mappedTilt: TILT, yawDeg: SOUTH_YAW, wanted: 600, limit: MIN_RESCUE_DISTANCE - 1 };
    rescueFraming(world, from, ask, out);
    assert.equal(out.tiltDeg, TILT, 'the mapped tilt stands');
    assert.equal(out.distance, measureClearance(world, from, TILT, SOUTH_YAW, 600), 'and pulling in decides');
  });

  test('a tick at the shaft mouth keeps a real framing, and lets it go once the burial does', () => {
    setCameraMode('auto');
    const grid = shaftMouth();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 1));
    const camera = new TopDownCamera(16 / 9, { tiltDeg: TILT });
    camera.yawDeg = SOUTH_YAW;
    const auto = new AutoCamera(world);
    auto.seed(from, camera);

    assert.ok(camera.targetDistance > AUTO_OCCLUDED_DISTANCE, 'the zoom is not collapsed');
    const eye = eyeAt(from, camera.targetTiltDeg, camera.targetDistance);
    assert.ok(eye.h > 320, 'and the eye hangs clear of the high floor');

    // The lift arrives: the player stands level with the high floor, nothing
    // buries, and whatever the rescue was holding drains away — the framing
    // settles on the same one a camera that was never rescued would pick.
    const up = { ...from, z: 320 };
    const settle = (c: TopDownCamera, a: AutoCamera) => {
      for (let i = 0; i < 300; i++) {
        a.tick(up, c);
        c.tick(DOOM_TIC, up, null);
      }
    };
    settle(camera, auto);
    const fresh = new TopDownCamera(16 / 9, { tiltDeg: TILT });
    fresh.yawDeg = SOUTH_YAW;
    const freshAuto = new AutoCamera(world);
    freshAuto.seed(up, fresh);
    settle(fresh, freshAuto);
    assert.ok(Math.abs(camera.targetTiltDeg - fresh.targetTiltDeg) < 0.01, 'the tilt shift drained away');
    assert.ok(Math.abs(camera.targetDistance - fresh.targetDistance) < 1, 'and so did the distance');
  });
});
