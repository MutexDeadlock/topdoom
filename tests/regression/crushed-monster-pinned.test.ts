import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { stepMonsterAI } from '../../src/game/monsters/ai.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { gridMap } from '../fixtures/gridmap.ts';

/**
 * `P_TryMove`'s `tmceilingz - tmfloorz < thing->height` — a monster that
 * doesn't fit where it's headed can't move at all. The engine only narrowed
 * headroom at line openings, so a monster inside a single crushed sector
 * crossed nothing and kept walking around under a closed crusher.
 * See docs/monster-ai.md § Movement.
 */

const TIC = 1 / 35;
const STATS = MONSTER_STATS[ThingType.hellKnight];

/** A two-cell room; the monster stands in the right cell, the player in the left. */
function scene(ceil: number) {
  const grid = gridMap(['####', '#..#', '####'], { heights: { '.': { floor: 0, ceil } } });
  const world = new World(grid.map);
  const at = grid.centre(2, 1);
  const target = grid.centre(1, 1);
  const body = {
    x: at.x,
    y: at.y,
    z: 0,
    angle: Math.PI,
    velX: 0,
    velY: 0,
    velZ: 0,
    health: 500,
    alerted: true,
    reactionTicks: 0,
    painTimer: 0,
    chargeTimer: 0,
    attackPause: 0,
    burstLeft: 0,
    refiring: false,
    justHit: false,
    movedir: 4,
    movecount: 0,
    threshold: 0,
    targetId: null,
    homingBias: false,
    chargeAngle: 0,
    // eslint-disable-next-line
  } as any;
  return { grid, world, body, target: { x: target.x, y: target.y, z: 0 } };
}

/** Total distance the monster covers chasing for a second. */
function walkFor(ceil: number, stats = STATS): number {
  const { world, body, target } = scene(ceil);
  const startX = body.x;
  const startY = body.y;
  for (let i = 0; i < 35; i++) {
    stepMonsterAI(body, stats, world, { dt: TIC, target, targetRadius: 16, targetHeight: 56 });
  }
  return Math.hypot(body.x - startX, body.y - startY);
}

describe('Regressions · a crushed monster is pinned', () => {
  test('it walks normally under an open ceiling', () => {
    assert.ok(walkFor(256) > 1, 'an ordinary room lets the monster chase');
  });

  test('it cannot move once the ceiling has closed below its height', () => {
    // A crusher bottoms out at floor + 8; anything under the hell knight's own
    // 64-unit `mobjinfo.height` should already pin it.
    assert.equal(walkFor(8), 0, 'fully crushed: no movement at all');
    assert.equal(walkFor(48), 0, 'still short of its height: no movement');
  });

  test('the height it is measured against is its own, not a shared one', () => {
    // 60 units of headroom: over an imp's 56, under a hell knight's 64. A single
    // shared figure cannot get both of these right, which is why there isn't one.
    const imp = MONSTER_STATS[ThingType.imp];
    assert.equal(imp.height, 56, "MT_TROOP's own mobjinfo height");
    assert.equal(STATS.height, 64, "MT_KNIGHT's own mobjinfo height");

    assert.ok(walkFor(60, imp) > 1, 'the imp still fits and keeps chasing');
    assert.equal(walkFor(60), 0, 'the hell knight does not, and is pinned');
  });
});
