import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/game/world.ts';
import { buildThingSprites, type ThingLayer } from '../../src/game/things.ts';
import { attackPoseLetters, MONSTER_WALK_FRAMES_OVERRIDE } from '../../src/game/things/tables.ts';
import { MONSTER_STATS } from '../../src/game/monsters/tables.ts';
import { ThingType } from '../../src/game/things/doomednums.ts';
import { clearRandom } from '../../src/util/random.ts';
import { DOOM_TIC } from '../../src/constants.ts';
import type { ThingsSnapshot } from '../../src/game/snapshot.ts';
import type { Pos3 } from '../../src/types.ts';
import { gridMap, thingAt } from '../fixtures/gridmap.ts';
import { BANK, MATERIALS } from '../fixtures/spritestubs.ts';

/**
 * The arch-vile's cast is 94 tics (`S_VILE_ATK1`-`ATK11`) and its pose is those
 * very states' frames, `VILE` `G`-`P`. A flat per-frame rate made the two
 * disagree: 10 frames × 3 tics posed it for 30 tics and left it standing in its
 * idle frame for the other 64 — through the back half of the windup, where the
 * warning flame is the whole mechanic, and through the blast. Repro: the
 * `vilebug` save, taken 43 tics into a cast.
 *
 * The rule this pins: **an attack pose lasts exactly as long as the attack it
 * poses for** (`AttackStats.duration`), live and across a savegame both.
 * docs/sprites.md § Pain, and attack/pain poses.
 */

const VILE_ATTACK = attackPoseLetters(ThingType.archVile);
const VILE_WALK = MONSTER_WALK_FRAMES_OVERRIDE[ThingType.archVile];
const RANGED = MONSTER_STATS[ThingType.archVile].ranged!;

interface Fixture {
  layer: ThingLayer;
  player: Pos3;
  /** The frame the vile's billboard is drawn on right now. */
  frame(): string;
  /** Ticks the layer, and reports whether the blast landed on this tic. */
  tic(): boolean;
}

/**
 * One open room with the player in a corner and an alerted arch-vile two cells
 * off — inside its 896-unit range, with clear sight, so it casts on its own.
 * `restore` rebuilds from a savegame instead of spawning fresh.
 */
function arena(restore?: ThingsSnapshot): Fixture {
  clearRandom();
  const grid = gridMap(['######', '#....#', '#....#', '######'], { cell: 128 });
  const map = grid.map;
  map.things.push(thingAt(grid, 1, 1, 1), thingAt(grid, 3, 2, ThingType.archVile));
  const player: Pos3 = { x: map.things[0].x, y: map.things[0].y, z: 0 };
  const layer = buildThingSprites(new World(map), { bank: BANK, materials: MATERIALS, skill: 3, restore: restore ?? awake(map.things[1]) });
  assert.equal(layer.count, 1, 'the vile is the only thing posed');
  return {
    layer,
    player,
    frame() {
      layer.draw(1, 0);
      return layer.drawnFrameKey(0).slice(4);
    },
    tic: () => layer.update(DOOM_TIC, [player]).attacks.some((a) => a.kind === 'ranged' && a.blast),
  };
}

/** A save that wakes the vile the map spawned, so the cast under test is one the AI decides to start. */
function awake(vile: { x: number; y: number }): ThingsSnapshot {
  return {
    clock: 0,
    stats: { totalKills: 1, kills: 0, totalItems: 0, items: 0 },
    changed: [[0, { type: ThingType.archVile, x: vile.x, y: vile.y, z: 0, facingDeg: 180, monster: { alerted: true } }]],
    lastlook: '',
  };
}

/** `S_VILE_ATK1`-`ATK11`, in tics — the length of one cast, and so of one pose. */
const CAST_TICS = Math.round(RANGED.duration / DOOM_TIC);

/** Steps until the vile commits to a cast, leaving the fixture on that tic. */
function startCast(fx: Fixture): void {
  for (let tic = 0; tic < 400; tic++) {
    if (fx.layer.update(DOOM_TIC, [fx.player]).attacks.some((a) => a.kind === 'vileWindup')) return;
  }
  assert.fail('the vile never started a cast');
}

describe('Regressions · the arch-vile’s pose spans its whole cast', () => {
  test('it is still posed when the blast lands, not standing in its idle frame', () => {
    const fx = arena();
    startCast(fx);
    assert.ok(VILE_ATTACK.includes(fx.frame()), 'posed the tic the windup begins');

    // 66 tics in, A_VileAttack fires — one tic of slack, since the burst timer
    // is decremented before it is tested. The flat rate had the pose over 36
    // tics before that, so this drew the idle 'A'.
    const windupTics = Math.round((RANGED.startDelaySeconds ?? 0) / DOOM_TIC) + 1;
    let fired = false;
    for (let tic = 0; tic < windupTics; tic++) {
      fired ||= fx.tic();
      assert.ok(VILE_ATTACK.includes(fx.frame()), `still posed ${tic + 1} tics into the cast`);
    }
    assert.ok(fired, 'and the blast landed inside that window');
  });

  test('the pose ends with the cast rather than outlasting it', () => {
    const fx = arena();
    startCast(fx);
    // `justAttacked` re-routes the chase call that follows, so the tic the cast
    // runs out on can't already be the start of another one.
    for (let tic = 0; tic < CAST_TICS; tic++) fx.tic();
    const frame = fx.frame();
    assert.ok(VILE_WALK.includes(frame), `back on the walk cycle, not ${frame}`);
  });

  test('a save taken mid-cast reloads onto the frame it was drawn on', () => {
    const live = arena();
    startCast(live);
    // Where `vilebug` was taken: 43 tics into the cast, the flame already on
    // the player and the blast still to come.
    for (let tic = 0; tic < 43; tic++) live.tic();
    const posed = live.frame();
    assert.ok(VILE_ATTACK.includes(posed), 'the save really is taken mid-pose');

    // A restore used to skip transient poses outright, so this drew the idle
    // 'A' for the rest of the cast and through the blast.
    const loaded = arena(live.layer.snapshot());
    assert.equal(loaded.frame(), posed, 'fast-forwarded, not restarted from the first frame');
    // And it runs the rest of the cast out from there.
    for (let tic = 0; tic < CAST_TICS - 44; tic++) {
      loaded.tic();
      assert.ok(VILE_ATTACK.includes(loaded.frame()), `still posed ${tic + 1} tics after the load`);
    }
  });
});
