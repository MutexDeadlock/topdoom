import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MELEE_RANGE, MONSTER_STATS, meleeReachesVertically, meleeThreshold } from '../../src/game/monsters/defs.ts';
import { PLAYER_RADIUS } from '../../src/game/player.ts';
import { ThingType } from '../../src/game/thingtypes.ts';

/**
 * The two pure predicates every monster's melee gate bottoms out in
 * (`monsters/defs.ts`, called from `ai.ts`'s `wantsMelee`): how far a swing
 * reaches, and whether the two bodies overlap vertically at all. Driving them
 * through a real map is `tests/regression/pinky-vertical-melee.test.ts`'s job.
 * See docs/monster-ai.md § Melee reach.
 */

describe('Vanilla tables · meleeReachesVertically', () => {
  // ZDoom's `p_enemy.cpp`: `if (pl->Z() > actor->Top()) return false;` and
  // `if (pl->Top() < actor->Z()) return false;` — both strict, so bodies that
  // exactly touch still connect.
  const H = 64;

  test('overlapping bodies connect', () => {
    assert.ok(meleeReachesVertically(0, H, 0, H), 'identical');
    assert.ok(meleeReachesVertically(0, H, 32, H), 'target half a body up');
    assert.ok(meleeReachesVertically(0, H, -32, H), 'target half a body down');
  });

  test('exact touching still connects; one unit past does not', () => {
    assert.ok(meleeReachesVertically(0, H, H, H), 'target feet exactly at attacker top');
    assert.equal(meleeReachesVertically(0, H, H + 1, H), false, 'one unit above that');

    assert.ok(meleeReachesVertically(0, H, -H, H), 'target head exactly at attacker feet');
    assert.equal(meleeReachesVertically(0, H, -H - 1, H), false, 'one unit below that');
  });

  test('the two heights are read independently', () => {
    // A short target below a tall attacker: reachable only because the
    // attacker's own box is what the target's feet are measured against.
    assert.ok(meleeReachesVertically(0, 110, 100, 8), 'tall attacker reaches a high, short target');
    assert.equal(meleeReachesVertically(0, 56, 100, 8), false, 'a short one does not');
  });
});

describe('Vanilla tables · meleeThreshold', () => {
  /**
   * `P_CheckMeleeRange`: `dist >= MELEERANGE - 20*FRACUNIT + pl->info->radius`
   * (`p_enemy.c`), with `MELEERANGE` 64 (`p_local.h`). GZDoom reaches the same
   * threshold from the other side, storing the shortened 44 as
   * `AActor::meleerange` and comparing `dist >= meleerange + pl->radius`.
   * A flat range that ignored the target's radius was the bug this pins.
   */
  test('vanilla MELEERANGE is 64, and the threshold widens with the target', () => {
    assert.equal(MELEE_RANGE, 64, "vanilla's MELEERANGE");
    assert.equal(meleeThreshold(MELEE_RANGE, PLAYER_RADIUS), 60, 'against the player (radius 16)');
    assert.equal(meleeThreshold(MELEE_RANGE, MONSTER_STATS[ThingType.demon].radius), 74, 'against a demon (radius 30)');
    assert.equal(meleeThreshold(MELEE_RANGE, 0), 44, "GZDoom's default AActor::meleerange");
  });

  test('a wider victim is reachable from further out', () => {
    const player = meleeThreshold(MELEE_RANGE, PLAYER_RADIUS);
    for (const type of [ThingType.demon, ThingType.baronOfHell, ThingType.cyberdemon]) {
      const victim = meleeThreshold(MELEE_RANGE, MONSTER_STATS[type].radius);
      assert.ok(victim > player, `doomednum ${type} is wider than the player, so reachable further out`);
    }
  });
});
