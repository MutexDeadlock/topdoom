import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasLineOfSight,
  playerShotRange,
  shotPath,
  PLAYER_WEAPON_RANGE,
  WEAPON_RANGE,
} from '../../src/game/world.ts';
import { loadCorridor } from '../fixtures/corridor.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * A player's free hitscan used to be bounded by vanilla's 2048 `MISSILERANGE`,
 * so a monster further out than that was unkillable however clear the line to
 * it was. See docs/combat.md § Range.
 */

const NORTH = Math.PI / 2;

describe('Regressions · player hitscan range', () => {
  test('a player bullet reaches 3584 units down the corridor; a monster bullet does not', () => {
    const { world, player, monster } = loadCorridor();

    // WEAPON_RANGE is `P_LineAttack`'s MISSILERANGE and belongs to *monsters*.
    // In open corridor it simply runs out: full range travelled, nothing hit.
    const monsterShot = shotPath(world, player, NORTH, null, WEAPON_RANGE);
    assert.equal(monsterShot.dist, 2048);
    assert.equal(monsterShot.lineIndex, null, 'ran out of range rather than hitting anything');
    assert.ok(monsterShot.dist < 3584, 'a 2048 cap cannot reach the chaingunner');

    // PLAYER_WEAPON_RANGE is ZDoom's PLAYERMISSILERANGE. It crosses the whole
    // corridor and stops on the far wall 3616 out — past the monster at 3584.
    const playerShot = shotPath(world, player, NORTH, null, PLAYER_WEAPON_RANGE);
    assert.equal(playerShot.dist, 3616);
    assert.notEqual(playerShot.lineIndex, null, 'stopped by the end wall, not by range');
    assert.ok(playerShot.dist > 3584, 'the shot passes the chaingunner before it stops');

    assert.ok(hasLineOfSight(world, player, monster), 'nothing stands between them');
  });

  test('playerShotRange bounds a free bullet, a free missile and a locked-on shot differently', () => {
    const mapSpan = 12345;
    const target: Pos3 = { x: 0, y: 100, z: 0 };

    // Free: no auto-aim lock, so each kind needs its own bound.
    assert.equal(playerShotRange('hitscan', null, mapSpan), PLAYER_WEAPON_RANGE);
    assert.equal(playerShotRange('projectile', null, mapSpan), mapSpan);

    // Locked on: `undefined` lets shotPath stop at the target itself.
    assert.equal(playerShotRange('hitscan', target, mapSpan), undefined);
    assert.equal(playerShotRange('projectile', target, mapSpan), undefined);

    // The regression itself: a free player bullet must not fall back to the
    // monster bound, which is what shotPath uses when no range is passed.
    assert.notEqual(playerShotRange('hitscan', null, mapSpan), WEAPON_RANGE);
    assert.ok(PLAYER_WEAPON_RANGE > WEAPON_RANGE);
  });
});
