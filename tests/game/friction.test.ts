import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addControlLine, gridMap } from '../fixtures/gridmap.ts';
import { forcesRig } from '../fixtures/forcesrig.ts';
import { Forces } from '../../src/game/specials/forces.ts';
import { ORIG_FRICTION } from '../../src/game/specials/defs.ts';
import { makeTouchCache, World } from '../../src/game/world.ts';
import { PLAYER_RADIUS } from '../../src/game/player.ts';

/**
 * Boom's sector friction (linedef 223): the two curves out of `P_SpawnFriction`,
 * `P_GetFriction`'s straddle rule, `P_GetMoveFactor`'s momentum boost, and the
 * mapping onto this engine's movement model.
 * See docs/specials-forces.md § Friction and docs/movement.md § Friction.
 */
/**
 * `P_SpawnFriction`'s curve at six line lengths, each worked out by hand:
 * `friction = (0x1EB8 × len) / 0x80 + 0xD000`, so 32 → 0x07AE + 0xD000, 96 → 0x170A + 0xD000,
 * 128 → 0x1EB8 + 0xD000, 160 → 0x2666 + 0xD000, 192 → 0x2E14 + 0xD000. A length of 0 is the
 * intercept alone. These are transcriptions, not a second copy of the formula.
 */
const FRICTION_ANCHORS: readonly (readonly [length: number, raw: number])[] = [
  [0, 0xd000],
  [32, 0xd7ae],
  [96, 0xe70a],
  [128, 0xeeb8],
  [160, 0xf666],
  [192, 0xfe14],
];

describe('Specials · Boom friction', () => {
  /** Boom's generalized friction bit, `p_spec.h`'s `FRICTION_MASK`. */
  const FRICTION_MASK = 0x100;
  /** Well past `MORE_FRICTION_MOMENTUM << 2`, so a muddy floor gives its full boost. */
  const WALKING = 500;

  /** Three cells; the middle one gets a 223 line of `length` and the friction bit. */
  function rig(length: number) {
    return forcesRig(223, { dx: length, sectorBit: FRICTION_MASK });
  }

  /** `frictionUnder` at a cell's centre, standing on its floor. */
  function under(rigged: ReturnType<typeof rig>, col: number, speed = WALKING) {
    const at = rigged.grid.centre(col, 0);
    const at3 = { x: at.x, y: at.y, z: 0 };
    const f = rigged.forces.frictionUnder(at3, { radius: PLAYER_RADIUS, speed, cache: rigged.cache });
    return { friction: f.friction, targetScale: f.targetScale, accelScale: f.accelScale };
  }

  test('the friction curve is P_SpawnFriction’s, in map-unit line lengths', () => {
    // Worked out by hand from `friction = (0x1EB8 × len) / 0x80 + 0xD000`, rather than recomputed
    // here: an expression that mirrors the implementation agrees with any implementation of it.
    for (const [length, raw] of FRICTION_ANCHORS) {
      assert.equal(under(rig(length), 1).friction, raw / 0x10000, `length ${length}`);
    }
  });

  test('a short line is mud — slower, and a long one is ice — slipperier', () => {
    const mud = under(rig(32), 1);
    const ice = under(rig(160), 1);
    assert.ok(mud.friction < ORIG_FRICTION, `mud friction ${mud.friction}`);
    assert.ok(ice.friction > ORIG_FRICTION, `ice friction ${ice.friction}`);
    // Mud cuts the top speed hard and shortens the ramp; ice does the opposite.
    assert.ok(mud.targetScale < 0.5, `mud targetScale ${mud.targetScale}`);
    assert.ok(mud.accelScale > 1, `mud accelScale ${mud.accelScale}`);
    assert.ok(ice.targetScale > 1, `ice targetScale ${ice.targetScale}`);
    assert.ok(ice.accelScale < 0.5, `ice accelScale ${ice.accelScale}`);
  });

  test('both clamps hold at the extremes', () => {
    // A 1000-unit line would give friction well over 1 — momentum that grows.
    const wild = under(rig(1000), 1);
    assert.ok(wild.friction <= 1, `friction was ${wild.friction}`);
    // And a zero-length one would give a negative movefactor.
    const tiny = under(rig(0), 1);
    assert.ok(tiny.targetScale > 0, `targetScale was ${tiny.targetScale}`);
  });

  test('friction clamped to 1 is fast ice, not an infinite target at a zero rate', () => {
    // The regression: `friction` pinned at exactly 1 made `targetScale` infinite
    // and `accelScale` zero, whose product is the NaN that froze the player for
    // the rest of the level (mbfedit!.wad MAP01 sectors 121/154).
    const perfect = under(rig(1000), 1);
    assert.ok(Number.isFinite(perfect.targetScale), `targetScale was ${perfect.targetScale}`);
    assert.ok(perfect.accelScale > 0, `accelScale was ${perfect.accelScale}`);
    // `P_XYMovement`'s MAXMOVE over the normal-floor run terminal.
    assert.ok(Math.abs(perfect.targetScale - 1.8) < 1e-9, `targetScale was ${perfect.targetScale}`);
    // And slipperier than an ordinary ice line, which the bound must not touch.
    const ice = under(rig(160), 1);
    assert.ok(perfect.accelScale < ice.accelScale, `${perfect.accelScale} vs ${ice.accelScale}`);
    assert.ok(perfect.friction > ice.friction, `${perfect.friction} vs ${ice.friction}`);
    assert.ok(Number.isFinite(1 * perfect.targetScale * perfect.accelScale));
  });

  test('the MAXMOVE bound leaves an ordinary ice line alone', () => {
    // The two curves' own values still reach `frictionUnder` untouched either
    // side of the crossover — the bound only ever binds where MBF's own clamp did.
    for (const [length, raw] of FRICTION_ANCHORS) {
      const got = under(rig(length), 1).friction;
      assert.equal(got, raw / 0x10000, `length ${length}: ${got} vs ${raw / 0x10000}`);
    }
  });

  test('a sector without the friction bit is a normal floor', () => {
    const rigged = rig(160);
    rigged.grid.map.sectors[rigged.middle].special = 0;
    const f = under(rigged, 1);
    assert.equal(f.friction, ORIG_FRICTION);
    assert.equal(f.targetScale, 1);
    assert.equal(f.accelScale, 1);
  });

  test('a normal floor scales nothing at all — the no-223 map is untouched', () => {
    const grid = gridMap(['...']);
    const forces = new Forces(grid.map, new World(grid.map));
    const at = grid.centre(1, 0);
    const f = forces.frictionUnder(
      { x: at.x, y: at.y, z: 0 },
      { radius: PLAYER_RADIUS, speed: WALKING, cache: makeTouchCache() },
    );
    assert.equal(f.friction, ORIG_FRICTION);
    assert.equal(f.targetScale, 1);
    assert.equal(f.accelScale, 1);
  });

  test('the neighbouring sector is unaffected', () => {
    const rigged = rig(160);
    const at = rigged.grid.centre(0, 0);
    const f = rigged.forces.frictionUnder(
      { x: at.x - 32, y: at.y, z: 0 },
      { radius: PLAYER_RADIUS, speed: WALKING, cache: rigged.cache },
    );
    assert.equal(f.friction, ORIG_FRICTION);
  });

  test('standing above a friction sector’s floor does not pick it up', () => {
    const rigged = rig(160);
    const at = rigged.grid.centre(1, 0);
    const f = rigged.forces.frictionUnder(
      { x: at.x, y: at.y, z: 8 },
      { radius: PLAYER_RADIUS, speed: WALKING, cache: rigged.cache },
    );
    assert.equal(f.friction, ORIG_FRICTION);
  });

  test('a body straddling an ice patch is on it', () => {
    const rigged = rig(160);
    const edgeX = (rigged.grid.centre(0, 0).x + rigged.grid.centre(1, 0).x) / 2;
    const f = rigged.forces.frictionUnder(
      { x: edgeX - 4, y: rigged.grid.centre(1, 0).y, z: 0 },
      { radius: PLAYER_RADIUS, speed: WALKING, cache: rigged.cache },
    );
    assert.ok(f.friction > ORIG_FRICTION, `friction was ${f.friction}`);
  });

  test('mud has precedence over ice where a body touches both', () => {
    const grid = gridMap(['...']);
    for (const col of [0, 1]) {
      grid.map.sectors[grid.index(col, 0)].special = FRICTION_MASK;
      grid.map.sectors[grid.index(col, 0)].tag = 10 + col;
    }
    addControlLine(grid.map, 32, 0, 223, 10); // mud on the left cell
    addControlLine(grid.map, 160, 0, 223, 11); // ice on the right one
    const forces = new Forces(grid.map, new World(grid.map));
    const edgeX = (grid.centre(0, 0).x + grid.centre(1, 0).x) / 2;
    const f = forces.frictionUnder(
      { x: edgeX, y: grid.centre(0, 0).y, z: 0 },
      { radius: PLAYER_RADIUS, speed: WALKING, cache: makeTouchCache() },
    );
    assert.ok(f.friction < ORIG_FRICTION, `expected the muddy value, got ${f.friction}`);
  });

  test('mud’s thrust boost steps up with the body’s own speed', () => {
    const rigged = rig(32);
    const still = under(rigged, 1, 0).targetScale;
    const creeping = under(rigged, 1, 10).targetScale;
    const running = under(rigged, 1, WALKING).targetScale;
    assert.ok(still < creeping, `${still} then ${creeping}`);
    assert.ok(creeping < running, `${creeping} then ${running}`);
    // Three doublings between standing still and full speed.
    assert.ok(Math.abs(running / still - 8) < 1e-9, `ratio was ${running / still}`);
  });

  test('ice ignores the speed boost — it is mud’s alone', () => {
    const rigged = rig(160);
    assert.equal(under(rigged, 1, 0).targetScale, under(rigged, 1, WALKING).targetScale);
  });
});
