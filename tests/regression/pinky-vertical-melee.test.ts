import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ThingType } from '../../src/game/thingtypes.ts';
import {
  MELEE_RANGE,
  MONSTER_STATS,
  meleeReachesVertically,
  meleeThreshold,
} from '../../src/game/monsters/defs.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { hasLineOfSight } from '../../src/game/world.ts';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/game/player.ts';
import { loadPinky, type PinkyFixture, type PinkyMap } from '../fixtures/pinky.ts';

/** `MT_SERGEANT`'s own `mobjinfo.height`; the melee gate measures the attacker by its real body. */
const DEMON_HEIGHT = MONSTER_STATS[ThingType.demon].height;

/**
 * A demon in a pit could bite a player standing on the lip above it, and one on
 * a ledge could bite a player below — both well inside 2D melee reach, with no
 * vertical overlap whatsoever. The melee gate tested only distance and sight,
 * which is exactly what vanilla does; GZDoom refuses these, and that is the
 * behavior this engine follows. See docs/monster-ai.md § Melee reach.
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

        // Every y the tests use is genuinely inside 2D melee reach, and the
        // height gap genuinely leaves no vertical overlap — otherwise the
        // refusals below would pass for the wrong reason. Together these two
        // are what attribute the refusal to the vertical check rather than to
        // distance or sight. `meleeReachesVertically` itself is pinned as a
        // function in `tests/game/melee.test.ts`.
        for (const y of IN_REACH_Y) {
          const dist = Math.hypot(0 - f.demon.x, y - f.demon.y);
          assert.ok(dist < REACH, `y=${y} is ${dist} away, inside the ${REACH}-unit reach`);
          assert.equal(
            meleeReachesVertically(f.demon.z, DEMON_HEIGHT, f.playerAt(y).z, PLAYER_HEIGHT),
            false,
            `no vertical overlap at y=${y}`,
          );
        }
      });

      test('the demon never bites across the height gap, at any distance inside reach', () => {
        const f = loadPinky(which);
        for (const y of IN_REACH_Y) {
          assert.equal(bitesFrom(f, y), false, `must not bite with the player at y=${y}`);
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
    assert.ok(meleeReachesVertically(0, DEMON_HEIGHT, 0, PLAYER_HEIGHT), 'same floor overlaps');

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
