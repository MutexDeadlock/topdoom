import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World } from '../../src/game/world.ts';
import { AutoCamera, measureOpenness, setCameraMode } from '../../src/game/autocamera.ts';
import { TopDownCamera } from '../../src/render/camera.ts';

/**
 * The auto camera's openness probe and its mapping onto the framing envelope:
 * `spread` over the whole fan drives the zoom, `ahead` along the camera's view
 * bearing drives the tilt. Asserts monotonicity and the clamps rather than
 * pinning the tuned-by-feel digits. See docs/render.md § Auto camera.
 */

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
    const corridorOpenness = measureOpenness(new World(c.map), pc.x, pc.y, EAST);

    const r = room();
    const pr = r.centre(6, 6);
    const roomOpenness = measureOpenness(new World(r.map), pr.x, pr.y, EAST);

    assert.ok(corridorOpenness.spread < 0.1, `a one-cell corridor reads shut-in (got ${corridorOpenness.spread})`);
    assert.ok(roomOpenness.spread > 0.5, `an open room reads open (got ${roomOpenness.spread})`);
  });

  test('`ahead` follows the view bearing while `spread` ignores it', () => {
    const g = deadEndFacingHall();
    const world = new World(g.map);
    // Standing at the west end: the hall runs east, a wall sits immediately west.
    const p = g.centre(0, 2);
    const east = measureOpenness(world, p.x, p.y, EAST);
    const west = measureOpenness(world, p.x, p.y, WEST);

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
    const shut = measureOpenness(world, p.x, p.y, NORTH);
    // Raise the door sectors' ceilings — the probe must see through on the
    // very next measurement, the way an opening door does mid-level.
    for (let col = 0; col < g.cols; col++) g.map.sectors[g.index(col, 5)].ceilHeight = 128;
    const open = measureOpenness(world, p.x, p.y, NORTH);
    assert.ok(shut.ahead > 0, 'the half room already reads somewhat open');
    assert.ok(open.ahead > shut.ahead, `opening the doors widens the view north (${shut.ahead} -> ${open.ahead})`);
  });

  test('a corner of a big room reads boxed in, not open', () => {
    // The room's own centre against one of its corners. A mean over the fan
    // would call the corner open — most rays hit wall a step away, but the few
    // running the length of the room are long enough to carry the average.
    const r = room();
    const world = new World(r.map);
    const mid = r.centre(6, 6);
    const edge = r.centre(0, 0);
    const centre = measureOpenness(world, mid.x, mid.y, EAST);
    const corner = measureOpenness(world, edge.x, edge.y, EAST);

    assert.ok(
      corner.spread < centre.spread / 2,
      `the corner reads far tighter than the centre (${corner.spread} vs ${centre.spread})`,
    );
  });

  test('seed jumps the camera, narrower in a corridor than in a room', () => {
    const camera = new TopDownCamera(16 / 9);

    const c = corridor();
    const pc = c.centre(4, 1);
    new AutoCamera(new World(c.map)).seed(pc.x, pc.y, camera);
    const corridorDistance = camera.distance;
    const corridorTilt = camera.tiltDeg;
    assert.equal(camera.targetDistance, corridorDistance, 'seed leaves nothing to glide to');
    assert.equal(camera.targetTiltDeg, corridorTilt);

    const r = room();
    const pr = r.centre(6, 6);
    new AutoCamera(new World(r.map)).seed(pr.x, pr.y, camera);
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
      auto.seed(pc.x, pc.y, camera);
      auto.tick(pc.x, pc.y, camera);
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
    new AutoCamera(world).seed(p.x, p.y, facingHall);
    const facingWall = new TopDownCamera(16 / 9, { yawDeg: 90 });
    new AutoCamera(world).seed(p.x, p.y, facingWall);

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
    auto.tick(pc.x, pc.y, camera);
    assert.equal(camera.distance, before, 'tick writes the target, not the field');
    assert.ok(camera.targetDistance < before, 'a corridor pulls the default framing in');
  });
});
