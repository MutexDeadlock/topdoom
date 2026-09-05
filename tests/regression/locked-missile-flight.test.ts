import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World, playerShotRange } from '../../src/game/world.ts';
import { AIM_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * A locked-on **missile** used to be bounded by the launch-time distance to its target, so a
 * cacodemon that drifted aside left the rocket to burst in mid-air on the spot it had been standing
 * — the flight ended at `maxDist` with nothing there. `P_SpawnMissile` gives a missile momentum and
 * nothing else; it flies until a wall, the floor or a body stops it, and only a *bullet* is instant
 * enough to end at its target. See docs/combat.md § Range.
 */

const EAST = 0;
const IMP_HALF = MONSTER_STATS[ThingType.imp].height / 2;

/** A long open corridor, so nothing but the far wall is in the way. */
const GRID = gridMap(['##########', '#........#', '##########'], { cell: 128 });

describe('Regressions · a locked-on missile flies past its target', () => {
  test('playerShotRange stops a locked bullet at the target and never a missile', () => {
    const target: Pos3 = { x: 0, y: 100, z: 0 };
    assert.equal(playerShotRange('hitscan', target, 9999), undefined, 'a bullet is instant');
    assert.equal(playerShotRange('projectile', target, 9999), 9999, 'a missile keeps flying');
  });

  test('the flight runs to the wall, not to where the target stood', () => {
    const world = new World(GRID.map);
    const from = GRID.centre(1, 1);
    const origin: Pos3 = { x: from.x, y: from.y, z: AIM_HEIGHT_OFFSET };
    // An imp three cells east, and the wall well beyond it.
    const at = GRID.centre(4, 1);
    const target: Pos3 = { x: at.x, y: at.y, z: IMP_HALF };
    const toTarget = target.x - origin.x;

    const lock = { halfHeight: IMP_HALF, slopeOffset: 0 };
    const path = world.shotPath(origin, EAST, target, world.mapSpan, lock);
    assert.ok(path.dist > toTarget + 100, `expected past ${toTarget}, flew ${path.dist}`);
    assert.notEqual(path.lineIndex, null, 'the far wall is what ended it');
  });

  test('the aim wedge is still measured at the target’s own distance', () => {
    // The wedge opens on the target's silhouette, `thingtopslope`/`thingbottomslope`, which is a
    // half-height over the distance *to the thing*. Dividing by the flight's own range instead
    // collapsed it to the raw centre line the moment a missile stopped ending at its target.
    const world = new World(GRID.map);
    const from = GRID.centre(1, 1);
    const origin: Pos3 = { x: from.x, y: from.y, z: AIM_HEIGHT_OFFSET };
    const at = GRID.centre(4, 1);
    const target: Pos3 = { x: at.x, y: at.y, z: IMP_HALF };
    const lock = { halfHeight: IMP_HALF, slopeOffset: 0 };

    // Same lock, two ranges: the slope the wedge settles on must not depend on how far the shot
    // then travels, since nothing in this corridor narrows the wedge at all.
    const near = world.shotPath(origin, EAST, target, undefined, lock);
    const far = world.shotPath(origin, EAST, target, world.mapSpan, lock);
    const slopeOf = (p: { z: number; dist: number }) => (p.z - origin.z) / p.dist;
    assert.ok(
      Math.abs(slopeOf(near) - slopeOf(far)) < 1e-9,
      `slopes disagree: ${slopeOf(near)} vs ${slopeOf(far)}`,
    );
  });
});
