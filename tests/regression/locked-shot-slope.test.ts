import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gridMap } from '../fixtures/gridmap.ts';
import { shotPath, World, type ShotPath } from '../../src/game/world.ts';
import { AIM_HEIGHT_OFFSET } from '../../src/game/player.ts';
import { MONSTER_STATS } from '../../src/game/monsters/defs.ts';
import { ThingType } from '../../src/game/thingtypes.ts';
import type { Pos3 } from '../../src/types.ts';

/**
 * A locked-on shot used to be *cleared* by the wedge and then fired down the raw
 * line to the target, which is a different slope — so the auto-aim leniency
 * applied to the blocking test and never to the shot. A rocket aimed over a step
 * cleared the wedge, flew at the raw slope through the step, and burst on the
 * far wall (`ProjectileLayer.update` gates its floor test to a monster's shot,
 * so nothing downstream caught it). `shotPath` now fires `PTR_AimTraverse`'s
 * `aimslope` — the middle of the wedge that survived. See docs/combat.md
 * § shotPath.
 *
 * The same fixture pins the wedge's *span*: it is the target's real
 * `mobjinfo.height`, so a cyberdemon's head clears a step an imp is wholly
 * behind.
 */

/** The step between shooter and target: high enough that the raw centre-line hits it. */
const STEP = 40;
const IMP_HALF = MONSTER_STATS[ThingType.imp].height / 2;
const CYBER_HALF = MONSTER_STATS[ThingType.cyberdemon].height / 2;
const EAST = 0;

interface Scene {
  origin: Pos3;
  /** The aim point `game.ts` builds: the body's centre. */
  target: Pos3;
  /** The block's near edge, which is the crossing that binds the wedge. */
  toStep: number;
  toTarget: number;
  /** One locked-on shot at this target, with an optional per-pellet slope jitter. */
  fire(slopeOffset?: number): ShotPath;
}

/**
 * Four cells in a row: shooter, a `STEP`-high block, open floor, target. Both
 * bodies stand on the far floor at 0, behind the block rather than on it.
 * `art` opens the row up for the unobstructed case.
 */
function scene(half: number, art = '.=..'): Scene {
  const grid = gridMap([art], { heights: { '=': { floor: STEP, ceil: 128 } } });
  const world = new World(grid.map);
  const from = grid.centre(0, 0);
  const at = grid.centre(3, 0);
  const origin: Pos3 = { x: from.x, y: from.y, z: AIM_HEIGHT_OFFSET };
  const target: Pos3 = { x: at.x, y: at.y, z: half };
  return {
    origin,
    target,
    toStep: grid.cell / 2,
    toTarget: at.x - from.x,
    fire: (slopeOffset = 0) => shotPath(world, origin, EAST, target, undefined, { halfHeight: half, slopeOffset }),
  };
}

/** Height the returned path is at `d` units out — the slope it actually fired at. */
function heightAt(origin: Pos3, path: { z: number; dist: number }, d: number): number {
  return origin.z + ((path.z - origin.z) / path.dist) * d;
}

describe('Regressions · a locked-on shot fires the slope the wedge cleared', () => {
  test('the raw line to the target is the one that hits the step', () => {
    const { origin, target, toStep, toTarget } = scene(CYBER_HALF);
    const raw = heightAt(origin, { z: target.z, dist: toTarget }, toStep);
    assert.ok(raw < STEP, `the un-clamped aim passes ${raw} at the step's ${STEP} lip`);
  });

  test('a cyberdemon behind the step is reached, at a slope that clears it', () => {
    const { origin, target, toStep, toTarget, fire } = scene(CYBER_HALF);
    const path = fire();

    assert.equal(path.lineIndex, null, 'nothing stopped it short of the target');
    assert.equal(path.dist, toTarget, 'it stops at the target, as a locked shot does');
    assert.ok(heightAt(origin, path, toStep) >= STEP, 'the fired slope clears the step it was cleared over');
    assert.ok(path.z > target.z, 'aimed at the half of the body the step leaves visible');
    assert.ok(path.z <= target.z + CYBER_HALF, 'and not over its head');
  });

  test('an imp behind the same step is not reachable at all', () => {
    const path = scene(IMP_HALF).fire();

    // Every slope reaching an imp-sized body passes below the step's lip, so the
    // wedge collapses on it — vanilla's `topslope <= bottomslope`, stop.
    assert.notEqual(path.lineIndex, null, 'the step stops it');
    assert.ok(path.dist < 128, 'stopped at the near edge of the block, not past it');
  });

  test('with nothing in the way the aim is the body centre', () => {
    const { target, fire } = scene(CYBER_HALF, '....');
    const path = fire();

    // An un-narrowed wedge is symmetric about the target, so its midpoint is the
    // target: the clamp changes nothing in open ground.
    assert.equal(path.lineIndex, null);
    assert.ok(Math.abs(path.z - target.z) < 1e-9, 'aimed straight at the centre');
  });

  test('the super shotgun s per-pellet jitter survives the clamp', () => {
    const { toTarget, fire } = scene(CYBER_HALF);
    const jitter = 0.02;

    // `A_FireShotgun2` adds its jitter to the finished `bulletslope`, so a pellet
    // is free to scatter back into the step the aim itself had to clear.
    const dropped = fire().z - jitter * toTarget;
    assert.ok(Math.abs(fire(-jitter).z - dropped) < 1e-9, 'the offset applies after the clamp');
  });
});
