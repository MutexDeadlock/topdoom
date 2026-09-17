import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER_WEAPON_RANGE, WEAPON_RANGE } from '../../src/game/world.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { loadCorridor } from '../fixtures/corridor.ts';
import { shotRig } from '../fixtures/shotrig.ts';

/**
 * A player's free hitscan used to be bounded by vanilla's 2048 `MISSILERANGE`,
 * so a monster further out than that was unkillable however clear the line to
 * it was. See docs/combat.md § Range.
 */

const NORTH = Math.PI / 2;

describe('Combat · hitscan range', () => {
  test('a player bullet reaches 3584 units down the corridor; a monster bullet does not', () => {
    const { world, player, monster } = loadCorridor();

    // WEAPON_RANGE is `P_LineAttack`'s MISSILERANGE and belongs to *monsters*.
    // In open corridor it simply runs out: full range travelled, nothing hit.
    const monsterShot = world.shotPath(player, NORTH, null, WEAPON_RANGE);
    assert.equal(monsterShot.dist, 2048);
    assert.equal(monsterShot.lineIndex, null, 'ran out of range rather than hitting anything');
    assert.ok(monsterShot.dist < 3584, 'a 2048 cap cannot reach the chaingunner');

    // PLAYER_WEAPON_RANGE is ZDoom's PLAYERMISSILERANGE. It crosses the whole
    // corridor and stops on the far wall 3616 out — past the monster at 3584.
    const playerShot = world.shotPath(player, NORTH, null, PLAYER_WEAPON_RANGE);
    assert.equal(playerShot.dist, 3616);
    assert.notEqual(playerShot.lineIndex, null, 'stopped by the end wall, not by range');
    assert.ok(playerShot.dist > 3584, 'the shot passes the chaingunner before it stops');

    assert.ok(world.hasLineOfSight(player, monster), 'nothing stands between them');
  });

  test('a fired player bullet hits the chaingunner, locked on or not', () => {
    const { world, player, monster } = loadCorridor();
    const { radius, height } = MONSTER_STATS[ThingType.heavyWeaponDude];
    const chaingunner = { id: 1, type: ThingType.heavyWeaponDude, ...monster, height, angle: 0, radius };
    const { damaged, fire } = shotRig(world, player, [chaingunner]);
    const toward = Math.atan2(monster.y - player.y, monster.x - player.x);

    // The regression itself, through `spawnPlayerShot`: a player bullet must not fall back to the
    // monster bound, which is what shotPath uses when no range is passed — and a lock gives it a
    // slope, never a range.
    fire(toward, null);
    fire(toward, chaingunner);
    assert.deepEqual(damaged, [1, 1]);
  });
});
