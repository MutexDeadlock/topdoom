import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { World, WEAPON_RANGE } from '../../src/game/world.ts';
import { AIM_HEIGHT_OFFSET, PLAYER_HEIGHT } from '../../src/game/player.ts';
import { monsterShootZ } from '../../src/game/monsters/defs.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * A monster's hitscan used to be traced down the raw line from its fire height to
 * the player's, with no `P_AimLineAttack` wedge — so a window whose opening that
 * one line misses ate every bullet, while the player's own clicked shot, which
 * does get the wedge, shot back through it. Freedoom E1M2 has the case: north of
 * the 32-unit slit (sectors 273/281, floor 48 ceiling 80) the player kills the
 * gunners in sector 130, and the one gunner standing far enough back to pass
 * `P_CheckSight` fired volley after volley into the slit's lip. `A_PosAttack`,
 * `A_SPosAttack` and `A_CPosAttack` all take their slope from `P_AimLineAttack`.
 * See docs/monster-attacks.md § Hitscan vs. projectile.
 */

/** The slit's ceiling: below both bodies' fire height, so no level ray fits through. */
const SLIT_CEIL = 32;
const HALF = PLAYER_HEIGHT / 2;
/** The gunner's own `shootz`, which is what a hitscan leaves from. */
const FIRE_Z = monsterShootZ(MONSTER_STATS[ThingType.shotgunGuy].height);
const EAST = 0;

/** Height a returned path is at `d` units out — the slope it actually fired at. */
function heightAt(origin: Pos3, path: { z: number; dist: number }, d: number): number {
  return origin.z + ((path.z - origin.z) / path.dist) * d;
}

/**
 * Seven cells east-west, the fourth a slit; monster in the first, player in the
 * last. The distance back from the slit is the point of the fixture: close to it
 * the sight wedge collapses too and the monster never fires at all (which is
 * vanilla, and is what the two nearer gunners in that room do).
 */
function scene() {
  const grid = gridMap(['...w...'], { heights: { w: { floor: 0, ceil: SLIT_CEIL } } });
  const world = new World(grid.map);
  const from = grid.centre(0, 0);
  const at = grid.centre(6, 0);
  const monster: Pos3 = { x: from.x, y: from.y, z: 0 };
  const player: Pos3 = { x: at.x, y: at.y, z: 0 };
  const origin: Pos3 = { x: from.x, y: from.y, z: FIRE_Z };
  return {
    world,
    monster,
    player,
    origin,
    /** The slit's near edge — the crossing that binds both the sight wedge and the aim. */
    toSlit: grid.cell * 3 - grid.cell / 2,
    toPlayer: at.x - from.x,
    /** The aim pass `MonsterAttacks.resolveHitscan` makes: the wedge over the player's body. */
    aim: () =>
      world.shotPath(origin, EAST, { x: at.x, y: at.y, z: HALF }, undefined, {
        halfHeight: HALF,
        slopeOffset: 0,
      }),
  };
}

describe('Regressions · a monster shoots through a window it can see through', () => {
  test('the monster can see the player, so it does take the shot', () => {
    const { world, monster, player } = scene();
    assert.ok(world.hasLineOfSight(monster, player), 'P_CheckSight clears the slit from here');
  });

  test('the raw line to the player is the one the slit eats', () => {
    const { world, origin, toSlit, toPlayer } = scene();
    const raw = world.shotPath(
      origin,
      EAST,
      { x: origin.x + toPlayer, y: origin.y, z: AIM_HEIGHT_OFFSET },
      WEAPON_RANGE,
      null,
    );
    assert.notEqual(raw.lineIndex, null, 'the slit stops it');
    assert.ok(raw.dist <= toSlit + 1, 'at the slit, nowhere near the player');
  });

  test('the aim wedge finds a slope through it and reaches the player', () => {
    const { origin, toSlit, toPlayer, aim } = scene();
    const path = aim();

    assert.equal(path.lineIndex, null, 'nothing stopped the aim short');
    assert.equal(path.dist, toPlayer, 'it reaches the player');
    assert.ok(heightAt(origin, path, toSlit) < SLIT_CEIL, 'the fired slope passes under the slit lip');
    assert.ok(path.z >= 0 && path.z <= PLAYER_HEIGHT, 'and arrives inside the body it was aimed at');
  });

  test('the bullet fired at that slope flies on past the player', () => {
    const { world, origin, toPlayer, aim } = scene();
    const slope = (aim().z - origin.z) / toPlayer;
    // What `resolveHitscan` hands each pellet: the aim point moved onto the
    // shared slope, then traced as a fixed ray to `WEAPON_RANGE` — `P_LineAttack`
    // has no notion of stopping at whoever the aim found.
    const bullet = world.shotPath(
      origin,
      EAST,
      { x: origin.x + toPlayer, y: origin.y, z: origin.z + slope * toPlayer },
      WEAPON_RANGE,
      null,
    );
    assert.ok(bullet.dist > toPlayer, 'the player stands in the bullet path, not past its end');
  });
});
