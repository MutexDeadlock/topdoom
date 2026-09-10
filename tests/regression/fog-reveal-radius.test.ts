import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_DISTANCE } from '../../src/constants.ts';
import { World } from '../../src/game/world.ts';
import { FogOfWar } from '../../src/game/fogofwar.ts';
import { gridMap } from '../fixtures/gridmap.ts';
import { loadCorridor } from '../fixtures/corridor.ts';

/** Grid cell size these fixtures measure their distances in. */
const CELL = 128;

/** The column whose centre stands `units` or less from the player's, at column 1. */
const colAt = (units: number) => 1 + Math.floor(units / CELL);

/**
 * A one-row corridor of `middleRow` with the player at its west end, seeded — the
 * constructor runs one uncapped update, so the reveal is settled on return. The
 * probe it hands back reports a column's distance from the player and its alpha.
 */
function corridorFog(middleRow: string): (col: number) => { dist: number; alpha: number } {
  const wall = '#'.repeat(middleRow.length);
  const grid = gridMap([wall, middleRow, wall], { cell: CELL });
  const world = new World(grid.map);
  const start = grid.centre(1, 1);
  const fog = new FogOfWar(world, [], [start], 0);
  return (col) => {
    const p = grid.centre(col, 1);
    return { dist: p.x - start.x, alpha: fog.alphaOf(world.subsectorAt(p.x, p.y)) };
  };
}

/**
 * The fog reveal reaches exactly as far as the player can see (`VIEW_DISTANCE`),
 * and both halves of that are gameplay, not looks: `ThingLayer` gates rendering,
 * `pickMonster` *and* `raycastMonster` on fog alpha, so a monster inside the view
 * but outside the reveal is invisible, un-lockable and unhittable while it shoots
 * back — while reveal past the view spoils map the fog exists to withhold.
 * See docs/fogofwar.md § Reveal radius.
 */
describe('Regressions · fog reveal radius', () => {
  /**
   * The map the bug was reported on, in a real WAD rather than a `gridMap`: the
   * reveal stopped at 3000 while the view reached further, so this chaingunner
   * sat in the dark, firing. Its 3584 units are fixed by the fixture, so which
   * side of `VIEW_DISTANCE` it falls on is up to that dial — only a dial landing
   * within the alcove's own sampling radius of 3584 makes the answer fuzzy.
   */
  test('the chaingunner 3584 units out is revealed iff it is inside the view', () => {
    const { world, player, monster } = loadCorridor();
    const fog = new FogOfWar(world, [], [player], 0);
    assert.equal(fog.alphaOf(world.subsectorAt(player.x, player.y)), 1);

    const dist = Math.hypot(monster.x - player.x, monster.y - player.y);
    assert.equal(
      fog.alphaOf(world.subsectorAt(monster.x, monster.y)),
      dist <= VIEW_DISTANCE ? 1 : 0,
      `the alcove the chaingunner stands in, ${dist} out`,
    );
  });

  /**
   * The reveal distance is not readable from outside `fogofwar.ts`, so it is
   * pinned behaviourally from both sides — and against `VIEW_DISTANCE` rather
   * than a literal, because the reveal tracking that dial *is* the rule.
   * See docs/testing.md § Feel dials are read, never pinned.
   */
  test('the reveal radius is the view distance, from both sides', () => {
    const insideCol = colAt(VIEW_DISTANCE);
    // Two cells further is at least a full cell past the view, and a cell
    // exceeds any subsector's own sampling radius — so neither probe sits on
    // the boundary the distance reject rounds off.
    const outsideCol = insideCol + 2;
    const cols = outsideCol + 2;
    const at = corridorFog(`#${'.'.repeat(cols - 2)}#`);

    const inside = at(insideCol);
    const outside = at(outsideCol);
    assert.equal(inside.alpha, 1, `revealed at ${inside.dist}, inside the view`);
    assert.equal(outside.alpha, 0, `dark at ${outside.dist}, past the view`);
  });

  // Without this, a bug that revealed everything unconditionally would pass the
  // radius test above by accident.
  test('fog does not reveal through a wall', () => {
    // Inside the view at any dial, and close enough to the player that the grid
    // stays small however far the view reaches.
    const wallCol = Math.min(15, colAt(VIEW_DISTANCE / 2));
    const cols = wallCol + 4;
    const at = corridorFog(
      `#${'.'.repeat(wallCol - 1)}#${'.'.repeat(cols - wallCol - 2)}#`,
    );

    assert.equal(at(wallCol - 1).alpha, 1, 'up to the wall');
    assert.equal(at(wallCol + 1).alpha, 0, 'blocked by geometry, well inside the view');
    assert.equal(at(cols - 2).alpha, 0, 'and everything behind it');
  });
});
