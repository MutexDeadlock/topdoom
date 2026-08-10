import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECTILE_RADIUS, stepTouchesBody } from '../../src/game/spritefxdefs.ts';
import { MONSTER_HIT_HEIGHT, MONSTER_STATS } from '../../src/game/monsters/defs.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { boxToCircleRadius } from '../../src/util/geom.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * A projectile's contact test was one flat 40-unit disc plus a ±128 height
 * tolerance for every missile and every body alike, sampled at the end of each
 * frame's step. That made monster fireballs hit far too generously, made the
 * player's own missiles thread through wide monsters, and — since `game.ts`
 * clamps `dt` at 0.05s — let the fastest missiles step clean past a body.
 * See docs/monster-attacks.md § Monster projectiles in flight.
 */

const IMP = 3001;
const MANCUBUS = 67;
const CACODEMON = 3005;

/** A body standing at the origin on the floor. */
const AT_ORIGIN: Pos3 = { x: 0, y: 0, z: 0 };

/** A step of `len` units flying east at height `z`, passing `offset` units north of the origin. */
function stepPast(offset: number, z: number, len = 12): { from: Pos3; to: Pos3 } {
  return {
    from: { x: -len / 2, y: offset, z },
    to: { x: len / 2, y: offset, z },
  };
}

describe('Regressions · projectile contact', () => {
  test('an imp fireball hits at vanilla width, not the old flat 40 units', () => {
    const ball = PROJECTILE_RADIUS.BAL1;
    assert.equal(ball, 6, "MT_TROOPSHOT's own mobjinfo radius");
    // PIT_CheckThing's blockdist is 16 + 6 = 22, as the equal-mean-width circle.
    const reach = boxToCircleRadius(PLAYER_RADIUS + ball);
    assert.ok(reach > 27 && reach < 29, `expected ~28 units of reach, got ${reach}`);

    const near = stepPast(25, 20);
    assert.notEqual(stepTouchesBody(near.from, near.to, AT_ORIGIN, PLAYER_RADIUS, PLAYER_HEIGHT, ball), null);

    // Inside the old 40-unit disc, outside vanilla's box: this used to hit.
    const wide = stepPast(35, 20);
    assert.equal(stepTouchesBody(wide.from, wide.to, AT_ORIGIN, PLAYER_RADIUS, PLAYER_HEIGHT, ball), null);
  });

  test('the height band is PIT_CheckThing’s over/under pair, not ±128', () => {
    const ball = PROJECTILE_RADIUS.BAL1;
    const args = [AT_ORIGIN, PLAYER_RADIUS, PLAYER_HEIGHT, ball] as const;

    const chest = stepPast(0, 32);
    assert.notEqual(stepTouchesBody(chest.from, chest.to, ...args), null, 'level with the chest');

    // Clearing the player's own 56-unit height. The old ±128 tolerance hit here.
    const overhead = stepPast(0, 100);
    assert.equal(stepTouchesBody(overhead.from, overhead.to, ...args), null, 'passes overhead');

    // Below the feet by more than the missile's own 8-unit height.
    const under = stepPast(0, -40);
    assert.equal(stepTouchesBody(under.from, under.to, ...args), null, 'passes underneath');

    // Asymmetric about the feet: grazing the ankles connects, unlike a ± band.
    const ankles = stepPast(0, -6);
    assert.notEqual(stepTouchesBody(ankles.from, ankles.to, ...args), null, 'grazes the feet');
  });

  test('a BFG ball meets a wide monster across its real width', () => {
    const bfg = PROJECTILE_RADIUS.BFS1;
    assert.equal(bfg, 13, "MT_BFG's own mobjinfo radius");
    const fat = MONSTER_STATS[MANCUBUS].radius;
    assert.equal(fat, 48, "MT_FATSO's own mobjinfo radius");

    // 50 units off centre is well inside a mancubus and was outside the old
    // flat 24-unit test — the ball flew straight through its visible bulk.
    const through = stepPast(50, 40);
    assert.notEqual(stepTouchesBody(through.from, through.to, AT_ORIGIN, fat, MONSTER_HIT_HEIGHT, bfg), null);

    // The same shot past a slimmer body still misses: this is per-species, not
    // a blanket widening.
    const imp = MONSTER_STATS[IMP].radius;
    assert.equal(stepTouchesBody(through.from, through.to, AT_ORIGIN, imp, MONSTER_HIT_HEIGHT, bfg), null);
  });

  test('a graze that falls between two frame samples still connects', () => {
    // game.ts clamps dt at 0.05s; MT_ARACHPLAZ/MT_BFG fly 25 units/tic = 875/sec,
    // so one frame can carry a missile 43 units — further than the body it is
    // passing is wide, which is what makes sampling the endpoints lossy.
    const ball = PROJECTILE_RADIUS.APLS;
    const step = 875 * 0.05;
    const reach = boxToCircleRadius(PLAYER_RADIUS + ball);
    const offset = reach - 3;

    // Closest approach falls at the step's midpoint, inside the contact circle;
    // both endpoints sit outside it, so a point test at either one sees nothing.
    const from: Pos3 = { x: -step / 2, y: offset, z: 32 };
    const to: Pos3 = { x: step / 2, y: offset, z: 32 };
    assert.ok(Math.hypot(from.x, from.y) > reach && Math.hypot(to.x, to.y) > reach, 'both endpoints are clear');
    assert.notEqual(stepTouchesBody(from, to, AT_ORIGIN, PLAYER_RADIUS, PLAYER_HEIGHT, ball), null);
  });

  test('contact reports where along the step it happened, so the nearest body wins', () => {
    const ball = PROJECTILE_RADIUS.BAL1;
    const from: Pos3 = { x: 0, y: 0, z: 32 };
    const to: Pos3 = { x: 200, y: 0, z: 32 };
    const caco = MONSTER_STATS[CACODEMON].radius;

    const near = stepTouchesBody(from, to, { x: 40, y: 0, z: 0 }, caco, MONSTER_HIT_HEIGHT, ball);
    const far = stepTouchesBody(from, to, { x: 160, y: 0, z: 0 }, caco, MONSTER_HIT_HEIGHT, ball);
    assert.notEqual(near, null);
    assert.notEqual(far, null);
    assert.ok(near! < far!, 'the body the missile reaches first sorts first');
  });
});
