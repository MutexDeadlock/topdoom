import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { addControlLine, gridMap } from '../fixtures/gridmap.ts';
import { specialsRig } from '../fixtures/specialsrig.ts';
import { FADE_RADIUS } from '../../src/render/occlusion.ts';
import { WALL_CHUNK_LEN } from '../../src/render/mapmesh.ts';
import { targetAt } from '../fixtures/fadetarget.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';

/**
 * `MoverGeometry.updateFading` skips a mesh this frame's fading cannot reach
 * and that has nothing left to relax — the difference between walking a couple
 * of thousand movers a frame and walking the handful near the player. What the
 * cases here hold onto is that "cannot reach" really means it: a mover the
 * sightline crosses still fades, and one that has been faded still relaxes
 * after the player walks off. See docs/render.md § Mover meshes a frame cannot
 * touch.
 */
describe('render · mover meshes a frame cannot touch', () => {
  const CELL = WALL_CHUNK_LEN * 4;

  /**
   * A row of cells with a tagged lift in the middle, walls hung on every side
   * so the mover mesh has quads to fade, and the player parked at the east end.
   * The row is long enough that its west end sits well outside any fade reach
   * the camera has at the east one.
   */
  function rig(row = '.L......') {
    const grid = gridMap([row], { cell: CELL, heights: { L: { floor: 64, ceil: 128 } } });
    const { map } = grid;
    for (const side of map.sidedefs) {
      side.upper = 'UPPER';
      side.lower = 'LOWER';
      side.middle = 'MIDDLE';
    }
    // Raised above its neighbours, so triggering it actually moves and its mesh
    // is genuinely refreshed rather than left alone.
    const lift = grid.index(1, 0);
    map.sectors[lift].tag = 1;
    addControlLine(map, 64, 0, 62, 1); // SR lift, so the sector is a mover
    const control = map.linedefs.length - 1;
    const r = specialsRig(map, grid.centre(7, 0));
    assert.ok(r.movableSectors.has(lift), 'the fixture must actually build a mover mesh');
    const trigger = () => (r.specials as unknown as { trigger(line: number, keys: Set<never>): void }).trigger(control, new Set());
    return { grid, rig: r, lift, trigger };
  }

  /**
   * The alpha range across every mover mesh the controller hung on the scene.
   * Both ends matter: a fade shows up as a *low* below 1 somewhere, while a
   * mover fog of war has never revealed must be at 0 *everywhere*, which only
   * the high end catches — one batch left holding a stale 1 hides inside a
   * minimum taken over the rest.
   */
  function moverAlpha(scene: THREE.Group): { low: number; high: number } {
    let low = 1;
    let high = 0;
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      const attr = mesh.geometry?.getAttribute?.('color') as THREE.BufferAttribute | undefined;
      if (!attr) return;
      for (let v = 0; v < attr.count; v++) {
        low = Math.min(low, attr.getW(v));
        high = Math.max(high, attr.getW(v));
      }
    });
    return { low, high };
  }

  /** One long `dt`, so the damping snaps and each call reads as a steady state. */
  const SETTLE = 10;

  test('a mover on the sightline fades, and is whole again once nothing crosses it', () => {
    const { grid, rig: r } = rig();
    const scene = r.scene;
    // Camera north of the lift, target south of it: the sightline crosses the
    // lift's own north wall, which is a quad of its mover mesh.
    const at = grid.centre(1, 0);
    const camX = at.x;
    const camY = at.y + CELL;
    const target = targetAt(at.x, at.y - CELL, 0, {});
    r.specials.updateFading(SETTLE, camX, camY, PLAYER_HEIGHT + 256, [target]);
    assert.ok(moverAlpha(scene).low < 1, 'the mover mesh faded where the sightline crossed it');

    // The player walks to the far end of the row, taking the camera with them.
    // The regression this guards: the mesh is now far outside the fade reach,
    // and a skip that ignored whether it still had something to relax would
    // leave the hole in it forever.
    const far = grid.centre(7, 0);
    const away = targetAt(far.x, far.y, 0, {});
    for (let i = 0; i < 4; i++) {
      r.specials.updateFading(SETTLE, far.x, far.y + CELL, PLAYER_HEIGHT + 256, [away]);
    }
    assert.equal(moverAlpha(scene).low, 1, 'the mover mesh is whole again');
  });

  test('a mover the camera never comes near is still written once', () => {
    // Its faders start with nothing written at all, so the first pass has to
    // run however quiet its surroundings are — otherwise the mesh keeps
    // whatever alpha the builder left in the buffer, which is a fully drawn
    // wall in a corner of the level fog of war has never revealed. The solid
    // cell between is what keeps the spawn sweep off it.
    const { grid, rig: r } = rig('.L.#....');
    const far = grid.centre(7, 0);
    const away = targetAt(far.x, far.y, 0, {});
    const lift = grid.centre(1, 0);
    assert.ok(
      Math.hypot(lift.x - far.x, lift.y - far.y) > FADE_RADIUS * 2,
      'the fixture must put the mover well out of reach for this to mean anything',
    );
    r.specials.updateFading(SETTLE, far.x, far.y + CELL, PLAYER_HEIGHT + 256, [away]);
    assert.equal(moverAlpha(r.scene).high, 0, 'every batch of the unrevealed mover was written to the reveal it has');
  });

  test('a mover that moved is written again, however quiet its corner is', () => {
    // A refresh rewrites the mesh's whole colour attribute, alpha channel
    // included, so what the faders last wrote is gone from the buffer while
    // their own bookkeeping still claims it. Here the lift is in a part of the
    // level fog of war has never revealed, so the stale buffer would show a
    // fully drawn wall in the dark.
    const { grid, rig: r, lift, trigger } = rig('.L.#....');
    const far = grid.centre(7, 0);
    const away = targetAt(far.x, far.y, 0, {});
    const fade = () => r.specials.updateFading(SETTLE, far.x, far.y + CELL, PLAYER_HEIGHT + 256, [away]);
    // Long enough for the reveal around the standing player to finish ramping,
    // so the frames below are ones where fog of war reports no change at all —
    // which is the only kind this case is about.
    for (let i = 0; i < 200; i++) r.tick();
    fade();
    fade();
    assert.equal(moverAlpha(r.scene).high, 0, 'hidden to begin with');

    // Mid-travel, where a moving lift's mesh is *refreshed* in place rather
    // than rebuilt: a rebuild would hand `updateFading` a fresh entry, which it
    // always commits, so only the refresh can leave a stale buffer behind.
    trigger();
    for (let i = 0; i < 3; i++) r.tick();
    const moving = r.world.map.sectors[lift].floorHeight;
    assert.ok(moving < 64 && moving > 0, `the lift should be mid-travel, is at ${moving}`);
    fade();
    for (let i = 0; i < 3; i++) r.tick();
    fade();
    assert.equal(moverAlpha(r.scene).high, 0, 'and still hidden after its geometry was rewritten');
  });
});
