import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MELEE_RANGE,
  MONSTER_HIT_HEIGHT,
  MONSTER_STATS,
  meleeReachesVertically,
  meleeThreshold,
  stepMonsterAI,
} from '../../src/game/monsters.ts';
import { hasLineOfSight } from '../../src/game/world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { loadPinky, type PinkyFixture, type PinkyMap } from '../fixtures/pinky.ts';

/**
 * A demon in a pit could bite a player standing on the lip above it, and one on
 * a ledge could bite a player below — both well inside 2D melee reach, with no
 * vertical overlap whatsoever. The melee gate tested only distance and sight,
 * which is exactly what vanilla does; GZDoom refuses these, and that is the
 * behavior this engine follows. See docs/monsters.md § Melee reach.
 */

/** Enough simulated time for one chase call at any monster's `chaseInterval`. */
const CHASE_DT = 0.5;

/**
 * Runs one chase call and reports whether the demon swung. `y` walks the player
 * toward the divider at `y = 128`; the demon sits at `y = 160`.
 */
function bitesFrom(fixture: PinkyFixture, y: number): boolean {
  const body = fixture.demonBody();
  const player = fixture.playerAt(y);
  const attack = stepMonsterAI(
    body,
    fixture.stats,
    CHASE_DT,
    fixture.world,
    player,
    PLAYER_RADIUS,
    PLAYER_HEIGHT,
  );
  return attack?.kind === 'melee';
}

/** Reach against the player: vanilla's `MELEERANGE - 20 + 16`, exclusive. */
const REACH = meleeThreshold(MELEE_RANGE, PLAYER_RADIUS);

/**
 * The player positions that matter. The demon sits at `y = 160`, so these are
 * 48-58 units out — every one genuinely inside `REACH` (60), which the fixture
 * test below pins so none of them can drift out of it silently.
 */
const IN_REACH_Y = [112, 108, 104, 102];

describe('Regressions · vertical melee reach', () => {
  for (const which of ['pinky_below_test', 'pinky_above_test'] as PinkyMap[]) {
    describe(which, () => {
      test('the fixture holds the geometry the tests assume', () => {
        const f = loadPinky(which);
        assert.deepEqual({ x: f.demon.x, y: f.demon.y }, { x: 0, y: 160 }, 'demon position');
        assert.equal(f.ledgeFloor, which === 'pinky_below_test' ? -72 : 88, 'far sector floor');
        assert.equal(f.playerAt(112).z, 0, 'the player stays on the near floor at 0');
        assert.equal(f.world.map.sectors.length, 2);

        // Every y the tests use is genuinely inside 2D melee reach — otherwise
        // they would pass for the wrong reason.
        for (const y of IN_REACH_Y) {
          const dist = Math.hypot(0 - f.demon.x, y - f.demon.y);
          assert.ok(dist < REACH, `y=${y} is ${dist} away, inside the ${REACH}-unit reach`);
        }
      });

      test('the demon never bites across the height gap, at any distance inside reach', () => {
        const f = loadPinky(which);
        for (const y of IN_REACH_Y) {
          assert.equal(bitesFrom(f, y), false, `must not bite with the player at y=${y}`);
        }
      });

      test('it is the vertical check refusing the swing, not distance or sight', () => {
        const f = loadPinky(which);
        for (const y of IN_REACH_Y) {
          const player = f.playerAt(y);
          assert.equal(
            meleeReachesVertically(f.demon.z, MONSTER_HIT_HEIGHT, player.z, PLAYER_HEIGHT),
            false,
            `no vertical overlap at y=${y}`,
          );
        }
      });
    });
  }

  /**
   * `pinky_above_test` is the sharper of the two: standing at the wall the
   * sight wedge is already clipped by the ledge lip, so the bug only showed
   * once the player backed off far enough to see over it — which is how it was
   * reported. Pinning that sight actually passes there keeps this test honest.
   */
  test('pinky_above_test: sight passes once the player backs off the wall, and the bite is still refused', () => {
    const f = loadPinky('pinky_above_test');
    assert.equal(hasLineOfSight(f.world, f.demon, f.playerAt(112)), false, 'at the wall: lip blocks it');
    assert.equal(hasLineOfSight(f.world, f.demon, f.playerAt(102)), true, 'backed off: sees over the lip');
    // 58 units out, so still inside the 60-unit reach — the refusal cannot be
    // distance doing the work here.
    assert.ok(Math.hypot(0 - f.demon.x, 102 - f.demon.y) < REACH);
    assert.equal(bitesFrom(f, 102), false, 'and still must not bite');
  });

  /**
   * The guard against over-correcting: the fix must not stop an ordinary
   * same-floor bite, which is every melee attack in the game.
   */
  test('a demon on the same floor still bites', () => {
    const f = loadPinky('pinky_below_test');
    assert.ok(meleeReachesVertically(0, MONSTER_HIT_HEIGHT, 0, PLAYER_HEIGHT), 'same floor overlaps');

    // Same map and same 2D distance as the refused cases above — only the
    // demon's own `z` is lifted out of the pit onto the player's floor.
    const body = { ...f.demonBody(), z: 0 };
    const attack = stepMonsterAI(
      body,
      f.stats,
      CHASE_DT,
      f.world,
      f.playerAt(112),
      PLAYER_RADIUS,
      PLAYER_HEIGHT,
    );
    assert.equal(attack?.kind, 'melee', 'the swing connects when both stand at z=0');
  });
});

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
    assert.equal(meleeThreshold(MELEE_RANGE, MONSTER_STATS[3002].radius), 74, 'against a demon (radius 30)');
    assert.equal(meleeThreshold(MELEE_RANGE, 0), 44, "GZDoom's default AActor::meleerange");
  });

  test('a wider victim is reachable from further out', () => {
    const player = meleeThreshold(MELEE_RANGE, PLAYER_RADIUS);
    for (const type of [3002, 3003, 16]) {
      const victim = meleeThreshold(MELEE_RANGE, MONSTER_STATS[type].radius);
      assert.ok(victim > player, `doomednum ${type} is wider than the player, so reachable further out`);
    }
  });
});
