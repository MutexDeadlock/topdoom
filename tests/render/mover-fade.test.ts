import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { addControlLine, gridMap } from '../fixtures/gridmap.ts';
import { specialsRig, type SpecialsRig } from '../fixtures/specialsrig.ts';
import type { Opening } from '../../src/game/world.ts';
import { FADE_RADIUS, FadeCrossings, WallFader, type FadeTarget } from '../../src/render/occlusion.ts';
import { WALL_CHUNK_LEN } from '../../src/render/mapmesh.ts';
import { targetAt } from '../fixtures/fadetarget.ts';
import { PLAYER_HEIGHT } from '../../src/game/player.ts';

/**
 * The alpha range across the mover meshes the controller hung on the scene —
 * every batch, or only those `named` accepts. Both ends matter: a fade shows up
 * as a *low* below 1 somewhere, while a mover fog of war has never revealed
 * must be at 0 *everywhere*, which only the high end catches — one batch left
 * holding a stale 1 hides inside a minimum taken over the rest.
 */
function moverAlpha(scene: THREE.Group, named?: (name: string) => boolean): { low: number; high: number } {
  let low = 1;
  let high = 0;
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (named && !named(mesh.name ?? '')) return;
    const attr = mesh.geometry?.getAttribute?.('color') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    for (let v = 0; v < attr.count; v++) {
      low = Math.min(low, attr.getW(v));
      high = Math.max(high, attr.getW(v));
    }
  });
  return { low, high };
}

/**
 * The same, over a mover's **wall** batches alone. A mover's own floor is
 * usually in a corner fog of war has never revealed — 0 whatever the fade did —
 * so a case whose subject is the fade reads the walls rather than everything.
 */
function moverWallAlpha(scene: THREE.Group): { low: number; high: number } {
  return moverAlpha(scene, (name) => name.startsWith('wall:'));
}

/** One long `dt`, so the damping snaps and each call reads as a steady state. */
const SETTLE = 10;

/** The static batches a case drives alongside the movers, with the lookup their pass takes. */
interface Statics {
  fader: WallFader;
  openingInto: (line: number, out: Opening) => boolean;
}

/**
 * Both halves of the fade over one pair of bags, in `game.ts`'s own order —
 * pass one for every fader on the map, then pass two over what they all filed
 * (docs/render.md § One hole, whichever mesh it lands in). Written once so that
 * order lives in one place here rather than in each case. `statics` is the
 * map's own batches, for a case whose subject is a mover and a static wall
 * sharing one hole; a case about movers alone leaves it out. Fresh bags per
 * call: nothing here measures the allocation.
 */
function fade(
  r: SpecialsRig,
  camX: number,
  camY: number,
  camZ: number,
  targets: FadeTarget[],
  statics?: Statics,
): void {
  const walls = new FadeCrossings();
  const flats = new FadeCrossings();
  statics?.fader.collectCrossings(camX, camY, camZ, targets, statics.openingInto, walls);
  r.specials.collectFadeHits(camX, camY, camZ, targets, walls, flats);
  statics?.fader.applyCrossings(SETTLE, camX, camY, targets, statics.openingInto, walls);
  r.specials.updateFading(SETTLE, camX, camY, targets, walls, flats);
  statics?.fader.commit(() => 1);
}

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

  test('a mover on the sightline fades, and is whole again once nothing crosses it', () => {
    const { grid, rig: r } = rig();
    const scene = r.scene;
    // Camera north of the lift, target south of it: the sightline crosses the
    // lift's own north wall, which is a quad of its mover mesh.
    const at = grid.centre(1, 0);
    const camX = at.x;
    const camY = at.y + CELL;
    const target = targetAt(at.x, at.y - CELL, 0, {});
    fade(r, camX, camY, PLAYER_HEIGHT + 256, [target]);
    assert.ok(moverAlpha(scene).low < 1, 'the mover mesh faded where the sightline crossed it');

    // The player walks to the far end of the row, taking the camera with them.
    // The regression this guards: the mesh is now far outside the fade reach,
    // and a skip that ignored whether it still had something to relax would
    // leave the hole in it forever.
    const far = grid.centre(7, 0);
    const away = targetAt(far.x, far.y, 0, {});
    for (let i = 0; i < 4; i++) {
      fade(r, far.x, far.y + CELL, PLAYER_HEIGHT + 256, [away]);
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
    fade(r, far.x, far.y + CELL, PLAYER_HEIGHT + 256, [away]);
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
    const settle = () => fade(r, far.x, far.y + CELL, PLAYER_HEIGHT + 256, [away]);
    // Long enough for the reveal around the standing player to finish ramping,
    // so the frames below are ones where fog of war reports no change at all —
    // which is the only kind this case is about.
    for (let i = 0; i < 200; i++) r.tick();
    settle();
    settle();
    assert.equal(moverAlpha(r.scene).high, 0, 'hidden to begin with');

    // Mid-travel, where a moving lift's mesh is *refreshed* in place rather
    // than rebuilt: a rebuild would hand `updateFading` a fresh entry, which it
    // always commits, so only the refresh can leave a stale buffer behind.
    trigger();
    for (let i = 0; i < 3; i++) r.tick();
    const moving = r.world.map.sectors[lift].floorHeight;
    assert.ok(moving < 64 && moving > 0, `the lift should be mid-travel, is at ${moving}`);
    settle();
    for (let i = 0; i < 3; i++) r.tick();
    settle();
    assert.equal(moverAlpha(r.scene).high, 0, 'and still hidden after its geometry was rewritten');
  });
});

/**
 * A hole is a ball around where a sightline was stopped, and a level's walls
 * are spread across the static batches and one mesh per movable sector. Pass
 * one can only cross a fader's *own* walls, so the crossings have to be the
 * frame's rather than each fader's — otherwise a door standing in a wall the
 * player is behind is the one slab the hole opens around.
 * See docs/render.md § One hole, whichever mesh it lands in.
 */
describe('render · one hole, whichever mesh it lands in', () => {
  /** Cells one chunk wide, so a crossing in one is well inside `FADE_CORE` of the next. */
  const CELL = WALL_CHUNK_LEN;

  /**
   * A corridor running east–west with a solid wall along its north side, of
   * which the middle cell is a tagged door — a movable sector, so its share of
   * that wall lives in a mover mesh while the cells either side of it stay in
   * the static batches.
   */
  function wallWithADoorInIt(art: readonly string[] = ['#+#', '...']) {
    const grid = gridMap(art, { cell: CELL });
    const { map } = grid;
    for (const side of map.sidedefs) {
      side.upper = 'UPPER';
      side.lower = 'LOWER';
      side.middle = 'MIDDLE';
    }
    const door = grid.index(1, 0);
    map.sectors[door].tag = 1;
    addControlLine(map, 64, 0, 63, 1); // SR door, so the sector is a mover
    const r = specialsRig(map, grid.centre(0, 1));
    assert.ok(r.movableSectors.has(door), 'the fixture must actually build a mover mesh');
    const statics: Statics = {
      fader: new WallFader(r.built.occluders, r.built.wallMeshes),
      openingInto: (line: number, out: Opening) => r.world.openingInto(line, out),
    };
    const driveFade = (camX: number, camY: number, camZ: number, targets: FadeTarget[]) =>
      fade(r, camX, camY, camZ, targets, statics);
    return { grid, rig: r, door, fade: driveFade };
  }

  /** The lowest alpha the static batches hold over the wall quads standing at `x`. */
  function staticLow(r: SpecialsRig, x: number): number {
    let low = 1;
    for (const o of r.built.occluders) {
      if (Math.min(o.ax, o.bx) > x || Math.max(o.ax, o.bx) < x) continue;
      const attr = r.built.wallMeshes.get(o.key)?.geometry.getAttribute('color') as THREE.BufferAttribute;
      if (!attr) continue;
      for (let v = 0; v < o.vertexCount; v++) low = Math.min(low, attr.getW(o.vertexStart + v));
    }
    return low;
  }

  test('a door in a wall opens with the hole the wall beside it opened', () => {
    const { grid, rig: r, fade } = wallWithADoorInIt();
    // Player in the corridor under the *static* west cell of the wall, camera
    // due north of them and above: the sightline is stopped by that cell, half
    // a cell from where the door's own share of the wall starts.
    const at = grid.centre(0, 1);
    const target = targetAt(at.x, at.y, 0, {});
    fade(at.x, at.y + CELL * 2, PLAYER_HEIGHT + 256, [target]);

    assert.ok(staticLow(r, at.x) < 1, 'the static wall the sightline crosses fades');
    assert.ok(
      moverWallAlpha(r.scene).low < 1,
      'and so does the door beside it — the hole is one shape, not one per mesh',
    );
  });

  test('a door the hole never reaches stays whole', () => {
    // The same wall, with the player at the far end of the corridor: the ball
    // around that crossing does not reach the door, and nothing about sharing
    // the crossings may change that. What guards it is the footprint box every
    // fader rejects a crossing against before its own quads are walked.
    const { grid, rig: r, fade } = wallWithADoorInIt(['#+#####', '.......']);
    // Long enough for the reveal around the rig's own start to finish ramping,
    // so what is read back below is the fade rather than fog of war.
    for (let i = 0; i < 200; i++) r.tick();
    const at = grid.centre(6, 1);
    const doorEdge = grid.centre(1, 0);
    assert.ok(
      Math.hypot(at.x - doorEdge.x, at.y - doorEdge.y) > FADE_RADIUS,
      'the fixture must put the door out of reach for this to mean anything',
    );
    fade(at.x, at.y + CELL * 2, PLAYER_HEIGHT + 256, [targetAt(at.x, at.y, 0, {})]);
    assert.equal(moverWallAlpha(r.scene).low, 1, 'the door is untouched');
  });
});
