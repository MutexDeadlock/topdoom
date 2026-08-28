import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wad } from '../../src/wad/wad.ts';
import { loadMap, LF, NO_SIDE } from '../../src/wad/map.ts';
import { World } from '../../src/game/world.ts';
import { PLAYER_RADIUS } from '../../src/game/player.ts';
import { fixtureWad } from '../fixtures/wadfile.ts';

/**
 * Running straight at a **two-sided wall carrying `ML_BLOCKING`** stopped the
 * player dead instead of sliding along it. `PTR_SlideTraverse` tests only
 * `ML_TWOSIDED` and the opening, so the traverse called the line passable while
 * `PIT_CheckLine` refused the move — no wall found, so `P_SlideMove` fell to the
 * stairstep, and for a move whose Y component is exactly zero the stairstep is a
 * no-op. See docs/movement.md § slideMove.
 *
 * The geometry has to be diagonal (a wall square to the push should stop you),
 * so this is WAD-backed rather than on the grid fixture — docs/testing.md
 * § WAD-backed tests.
 */

/** freedoom2 MAP01 line 514, a diagonal two-sided `ML_BLOCKING` wall. */
const LINE = 514;

/** Parsed once: both cases below read the same map. */
let cached: { world: World; a: { x: number; y: number }; b: { x: number; y: number } } | null = null;

function scene(): { world: World; a: { x: number; y: number }; b: { x: number; y: number } } {
  if (cached) return cached;
  // `freedoom_map01.wad` is that map's own lumps lifted out of freedoom2, so
  // the line numbering is the IWAD's and it loads with no IWAD behind it.
  const world = new World(loadMap(new Wad([fixtureWad('freedoom_map01.wad')]), 'MAP01'));
  const line = world.map.linedefs[LINE];
  cached = { world, a: world.map.vertexes[line.v1], b: world.map.vertexes[line.v2] };
  return cached;
}

describe('Regressions · sliding along a two-sided blocking wall', () => {
  test('the fixture line is two-sided, ML_BLOCKING and diagonal', () => {
    const { world, a, b } = scene();
    const line = world.map.linedefs[LINE];
    assert.notEqual(line.left, NO_SIDE, 'two-sided');
    assert.notEqual(line.right, NO_SIDE, 'two-sided');
    assert.ok(line.flags & LF.BLOCKING, 'carries ML_BLOCKING');
    assert.ok(a.x !== b.x && a.y !== b.y, 'runs diagonally, so a slide is the correct outcome');
  });

  test('an axis-aligned push into it slides instead of stopping dead', () => {
    const { world, a, b } = scene();
    // Stand just off the wall's midpoint on each side and run straight at it,
    // on an exactly axis-aligned heading — what holding one strafe key with the
    // camera at a snapped yaw produces.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const step = 400 / 35; // running speed for one tic

    for (const side of [1, -1]) {
      const px = mx + nx * side * (PLAYER_RADIUS + 6);
      const py = my + ny * side * (PLAYER_RADIUS + 6);
      const z = world.groundFloor(px, py, PLAYER_RADIUS);
      // Head due east or due west, whichever points at the wall: Y is exactly 0,
      // so the stairstep cannot rescue this and only a real slide can move.
      const dx = -nx * side > 0 ? step : -step;

      let at = { x: px, y: py };
      for (let i = 0; i < 4; i++) at = world.slideMove({ ...at, z }, dx, 0, PLAYER_RADIUS);
      const moved = Math.hypot(at.x - px, at.y - py);
      assert.ok(moved > 8, `side ${side}: must slide along the wall, moved ${moved.toFixed(2)}`);
      assert.notEqual(at.y, py, `side ${side}: the slide has to carry along the wall, not just push in`);
    }
  });
});
