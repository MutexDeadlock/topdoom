import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { stepTouchesBody } from '../../src/game/spritefx/defs.ts';
import { PROJECTILE_RADIUS } from '../../src/game/spritefx/tables.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos3 } from '../../src/types.ts';
import { DOOM_TIC } from '../../src/constants.ts';

/**
 * A projectile's contact test was one flat 40-unit disc plus a ±128 height
 * tolerance for every missile and every body alike, sampled at the end of each
 * frame's step. That made monster fireballs hit far too generously, made the
 * player's own missiles thread through wide monsters, and let the fastest
 * missiles step clean past a body.
 *
 * The tic lock halved the worst case — a step is now one `DOOM_TIC` rather than
 * the old 0.05s `dt` clamp — but did not remove it: 25 units/tic is still wider
 * than some bodies, so the swept test remains load-bearing.
 * See docs/monster-attacks.md § Monster projectiles in flight.
 */

/** A body standing at the origin on the floor. */
const AT_ORIGIN: Pos3 = { x: 0, y: 0, z: 0 };

/** A step of `len` units flying east at height `z`, passing `offset` units north of the origin. */
function stepPast(offset: number, z: number, len = 12): { from: Pos3; to: Pos3 } {
  return {
    from: { x: -len / 2, y: offset, z },
    to: { x: len / 2, y: offset, z },
  };
}

describe('Projectiles · what a missile touches', () => {
  test('an imp fireball hits across PIT_CheckThing’s blockdist, exactly', () => {
    const ball = PROJECTILE_RADIUS.BAL1;
    assert.equal(ball, 6, "MT_TROOPSHOT's own mobjinfo radius");
    // `blockdist = thing->radius + tmthing->radius` = 16 + 6, and the box is
    // that half-width on each axis — no mean-width circle standing in for it.
    const blockdist = PLAYER_RADIUS + ball;
    assert.equal(blockdist, 22);

    const near = stepPast(blockdist - 2, 20);
    assert.notEqual(stepTouchesBody(near.from, near.to, AT_ORIGIN, PLAYER_RADIUS, PLAYER_HEIGHT, ball), null);

    // Exactly at blockdist is a miss, matching vanilla's `>=`.
    const flush = stepPast(blockdist, 20);
    assert.equal(stepTouchesBody(flush.from, flush.to, AT_ORIGIN, PLAYER_RADIUS, PLAYER_HEIGHT, ball), null);

    // The equal-mean-width circle this used to test reached ~28 units, so a
    // fireball 25 north of the player connected. Vanilla's box does not.
    const wide = stepPast(25, 20);
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
    const fat = MONSTER_STATS[ThingType.mancubus].radius;
    assert.equal(fat, 48, "MT_FATSO's own mobjinfo radius");

    // 50 units off centre is well inside a mancubus and was outside the old
    // flat 24-unit test — the ball flew straight through its visible bulk.
    const through = stepPast(50, 40);
    assert.notEqual(stepTouchesBody(through.from, through.to, AT_ORIGIN, fat, MONSTER_STATS[ThingType.mancubus].height, bfg), null);

    // The same shot past a slimmer body still misses: this is per-species, not
    // a blanket widening.
    const imp = MONSTER_STATS[ThingType.imp].radius;
    assert.equal(stepTouchesBody(through.from, through.to, AT_ORIGIN, imp, MONSTER_STATS[ThingType.imp].height, bfg), null);
  });

  test('the test is swept, not sampled at the step’s endpoints', () => {
    // A step long enough to cross the whole box: both endpoints sit outside it,
    // so sampling either one sees nothing and only a swept test connects.
    const ball = PROJECTILE_RADIUS.APLS;
    const blockdist = PLAYER_RADIUS + ball;
    const from: Pos3 = { x: -blockdist * 2, y: 0, z: 32 };
    const to: Pos3 = { x: blockdist * 2, y: 0, z: 32 };
    assert.ok(Math.abs(from.x) > blockdist && Math.abs(to.x) > blockdist, 'both endpoints are clear');
    const t = stepTouchesBody(from, to, AT_ORIGIN, PLAYER_RADIUS, PLAYER_HEIGHT, ball);
    assert.notEqual(t, null);
    // It reports first contact, so the entry point rather than closest approach.
    assert.ok(Math.abs(from.x + (to.x - from.x) * t! + blockdist) < 1e-9, 'enters at -blockdist');

    // Against stock missile speeds the sweep is now belt-and-braces rather than
    // load-bearing: the fastest missile covers 25 units a tic
    // (`875 * DOOM_TIC`), and the narrowest box a missile meets is wider than
    // that, so an endpoint sample would not actually skip one.
    assert.ok(875 * DOOM_TIC < 2 * blockdist);
  });

  test('contact reports where along the step it happened, so the nearest body wins', () => {
    const ball = PROJECTILE_RADIUS.BAL1;
    const from: Pos3 = { x: 0, y: 0, z: 32 };
    const to: Pos3 = { x: 200, y: 0, z: 32 };
    const caco = MONSTER_STATS[ThingType.cacodemon].radius;

    const near = stepTouchesBody(from, to, { x: 40, y: 0, z: 0 }, caco, MONSTER_STATS[ThingType.cacodemon].height, ball);
    const far = stepTouchesBody(from, to, { x: 160, y: 0, z: 0 }, caco, MONSTER_STATS[ThingType.cacodemon].height, ball);
    assert.notEqual(near, null);
    assert.notEqual(far, null);
    assert.ok(near! < far!, 'the body the missile reaches first sorts first');
  });
});
