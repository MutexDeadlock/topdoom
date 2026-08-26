import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import {
  AutoCamera,
  measureClearance,
  measureOpenness,
  setCameraMode,
  AUTO_OCCLUDED_DISTANCE,
  nearestObstruction,
  rescueFraming,
  type RescueFraming,
  NEAR_TILT_LEAN,
  nearTiltLean,
  AUTO_NARROW_DISTANCE,
} from '../../src/game/autocamera.ts';
import { EYE_HEIGHT } from '../../src/game/player.ts';
import { MAX_TILT_DEG, MIN_RESCUE_DISTANCE, MIN_TILT_DEG, TopDownCamera } from '../../src/render/camera.ts';
import type { Pos2, Pos3 } from '../../src/types.ts';

/**
 * The auto camera's openness probe and its mapping onto the framing envelope:
 * `spread` over the whole fan drives the zoom, `ahead` along the camera's view
 * bearing drives the tilt. Asserts monotonicity and the clamps rather than
 * pinning the tuned-by-feel digits. See docs/camera.md § Auto camera.
 */

/** A grid cell centre as the probe wants it, standing on a floor-0 cell. */
const at = (p: Pos2): Pos3 => ({ ...p, z: 0 });

/** DOOM bearings, degrees: +x is east, +y north. */
const EAST = 0;
const NORTH = 90;
const WEST = 180;

/** A long one-cell corridor running east–west: about as shut-in as geometry gets. */
const corridor = () =>
  gridMap([
    '#########',
    '.........',
    '#########',
  ]);

/** A 12×12 open room. */
const room = () => gridMap(Array.from({ length: 12 }, () => '.'.repeat(12)));

/**
 * A dead end at the west, a hall running east — the shape the directional half
 * exists for. The player stands at the closed end.
 */
const deadEndFacingHall = () =>
  gridMap(
    [
      '###################',
      '...................',
      '...................',
      '...................',
      '###################',
    ],
    { cell: 256 },
  );

describe('game · auto camera openness', () => {
  test('a corridor reads shut-in, an open room reads open', () => {
    const c = corridor();
    const pc = c.centre(4, 1);
    const corridorOpenness = measureOpenness(new World(c.map), at(pc), EAST);

    const r = room();
    const pr = r.centre(6, 6);
    const roomOpenness = measureOpenness(new World(r.map), at(pr), EAST);

    assert.ok(corridorOpenness.spread < 0.1, `a one-cell corridor reads shut-in (got ${corridorOpenness.spread})`);
    assert.ok(roomOpenness.spread > 0.5, `an open room reads open (got ${roomOpenness.spread})`);
  });

  test('`ahead` follows the view bearing while `spread` ignores it', () => {
    const g = deadEndFacingHall();
    const world = new World(g.map);
    // Standing at the west end: the hall runs east, a wall sits immediately west.
    const p = g.centre(0, 2);
    const east = measureOpenness(world, at(p), EAST);
    const west = measureOpenness(world, at(p), WEST);

    assert.ok(
      east.ahead > west.ahead,
      `looking down the hall reads more open than facing the dead end (${east.ahead} vs ${west.ahead})`,
    );
    assert.equal(east.spread, west.spread, 'the undirected half is the same measurement either way');
  });

  test('blocking is live: a shut door wall blocks the rays until its sectors open', () => {
    // A room cut in half by a row of shut doors. The south half is open enough
    // to sit above the mapping's shut-in floor, so the doors opening shows.
    const g = gridMap([
      '............',
      '............',
      '............',
      '............',
      '............',
      '++++++++++++',
      '............',
      '............',
      '............',
      '............',
      '............',
    ]);
    const world = new World(g.map);
    // Standing in the south half, looking north at the doors.
    const p = g.centre(5, 8);
    const shut = measureOpenness(world, at(p), NORTH);
    // Raise the door sectors' ceilings — the probe must see through on the
    // very next measurement, the way an opening door does mid-level.
    for (let col = 0; col < g.cols; col++) g.map.sectors[g.index(col, 5)].ceilHeight = 128;
    const open = measureOpenness(world, at(p), NORTH);
    assert.ok(shut.ahead > 0, 'the half room already reads somewhat open');
    assert.ok(open.ahead > shut.ahead, `opening the doors widens the view north (${shut.ahead} -> ${open.ahead})`);
  });

  test('a ledge the player cannot see over bounds the fan', () => {
    // A pen inside an open field, walled by a step 64 units up: every one of
    // those lines has a wide vertical opening, so a height-blind probe runs
    // straight over them and calls the pen as open as the field beyond it.
    // EPIC.WAD MAP02 around (-4018, -3014) is the case this was found on, a
    // railed pen whose whole fan read 1280 and pinned both dials at 1.
    const g = gridMap(
      [
        '.........',
        '.........',
        '..^^^^^..',
        '..^...^..',
        '..^...^..',
        '..^...^..',
        '..^^^^^..',
        '.........',
        '.........',
      ],
      { heights: { '^': { floor: 64, ceil: 128 } } },
    );
    const pen = measureOpenness(new World(g.map), at(g.centre(4, 4)), EAST);

    assert.ok(pen.spread < 0.5, `the pen is not wide open (got ${pen.spread})`);
    assert.ok(pen.ahead < 0.5, `and the view does not reach past its wall (got ${pen.ahead})`);
  });

  test('a corner of a big room reads boxed in, not open', () => {
    // The room's own centre against one of its corners. A mean over the fan
    // would call the corner open — most rays hit wall a step away, but the few
    // running the length of the room are long enough to carry the average.
    const r = room();
    const world = new World(r.map);
    const mid = r.centre(6, 6);
    const edge = r.centre(0, 0);
    const centre = measureOpenness(world, at(mid), EAST);
    const corner = measureOpenness(world, at(edge), EAST);

    assert.ok(
      corner.spread < centre.spread / 2,
      `the corner reads far tighter than the centre (${corner.spread} vs ${centre.spread})`,
    );
  });

  test('seed jumps the camera, narrower in a corridor than in a room', () => {
    const camera = new TopDownCamera(16 / 9);

    const c = corridor();
    const pc = c.centre(4, 1);
    new AutoCamera(new World(c.map)).seed(at(pc), camera);
    const corridorDistance = camera.distance;
    const corridorTilt = camera.tiltDeg;
    assert.equal(camera.targetDistance, corridorDistance, 'seed leaves nothing to glide to');
    assert.equal(camera.targetTiltDeg, corridorTilt);

    const r = room();
    const pr = r.centre(6, 6);
    new AutoCamera(new World(r.map)).seed(at(pr), camera);
    assert.ok(camera.distance > corridorDistance, 'an open room frames wider than a corridor');
    assert.ok(camera.tiltDeg > corridorTilt, 'and more top-down');
  });

  test('manual mode leaves the framing entirely alone', () => {
    const c = corridor();
    const pc = c.centre(4, 1);
    const auto = new AutoCamera(new World(c.map));
    const camera = new TopDownCamera(16 / 9);
    setCameraMode('manual');
    try {
      auto.seed(at(pc), camera);
      auto.tick(at(pc), camera);
      assert.equal(camera.distance, 480, 'the constructor default stands');
      assert.equal(camera.targetDistance, 480, 'and nothing was queued to glide to');
      assert.equal(camera.targetTiltDeg, 60);
    } finally {
      setCameraMode('auto');
    }
  });

  test('turning the camera to face a wall lowers the tilt but leaves the zoom alone', () => {
    const g = deadEndFacingHall();
    const world = new World(g.map);
    const p = g.centre(0, 2);

    // yawDeg + 90 is the bearing the camera looks along, so -90 looks east.
    const facingHall = new TopDownCamera(16 / 9, { yawDeg: -90 });
    new AutoCamera(world).seed(at(p), facingHall);
    const facingWall = new TopDownCamera(16 / 9, { yawDeg: 90 });
    new AutoCamera(world).seed(at(p), facingWall);

    assert.ok(
      facingHall.tiltDeg > facingWall.tiltDeg,
      `the hall earns more tilt than the dead end (${facingHall.tiltDeg} vs ${facingWall.tiltDeg})`,
    );
    assert.equal(facingHall.distance, facingWall.distance, 'the zoom is undirected');
  });

  test('tick retargets without jumping', () => {
    const camera = new TopDownCamera(16 / 9);
    const c = corridor();
    const pc = c.centre(4, 1);
    const auto = new AutoCamera(new World(c.map));
    const before = camera.distance;
    auto.tick(at(pc), camera);
    assert.equal(camera.distance, before, 'tick writes the target, not the field');
    assert.ok(camera.targetDistance < before, 'a corridor pulls the default framing in');
  });
});

/**
 * The buried-eye rescue: the camera backs off until its eye is out of the
 * ground, and stays put whenever it already is — which on ordinary geometry is
 * every time. See docs/camera.md § The buried-eye rescue.
 */

/** A high plateau three cells south of the player, with room to the north. */
const plateau = () =>
  gridMap(
    [
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      'PPPPPPP',
      'PPPPPPP',
      'PPPPPPP',
    ],
    { heights: { P: { floor: 512, ceil: 1024 } } },
  );

/**
 * A plateau starting half a cell away, on a grid fine enough that even the
 * closest framing the rescue will try still hangs over it.
 */
const cliffEdge = () =>
  gridMap(['.......', '.......', 'PPPPPPP', 'PPPPPPP', 'PPPPPPP'], {
    cell: 64,
    heights: { P: { floor: 512, ceil: 1024 } },
  });

/** Where a camera `distance` back along `tiltDeg` at yaw 0 (due south) actually sits. */
const eyeAt = (from: Pos3, tiltDeg: number, distance: number) => {
  const tilt = (tiltDeg * Math.PI) / 180;
  return {
    x: from.x,
    y: from.y - Math.sin(tilt) * distance,
    h: from.z + EYE_HEIGHT + Math.cos(tilt) * distance,
  };
};

describe('game · the buried-eye rescue', () => {
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

describe('game · a framing pulled in leans further over', () => {
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

describe('game · the buried-eye rescue searches both dials', () => {
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
    rescueFraming(world, at(grid.centre(6, 6)), TILT, SOUTH_YAW, 400, LIMIT, out);
    assert.deepEqual(out, { distance: 400, tiltDeg: TILT });
  });

  test('at a shaft mouth it finds a clear framing rather than collapsing the zoom', () => {
    const grid = shaftMouth();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 1));
    // Fixture: pulling in at the mapped tilt would fall under the occluded floor.
    assert.ok(measureClearance(world, from, TILT, SOUTH_YAW, 400) < AUTO_OCCLUDED_DISTANCE);

    rescueFraming(world, from, TILT, SOUTH_YAW, 400, LIMIT, out);
    const eye = eyeAt(from, out.tiltDeg, out.distance);
    assert.ok(eye.h > 320, 'the framing it picks hangs clear of the high floor');
    assert.ok(out.distance > AUTO_OCCLUDED_DISTANCE, 'and is not a collapse');
  });

  test('it takes the nearest clear framing, weighing a degree against a unit by each dial’s span', () => {
    const grid = shaftMouth();
    const world = new World(grid.map);
    const from = at(grid.centre(3, 1));
    const wanted = 400;
    rescueFraming(world, from, TILT, SOUTH_YAW, wanted, LIMIT, out);
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

    rescueFraming(world, from, TILT, SOUTH_YAW, 600, LIMIT, out);
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
    rescueFraming(world, from, TILT, SOUTH_YAW, 600, MIN_RESCUE_DISTANCE - 1, out);
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
        c.tick(1 / 35, up, null);
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

/**
 * Framing past an occluder: only a wall the camera can actually see counts —
 * a room's own wall between the player inside it and a camera hanging outside
 * hides nothing — and the framing backs off only as far as the wall it does
 * find. See docs/camera.md § Framing past an occluder.
 */

/**
 * A wall cell south of the player with open floor either side, under a ceiling
 * high enough that the camera cannot simply look over the wall's top — what it
 * draws is an upper quad up to that ceiling, and the test is about which side
 * of it faces the camera.
 */
const wallToTheSouth = () =>
  gridMap(
    ['.....', '.....', '.....', '.....', '.....', '#####', '.....', '.....'],
    { heights: { '.': { floor: 0, ceil: 512 } } },
  );

/** The same wall, drawn only to 256 — low enough that a wide framing hangs over its top. */
const lowWallToTheSouth = () =>
  gridMap(
    ['.....', '.....', '.....', '.....', '.....', '#####', '.....', '.....'],
    { heights: { '.': { floor: 0, ceil: 256 } } },
  );

describe('game · framing past an occluder', () => {
  const TILT = 60;
  /** The tilt the auto camera reaches over open ground — what the far-wall case is framed at. */
  const WIDE_TILT = 70;
  const SOUTH_YAW = 0;
  const NORTH_YAW = 180;

  test('open floor obstructs nothing', () => {
    const grid = room();
    const world = new World(grid.map);
    assert.equal(nearestObstruction(world, at(grid.centre(6, 6)), TILT, SOUTH_YAW, 600), Infinity);
  });

  test('a wall the camera hangs behind hides the player, and says how far off it is', () => {
    const grid = wallToTheSouth();
    const world = new World(grid.map);
    // From row 4 the camera at 600u clears the wall's far side, so it looks at
    // the face the wall draws for it.
    const at4 = at(grid.centre(2, 4));
    const d = nearestObstruction(world, at4, TILT, SOUTH_YAW, 600);
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
    assert.equal(nearestObstruction(world, at(grid.centre(2, 4)), TILT, NORTH_YAW, 600), Infinity);
  });

  test('a wall the camera hangs well over is left to the fade, and the framing decides which', () => {
    const grid = lowWallToTheSouth();
    const world = new World(grid.map);
    const from = at(grid.centre(2, 4));
    // Same wall, same place: near in the eye is still under its top, far out it
    // is over it and what little the wall covers is the fade's to dissolve.
    assert.ok(Number.isFinite(nearestObstruction(world, from, TILT, SOUTH_YAW, 400)), 'near in, under the top');
    assert.equal(nearestObstruction(world, from, TILT, SOUTH_YAW, 800), Infinity, 'far out, over the top');
  });

  test('a framing that stops short of the wall is unobstructed', () => {
    const grid = wallToTheSouth();
    const world = new World(grid.map);
    assert.equal(nearestObstruction(world, at(grid.centre(2, 0)), TILT, SOUTH_YAW, 300), Infinity);
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

    const wall = nearestObstruction(world, from, camera.tiltDeg, camera.yawDeg, 1e9);
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
